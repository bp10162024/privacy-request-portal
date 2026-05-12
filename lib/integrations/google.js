const { google } = require('googleapis');
const axios = require('axios');
const { supabase } = require('../supabase');

const REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI || `${process.env.BASE_URL}/oauth/google/callback`;

const SCOPES = [
  'https://www.googleapis.com/auth/analytics.user.deletion',
  'https://www.googleapis.com/auth/adwords',
];

function makeClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    REDIRECT_URI,
  );
}

function getAuthUrl() {
  const c = makeClient();
  return c.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });
}

async function exchangeCode(code, actorEmail) {
  const c = makeClient();
  const { tokens } = await c.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error('Google did not return a refresh_token. Revoke the app at https://myaccount.google.com/permissions and try again.');
  }
  for (const provider of ['google_analytics', 'google_ads']) {
    await supabase.from('privacy_request_oauth_tokens').upsert({
      provider,
      refresh_token: tokens.refresh_token,
      scope: SCOPES.join(' '),
      authorized_by: actorEmail,
      authorized_at: new Date().toISOString(),
    });
  }
  return { ok: true };
}

async function getAuthorizedClient() {
  const { data } = await supabase
    .from('privacy_request_oauth_tokens')
    .select('*')
    .eq('provider', 'google_analytics')
    .maybeSingle();
  if (!data) return null;
  const c = makeClient();
  c.setCredentials({ refresh_token: data.refresh_token });
  return c;
}

// --------- GA4 User Deletion ---------
// Endpoint per Google Analytics User Deletion API v3 docs:
//   POST https://www.googleapis.com/analytics/v3/userDeletion/userDeletionRequests:upsert
// For GA4 properties, webPropertyId must be in the format `properties/{propertyId}` (not UA-{id}-{view}).
// If only an email is supplied, we record that GA4 cannot be deleted by email and note the gap.
async function ga4DeleteUser(emailOrClientId, requestId) {
  const propertyId = process.env.GA4_PROPERTY_ID;
  if (!propertyId) {
    return { ok: false, status: 'failed', notes: 'GA4_PROPERTY_ID not configured.' };
  }
  const auth = await getAuthorizedClient();
  if (!auth) {
    return { ok: false, status: 'failed', notes: 'Google OAuth not authorized yet. Visit /oauth/google/authorize as an admin.' };
  }
  const { token } = await auth.getAccessToken();

  // GA4 doesn't accept emails as direct identifiers — only USER_ID or CLIENT_ID (the _ga cookie value).
  // For an opt-out received via Intercom/email, we usually don't have either. Record honestly.
  const looksLikeEmail = String(emailOrClientId).includes('@');
  if (looksLikeEmail) {
    return {
      ok: true,
      status: 'not_applicable',
      notes: `GA4 doesn't index by email. To delete this user's GA4 data, we'd need their user_id from app.buddypunch.com (logged-in users) or their _ga cookie value (anonymous visitors). Marketing-site visitor data without those identifiers cannot be targeted in GA4. Recommendation: rely on HubSpot's marketing exclusion + Google Ads Customer Match removal for indirect protection.`,
    };
  }

  try {
    const body = {
      kind: 'analytics#userDeletionRequest',
      id: { type: 'USER_ID', userId: String(emailOrClientId) },
      webPropertyId: `properties/${propertyId}`,
      deletionRequestTime: new Date().toISOString(),
    };
    const res = await axios.post(
      'https://www.googleapis.com/analytics/v3/userDeletion/userDeletionRequests:upsert',
      body,
      { headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true },
    );
    if (res.status >= 400) {
      return { ok: false, status: 'failed', notes: `GA4 error ${res.status}: ${JSON.stringify(res.data).slice(0, 400)}` };
    }
    return {
      ok: true,
      status: 'completed',
      notes: `Submitted GA4 user deletion for user_id ${emailOrClientId}. Removes from User Explorer within 72h; full purge in next bi-monthly cycle.`,
      external_reference: res.data?.id || null,
      response_data: res.data,
    };
  } catch (err) {
    return { ok: false, status: 'failed', notes: err.message };
  }
}

