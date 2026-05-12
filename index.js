// Privacy Request Portal — entry point
const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const cron = require('node-cron');
const { parse } = require('csv-parse/sync');

const { supabase, audit } = require('./lib/supabase');
const { getGoogleAuthUrl, handleCallback, requireAuth, requireAdmin } = require('./lib/auth');
const { postMessage } = require('./lib/slack');
const runner = require('./lib/runner');
const googleInt = require('./lib/integrations/google');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ dest: '/tmp/' });

app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 8, sameSite: 'lax' },
}));

function render(res, view, locals = {}) {
  res.render(view, locals, (err, body) => {
    if (err) {
      console.error('Render error', err);
      return res.status(500).send('Template error: ' + err.message);
    }
    res.render('layout', { ...locals, body, user: res.locals.user, flash: res.locals.flash, title: locals.title });
  });
}

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.flash = req.session.flash || null;
  req.session.flash = null;
  next();
});

app.get('/healthz', (_req, res) => res.send('OK'));
app.get('/', requireAuth, async (req, res) => {
  const { data: open } = await supabase.from('privacy_requests_open').select('*').order('deadline_at', { ascending: true });
  const { data: completed } = await supabase
    .from('privacy_requests')
    .select('*')
    .eq('status', 'completed')
    .order('completed_at', { ascending: false })
    .limit(10);
  render(res, 'dashboard', { open, completed, title: 'Dashboard' });
});

app.get('/login', (req, res) => {
  res.render('login', { error: req.query.error });
});
app.get('/auth/google', (_req, res) => {
  res.redirect(getGoogleAuthUrl());
});
app.get('/auth/callback', async (req, res) => {
  try {
    const result = await handleCallback(req.query.code);
    if (!result.ok) return res.redirect('/login?error=' + encodeURIComponent(result.error));
    req.session.user = result.user;
    req.session.save((err) => {
      if (err) {
        console.error('Session save error', err);
        return res.redirect('/login?error=' + encodeURIComponent('Session error: ' + err.message));
      }
      res.redirect('/');
    });
  } catch (err) {
    console.error('Auth callback error', err);
    res.redirect('/login?error=' + encodeURIComponent(err.message));
  }
});
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/oauth/google/authorize', requireAdmin, (_req, res) => {
  res.redirect(googleInt.getAuthUrl());
});
app.get('/oauth/google/callback', requireAdmin, async (req, res) => {
  try {
    await googleInt.exchangeCode(req.query.code, req.session.user.email);
    req.session.flash = { type: 'ok', message: 'Google OAuth authorized for GA4 + Google Ads.' };
    res.redirect('/');
  } catch (err) {
    req.session.flash = { type: 'error', message: 'OAuth failed: ' + err.message };
    res.redirect('/');
  }
});

app.get('/requests/new', requireAuth, (_req, res) => {
  render(res, 'new_request', { title: 'New Request' });
});
app.post('/requests/new', requireAuth, async (req, res) => {
  const { requester_email, requester_name, source, request_type, source_url, notes } = req.body;
  const dateReceived = new Date();
  const deadline = new Date(dateReceived);
  if (request_type === 'opt_out' || request_type === 'limit') {
    deadline.setDate(deadline.getDate() + 21);
  } else {
    deadline.setDate(deadline.getDate() + 45);
  }
  const { data, error } = await supabase
    .from('privacy_requests')
    .insert({
      requester_email: requester_email.toLowerCase().trim(),
      requester_name,
      source,
      request_type,
      source_url,
      notes,
      deadline_at: deadline.toISOString(),
      date_received: dateReceived.toISOString(),
      status: 'received',
      created_by: req.session.user.email,
    })
    .select()
    .single();
  if (error) {
    req.session.flash = { type: 'error', message: error.message };
    return res.redirect('/requests/new');
  }
  await runner.ensureActionsForRequest(data);
  await audit(data.id, 'request.created', req.session.user.email, { source, request_type });
  await postMessage(
    `:lock: New privacy request received\n*Type:* ${request_type}  *From:* ${requester_email}\n*Deadline:* ${deadline.toLocaleDateString()}\n${process.env.BASE_URL}/requests/${data.id}`,
  );
  res.redirect(`/requests/${data.id}`);
});

