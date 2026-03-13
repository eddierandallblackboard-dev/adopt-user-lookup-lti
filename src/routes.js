const express = require('express');
const fetch   = require('node-fetch');
const router  = express.Router();

const BB_URL           = (process.env.BB_PLATFORM_ISSUER || '').replace(/\/$/, '');
const BB_CLIENT_ID     = process.env.BB_CLIENT_ID;
const BB_CLIENT_SECRET = process.env.BB_CLIENT_SECRET;
const ADOPT_HOST       = (process.env.ADOPT_HOST || 'https://app.pendo.io').replace(/\/$/, '');

// ── BB token cache ────────────────────────────────────────────────────────────
let bbTokenCache = { token: null, expires: 0 };

async function getBbToken() {
  if (bbTokenCache.token && bbTokenCache.expires > Date.now()) return bbTokenCache.token;
  const resp = await fetch(`${BB_URL}/learn/api/public/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: BB_CLIENT_ID, client_secret: BB_CLIENT_SECRET })
  });
  if (!resp.ok) throw new Error(`BB token request failed: ${resp.status}`);
  const data = await resp.json();
  bbTokenCache = { token: data.access_token, expires: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

function isPreviewUser(u) { return (u?.userName || '').toLowerCase().endsWith('_previewuser'); }
function adoptHeaders(key) { return { 'Content-Type': 'application/json', 'x-pendo-integration-key': key }; }

// ═════════════════════════════════════════════════════════════════════════════
// BLACKBOARD
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/bb/user?email=foo@bar.com
router.get('/bb/user', async (req, res) => {
  const email = req.query.email?.trim();
  if (!email) return res.status(400).json({ error: 'email required' });
  const fields = 'uuid,userName,name.given,name.family,contact.email';
  try {
    const token = await getBbToken();

    // Strategy 1: search endpoint
    const s1 = await fetch(`${BB_URL}/learn/api/public/v1/users?contact.email=${encodeURIComponent(email)}&fields=${fields}&limit=50`, { headers: { Authorization: `Bearer ${token}` } });
    if (s1.ok) {
      const d = await s1.json();
      const users = (d.results || []).filter(u => u?.uuid && !isPreviewUser(u));
      if (users.length) return res.json({ users });
    }

    // Strategy 2: secondary ID
    const s2 = await fetch(`${BB_URL}/learn/api/public/v1/users/contact.email:${encodeURIComponent(email)}?fields=${fields}`, { headers: { Authorization: `Bearer ${token}` } });
    if (s2.ok) { const u = await s2.json(); if (u?.uuid && !isPreviewUser(u)) return res.json({ users: [u] }); }

    // Strategy 3: userName = full email
    const s3 = await fetch(`${BB_URL}/learn/api/public/v1/users/userName:${encodeURIComponent(email)}?fields=${fields}`, { headers: { Authorization: `Bearer ${token}` } });
    if (s3.ok) { const u = await s3.json(); if (u?.uuid && !isPreviewUser(u)) return res.json({ users: [u] }); }

    // Strategy 4: userName = local part
    const local = email.split('@')[0];
    const s4 = await fetch(`${BB_URL}/learn/api/public/v1/users/userName:${encodeURIComponent(local)}?fields=${fields}`, { headers: { Authorization: `Bearer ${token}` } });
    if (s4.ok) { const u = await s4.json(); if (u?.uuid && !isPreviewUser(u)) return res.json({ users: [u] }); }

    res.json({ users: [] });
  } catch (err) {
    console.error('[BB] user lookup error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/bb/user/uuid/:uuid
router.get('/bb/user/uuid/:uuid', async (req, res) => {
  try {
    const token = await getBbToken();
    const r = await fetch(`${BB_URL}/learn/api/public/v1/users/uuid:${encodeURIComponent(req.params.uuid)}?fields=uuid,userName,name.given,name.family,contact.email`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return res.status(r.status).json({ error: `BB returned ${r.status}` });
    res.json(await r.json());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═════════════════════════════════════════════════════════════════════════════
// PENDO / ADOPT
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/adopt/segments?key=xxx&createdByApi=true
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

// POST /api/adopt/segments/members
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

// POST /api/adopt/segments/create
router.post('/adopt/segments/create', async (req, res) => {
  const { key, name, visitors } = req.body;
  if (!key || !name || !visitors) return res.status(400).json({ error: 'key, name, visitors required' });
  try {
    const r = await fetch(`${ADOPT_HOST}/api/v1/segment/upload`, {
      method: 'POST', headers: adoptHeaders(key), body: JSON.stringify({ name, visitors })
    });
    if (!r.ok) return res.status(r.status).json({ error: `Pendo returned ${r.status}` });
    res.json(await r.json());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/adopt/segments/:segmentId
router.put('/adopt/segments/:segmentId', async (req, res) => {
  const { key, visitors } = req.body;
  if (!key || !visitors) return res.status(400).json({ error: 'key and visitors required' });
  try {
    const r = await fetch(`${ADOPT_HOST}/api/v1/segment/${req.params.segmentId}`, {
      method: 'PUT', headers: adoptHeaders(key), body: JSON.stringify({ visitors })
    });
    if (!r.ok) return res.status(r.status).json({ error: `Pendo returned ${r.status}` });
    res.json(await r.json());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/adopt/status?url=xxx&key=xxx
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
