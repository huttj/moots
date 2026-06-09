/* moots — client-side Twitter archive parser.
   Runs in the browser (no upload) and in Node (for tests).
   Input: array of tweet objects (each { tweet: {...} }), optional note-tweet array.
   Output: { self, selfName, totalTweets, totalPeople, people[], links[] }  */

(function (root) {
  function parseDate(s) {
    if (!s) return null;
    const d = new Date(s);                 // V8 parses "Thu May 28 19:42:52 +0000 2026"
    return isNaN(d) ? null : d;
  }

  // Identify whose archive this is: the handle most often replied-to in tweets
  // that reply to one of THIS archive's own tweet ids (i.e. self-threading).
  function detectSelf(tweets) {
    const ownIds = new Set();
    for (const it of tweets) {
      const t = it.tweet || it;
      if (t.id_str) ownIds.add(t.id_str);
    }
    const selfVotes = new Map();
    for (const it of tweets) {
      const t = it.tweet || it;
      const rid = t.in_reply_to_status_id_str || t.in_reply_to_status_id;
      const rsn = t.in_reply_to_screen_name;
      if (rsn && rid && ownIds.has(String(rid))) {
        selfVotes.set(rsn, (selfVotes.get(rsn) || 0) + 1);
      }
    }
    let self = null, best = 0;
    for (const [sn, c] of selfVotes) if (c > best) { best = c; self = sn; }
    return self; // may be null for archives with no self-threads
  }

  function parseArchive(tweets, notes) {
    const self = detectSelf(tweets);
    let selfName = null;

    const mentions = new Map(), replies = new Map(), names = new Map(), ids = new Map();
    const first = new Map(), last = new Map();
    const yearCt = new Map();                 // sn -> Map(year -> count)
    const co = new Map();                      // sn -> Map(other -> weight)

    const bumpYear = (sn, yr) => {
      if (!yr) return;
      let m = yearCt.get(sn); if (!m) yearCt.set(sn, m = new Map());
      m.set(yr, (m.get(yr) || 0) + 1);
    };
    const bumpDate = (sn, dt) => {
      if (!dt) return;
      if (!first.has(sn) || dt < first.get(sn)) first.set(sn, dt);
      if (!last.has(sn) || dt > last.get(sn)) last.set(sn, dt);
    };
    const addCo = (a, b) => {
      let m = co.get(a); if (!m) co.set(a, m = new Map());
      m.set(b, (m.get(b) || 0) + 1);
    };

    for (const it of tweets) {
      const t = it.tweet || it;
      const dt = parseDate(t.created_at);
      const yr = dt ? dt.getUTCFullYear() : null;

      const ms = (t.entities && t.entities.user_mentions) || [];
      const here = [];
      for (const m of ms) {
        const sn = m.screen_name;
        if (sn === self) { selfName = m.name || selfName; continue; }
        here.push(sn);
        mentions.set(sn, (mentions.get(sn) || 0) + 1);
        names.set(sn, m.name || '');
        ids.set(sn, m.id_str || '');
        bumpYear(sn, yr); bumpDate(sn, dt);
      }

      const rsn = t.in_reply_to_screen_name;
      if (rsn && rsn !== self) {
        replies.set(rsn, (replies.get(rsn) || 0) + 1);
        if (!names.has(rsn)) names.set(rsn, rsn);
        bumpYear(rsn, yr); bumpDate(rsn, dt);
      }

      // co-mention edges among distinct handles in the same tweet
      const uniq = Array.from(new Set(here)).sort();
      for (let i = 0; i < uniq.length; i++)
        for (let j = i + 1; j < uniq.length; j++) { addCo(uniq[i], uniq[j]); addCo(uniq[j], uniq[i]); }
    }

    const all = new Set([...mentions.keys(), ...replies.keys()]);
    const people = [];
    for (const sn of all) {
      const m = mentions.get(sn) || 0, r = replies.get(sn) || 0;
      const yrs = yearCt.get(sn);
      let peakYear = null, pk = -1;
      if (yrs) for (const [y, c] of yrs) if (c > pk) { pk = c; peakYear = y; }
      people.push({
        sn, name: names.get(sn) || sn, id: ids.get(sn) || '',
        mentions: m, replies: r, total: m + r,
        first: first.has(sn) ? first.get(sn).toISOString() : null,
        last: last.has(sn) ? last.get(sn).toISOString() : null,
        peakYear,
      });
    }
    people.sort((a, b) => b.total - a.total);

    const links = [];
    for (const [a, m] of co)
      for (const [b, w] of m)
        if (a < b && w >= 2 && all.has(a) && all.has(b)) links.push({ s: a, t: b, w });

    return {
      self: self || null,
      selfName: selfName || self || 'you',
      totalTweets: tweets.length,
      totalPeople: all.size,
      people, links,
    };
  }

  const api = { parseArchive, detectSelf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MootsParse = api;
})(typeof window !== 'undefined' ? window : globalThis);
