const axios = require('axios');

// Buddy Punch has two Amplitude projects (one keyed by UserID, one by AccountID per Nick).
// The existing amplitude-slack-bot only has ONE set of keys, named without suffixes —
// so fall back from suffixed env vars to the plain ones.
const PROJECTS = [
  {
    name: 'UserID',
    apiKey: process.env.AMPLITUDE_API_KEY_USERID || process.env.AMPLITUDE_API_KEY,
    secretKey: process.env.AMPLITUDE_SECRET_KEY_USERID || process.env.AMPLITUDE_SECRET_KEY,
  },
  {
    name: 'AccountID',
    apiKey: process.env.AMPLITUDE_API_KEY_ACCOUNTID,
    secretKey: process.env.AMPLITUDE_SECRET_KEY_ACCOUNTID,
  },
];

// Amplitude's User Privacy API requires `requester` to be a valid email address.
// Use the configured requester email, falling back to a default support email.
const REQUESTER_EMAIL = process.env.AMPLITUDE_REQUESTER_EMAIL || 'support@buddypunch.com';

async function deleteUser(emailOrUserId) {
  const results = [];
  for (const p of PROJECTS) {
    if (!p.apiKey || !p.secretKey) {
      results.push({ project: p.name, status: 'skipped', notes: 'No API credentials configured for this project' });
      continue;
    }
    const auth = Buffer.from(`${p.apiKey}:${p.secretKey}`).toString('base64');
    try {
      const res = await axios.post(
        'https://amplitude.com/api/2/deletions/users',
        {
          user_ids: [String(emailOrUserId)],
          requester: REQUESTER_EMAIL,
          // ignore_invalid_id: allow the call to succeed even if Amplitude doesn't know this user_id
          ignore_invalid_id: true,
          delete_from_org: 'False',
        },
        { headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' }, validateStatus: () => true }
      );
      if (res.status >= 400) {
        results.push({ project: p.name, status: 'failed', error: res.data });
      } else {
        results.push({
          project: p.name,
          status: 'completed',
          request_id: res.data?.[0]?.request_id || res.data?.requests_received,
          raw: res.data,
        });
      }
    } catch (err) {
      results.push({ project: p.name, status: 'failed', error: err.response?.data || err.message });
    }
  }
  const anyOk = results.some(r => r.status === 'completed');
  const anyFailed = results.some(r => r.status === 'failed');
  let status;
  if (anyFailed && !anyOk) status = 'failed';
  else status = 'completed';
  return {
    ok: !anyFailed || anyOk,
    status,
    notes: results.map(r => `${r.project}: ${r.status}${r.request_id ? ` (req ${r.request_id})` : ''}${r.error ? ` — ${JSON.stringify(r.error).slice(0, 120)}` : ''}`).join('; '),
    response_data: results,
  };
}

module.exports = { deleteUser };
