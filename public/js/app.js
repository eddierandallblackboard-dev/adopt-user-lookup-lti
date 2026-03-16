// app.js — Adopt User Lookup LTI frontend
'use strict';

// ── UUID prefix — derived from LTI token, falls back to empty string ─────────
function getUuidPrefix() {
  try {
    const token = getLtiToken();
    if (token) {
      const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
      if (payload.uuidPrefix) return payload.uuidPrefix;
    }
  } catch(e) {}
  return '';
}

// Strip any prefix from a UUID — handles both prefixed and bare UUIDs
// A BB UUID looks like: <siteUUID>_<userUUID>
// We detect a prefix by checking if removing everything up to the last underscore
// leaves something that looks like a UUID (8-4-4-4-12 hex pattern).
function stripUuidPrefix(value) {
  if (!value) return value;
  const lastUnderscore = value.lastIndexOf('_');
  if (lastUnderscore > 0) {
    const candidate = value.slice(lastUnderscore + 1);
    // Check if it looks like a UUID
    // Matches both dashed UUID (8-4-4-4-12) and compact 32-char hex (no dashes)
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate) ||
        /^[0-9a-f]{32}$/i.test(candidate)) {
      return candidate;
    }
  }
  return value;
}


// ── LTI auth token (stored in sessionStorage after launch) ────────────────────
function getLtiToken() {
  try { return sessionStorage.getItem('lti_token') || ''; } catch(e) { return ''; }
}


// ── State ─────────────────────────────────────────────────────────────────────
let csvData   = null;  // { headers, rows, emailCol }
let results   = [];
let running   = false;
let aborted   = false;

const el = id => document.getElementById(id);

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');
      if (btn.dataset.tab === 'tab-adopt' && !el('adoptKey2').value.trim()) {
        const key = await promptForIntegrationKey();
        if (key) loadSegments();
      }
    });
  });

  // Sync creds between panels
  ['adoptHost','adoptKey'].forEach(id => {
    el(id).addEventListener('input', () => { el(id+'2').value = el(id).value; });
  });
  ['adoptHost2','adoptKey2'].forEach(id => {
    el(id).addEventListener('input', () => { el(id.replace('2','')).value = el(id).value; });
  });

  // Mode toggle
  document.querySelectorAll('input[name="adoptMode"]').forEach(r => {
    r.addEventListener('change', () => {
      const isUpdate = el('adoptModeUpdate').checked;
      el('adoptCreateRow').style.display = isUpdate ? 'none' : '';
      el('adoptUpdateRow').style.display = isUpdate ? 'flex' : 'none';
      if (isUpdate) loadSegmentsForPanel1();
    });
  });

  // File input
  el('fileInput').addEventListener('change', e => handleFile(e.target.files[0]));
  el('dropzone').addEventListener('click', () => el('fileInput').click());
  el('dropzone').addEventListener('dragover', e => { e.preventDefault(); el('dropzone').classList.add('drag'); });
  el('dropzone').addEventListener('dragleave', () => el('dropzone').classList.remove('drag'));
  el('dropzone').addEventListener('drop', e => { e.preventDefault(); el('dropzone').classList.remove('drag'); handleFile(e.dataTransfer.files[0]); });

  // Buttons
  el('runBtn').addEventListener('click', runLookup);
  el('stopBtn').addEventListener('click', () => { aborted = true; });
  el('resetBtn').addEventListener('click', resetAll);
  el('dlBtn').addEventListener('click', exportCSV);
  el('uuidLookupBtn').addEventListener('click', lookupSingleUuid);
  el('uuidResetBtn').addEventListener('click', () => { el('uuidInput').value=''; el('uuidResult').innerHTML=''; });
  el('uuidInput').addEventListener('keydown', e => { if(e.key==='Enter') lookupSingleUuid(); });
  el('adoptPushBtn').addEventListener('click', pushToAdopt);
  el('adoptUpdateBtn').addEventListener('click', updateAdoptSegment);
  el('adoptSegmentSelect').addEventListener('change', () => {
    const id = el('adoptSegmentSelect').value;
    if (id) showSegmentMembers1(); else el('adoptMembersPanel1').classList.add('hidden');
  });
  el('loadSegmentsBtn').addEventListener('click', loadSegments);
  el('showMembersBtn').addEventListener('click', showSegmentMembers);
  el('segmentSelect').addEventListener('change', () => {
    el('showMembersBtn').disabled = !el('segmentSelect').value;
    el('segmentMembersPanel').classList.add('hidden');
    el('segCount').textContent = '';
  });

  setDot('ok');
});

