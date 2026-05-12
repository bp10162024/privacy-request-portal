const Stripe = require('stripe');

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

async function findCustomerByEmail(email) {
  if (!stripe) return null;
  const list = await stripe.customers.list({ email, limit: 5 });
  return list.data;
}

async function hasActiveSubscriptions(customerId) {
  if (!stripe) return false;
  const subs = await stripe.subscriptions.list({ customer: customerId, status: 'active', limit: 1 });
  return subs.data.length > 0;
}

async function deleteIfInactive(email) {
  if (!stripe) {
    return { ok: false, status: 'failed', notes: 'STRIPE_SECRET_KEY not configured', external_reference: null };
  }
  const customers = await findCustomerByEmail(email);
  if (!customers || customers.length === 0) {
    return { ok: true, status: 'completed', notes: `No Stripe customer found for ${email}.`, external_reference: null };
  }
  const deleted = [];
  const retained = [];
  for (const c of customers) {
    if (await hasActiveSubscriptions(c.id)) {
      retained.push(c.id);
      continue;
    }
    await stripe.customers.del(c.id);
    deleted.push(c.id);
  }
  const notes = [
    deleted.length ? `Deleted ${deleted.length} inactive customer(s): ${deleted.join(', ')}.` : null,
    retained.length ? `Retained ${retained.length} active customer(s) under CCPA financial-records exception §1798.105(d)(6): ${retained.join(', ')}.` : null,
  ].filter(Boolean).join(' ');
  return {
    ok: true,
    status: retained.length && !deleted.length ? 'not_applicable' : 'completed',
    notes,
    external_reference: [...deleted, ...retained].join(','),
  };
}

module.exports = { findCustomerByEmail, hasActiveSubscriptions, deleteIfInactive };
