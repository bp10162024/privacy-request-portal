const axios = require('axios');

const HUBSPOT_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
const BASE = 'https://api.hubapi.com';

async function hub(method, path, body = null) {
  const res = await axios({
    method,
    url: `${BASE}${path}`,
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, 'Content-Type': 'application/json' },
    data: body,
    validateStatus: () => true,
  });
  if (res.status >= 400) throw new Error(`HubSpot ${method} ${path} → ${res.status}: ${JSON.stringify(res.data)}`);
  return res.data;
}

async function findContactByEmail(email) {
  const data = await hub('POST', '/crm/v3/objects/contacts/search', {
    filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
    properties: ['email', 'firstname', 'lastname', 'do_not_sell', 'hs_marketable_status'],
    limit: 1,
  });
  return data.results?.[0] || null;
}

async function flagDoNotSell(email, requestId) {
  const contact = await findContactByEmail(email);
  if (!contact) {
    return { ok: true, status: 'completed', notes: `No HubSpot contact found for ${email}. Nothing to flag.`, external_reference: null };
  }
  try {
    await hub('PATCH', `/crm/v3/objects/contacts/${contact.id}`, {
      properties: { do_not_sell: 'true', hs_marketable_status: 'NON_MARKETABLE', privacy_request_id: requestId },
    });
  } catch (err) {
    // Some properties may not exist on every account — fall back to just do_not_sell + marketable_status
    try {
      await hub('PATCH', `/crm/v3/objects/contacts/${contact.id}`, {
        properties: { do_not_sell: 'true', hs_marketable_status: 'NON_MARKETABLE' },
      });
    } catch (err2) {
      await hub('PATCH', `/crm/v3/objects/contacts/${contact.id}`, {
        properties: { hs_marketable_status: 'NON_MARKETABLE' },
      });
      return {
        ok: true,
        status: 'completed',
        notes: `Set hs_marketable_status=NON_MARKETABLE on contact ${contact.id}. do_not_sell custom property not writable — check HubSpot property settings.`,
        external_reference: contact.id,
      };
    }
  }
  return {
    ok: true,
    status: 'completed',
    notes: `Flagged contact ${contact.id} as do_not_sell + non-marketable.`,
    external_reference: contact.id,
  };
}

// HubSpot GDPR-delete endpoint:
//   POST /crm/v3/objects/contacts/gdpr-delete
//   { "idProperty": "email", "objectId": "<email>" }
// NOT a DELETE on /contacts/{id}/gdpr-delete (that path doesn't exist).
async function permanentDelete(email) {
  const contact = await findContactByEmail(email);
  if (!contact) {
    return { ok: true, status: 'completed', notes: `No HubSpot contact found for ${email}.`, external_reference: null };
  }
  await hub('POST', `/crm/v3/objects/contacts/gdpr-delete`, {
    idProperty: 'email',
    objectId: email,
  });
  return {
    ok: true,
    status: 'completed',
    notes: `Permanently deleted contact ${contact.id} via HubSpot GDPR-delete endpoint. HubSpot propagates removal to synced ad-platform audiences automatically.`,
    external_reference: contact.id,
  };
}

module.exports = { findContactByEmail, flagDoNotSell, permanentDelete };
