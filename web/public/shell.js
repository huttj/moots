/* moots — shell: file drop & parse, settings, share, welcome card.
   Talks to the viz through window.__moots (set by initMoots). */
(function () {
  const $ = id => document.getElementById(id);

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
      if (source === 'upload') {       // you just uploaded your archive -> offer to publish
        const self = (window.__moots && window.__moots.data && window.__moots.data.self) || 'your';
        $('pub-who').textContent = self === 'your' ? 'your' : '@' + self + '’s';
        $('publish').classList.remove('hide');
      }
    }
  }
  window.__shellReady = applyWelcome;
  if (window.__MOOTS_SOURCE) applyWelcome(window.__MOOTS_SOURCE); // boot already finished

  /* ---------------- publish to moots.fyi ---------------- */
  $('pclose').onclick = $('p-skip').onclick = () => $('publish').classList.add('hide');
  $('p-go').onclick = async () => {
    if (!$('p-public').checked) { $('publish').classList.add('hide'); return; }
    const res = $('p-result'); res.textContent = 'publishing…';
    try {
      const data = window.__moots.data;
      let png = null;
      try { png = await window.__moots.exportPNG(2); } catch (_) {}
      const fd = new FormData();
      fd.append('data', new Blob([JSON.stringify(data)], { type: 'application/json' }));
      if (png) fd.append('image', png, 'og.png');
      const r = await fetch('/share', { method: 'POST', body: fd });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const { id } = await r.json();
      const link = location.origin + '/v/' + id;
      try { await navigator.clipboard.writeText(link); } catch (_) {}
      res.innerHTML = 'published → <a href="' + link + '" style="color:var(--accent2)">' + link.replace(/^https?:\/\//, '') + '</a> (copied)';
    } catch (e) {
      res.textContent = 'publishing isn’t live yet — coming soon';
    }
  };
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

  // strip the "window.YTD.tweets.part0 = " prefix Twitter wraps its .js data in
  function stripJS(text) {
    const i = text.indexOf('=');
    const br = text.indexOf('[');
    if (br !== -1 && (i === -1 || br < i + 40)) return text.slice(br);
    return text;
  }
  function parseJSONLoose(text) { return JSON.parse(stripJS(text)); }

  async function readArchive(files) {
    let tweets = null, notes = null;
    for (const f of files) {
      const name = f.name.toLowerCase();
      if (name.endsWith('.zip')) {
        if (!window.JSZip) throw new Error('zip support failed to load — try dropping tweets.js directly');
        const zip = await window.JSZip.loadAsync(f);
        // find tweets.js / tweets.json (+ optional parts) and note-tweet
        const entries = Object.keys(zip.files);
        const tw = entries.filter(n => /(^|\/)tweets(-part\d+)?\.(js|json)$/i.test(n)).sort();
        const nt = entries.filter(n => /(^|\/)note-tweet\.(js|json)$/i.test(n));
        if (!tw.length) throw new Error('no tweets.js found inside the zip');
        let arr = [];
        for (const e of tw) arr = arr.concat(parseJSONLoose(await zip.files[e].async('string')));
        tweets = arr;
        if (nt.length) notes = parseJSONLoose(await zip.files[nt[0]].async('string'));
      } else if (/tweets(-part\d+)?\.(js|json)$/i.test(name) || name === 'tweets.json' || name === 'tweets.js') {
        const t = parseJSONLoose(await f.text());
        tweets = (tweets || []).concat(t);
      } else if (/note-tweet\.(js|json)$/i.test(name)) {
        notes = parseJSONLoose(await f.text());
      } else {
        // unknown single file: try to parse as tweets
        try { tweets = parseJSONLoose(await f.text()); } catch (_) {}
      }
    }
    if (!tweets) throw new Error("couldn't find your tweets — drop tweets.js, tweets.json, or the archive .zip");
    return { tweets, notes };
  }

  async function handleFiles(files) {
    try {
      busy('reading your archive…');
      await new Promise(r => setTimeout(r, 30));
      const { tweets, notes } = await readArchive(Array.from(files));
      busy(`tallying ${tweets.length.toLocaleString()} tweets…`);
      await new Promise(r => setTimeout(r, 30));
      const data = window.MootsParse.parseArchive(tweets, notes);
      if (!data.people.length) throw new Error('no mentions or replies found in this archive');
      try {
        sessionStorage.setItem('mootsData', JSON.stringify(data));
      } catch (_) {
        // too big for sessionStorage: hand off in-memory and re-init without reload
        unbusy();
        window.__pendingData = data;
        return location.reload(); // best-effort; pending path handled on next load if present
      }
      location.reload(); // boot() picks up sessionStorage -> renders their constellation
    } catch (err) {
      unbusy();
      alert('Could not read that archive:\n\n' + err.message);
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
  dlmenu.querySelectorAll('button').forEach(b => b.onclick = async () => {
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
    location.replace(location.origin + '/');
  };

  // pick up oversized in-memory handoff (when sessionStorage was too small)
  if (window.__pendingData) {/* handled by boot via sessionStorage normally */}
})();
