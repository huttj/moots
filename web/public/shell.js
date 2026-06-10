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
      w.classList.remove('hide');   // greet on every demo/shared visit (× dismisses for this view only)
    } else {
      w.classList.add('hide'); // viewing your own uploaded map: skip the pitch
      // open the share preview only right after a FRESH upload — not on every refresh of the saved data
      let fresh = false; try { fresh = sessionStorage.getItem('moots_fresh') === '1'; sessionStorage.removeItem('moots_fresh'); } catch (_) {}
      if (source === 'upload' && fresh) showShare();
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
      const fit = ($('p-curview') && $('p-curview').checked) ? undefined : 'graph';   // default: whole-map square
      currentBlob = await window.__moots.exportPNG(2, 'image/jpeg', 0.9, fit);   // jpeg: small enough to always store
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
  $('p-curview').onchange = capturePreview;          // toggle whole-map vs current view -> re-capture

  // publish the CURRENTLY-previewed image (so the link matches what they see)
  async function ensurePublished() {
    if (publishedLink) return publishedLink;
    const res = $('p-result');
    res.textContent = 'publishing…';
    busy('publishing your constellation…');         // dim + block the page with a prominent indicator
    try {
      const png = currentBlob || await window.__moots.exportPNG(2, 'image/jpeg', 0.9, ($('p-curview') && $('p-curview').checked) ? undefined : 'graph');
      const fd = new FormData();
      fd.append('data', new Blob([JSON.stringify(window.__moots.data)], { type: 'application/json' }));
      if (png) fd.append('image', png, 'og.jpg');
      const r = await fetch('/share', { method: 'POST', body: fd });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const { id } = await r.json();
      publishedLink = location.origin + '/v/' + id;
      res.innerHTML = 'live → <a href="' + publishedLink + '" target="_blank" rel="noopener" style="color:var(--accent2)">' + publishedLink.replace(/^https?:\/\//, '') + '</a>';
      return publishedLink;
    } catch (e) {
      res.textContent = 'publishing failed — try again';
      return null;
    } finally {
      unbusy();
    }
  }

  // run an async action with the clicked button disabled + a loading shimmer
  async function withLoading(btn, fn) {
    btn.classList.add('btn-loading'); btn.disabled = true;
    try { return await fn(); } finally { btn.classList.remove('btn-loading'); btn.disabled = false; }
  }
  $('p-share').onclick = () => withLoading($('p-share'), async () => {
    const link = await ensurePublished();
    if (!link) return;
    const self = window.__moots.data && window.__moots.data.self;
    const text = (self ? '@' + self + '’s' : 'My') + ' Twitter constellation ✦';
    const url = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(text) + '&url=' + encodeURIComponent(link);
    window.open(url, '_blank', 'noopener,width=600,height=660');
  });
  $('p-copy').onclick = () => withLoading($('p-copy'), async () => {
    const link = await ensurePublished();
    if (!link) return;
    try { await navigator.clipboard.writeText(link); const r = $('p-result'); if (!/copied/.test(r.textContent)) r.innerHTML += ' <span style="color:var(--accent)">copied ✓</span>'; } catch (_) {}
  });
  $('btn-shareopen').onclick = showShare;
  const dismissWelcome = () => { $('welcome').classList.add('hide'); };   // hide for this view; returns on refresh
  $('wclose').onclick = dismissWelcome;
  $('w-dismiss').onclick = dismissWelcome;

  /* ---------------- file upload + "how to" popover ---------------- */
  const fileInput = $('file-input');
  const openPicker = () => fileInput.click();
  fileInput.onchange = e => { if (e.target.files[0]) handleFiles(e.target.files); };

  const howmodal = $('howmodal');
  const showHow = () => howmodal.classList.remove('hide');
  const hideHow = () => howmodal.classList.add('hide');
  $('btn-upload').onclick = showHow;                         // "See yours" -> popover
  $('w-how').onclick = showHow;                              // welcome "How to get it"
  $('d-how').onclick = showHow;                              // drop overlay link
  $('howclose').onclick = hideHow;
  howmodal.onclick = e => { if (e.target === howmodal) hideHow(); };   // backdrop click
  $('how-upload').onclick = () => { hideHow(); openPicker(); };        // CTA -> file picker
  $('w-upload').onclick = openPicker;                        // welcome "Drop your own archive"

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

  /* ---- minimal zip reader. Two reasons it exists instead of jszip alone:
     1) Twitter archives >4GB (or >65k files) are written as ZIP64 — jszip can't read
        those ("expected N records in central dir, got 0").
     2) it extracts entries via File.slice + native DecompressionStream, so a multi-GB
        archive never has to fit in memory; we only pull out the few .js files we need. */
  async function zipExtract(file, want) {              // want(name) -> bool; returns Map(name -> text)
    const u8 = async (start, len) => new Uint8Array(await file.slice(start, start + len).arrayBuffer());
    // end-of-central-directory record: in the last 64KB (max comment) + 22
    const tailLen = Math.min(file.size, 65557);
    const tail = await u8(file.size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--)
      if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { eocd = i; break; }
    if (eocd < 0) throw new Error('not a zip (no end-of-central-directory record)');
    const eocdAbs = file.size - tailLen + eocd;
    const dv = new DataView(tail.buffer);
    let count = dv.getUint16(eocd + 10, true);
    let cdSize = dv.getUint32(eocd + 12, true);
    let cdOff = dv.getUint32(eocd + 16, true);
    // zip64 records (locator + EOCD64) sit between the central directory and the classic
    // EOCD when present — Twitter writes them even when the classic fields are NOT
    // placeholders, so check for the locator unconditionally.
    let cdEndAbs = eocdAbs;
    const loc = eocd - 20;
    const hasLoc = loc >= 0 && dv.getUint32(loc, true) === 0x07064b50;
    if (hasLoc) cdEndAbs = Number(dv.getBigUint64(loc + 8, true));
    if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
      // ZIP64 placeholders: the real values live in the zip64 EOCD
      if (!hasLoc) throw new Error('zip64 archive missing its locator record');
      const z = new DataView((await u8(cdEndAbs, 56)).buffer);
      if (z.getUint32(0, true) !== 0x06064b50) throw new Error('bad zip64 end-of-central-directory record');
      count = Number(z.getBigUint64(32, true));
      cdSize = Number(z.getBigUint64(40, true));
      cdOff = Number(z.getBigUint64(48, true));
    }
    // find the central directory: the stored offset is usually right, but archives just
    // over 4GB written without zip64 store it mod 2^32 (jszip's "expected N records in
    // central dir, got 0"). The directory always ends where the (zip64) EOCD begins, so
    // that's the recovery candidate. Validate either by signature.
    let cdStart = -1;
    for (const cand of [cdOff, cdEndAbs - cdSize]) {
      if (cand < 0 || cand + cdSize > file.size) continue;
      const s = await u8(cand, 4);
      if (s[0] === 0x50 && s[1] === 0x4b && s[2] === 0x01 && s[3] === 0x02) { cdStart = cand; break; }
    }
    if (cdStart < 0) throw new Error('central directory not found — corrupted download?');
    // walk the central directory, picking the entries we want
    const cd = await u8(cdStart, cdSize), cdv = new DataView(cd.buffer), td = new TextDecoder();
    const found = [];
    let bias = 0, prevLho = -1;                      // un-wrap per-entry 4GB offset wraps
    for (let i = 0, p = 0; i < count && p + 46 <= cd.length; i++) {
      if (cdv.getUint32(p, true) !== 0x02014b50) throw new Error('corrupted central directory (entry ' + i + ' of ' + count + ')');
      const method = cdv.getUint16(p + 10, true);
      let csize = cdv.getUint32(p + 20, true), usize = cdv.getUint32(p + 24, true);
      const nLen = cdv.getUint16(p + 28, true), eLen = cdv.getUint16(p + 30, true), cLen = cdv.getUint16(p + 32, true);
      let lho = cdv.getUint32(p + 42, true);
      const name = td.decode(cd.subarray(p + 46, p + 46 + nLen));
      if (csize === 0xffffffff || usize === 0xffffffff || lho === 0xffffffff) {
        // zip64 extra field (id 0x0001): one 8-byte value per 0xffffffff field, in this order
        for (let q = p + 46 + nLen, qEnd = q + eLen; q + 4 <= qEnd;) {
          const id = cdv.getUint16(q, true), sz = cdv.getUint16(q + 2, true);
          if (id === 0x0001) {
            let r = q + 4;
            if (usize === 0xffffffff) { usize = Number(cdv.getBigUint64(r, true)); r += 8; }
            if (csize === 0xffffffff) { csize = Number(cdv.getBigUint64(r, true)); r += 8; }
            if (lho === 0xffffffff) { lho = Number(cdv.getBigUint64(r, true)); }
            break;
          }
          q += 4 + sz;
        }
      }
      lho += bias;
      if (lho < prevLho) { bias += 0x100000000; lho += 0x100000000; }   // wrapped at a 4GB boundary
      prevLho = lho;
      if (want(name)) found.push({ name, method, csize, lho });
      p += 46 + nLen + eLen + cLen;
    }
    // pull each wanted entry out of the file and inflate it
    const out = new Map();
    for (const f of found) {
      let off = f.lho;
      let lh = new DataView((await u8(off, 30)).buffer);
      while (lh.getUint32(0, true) !== 0x04034b50 && off + 0x100000000 + 30 <= file.size) {
        off += 0x100000000;                          // residual 4GB wrap the monotonic pass missed
        lh = new DataView((await u8(off, 30)).buffer);
      }
      if (lh.getUint32(0, true) !== 0x04034b50) throw new Error('bad local header for ' + f.name);
      const dataOff = off + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
      const blob = file.slice(dataOff, dataOff + f.csize);
      let text;
      if (f.method === 0) text = await blob.text();
      else if (f.method === 8) {
        if (typeof DecompressionStream === 'undefined') throw new Error('this browser cannot decompress zips — extract data/tweets.js from the archive and drop that in instead');
        text = await new Response(blob.stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
      } else throw new Error('unsupported compression (method ' + f.method + ') for ' + f.name);
      out.set(f.name, text);
    }
    return out;
  }

  async function readArchive(files) {
    let tweets = null, notes = null, account = null;
    const addTweets = arr => { tweets = (tweets || []).concat(arr); };
    for (const f of files) {
      const name = f.name.toLowerCase();
      if (name.endsWith('.zip')) {
        const isTweets = n => /(^|\/)tweets(-part\d+)?\.(js|json)$/i.test(n);
        const isNotes = n => /(^|\/)note-tweet\.(js|json)$/i.test(n);
        let texts;
        try {
          texts = await zipExtract(f, n => isTweets(n) || isNotes(n));
        } catch (e1) {
          // odd-but-valid zip our mini reader rejects: let jszip try before giving up
          if (!window.JSZip) throw e1;
          const zip = await window.JSZip.loadAsync(f);
          texts = new Map();
          for (const n of Object.keys(zip.files)) if (isTweets(n) || isNotes(n)) texts.set(n, await zip.files[n].async('string'));
        }
        const tw = [...texts.keys()].filter(isTweets).sort();
        const nt = [...texts.keys()].filter(isNotes);
        if (!tw.length) throw new Error('no tweets.js found inside the zip');
        for (const e of tw) addTweets(parseJSONLoose(texts.get(e)));
        if (nt.length) notes = parseJSONLoose(texts.get(nt[0]));
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
      try { sessionStorage.setItem('moots_fresh', '1'); } catch (_) {}   // so the share popup opens only on a FRESH upload, not every refresh
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

  // mobile: search lives behind a button and expands as a row under the header
  const searchWrap = document.querySelector('header .search');
  $('btn-search').onclick = (e) => {
    e.stopPropagation();
    searchWrap.classList.toggle('open');
    if (searchWrap.classList.contains('open')) $('search').focus();
  };
  document.addEventListener('click', e => {
    if (searchWrap.classList.contains('open') && !e.target.closest('.search') && !e.target.closest('#btn-search'))
      searchWrap.classList.remove('open');
  });
  const sSize = $('s-size'), sSpread = $('s-spread'), sLabel = $('s-label'), sContrast = $('s-contrast'), sPack = $('s-pack'), sAge = $('s-age');
  const ageWord = v => v <= 0.02 ? 'off' : v <= 0.35 ? 'low' : v <= 0.7 ? 'medium' : v <= 1.2 ? 'high' : 'extreme';
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
  pushSettings();   // sync labels (and viz, if ready) from the current slider values — order-independent w/ initMoots' applyDefaults

  // GL-only display options (avatar resolution + edge anti-aliasing). Handlers attach now
  // (they no-op when GL is off); initMoots reveals the panel once the renderer is up.
  const segRes = $('seg-res');
  segRes.querySelectorAll('button').forEach(b => b.onclick = () => {
    segRes.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    if (window.__moots && window.__moots.setGL) window.__moots.setGL({ avatarRes: +b.dataset.res });
  });
  $('s-aa').onchange = () => { if (window.__moots && window.__moots.setGL) window.__moots.setGL({ aa: $('s-aa').checked }); };
  $('s-fps').onchange = () => { if (window.__moots && window.__moots.setGL) window.__moots.setGL({ fps: $('s-fps').checked }); };

  // time-range scrubber: dual-ended slider -> filter people by activity in the window.
  // t-min/t-max are canonical; the histogram page has a mirror slider (th-min/th-max).
  const tMinEl = $('t-min'), tMaxEl = $('t-max'), tFill = $('time-fill');
  const hMinEl = $('th-min'), hMaxEl = $('th-max'), hFill = $('time-fill-h');
  const fmtMs = ms => new Date(ms).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  // fill bar drawn in the same inset coordinate space the thumbs travel ([tw/2, 100%-tw/2]),
  // otherwise it pokes out past the dots at the track's extremes
  function fillCss(f, a, b) {
    f.style.left = 'calc(7.5px + (100% - 15px) * ' + (a / 1000) + ')';
    f.style.width = 'calc((100% - 15px) * ' + (Math.max(0, b - a) / 1000) + ')';
  }
  function applyTime() {
    let a = +tMinEl.value, b = +tMaxEl.value;
    fillCss(tFill, a, b);
    if (hMinEl) {
      hMinEl.value = a; hMaxEl.value = b;
      fillCss(hFill, a, b);
    }
    const bn = window.__moots && window.__moots.timeBounds;
    if (!bn) return;
    const aMs = bn.min + (bn.max - bn.min) * (a / 1000), bMs = bn.min + (bn.max - bn.min) * (b / 1000);
    $('v-time').textContent = (a <= 0 && b >= 1000) ? 'all time' : (fmtMs(aMs) + ' – ' + fmtMs(bMs));
    if (window.__moots.setTimeFilter) window.__moots.setTimeFilter(aMs, bMs);
  }
  tMinEl.oninput = () => { if (+tMinEl.value > +tMaxEl.value) tMinEl.value = tMaxEl.value; applyTime(); };
  tMaxEl.oninput = () => { if (+tMaxEl.value < +tMinEl.value) tMaxEl.value = tMinEl.value; applyTime(); };
  if (hMinEl) {   // keyboard on the histogram mirror writes through to the canonical pair
    hMinEl.oninput = () => { tMinEl.value = Math.min(+hMinEl.value, +tMaxEl.value); applyTime(); };
    hMaxEl.oninput = () => { tMaxEl.value = Math.max(+hMaxEl.value, +tMinEl.value); applyTime(); };
  }
  applyTime();   // initial fill
  // pointer interaction, same for both sliders (native thumbs are pointer-events:none):
  //  - near a thumb: grab that handle (overlapped pair: the side you click breaks the tie)
  //  - inside the window: drag the whole window around, width unchanged
  //  - outside it: the nearest handle jumps to the click and follows the drag
  function wireDual(dual) {
    dual.addEventListener('pointerdown', e => {
      e.preventDefault();
      const r = dual.getBoundingClientRect();
      // native range thumbs don't span the full track: the 15px thumb's CENTER travels
      // [left+7.5, right-7.5]. Use that mapping both ways or hitboxes skew off the visuals.
      const TW = 15;
      const val = ev => Math.round(Math.min(1, Math.max(0, (ev.clientX - r.left - TW / 2) / (r.width - TW))) * 1000);
      const xOf = v => r.left + TW / 2 + (v / 1000) * (r.width - TW);
      const v0 = val(e), a0 = +tMinEl.value, b0 = +tMaxEl.value;
      const GRAB = 8;    // px: how close to a thumb counts as grabbing it (~the thumb itself)
      const nearA = Math.abs(e.clientX - xOf(a0)) <= GRAB, nearB = Math.abs(e.clientX - xOf(b0)) <= GRAB;
      const inside = v0 > a0 && v0 < b0;
      let mode;          // 'a' | 'b' | 'pan'
      if (nearA && nearB) mode = 'pan';   // stacked/narrow pair: drag moves BOTH; spread by clicking outside the dots
      else if (nearA) mode = 'a';
      else if (nearB) mode = 'b';
      else if (inside) mode = 'pan';
      else mode = v0 < a0 ? 'a' : 'b';
      setSelPart(mode === 'pan' ? 'win' : mode);   // highlight what was grabbed; arrows nudge it
      const move = ev => {
        const nv = val(ev);
        if (mode === 'pan') {
          const dv = Math.max(-a0, Math.min(1000 - b0, nv - v0));
          tMinEl.value = a0 + dv; tMaxEl.value = b0 + dv;
        } else if (mode === 'a') tMinEl.value = Math.min(nv, +tMaxEl.value);
        else tMaxEl.value = Math.max(nv, +tMinEl.value);
        applyTime();
      };
      dual.setPointerCapture(e.pointerId);
      if (mode !== 'pan') move(e);   // handles jump to the pointer; panning starts in place
      dual.addEventListener('pointermove', move);
      const up = () => dual.removeEventListener('pointermove', move);
      dual.addEventListener('pointerup', up, { once: true });
      dual.addEventListener('pointercancel', up, { once: true });
    });
  }
  wireDual($('time-dual'));
  const hDual = $('time-dual-h'); if (hDual) wireDual(hDual);

  // --- timeline keyboard control: click a dot or the bar to select it (subtle gold halo),
  //     then ←/→ nudges it; Shift+←/→ moves faster; Esc or clicking elsewhere deselects ---
  let selPart = null;   // 'a' | 'b' | 'win' | null
  function setSelPart(p) {
    selPart = p;
    for (const el of [tMinEl, hMinEl]) if (el) el.classList.toggle('selpart', p === 'a');
    for (const el of [tMaxEl, hMaxEl]) if (el) el.classList.toggle('selpart', p === 'b');
    for (const el of [tFill, hFill]) if (el) el.classList.toggle('selpart', p === 'win');
  }
  function nudge(dv) {
    let a = +tMinEl.value, b = +tMaxEl.value;
    if (selPart === 'win') { const w = b - a; a = Math.max(0, Math.min(1000 - w, a + dv)); b = a + w; }
    else if (selPart === 'a') a = Math.max(0, Math.min(b, a + dv));
    else if (selPart === 'b') b = Math.max(a, Math.min(1000, b + dv));
    tMinEl.value = a; tMaxEl.value = b; applyTime();
  }
  document.addEventListener('keydown', e => {
    if (!selPart || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      // the filter buckets by month, so that's the meaningful step: arrows move one
      // month, Shift+arrows one year (in slider units of the archive's actual span)
      const bn = window.__moots && window.__moots.timeBounds;
      const months = bn ? Math.max(1, (bn.max - bn.min) / (30.44 * 86400e3)) : 120;
      const unit = Math.max(1, Math.round(1000 / months));
      nudge((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? unit * 12 : unit));
    } else if (e.key === 'Escape') setSelPart(null);
  });
  document.addEventListener('click', e => { if (!e.target.closest('.dual')) setSelPart(null); });
  // off (default) = keep the all-time layout, only sizes/visibility track the range;
  // on = re-rank positions by activity inside the range
  $('s-redist').onchange = () => { if (window.__moots && window.__moots.setRedistribute) window.__moots.setRedistribute($('s-redist').checked); };
  // coloured rings around the circles (recency / community); selection highlights always show
  $('s-rings').onchange = () => { if (window.__moots && window.__moots.setOutlines) window.__moots.setOutlines($('s-rings').checked); };

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
    seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.mode === 'spread'));
    tMinEl.value = 0; tMaxEl.value = 1000; applyTime();   // clear the time scrubber
    const rd = $('s-redist'); if (rd && rd.checked) { rd.checked = false; if (window.__moots && window.__moots.setRedistribute) window.__moots.setRedistribute(false); }
    const rg = $('s-rings'); if (rg && !rg.checked) { rg.checked = true; if (window.__moots && window.__moots.setOutlines) window.__moots.setOutlines(true); }
    if (window.__moots) {
      window.__moots.setLayoutMode('spread');
      if (window.__moots.applyDefaults) window.__moots.applyDefaults();   // archive-size-aware defaults + label refresh
      else { sSize.value = 3; sSpread.value = 1; sLabel.value = 22; sContrast.value = 1; sPack.value = 0; sAge.value = 0; pushSettings(); }
    }
    exitShot();
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
      const blob = await window.__moots.exportPNG(+b.dataset.s, 'image/png', undefined, 'graph');   // tight square of the whole graph
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
