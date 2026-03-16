require('dotenv').config();
const express      = require('express');
const cookieParser = require('cookie-parser');
const crypto       = require('crypto');
const path         = require('path');
const { exportJWK, importPKCS8, importSPKI, jwtVerify, createRemoteJWKSet, SignJWT } = require('jose');
const routes       = require('./routes');

const APP_URL        = (process.env.APP_URL || '').replace(/\/$/, '');
const SESSION_SECRET = process.env.SESSION_SECRET;
const PORT           = process.env.PORT || 3000;

if (!APP_URL || !SESSION_SECRET) {
  console.error('Missing required env vars: APP_URL, SESSION_SECRET');
  process.exit(1);
}

// ── RSA keypair (for BB JWT verification) ─────────────────────────────────────
let toolPublicKey, toolPrivateKey;
const toolKid = process.env.LTI_KID;

(async () => {
  const privPem = (process.env.LTI_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const pubPem  = (process.env.LTI_PUBLIC_KEY  || '').replace(/\\n/g, '\n');
  if (!privPem || !pubPem || !toolKid) {
    console.error('Missing LTI_PRIVATE_KEY, LTI_PUBLIC_KEY or LTI_KID');
    process.exit(1);
  }
  toolPrivateKey = await importPKCS8(privPem, 'RS256');
  toolPublicKey  = await importSPKI(pubPem,   'RS256');
})();

// ── App-level signing key (for our own session tokens) ────────────────────────
// Derived from SESSION_SECRET — stable across restarts
const appSigningKey = crypto.createHmac('sha256', SESSION_SECRET)
  .update('app-signing-key-v1')
  .digest();

async function signAppToken(payload) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('4h')
    .sign(appSigningKey);
}

async function verifyAppToken(token) {
  const { createSecretKey } = require('crypto');
  const { jwtVerify: jv } = require('jose');
  const { payload } = await jv(token, appSigningKey);
  return payload;
}

// ── Nonce store ───────────────────────────────────────────────────────────────
const usedNonces = new Map();
function registerNonce(n) { usedNonces.set(n, Date.now() + 10 * 60 * 1000); }
function consumeNonce(n) {
  const exp = usedNonces.get(n);
  if (!exp || Date.now() > exp) { usedNonces.delete(n); return false; }
  usedNonces.delete(n);
  return true;
}
setInterval(() => { const now = Date.now(); for (const [k,v] of usedNonces) if (now>v) usedNonces.delete(k); }, 60_000);

// ── State store ───────────────────────────────────────────────────────────────
const pendingStates = new Map();
function saveState(state, nonce) {
  pendingStates.set(state, { nonce, expires: Date.now() + 10 * 60 * 1000 });
}
function consumeState(state) {
  const entry = pendingStates.get(state);
  if (!entry || Date.now() > entry.expires) { pendingStates.delete(state); return null; }
  pendingStates.delete(state);
  return entry;
}
setInterval(() => { const now = Date.now(); for (const [k,v] of pendingStates) if (now > v.expires) pendingStates.delete(k); }, 60_000);

// ── Platform config ───────────────────────────────────────────────────────────
const platform = () => ({
  issuer:   'https://blackboard.com',
  clientId: process.env.BB_LTI_CLIENT_ID,
  authUrl:  process.env.BB_LTI_AUTH_URL  || 'https://developer.blackboard.com/api/v1/gateway/oidcauth',
  jwksUrl:  process.env.BB_LTI_JWKS_URL  || `https://developer.blackboard.com/api/v1/management/applications/${process.env.BB_LTI_CLIENT_ID}/jwks.json`,
});

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true }));

// ── Debug — no auth, shows env var status ─────────────────────────────────────
app.get('/debug', (_, res) => {
  const cid = process.env.BB_CLIENT_ID || '';
  const lid = process.env.BB_LTI_CLIENT_ID || '';
  res.json({
    BB_HOST:          process.env.BB_HOST ? `set → ${process.env.BB_HOST}` : 'MISSING',
    BB_CLIENT_ID:     cid ? `set → ${cid.slice(0,8)}...` : 'MISSING',
    BB_CLIENT_SECRET: process.env.BB_CLIENT_SECRET ? 'set' : 'MISSING',
    BB_LTI_CLIENT_ID: lid ? `set → ${lid.slice(0,8)}...` : 'MISSING',
    SESSION_SECRET:   process.env.SESSION_SECRET ? 'set' : 'MISSING',
    APP_URL:          process.env.APP_URL || 'MISSING',
    NODE_ENV:         process.env.NODE_ENV || 'not set',
  });
});