// ── API helpers ───────────────────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  const token = getLtiToken();
  const r = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': 'Bearer ' + token } : {}),
      ...(opts.headers||{})
    }
  });
  return { ok: r.ok, status: r.status, data: r.ok ? await r.json() : null };
}

// ── Single UUID lookup ────────────────────────────────────────────────────────
async function lookupSingleUuid() {
  const raw  = el('uuidInput').value.trim();
  // Strip prefix: if the value contains an underscore followed by a UUID-shaped segment,
  // take only the part after the last underscore. Works whether or not LTI token is present.
  const uuid = stripUuidPrefix(raw);
  const out  = el('uuidResult');

  if (!uuid) { out.innerHTML = '<span style="color:#dc2626">⚠ Paste a UUID to look up.</span>'; return; }
  out.innerHTML = '<span style="color:#6b7280">Looking up…</span>';
  el('uuidLookupBtn').disabled = true;

  try {
    const r = await apiFetch(`/api/bb/user/uuid/${encodeURIComponent(uuid)}`);
    if (r.ok && r.data?.userName) {
      const u = r.data;
      const fullName = [u.name?.given, u.name?.family].filter(Boolean).join(' ');
      const email    = u.contact?.email || '';
      out.innerHTML = `
        <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:8px 10px;background:#f0fdf4;border:1.5px solid #bbf7d0;border-radius:7px">
          <span style="font-weight:700;color:#15803d">${u.userName}</span>
          ${fullName ? `<span style="color:#374151">${fullName}</span>` : ''}
          ${email    ? `<span style="color:#6b7280;font-size:12px">${email}</span>` : ''}
          <span style="font-family:'Courier New',monospace;font-size:11px;color:#9ca3af">${uuid}</span>
        </div>`;
    } else if (r.status === 404) {
      out.innerHTML = `<span style="color:#b45309">⚠ No user found for UUID: <code style="font-size:11px">${uuid}</code></span>`;
    } else {
      out.innerHTML = `<span style="color:#dc2626">✗ Error ${r.status}</span>`;
    }
  } catch(e) {
    out.innerHTML = `<span style="color:#dc2626">✗ ${e.message}</span>`;
  } finally {
    el('uuidLookupBtn').disabled = false;
  }
}

// ── CSV parsing ───────────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g,''));
  const rows = lines.slice(1).map(line => {
    const vals = line.split(',').map(v => v.trim().replace(/^"|"$/g,''));
    return Object.fromEntries(headers.map((h,i) => [h, vals[i]||'']));
  });
  return { headers, rows };
}

function detectEmailCol(headers) {
  return headers.find(h => /email/i.test(h)) || headers[0];
}

function handleFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const { headers, rows } = parseCSV(e.target.result);
    const emailCol = detectEmailCol(headers);
    csvData = { headers, rows, emailCol };
    renderFileLoaded();
  };
  reader.readAsText(file);
}

function renderFileLoaded() {
  el('dropzone').classList.add('loaded');
  el('dropInner').innerHTML = `<div class="drop-icon">✓</div><div class="drop-text">${csvData.rows.length} rows loaded</div>`;
  el('runBtn').disabled = false;

  const sel = el('colSelector');
  sel.innerHTML = csvData.headers.map(h => `<option${h===csvData.emailCol?' selected':''}>${h}</option>`).join('');
  sel.onchange  = () => { csvData.emailCol = sel.value; };
  el('colSelectorWrap').style.visibility = 'visible';
}

// ── Email → UUID lookup (batch) ───────────────────────────────────────────────
async function lookupEmail(email) {
  const clean = email.replace(/,+$/,'').trim();
  const r = await apiFetch(`/api/bb/user?email=${encodeURIComponent(clean)}`);
  if (!r.ok) return { email: clean, uuid:'', status: r.status===403?'forbidden':'network_error' };

  const users = r.data?.users || [];
  if (users.length === 1) return { email:clean, uuid: getUuidPrefix() + users[0].uuid, status:'found' };
  if (users.length > 1)  {
    const chosen = await showUserPicker(clean, users);
    if (chosen) return { email:clean, uuid: getUuidPrefix() + chosen.uuid, status:'found' };
    return { email:clean, uuid:'', status:'skipped' };
  }
  return { email:clean, uuid:'', status:'not_found' };
}