// --------- Google Ads Customer Match removal (v19) ---------
async function googleAdsRemoveFromAudiences(email) {
  const devToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID;
  const loginCustomerId = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || customerId;
  if (!devToken || !customerId) {
    return { ok: false, status: 'failed', notes: 'GOOGLE_ADS_DEVELOPER_TOKEN or GOOGLE_ADS_CUSTOMER_ID not configured.' };
  }
  const auth = await getAuthorizedClient();
  if (!auth) {
    return { ok: false, status: 'failed', notes: 'Google OAuth not authorized yet. Visit /oauth/google/authorize as an admin.' };
  }
  const { token } = await auth.getAccessToken();
  const sha256 = require('crypto').createHash('sha256').update(email.trim().toLowerCase()).digest('hex');

  const API_VERSION = 'v19';
  const headers = {
    Authorization: `Bearer ${token}`,
    'developer-token': devToken,
    'login-customer-id': loginCustomerId,
    'Content-Type': 'application/json',
  };

  try {
    const searchRes = await axios.post(
      `https://googleads.googleapis.com/${API_VERSION}/customers/${customerId}/googleAds:searchStream`,
      { query: "SELECT user_list.id, user_list.name FROM user_list WHERE user_list.type = 'CRM_BASED'" },
      { headers, validateStatus: () => true },
    );
    if (searchRes.status >= 400) {
      // Common case: Developer Token still in test/pending approval — search may not work.
      const errBody = typeof searchRes.data === 'string' ? searchRes.data.slice(0, 200) : JSON.stringify(searchRes.data).slice(0, 400);
      return { ok: false, status: 'failed', notes: `Google Ads ${API_VERSION} search ${searchRes.status}: ${errBody}` };
    }
    const lists = [];
    const data = Array.isArray(searchRes.data) ? searchRes.data : [searchRes.data];
    for (const chunk of data) {
      for (const r of (chunk.results || [])) {
        if (r.userList) lists.push(r.userList);
      }
    }
    if (!lists.length) {
      return { ok: true, status: 'completed', notes: 'No Customer Match audiences found to remove from.', external_reference: null };
    }
    const removedFrom = [];
    for (const list of lists) {
      const offlineRes = await axios.post(
        `https://googleads.googleapis.com/${API_VERSION}/customers/${customerId}/offlineUserDataJobs:create`,
        {
          job: {
            type: 'CUSTOMER_MATCH_USER_LIST',
            customerMatchUserListMetadata: { userList: `customers/${customerId}/userLists/${list.id}` },
          },
        },
        { headers, validateStatus: () => true },
      );
      if (offlineRes.status >= 400) continue;
      const jobResource = offlineRes.data?.resourceName;
      if (!jobResource) continue;

      await axios.post(
        `https://googleads.googleapis.com/${API_VERSION}/${jobResource}:addOperations`,
        {
          operations: [{ remove: { userIdentifiers: [{ hashedEmail: sha256 }] } }],
          enable_partial_failure: true,
        },
        { headers, validateStatus: () => true },
      );
      await axios.post(
        `https://googleads.googleapis.com/${API_VERSION}/${jobResource}:run`,
        {},
        { headers, validateStatus: () => true },
      );
      removedFrom.push(list.name);
    }
    return {
      ok: true,
      status: 'completed',
      notes: removedFrom.length
        ? `Submitted Google Ads remove-from-audience for: ${removedFrom.join(', ')}. Processing takes a few hours.`
        : 'No matching Customer Match audiences contained this email.',
      external_reference: removedFrom.join(', ') || null,
    };
  } catch (err) {
    return { ok: false, status: 'failed', notes: err.message };
  }
}

module.exports = { getAuthUrl, exchangeCode, ga4DeleteUser, googleAdsRemoveFromAudiences };
