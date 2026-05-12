const { supabase, audit } = require('./supabase');
const hubspot = require('./integrations/hubspot');
const amplitude = require('./integrations/amplitude');
const intercom = require('./integrations/intercom');
const stripeInt = require('./integrations/stripe');
const meta = require('./integrations/meta');
const google = require('./integrations/google');
const { postMessage } = require('./slack');

// Terminal action statuses — counted as "resolved" for auto-complete logic
const TERMINAL_STATUSES = new Set(['completed', 'not_applicable', 'skipped']);

const DESTINATIONS = {
  hubspot: {
    label: 'HubSpot',
    automated: true,
    runOnOptOut: true,
    runOnDelete: true,
    docs: 'https://knowledge.hubspot.com/ads/hubspot-ads-privacy-features',
    notApplicable: () => null,
    execute: async (req) => {
      if (req.request_type === 'delete') return hubspot.permanentDelete(req.requester_email);
      return hubspot.flagDoNotSell(req.requester_email, req.id);
    },
  },
  amplitude: {
    label: 'Amplitude',
    automated: true,
    runOnOptOut: true,
    runOnDelete: true,
    docs: 'https://www.docs.developers.amplitude.com/analytics/apis/user-privacy-api/',
    notApplicable: (req) => {
      if (String(req.requester_email || '').includes('@')) {
        return "Amplitude indexes by Buddy Punch user_id, not email. Will be handled indirectly when the Internal Product DB endpoint deletes the user — Amplitude data deletes via that pipeline.";
      }
      return null;
    },
    execute: async (req) => amplitude.deleteUser(req.requester_email),
  },
  intercom: {
    label: 'Intercom',
    automated: true,
    runOnOptOut: false,
    runOnDelete: true,
    docs: 'https://developers.intercom.com/docs/references/1.1/rest-api/users/delete-users',
    notApplicable: () => null,
    execute: async (req) => intercom.permanentDelete(req.requester_email),
  },
  stripe: {
    label: 'Stripe (non-active customers only)',
    automated: true,
    runOnOptOut: false,
    runOnDelete: true,
    docs: 'https://stripe.com/docs/api/customers/delete',
    notApplicable: () => null,
    execute: async (req) => stripeInt.deleteIfInactive(req.requester_email),
  },
  meta: {
    label: 'Meta (Facebook Pixel — LDU signal)',
    automated: true,
    runOnOptOut: true,
    runOnDelete: true,
    docs: 'https://developers.facebook.com/docs/marketing-apis/data-processing-options',
    notApplicable: () => null,
    execute: async (req) => meta.sendLDUSignal(req.requester_email),
  },
  ga4: {
    label: 'Google Analytics 4',
    automated: true,
    runOnOptOut: true,
    runOnDelete: true,
    docs: 'https://developers.google.com/analytics/devguides/config/userdeletion/v3',
    notApplicable: (req) => {
      if (String(req.requester_email || '').includes('@')) {
        return "GA4 indexes by user_id or _ga client_id cookie, not email. Will be handled indirectly when the Internal Product DB endpoint deletes the user.";
      }
      return null;
    },
    execute: async (req) => google.ga4DeleteUser(req.requester_email, req.id),
  },
  google_ads: {
    label: 'Google Ads (Customer Match)',
    automated: true,
    runOnOptOut: true,
    runOnDelete: true,
    docs: 'https://developers.google.com/google-ads/api/docs/remarketing/audience-types/customer-match',
    notApplicable: () => null,
    execute: async (req) => google.googleAdsRemoveFromAudiences(req.requester_email),
  },
  linkedin: {
    label: 'LinkedIn (Insight Tag & Matched Audiences)',
    automated: false,
    runOnOptOut: true,
    runOnDelete: true,
    docs: 'https://www.linkedin.com/help/lms/answer/a521452',
    notApplicable: () => "Buddy Punch is not currently running LinkedIn ads or Matched Audiences, so there is no LinkedIn data to remove. Will be revisited if LinkedIn campaigns are activated in the future.",
    execute: null,
  },
  bing: {
    label: 'Microsoft Ads / Bing (UET)',
    automated: false,
    runOnOptOut: true,
    runOnDelete: true,
    docs: 'https://www.microsoft.com/en-us/privacy/ccpa-guidance',
    notApplicable: () => "Buddy Punch's Bing campaigns are non-brand keyword-based without Customer Match audiences. Microsoft Advertising API access is not configured. Will be revisited if Customer Match audiences are added to Bing.",
    execute: null,
  },
  internal_db: {
    label: 'Internal Product DB (Buddy Punch)',
    automated: false,
    runOnOptOut: false,
    runOnDelete: true,
    docs: null,
    notApplicable: () => null,
    execute: null,
  },
};

function destinationsForRequest(req) {
  return Object.entries(DESTINATIONS)
    .filter(([_, d]) => {
      if (req.request_type === 'opt_out') return d.runOnOptOut;
      if (req.request_type === 'delete') return d.runOnDelete;
      return true;
    })
    .map(([key, d]) => {
      const naReason = d.notApplicable ? d.notApplicable(req) : null;
      return { key, ...d, naReason };
    });
}