async function runLookup() {
  if (!csvData) { showError('Upload a CSV file first.'); return; }

  results=[]; aborted=false; running=true;
  setDot('running');
  el('resultsPanel').classList.remove('hidden');
  el('runBtn').style.display  = 'none';
  el('stopBtn').style.display = 'inline-block';
  el('resetBtn').disabled     = true;
  el('feedBody').innerHTML    = '';
  el('feedPanel').style.display = 'block';
  el('tablePanel').classList.add('hidden');

  const emails = csvData.rows.map(r => r[csvData.emailCol]).filter(Boolean);
  for (let i=0; i<emails.length && !aborted; i++) {
    const res = await lookupEmail(emails[i]);
    results.push({ ...csvData.rows[i], _email:res.email, _uuid:res.uuid, _status:res.status });
    addFeedRow(results[results.length-1]);
    updateProgress(i+1, emails.length, false);
    updateStats();
  }
  finishRun();
}

async function finishRun() {
  running=false;
  setDot('done');
  el('runBtn').style.display  = 'inline-block';
  el('stopBtn').style.display = 'none';
  el('resetBtn').disabled     = false;
  updateProgress(results.length, results.length, true);
  el('progressTitle').textContent = `Complete — ${results.length} processed`;
  const foundCount = results.filter(r=>r._status==='found').length;
  if (foundCount>0) {
    el('dlBtn').classList.remove('hidden');
    el('adoptPanel').style.display = 'block';
    if (!el('adoptSegmentName').value.trim()) {
      el('adoptSegmentName').value = `BB Segment – ${new Date().toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}`;
    }
    if (!el('adoptKey').value.trim()) {
      const key = await promptForIntegrationKey();
      if (key) loadSegmentsForPanel1();
    } else {
      loadSegmentsForPanel1();
    }
  }
  el('feedPanel').style.display = 'none';
  renderTable();
  el('tablePanel').classList.remove('hidden');
}

function updateProgress(done, total, isDone) {
  const pct = total ? Math.round((done/total)*100) : 0;
  const bar = el('progBar');
  bar.style.width = pct+'%';
  if (isDone) bar.classList.add('done'); else bar.classList.remove('done');
  if (!isDone) el('progressTitle').textContent = `Processing… ${done} / ${total}`;
}

function updateStats() {
  el('statFound').textContent   = results.filter(r=>r._status==='found').length;
  el('statMissed').textContent  = results.filter(r=>r._status==='not_found').length;
  el('statSkipped').textContent = results.filter(r=>r._status==='skipped').length;
  el('statErrors').textContent  = results.filter(r=>!['found','not_found','skipped'].includes(r._status)).length;
}

function addFeedRow(r) {
  const feed = el('feedBody');
  const row  = document.createElement('div');
  row.className = 'feed-row';
  row.innerHTML = `
    <span class="feed-email">${r._email}</span>
    ${r._uuid ? `<span class="feed-uuid">${r._uuid}</span>` : `<span class="feed-st">${r._status}</span>`}`;
  feed.prepend(row);
}

function renderTable() {
  const statusBadge = s => {
    const cls = {'found':'found','not_found':'not_found','forbidden':'forbidden','skipped':'skipped'}[s] ? `badge-${s}` : 'badge-error';
    const lbl = {'found':'found','not_found':'not found','forbidden':'forbidden','skipped':'skipped','network_error':'net error'}[s] || s;
    return `<span class="badge ${cls}">${lbl}</span>`;
  };
  el('resultsBody').innerHTML = results.map(r => `
    <tr>
      <td style="color:#374151">${r._email}</td>
      <td>${r._uuid ? `<span class="uuid-pill">${r._uuid}</span>` : '—'}</td>
      <td>${statusBadge(r._status)}</td>
    </tr>`).join('');
}

