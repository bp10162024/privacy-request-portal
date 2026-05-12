const { OAuth2Client } = require('google-auth-library');
const { supabase } = require('./supabase');

const googleOAuth = new OAuth2Client(
  process.env.GOOGLE_OAUTH_CLIENT_ID,
  process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  `${process.env.BASE_URL}/auth/callback`
);

function getGoogleAuthUrl() {
  return googleOAuth.generateAuthUrl({
    access_type: 'online',
    scope: ['openid', 'email', 'profile'],
    prompt: 'select_account',
  });
}

async function handleCallback(code) {
  const { tokens } = await googleOAuth.getToken(code);
  const ticket = await googleOAuth.verifyIdToken({
    idToken: tokens.id_token,
    audience: process.env.GOOGLE_OAUTH_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  const email = (payload.email || '').toLowerCase();

  // Check if email is in allowlist
  const { data: user } = await supabase
    .from('privacy_request_users')
    .select('*')
    .eq('email', email)
    .maybeSingle();

  if (!user) {
    return { ok: false, error: `Email ${email} is not authorized to access this portal.` };
  }

  await supabase
    .from('privacy_request_users')
    .update({ last_login_at: new Date().toISOString() })
    .eq('id', user.id);

  return {
    ok: true,
    user: {
      email,
      name: payload.name || email,
      picture: payload.picture,
      role: user.role,
    },
  };
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.role !== 'admin') {
    return res.status(403).send('Admin access required.');
  }
  next();
}

module.exports = { getGoogleAuthUrl, handleCallback, requireAuth, requireAdmin };
