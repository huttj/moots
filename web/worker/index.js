/* moots Worker — serves the static site AND the API from one origin.
   Routes handled here; everything else falls through to static assets (env.ASSETS).
     GET  /pfp?u=<handle>      profile image (edge-cached, same-origin -> clean canvas)
     GET  /banner?u=<handle>   { url } of header image (cached)
     POST /share               store {data, image} in KV -> { id }
     GET  /v/<id>              the app HTML with Open-Graph meta injected (for link previews)
     GET  /v/<id>/data         the shared aggregated JSON (client fetches this to render)
     GET  /v/<id>/og.png       the shared preview image (Open-Graph)
   Profile pics resolve via x.com HTML -> pbs.twimg.com, unavatar.io fallback. */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const ID = /^[A-Za-z0-9_-]{8,40}$/;
const IMG_TTL = 60 * 60 * 24 * 30;        // 30 days
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function genId() {
  const a = new Uint8Array(12); crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/[+/=]/g, '').slice(0, 12);
}

/* ---------- avatars / banners ---------- */
async function resolveAvatarUrl(handle) {
  try {
    const r = await fetch('https://x.com/' + handle, { headers: { 'User-Agent': UA }, cf: { cacheTtl: IMG_TTL, cacheEverything: true } });
    if (r.ok) {
      const m = (await r.text()).match(/pbs\.twimg\.com\/profile_images\/[^"&\\]+_normal\.[a-z]+/i);
      if (m) return 'https://' + m[0].replace('_normal.', '_400x400.');
    }
  } catch (_) {}
  return null;
}
async function pfp(url, ctx, env) {
  const h = url.searchParams.get('u') || '';
  if (!HANDLE.test(h)) return new Response('bad handle', { status: 400, headers: CORS });
  const r2key = h.toLowerCase() + '.jpg';

  // 1) R2 — the durable cache. Once populated, img.moots.fyi serves future loads
  //    WITHOUT invoking this Worker; here it just saves a re-scrape on a cold edge.
  if (env.AVATARS) {
    const obj = await env.AVATARS.get(r2key);
    if (obj) return new Response(obj.body, { headers: { ...CORS, 'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg', 'Cache-Control': `public, max-age=${IMG_TTL}, immutable` } });
  }
  // 2) image bytes: reuse the edge-cached copy (avoids re-scraping pbs) or resolve fresh
  const cache = caches.default, ckey = new Request('https://moots.cache/pfp/' + h);
  let buf, ct;
  const hit = await cache.match(ckey);
  if (hit && !hit.ok) return new Response('not found', { status: 404, headers: CORS });   // cached miss
  if (hit) {
    ct = hit.headers.get('content-type') || 'image/jpeg';
    buf = await hit.arrayBuffer();
  } else {
    let imgUrl = await resolveAvatarUrl(h);
    let img = imgUrl ? await fetch(imgUrl, { headers: { 'User-Agent': UA } }) : null;
    if (img && !img.ok && imgUrl.includes('_400x400.')) img = await fetch(imgUrl.replace('_400x400.', '_normal.'), { headers: { 'User-Agent': UA } });
    if (!img || !img.ok) img = await fetch('https://unavatar.io/twitter/' + h + '?fallback=false', { headers: { 'User-Agent': UA } });
    if (!img || !img.ok) {
      // negative-cache DEFINITIVE misses (unavatar 404 = no such avatar) so dead handles
      // 404 instantly instead of re-running the whole slow resolve chain on every page view.
      // Transient failures (429 rate limit, 5xx) are NOT cached -> retried next load.
      if (img && img.status === 404) ctx.waitUntil(cache.put(ckey, new Response('not found', { status: 404, headers: { ...CORS, 'Cache-Control': 'public, max-age=21600' } })));
      return new Response('not found', { status: 404, headers: CORS });
    }
    ct = img.headers.get('content-type') || 'image/jpeg';
    buf = await img.arrayBuffer();
    ctx.waitUntil(cache.put(ckey, new Response(buf, { headers: { ...CORS, 'Content-Type': ct, 'Cache-Control': `public, max-age=${IMG_TTL}, immutable` } })));
  }
  // 3) ALWAYS populate R2 — this is what lets the CDN (r2.dev / img.moots.fyi) serve it Worker-free
  if (env.AVATARS) ctx.waitUntil(env.AVATARS.put(r2key, buf, { httpMetadata: { contentType: ct, cacheControl: `public, max-age=${IMG_TTL}, immutable` } }));
  return new Response(buf, { headers: { ...CORS, 'Content-Type': ct, 'Cache-Control': `public, max-age=${IMG_TTL}, immutable` } });
}
async function banner(url, ctx) {
  const h = url.searchParams.get('u') || '';
  if (!HANDLE.test(h)) return new Response('bad handle', { status: 400, headers: CORS });
  const cache = caches.default, key = new Request('https://moots.cache/banner/' + h);
  const hit = await cache.match(key); if (hit) return hit;
  let url2 = null;
  try {
    const r = await fetch('https://x.com/' + h, { headers: { 'User-Agent': UA }, cf: { cacheTtl: IMG_TTL, cacheEverything: true } });
    if (r.ok) { const m = (await r.text()).match(/pbs\.twimg\.com\/profile_banners\/[0-9]+\/[0-9]+/i); if (m) url2 = 'https://' + m[0] + '/1500x500'; }
  } catch (_) {}
  const out = json({ url: url2 });
  out.headers.set('Cache-Control', `public, max-age=${IMG_TTL}`);
  ctx.waitUntil(cache.put(key, out.clone()));
  return out;
}

/* ---------- sharing ---------- */
// keep only the fields the viz renders (never raw tweet text)
function sanitize(d) {
  if (!d || !Array.isArray(d.people)) throw new Error('bad');
  const people = d.people.map(p => ({
    sn: String(p.sn || '').slice(0, 20), name: String(p.name || '').slice(0, 80), id: String(p.id || '').slice(0, 25),
    mentions: +p.mentions | 0, replies: +p.replies | 0, total: +p.total | 0,
    first: p.first ? String(p.first).slice(0, 30) : null, last: p.last ? String(p.last).slice(0, 30) : null,
    peakYear: p.peakYear ? +p.peakYear : null,
    tl: Array.isArray(p.tl) ? p.tl.slice(0, 4000).map(x => +x | 0) : null,   // monthly buckets so the scrubber works on shares
  }));
  const links = (Array.isArray(d.links) ? d.links : []).map(l => ({ s: String(l.s).slice(0, 20), t: String(l.t).slice(0, 20), w: +l.w | 0 }));
  return { self: d.self ? String(d.self).slice(0, 20) : null, selfName: String(d.selfName || '').slice(0, 80),
    totalTweets: +d.totalTweets | 0, totalPeople: +d.totalPeople | 0, people, links };
}
// display settings stored with a share (whitelist + clamp; anything bad -> null = viewer gets defaults)
function sanitizeSettings(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 2000) return null;
  let s; try { s = JSON.parse(raw); } catch (_) { return null; }
  if (!s || typeof s !== 'object') return null;
  const ranges = { size: [0.4, 10], spread: [0.5, 5], pack: [-1.5, 1.5], contrast: [0, 2.5], age: [0, 2], label: [4, 24], t0: [0, 1000], t1: [0, 1000] };
  const out = {};
  for (const k in ranges) {
    const v = +s[k];
    if (Number.isFinite(v)) out[k] = Math.min(ranges[k][1], Math.max(ranges[k][0], v));
  }
  if (out.t0 != null && out.t1 != null && out.t0 > out.t1) { const t = out.t0; out.t0 = out.t1; out.t1 = t; }
  if (s.layout === 'spread' || s.layout === 'community') out.layout = s.layout;
  if (typeof s.redist === 'boolean') out.redist = s.redist;
  if (typeof s.rings === 'boolean') out.rings = s.rings;
  return Object.keys(out).length ? out : null;
}
async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
// Storage layout (lets the same person re-share many views without duplicating the data):
//   data:<contentHash>  -> the aggregated tally, stored ONCE per unique dataset
//   share:<id>          -> { d:<hash>, self, n, t, s? }  (one small record per shared URL; s = display settings)
//   img:<id>            -> the preview PNG (unique per URL)
async function share(req, env) {
  if (!env.SHARES) return json({ error: 'sharing not configured' }, 501);
  let form; try { form = await req.formData(); } catch (_) { return json({ error: 'bad form' }, 400); }
  const dataBlob = form.get('data'); if (!dataBlob) return json({ error: 'no data' }, 400);
  const text = await dataBlob.text();
  if (text.length > 24_000_000) return json({ error: 'too large' }, 413);   // KV value limit is 25 MiB; leave margin
  let clean; try { clean = sanitize(JSON.parse(text)); } catch (_) { return json({ error: 'bad data' }, 400); }

  const cleanStr = JSON.stringify(clean);
  const dataHash = await sha256hex(cleanStr);
  if (!(await env.SHARES.get('data:' + dataHash))) await env.SHARES.put('data:' + dataHash, cleanStr);   // dedup

  const id = genId();
  const rec = { d: dataHash, self: clean.self, n: clean.totalPeople, t: Date.now() };
  const settings = sanitizeSettings(form.get('settings'));
  if (settings) rec.s = settings;
  await env.SHARES.put('share:' + id, JSON.stringify(rec), { metadata: { self: clean.self, n: clean.totalPeople, t: rec.t } });
  const image = form.get('image');
  if (image && image.size && image.size < 5_000_000) await env.SHARES.put('img:' + id, await image.arrayBuffer());
  return json({ id });
}
async function viewShare(req, env, id, sub, ctx) {
  if (!ID.test(id)) return new Response('bad id', { status: 400, headers: CORS });
  if (!env.SHARES) return new Response('sharing not configured', { status: 501, headers: CORS });

  if (sub === '/og.png') {
    const img = await env.SHARES.get('img:' + id, 'arrayBuffer');
    if (img) return new Response(img, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' } });
    return Response.redirect(new URL('/og-default.png', req.url).toString(), 302);
  }

  const rec = await env.SHARES.get('share:' + id, { type: 'json' });
  if (!rec) return new Response('not found', { status: 404, headers: CORS });

  if (sub === '/data') {
    const d = await env.SHARES.get('data:' + rec.d);
    if (!d) return json({ error: 'not found' }, 404);
    return new Response(d, { headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' } });
  }

  // base /v/:id -> serve the app HTML with OG meta injected
  const self = rec.self || 'someone';
  const n = rec.n || 0;
  const origin = new URL(req.url).origin;
  const title = `@${self}'s Twitter constellation`;
  const desc = `${n.toLocaleString()} people · explore the map of who they talk to on Twitter — made with moots.fyi`;
  const ogImg = `${origin}/v/${id}/og.png`;
  const tags = `
  <meta name="description" content="${esc(desc)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="moots">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:image" content="${ogImg}">
  <meta property="og:url" content="${origin}/v/${id}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(title)}">
  <meta name="twitter:description" content="${esc(desc)}">
  <meta name="twitter:image" content="${ogImg}">`;
  // sharer's display settings ride along so the link reopens the same view
  // (rec.s passed sanitizeSettings: only whitelisted numbers/booleans/enums, so safe to inline)
  const settingsTag = rec.s ? `\n  <script>window.__MOOTS_SETTINGS=${JSON.stringify(rec.s).replace(/</g, '\\u003c')}</script>` : '';
  const res = await env.ASSETS.fetch(new URL('/index.html', req.url));
  let html = await res.text();
  // drop the static description/OG/twitter metas so the dynamic ones don't duplicate
  html = html.replace(/<meta\s+(?:name|property)="(?:description|og:[^"]*|twitter:[^"]*)"[^>]*>\s*/gi, '');
  html = html.replace('</head>', tags + settingsTag + '</head>');
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url), p = url.pathname;
    if (p === '/pfp') return pfp(url, ctx, env);
    if (p === '/banner') return banner(url, ctx);
    if (p === '/health') return new Response('ok', { headers: CORS });
    if (p === '/share' && req.method === 'POST') return share(req, env);
    const v = p.match(/^\/v\/([^/]+)(\/data|\/og\.png)?$/);
    if (v) return viewShare(req, env, v[1], v[2], ctx);
    return env.ASSETS.fetch(req);   // static site
  },
};
