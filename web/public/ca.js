/* moots — Community Archive loader (hidden feature: visit /?ca once to enable, /?ca=<handle> to load one).
   Pages a person's tweets straight from the Community Archive's public API in the browser
   (nothing goes through our server), tallies as pages land, and re-renders the constellation
   every couple of seconds so stars appear while the fetch is still running. Progress is
   checkpointed to IndexedDB after every page, so a closed tab / paused fetch picks up where it
   left off. The finished tally is posted to /ca/<handle> so the next visitor skips the fetch. */
(function () {
  const $ = id => document.getElementById(id);
  const API = 'https://fabxmporizzqflnftavs.supabase.co/rest/v1';
  const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZhYnhtcG9yaXp6cWZsbmZ0YXZzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MjIyNDQ5MTIsImV4cCI6MjAzNzgyMDkxMn0.UIEJiUNkLsW28tBHmG-RQDW-I5JNlJLt62CSk9D_qG8';   // CA's public anon key
  const HEAD = { apikey: KEY, Authorization: 'Bearer ' + KEY };
  const PARTS = 8;          // parallel keyset streams over disjoint created_at spans (the API caps a page at 1000 rows).
  // NB: tweet_id is a TEXT column over there, so it can't be used for ordering/ranges (lexicographic); created_at is a real timestamp.
  const PAGE = 1000;
  const RENDER_MS = 1500;   // min gap between streaming re-renders
  const CKPT_MS = 4000;     // min gap between IndexedDB checkpoints
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ---- feature flag: ?ca turns it on for this browser; ?ca=<handle> also loads that person ---- */
  const qs = new URLSearchParams(location.search);
  let on = false, want = null;
  try {
    if (qs.has('ca')) { localStorage.setItem('moots_ca', '1'); want = qs.get('ca') || null; }
    on = localStorage.getItem('moots_ca') === '1';
  } catch (_) {}
  if (!on) return;

  const box = $('ca-box'), q = $('ca-q'), ac = $('ca-ac'), go = $('ca-go'), note = $('ca-note');
  const pill = $('ca-pill'), pillText = $('ca-pill-text'), pillBtn = $('ca-pause');
  if (!box || !q) return;
  box.classList.remove('hide');

  /* ---- CA API with retry (their DB 500s after ~30 s on some pages; 429s under load) ---- */
  async function ca(path, tries) {
    tries = tries || 6;
    for (let i = 0; ; i++) {
      try {
        const r = await fetch(API + path, { headers: HEAD });
        if (r.ok) return await r.json();
        if (i >= tries - 1 || !(r.status === 429 || r.status >= 500)) throw new Error('Community Archive ' + r.status);
      } catch (e) { if (i >= tries - 1) throw e; }
      await sleep(800 * Math.pow(2, i));
    }
  }
  const latestArchiveAt = accountId =>
    ca(`/archive_upload?select=archive_at&account_id=eq.${accountId}&upload_phase=eq.completed&order=created_at.desc&limit=1`)
      .then(rows => rows.length ? rows[0].archive_at : null);

  /* ---- account list (cached an hour) ---- */
  async function accounts() {
    try { const c = JSON.parse(localStorage.getItem('moots_ca_accounts') || 'null'); if (c && Date.now() - c.t < 3600e3) return c.list; } catch (_) {}
    const list = await ca('/account?select=account_id,username,account_display_name,num_tweets&order=num_tweets.desc&limit=1000');
    try { localStorage.setItem('moots_ca_accounts', JSON.stringify({ t: Date.now(), list })); } catch (_) {}
    return list;
  }
  let LIST = [], picked = null, acIdx = 0, matches = [];
  const byName = u => LIST.find(a => a.username.toLowerCase() === String(u).toLowerCase());
  const esc = t => String(t || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  async function fillSelect() {
    try { LIST = await accounts(); } catch (e) { q.placeholder = 'couldn’t reach the Community Archive'; return; }
    q.disabled = false; q.placeholder = `search ${LIST.length} archived accounts…`;
    if (want && byName(want)) pick(byName(want));
  }
  // searchable picker: type to filter by handle / display name; ↑↓ + Enter, or click
  function acMatch(s) {
    s = s.trim().replace(/^@/, '').toLowerCase();
    let partial = null; try { partial = localStorage.getItem('moots_ca_partial'); } catch (_) {}
    const hit = a => !s || a.username.toLowerCase().includes(s) || (a.account_display_name || '').toLowerCase().includes(s);
    const list = LIST.filter(hit).sort((x, y) => {   // prefix matches first, then by size
      const px = x.username.toLowerCase().startsWith(s), py = y.username.toLowerCase().startsWith(s);
      return px === py ? 0 : px ? -1 : 1;
    });
    if (partial && byName(partial) && hit(byName(partial))) { const p = byName(partial); list.splice(list.indexOf(p), 1); list.unshift(p); }
    return list.slice(0, 12).map(a => ({ a, resume: a.username === partial }));
  }
  function renderAC() {
    matches = acMatch(q.value); acIdx = 0;
    ac.innerHTML = matches.map((m, i) => `<div class="ac-item${i === 0 ? ' active' : ''}" data-i="${i}">
      <span class="nm">${m.resume ? '↻ resume ' : ''}<b>@${esc(m.a.username)}</b> <span style="color:var(--dim)">${esc(m.a.account_display_name || '')}</span></span>
      <span class="ct">${(+m.a.num_tweets || 0).toLocaleString()} tweets</span></div>`).join('');
    const r = q.getBoundingClientRect();   // fixed-position overlay anchored under the input (escapes the card's overflow clip)
    ac.style.top = (r.bottom + 6) + 'px'; ac.style.left = r.left + 'px'; ac.style.width = r.width + 'px';
    ac.style.maxHeight = Math.max(120, Math.min(320, window.innerHeight - r.bottom - 18)) + 'px';   // never past the bottom edge
    ac.classList.toggle('show', matches.length > 0);
    ac.querySelectorAll('.ac-item').forEach(el => { el.onmousedown = e => e.preventDefault(); el.onclick = () => pick(matches[+el.dataset.i].a); });
  }
  function pick(a) {
    picked = a; q.value = '@' + a.username; ac.classList.remove('show'); go.disabled = false; updateNote();
  }
  function updateNote() {
    const a = picked; if (!a) { note.textContent = ''; return; }
    const pages = Math.ceil((+a.num_tweets || 0) / PAGE);
    const secs = Math.round(pages * 2.4 / PARTS);
    note.textContent = pages > 40 ? `~${pages} pages — about ${secs < 90 ? secs + ' s' : Math.round(secs / 60) + ' min'} if it isn’t cached yet; stars appear as it goes` : '';
  }
  q.oninput = () => { picked = null; go.disabled = true; note.textContent = ''; renderAC(); };
  q.onfocus = renderAC;
  q.onblur = () => setTimeout(() => ac.classList.remove('show'), 120);
  q.onkeydown = e => {
    if (!ac.classList.contains('show') && e.key !== 'Enter') return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); acIdx = (acIdx + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
      ac.querySelectorAll('.ac-item').forEach((el, i) => el.classList.toggle('active', i === acIdx));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (picked) load(picked.username); else if (matches[acIdx]) { pick(matches[acIdx].a); load(picked.username); }
    } else if (e.key === 'Escape') ac.classList.remove('show');
  };

  /* ---- progress pill ---- */
  let paused = false, running = null;   // running = username in flight
  function showPill(text, btn, spin) { pill.classList.add('show'); pill.classList.toggle('idle', spin === false); pillText.textContent = text; pillBtn.textContent = btn || ''; pillBtn.style.display = btn ? '' : 'none'; }
  function hidePill(delay) { setTimeout(() => pill.classList.remove('show'), delay || 0); }
  pillBtn.onclick = () => {
    if (running && !paused) { paused = true; showPill('pausing…', ''); }
    else if (paused && running) { load(running); }
  };

  /* ---- data mapping: CA row -> the tweet shape parse.js already understands ---- */
  const toTweet = r => ({
    id_str: r.tweet_id, created_at: r.created_at,
    in_reply_to_screen_name: r.reply_to_username || null,
    entities: { user_mentions: (r.user_mentions || []).map(m => m.mentioned_users).filter(Boolean)
      .map(u => ({ screen_name: u.screen_name, name: u.name || '', id_str: u.user_id || '' })) },
  });
  const SELECT = 'select=tweet_id,created_at,reply_to_username,user_mentions(mentioned_users(user_id,name,screen_name))';

  /* ---- the load ---- */
  async function load(username) {
    const a = byName(username);
    if (!a) { alert('@' + username + ' isn’t in the Community Archive list'); return; }
    if (running && running !== username) { alert('already loading @' + running + ' — pause that first'); return; }
    paused = false; running = username;
    $('howmodal').classList.add('hide');
    $('welcome').classList.add('hide');   // they've chosen a map; the pitch is done
    showPill(`@${username}: checking the Community Archive…`, '');
    try {
      const [archiveAt, meta] = await Promise.all([
        latestArchiveAt(a.account_id),
        fetch('/ca/' + encodeURIComponent(username) + '/meta').then(r => r.ok ? r.json() : null).catch(() => null),
      ]);
      const account = { username: a.username, name: a.account_display_name || a.username };

      // 1) cached on our side and still current -> instant
      if (meta && archiveAt && meta.archive_at === archiveAt) {
        showPill(`@${username}: loading cached map…`, '');
        const r = await fetch('/ca/' + encodeURIComponent(username) + '/data');
        if (r.ok) { const data = await r.json(); await finish(username, data, null, null); return; }
      }

      // 2) resume a checkpoint, or start fresh
      const key = 'ca:' + username.toLowerCase();
      let st = null; try { st = await window.idbGet(key); } catch (_) {}
      if (st && st.archive_at !== archiveAt) st = null;   // they re-uploaded since: the id space isn't stable across uploads
      const tally = window.MootsParse.createTally(account);
      if (st) { tally.restore(st.tally); }
      else {
        const [lo, hi] = await Promise.all([
          ca(`/tweets?select=created_at&account_id=eq.${a.account_id}&order=created_at.asc&limit=1`),
          ca(`/tweets?select=created_at&account_id=eq.${a.account_id}&order=created_at.desc&limit=1`),
        ]);
        const parts = [];
        if (lo.length) {
          const L = Date.parse(lo[0].created_at), Hh = Date.parse(hi[0].created_at) + 1000, step = Math.ceil((Hh - L) / PARTS);
          const iso = ms => new Date(ms).toISOString();
          for (let i = 0; i < PARTS; i++) {
            const pl = L + step * i, ph = i === PARTS - 1 ? Hh : Math.min(Hh, L + step * (i + 1));
            // cursor walks down from the span's top; the first page is exclusive (lt) so spans don't overlap,
            // later pages are inclusive (lte) + dedup of ids already seen at that exact second
            if (pl < Hh) parts.push({ lo: iso(pl), cursor: iso(ph), incl: false, seen: [], done: false });
          }
        }
        st = { archive_at: archiveAt, account, parts, tally: null, pages: 0, tweets: 0 };
      }
      try { localStorage.setItem('moots_ca_partial', username); } catch (_) {}

      let lastRender = 0, lastCkpt = Date.now(), dirty = false, renderCost = 0;
      const checkpoint = async () => { st.tally = tally.snapshot(); lastCkpt = Date.now(); try { await window.idbSet(key, st); } catch (_) {} };
      const render = () => {
        const t0 = performance.now();
        const data = tally.finalize();
        if (data.people.length) { window.__mootsSetData(data, 'ca'); if (window.__shellReady) window.__shellReady('ca'); }
        renderCost = performance.now() - t0; lastRender = Date.now(); dirty = false;
      };
      const progress = () => {
        const pct = Math.min(99, Math.round(100 * st.tweets / Math.max(1, +a.num_tweets || 0)));
        showPill(`@${username}: ${st.tweets.toLocaleString()} tweets · ${pct}%`, 'pause');
      };
      progress();

      // one keyset walker per id-range; they share the tally
      const walk = async (p) => {
        while (!p.done && !paused) {
          const e = encodeURIComponent;
          const all = await ca(`/tweets?${SELECT}&account_id=eq.${a.account_id}&created_at=gte.${e(p.lo)}&created_at=${p.incl ? 'lte' : 'lt'}.${e(p.cursor)}&order=created_at.desc,tweet_id.desc&limit=${PAGE}`);
          const rows = p.incl ? all.filter(r => !p.seen.includes(r.tweet_id)) : all;
          if (rows.length) {
            tally.add(rows.map(toTweet)); st.tweets += rows.length;
            const lastTs = rows[rows.length - 1].created_at;
            p.cursor = lastTs; p.incl = true;
            p.seen = rows.filter(r => r.created_at === lastTs).map(r => r.tweet_id);
          }
          if (all.length < PAGE) p.done = true;
          st.pages++; dirty = true; progress();
          const now = Date.now();
          if (now - lastRender > Math.max(RENDER_MS, renderCost * 4)) render();
          if (now - lastCkpt > CKPT_MS) await checkpoint();
        }
      };
      await Promise.all(st.parts.map(walk));

      if (paused) { await checkpoint(); if (dirty) render(); showPill(`@${username}: paused at ${st.tweets.toLocaleString()} tweets`, 'resume', false); return; }
      const data = tally.finalize();
      await finish(username, data, key, archiveAt);
    } catch (e) {
      console.error(e);
      showPill(`@${username}: ${e.message || e}`, 'resume', false);
    }
  }

  // done: show it, persist like an upload (survives reload), drop the checkpoint, feed the shared cache
  async function finish(username, data, key, archiveAt) {
    running = null; paused = false;
    if (key) { try { await window.idbDel(key); } catch (_) {} }
    try { if (localStorage.getItem('moots_ca_partial') === username) localStorage.removeItem('moots_ca_partial'); } catch (_) {}
    if (!data.people.length) { showPill(`@${username}: no mentions or replies found`, '', false); hidePill(4000); return; }
    window.__mootsSetData(data, 'ca'); if (window.__shellReady) window.__shellReady('ca');
    try { await window.idbSet('mootsData', data); } catch (_) {}
    showPill(`@${username}: ${data.totalPeople.toLocaleString()} people from ${data.totalTweets.toLocaleString()} tweets ✓`, '', false);
    hidePill(3500);
    if (archiveAt) {   // freshly built -> cache it for everyone (server re-checks archive_at against CA)
      try {
        const json = JSON.stringify(data);
        const body = typeof CompressionStream !== 'undefined'
          ? await new Response(new Response(json).body.pipeThrough(new CompressionStream('gzip'))).blob() : new Blob([json]);
        const fd = new FormData(); fd.append('data', body, 'data.json.gz'); fd.append('archive_at', archiveAt);
        await fetch('/ca/' + encodeURIComponent(username), { method: 'POST', body: fd });
      } catch (_) {}
    }
  }

  go.onclick = () => { if (picked) load(picked.username); };
  fillSelect().then(() => { if (want && byName(want)) load(byName(want).username); });
})();