app.get('/requests/:id', requireAuth, async (req, res) => {
  const { data: r } = await supabase.from('privacy_requests').select('*').eq('id', req.params.id).single();
  if (!r) return res.status(404).send('Not found');
  const { data: actionsRaw } = await supabase.from('privacy_request_actions').select('*').eq('request_id', r.id);
  const destList = runner.destinationsForRequest(r);
  const actions = destList.map(d => {
    const a = (actionsRaw || []).find(x => x.destination === d.key) || {};
    return {
      destination: d.key,
      label: d.label,
      automated: d.automated,
      docs: d.docs,
      naReason: d.naReason,
      status: a.status || (d.naReason ? 'not_applicable' : 'pending'),
      executed_at: a.executed_at,
      executed_by: a.executed_by,
      external_reference: a.external_reference,
      response_data: a.response_data,
      error_message: a.error_message,
    };
  });
  const { data: auditLog } = await supabase
    .from('privacy_request_audit_log')
    .select('*')
    .eq('request_id', r.id)
    .order('created_at', { ascending: false })
    .limit(50);
  const allDone = actions.every(a => a.status === 'completed' || a.status === 'skipped' || a.status === 'not_applicable');
  render(res, 'request_detail', { req: r, actions, auditLog: auditLog || [], allDone, title: r.requester_email });
});

