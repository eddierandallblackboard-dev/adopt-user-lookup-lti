const express = require('express');
const fetch   = require('node-fetch');
const router  = express.Router();

const DEFAULT_ADOPT_HOST = (process.env.ADOPT_HOST || 'https://app.pendo.io').replace(/\/$/, '');

function getAdoptHost(req) {
  // Use host from request if provided, fall back to env var
  const h = req.body?.adoptHost || req.query?.adoptHost || '';
  return (h || DEFAULT_ADOPT_HOST).replace(/\/$/, '');
}

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

// GET /api/bb/siteinfo — tries multiple endpoints to find BB site/system ID
router.get('/bb/siteinfo', async (req, res) => {
  try {
    const token = await getBbToken(req);
    const { url } = bbConfig(req);
    const endpoints = [
      '/learn/api/public/v1/system/version',
      '/learn/api/public/v1/system/properties',
      '/learn/api/public/v1/system/settings/cloud',
      '/learn/api/public/v1/system/settings',
    ];
    const results = {};
    for (const ep of endpoints) {
      try {
        const r = await fetch(`${url}${ep}`, { headers: { Authorization: `Bearer ${token}` } });
        const body = await r.text();
        results[ep] = { status: r.status, body: body.slice(0, 500) };
        console.log(`[BB] ${ep} → ${r.status}: ${body.slice(0, 200)}`);
      } catch(e) {
        results[ep] = { error: e.message };
      }
    }
    res.json(results);
  } catch (err) {
    console.error('[BB] siteinfo error:', err.message);
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
    const host = getAdoptHost(req);
    const qs = createdByApi !== undefined ? `?createdByApi=${createdByApi}` : '';
    console.log(`[Adopt] GET segments from ${host}`);
    const r  = await fetch(`${host}/api/v1/segment${qs}`, { headers: adoptHeaders(key) });
    if (!r.ok) return res.status(r.status).json({ error: `Pendo returned ${r.status}` });
    res.json(await r.json());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/adopt/prefix?key=xxx
// Discovers the visitor ID prefix by sampling any segment's members
router.get('/adopt/prefix', async (req, res) => {
  const { key } = req.query;
  console.log('[Adopt] /prefix called, key present:', !!key);
  if (!key) return res.status(400).json({ error: 'key required' });
  const adoptHost = getAdoptHost(req);
  try {
    // Get any segment to sample a visitor ID from
    const segR = await fetch(`${adoptHost}/api/v1/segment?createdByApi=false`, { headers: adoptHeaders(key) });
    if (!segR.ok) return res.status(segR.status).json({ error: `Pendo returned ${segR.status}` });
    const segments = await segR.json();
    const list = Array.isArray(segments) ? segments : (segments.results || []);
    
    // Try each segment until we find one with members
    for (const seg of list.slice(0, 5)) {
      const memR = await fetch(`${adoptHost}/api/v1/aggregation`, {
        method: 'POST', headers: adoptHeaders(key),
        body: JSON.stringify({ response: { mimeType: 'application/json' }, request: { pipeline: [
          { source: { visitors: null } },
          { segment: { id: seg.id } },
          { select: { visitorId: 'visitorId' } },
          { limit: { limit: 1 } }
        ]}})
      });
      if (!memR.ok) continue;
      const memData = await memR.json();
      const results = memData.results || [];
      if (results.length > 0 && results[0].visitorId) {
        const visitorId = results[0].visitorId;
        const lastUnderscore = visitorId.lastIndexOf('_');
        const prefix = lastUnderscore > 0 ? visitorId.slice(0, lastUnderscore + 1) : '';
        console.log(`[Adopt] Discovered prefix: '${prefix}' from visitorId: ${visitorId}`);
        return res.json({ prefix, visitorId });
      }
    }
    res.json({ prefix: '' });
  } catch (err) {
    console.error('[Adopt] prefix discovery error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/adopt/segments/members', async (req, res) => {
  const { key, segmentId } = req.body;
  if (!key || !segmentId) return res.status(400).json({ error: 'key and segmentId required' });
  try {
    const host = getAdoptHost(req);
    const r = await fetch(`${host}/api/v1/aggregation`, {
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
    console.log(`[Adopt] Creating segment "${name}" with ${visitors.length} visitors`);
    console.log(`[Adopt] Full visitors array: ${JSON.stringify(visitors)}`);
    const adoptHost = getAdoptHost(req);
    console.log(`[Adopt] POST ${adoptHost}/api/v1/segment/upload`);
    const r = await fetch(`${adoptHost}/api/v1/segment/upload`, {
      method: 'POST', headers: adoptHeaders(key), body: JSON.stringify({ name, visitors })
    });
    if (!r.ok) {
      const body = await r.text();
      console.error(`[Adopt] Create failed ${r.status}: ${body.slice(0,500)}`);
      return res.status(r.status).json({ error: `Pendo returned ${r.status}`, detail: body.slice(0,500) });
    }
    const result = await r.json();
    console.log(`[Adopt] Create success:`, JSON.stringify(result));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/adopt/segments/:segmentId', async (req, res) => {
  const { key, visitors } = req.body;
  if (!key || !visitors) return res.status(400).json({ error: 'key and visitors required' });
  try {
    console.log(`[Adopt] Updating segment ${req.params.segmentId} with ${visitors.length} visitors`);
    const adoptHost = getAdoptHost(req);
    console.log(`[Adopt] PUT ${adoptHost}/api/v1/segment/${req.params.segmentId}`);
    const r = await fetch(`${adoptHost}/api/v1/segment/${req.params.segmentId}`, {
      method: 'PUT', headers: adoptHeaders(key), body: JSON.stringify({ visitors })
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
    console.log(`[Adopt] Status poll: ${url}`);
    const r = await fetch(url, { headers: { 'x-pendo-integration-key': key } });
    if (!r.ok) return res.status(r.status).json({ error: `Pendo returned ${r.status}` });
    res.json(await r.json());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
