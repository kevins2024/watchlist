
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
    try{
      const cached = await storage.get(key, false);
      if(cached && cached.value) return JSON.parse(cached.value);
    }catch(e){ /* not cached yet */ }

    let parsed;
    if(sport === 'college-football' && pointer.seasontype === 2 && (pointer.week === 0 || pointer.week === 1)){
      const split = await getWeekZeroOneSplit(sport, pointer.year, pointer.seasontype);
      parsed = {
        meta: { year: pointer.year, week: pointer.week, seasontype: pointer.seasontype, weekText: pointer.week === 0 ? 'Week 0' : 'Week 1' },
        games: pointer.week === 0 ? split.week0 : split.week1
      };
    }else{
      const raw = await fetchJSON(scoreboardURL(sport, pointer));
      parsed = parseScoreboard(raw, pointer);
    }

    try{ await storage.set(key, JSON.stringify(parsed), false); }catch(e){}
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
        // per-quarter scoring (e.g. [7,14,0,21]) — used to tell a genuinely tight finish from
        // garbage time padding a blowout's final margin. Not always present; null if missing.
        linescores: Array.isArray(c.linescores) && c.linescores.length
          ? c.linescores.map(ls => Number(ls.value ?? ls.displayValue ?? ls) || 0)
          : null
      }) : null;
      const netObj = comp.broadcasts?.[0];
      const network = netObj?.names?.[0] || comp.geoBroadcasts?.[0]?.media?.shortName || null;
      return {
        id: ev.id,
        date: ev.date,
        completed: !!ev.status?.type?.completed,
        state: ev.status?.type?.state, // pre, in, post
        statusDetail: ev.status?.type?.shortDetail || '',
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
  const MAJOR_NETS = ['ABC','CBS','NBC','FOX','ESPN','ESPN2','Prime Video','Peacock'];

  function isNailBiter(game){
    if(!game.completed || game.away?.score == null || game.home?.score == null) return false;
    return Math.abs(game.away.score - game.home.score) <= 16;
  }

  function isUpset(game){
    if(!game.completed || !game.odds?.favorite) return false;
    return (game.odds.favorite === 'home' && game.away?.winner === true) ||
           (game.odds.favorite === 'away' && game.home?.winner === true);
  }

  // Sum of the first 3 quarters for each side, if ESPN gave us per-quarter scoring.
  function scoreThroughQ3(team){
    if(!team?.linescores || team.linescores.length < 3) return null;
    return team.linescores.slice(0,3).reduce((a,b) => a+b, 0);
  }

  // A close final margin only means something if the game was actually still in doubt getting there.
  // Real signal, when we have it: within 16 points at the end of the 3rd quarter, and the final gap
  // didn't blow open wider than that — i.e. it stayed close or tightened further in the 4th, rather
  // than a blowout that only looked "close" at the final whistle because backups traded garbage-time
  // scores once it was already decided. Falls back to the pregame-line guard when quarter data is
  // missing. An outright upset always counts, regardless of margin.
  function wasCompetitive(game){
    if(isUpset(game)) return true;

    const awQ3 = scoreThroughQ3(game.away);
    const hmQ3 = scoreThroughQ3(game.home);
    if(awQ3 != null && hmQ3 != null && game.away?.score != null && game.home?.score != null){
      const q3Diff = Math.abs(awQ3 - hmQ3);
      const finalDiff = Math.abs(game.away.score - game.home.score);
      return q3Diff <= 16 && finalDiff <= q3Diff;
    }

    const spreadAbs = game.odds?.spreadAbs;
    const wasBlowoutLine = spreadAbs != null && spreadAbs >= 21;
    return isNailBiter(game) && !wasBlowoutLine;
  }

  // Rankings + broadcast slot + records + following set the pre-game expectation, the spread nudges
  // it (tight line up, blowout line down) — and once a game is final, a genuinely competitive finish
  // (see wasCompetitive above) quietly pulls the score back up. The spread number and the final
  // margin are never rendered, only used here.
  function starScore(game, recAway, recHome, followed){
    let s = 0;
    if(followed) s += 2; // a strong nudge, not an automatic 3/3 — other factors still matter
    if(game.network && MAJOR_NETS.some(n => game.network.includes(n))) s++;
    const ranks = [game.away?.rank, game.home?.rank].filter(r => r != null);
    if(ranks.length === 2) s += 2; else if(ranks.length === 1) s += 1;
    if(recAway && recHome && (recAway.w + recAway.l) > 0 && (recHome.w + recHome.l) > 0
       && recAway.w >= recAway.l && recHome.w >= recHome.l) s++;

    const spreadAbs = game.odds?.spreadAbs;
    if(spreadAbs != null){
      if(spreadAbs <= 9) s += 1;
      else if(spreadAbs >= 21) s -= 1;
    }

    if(game.completed && wasCompetitive(game)) s += 2;

    return Math.max(0, Math.min(s, 3));
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
    const stars = starScore(g, recAway, recHome, followedGame);
    const nail = wasCompetitive(g);
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
          ${(followedGame||stars>=2||closeSpread||nail) ? `<button class="reveal-btn ${revealed?'on':''}" data-sport="${sport}" data-id="${g.id}" title="${revealed?'Hide watchability reasons':'Show rating reasons'}">${revealed?'🙈':'👁'}</button>` : ''}
        </div>
        ${stars>0 ? `<span class="stars">${'★'.repeat(stars)}${'☆'.repeat(3-stars)}</span>` : ''}
        ${revealed ? `
          ${followedGame ? `<span class="badge following">♥ following</span>` : ''}
          ${stars>=2 && !followedGame ? `<span class="badge marquee">Marquee</span>` : ''}
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
        const followedGame = (g.away && isFollowed(sport, g.away.id)) || (g.home && isFollowed(sport, g.home.id));
        return { g, recAway, recHome, stars: starScore(g, recAway, recHome, followedGame) };
      });
      scored.sort((a,b) => b.stars - a.stars || new Date(a.g.date) - new Date(b.g.date));
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
          const followedA = (a.game.away && isFollowed(gr.sport, a.game.away.id)) || (a.game.home && isFollowed(gr.sport, a.game.home.id));
          const followedB = (b.game.away && isFollowed(gr.sport, b.game.away.id)) || (b.game.home && isFollowed(gr.sport, b.game.home.id));
          const sa = starScore(a.game, a.recAway, a.recHome, followedA);
          const sb = starScore(b.game, b.recAway, b.recHome, followedB);
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
