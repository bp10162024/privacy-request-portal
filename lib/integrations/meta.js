const axios = require('axios');
const crypto = require('crypto');

const PIXEL_ID = process.env.META_PIXEL_ID;
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;

function sha256Lower(s) {
  return crypto.createHash('sha256').update(String(s).trim().toLowerCase()).digest('hex');
}

// Submit a Limited Data Use (LDU) signal for this user via Conversions API.
// This tells Meta to treat the user as having opted out under CCPA going forward.
// For full historical data deletion, the manual data-deletion form is still required.
async function sendLDUSignal(email) {
  if (!PIXEL_ID || !ACCESS_TOKEN) {
    return { ok: false, status: 'failed', notes: 'META_PIXEL_ID or META_ACCESS_TOKEN not configured.', external_reference: null };
  }
  const url = `https://graph.facebook.com/v18.0/${PIXEL_ID}/events`;
  const event = {
    event_name: 'CCPA_OptOut',
    event_time: Math.floor(Date.now() / 1000),
    action_source: 'website',
    user_data: { em: [sha256Lower(email)] },
    data_processing_options: ['LDU'],
    data_processing_options_country: 1, // 1 = United States
    data_processing_options_state: 1000, // 1000 = California
  };
  const res = await axios.post(url, { data: [event], access_token: ACCESS_TOKEN }, { validateStatus: () => true });
  if (res.status >= 400 || res.data?.error) {
    return {
      ok: false,
      status: 'failed',
      notes: `Meta API error: ${JSON.stringify(res.data)}`,
      external_reference: null,
    };
  }
  return {
    ok: true,
    status: 'completed',
    notes: `Submitted LDU (Limited Data Use) signal to Meta for ${email}. Meta will treat this user as opted-out under CCPA going forward. For historical data deletion, also submit at business.facebook.com → Events Manager → Pixel → Settings → Privacy → Request Data Deletion.`,
    external_reference: res.data?.events_received ? `${res.data.events_received} event(s) accepted` : null,
    response_data: res.data,
  };
}

module.exports = { sendLDUSignal };
