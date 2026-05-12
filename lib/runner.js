const { supabase, audit } = require('./supabase');
const hubspot = require('./integrations/hubspot');
const amplitude = require('./integrations/amplitude');
const intercom = require('./integrations/intercom');
const stripeInt = require('./integrations/stripe');
const meta = require('./integrations/meta');
const google = require('./integrations/google');

// Map of destination → metadata + executor function
const DESTINATIONS = {
  hubspot: {
    label: 'HubSpot',
    automated: true,
    runOnOptOut: true,
    runOnDelete: true,
    docs: 'https://knowledge.hubspot.com/ads/hubspot-ads-privacy-features',
    execute: async (req) => {
      if (req.request_type === 'delete') return hubspot.permanentDelete(req.requester_email);
      return hubspot.flagDoNotSell(req.requester_email, req.id);
    },
  },
  amplitude: {
    label: 'Amplitude (both UserID + AccountID projects)',
    automated: true,
    runOnOptOut: true,
    runOnDelete: true,
    docs: 'https://www.docs.developers.amplitude.com/analytics/apis/user-privacy-api/',
    execute: async (req) => amplitude.deleteUser(req.requester_email),
  },
  intercom: {
    label: 'Intercom',
    automated: true,
    runOnOptOut: false, // Don't delete from Intercom on opt-out — we need conversation history
    runOnDelete: true,
    docs: 'https://developers.intercom.com/docs/references/1.1/rest-api/users/delete-users',
    execute: async (req) => intercom.permanentDelete(req.requester_email),
  },
  stripe: {
    label: 'Stripe (non-active customers only)',
    automated: true,
    runOnOptOut: false,
    runOnDelete: true,
    docs: 'https://stripe.com/docs/api/customers/delete',
    execute: async (req) => stripeInt.deleteIfInactive(req.requester_email),
  },
  meta: {
    label: 'Meta (Facebook Pixel — LDU signal)',
    automated: true,
    runOnOptOut: true,
    runOnDelete: true,
    docs: 'https://developers.facebook.com/docs/marketing-apis/data-processing-options',
    execute: async (req) => meta.sendLDUSignal(req.requester_email),
  },
  ga4: {
    label: 'Google Analytics 4',
    automated: true,
    runOnOptOut: true,
    runOnDelete: true,
    docs: 'https://developers.google.com/analytics/devguides/config/userdeletion/v3',
    execute: async (req) => google.ga4DeleteUser(req.requester_email, req.id),
  },
  google_ads: {
    label: 'Google Ads (Customer Match)',
    automated: true,
    runOnOptOut: true,
    runOnDelete: true,
    docs: 'https://developers.google.com/google-ads/api/docs/remarketing/audience-types/customer-match',
    execute: async (req) => google.googleAdsRemoveFromAudiences(req.requester_email),
  },
  linkedin: {
    label: 'LinkedIn (Insight Tag & Matched Audiences)',
    automated: false,
    runOnOptOut: true,
    runOnDelete: true,
    docs: 'https://www.linkedin.com/help/lms/answer/a521452',
    execute: null, // manual checklist
  },
  bing: {
    label: 'Microsoft Ads / Bing (UET)',
    automated: false,
    runOnOptOut: true,
    runOnDelete: true,
    docs: 'https://www.microsoft.com/en-us/privacy/ccpa-guidance',
    execute: null,
  },
  internal_db: {
    label: 'Internal Product DB (Buddy Punch)',
    automated: false,
    runOnOptOut: false,
    runOnDelete: true,
    docs: null,
    execute: null, // Nick / Muhammad handles via script
  },
};

function destinationsForRequest(req) {
  return Object.entries(DESTINATIONS)
    .filter(([_, d]) => {
      if (req.request_type === 'opt_out') return d.runOnOptOut;
      if (req.request_type === 'delete') return d.runOnDelete;
      // For access / correct / limit, surface as manual checklist for now
      return true;
    })
    .map(([key, d]) => ({ key, ...d }));
}

async function ensureActionsForRequest(req) {
  const dests = destinationsForRequest(req);
  for (const d of dests) {
    await supabase.from('privacy_request_actions').upsert(
      {
        request_id: req.id,
        destination: d.key,
        action_type: d.automated ? 'automated_api' : (d.key === 'internal_db' ? 'manual_internal' : (d.key === 'linkedin' || d.key === 'bing' ? 'manual_support_ticket' : 'manual_form')),
        status: 'pending',
      },
      { onConflict: 'request_id,destination', ignoreDuplicates: true },
    );
  }
}

async function runDestination(req, destinationKey, actorEmail) {
  const dest = DESTINATIONS[destinationKey];
  if (!dest) throw new Error(`Unknown destination ${destinationKey}`);
  if (!dest.execute) {
    return { ok: false, status: 'pending', notes: `${dest.label} is a manual step; mark complete via the checkbox once done.` };
  }
  // Mark in_progress
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

  return result;
}

async function runAllAutomated(req, actorEmail) {
  const results = {};
  const dests = destinationsForRequest(req).filter(d => d.automated);
  for (const d of dests) {
    results[d.key] = await runDestination(req, d.key, actorEmail);
  }
  return results;
}

async function markManualComplete(req, destinationKey, actorEmail, notes) {
  const dest = DESTINATIONS[destinationKey];
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
  return { ok: true };
}

module.exports = { DESTINATIONS, destinationsForRequest, ensureActionsForRequest, runDestination, runAllAutomated, markManualComplete };
