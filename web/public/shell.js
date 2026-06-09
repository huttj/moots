/* moots — shell: file drop & parse, settings, share, welcome card.
   Talks to the viz through window.__moots (set by initMoots). */
(function () {
  const $ = id => document.getElementById(id);
  let publishedLink = null;   // permalink for the currently-previewed capture (declared early — applyWelcome may showShare())
  let currentBlob = null;     // captured PNG of the current view

  /* ---------------- welcome / about card ----------------
     Works regardless of whether boot() or shell.js runs first:
     boot() calls window.__shellReady(source); we also self-apply if boot
     already ran (window.__MOOTS_SOURCE set before this script executed). */
  function applyWelcome(source) {
    const w = $('welcome');
    $('btn-clear').style.display = (source === 'upload' || source === 'shared') ? '' : 'none';
    if (source === 'demo' || source === 'shared') {
      const self = (window.__moots && window.__moots.data && window.__moots.data.self) || 'someone';
      $('welcome-who').textContent = '@' + self;
      const tw = $('welcome-title-who'); if (tw) tw.textContent = '@' + self + '’s';
      // demo: show once (remembered). shared link: always greet the new visitor.
      if (source === 'shared') w.classList.remove('hide');
      else w.classList.toggle('hide', !!localStorage.getItem('moots_seen'));
    } else {
      w.classList.add('hide'); // viewing your own / a shared map: skip the pitch
      if (source === 'upload') showShare();   // you just uploaded -> open the share preview
    }
  }
  window.__shellReady = applyWelcome;
  if (window.__MOOTS_SOURCE) applyWelcome(window.__MOOTS_SOURCE); // boot already finished

  /* ---------------- share: live preview of the current view ---------------- */
  async function capturePreview() {
    publishedLink = null;                         // new capture -> needs a new publish
    $('p-result').textContent = '';
    $('pub-capturing').classList.remove('hide');
    try {
      currentBlob = await window.__moots.exportPNG(2);
      const img = $('pub-preview');
      if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
      const u = URL.createObjectURL(currentBlob);
      img.dataset.url = u; img.src = u;
    } catch (_) { currentBlob = null; }
    $('pub-capturing').classList.add('hide');
  }
  async function showShare() {
    $('publish').classList.remove('hide');
    await capturePreview();                        // always reflect the current view
  }
  $('pclose').onclick = () => $('publish').classList.add('hide');
  $('p-recap').onclick = capturePreview;

  // publish the CURRENTLY-previewed image (so the link matches what they see)
  async function ensurePublished() {
    if (publishedLink) return publishedLink;
    const res = $('p-result');
    res.textContent = 'publishing…';
    try {
      const png = currentBlob || await window.__moots.exportPNG(2);
      const fd = new FormData();
      fd.append('data', new Blob([JSON.stringify(window.__moots.data)], { type: 'application/json' }));
      if (png) fd.append('image', png, 'og.png');
      const r = await fetch('/share', { method: 'POST', body: fd });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const { id } = await r.json();
      publishedLink = location.origin + '/v/' + id;
      res.innerHTML = 'live → <a href="' + publishedLink + '" target="_blank" rel="noopener" style="color:var(--accent2)">' + publishedLink.replace(/^https?:\/\//, '') + '</a>';
      return publishedLink;
    } catch (e) {
      res.textContent = 'publishing failed — try again';
      return null;
    }
  }

  $('p-share').onclick = async () => {
    const link = await ensurePublished();
    if (!link) return;
    const self = window.__moots.data && window.__moots.data.self;
    const text = (self ? '@' + self + '’s' : 'My') + ' Twitter constellation ✦';
    const url = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(text) + '&url=' + encodeURIComponent(link);
    window.open(url, '_blank', 'noopener,width=600,height=660');
  };
  $('p-copy').onclick = async () => {
    const link = await ensurePublished();
    if (!link) return;
    try { await navigator.clipboard.writeText(link); const r = $('p-result'); if (!/copied/.test(r.textContent)) r.innerHTML += ' <span style="color:var(--accent)">copied ✓</span>'; } catch (_) {}
  };
  $('btn-shareopen').onclick = showShare;
  const dismissWelcome = () => { $('welcome').classList.add('hide'); try { localStorage.setItem('moots_seen', '1'); } catch (_) {} };
  $('wclose').onclick = dismissWelcome;
  $('w-dismiss').onclick = dismissWelcome;

  /* ---------------- file upload + parse ---------------- */
  const fileInput = $('file-input');
  $('btn-upload').onclick = () => fileInput.click();
  $('w-upload').onclick = () => fileInput.click();
  fileInput.onchange = e => { if (e.target.files[0]) handleFiles(e.target.files); };

  // drag & drop anywhere
  const drop = $('drop');
  let dragDepth = 0;
  window.addEventListener('dragenter', e => { e.preventDefault(); if (++dragDepth === 1) drop.classList.add('show'); });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('dragleave', e => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; drop.classList.remove('show'); } });
  window.addEventListener('drop', e => {
    e.preventDefault(); dragDepth = 0; drop.classList.remove('show');
    if (e.dataTransfer.files && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  });

  const busy = (msg) => { $('busy-text').textContent = msg; $('busy').classList.add('show'); };
  const unbusy = () => $('busy').classList.remove('show');

  // strip the "window.YTD.tweets.part0 = " prefix Twitter wraps its .js data in.
  // (Community Archive / plain JSON already start with { or [ — leave those alone.)
  function stripJS(text) {
    const t = text.replace(/^﻿/, '').replace(/^\s+/, '');
    if (t[0] === '{' || t[0] === '[') return t;
    const eq = t.indexOf('=');                       // window.YTD.tweets.part0 = [...]
    return (eq !== -1 && eq < 120) ? t.slice(eq + 1) : t;
  }
  function parseJSONLoose(text) { return JSON.parse(stripJS(text)); }

  // Community Archive (community-archive.org): one JSON object combining the whole export.
  function extractCommunityArchive(obj) {
    // NB: concat, not push(...arr) — spreading a huge array as args overflows the stack
    let tweets = [];
    for (const k of ['tweets', 'community-tweet']) if (Array.isArray(obj[k])) tweets = tweets.concat(obj[k]);
    let notes = null;
    for (const k of ['note-tweet', 'noteTweet', 'note_tweet']) if (Array.isArray(obj[k])) { notes = obj[k]; break; }
    let account = null;
    const a = Array.isArray(obj.account) ? (obj.account[0] && (obj.account[0].account || obj.account[0])) : null;
    if (a && a.username) account = { username: a.username, name: a.accountDisplayName || a.username };
    return { tweets, notes, account };
  }

  // read a File's text, retrying transient NotReadableError (cloud placeholder still hydrating, etc.)
  async function readFileText(f) {
    let lastErr;
    for (let i = 0; i < 3; i++) {
      try { return await f.text(); }
      catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 250 * (i + 1))); }
    }
    throw lastErr;
  }

  async function readArchive(files) {
    let tweets = null, notes = null, account = null;
    const addTweets = arr => { tweets = (tweets || []).concat(arr); };
    for (const f of files) {
      const name = f.name.toLowerCase();
      if (name.endsWith('.zip')) {
        if (!window.JSZip) throw new Error('zip support failed to load — try dropping tweets.js / the JSON directly');
        const zip = await window.JSZip.loadAsync(f);
        const entries = Object.keys(zip.files);
        const tw = entries.filter(n => /(^|\/)tweets(-part\d+)?\.(js|json)$/i.test(n)).sort();
        const nt = entries.filter(n => /(^|\/)note-tweet\.(js|json)$/i.test(n));
        if (!tw.length) throw new Error('no tweets.js found inside the zip');
        for (const e of tw) addTweets(parseJSONLoose(await zip.files[e].async('string')));
        if (nt.length) notes = parseJSONLoose(await zip.files[nt[0]].async('string'));
      } else {
        // a .js / .json file: raw export part (array) OR a Community Archive (object)
        const val = parseJSONLoose(await readFileText(f));
        if (Array.isArray(val)) {
          if (/note-tweet/i.test(name)) notes = val; else addTweets(val);
        } else if (val && typeof val === 'object') {
          const ex = extractCommunityArchive(val);
          if (ex.tweets.length) addTweets(ex.tweets);
          if (ex.notes) notes = ex.notes;
          if (ex.account) account = ex.account;
        }
      }
    }
    if (!tweets || !tweets.length)
      throw new Error("couldn't find any tweets — drop tweets.js, tweets.json, the archive .zip, or a Community Archive JSON");
    return { tweets, notes, account };
  }

  async function handleFiles(files) {
    try {
      busy('reading your archive…');
      await new Promise(r => setTimeout(r, 30));
      const { tweets, notes, account } = await readArchive(Array.from(files));
      busy(`tallying ${tweets.length.toLocaleString()} tweets…`);
      await new Promise(r => setTimeout(r, 30));
      const data = window.MootsParse.parseArchive(tweets, notes, account);
      if (!data.people.length) throw new Error('no mentions or replies found in this archive');
      busy('rendering your constellation…');
      // IndexedDB has no ~5MB cap, so even huge graphs survive the reload; fall back if it fails
      try { await window.idbSet('mootsData', data); }
      catch (_) { try { sessionStorage.setItem('mootsData', JSON.stringify(data)); } catch (__) {} }
      location.reload();
    } catch (err) {
      unbusy();
      const m = String((err && (err.name + ' ' + err.message)) || err);
      const unreadable = /NotReadable|NotFound|could not be read|permission/i.test(m);
      alert(unreadable
        ? "Couldn't read that file.\n\nIt looks like the file became unreadable after you picked it — usually because it's a cloud placeholder (iCloud / Dropbox / Desktop & Documents) that isn't fully downloaded, or it moved while uploading.\n\nFix: move it to a plain local folder (e.g. Downloads), make sure it's fully downloaded (no ☁️ icon), then drag it in again."
        : 'Could not read that archive:\n\n' + (err.message || err));
    }
  }

  /* ---------------- settings ---------------- */
  const settings = $('settings');
  $('btn-settings').onclick = () => settings.classList.toggle('show');
  const sSize = $('s-size'), sSpread = $('s-spread'), sLabel = $('s-label'), sContrast = $('s-contrast'), sPack = $('s-pack'), sAge = $('s-age');
  const ageWord = v => v <= 0.02 ? 'off' : v <= 0.35 ? 'low' : v <= 0.7 ? 'medium' : 'high';
  const labelWord = v => v >= 24 ? 'zero labels' : v <= 6 ? 'lots' : v <= 12 ? 'normal' : v <= 18 ? 'sparse' : 'minimal';
  const contrastWord = v => v <= 0.05 ? 'uniform' : v <= 0.4 ? 'low' : v <= 0.7 ? 'medium' : v < 0.95 ? 'high' : v <= 1.05 ? 'full' : v <= 1.8 ? 'extra' : 'max';
  // signed packing: 0 = even (uniform density); <0 looser centre / denser edge; >0 denser centre
  const packWord = v => v <= -0.8 ? 'very loose' : v < -0.1 ? 'loose center' : v <= 0.1 ? 'even' : v < 0.8 ? 'center-heavy' : 'tight center';
  const packPow = v => 0.5 * Math.pow(2, v);     // v in [-1.5,1.5] -> POW in [~0.18, ~1.41]
  function pushSettings() {
    $('v-size').textContent = (+sSize.value).toFixed(2) + '×';
    $('v-spread').textContent = (+sSpread.value).toFixed(2) + '×';
    $('v-label').textContent = labelWord(+sLabel.value);
    $('v-contrast').textContent = contrastWord(+sContrast.value);
    $('v-pack').textContent = packWord(+sPack.value);
    $('v-age').textContent = ageWord(+sAge.value);
    if (window.__moots) window.__moots.setSettings({
      sizeMul: +sSize.value, spreadMul: +sSpread.value, labelThresh: +sLabel.value,
      contrast: +sContrast.value, radiusPow: packPow(+sPack.value), ageWeight: +sAge.value
    });
  }
  sSize.oninput = sSpread.oninput = sLabel.oninput = sContrast.oninput = sPack.oninput = sAge.oninput = pushSettings;

  // layout toggle: even spread vs community pie-slices
  const seg = $('seg-layout');
  seg.querySelectorAll('button').forEach(b => b.onclick = () => {
    seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    if (window.__moots) window.__moots.setLayoutMode(b.dataset.mode);
  });

  // clean screenshot mode: a mode (not a toggle) — enter via button, exit via Esc
  const enterShot = () => { settings.classList.remove('show'); document.body.classList.add('shot'); };
  const exitShot = () => document.body.classList.remove('shot');
  $('s-shot-btn').onclick = enterShot;
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && document.body.classList.contains('shot')) exitShot(); });

  $('s-reset').onclick = () => {
    sSize.value = 3; sSpread.value = 1; sLabel.value = 22; sContrast.value = 1; sPack.value = 0; sAge.value = 0;
    seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.mode === 'spread'));
    if (window.__moots) window.__moots.setLayoutMode('spread');
    exitShot(); pushSettings();
  };
  if (new URLSearchParams(location.search).get('layout') === 'community')
    seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.mode === 'community'));

  /* ---------------- save image (menu: 1× / 2× / 3×) ---------------- */
  const dlmenu = $('dlmenu');
  $('btn-share').onclick = (e) => { e.stopPropagation(); dlmenu.classList.toggle('show'); };
  document.addEventListener('click', (e) => { if (!e.target.closest('#dlmenu') && !e.target.closest('#btn-share')) dlmenu.classList.remove('show'); });
  dlmenu.querySelectorAll('button[data-s]').forEach(b => b.onclick = async () => {
    dlmenu.classList.remove('show');
    if (!window.__moots) return;
    try {
      const blob = await window.__moots.exportPNG(+b.dataset.s);
      const self = (window.__moots.data && window.__moots.data.self) || 'moots';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `moots-${self}-${b.dataset.s}x.png`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e) {
      alert('Could not export the image.\n(' + e.message + ')\nTip: this needs to run over http(s), not a file:// page.');
    }
  });

  /* ---------------- clear uploaded archive -> back to the demo ---------------- */
  $('btn-clear').onclick = () => {
    try { sessionStorage.removeItem('mootsData'); } catch (_) {}
    Promise.resolve(window.idbDel && window.idbDel('mootsData')).catch(() => {})
      .finally(() => location.replace(location.origin + '/'));
  };

  // pick up oversized in-memory handoff (when sessionStorage was too small)
  if (window.__pendingData) {/* handled by boot via sessionStorage normally */}
})();