function exportCSV() {
  const uuids = results.filter(r=>r._uuid).map(r=>r._uuid);
  const blob  = new Blob([uuids.join('\n')], {type:'text/csv'});
  const a     = document.createElement('a');
  a.href      = URL.createObjectURL(blob);
  a.download  = 'uuids.csv';
  a.click();
}

function resetAll() {
  csvData=null; results=[]; running=false; aborted=false;
  el('fileInput').value='';
  el('dropzone').className='dropzone';
  el('dropInner').innerHTML=`<div class="drop-icon">⬆</div><div class="drop-text">Drop CSV or click to browse</div><div class="drop-sub">Must contain an email column</div>`;
  el('runBtn').disabled=true;
  el('colSelectorWrap').style.visibility='hidden';
  el('resultsPanel').classList.add('hidden');
  el('adoptPanel').style.display='none';
  el('adoptMembersPanel1').classList.add('hidden');
  el('dlBtn').classList.add('hidden');
  clearError(); setDot('ok');
}

// ── Adopt: push/create ────────────────────────────────────────────────────────
async function pushToAdopt() {
  const key  = el('adoptKey').value.trim();
  const name = el('adoptSegmentName').value.trim();
  const uuids= results.filter(r=>r._uuid).map(r=>r._uuid);

  if (!key)   { setAdoptStatus('Integration key is required.','err'); return; }
  if (!name)  { setAdoptStatus('Segment name is required.','err'); return; }
  if (!uuids.length) { setAdoptStatus('No UUIDs to push.','err'); return; }

  // Duplicate check
  const existing = (window._adoptSegments||[]).filter(s=>(s.name||'').toLowerCase()===name.toLowerCase());
  if (existing.length>0) {
    const res = await showDuplicateSegmentPrompt(name, existing[0], uuids.length);
    if (!res) return;
    if (res==='update') {
      el('adoptModeUpdate').checked=true; el('adoptModeCreate').checked=false;
      el('adoptCreateRow').style.display='none'; el('adoptUpdateRow').style.display='flex';
      await loadSegmentsForPanel1();
      const sel=el('adoptSegmentSelect');
      for(const opt of sel.options) if(opt.value===existing[0].id){opt.selected=true;break;}
      setAdoptStatus('Switched to update mode — click "Update Segment" to proceed.','ok'); return;
    }
  }

  const confirmed = await showConfirm(`Create segment "${name}" with ${uuids.length} visitor${uuids.length!==1?'s':''}?`);
  if (!confirmed) return;

  saveAdoptSettings();
  el('adoptPushBtn').disabled=true;
  setAdoptStatus(`Creating segment…`,'');

  try {
    const r = await apiFetch('/api/adopt/segments/create',{
      method:'POST',
      body:JSON.stringify({key, name, visitors:uuids})
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { statusUrl } = r.data;
    setAdoptStatus('✓ Segment created — processing…','ok');
    if (statusUrl) pollAdoptStatus(statusUrl, key, setAdoptStatus);
  } catch(err) {
    setAdoptStatus(`✗ ${err.message}`,'err');
  } finally {
    el('adoptPushBtn').disabled=false;
  }
}

// ── Adopt: update (append) ────────────────────────────────────────────────────
async function updateAdoptSegment() {
  const key      = el('adoptKey').value.trim();
  const segId    = el('adoptSegmentSelect').value;
  const segName  = el('adoptSegmentSelect').options[el('adoptSegmentSelect').selectedIndex]?.text||'';
  const newUuids = results.filter(r=>r._uuid).map(r=>r._uuid);

  if (!key)    { setAdoptStatus('Integration key is required.','err'); return; }
  if (!segId)  { setAdoptStatus('Select a segment to update.','err'); return; }
  if (!newUuids.length) { setAdoptStatus('No UUIDs to push.','err'); return; }

  const confirmed = await showConfirm(
    `Append ${newUuids.length} visitor${newUuids.length!==1?'s':''} to segment "${segName}"?`,
    'Yes, Update Existing Segment'
  );
  if (!confirmed) return;

  el('adoptUpdateBtn').disabled=true;
  setAdoptStatus('Fetching existing members to merge…','');

  try {
    // Get existing members
    const mem = await apiFetch('/api/adopt/segments/members',{
      method:'POST',
      body:JSON.stringify({key,segmentId:segId})
    });
    const existing = mem.ok ? (mem.data?.results||[]).map(r=>r.visitorId).filter(Boolean) : [];
    const merged   = [...new Set([...existing,...newUuids])];
    const added    = merged.length - existing.length;

    setAdoptStatus(`Merging ${existing.length} existing + ${added} new…`,'');
    const r = await apiFetch(`/api/adopt/segments/${segId}`,{
      method:'PUT',
      body:JSON.stringify({key,visitors:merged})
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    setAdoptStatus(`✓ Appended ${added} visitor${added!==1?'s':''} — ${merged.length} total. Processing…`,'ok');
    if (r.data?.statusUrl) pollAdoptStatus(r.data.statusUrl, key, setAdoptStatus);
  } catch(err) {
    setAdoptStatus(`✗ ${err.message}`,'err');
  } finally {
    el('adoptUpdateBtn').disabled=false;
  }
}

// ── Adopt: load segments (panel 1 — update mode) ──────────────────────────────
async function loadSegmentsForPanel1() {
  const key = el('adoptKey').value.trim();
  if (!key) { setAdoptStatus('Integration key is required to load segments.','err'); return; }

  const sel = el('adoptSegmentSelect');
  sel.innerHTML='<option value="">— loading… —</option>';
  setAdoptStatus('Fetching segments…','');

  try {
    const r = await apiFetch(`/api/adopt/segments?key=${encodeURIComponent(key)}&createdByApi=true`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const segments = (Array.isArray(r.data)?r.data:(r.data?.results||[])).sort((a,b)=>(a.name||'').localeCompare(b.name||''));
    window._adoptSegments = segments;
    sel.innerHTML = segments.length
      ? ['<option value="">— Select existing segment to update —</option>',...segments.map(s=>`<option value="${s.id}">${s.name}</option>`)].join('')
      : '<option value="">— no API-created segments found —</option>';
    // Show or hide the "Update existing segment" radio based on whether segments exist
    el('adoptModeLabelUpdate').style.display = segments.length ? 'flex' : 'none';
    if (!segments.length && el('adoptModeUpdate').checked) {
      el('adoptModeCreate').checked = true;
      el('adoptCreateRow').style.display = '';
      el('adoptUpdateRow').style.display = 'none';
    }
    setAdoptStatus(segments.length?`✓ ${segments.length} segment(s) loaded`:'No API-created segments found.',segments.length?'ok':'');
  } catch(err) {
    sel.innerHTML='<option value="">— error loading segments —</option>';
    setAdoptStatus(`✗ ${err.message}`,'err');
  }
}

// ── Adopt: show members (panel 1) ─────────────────────────────────────────────
async function showSegmentMembers1() {
  const key    = el('adoptKey').value.trim();
  const segId  = el('adoptSegmentSelect').value;
  const segName= el('adoptSegmentSelect').options[el('adoptSegmentSelect').selectedIndex]?.text||'';
  if (!segId||!key) return;

  el('adoptMembers1Title').textContent = segName;
  el('adoptMembers1Count').textContent = 'Loading…';
  el('adoptMembersPanel1').classList.remove('hidden');
  const tbody = el('adoptMembers1Body');
  tbody.innerHTML='<tr><td colspan="3" style="color:#9ca3af;text-align:center;padding:8px">Loading…</td></tr>';

  try {
    const r = await apiFetch('/api/adopt/segments/members',{method:'POST',body:JSON.stringify({key,segmentId:segId})});
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const rows = r.data?.results||[];
    el('adoptMembers1Count').textContent=`${rows.length} member(s)`;
    if (rows.length===0) {
      tbody.innerHTML='<tr><td colspan="3" style="color:#9ca3af;text-align:center;padding:8px">This Segment Contains 0 Members</td></tr>';
      return;
    }
    const members = rows.map(r=>({visitorId:r.visitorId||'',bareUuid:stripUuidPrefix(r.visitorId||''),username:null}));
    const render  = ()=>{tbody.innerHTML=members.map((m,i)=>`<tr><td style="color:#9ca3af;width:36px;font-size:11px">${i+1}</td><td><span class="uuid-pill">${m.bareUuid}</span></td><td style="color:#374151;font-size:13px">${m.username||'<span style="color:#d1d5db">—</span>'}</td></tr>`).join('');};
    render();
    await enrichUsernames(members, render);
  } catch(err) {
    tbody.innerHTML=`<tr><td colspan="3" style="color:#dc2626;text-align:center;padding:8px">✗ ${err.message}</td></tr>`;
    el('adoptMembers1Count').textContent='';
  }
}

// ── Adopt: load segments (tab 2) ──────────────────────────────────────────────
async function loadSegments() {
  const host = (el('adoptHost2').value.trim()||'https://app.pendo.io').replace(/\/$/,'');
  const key  = el('adoptKey2').value.trim();
  saveAdoptSettings();
  if (!key) { setAdoptStatus2('Integration key required.','err'); return; }

  el('loadSegmentsBtn').disabled=true; el('loadSegmentsBtn').textContent='Loading…';
  setAdoptStatus2('Fetching segments…','');
  try {
    const r = await apiFetch(`/api/adopt/segments?key=${encodeURIComponent(key)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const segments = Array.isArray(r.data)?r.data:(r.data?.results||[]);
    const sel = el('segmentSelect');
    sel.innerHTML='<option value="">— choose a segment —</option>';
    segments.sort((a,b)=>(a.name||'').localeCompare(b.name||'')).forEach(s=>{
      const opt=document.createElement('option'); opt.value=s.id; opt.textContent=s.name||s.id; sel.appendChild(opt);
    });
    el('segmentSelectorPanel').style.display='block';
    el('showMembersBtn').disabled=true;
    el('segmentMembersPanel').classList.add('hidden');
    setAdoptStatus2(`✓ ${segments.length} segment(s) loaded`,'ok');
  } catch(err) {
    setAdoptStatus2(`✗ ${err.message}`,'err');
  } finally {
    el('loadSegmentsBtn').disabled=false; el('loadSegmentsBtn').textContent='Load Segments';
  }
}

// ── Adopt: show members (tab 2) ───────────────────────────────────────────────
async function showSegmentMembers() {
  const key    = el('adoptKey2').value.trim();
  const segId  = el('segmentSelect').value;
  const segName= el('segmentSelect').options[el('segmentSelect').selectedIndex].text;
  if (!segId||!key) return;

  el('showMembersBtn').disabled=true; el('showMembersBtn').textContent='Loading…';
  setAdoptStatus2('Fetching members…','');

  try {
    const r = await apiFetch('/api/adopt/segments/members',{method:'POST',body:JSON.stringify({key,segmentId:segId})});
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const rows = r.data?.results||[];
    el('segmentMembersTitle').textContent=`${segName} — ${rows.length} member(s)`;
    const tbody=el('segmentMembersBody');
    if (rows.length===0) {
      tbody.innerHTML='<tr><td colspan="3" style="color:#9ca3af;text-align:center;padding:10px">This Segment Contains 0 Members</td></tr>';
      el('segCount').textContent='';
      el('segmentMembersPanel').classList.remove('hidden');
      setAdoptStatus2('',''); return;
    }
    const members=rows.map(r=>({visitorId:r.visitorId||'',bareUuid:stripUuidPrefix(r.visitorId||''),username:null}));
    const render=()=>{tbody.innerHTML=members.map((m,i)=>`<tr><td style="color:#9ca3af;width:36px;font-size:11px">${i+1}</td><td><span class="uuid-pill">${m.bareUuid}</span></td><td style="color:#374151;font-size:13px">${m.username||'<span style="color:#d1d5db">—</span>'}</td></tr>`).join('');};
    render();
    el('segCount').textContent=`${rows.length} visitor(s) in this segment`;
    el('segmentMembersPanel').classList.remove('hidden');
    setAdoptStatus2('','');
    await enrichUsernames(members, render, s=>setAdoptStatus2(s,''));
    setAdoptStatus2(`✓ Done — ${members.filter(m=>m.username).length} username(s) resolved`,'ok');
  } catch(err) {
    setAdoptStatus2(`✗ ${err.message}`,'err');
  } finally {
    el('showMembersBtn').disabled=false; el('showMembersBtn').textContent='Show Members';
  }
}

// ── Shared: enrich members with BB usernames ──────────────────────────────────
async function enrichUsernames(members, renderFn, statusFn) {
  for (let i=0;i<members.length;i++) {
    const uuid=members[i].bareUuid;
    if (!uuid) continue;
    try {
      const r = await apiFetch(`/api/bb/user/uuid/${encodeURIComponent(uuid)}`);
      if (r.ok&&r.data?.userName) members[i].username=r.data.userName;
    } catch(e) {}
    if ((i+1)%5===0||i===members.length-1) {
      renderFn();
      if (statusFn) statusFn(`Looking up usernames… ${i+1}/${members.length}`);
    }
  }
}

// ── Adopt: poll status ────────────────────────────────────────────────────────
async function pollAdoptStatus(statusUrl, key, statusFn) {
  for (let i=0;i<20;i++) {
    await new Promise(r=>setTimeout(r,5000));
    try {
      const r = await apiFetch(`/api/adopt/status?url=${encodeURIComponent(statusUrl)}&key=${encodeURIComponent(key)}`);
      if (!r.ok) break;
      const cmd=(r.data?.command||'').toLowerCase();
      if (cmd==='finish') { statusFn(`✓ Done! ${r.data?.totalTagged??'?'} visitor(s) added to segment.`,'ok'); return; }
      if (cmd==='error')  { statusFn('✗ Segment processing error. Check Adopt for details.','err'); return; }
      statusFn(`⏳ Status: ${cmd||'pending'}… (${r.data?.totalTagged??0} processed)`,'');
    } catch(e) { break; }
  }
}

// ── Modals ────────────────────────────────────────────────────────────────────
function makeOverlay() {
  const o=document.createElement('div'); o.className='modal-overlay'; return o;
}
function makeBox() {
  const b=document.createElement('div'); b.className='modal-box'; return b;
}

function showConfirm(message, confirmLabel='Create Segment') {
  return new Promise(resolve=>{
    const overlay=makeOverlay(), box=makeBox();
    const msg=document.createElement('p'); msg.style.cssText='margin:0 0 20px;font-size:14px;color:#111827;line-height:1.5'; msg.textContent=message;
    const btns=document.createElement('div'); btns.style.cssText='display:flex;gap:10px;justify-content:flex-end';
    const cancel=document.createElement('button'); cancel.textContent='Cancel'; cancel.className='btn-ghost'; cancel.onclick=()=>{document.body.removeChild(overlay);resolve(false);};
    const confirm=document.createElement('button'); confirm.textContent=confirmLabel; confirm.className='btn-primary'; confirm.onclick=()=>{document.body.removeChild(overlay);resolve(true);};
    btns.append(cancel,confirm); box.append(msg,btns); overlay.append(box); document.body.append(overlay); confirm.focus();
  });
}

function showUserPicker(email, users) {
  return new Promise(resolve=>{
    const overlay=makeOverlay(), box=makeBox();
    const title=document.createElement('p'); title.style.cssText='margin:0 0 4px;font-size:13px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:.05em'; title.textContent='Multiple accounts found';
    const sub=document.createElement('p'); sub.style.cssText='margin:0 0 14px;font-size:13px;color:#6b7280;word-break:break-all'; sub.textContent=email;
    const sel=document.createElement('select'); sel.style.cssText='width:100%;padding:8px 10px;border:1.5px solid #d1d5db;border-radius:6px;font-size:13px;font-family:inherit;margin-bottom:16px;background:#fff';
    users.forEach((u,i)=>{const o=document.createElement('option');o.value=i;const fn=[u.name?.given,u.name?.family].filter(Boolean).join(' ');o.textContent=fn?`${u.userName} — ${fn}`:u.userName;sel.appendChild(o);});
    const btns=document.createElement('div'); btns.style.cssText='display:flex;gap:10px;justify-content:flex-end';
    const skip=document.createElement('button'); skip.textContent='Skip'; skip.className='btn-ghost'; skip.onclick=()=>{document.body.removeChild(overlay);resolve(null);};
    const use=document.createElement('button'); use.textContent='Use this account'; use.className='btn-primary'; use.onclick=()=>{document.body.removeChild(overlay);resolve(users[parseInt(sel.value)]);};
    btns.append(skip,use); box.append(title,sub,sel,btns); overlay.append(box); document.body.append(overlay); use.focus();
  });
}

function showDuplicateSegmentPrompt(name, existing, count) {
  return new Promise(resolve=>{
    const overlay=makeOverlay(), box=makeBox();
    const title=document.createElement('p'); title.style.cssText='margin:0 0 4px;font-size:13px;font-weight:700;color:#b45309;text-transform:uppercase;letter-spacing:.05em'; title.textContent='Duplicate Segment Name';
    const sub=document.createElement('p'); sub.style.cssText='margin:0 0 16px;font-size:13px;color:#374151;line-height:1.5'; sub.innerHTML=`A segment named <strong>"${name}"</strong> already exists. How would you like to proceed?`;
    const btns=document.createElement('div'); btns.style.cssText='display:flex;flex-direction:column;gap:8px';
    const upd=document.createElement('button'); upd.className='btn-primary'; upd.style.textAlign='left'; upd.innerHTML=`<strong>Update existing segment</strong><br><span style="font-weight:400;font-size:12px">Append ${count} visitor${count!==1?'s':''} to "${name}"</span>`; upd.onclick=()=>{document.body.removeChild(overlay);resolve('update');};
    const cre=document.createElement('button'); cre.className='btn-ghost'; cre.style.textAlign='left'; cre.innerHTML=`<strong>Create anyway</strong><br><span style="font-weight:400;font-size:12px">Create a new segment with the same name</span>`; cre.onclick=()=>{document.body.removeChild(overlay);resolve('create');};
    const can=document.createElement('button'); can.textContent='Cancel'; can.className='btn-ghost'; can.style.color='#6b7280'; can.onclick=()=>{document.body.removeChild(overlay);resolve(null);};
    btns.append(upd,cre,can); box.append(title,sub,btns); overlay.append(box); document.body.append(overlay); upd.focus();
  });
}

function promptForIntegrationKey() {
  return new Promise(resolve=>{
    const overlay=makeOverlay(), box=makeBox();
    const title=document.createElement('p'); title.style.cssText='margin:0 0 4px;font-size:13px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:.05em'; title.textContent='Pendo Integration Key';
    const sub=document.createElement('p'); sub.style.cssText='margin:0 0 14px;font-size:13px;color:#6b7280;line-height:1.5'; sub.textContent='Enter your Pendo integration key to create or update segments in Blackboard Adopt.';
    const input=document.createElement('input'); input.type='password'; input.placeholder='Paste your integration key'; input.style.cssText='width:100%;box-sizing:border-box;padding:8px 10px;border:1.5px solid #d1d5db;border-radius:6px;font-size:13px;font-family:inherit;margin-bottom:16px';
    const btns=document.createElement('div'); btns.style.cssText='display:flex;gap:10px;justify-content:flex-end';
    const skip=document.createElement('button'); skip.textContent='Skip'; skip.className='btn-ghost'; skip.onclick=()=>{document.body.removeChild(overlay);resolve(null);};
    const save=document.createElement('button'); save.textContent='Save Key'; save.className='btn-primary';
    save.onclick=()=>{
      const val=input.value.trim(); if(!val){input.style.borderColor='#dc2626';return;}
      el('adoptKey').value=val; el('adoptKey2').value=val;
      saveAdoptSettings(); document.body.removeChild(overlay); resolve(val);
    };
    input.addEventListener('keydown',e=>{if(e.key==='Enter')save.click();});
    btns.append(skip,save); box.append(title,sub,input,btns); overlay.append(box); document.body.append(overlay); setTimeout(()=>input.focus(),50);
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function saveAdoptSettings() {
  // Only persist the host, never the key
  localStorage.setItem('adoptSettings', JSON.stringify({
    host: el('adoptHost').value.trim()
  }));
}

function setDot(state) {
  const d=el('statusDot'); d.className='dot'; if(state) d.classList.add(state);
}
function setAdoptStatus(msg,cls) {
  const s=el('adoptStatus'); s.textContent=msg; s.className='adopt-status'+(cls?' '+cls:'');
}
function setAdoptStatus2(msg,cls) {
  const s=el('adoptStatus2'); s.textContent=msg; s.className='adopt-status'+(cls?' '+cls:'');
}
function showError(msg) { const b=el('errorBar'); b.textContent='⚠ '+msg; b.style.display='block'; }
function clearError()   { el('errorBar').style.display='none'; }