app.post('/requests/:id/run/:destination', requireAuth, async (req, res) => {
  const { data: r } = await supabase.from('privacy_requests').select('*').eq('id', req.params.id).single();
  if (!r) return res.status(404).send('Not found');
  if (r.status === 'received') {
    await supabase.from('privacy_requests').update({ status: 'in_progress', acknowledged_at: new Date().toISOString() }).eq('id', r.id);
  }
  try {
    const result = await runner.runDestination(r, req.params.destination, req.session.user.email);
    req.session.flash = { type: result.ok ? 'ok' : 'error', message: `${req.params.destination}: ${result.notes || result.status}` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect(`/requests/${r.id}`);
});

app.post('/requests/:id/run-all', requireAuth, async (req, res) => {
  const { data: r } = await supabase.from('privacy_requests').select('*').eq('id', req.params.id).single();
  if (!r) return res.status(404).send('Not found');
  if (r.status === 'received') {
    await supabase.from('privacy_requests').update({ status: 'in_progress', acknowledged_at: new Date().toISOString() }).eq('id', r.id);
  }
  const results = await runner.runAllAutomated(r, req.session.user.email);
  const okCount = Object.values(results).filter(x => x.ok).length;
  req.session.flash = { type: 'ok', message: `Ran ${okCount}/${Object.keys(results).length} automated destinations.` };
  res.redirect(`/requests/${r.id}`);
});

app.post('/requests/:id/manual-complete/:destination', requireAuth, async (req, res) => {
  const { data: r } = await supabase.from('privacy_requests').select('*').eq('id', req.params.id).single();
  await runner.markManualComplete(r, req.params.destination, req.session.user.email, req.body.notes);
  res.redirect(`/requests/${r.id}`);
});

app.post('/requests/:id/complete', requireAuth, async (req, res) => {
  const { data: r } = await supabase.from('privacy_requests').select('*').eq('id', req.params.id).single();
  await supabase.from('privacy_requests').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', r.id);
  await audit(r.id, 'request.completed', req.session.user.email);
  await postMessage(
    `:white_check_mark: Privacy request completed\n*From:* ${r.requester_email}  *Type:* ${r.request_type}\n${process.env.BASE_URL}/requests/${r.id}`,
  );
  req.session.flash = { type: 'ok', message: 'Request marked complete. Send the confirmation email to the requester manually for now (see runbook).' };
  res.redirect(`/requests/${r.id}`);
});

app.get('/users', requireAdmin, async (req, res) => {
  const { data: users } = await supabase.from('privacy_request_users').select('*').order('created_at');
  render(res, 'users', { users: users || [], currentUser: req.session.user, title: 'Users' });
});
app.post('/users/add', requireAdmin, async (req, res) => {
  const { email, role } = req.body;
  await supabase.from('privacy_request_users').upsert({
    email: email.toLowerCase().trim(),
    role,
    added_by: req.session.user.email,
  });
  res.redirect('/users');
});
app.post('/users/:id/remove', requireAdmin, async (req, res) => {
  await supabase.from('privacy_request_users').delete().eq('id', req.params.id);
  res.redirect('/users');
});

app.get('/import', requireAdmin, (_req, res) => {
  render(res, 'import', { result: null, title: 'Bulk Import' });
});
app.post('/import', requireAdmin, upload.single('csvfile'), async (req, res) => {
  let imported = 0;
  const errors = [];
  try {
    const text = fs.readFileSync(req.file.path, 'utf-8');
    const rows = parse(text, { columns: true, skip_empty_lines: true, trim: true });
    for (const row of rows) {
      try {
        const dateReceived = row.date_received ? new Date(row.date_received) : new Date();
        const deadline = new Date(dateReceived);
        if (row.request_type === 'opt_out' || row.request_type === 'limit') deadline.setDate(deadline.getDate() + 21);
        else deadline.setDate(deadline.getDate() + 45);
        const { data, error } = await supabase
          .from('privacy_requests')
          .insert({
            requester_email: (row.requester_email || '').toLowerCase().trim(),
            requester_name: row.requester_name || null,
            source: row.source || 'other',
            request_type: row.request_type || 'opt_out',
            source_url: row.source_url || null,
            notes: row.notes || null,
            date_received: dateReceived.toISOString(),
            deadline_at: deadline.toISOString(),
            status: 'received',
            created_by: req.session.user.email,
          })
          .select()
          .single();
        if (error) throw error;
        await runner.ensureActionsForRequest(data);
        imported++;
      } catch (e) {
        errors.push(`Row ${row.requester_email || JSON.stringify(row)}: ${e.message}`);
      }
    }
  } catch (e) {
    errors.push(e.message);
  } finally {
    try { fs.unlinkSync(req.file.path); } catch {}
  }
  render(res, 'import', { result: { imported, errors }, title: 'Bulk Import' });
});

app.get('/admin/quarterly-summary', requireAdmin, async (_req, res) => {
  const since = new Date();
  since.setMonth(since.getMonth() - 3);
  const { data } = await supabase
    .from('privacy_requests')
    .select('*')
    .gte('date_received', since.toISOString());
  const total = data.length;
  const byType = {};
  let totalDays = 0;
  let completedCount = 0;
  for (const r of data) {
    byType[r.request_type] = (byType[r.request_type] || 0) + 1;
    if (r.completed_at && r.date_received) {
      totalDays += (new Date(r.completed_at) - new Date(r.date_received)) / (1000 * 60 * 60 * 24);
      completedCount++;
    }
  }
  const avgDays = completedCount ? (totalDays / completedCount).toFixed(1) : 'n/a';
  res.json({ since: since.toISOString(), total, by_type: byType, average_completion_days: avgDays });
});

cron.schedule('0 9 * * *', async () => {
  console.log('[cron] running deadline check');
  const { data } = await supabase
    .from('privacy_requests_open')
    .select('*')
    .lt('deadline_at', new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString());
  for (const r of data || []) {
    const days = Math.max(0, Math.floor(r.days_remaining));
    await postMessage(
      `:warning: Privacy request approaching deadline (T-${days}d)\n*From:* ${r.requester_email}  *Type:* ${r.request_type}\n*Deadline:* ${new Date(r.deadline_at).toLocaleDateString()}\n${process.env.BASE_URL}/requests/${r.id}`,
    );
  }
}, { timezone: 'America/Chicago' });

cron.schedule('0 9 1-7 1,4,7,10 1', async () => {
  console.log('[cron] running quarterly summary');
  const since = new Date();
  since.setMonth(since.getMonth() - 3);
  const { data } = await supabase
    .from('privacy_requests')
    .select('*')
    .gte('date_received', since.toISOString());
  const total = data.length;
  const byType = {};
  for (const r of data) byType[r.request_type] = (byType[r.request_type] || 0) + 1;
  const lines = [
    `:bar_chart: *Quarterly Privacy Request Summary* (last 3 months)`,
    `Total: ${total}`,
    ...Object.entries(byType).map(([k, v]) => `• ${k}: ${v}`),
  ];
  await postMessage(lines.join('\n'));
}, { timezone: 'America/Chicago' });

app.listen(PORT, () => {
  console.log(`Privacy Request Portal listening on :${PORT}`);
});
