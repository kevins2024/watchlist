
(function(){
  // Real per-browser/device persistence via localStorage. This is a standalone page (GitHub Pages),
  // not a Claude artifact preview, so it needs actual browser storage rather than Claude's injected
  // window.storage service — that only exists inside Claude's own sandbox and would silently no-op
  // anywhere else. Extra args some call sites still pass (e.g. a trailing "shared" flag left over
  // from that API) are just ignored here; localStorage has no such concept, it's always per-browser.
  const storage = {
    async get(key){
      try{
        const raw = localStorage.getItem(key);
        return raw === null ? null : { key, value: raw };
      }catch(e){ return null; }
    },
    async set(key, value){
      try{ localStorage.setItem(key, value); return { key, value }; }
      catch(e){ return null; }
    },
    async delete(key){
      try{ localStorage.removeItem(key); return { key, deleted:true }; }
      catch(e){ return null; }
    },
    async list(prefix){
      try{
        const keys = [];
        for(let i=0;i<localStorage.length;i++){
          const k = localStorage.key(i);
          if(!prefix || (k && k.startsWith(prefix))) keys.push(k);
        }
        return { keys, prefix };
      }catch(e){ return null; }
    }
  };

  const SPORTS = {
    'college-football': { path:'college-football', label:'CFB', extra:'&groups=80&limit=200' },
    'nfl': { path:'nfl', label:'NFL', extra:'' }
  };

  const state = {
    sport: 'college-football', // 'college-football' | 'nfl' | 'watchlist'
    // shared across both leagues: "3" means 3 weeks ahead of each league's own current week,
    // so switching tabs mid-browse lands on the correlated point in each season, not an independent one
    weeksFromNow: 0,
    sortMode: 'time', // 'time' | 'watchability'
    pointer: { 'college-football': null, 'nfl': null }, // last-resolved display pointer, for reference
    now: { 'college-football': null, 'nfl': null },      // each league's own true current week
    watchlist: [],       // [{sport, id, year, seasontype, week}] — pinned "want to watch" games
    watchedKeys: new Set(),   // "sport:gameId", derived from watchlist, for fast lookups
    seenGames: new Set(),     // "sport:gameId" — games marked as already watched (separate from the watchlist)
    followedTeams: new Set(),  // "sport:teamId"
    followedTeamsList: []      // [{sport,id,name}] — kept alongside the Set so we can render chips
  };

  function isWatched(sport, gameId){ return state.watchedKeys.has(`${sport}:${gameId}`); }
  function isSeen(sport, gameId){ return state.seenGames.has(`${sport}:${gameId}`); }
  function isFollowed(sport, teamId){ return state.followedTeams.has(`${sport}:${teamId}`); }

  async function loadUserData(){
    try{
      const w = await storage.get('watchlist:games', false);
      if(w && w.value){
        const parsed = JSON.parse(w.value);
        // earlier version stored plain "sport:id" strings with no week info — those can't be
        // placed in the new by-week Watchlist tab, so we start that list fresh rather than guess
        state.watchlist = (Array.isArray(parsed) && parsed.length && typeof parsed[0] === 'object') ? parsed : [];
        state.watchedKeys = new Set(state.watchlist.map(x => `${x.sport}:${x.id}`));
      }
    }catch(e){}
    try{
      const s = await storage.get('seen:games', false);
      if(s && s.value) state.seenGames = new Set(JSON.parse(s.value));
    }catch(e){}
    try{
      const t = await storage.get('watchlist:teams', false);
      if(t && t.value){
        state.followedTeamsList = JSON.parse(t.value);
        state.followedTeams = new Set(state.followedTeamsList.map(x => `${x.sport}:${x.id}`));
      }
    }catch(e){}
    // weeksFromNow is intentionally NOT persisted — every page load (or navigation between the CFB
    // and NFL boards) should land on that league's actual current week, not wherever you'd scrolled
    // to last time. It only lives in memory for the duration of one page view.
  }
  async function saveWatchlist(){
    try{ await storage.set('watchlist:games', JSON.stringify(state.watchlist), false); }catch(e){}
  }
  async function saveSeen(){
    try{ await storage.set('seen:games', JSON.stringify(Array.from(state.seenGames)), false); }catch(e){}
  }
  async function saveFollowedTeams(){
    try{ await storage.set('watchlist:teams', JSON.stringify(state.followedTeamsList), false); }catch(e){}
  }

  // Every localStorage key any board on this site writes to (CFB/NFL share the unprefixed keys via
  // this file; the other boards are separate JS files but the same origin, each with its own prefix).
  // Export/Import lives on the Watchlist tab but backs up everything, since it's all one localStorage
  // and there's no reason to make someone do this once per board.
  const ALL_STORAGE_KEYS = [
    'watchlist:games', 'seen:games', 'watchlist:teams',
    'nhl:watchlist:games', 'nhl:seen:games', 'nhl:follow:teams',
    'soccer:watchlist:games', 'soccer:seen:games', 'soccer:follow:teams',
    'intlsoccer:watchlist:games', 'intlsoccer:seen:games', 'intlsoccer:follow:teams',
    'rugby:watchlist:games', 'rugby:seen:games', 'rugby:follow:teams'
  ];

  async function exportUserData(){
    const data = {};
    for(const key of ALL_STORAGE_KEYS){
      const entry = await storage.get(key);
      if(entry && entry.value != null) data[key] = entry.value;
    }
    const payload = { app: 'delayed-kickoff', version: 1, exportedAt: new Date().toISOString(), data };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `delayed-kickoff-backup-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function importUserDataFromFile(file){
    let payload;
    try{
      payload = JSON.parse(await file.text());
    }catch(e){
      alert("That file isn't valid JSON — doesn't look like a Delayed Kickoff backup.");
      return;
    }
    const data = (payload && typeof payload === 'object' && payload.data && typeof payload.data === 'object') ? payload.data : null;
    if(!data){
      alert("That doesn't look like a Delayed Kickoff backup file.");
      return;
    }
    const known = new Set(ALL_STORAGE_KEYS);
    const entries = Object.entries(data).filter(([key, value]) => known.has(key) && typeof value === 'string');
    if(!entries.length){
      alert('No recognizable watchlist data found in that file.');
      return;
    }
    if(!confirm(`This will replace your current watchlist, follows, and watched-marks on this device with the ${entries.length} saved list(s) in that file. Continue?`)) return;
    for(const [key, value] of entries){
      await storage.set(key, value, false);
    }
    await loadUserData();
    render();
  }

  function toggleSeen(sport, gameId){
    const key = `${sport}:${gameId}`;
    if(state.seenGames.has(key)) state.seenGames.delete(key);
    else state.seenGames.add(key);
    saveSeen();
    patchRow(sport, gameId); // never changes list membership, always safe to patch in place
  }

  function toggleWatch(sport, gameId, year, seasontype, week){
    const key = `${sport}:${gameId}`;
    const idx = state.watchlist.findIndex(x => x.sport === sport && String(x.id) === String(gameId));
    if(idx >= 0){
      state.watchlist.splice(idx, 1);
      state.watchedKeys.delete(key);
    }else{
      state.watchlist.push({ sport, id:gameId, year:Number(year), seasontype:Number(seasontype), week:Number(week) });
      state.watchedKeys.add(key);
    }
    saveWatchlist();
    if(state.sport === 'watchlist'){ render(); return; } // list membership itself changed
    patchRow(sport, gameId);
  }
  function toggleFollow(sport, teamId, teamName){
    const key = `${sport}:${teamId}`;
    if(state.followedTeams.has(key)){
      state.followedTeams.delete(key);
      state.followedTeamsList = state.followedTeamsList.filter(x => `${x.sport}:${x.id}` !== key);
    }else{
      state.followedTeams.add(key);
      state.followedTeamsList.push({ sport, id:teamId, name:teamName });
    }
    saveFollowedTeams();
    renderFollowChips();
    // this team can appear in more than one on-screen row (e.g. inside the Watchlist tab) — patch all of them
    for(const [k, entry] of state.renderedGames){
      if(!k.startsWith(sport+':')) continue;
      if((entry.game.away && entry.game.away.id === teamId) || (entry.game.home && entry.game.home.id === teamId)){
        patchRow(sport, entry.game.id);
      }
    }
  }

  const board = document.getElementById('board');
  const weekLabel = document.getElementById('weekLabel');
  const prevBtn = document.getElementById('prevWeek');
  const nextBtn = document.getElementById('nextWeek');
  const jumpNowBtn = document.getElementById('jumpNow');
  const weeknavEl = document.querySelector('.weeknav');

  // ---------- fetch helpers ----------
  async function fetchJSON(url){
    try{
      const r = await fetch(url, { headers: { 'Accept':'application/json' } });
      if(!r.ok) throw new Error('HTTP '+r.status);
      return await r.json();
    }catch(e){
      // fallback through a CORS proxy if the direct call is blocked
      const proxied = 'https://corsproxy.io/?url=' + encodeURIComponent(url);
      const r2 = await fetch(proxied);
      if(!r2.ok) throw new Error('HTTP '+r2.status+' (proxy)');
      return await r2.json();
    }
  }

  function scoreboardURL(sport, {year, week, seasontype} = {}){
    const cfg = SPORTS[sport];
    let url = `https://site.api.espn.com/apis/site/v2/sports/football/${cfg.path}/scoreboard?`;
    const parts = [];
    if(year) parts.push('year='+year);
    if(week) parts.push('week='+week);
    if(seasontype) parts.push('seasontype='+seasontype);
    url += parts.join('&') + cfg.extra;
    return url;
  }

  function cacheKey(sport, p){ return `sched:v4:${sport}:${p.year}:${p.seasontype}:${p.week}`; }

  // ESPN doesn't appear to carry a genuinely separate "Week 0" calendar entry for CFB — requesting
  // week=0 and week=1 both resolve to the same combined ~10-day block (the season-opening weekend
  // through the following Labor Day slate). Since there's no server-declared boundary to trust here,
  // this finds the actual gap in the schedule itself: sort every game in that block by kickoff time,
  // find the single largest gap between consecutive games, and cut there. That gap reliably falls
  // between the Week 0 weekend and the next slate, regardless of exactly which dates it lands on in
  // a given year — it's derived from the real fixture list, not a guessed or hardcoded date.
  const weekZeroSplitCache = {}; // "sport:year:seasontype" -> { week0: [...], week1: [...] }

  async function getWeekZeroOneSplit(sport, year, seasontype){
    const ck = `${sport}:${year}:${seasontype}`;
    if(weekZeroSplitCache[ck]) return weekZeroSplitCache[ck];

    const raw = await fetchJSON(scoreboardURL(sport, { year, week:1, seasontype }));
    const parsedAll = parseScoreboard(raw, { year, week:1, seasontype });
    const events = parsedAll.games.slice().sort((a,b) => new Date(a.date) - new Date(b.date));

    let split;
    if(events.length < 2){
      split = { week0: [], week1: events };
    }else{
      let maxGap = -1, cutIndex = events.length;
      for(let i=1; i<events.length; i++){
        const gap = new Date(events[i].date) - new Date(events[i-1].date);
        if(gap > maxGap){ maxGap = gap; cutIndex = i; }
      }
      split = { week0: events.slice(0, cutIndex), week1: events.slice(cutIndex) };
    }
    weekZeroSplitCache[ck] = split;
    return split;
  }

  async function getWeekData(sport, pointer){
    const key = cacheKey(sport, pointer);

    // The CFB week-0/week-1 split (below) is derived from ESPN's combined ~10-day block, and that
    // block keeps filling in with more games as the season approaches — so a split computed early
    // (when only a few games existed yet) is wrong once the rest show up. It's never re-derived
    // once persisted, since getWeekData otherwise caches forever with no expiry, so it's kept out of
    // localStorage entirely (getWeekZeroOneSplit's in-memory cache still avoids refetching within
    // one page view) and any stale copy from before this fix is purged on the way through.
    const isCfbWeekZeroOne = sport === 'college-football' && pointer.seasontype === 2 && (pointer.week === 0 || pointer.week === 1);

    if(isCfbWeekZeroOne){
      try{ await storage.delete(key); }catch(e){}
    }else{
      try{
        const cached = await storage.get(key, false);
        if(cached && cached.value){
          const parsedCached = JSON.parse(cached.value);
          // A week fetched while a game was still in progress caches that game as `completed:false`
          // forever otherwise — its watchability score would be stuck on the pre-game guess for good,
          // never updating to the final-score read, since this cache has no TTL. So: if anything in
          // here isn't marked done but is well past its typical finish time, treat the whole cached
          // week as stale and refetch instead of trusting it.
          const stale = (parsedCached.games || []).some(g =>
            !g.completed && (Date.now() - new Date(g.date).getTime()) > TYPICAL_DURATION_MS
          );
          if(!stale) return parsedCached;
        }
      }catch(e){ /* not cached yet */ }
    }

    let parsed;
    if(isCfbWeekZeroOne){
      const split = await getWeekZeroOneSplit(sport, pointer.year, pointer.seasontype);
      parsed = {
        meta: { year: pointer.year, week: pointer.week, seasontype: pointer.seasontype, weekText: pointer.week === 0 ? 'Week 0' : 'Week 1' },
        games: pointer.week === 0 ? split.week0 : split.week1
      };
    }else{
      const raw = await fetchJSON(scoreboardURL(sport, pointer));
      parsed = parseScoreboard(raw, pointer);
      try{ await storage.set(key, JSON.stringify(parsed), false); }catch(e){}
    }

    return parsed;
  }

  // Extract a spread magnitude + which side is favored from ESPN's odds block.
  // We only ever use the magnitude to score watchability — the raw line isn't shown for anything
  // that would double as a spoiler, but the pre-game spread itself is public knowledge, not a spoiler.
  function parseOdds(comp, awayAbbr, homeAbbr){
    const o = comp.odds?.[0];
    if(!o) return { spreadAbs:null, favorite:null };
    let favorite = null;
    let spreadAbs = typeof o.spread === 'number' ? Math.abs(o.spread) : null;
    const details = (o.details || '').trim();
    const m = details.match(/^([A-Z]{2,5})\s*(-?\d+(\.\d+)?)$/);
    if(m){
      spreadAbs = Math.abs(parseFloat(m[2]));
      if(m[1] === awayAbbr) favorite = 'away';
      else if(m[1] === homeAbbr) favorite = 'home';
    } else if(/^(PK|EVEN)$/i.test(details)){
      spreadAbs = 0;
    }
    if(favorite === null){
      if(o.homeTeamOdds?.favorite === true) favorite = 'home';
      else if(o.awayTeamOdds?.favorite === true) favorite = 'away';
    }
    return { spreadAbs, favorite };
  }

  // ESPN's scoreboard responses carry their own week calendar (exact UTC start/end per week) — this
  // shape isn't officially documented and varies (sometimes grouped by season type with nested
  // "entries", sometimes a flat list for just the requested season type), so this parses defensively
  // and returns null rather than guessing if the shape doesn't match either.
  function parseCalendarEntries(raw){
    const cal = raw?.leagues?.[0]?.calendar;
    if(!Array.isArray(cal)) return null;
    const out = [];
    cal.forEach(block => {
      if(Array.isArray(block?.entries)){
        const stype = Number(block.value) || null; // grouped-by-season-type shape
        block.entries.forEach(en => {
          if(en?.startDate && en?.endDate && en?.value != null){
            out.push({ seasontype: stype, week: Number(en.value), start: en.startDate, end: en.endDate });
          }
        });
      }else if(block?.startDate && block?.endDate && block?.value != null){
        out.push({ seasontype: null, week: Number(block.value), start: block.startDate, end: block.endDate }); // flat shape
      }
    });
    return out.length ? out : null;
  }

  function findWeekWindow(entries, seasontype, week){
    if(!entries) return null;
    return entries.find(e => e.week === week && (e.seasontype === seasontype || e.seasontype === null)) || null;
  }

  // `requested` is the exact {year,week,seasontype} we asked ESPN for, when known — used (rather than
  // trusting the response's own echoed week.number) to look up that specific week's real date window,
  // so we filter strictly to games that actually fall inside it. This is what keeps "Week 0" and
  // "Week 1" from bleeding into each other when ESPN's server-side week filter doesn't cleanly separate
  // them — we trust the exact UTC boundary ESPN itself declares, not the week label alone.
  function parseScoreboard(raw, requested){
    const meta = {
      year: raw?.season?.year ?? null,
      week: raw?.week?.number ?? null,
      seasontype: raw?.season?.type ?? null,
      weekText: raw?.week?.text ?? null
    };
    let games = (raw.events || []).map(ev => {
      const comp = ev.competitions?.[0] || {};
      const competitors = comp.competitors || [];
      const away = competitors.find(c => c.homeAway === 'away');
      const home = competitors.find(c => c.homeAway === 'home');
      const mapTeam = c => c ? ({
        id: c.team?.id,
        name: c.team?.shortDisplayName || c.team?.displayName || c.team?.name || '—',
        abbr: c.team?.abbreviation || null,
        rank: (c.curatedRank && typeof c.curatedRank.current === 'number' && c.curatedRank.current < 99) ? c.curatedRank.current : null,
        winner: c.winner === true,
        score: c.score !== undefined ? Number(c.score) : null,
        conferenceId: c.team?.conferenceId ?? null,
      }) : null;
      const netObj = comp.broadcasts?.[0];
      const network = netObj?.names?.[0] || comp.geoBroadcasts?.[0]?.media?.shortName || null;
      return {
        id: ev.id,
        date: ev.date,
        completed: !!ev.status?.type?.completed,
        state: ev.status?.type?.state, // pre, in, post
        statusDetail: ev.status?.type?.shortDetail || '',
        period: ev.status?.period ?? null, // 5+ means overtime (period 5 = 1OT, 6 = 2OT, ...)
        conferenceGame: !!comp.conferenceCompetition,
        network,
        venue: comp.venue?.fullName || null,
        odds: parseOdds(comp, away?.team?.abbreviation, home?.team?.abbreviation),
        away: mapTeam(away),
        home: mapTeam(home)
      };
    });

    const calEntries = parseCalendarEntries(raw);
    const targetWeek = requested ? requested.week : meta.week;
    const targetType = requested ? requested.seasontype : meta.seasontype;
    const win = (calEntries && targetWeek != null) ? findWeekWindow(calEntries, targetType, targetWeek) : null;
    if(win){
      const startMs = new Date(win.start).getTime();
      const endMs = new Date(win.end).getTime();
      games = games.filter(g => {
        const t = new Date(g.date).getTime();
        return t >= startMs && t < endMs;
      });
    }

    return { meta, games };
  }

  // ---------- records (as of week entering `week`, seasontype 2 only) ----------
  const recordsCache = {}; // in-memory, key -> Map(teamId -> {w,l,t}) — just avoids re-parsing storage mid-session

  function recordsStorageKey(sport, year, seasontype, week){
    return `records:v4:${sport}:${year}:${seasontype}:${week}`;
  }

  async function getRecordsEntering(sport, year, seasontype, week){
    if(seasontype !== 2 || week <= 0) return new Map();
    const memKey = `${sport}:${year}:${seasontype}:${week}`;
    if(recordsCache[memKey]) return recordsCache[memKey];

    const storeKey = recordsStorageKey(sport, year, seasontype, week);

    // check persistent storage first — if a prior run already tallied this week, reuse it verbatim
    try{
      const cached = await storage.get(storeKey, false);
      if(cached && cached.value){
        const map = new Map(JSON.parse(cached.value));
        recordsCache[memKey] = map;
        return map;
      }
    }catch(e){ /* not cached yet, fall through and compute */ }

    const map = new Map();
    for(let w = 0; w < week; w++){
      let wd;
      try{
        wd = await getWeekData(sport, { year, week: w, seasontype });
      }catch(e){ continue; }
      wd.games.forEach(g => {
        if(!g.completed || !g.home || !g.away) return;
        const tie = !g.home.winner && !g.away.winner;
        [g.home, g.away].forEach(team => {
          if(!team?.id) return;
          const rec = map.get(team.id) || { w:0, l:0, t:0 };
          if(tie) rec.t++;
          else if(team.winner) rec.w++;
          else rec.l++;
          map.set(team.id, rec);
        });
      });
    }

    recordsCache[memKey] = map;
    // persist the finished tally so future runs skip recomputation entirely
    try{ await storage.set(storeKey, JSON.stringify(Array.from(map.entries())), false); }catch(e){}
    return map;
  }

  function fmtRecord(rec){
    if(!rec) return null;
    if(rec.t) return `${rec.w}-${rec.l}-${rec.t}`;
    return `${rec.w}-${rec.l}`;
  }

  // ---------- watchability heuristic ----------
  // Exact top-tier broadcast slots only. A *Network*/*SN* channel (ACC Network, CBSSN, ESPNU...) is
  // exposure, not evidence of a big game, so this is an exact match rather than the substring check
  // it used to be (which let "ESPNU" count as "ESPN").
  const MAJOR_NETS = ['ABC','CBS','NBC','FOX','ESPN','ESPN2','Prime Video','Peacock'];

  // Annual rivalry games where the two teams' records/rankings routinely undersell how competitive
  // it'll be. ESPN's feed has no generic "this is a rivalry" flag (checked: the `notes` field is only
  // used for branded neutral-site games like bowl/classic names), so this is a hand-picked,
  // non-exhaustive list of the biggest ones, keyed by team ID so a mascot/branding change can't
  // silently break it. Ask to add more any time.
  const RIVALRY_PAIRS = {
    'college-football': [
      ['2294','66',  'Cy-Hawk Trophy: Iowa – Iowa State'],
      ['194','130',  'The Game: Ohio State – Michigan'],
      ['130','127',  'Paul Bunyan Trophy: Michigan – Michigan State'],
      ['333','2',    'Iron Bowl: Alabama – Auburn'],
      ['251','201',  'Red River Rivalry: Texas – Oklahoma'],
      ['57','61',    'Florida – Georgia'],
      ['30','87',    'USC – Notre Dame'],
      ['30','26',    'USC – UCLA'],
      ['52','2390',  'Florida State – Miami'],
      ['228','2579', 'Palmetto Bowl: Clemson – South Carolina'],
      ['61','59',    "Clean, Old-Fashioned Hate: Georgia – Georgia Tech"],
      ['25','24',    'The Big Game: Cal – Stanford'],
      ['135','275',  "Paul Bunyan's Axe: Minnesota – Wisconsin"],
      ['356','77',   'Land of Lincoln Trophy: Illinois – Northwestern'],
      ['2509','84',  'Old Oaken Bucket: Purdue – Indiana'],
      ['344','145',  'Egg Bowl: Mississippi State – Ole Miss'],
      ['96','97',    "Governor's Cup: Kentucky – Louisville"],
      ['252','254',  'Holy War: BYU – Utah'],
      ['245','251',  'Lone Star Showdown: Texas A&M – Texas'],
      ['277','221',  'Backyard Brawl: West Virginia – Pittsburgh'],
      ['258','259',  'Commonwealth Cup: Virginia – Virginia Tech'],
      ['349','2426', "America's Game: Army – Navy"],
      ['2305','2306','Sunflower Showdown: Kansas – Kansas State'],
      ['197','201',  'Bedlam: Oklahoma State – Oklahoma'],
      ['2633','238', 'Tennessee – Vanderbilt']
    ],
    'nfl': []
  };
  const RIVALRY_SETS = Object.fromEntries(
    Object.entries(RIVALRY_PAIRS).map(([sport, pairs]) => [sport, new Set(pairs.map(([a,b]) => [a,b].sort().join('|')))])
  );
  function isRivalryGame(sport, game){
    const set = RIVALRY_SETS[sport];
    if(!set || !game.away?.id || !game.home?.id) return false;
    return set.has([String(game.away.id), String(game.home.id)].sort().join('|'));
  }

  // 5+ means overtime (period 5 = 1OT, 6 = 2OT, ...). Overtime means the two teams were tied after a
  // full regulation game — an automatic strong watchability signal on its own, independent of margin,
  // rank, rivalry, or anything else: no game with a period this high was ever a laugher.
  function otPeriods(game){
    if(!game.completed || game.period == null) return 0;
    return Math.max(0, game.period - 4);
  }

  // Was the final result actually in question? Trusts the final margin alone — within 16 is close.
  // (An earlier version also looked at the score through 3 quarters to catch a blowout that only
  // looked close at the final whistle because of garbage-time scoring. Dropped it: any cutoff on the
  // Q3 gap misjudges some real games — a genuine 4th-quarter comeback can produce the exact same
  // final/Q3 numbers as a coast-and-pad blowout, so there's no threshold that gets both right.)
  function wasActuallyClose(game){
    if(game.away?.score == null || game.home?.score == null) return false;
    return Math.abs(game.away.score - game.home.score) <= 16;
  }

  function isNailBiter(game){
    return !!game.completed && wasActuallyClose(game);
  }

  // Power-conference membership, for the final-score rank component below. The concept doesn't exist
  // outside CFB, so every team counts as "power" elsewhere — the penalty this feeds just never fires.
  // ESPN groups every FBS independent under one nominal conference id, and that id currently holds
  // exactly two teams — Notre Dame and UConn — only one of which is remotely power-caliber, so
  // independents need their own explicit allow-list rather than a conference id.
  const POWER_CONFERENCE_IDS = { 'college-football': new Set(['1','4','5','8']) }; // ACC, Big 12, Big Ten, SEC
  const POWER_INDEPENDENT_IDS = { 'college-football': new Set(['87']) }; // Notre Dame
  function isPowerConferenceTeam(sport, team){
    if(sport !== 'college-football') return true;
    if(!team) return false;
    if(POWER_INDEPENDENT_IDS[sport]?.has(String(team.id))) return true;
    return team.conferenceId != null && POWER_CONFERENCE_IDS[sport]?.has(String(team.conferenceId));
  }

  // Who was expected to win, and did they lose? Betting odds are almost never present in this feed
  // for CFB, so fall back to rankings: a ranked team is presumed favorite over an unranked one, and
  // between two ranked teams the higher rank (lower number) is favored.
  function isUpset(game){
    if(!game.completed) return false;
    let favorite = game.odds?.favorite ?? null;
    if(favorite == null){
      const awayRank = game.away?.rank, homeRank = game.home?.rank;
      if(awayRank != null && homeRank == null) favorite = 'away';
      else if(homeRank != null && awayRank == null) favorite = 'home';
      else if(awayRank != null && homeRank != null) favorite = awayRank < homeRank ? 'away' : 'home';
    }
    if(favorite == null) return false;
    return (favorite === 'home' && game.away?.winner === true) ||
           (favorite === 'away' && game.home?.winner === true);
  }

  // A ranked-vs-ranked matchup pre-game is a real marquee signal. A both-ranked game that survives
  // the result (actually stayed close, not just close-looking, or is still to be played) keeps the
  // badge; one that turned into a rout loses it — the final score gets the last word on "was this big."
  function isMarquee(game){
    if(game.away?.rank == null || game.home?.rank == null) return false;
    if(!game.completed) return true;
    return wasActuallyClose(game);
  }

  // ---- Pre-game / in-progress: an expectation score built from hype signals alone. Thrown away
  // entirely once a game is final (see postGameScore) — a guess about how good a game will be
  // doesn't get to keep counting once we know how it actually went.
  // No single one of these signals should be trusted on its own — a rivalry can still be a 50-3
  // laugher (see: some Army-Navy games), an unranked team can still play a ranked one dead even, a
  // conference game can still be a mismatch. None of them gate the score to zero on their own or
  // guarantee a high one; they're small, independent, additive nudges that are meant to stack —
  // most real games should earn *some* points from *some* combination of them, not require one
  // specific rare condition (both ranked) just to be worth watching pre-game.
  function preGameScore(sport, game, recAway, recHome, followed){
    let s = 0;
    if(followed) s += 40;
    const ranks = [game.away?.rank, game.home?.rank].filter(r => r != null);
    // Both ranked is the strongest version of this signal. One ranked team is weaker and more
    // ambiguous — it's just as likely to be a measuring-stick win as a wipeout — but it's still a
    // real signal (a ranked team is, on average, a better and more competitive team), not nothing.
    if(ranks.length === 2) s += 35;
    else if(ranks.length === 1) s += 15;
    // A real annual rivalry plays tighter than records suggest more often than not — worth close to
    // as much as a tight pre-game spread, independent of and additive with everything else here.
    if(isRivalryGame(sport, game)) s += 20;
    // Conference games tend to be more evenly matched than a P4-vs-cupcake non-conference slate game
    // — a weaker, broader version of the same idea as rivalry, using data ESPN already gives us.
    if(game.conferenceGame) s += 8;
    if(game.network && MAJOR_NETS.includes(game.network)) s += 10;
    if(recAway && recHome && (recAway.w + recAway.l) > 0 && (recHome.w + recHome.l) > 0
       && recAway.w >= recAway.l && recHome.w >= recHome.l) s += 5;
    const spreadAbs = game.odds?.spreadAbs;
    if(spreadAbs != null){
      if(spreadAbs <= 9) s += 20;
      else if(spreadAbs >= 21) s -= 20;
    }
    return Math.max(0, Math.min(100, s));
  }

  // ---- Final: the result IS the score, full stop — none of the pre-game guessing above carries
  // over. Margin of victory does the bulk of the work (tied/OT-caliber = 80, down 2 points per point
  // of final margin), with everything else as smaller stacking nudges on top: which team you follow
  // won or lost (flat, not scaled by margin — this is an aggregate feeling, not its own mini-formula),
  // how well-ranked the two teams were, and whether it was a confirmed upset. A followed team winning
  // huge still only adds 30 to a margin component that's near zero, so the final number doesn't just
  // read as "your team won" — there has to be real jeopardy, or real prestige, alongside it to get high.
  function marginComponent(game){
    const diff = Math.abs(game.away.score - game.home.score);
    return Math.max(0, 80 - 2 * diff); // 0 -> 80, 16 -> 48, 40+ -> 0
  }
  function followedComponent(game, followedAway, followedHome){
    const followedWon = (followedAway && game.away?.winner === true) || (followedHome && game.home?.winner === true);
    const followedLost = (followedAway && game.home?.winner === true) || (followedHome && game.away?.winner === true);
    return followedWon ? 30 : followedLost ? -30 : 0;
  }
  // Both ranked slides up to +20 with how highly (two top-5 teams get nearly all of it; two teams
  // barely inside the poll get almost none). One ranked is a flat, smaller +10 — deliberately not
  // scaled, so margin stays the dominant signal rather than rank quality doing extra work here too.
  // Separately, if neither team plays in a power conference (or is Notre Dame, the one power-caliber
  // independent), that's a real markdown regardless of rank — a mid-major track meet isn't the same
  // as a Power 4 defensive struggle even at the same final margin.
  function rankComponent(sport, game){
    const awayRank = game.away?.rank, homeRank = game.home?.rank;
    const ranks = [awayRank, homeRank].filter(r => r != null);
    let s = 0;
    if(ranks.length === 2){
      const strength = r => (26 - r) / 25; // rank 1 -> 1.0, rank 25 -> 0.04
      s += Math.round(((strength(awayRank) + strength(homeRank)) / 2) * 20);
    }else if(ranks.length === 1){
      s += 10;
    }
    if(!isPowerConferenceTeam(sport, game.away) && !isPowerConferenceTeam(sport, game.home)) s -= 20;
    return s;
  }
  function postGameScore(sport, game, followedAway, followedHome){
    if(game.away?.score == null || game.home?.score == null) return 0;
    let s = marginComponent(game) + followedComponent(game, followedAway, followedHome) + rankComponent(sport, game);
    if(isUpset(game)) s += 10;
    return Math.max(0, Math.min(100, s));
  }

  function watchabilityScore(sport, game, recAway, recHome){
    const followedAway = !!(game.away && isFollowed(sport, game.away.id));
    const followedHome = !!(game.home && isFollowed(sport, game.home.id));
    if(game.completed){
      const score = postGameScore(sport, game, followedAway, followedHome);
      const ot = otPeriods(game);
      // Floor, not a replacement — a followed team's OT win still scores its own way above this.
      return ot > 0 ? Math.max(score, Math.min(100, 80 + (ot - 1) * 10)) : score;
    }
    // Live (kicked off, not yet final): no rating at all. The pre-game guess is stale the moment the
    // ball's in the air, and we're not computing a live-score-based one either — the guess should
    // stop, not just switch to guessing off different, still-incomplete information.
    if(game.state === 'in') return null;
    return preGameScore(sport, game, recAway, recHome, followedAway || followedHome);
  }

  function scoreBucketClass(score){
    if(score >= 70) return 'high';
    if(score >= 40) return 'mid';
    return 'low';
  }

  // ---------- rendering ----------
  function dayKey(iso){
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { weekday:'long', month:'short', day:'numeric' });
  }
  function timeStr(iso){
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit', timeZoneName:'short' });
  }

  function shortDate(iso){
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { weekday:'short', month:'numeric', day:'numeric' });
  }

  // Week data is cached indefinitely (see getWeekData), so a game's `state`/`completed` fields
  // reflect whatever the scoreboard looked like at fetch time — they can go stale (e.g. a week
  // fetched before kickoff stays frozen on "pre" long after the game has ended). `completed` is
  // trustworthy once true (a finished game never becomes unfinished), but for everything else we
  // reason from the kickoff clock instead of trusting a possibly-stale live/pre flag.
  const TYPICAL_DURATION_MS = 4 * 60 * 60 * 1000; // ~4h covers OT; better to undercount as "live" a bit long than call it over early

  function statusPhase(g, nowMs){
    if(g.completed) return 'final';
    const kickoff = new Date(g.date).getTime();
    if(nowMs < kickoff) return 'upcoming';
    return (nowMs - kickoff) < TYPICAL_DURATION_MS ? 'live' : 'replay';
  }

  // Keyed by "sport:gameId" -> { game, recAway, recHome, pointer, showDate } for whatever is currently
  // on screen, so a favorite/watchlist toggle can patch just that row instead of rebuilding the board.
  state.renderedGames = new Map();

  // Which rows have their watchability "reasons" (badges) expanded. Deliberately NOT persisted —
  // a completed game's "Nail-biter" badge gives away that it was close, so it stays hidden by
  // default every time, behind the eye icon, rather than remembering a past reveal.
  state.revealedRows = new Set();

  // Which specific team-in-a-game slots (keyed "sport:gameId:home"/"sport:gameId:away") have their
  // rank, record, and win/loss highlighting revealed. A team's record going up is itself a spoiler
  // (it means they won last week), so this is hidden the same way — and deliberately NOT persisted,
  // same reasoning as revealedRows above. Every team gets an eye regardless of whether it actually
  // has a rank or record to show, so the icon's presence alone can't leak "this team has played" info.
  state.revealedTeamInfo = new Set();

  function toggleReveal(sport, gameId){
    const key = `${sport}:${gameId}`;
    if(state.revealedRows.has(key)) state.revealedRows.delete(key);
    else state.revealedRows.add(key);
    patchRow(sport, gameId);
  }

  function toggleTeamReveal(sport, gameId, side){
    const key = `${sport}:${gameId}:${side}`;
    if(state.revealedTeamInfo.has(key)) state.revealedTeamInfo.delete(key);
    else state.revealedTeamInfo.add(key);
    patchRow(sport, gameId);
  }

  function buildRowHTML(sport, g, recAway, recHome, rowIndex, pointer, opts={}){
    const followedGame = (g.away && isFollowed(sport, g.away.id)) || (g.home && isFollowed(sport, g.home.id));
    const score = watchabilityScore(sport, g, recAway, recHome);
    const marquee = isMarquee(g);
    const rivalry = isRivalryGame(sport, g);
    const nail = isNailBiter(g);
    const ot = otPeriods(g);
    const closeSpread = g.odds?.spreadAbs != null && g.odds.spreadAbs <= 9;
    const watched = isWatched(sport, g.id);
    const seen = isSeen(sport, g.id);
    const revealed = state.revealedRows.has(`${sport}:${g.id}`);

    const phase = statusPhase(g, Date.now());
    const statusLine = phase === 'final' ? `<span class="status-final">FINAL</span>`
      : phase === 'live' ? `<span class="status-live">LIVE</span>`
      : phase === 'replay' ? `<span class="status-replay">REPLAY</span>`
      : timeStr(g.date);
    const dateMini = opts.showDate ? `<div class="date-mini">${shortDate(g.date)}</div>` : '';

    const teamLine = (team, side) => {
      if(!team) return '';
      const teamRevealed = state.revealedTeamInfo.has(`${sport}:${g.id}:${side}`);
      const rankChip = (teamRevealed && team.rank) ? `<span class="rank-chip">#${team.rank}</span>` : '';
      const rec = side === 'away' ? recAway : recHome;
      const recChip = teamRevealed ? fmtRecord(recAway && recHome ? rec : null) : null;
      const followed = isFollowed(sport, team.id);
      return `<div class="team-line">
        <button class="follow-btn ${followed?'on':''}" data-sport="${sport}" data-id="${team.id}" data-name="${escapeHTML(team.name)}" title="${followed?'Unfollow':'Follow'} ${escapeHTML(team.name)}">${followed?'♥':'♡'}</button>
        <button class="team-reveal-btn ${teamRevealed?'on':''}" data-sport="${sport}" data-id="${g.id}" data-side="${side}" title="${teamRevealed?'Hide rank & record':'Show rank & record'}">${teamRevealed?'🙈':'👁'}</button>
        ${rankChip}
        <span class="team-name ${(teamRevealed && team.winner) ? 'winner':''}">${escapeHTML(team.name)}</span>
        ${recChip ? `<span class="rec">${recChip}</span>` : ''}
      </div>`;
    };

    const animAttrs = rowIndex == null
      ? ` static`
      : ``;
    const animStyle = rowIndex == null ? '' : ` style="animation-delay:${Math.min(rowIndex*45,400)}ms"`;

    return `<div class="row ${followedGame?'followed':''} ${seen?'seen':''}${animAttrs}" data-sport="${sport}" data-game-id="${g.id}"${animStyle}>
      <div class="time">${dateMini}${statusLine}</div>
      <div class="matchup">
        ${teamLine(g.away, 'away')}
        <div class="at">at</div>
        ${teamLine(g.home, 'home')}
        <div class="venue-net">
          ${g.network ? `<span class="net">${escapeHTML(g.network)}</span>` : ''}
          ${g.venue ? `<span>${escapeHTML(g.venue)}</span>` : ''}
        </div>
      </div>
      <div class="flags">
        <div class="icon-row">
          <button class="seen-btn ${seen?'on':''}" data-sport="${sport}" data-id="${g.id}" title="${seen?'Mark as not watched':'Mark as watched'}">${seen?'☑':'☐'}</button>
          <button class="bookmark-btn ${watched?'on':''}" data-sport="${sport}" data-id="${g.id}" data-year="${pointer?.year??''}" data-seasontype="${pointer?.seasontype??''}" data-week="${pointer?.week??''}" title="${watched?'Remove from watchlist':'Add to watchlist'}">${watched?'🔖':'📑'}</button>
          ${(followedGame||score>=50||closeSpread||nail||rivalry||ot>0) ? `<button class="reveal-btn ${revealed?'on':''}" data-sport="${sport}" data-id="${g.id}" title="${revealed?'Hide watchability reasons':'Show rating reasons'}">${revealed?'🙈':'👁'}</button>` : ''}
        </div>
        ${score>0 ? `<span class="watch-score ${scoreBucketClass(score)}">${score}</span>` : ''}
        ${revealed ? `
          ${followedGame ? `<span class="badge following">♥ following</span>` : ''}
          ${marquee && !followedGame ? `<span class="badge marquee">Marquee</span>` : ''}
          ${rivalry ? `<span class="badge rivalry">⚔️ Rivalry</span>` : ''}
          ${ot>0 ? `<span class="badge overtime">⏱ ${ot>1?ot+'OT':'OT'}</span>` : ''}
          ${closeSpread ? `<span class="badge spread">Close spread</span>` : ''}
          ${nail ? `<span class="badge nailbiter">🔥 Nail-biter</span>` : ''}
        ` : ''}
      </div>
    </div>`;
  }

  // Swap one row's markup in place — no board rebuild, no re-triggered flap animation.
  function patchRow(sport, gameId){
    const entry = state.renderedGames.get(`${sport}:${gameId}`);
    const rowEl = board.querySelector(`.row[data-sport="${sport}"][data-game-id="${gameId}"]`);
    if(!entry || !rowEl) return false;
    const wrap = document.createElement('div');
    wrap.innerHTML = buildRowHTML(sport, entry.game, entry.recAway, entry.recHome, null, entry.pointer, { showDate: entry.showDate });
    rowEl.replaceWith(wrap.firstElementChild);
    return true;
  }

  function weekGroupLabel(sport, seasontype, week){
    const phase = seasontype===1?'Preseason ':seasontype===3?'Postseason ':'';
    return `${SPORTS[sport].label} · ${phase}Week ${week}`;
  }

  async function render(){
    const sport = state.sport;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.sport === sport));

    if(sport === 'watchlist'){
      weeknavEl.style.display = 'none';
      board.innerHTML = `<div class="loading"><span class="flicker">LOADING WATCHLIST…</span></div>`;
      return renderWatchlist();
    }
    weeknavEl.style.display = '';

    const pointer = await computePointerForOffset(sport, state.weeksFromNow);
    if(!pointer){
      weekLabel.textContent = '—';
      board.innerHTML = `<div class="empty">That's the edge of the available schedule.</div>`;
      return;
    }
    state.pointer[sport] = pointer;

    weekLabel.innerHTML = `WEEK ${pointer.week}<span class="yr">${pointer.seasontype===1?'PRESEASON · ':pointer.seasontype===3?'POSTSEASON · ':''}${pointer.year}</span>`;

    board.innerHTML = `<div class="loading"><span class="flicker">LOADING WEEK ${pointer.week}…</span></div>`;

    let data;
    try{
      data = await getWeekData(sport, pointer);
    }catch(e){
      board.innerHTML = `<div class="err">Couldn't reach ESPN's scoreboard from here (likely a network/CORS block).<br>
        Try again in a moment, or check <a href="https://www.espn.com/${SPORTS[sport].path}/schedule" target="_blank" rel="noopener">espn.com/${SPORTS[sport].path}</a> directly.</div>`;
      return;
    }

    if(!data.games.length){
      board.innerHTML = `<div class="empty">No games on the board for this week.</div>`;
      return;
    }

    const records = await getRecordsEntering(sport, pointer.year, pointer.seasontype, pointer.week);
    state.renderedGames.clear();
    let html = '';

    if(state.sortMode === 'watchability'){
      const scored = data.games.map(g => {
        const recAway = g.away ? records.get(g.away.id) : null;
        const recHome = g.home ? records.get(g.home.id) : null;
        return { g, recAway, recHome, score: watchabilityScore(sport, g, recAway, recHome) };
      });
      scored.sort((a,b) => (b.score ?? -1) - (a.score ?? -1) || new Date(a.g.date) - new Date(b.g.date));
      scored.forEach((item, idx) => {
        state.renderedGames.set(`${sport}:${item.g.id}`, { game:item.g, recAway:item.recAway, recHome:item.recHome, pointer, showDate:true });
        html += buildRowHTML(sport, item.g, item.recAway, item.recHome, idx, pointer, { showDate:true });
      });
    }else{
      const groups = new Map();
      data.games.slice().sort((a,b) => new Date(a.date) - new Date(b.date)).forEach(g => {
        const k = dayKey(g.date);
        if(!groups.has(k)) groups.set(k, []);
        groups.get(k).push(g);
      });
      let rowIndex = 0;
      groups.forEach((games, day) => {
        html += `<div class="day-group"><div class="day-label">${day}</div>`;
        games.forEach(g => {
          const recAway = g.away ? records.get(g.away.id) : null;
          const recHome = g.home ? records.get(g.home.id) : null;
          state.renderedGames.set(`${sport}:${g.id}`, { game:g, recAway, recHome, pointer, showDate:false });
          html += buildRowHTML(sport, g, recAway, recHome, rowIndex, pointer);
          rowIndex++;
        });
        html += `</div>`;
      });
    }

    board.innerHTML = html;
    renderFollowChips();
  }

  async function renderWatchlist(){
    if(!state.watchlist.length){
      board.innerHTML = `<div class="empty">Nothing pinned yet.<br>Tap 📑 on any game in CFB or NFL to add it here.</div>`;
      renderFollowChips();
      return;
    }

    // dedupe the (sport, year, seasontype, week) combos we actually need to fetch
    const weekKeys = new Map();
    state.watchlist.forEach(x => {
      const k = `${x.sport}:${x.year}:${x.seasontype}:${x.week}`;
      if(!weekKeys.has(k)) weekKeys.set(k, x);
    });

    const weekDataByKey = {};
    const recordsByKey = {};
    for(const [k, meta] of weekKeys){
      try{
        weekDataByKey[k] = await getWeekData(meta.sport, meta);
        recordsByKey[k] = await getRecordsEntering(meta.sport, meta.year, meta.seasontype, meta.week);
      }catch(e){ /* that week's data is unreachable right now — its pins just won't show */ }
    }

    const groupMap = new Map();
    state.watchlist.forEach(x => {
      const k = `${x.sport}:${x.year}:${x.seasontype}:${x.week}`;
      const wd = weekDataByKey[k];
      if(!wd) return;
      const game = wd.games.find(g => String(g.id) === String(x.id));
      if(!game) return; // pinned game no longer appears in that week's data — skip quietly
      const records = recordsByKey[k] || new Map();
      const recAway = game.away ? records.get(game.away.id) : null;
      const recHome = game.home ? records.get(game.home.id) : null;
      if(!groupMap.has(k)){
        groupMap.set(k, {
          label: weekGroupLabel(x.sport, x.seasontype, x.week),
          sport: x.sport,
          pointer: { year:x.year, seasontype:x.seasontype, week:x.week },
          items: []
        });
      }
      groupMap.get(k).items.push({ game, recAway, recHome });
    });

    const groups = Array.from(groupMap.values());
    if(!groups.length){
      board.innerHTML = `<div class="empty">Your pinned games aren't reachable right now.<br>Try again in a moment.</div>`;
      renderFollowChips();
      return;
    }
    groups.forEach(gr => { gr.earliest = Math.min(...gr.items.map(it => new Date(it.game.date).getTime())); });
    groups.sort((a,b) => a.earliest - b.earliest);

    state.renderedGames.clear();
    let html = '';
    let rowIndex = 0;
    groups.forEach(gr => {
      let items = gr.items.slice();
      if(state.sortMode === 'watchability'){
        items.sort((a,b) => {
          const sa = watchabilityScore(gr.sport, a.game, a.recAway, a.recHome) ?? -1;
          const sb = watchabilityScore(gr.sport, b.game, b.recAway, b.recHome) ?? -1;
          return sb - sa || new Date(a.game.date) - new Date(b.game.date);
        });
      }else{
        items.sort((a,b) => new Date(a.game.date) - new Date(b.game.date));
      }
      html += `<div class="day-group"><div class="day-label">${gr.label}</div>`;
      items.forEach(it => {
        state.renderedGames.set(`${gr.sport}:${it.game.id}`, { game:it.game, recAway:it.recAway, recHome:it.recHome, pointer:gr.pointer, showDate:true });
        html += buildRowHTML(gr.sport, it.game, it.recAway, it.recHome, rowIndex, gr.pointer, { showDate:true });
        rowIndex++;
      });
      html += `</div>`;
    });

    board.innerHTML = html;
    renderFollowChips();
  }

  function renderFollowChips(){
    const el = document.getElementById('followList');
    if(!el) return;
    if(!state.followedTeamsList.length){ el.innerHTML = ''; return; }
    el.innerHTML = state.followedTeamsList.map(t =>
      `<span class="chip">${escapeHTML(t.name)}<button class="chip-x" data-sport="${t.sport}" data-id="${t.id}" data-name="${escapeHTML(t.name)}" title="Unfollow">×</button></span>`
    ).join('');
  }

  function escapeHTML(s){
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ---------- init / navigation ----------
  async function detectCurrent(sport){
    const raw = await fetchJSON(scoreboardURL(sport, {}));
    const parsed = parseScoreboard(raw);
    const key = cacheKey(sport, parsed.meta);
    try{ await storage.set(key, JSON.stringify(parsed), false); }catch(e){}
    return { year: parsed.meta.year, week: parsed.meta.week, seasontype: parsed.meta.seasontype };
  }

  async function ensurePointer(sport){
    if(state.now[sport]) return;
    try{
      state.now[sport] = await detectCurrent(sport);
    }catch(e){
      state.now[sport] = { year:new Date().getFullYear(), week:1, seasontype:2 };
    }
  }

  // Rough max-week guesses, only used as a starting point when searching backward across a
  // season-type boundary — if the guess is off we just walk down until we find real games.
  const SEASONTYPE_WEEK_HINT = {
    'nfl': { 1: 3, 2: 18, 3: 5 },
    'college-football': { 1: 1, 2: 16, 3: 6 }
  };

  async function weekHasGames(sport, pointer){
    try{
      const wd = await getWeekData(sport, pointer);
      return wd.games.length > 0;
    }catch(e){ return false; }
  }

  // Move one week in `dir` (+1/-1), rolling across preseason/regular/postseason boundaries as needed.
  // Returns null if there's nowhere further to go (e.g. stepping back before the season starts).
  async function advancePointer(sport, pointer, dir){
    let candidate = { ...pointer, week: pointer.week + dir };

    if(candidate.week === 0){
      // CFB "Week 0" is a real, distinct slate the weekend before "Week 1" — check it directly
      // rather than assuming week 1 is the true start of the regular season.
      if(await weekHasGames(sport, candidate)) return candidate;
      candidate = { ...candidate, week: -1 }; // no week 0 here — fall through to the boundary logic below
    }

    if(candidate.week < 1){
      if(candidate.seasontype > 1){
        const prevType = candidate.seasontype - 1;
        let w = SEASONTYPE_WEEK_HINT[sport]?.[prevType] || 18;
        let found = null;
        while(w >= 1){
          const c = { year: candidate.year, seasontype: prevType, week: w };
          if(await weekHasGames(sport, c)){ found = c; break; }
          w--;
        }
        candidate = found || { year: candidate.year, seasontype: prevType, week: 1 };
      }else{
        return null;
      }
    }else if(!(await weekHasGames(sport, candidate)) && candidate.seasontype < 3){
      const next = { year: candidate.year, seasontype: candidate.seasontype + 1, week: 1 };
      if(await weekHasGames(sport, next)) candidate = next;
      // else leave candidate as-is; render() will show the honest "no games" state
    }
    return candidate;
  }

  // Resolves the display pointer for a given "weeks from now" offset, walking from that league's
  // own current week one advancePointer() step at a time. This is what keeps CFB and NFL correlated:
  // both leagues resolve the same offset independently, so tab-switching lands on the analogous week.
  const pointerOffsetCache = {}; // "sport:offset" -> pointer|null

  async function computePointerForOffset(sport, offset){
    const ck = `${sport}:${offset}`;
    if(ck in pointerOffsetCache) return pointerOffsetCache[ck];
    let p = state.now[sport];
    if(!p) return null;
    const dir = offset > 0 ? 1 : offset < 0 ? -1 : 0;
    for(let i=0; i<Math.abs(offset); i++){
      const next = await advancePointer(sport, p, dir);
      if(!next) break; // hit the edge of the available schedule; stay put
      p = next;
    }
    pointerOffsetCache[ck] = p;
    return p;
  }

  let navigating = false;

  async function step(delta){
    if(navigating || state.sport === 'watchlist') return;
    navigating = true;
    prevBtn.disabled = true; nextBtn.disabled = true;
    try{
      state.weeksFromNow += delta;
      await render();
    } finally {
      navigating = false;
      prevBtn.disabled = false; nextBtn.disabled = false;
    }
  }

  document.querySelectorAll('.sort-btn').forEach(b => {
    b.addEventListener('click', () => {
      if(state.sortMode === b.dataset.sort) return;
      state.sortMode = b.dataset.sort;
      document.querySelectorAll('.sort-btn').forEach(x => x.classList.toggle('active', x === b));
      render();
    });
  });
  prevBtn.addEventListener('click', () => step(-1));
  nextBtn.addEventListener('click', () => step(1));
  jumpNowBtn.addEventListener('click', () => {
    if(state.weeksFromNow === 0) return;
    state.weeksFromNow = 0;
    render();
  });

  // Only present on watchlist.html — cfb.html/nfl.html don't have these controls.
  document.getElementById('exportDataBtn')?.addEventListener('click', exportUserData);
  document.getElementById('importDataBtn')?.addEventListener('click', () => {
    document.getElementById('importFileInput')?.click();
  });
  document.getElementById('importFileInput')?.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // reset so importing the same filename again still fires 'change'
    if(file) importUserDataFromFile(file);
  });

  // one delegated listener covers watchlist bookmarks, seen toggles, reveal toggles, follow hearts, and follow-chip removals
  document.addEventListener('click', (e) => {
    const sbtn = e.target.closest('.seen-btn');
    if(sbtn){ toggleSeen(sbtn.dataset.sport, sbtn.dataset.id); return; }
    const rbtn = e.target.closest('.reveal-btn');
    if(rbtn){ toggleReveal(rbtn.dataset.sport, rbtn.dataset.id); return; }
    const trbtn = e.target.closest('.team-reveal-btn');
    if(trbtn){ toggleTeamReveal(trbtn.dataset.sport, trbtn.dataset.id, trbtn.dataset.side); return; }
    const wbtn = e.target.closest('.bookmark-btn');
    if(wbtn){ toggleWatch(wbtn.dataset.sport, wbtn.dataset.id, wbtn.dataset.year, wbtn.dataset.seasontype, wbtn.dataset.week); return; }
    const fbtn = e.target.closest('.follow-btn, .chip-x');
    if(fbtn){ toggleFollow(fbtn.dataset.sport, fbtn.dataset.id, fbtn.dataset.name); return; }
  });

  // Each page (cfb.html / nfl.html / watchlist.html) sets window.APP_SPORT before loading this file
  // and just links to the others as real pages — no in-page tab-switching needed anymore.
  (async function init(){
    await loadUserData();
    state.sport = window.APP_SPORT || 'college-football';
    if(state.sport !== 'watchlist') await ensurePointer(state.sport);
    render();
  })();
})();