// ── JWKS ──────────────────────────────────────────────────────────────────────
app.get('/keys', async (_, res) => {
  const jwk = await exportJWK(toolPublicKey);
  jwk.kid = toolKid; jwk.alg = 'RS256'; jwk.use = 'sig';
  res.json({ keys: [jwk] });
});

// ── Step 1: OIDC Login Initiation ─────────────────────────────────────────────
async function handleOidcLogin(req, res) {
  const p      = platform();
  const params = { ...req.query, ...req.body };

  const state = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  registerNonce(nonce);
  saveState(state, nonce);

  const qs = new URLSearchParams({
    scope: 'openid', response_type: 'id_token', response_mode: 'form_post',
    prompt: 'none', client_id: p.clientId,
    redirect_uri:     `${APP_URL}/lti/launch`,
    login_hint:       params.login_hint || '',
    lti_message_hint: params.lti_message_hint || '',
    state, nonce,
  });

  console.log(`[LTI] Login init — state=${state}`);
  res.redirect(`${p.authUrl}?${qs}`);
}
app.get('/lti',  handleOidcLogin);
app.post('/lti', handleOidcLogin);

// ── Step 2: LTI Launch ────────────────────────────────────────────────────────
app.post('/lti/launch', async (req, res) => {
  const p = platform();
  const { id_token, state } = req.body;

  if (!id_token) return res.status(400).send('Missing id_token');
  if (!state)    return res.status(400).send('Missing state');

  const stateEntry = consumeState(state);
  if (!stateEntry) {
    console.error(`[LTI] State not found — received=${state}`);
    return res.status(400).send('State mismatch — please try launching the tool again from Blackboard.');
  }

  try {
    const JWKS = createRemoteJWKSet(new URL(p.jwksUrl));
    const { payload } = await jwtVerify(id_token, JWKS, { issuer: p.issuer, audience: p.clientId });

    if (!consumeNonce(payload.nonce)) return res.status(400).send('Invalid or replayed nonce');

    // Derive UUID prefix from the sub claim: sub looks like "<prefix>_<uuid>"
    // The prefix is shared across all users on the same BB instance
    const sub = payload.sub || '';
    const lastUnderscore = sub.lastIndexOf('_');
    const uuidPrefix = lastUnderscore > 0 ? sub.slice(0, lastUnderscore + 1) : '';
    console.log(`[LTI] Derived UUID prefix: ${uuidPrefix}`);

    const appToken = await signAppToken({
      sub:       sub,
      name:      payload.name,
      email:     payload.email,
      roles:     payload['https://purl.imsglobal.org/spec/lti/claim/roles'] || [],
      context:   payload['https://purl.imsglobal.org/spec/lti/claim/context'],
      iss:       payload.iss,
      uuidPrefix: uuidPrefix,
      bbHost:     process.env.BB_HOST || '',
    });

    console.log(`[LTI] Launch success — sub=${payload.sub}`);

    // Pass token in URL hash — never sent to server, readable by frontend before sessionStorage
    const tokenJson = JSON.stringify(appToken);
    res.send(`<!DOCTYPE html>
<html>
<head><title>Launching…</title></head>
<body>
<script>
  var token = ${tokenJson};
  // Try sessionStorage first, fall back silently
  try { sessionStorage.setItem('lti_token', token); } catch(e) {}
  // Also store in window.name which survives cross-origin iframe navigation
  try { window.name = 'lti_token:' + token; } catch(e) {}
  // Pass token in hash so /app can read it even if sessionStorage is blocked
  window.location.replace('/app#t=' + encodeURIComponent(token));
</script>
<p>Launching… <a href="/app">click here if not redirected</a></p>
</body>
</html>`);

  } catch (err) {
    console.error('[LTI] Launch error:', err.message);
    res.status(400).send(`LTI launch failed: ${err.message}`);
  }
});

// ── Auth middleware — reads token from Authorization header ───────────────────
async function requireLti(req, res, next) {
  // Dev mode bypass
  if (process.env.NODE_ENV !== 'production') return next();

  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

  if (!token) return res.status(401).json({ error: 'LTI session required' });

  try {
    req.ltiUser = await verifyAppToken(token);
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
}

// ── App shell — no auth needed, frontend handles it ──────────────────────────
app.get('/app', (_, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

// ── API routes — protected by Bearer token ────────────────────────────────────
app.use('/api', requireLti, routes);

// ── Boot ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Adopt User Lookup LTI on port ${PORT}`);
  console.log(`  JWKS:   ${APP_URL}/keys`);
  console.log(`  Login:  ${APP_URL}/lti`);
  console.log(`  Launch: ${APP_URL}/lti/launch`);
});