async function ensureActionsForRequest(req) {
  const dests = destinationsForRequest(req);
  for (const d of dests) {
    const status = d.naReason ? 'not_applicable' : 'pending';
    await supabase.from('privacy_request_actions').upsert(
      {
        request_id: req.id,
        destination: d.key,
        action_type: d.automated
          ? 'automated_api'
          : (d.key === 'internal_db' ? 'manual_internal' : 'manual_support_ticket'),
        status,
        response_data: d.naReason ? { not_applicable_reason: d.naReason } : null,
      },
      { onConflict: 'request_id,destination', ignoreDuplicates: true },
    );
  }
}

// Check if all destinations for this request are in a terminal state. If yes,
// flip the request status to 'completed' and notify Slack.
async function maybeAutoComplete(req, actorEmail) {
  const { data: r } = await supabase
    .from('privacy_requests')
    .select('*')
    .eq('id', req.id)
    .single();
  if (!r || r.status === 'completed' || r.status === 'cancelled') return false;

  const { data: actions } = await supabase
    .from('privacy_request_actions')
    .select('status')
    .eq('request_id', req.id);

  if (!actions || actions.length === 0) return false;
  const allDone = actions.every(a => TERMINAL_STATUSES.has(a.status));
  if (!allDone) return false;

  await supabase
    .from('privacy_requests')
    .update({ status: 'completed', completed_at: new Date().toISOString() })
    .eq('id', req.id);

  await audit(req.id, 'request.auto_completed', actorEmail || 'system', {
    note: 'All destinations resolved — request auto-completed',
  });

  await postMessage(
    `:white_check_mark: Privacy request auto-completed\n*From:* ${r.requester_email}  *Type:* ${r.request_type}\nAll destinations resolved.\n_Reminder: send the completion confirmation reply to the requester via Intercom — see CCPA Request Runbook for the macro._\n${process.env.BASE_URL}/requests/${req.id}`,
  );
  return true;
}

async function runDestination(req, destinationKey, actorEmail) {
  const dest = DESTINATIONS[destinationKey];
  if (!dest) throw new Error(`Unknown destination ${destinationKey}`);
  const naReason = dest.notApplicable ? dest.notApplicable(req) : null;
  if (naReason) {
    await supabase
      .from('privacy_request_actions')
      .update({
        status: 'not_applicable',
        response_data: { not_applicable_reason: naReason },
        executed_at: new Date().toISOString(),
        executed_by: actorEmail,
      })
      .eq('request_id', req.id)
      .eq('destination', destinationKey);
    await maybeAutoComplete(req, actorEmail);
    return { ok: true, status: 'not_applicable', notes: naReason };
  }
  if (!dest.execute) {
    return { ok: false, status: 'pending', notes: `${dest.label} is a manual step; mark complete via the checkbox once done.` };
  }
  await supabase
    .from('privacy_request_actions')
    .update({ status: 'in_progress', executed_at: new Date().toISOString(), executed_by: actorEmail })
    .eq('request_id', req.id)
    .eq('destination', destinationKey);

  let result;
  try {
    result = await dest.execute(req);
  } catch (err) {
    result = { ok: false, status: 'failed', notes: err.message };
  }

  await supabase
    .from('privacy_request_actions')
    .update({
      status: result.status || (result.ok ? 'completed' : 'failed'),
      external_reference: result.external_reference || null,
      response_data: result.response_data || null,
      error_message: result.ok ? null : result.notes,
      executed_at: new Date().toISOString(),
      executed_by: actorEmail,
    })
    .eq('request_id', req.id)
    .eq('destination', destinationKey);

  await audit(req.id, `action.${destinationKey}.${result.status || (result.ok ? 'completed' : 'failed')}`, actorEmail, {
    destination: destinationKey,
    notes: result.notes,
    external_reference: result.external_reference,
  });

  await maybeAutoComplete(req, actorEmail);
  return result;
}

async function runAllAutomated(req, actorEmail) {
  const results = {};
  const dests = destinationsForRequest(req).filter(d => d.automated && !d.naReason);
  for (const d of dests) {
    results[d.key] = await runDestination(req, d.key, actorEmail);
  }
  const naDests = destinationsForRequest(req).filter(d => d.naReason);
  for (const d of naDests) {
    await runDestination(req, d.key, actorEmail);
  }
  await maybeAutoComplete(req, actorEmail);
  return results;
}

async function markManualComplete(req, destinationKey, actorEmail, notes) {
  await supabase
    .from('privacy_request_actions')
    .update({
      status: 'completed',
      executed_at: new Date().toISOString(),
      executed_by: actorEmail,
      response_data: { manual: true, notes: notes || null },
    })
    .eq('request_id', req.id)
    .eq('destination', destinationKey);
  await audit(req.id, `action.${destinationKey}.manual_completed`, actorEmail, {
    destination: destinationKey,
    notes,
  });
  await maybeAutoComplete(req, actorEmail);
  return { ok: true };
}

module.exports = { DESTINATIONS, destinationsForRequest, ensureActionsForRequest, runDestination, runAllAutomated, markManualComplete };
