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

  // account (optional): { username, name } — used when the source already knows whose
  // archive it is (e.g. a Community Archive), instead of the self-thread heuristic.
  //
  // createTally(account) is the incremental form: add(tweets) as pages arrive, finalize() any
  // time for a snapshot of the graph so far, snapshot()/restore() to checkpoint + resume a
  // fetch that got interrupted. parseArchive() is the one-shot wrapper around it.
  function createTally(account) {
    let self = (account && account.username) || null;
    let selfName = (account && account.name) || null;
    let totalTweets = 0;

    const mentions = new Map(), replies = new Map(), names = new Map(), ids = new Map();
    const first = new Map(), last = new Map();   // sn -> ms
    const monCt = new Map();                  // sn -> Map(monthIdx -> [mentions, replies]), monthIdx = utcYear*12 + utcMonth
    const co = new Map();                      // sn -> Map(other -> weight)

    const bumpMonth = (sn, dt, ri) => {   // ri: 0 = mention, 1 = reply
      if (!dt) return;
      const mi = dt.getUTCFullYear() * 12 + dt.getUTCMonth();
      let m = monCt.get(sn); if (!m) monCt.set(sn, m = new Map());
      let c = m.get(mi); if (!c) m.set(mi, c = [0, 0]);
      c[ri]++;
    };
    const bumpDate = (sn, dt) => {
      if (!dt) return;
      const ms = +dt;
      if (!first.has(sn) || ms < first.get(sn)) first.set(sn, ms);
      if (!last.has(sn) || ms > last.get(sn)) last.set(sn, ms);
    };
    const addCo = (a, b) => {
      let m = co.get(a); if (!m) co.set(a, m = new Map());
      m.set(b, (m.get(b) || 0) + 1);
    };

    function add(tweets) {
      if (!self) self = detectSelf(tweets);   // best effort on the first batch (one-shot path)
      for (const it of tweets) {
        const t = it.tweet || it;
        totalTweets++;
        const dt = parseDate(t.created_at);

        const ms = (t.entities && t.entities.user_mentions) || [];
        const here = [];
        for (const m of ms) {
          const sn = m.screen_name;
          if (!sn) continue;
          if (sn === self) { selfName = m.name || selfName; continue; }
          here.push(sn);
          mentions.set(sn, (mentions.get(sn) || 0) + 1);
          if (m.name || !names.has(sn)) names.set(sn, m.name || '');
          if (m.id_str || !ids.has(sn)) ids.set(sn, m.id_str || '');
          bumpMonth(sn, dt, 0); bumpDate(sn, dt);
        }

        const rsn = t.in_reply_to_screen_name;
        if (rsn && rsn !== self) {
          replies.set(rsn, (replies.get(rsn) || 0) + 1);
          if (!names.has(rsn)) names.set(rsn, rsn);
          bumpMonth(rsn, dt, 1); bumpDate(rsn, dt);
        }

        // co-mention edges among distinct handles in the same tweet
        const uniq = Array.from(new Set(here)).sort();
        for (let i = 0; i < uniq.length; i++)
          for (let j = i + 1; j < uniq.length; j++) { addCo(uniq[i], uniq[j]); addCo(uniq[j], uniq[i]); }
      }
    }

    function finalize() {
      const all = new Set([...mentions.keys(), ...replies.keys()]);
      const people = [];
      for (const sn of all) {
        const m = mentions.get(sn) || 0, r = replies.get(sn) || 0;
        const mons = monCt.get(sn);
        let peakYear = null;
        if (mons) {
          const yrs = new Map();
          for (const [mi, c] of mons) { const y = Math.floor(mi / 12); yrs.set(y, (yrs.get(y) || 0) + c[0] + c[1]); }
          let pk = -1;
          for (const [y, c] of yrs) if (c > pk) { pk = c; peakYear = y; }
        }
        const person = {
          sn, name: names.get(sn) || sn, id: ids.get(sn) || '',
          mentions: m, replies: r, total: m + r,
          first: first.has(sn) ? new Date(first.get(sn)).toISOString() : null,
          last: last.has(sn) ? new Date(last.get(sn)).toISOString() : null,
          peakYear,
        };
        // tl: sparse [monthIdx, mentions, replies, ...] triples, ascending — lets the UI re-weigh by time window
        if (mons) person.tl = Array.from(mons).sort((a, b) => a[0] - b[0]).flatMap(([mi, c]) => [mi, c[0], c[1]]);
        people.push(person);
      }
      people.sort((a, b) => b.total - a.total);

      const links = [];
      for (const [a, m] of co)
        for (const [b, w] of m)
          if (a < b && w >= 2 && all.has(a) && all.has(b)) links.push({ s: a, t: b, w });

      return {
        self: self || null,
        selfName: selfName || self || 'you',
        totalTweets,
        totalPeople: all.size,
        people, links,
      };
    }

    // plain-object checkpoint (structured-clone / JSON safe) so an interrupted fetch can resume
    function snapshot() {
      return {
        v: 1, self, selfName, totalTweets,
        mentions: [...mentions], replies: [...replies], names: [...names], ids: [...ids],
        first: [...first], last: [...last],
        monCt: [...monCt].map(([sn, m]) => [sn, [...m]]),
        co: [...co].map(([sn, m]) => [sn, [...m]]),
      };
    }
    function restore(s) {
      if (!s || s.v !== 1) throw new Error('bad tally snapshot');
      self = s.self; selfName = s.selfName; totalTweets = s.totalTweets;
      const fill = (map, arr) => { map.clear(); for (const [k, v] of arr) map.set(k, v); };
      fill(mentions, s.mentions); fill(replies, s.replies); fill(names, s.names); fill(ids, s.ids);
      fill(first, s.first); fill(last, s.last);
      monCt.clear(); for (const [sn, m] of s.monCt) monCt.set(sn, new Map(m));
      co.clear();    for (const [sn, m] of s.co)    co.set(sn, new Map(m));
    }

    return { add, finalize, snapshot, restore, get totalTweets() { return totalTweets; } };
  }

  function parseArchive(tweets, notes, account) {
    const t = createTally(account);
    t.add(tweets);
    return t.finalize();
  }

  const api = { parseArchive, createTally, detectSelf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MootsParse = api;
})(typeof window !== 'undefined' ? window : globalThis);
