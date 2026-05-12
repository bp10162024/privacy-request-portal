const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

async function audit(requestId, action, actorEmail, details = {}) {
  await supabase.from('privacy_request_audit_log').insert({
    request_id: requestId,
    action,
    actor_email: actorEmail,
    details,
  });
}

module.exports = { supabase, audit };
