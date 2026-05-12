const axios = require('axios');

const PROJECTS = [
  {
    name: 'UserID',
    apiKey: process.env.AMPLITUDE_API_KEY_USERID,
    secretKey: process.env.AMPLITUDE_SECRET_KEY_USERID,
  },
  {
    name: 'AccountID',
    apiKey: process.env.AMPLITUDE_API_KEY_ACCOUNTID,
    secretKey: process.env.AMPLITUDE_SECRET_KEY_ACCOUNTID,
  },
];

async function deleteUser(emailOrUserId) {
  const results = [];
  for (const p of PROJECTS) {
    if (!p.apiKey || !p.secretKey) {
      results.push({ project: p.name, status: 'skipped', notes: 'Missing API credentials' });
      continue;
    }
    const auth = Buffer.from(`${p.apiKey}:${p.secretKey}`).toString('base64');
    try {
      const res = await axios.post(
        'https://amplitude.com/api/2/deletions/users',
        { user_ids: [emailOrUserId], requester: 'privacy-request-portal' },
        { headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' } }
      );
      results.push({ project: p.name, status: 'completed', request_id: res.data?.[0]?.request_id, raw: res.data });
    } catch (err) {
      results.push({ project: p.name, status: 'failed', error: err.response?.data || err.message });
    }
  }
  const allOk = results.every(r => r.status === 'completed' || r.status === 'skipped');
  return {
    ok: allOk,
    status: allOk ? 'completed' : 'failed',
    notes: results.map(r => `${r.project}: ${r.status}${r.request_id ? ` (req ${r.request_id})` : ''}`).join('; '),
    response_data: results,
  };
}

module.exports = { deleteUser };
