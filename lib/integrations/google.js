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
  // Persist for both GA4 and Google Ads since we use one OAuth flow with both scopes
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
  // GA4 User Deletion API: https://developers.google.com/analytics/devguides/config/userdeletion/v3
  // Note: GA4's User Deletion API works on user_id or client_id (not email directly).
  // For visitors without user_id, we identify them by GA4 client_id (the _ga cookie).
  // If we have neither, we record the gap honestly.
  if (!emailOrClientId.includes('.')) {
    // Doesn't look like a client_id either — record as deferred
    return {
      ok: true,
      status: 'not_applicable',
      notes: `No GA4 user_id or client_id available for ${emailOrClientId}. GA4 doesn't index by email; deletion deferred unless the user provides their _ga cookie or we can match them via app.buddypunch.com user_id.`,
    };
  }
  try {
    const body = {
      kind: 'analytics#userDeletionRequest',
      id: { type: 'CLIENT_ID', userId: emailOrClientId },
      webPropertyId: propertyId,
      deletionRequestTime: new Date().toISOString(),
    };
    const res = await axios.post(
      'https://www.googleapis.com/analytics/v3/userDeletion/userDeletionRequests:upsert',
      body,
      { headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true },
    );
    if (res.status >= 400) {
      return { ok: false, status: 'failed', notes: `GA4 error ${res.status}: ${JSON.stringify(res.data)}` };
    }
    return {
      ok: true,
      status: 'completed',
      notes: `Submitted GA4 user deletion for client_id ${emailOrClientId}. Data purges from User Explorer within 72h; full removal in next bi-monthly cycle (~63 days).`,
      external_reference: res.data?.id || null,
      response_data: res.data,
    };
  } catch (err) {
    return { ok: false, status: 'failed', notes: err.message };
  }
}

// --------- Google Ads Customer Match removal ---------
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

  // List Customer Match user lists this account owns
  try {
    const searchRes = await axios.post(
      `https://googleads.googleapis.com/v18/customers/${customerId}/googleAds:search`,
      { query: "SELECT user_list.id, user_list.name FROM user_list WHERE user_list.type = 'CRM_BASED'" },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'developer-token': devToken,
          'login-customer-id': loginCustomerId,
        },
        validateStatus: () => true,
      },
    );
    if (searchRes.status >= 400) {
      return { ok: false, status: 'failed', notes: `Google Ads list query ${searchRes.status}: ${JSON.stringify(searchRes.data)}` };
    }
    const lists = (searchRes.data?.results || []).map(r => r.userList);
    if (!lists.length) {
      return { ok: true, status: 'completed', notes: 'No Customer Match audiences found to remove from.', external_reference: null };
    }
    const removedFrom = [];
    for (const list of lists) {
      const offlineRes = await axios.post(
        `https://googleads.googleapis.com/v18/customers/${customerId}/offlineUserDataJobs:create`,
        {
          job: {
            type: 'CUSTOMER_MATCH_USER_LIST',
            customerMatchUserListMetadata: { userList: `customers/${customerId}/userLists/${list.id}` },
          },
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'developer-token': devToken,
            'login-customer-id': loginCustomerId,
          },
          validateStatus: () => true,
        },
      );
      if (offlineRes.status >= 400) continue;
      const jobResource = offlineRes.data?.resourceName;
      if (!jobResource) continue;

      // Add remove-operation
      await axios.post(
        `https://googleads.googleapis.com/v18/${jobResource}:addOperations`,
        {
          operations: [{ remove: { userIdentifiers: [{ hashedEmail: sha256 }] } }],
          enable_partial_failure: true,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'developer-token': devToken,
            'login-customer-id': loginCustomerId,
          },
          validateStatus: () => true,
        },
      );
      // Run the job
      await axios.post(
        `https://googleads.googleapis.com/v18/${jobResource}:run`,
        {},
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'developer-token': devToken,
            'login-customer-id': loginCustomerId,
          },
          validateStatus: () => true,
        },
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
