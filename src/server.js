require('dotenv').config();
const express      = require('express');
const session      = require('express-session');
const cookieParser = require('cookie-parser');
const crypto       = require('crypto');
const path         = require('path');
const { exportJWK, importPKCS8, importSPKI, jwtVerify, createRemoteJWKSet } = require('jose');
const routes       = require('./routes');

const APP_URL        = (process.env.APP_URL || '').replace(/\/$/, '');
const SESSION_SECRET = process.env.SESSION_SECRET;
const PORT           = process.env.PORT || 3000;

if (!APP_URL || !SESSION_SECRET) {
  console.error('Missing required env vars: APP_URL, SESSION_SECRET');
  process.exit(1);
}

// ── RSA keypair — loaded from env vars, stable across restarts ────────────────
let toolPublicKey, toolPrivateKey;
const toolKid = process.env.LTI_KID;

(async () => {
  const privPem = (process.env.LTI_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const pubPem  = (process.env.LTI_PUBLIC_KEY  || '').replace(/\\n/g, '\n');
  if (!privPem || !pubPem || !toolKid) {
    console.error('Missing LTI_PRIVATE_KEY, LTI_PUBLIC_KEY or LTI_KID — see README');
    process.exit(1);
  }
  toolPrivateKey = await importPKCS8(privPem, 'RS256');
  toolPublicKey  = await importSPKI(pubPem,   'RS256');
})();

// ── Nonce store (in-memory, 10 min TTL) ──────────────────────────────────────
const usedNonces = new Map();
function registerNonce(n) { usedNonces.set(n, Date.now() + 10 * 60 * 1000); }
function consumeNonce(n) {
  const exp = usedNonces.get(n);
  if (!exp || Date.now() > exp) { usedNonces.delete(n); return false; }
  usedNonces.delete(n);
  return true;
}
setInterval(() => { const now = Date.now(); for (const [k,v] of usedNonces) if (now>v) usedNonces.delete(k); }, 60_000);

// ── Platform config from env ──────────────────────────────────────────────────
const platform = () => ({
  // Blackboard's issuer is always https://blackboard.com for all instances
  issuer:   'https://blackboard.com',
  clientId: process.env.BB_LTI_CLIENT_ID,
  // These come from the Developer Portal after registration
  authUrl:  process.env.BB_LTI_AUTH_URL  || 'https://developer.blackboard.com/api/v1/gateway/oidcauth',
  jwksUrl:  process.env.BB_LTI_JWKS_URL  || `https://developer.blackboard.com/api/v1/management/applications/${process.env.BB_LTI_CLIENT_ID}/jwks.json`,
});

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure:   process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge:   4 * 60 * 60 * 1000
  }
}));
app.use(express.static(path.join(__dirname, '../public')));

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true }));

// ── JWKS — Blackboard fetches our public key from here on every launch ────────
app.get('/keys', async (_, res) => {
  const jwk = await exportJWK(toolPublicKey);
  jwk.kid = toolKid;
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  res.json({ keys: [jwk] });
});

// ── Step 1: OIDC Login Initiation ─────────────────────────────────────────────
async function handleOidcLogin(req, res) {
  const p      = platform();
  const params = { ...req.query, ...req.body };

  // Log the issuer Blackboard sends — useful for debugging
  // Blackboard always sends iss=https://blackboard.com regardless of instance URL
  if (params.iss && params.iss !== p.issuer) {
    console.warn(`[LTI] Received iss=${params.iss}, expected ${p.issuer}`);
  }

  const state = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  registerNonce(nonce);
  req.session.ltiState = state;

  const qs = new URLSearchParams({
    scope: 'openid', response_type: 'id_token', response_mode: 'form_post',
    prompt: 'none', client_id: p.clientId,
    redirect_uri:      `${APP_URL}/lti/launch`,
    login_hint:        params.login_hint || '',
    lti_message_hint:  params.lti_message_hint || '',
    state, nonce,
  });
  res.redirect(`${p.authUrl}?${qs}`);
}
app.get('/lti',  handleOidcLogin);
app.post('/lti', handleOidcLogin);

// ── Step 2: LTI Launch ────────────────────────────────────────────────────────
app.post('/lti/launch', async (req, res) => {
  const p = platform();
  const { id_token, state } = req.body;
  if (!id_token)                                return res.status(400).send('Missing id_token');
  if (!state || state !== req.session.ltiState) return res.status(400).send('State mismatch');

  try {
    const JWKS = createRemoteJWKSet(new URL(p.jwksUrl));
    const { payload } = await jwtVerify(id_token, JWKS, { issuer: p.issuer, audience: p.clientId });

    if (!consumeNonce(payload.nonce)) return res.status(400).send('Invalid or replayed nonce');

    req.session.ltiToken = {
      sub:     payload.sub,
      name:    payload.name,
      email:   payload.email,
      roles:   payload['https://purl.imsglobal.org/spec/lti/claim/roles'] || [],
      context: payload['https://purl.imsglobal.org/spec/lti/claim/context'],
      iss:     payload.iss,
    };
    delete req.session.ltiState;
    res.redirect('/app');
  } catch (err) {
    console.error('[LTI] Launch error:', err.message);
    res.status(400).send(`LTI launch failed: ${err.message}`);
  }
});

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireLti(req, res, next) {
  if (req.session?.ltiToken) return next();
  if (process.env.NODE_ENV !== 'production') return next();
  res.status(401).json({ error: 'LTI session required' });
}

// ── App + API ─────────────────────────────────────────────────────────────────
app.get('/app', requireLti, (_, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
app.use('/api', requireLti, routes);

// ── Boot ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Adopt User Lookup LTI on port ${PORT}`);
  console.log(`  JWKS:   ${APP_URL}/keys`);
  console.log(`  Login:  ${APP_URL}/lti`);
  console.log(`  Launch: ${APP_URL}/lti/launch`);
});
