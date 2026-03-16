const express = require('express');
const fetch   = require('node-fetch');
const router  = express.Router();

const ADOPT_HOST = (process.env.ADOPT_HOST || 'https://app.pendo.io').replace(/\/$/, '');

// Read BB vars lazily so missing env vars show up clearly in errors
function bbConfig(req) {
  // Prefer bbHost from the LTI token (future multi-tenant support),
  // fall back to BB_HOST env var
  const tokenHost = req?.ltiUser?.bbHost || '';
  const url    = (tokenHost || process.env.BB_HOST || '').replace(/\/$/, '');
  const id     = process.env.BB_CLIENT_ID;
  const secret = process.env.BB_CLIENT_SECRET;
  if (!url)    throw new Error('BB_HOST is not set (check env vars or LTI token)');
  if (!id)     throw new Error('BB_CLIENT_ID env var is not set');
  if (!secret) throw new Error('BB_CLIENT_SECRET env var is not set');
  return { url, id, secret };
}

// ── BB token cache ────────────────────────────────────────────────────────────
let bbTokenCache = { token: null, expires: 0 };

async function getBbToken(req) {
  if (bbTokenCache.token && bbTokenCache.expires > Date.now()) return bbTokenCache.token;
  const { url, id, secret } = bbConfig(req);
  console.log(`[BB] Fetching token from ${url}`);
  const credentials = Buffer.from(`${id}:${secret}`).toString('base64');
  const resp = await fetch(`${url}/learn/api/public/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' })
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`BB token request failed: ${resp.status} — ${body.slice(0, 300)}`);
  }
  const data = await resp.json();
  bbTokenCache = { token: data.access_token, expires: Date.now() + (data.expires_in - 60) * 1000 };
  console.log('[BB] Token obtained successfully');
  return data.access_token;
}

function isPreviewUser(u) { return (u?.userName || '').toLowerCase().endsWith('_previewuser'); }
function adoptHeaders(key) { return { 'Content-Type': 'application/json', 'x-pendo-integration-key': key }; }

// ── Debug endpoint — shows env var status (no sensitive values) ───────────────
router.get('/debug', (req, res) => {
  res.json({
    BB_HOST:           process.env.BB_HOST ? `set (${process.env.BB_HOST})` : 'MISSING',
    BB_CLIENT_ID:      process.env.BB_CLIENT_ID ? `set (${process.env.BB_CLIENT_ID.slice(0,8)}...)` : 'MISSING',
    BB_CLIENT_SECRET:  process.env.BB_CLIENT_SECRET ? 'set' : 'MISSING',
    BB_LTI_CLIENT_ID:  process.env.BB_LTI_CLIENT_ID ? `set (${process.env.BB_LTI_CLIENT_ID.slice(0,8)}...)` : 'MISSING',
    ADOPT_HOST:        ADOPT_HOST,
    NODE_ENV:          process.env.NODE_ENV,
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BLACKBOARD
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/bb/user?email=foo@bar.com
router.get('/bb/user', async (req, res) => {
  const email = req.query.email?.trim();
  if (!email) return res.status(400).json({ error: 'email required' });
  const fields = 'uuid,userName,name.given,name.family,contact.email';
  try {
    const { url } = bbConfig(req);
    const token = await getBbToken(req);

    // Strategy 1: search endpoint
    const s1 = await fetch(`${url}/learn/api/public/v1/users?contact.email=${encodeURIComponent(email)}&fields=${fields}&limit=50`, { headers: { Authorization: `Bearer ${token}` } });
    if (s1.ok) {
      const d = await s1.json();
      const users = (d.results || []).filter(u => u?.uuid && !isPreviewUser(u));
      if (users.length) return res.json({ users });
    }

    // Strategy 2: secondary ID
    const s2 = await fetch(`${url}/learn/api/public/v1/users/contact.email:${encodeURIComponent(email)}?fields=${fields}`, { headers: { Authorization: `Bearer ${token}` } });
    if (s2.ok) { const u = await s2.json(); if (u?.uuid && !isPreviewUser(u)) return res.json({ users: [u] }); }

    // Strategy 3: userName = full email
    const s3 = await fetch(`${url}/learn/api/public/v1/users/userName:${encodeURIComponent(email)}?fields=${fields}`, { headers: { Authorization: `Bearer ${token}` } });
    if (s3.ok) { const u = await s3.json(); if (u?.uuid && !isPreviewUser(u)) return res.json({ users: [u] }); }

    // Strategy 4: userName = local part
    const local = email.split('@')[0];
    const s4 = await fetch(`${url}/learn/api/public/v1/users/userName:${encodeURIComponent(local)}?fields=${fields}`, { headers: { Authorization: `Bearer ${token}` } });
    if (s4.ok) { const u = await s4.json(); if (u?.uuid && !isPreviewUser(u)) return res.json({ users: [u] }); }

    res.json({ users: [] });
  } catch (err) {
    console.error('[BB] user lookup error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/bb/user/uuid/:uuid
router.get('/bb/user/uuid/:uuid', async (req, res) => {
  try {
    const { url } = bbConfig(req);
    const token = await getBbToken(req);
    const uuid = req.params.uuid;
    const fullUrl = `${url}/learn/api/public/v1/users/uuid:${encodeURIComponent(uuid)}?fields=uuid,userName,name.given,name.family,contact.email`;
    console.log(`[BB] UUID lookup: ${fullUrl}`);
    const r = await fetch(fullUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      const body = await r.text();
      console.error(`[BB] UUID lookup failed ${r.status}: ${body.slice(0, 300)}`);
      return res.status(r.status).json({ error: `BB returned ${r.status}`, detail: body.slice(0, 300) });
    }
    res.json(await r.json());
  } catch (err) {
    console.error('[BB] uuid lookup error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// PENDO / ADOPT
// ═════════════════════════════════════════════════════════════════════════════

router.get('/adopt/segments', async (req, res) => {
  const { key, createdByApi } = req.query;
  if (!key) return res.status(400).json({ error: 'key required' });
  try {
    const qs = createdByApi !== undefined ? `?createdByApi=${createdByApi}` : '';
    const r  = await fetch(`${ADOPT_HOST}/api/v1/segment${qs}`, { headers: adoptHeaders(key) });
    if (!r.ok) return res.status(r.status).json({ error: `Pendo returned ${r.status}` });
    res.json(await r.json());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/adopt/segments/members', async (req, res) => {
  const { key, segmentId } = req.body;
  if (!key || !segmentId) return res.status(400).json({ error: 'key and segmentId required' });
  try {
    const r = await fetch(`${ADOPT_HOST}/api/v1/aggregation`, {
      method: 'POST', headers: adoptHeaders(key),
      body: JSON.stringify({ response: { mimeType: 'application/json' }, request: { pipeline: [{ source: { visitors: null } }, { segment: { id: segmentId } }, { select: { visitorId: 'visitorId' } }] } })
    });
    if (!r.ok) return res.status(r.status).json({ error: `Pendo returned ${r.status}` });
    res.json(await r.json());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/adopt/segments/create', async (req, res) => {
  const { key, name, visitors } = req.body;
  if (!key || !name || !visitors) return res.status(400).json({ error: 'key, name, visitors required' });
  try {
    // Pendo expects visitors as array of objects: [{visitorId: "..."}]
    const visitorObjects = visitors.map(v => typeof v === 'string' ? { visitorId: v } : v);
    console.log(`[Adopt] Creating segment "${name}" with ${visitorObjects.length} visitors`);
    console.log(`[Adopt] Sample visitor: ${JSON.stringify(visitorObjects[0])}`);
    const r = await fetch(`${ADOPT_HOST}/api/v1/segment/upload`, {
      method: 'POST', headers: adoptHeaders(key), body: JSON.stringify({ name, visitors: visitorObjects })
    });
    if (!r.ok) {
      const body = await r.text();
      console.error(`[Adopt] Create failed ${r.status}: ${body.slice(0,300)}`);
      return res.status(r.status).json({ error: `Pendo returned ${r.status}`, detail: body.slice(0,300) });
    }
    res.json(await r.json());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/adopt/segments/:segmentId', async (req, res) => {
  const { key, visitors } = req.body;
  if (!key || !visitors) return res.status(400).json({ error: 'key and visitors required' });
  try {
    // Pendo expects visitors as array of objects: [{visitorId: "..."}]
    const visitorObjects = visitors.map(v => typeof v === 'string' ? { visitorId: v } : v);
    const r = await fetch(`${ADOPT_HOST}/api/v1/segment/${req.params.segmentId}`, {
      method: 'PUT', headers: adoptHeaders(key), body: JSON.stringify({ visitors: visitorObjects })
    });
    if (!r.ok) {
      const body = await r.text();
      console.error(`[Adopt] Update failed ${r.status}: ${body.slice(0,300)}`);
      return res.status(r.status).json({ error: `Pendo returned ${r.status}`, detail: body.slice(0,300) });
    }
    res.json(await r.json());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/adopt/status', async (req, res) => {
  const { url, key } = req.query;
  if (!url || !key) return res.status(400).json({ error: 'url and key required' });
  try {
    const r = await fetch(url, { headers: { 'x-pendo-integration-key': key } });
    if (!r.ok) return res.status(r.status).json({ error: `Pendo returned ${r.status}` });
    res.json(await r.json());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
