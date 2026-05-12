const axios = require('axios');

const INTERCOM_TOKEN = process.env.INTERCOM_ACCESS_TOKEN;
const BASE = 'https://api.intercom.io';

async function intercom(method, path, body = null) {
  const res = await axios({
    method,
    url: `${BASE}${path}`,
    headers: {
      Authorization: `Bearer ${INTERCOM_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Intercom-Version': '2.11',
    },
    data: body,
    validateStatus: () => true,
  });
  if (res.status >= 400) throw new Error(`Intercom ${method} ${path} → ${res.status}: ${JSON.stringify(res.data)}`);
  return res.data;
}

async function findContactByEmail(email) {
  const data = await intercom('POST', '/contacts/search', {
    query: { field: 'email', operator: '=', value: email },
  });
  return data.data?.[0] || null;
}

async function permanentDelete(email) {
  const contact = await findContactByEmail(email);
  if (!contact) {
    return { ok: true, status: 'completed', notes: `No Intercom contact found for ${email}.`, external_reference: null };
  }
  const deletion = await intercom('POST', '/user_delete_requests', { intercom_user_id: contact.id });
  return {
    ok: true,
    status: 'completed',
    notes: `Submitted Intercom user_delete_request for contact ${contact.id}. Recoverable within 7 days, then permanently destroyed.`,
    external_reference: deletion.id || contact.id,
  };
}

module.exports = { findContactByEmail, permanentDelete };
