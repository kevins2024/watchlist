(function(){
  // Same real per-browser/device localStorage shim used on the other boards, kept as its own copy
  // here so this file has no dependency on the others — deliberately self-contained.
  const storage = {
    async get(key){
      try{ const raw = localStorage.getItem(key); return raw === null ? null : { key, value: raw }; }
      catch(e){ return null; }
    },
    async set(key, value){
      try{ localStorage.setItem(key, value); return { key, value }; }
      catch(e){ return null; }
    }
  };

  const state = {
    dateOffset: 0,           // days (in the season calendar, not the raw calendar) from "today"
    sortMode: 'time',
    watchedKeys: new Set(),      // "gameId"
    seenGames: new Set(),
    followedTeams: new Set(),    // "teamId"
    followedTeamsList: [],
    revealedRows: new Set(),         // badge reveal, not persisted — same reasoning as the other boards
    revealedTeamInfo: new Set(),     // record reveal, not persisted
    renderedGames: new Map(),
    calendar: null,          // sorted ['YYYYMMDD', ...] of every date with an NHL game, in-memory only
    days: {},                // 'YYYYMMDD' -> [games...], in-memory only for this page view
    teamSchedules: {}        // "teamId:seasonYear" -> [{date,completed,winner,period}...], in-memory only
  };

  const board = document.getElementById('board');
  const dayLabel = document.getElementById('dayLabel');
  const prevBtn = document.getElementById('prevDay');
  const nextBtn = document.getElementById('nextDay');
  const jumpNowBtn = document.getElementById('jumpNowDay');
  const followListEl = document.getElementById('followList');

  async function fetchJSON(url){
    try{
      const r = await fetch(url, { headers: { 'Accept':'application/json' } });
      if(!r.ok) throw new Error('HTTP '+r.status);
      return await r.json();
    }catch(e){
      const proxied = 'https://corsproxy.io/?url=' + encodeURIComponent(url);
      const r2 = await fetch(proxied);
      if(!r2.ok) throw new Error('HTTP '+r2.status+' (proxy)');
      return await r2.json();
    }
  }

  function parseEvent(ev){
    const comp = ev.competitions?.[0] || {};
    const status = comp.status || {};
    const competitors = comp.competitors || [];
    const away = competitors.find(c => c.homeAway === 'away');
    const home = competitors.find(c => c.homeAway === 'home');
    const mapTeam = c => c ? ({
      id: c.team?.id,
      name: c.team?.shortDisplayName || c.team?.displayName || c.team?.name || '—',
      winner: c.winner === true,
      score: c.score !== undefined ? Number(c.score) : null
    }) : null;
    const netObj = comp.broadcasts?.[0];
    const network = netObj?.names?.[0] || comp.geoBroadcasts?.[0]?.media?.shortName || null;
    return {
      id: ev.id,
      date: ev.date,
      completed: !!status.type?.completed,
      state: status.type?.state,
      period: status.period || 0,          // 4+ means it went to OT/SO
      seasonType: ev.season?.type ?? null,  // 1 preseason, 2 regular, 3 playoffs
      venue: comp.venue?.fullName || null,
      network,
      away: mapTeam(away),
      home: mapTeam(home)
    };
  }

  function ymd(iso){ return iso.slice(0,10).replace(/-/g,''); }

  // NHL runs a near-daily schedule across a ~9-month season rather than weekly rounds, so there's no
  // "week" pointer to walk the way the CFB/NFL boards do. ESPN's own scoreboard response carries a flat
  // calendar of every date that actually has a game that season — fetched once per page view and used
  // to step the pager straight from one game date to the next/previous, skipping empty days for free.
  async function ensureCalendar(){
    if(state.calendar) return state.calendar;
    const raw = await fetchJSON('https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard');
    const cal = raw?.leagues?.[0]?.calendar;
    const dates = Array.isArray(cal) ? cal.map(ymd) : [];
    state.calendar = Array.from(new Set(dates)).sort();
    return state.calendar;
  }

  function currentDateIndex(calendar){
    const todayStr = ymd(new Date().toISOString());
    for(let i=0; i<calendar.length; i++){
      if(calendar[i] >= todayStr) return i;
    }
    return Math.max(0, calendar.length - 1);
  }

  // Schedule data is fetched fresh every page load rather than cached to localStorage — same reasoning
  // as the international boards: a date close to "now" can still have games that are mid-progress or
  // whose result isn't posted yet, and an indefinite cache would freeze that the way the CFB
  // week-0/week-1 split once did. The in-memory `state.days` cache still avoids re-fetching a date
  // you've already paged past within one visit.
  async function getDayData(dateStr){
    if(state.days[dateStr]) return state.days[dateStr];
    const raw = await fetchJSON(`https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard?dates=${dateStr}`);
    const games = (raw.events || []).map(parseEvent);
    state.days[dateStr] = games;
    return games;
  }

  // NHL's season "year" names the year it ends in (the 2025-26 season is "2026") — games from
  // July onward count as the start of the next season.
  function seasonYearFor(dateObj){
    const y = dateObj.getUTCFullYear();
    const m = dateObj.getUTCMonth(); // 0-indexed
    return m >= 6 ? y + 1 : y;
  }

  // A team's own full-season schedule, fetched once per team+season and reused for every game of
  // theirs you view this session — far cheaper than tallying day-by-day across the whole season, since
  // it's one request per team rather than one per date. Not persisted to localStorage for the same
  // "still-evolving data" reason as getDayData above.
  async function getTeamSchedule(teamId, seasonYear){
    const key = `${teamId}:${seasonYear}`;
    if(state.teamSchedules[key]) return state.teamSchedules[key];
    let sched = [];
    try{
      const raw = await fetchJSON(`https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/teams/${teamId}/schedule?season=${seasonYear}`);
      sched = (raw.events || []).map(ev => {
        const comp = ev.competitions?.[0] || {};
        const status = comp.status || {};
        const self = (comp.competitors || []).find(c => String(c.team?.id) === String(teamId));
        return {
          date: ev.date,
          completed: !!status.type?.completed,
          winner: self?.winner === true,
          hasResult: self != null,
          period: status.period || 3
        };
      });
    }catch(e){ /* leave sched empty — that team's record just won't show */ }
    state.teamSchedules[key] = sched;
    return sched;
  }

  // Plain W-L-OTL, tallied from that team's own completed games strictly before `beforeISO` — computed
  // ourselves from raw results rather than trusting ESPN's own "YTD" record field, which (confirmed by
  // spot-checking real games) already includes the result of the game it's attached to. Showing that
  // directly for a finished game would immediately give away whether the team had just won or lost it.
  function tallyRecordEntering(sched, beforeISO){
    const cutoffMs = new Date(beforeISO).getTime();
    const rec = { w:0, l:0, otl:0 };
    sched.forEach(g => {
      if(!g.completed || !g.hasResult) return;
      if(new Date(g.date).getTime() >= cutoffMs) return;
      if(g.winner) rec.w++;
      else if(g.period >= 4) rec.otl++;
      else rec.l++;
    });
    return rec;
  }
  function fmtRecord(rec){
    if(!rec) return null;
    return `${rec.w}-${rec.l}-${rec.otl} · ${rec.w*2+rec.otl}pts`;
  }

  function isWatched(gameId){ return state.watchedKeys.has(String(gameId)); }
  function isSeen(gameId){ return state.seenGames.has(String(gameId)); }
  function isFollowed(teamId){ return state.followedTeams.has(String(teamId)); }

  async function loadUserData(){
    try{
      const w = await storage.get('nhl:watchlist:games');
      if(w && w.value) state.watchedKeys = new Set(JSON.parse(w.value));
    }catch(e){}
    try{
      const s = await storage.get('nhl:seen:games');
      if(s && s.value) state.seenGames = new Set(JSON.parse(s.value));
    }catch(e){}
    try{
      const t = await storage.get('nhl:follow:teams');
      if(t && t.value){
        state.followedTeamsList = JSON.parse(t.value);
        state.followedTeams = new Set(state.followedTeamsList.map(x => x.id));
      }
    }catch(e){}
  }
  async function saveWatched(){ try{ await storage.set('nhl:watchlist:games', JSON.stringify(Array.from(state.watchedKeys))); }catch(e){} }
  async function saveSeen(){ try{ await storage.set('nhl:seen:games', JSON.stringify(Array.from(state.seenGames))); }catch(e){} }
  async function saveFollowed(){ try{ await storage.set('nhl:follow:teams', JSON.stringify(state.followedTeamsList)); }catch(e){} }

  function toggleWatch(gameId){
    if(state.watchedKeys.has(gameId)) state.watchedKeys.delete(gameId); else state.watchedKeys.add(gameId);
    saveWatched();
    patchRow(gameId);
  }
  function toggleSeen(gameId){
    if(state.seenGames.has(gameId)) state.seenGames.delete(gameId); else state.seenGames.add(gameId);
    saveSeen();
    patchRow(gameId);
  }
  function toggleFollow(teamId, teamName){
    if(state.followedTeams.has(teamId)){
      state.followedTeams.delete(teamId);
      state.followedTeamsList = state.followedTeamsList.filter(x => x.id !== teamId);
    }else{
      state.followedTeams.add(teamId);
      state.followedTeamsList.push({ id: teamId, name: teamName });
    }
    saveFollowed();
    renderFollowChips();
    for(const [gameId, entry] of state.renderedGames){
      if((entry.game.away && entry.game.away.id === teamId) || (entry.game.home && entry.game.home.id === teamId)){
        patchRow(gameId);
      }
    }
  }
  function toggleReveal(gameId){
    if(state.revealedRows.has(gameId)) state.revealedRows.delete(gameId); else state.revealedRows.add(gameId);
    patchRow(gameId);
  }
  function toggleTeamReveal(gameId, side){
    const key = `${gameId}:${side}`;
    if(state.revealedTeamInfo.has(key)) state.revealedTeamInfo.delete(key); else state.revealedTeamInfo.add(key);
    patchRow(gameId);
  }

  const MAJOR_NETS = ['ABC','ESPN','ESPN2','TNT','TBS','Prime Video','Hulu'];

  // A one-goal final is the standard "close game" line in hockey; a game that reached overtime or a
  // shootout is close by definition (the score was still tied after 60 minutes) even on the rare
  // occasion the final margin reads as more than one due to an empty-net goal.
  function isCloseFinish(g){
    if(!g.completed || g.away?.score == null || g.home?.score == null) return false;
    return Math.abs(g.away.score - g.home.score) <= 1 || g.period >= 4;
  }
  function wentToOT(g){ return g.completed && g.period >= 4; }
  // Regulation is 3 periods; anything past that is overtime/shootout. Playoffs can run to multiple OT
  // periods (period 5, 6, 7...); a regular-season shootout just shows as one extra period.
  function otPeriods(g){ return g.completed ? Math.max(0, (g.period || 0) - 3) : 0; }
  function isUpset(g, recAway, recHome){
    if(!g.completed || !recAway || !recHome) return false;
    const ptsA = recAway.w*2 + recAway.otl, ptsH = recHome.w*2 + recHome.otl;
    if(ptsH > ptsA + 15 && g.away?.winner) return true;
    if(ptsA > ptsH + 15 && g.home?.winner) return true;
    return false;
  }
  function standingsClose(recAway, recHome){
    if(!recAway || !recHome) return false;
    const ptsA = recAway.w*2+recAway.otl, ptsH = recHome.w*2+recHome.otl;
    return Math.abs(ptsA-ptsH) <= 8;
  }
  // A playoff game that survives the result (stayed a one-goal/OT game, or hasn't been played yet)
  // keeps the marquee badge; one that turned into a laugher loses it, same as CFB's both-ranked badge.
  function isMarquee(g){
    if(g.seasonType !== 3) return false;
    if(!g.completed) return true;
    return isCloseFinish(g);
  }

  // ---- Pre-game / in-progress: a hype guess from small stacking signals, discarded entirely once
  // the game is final (see postGameScore) — nothing here should still be influencing the score once
  // we know how it actually went.
  function preGameScore(g, recAway, recHome, followed){
    let s = 0;
    if(followed) s += 40;
    if(g.seasonType === 3) s += 25; // playoffs are appointment viewing even blind to the matchup
    if(g.network && MAJOR_NETS.includes(g.network)) s += 10;
    if(standingsClose(recAway, recHome)) s += 15;
    return Math.max(0, Math.min(100, s));
  }

  // ---- Final: the result IS the score. Goal differential does almost all the work (a one-goal or
  // OT/SO finish scores highest, dropping fast from there — hockey blowouts happen at much smaller
  // margins than football's), plus a flat followed-team swing and a smaller nudge for a genuine upset
  // or an evenly-matched standings battle. Any overtime floors the score at 80+, climbing with each
  // extra period, regardless of what the raw components add up to.
  function postGameScore(g, recAway, recHome, followed, followedWon){
    if(g.away?.score == null || g.home?.score == null) return 0;
    const diff = Math.abs(g.away.score - g.home.score);
    let s = Math.max(0, 80 - 16 * diff); // 0 -> 80, 1 -> 64, 2 -> 48, 3 -> 32, 4 -> 16, 5+ -> 0
    if(followed) s += followedWon ? 30 : -30;
    if(standingsClose(recAway, recHome)) s += 10;
    if(isUpset(g, recAway, recHome)) s += 10;
    s = Math.max(0, Math.min(100, s));
    const ot = otPeriods(g);
    if(ot > 0) s = Math.max(s, Math.min(100, 80 + (ot - 1) * 10));
    return s;
  }

  function watchabilityScore(g, recAway, recHome, followedAway, followedHome){
    const followed = followedAway || followedHome;
    if(g.completed){
      const followedWon = (followedAway && g.away?.winner === true) || (followedHome && g.home?.winner === true);
      return postGameScore(g, recAway, recHome, followed, followedWon);
    }
    if(g.state === 'in') return null; // live: no rating, same reasoning as the CFB board
    return preGameScore(g, recAway, recHome, followed);
  }
  function scoreBucketClass(score){
    if(score >= 70) return 'high';
    if(score >= 40) return 'mid';
    return 'low';
  }

  function escapeHTML(s){
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function timeStr(iso){
    return new Date(iso).toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit', timeZoneName:'short' });
  }
  function longDate(dateStr){
    // dateStr is 'YYYYMMDD' — build a Date at UTC noon so no local timezone can roll it to the wrong day
    const d = new Date(Date.UTC(+dateStr.slice(0,4), +dateStr.slice(4,6)-1, +dateStr.slice(6,8), 12));
    return d.toLocaleDateString(undefined, { weekday:'long', month:'short', day:'numeric' });
  }

  // This board fetches fresh every page load (see getDayData) rather than caching the schedule forever,
  // so there's no stale "state" field to worry about — but the clock-based fallback still matters for
  // the common case of a completed game whose `completed` flag genuinely hasn't flipped yet moments
  // after the final horn.
  const TYPICAL_DURATION_MS = 3 * 60 * 60 * 1000; // 3 periods + intermissions, with room for OT/SO

  function statusPhase(g, nowMs){
    if(g.completed) return 'final';
    const start = new Date(g.date).getTime();
    if(nowMs < start) return 'upcoming';
    return (nowMs - start) < TYPICAL_DURATION_MS ? 'live' : 'replay';
  }

  function buildRowHTML(g, recAway, recHome, rowIndex){
    const followedAway = !!(g.away && isFollowed(g.away.id));
    const followedHome = !!(g.home && isFollowed(g.home.id));
    const followedGame = followedAway || followedHome;
    const score = watchabilityScore(g, recAway, recHome, followedAway, followedHome);
    const marquee = isMarquee(g);
    const close = isCloseFinish(g);
    const ot = wentToOT(g);
    const watched = isWatched(g.id);
    const seen = isSeen(g.id);
    const revealed = state.revealedRows.has(g.id);

    const phase = statusPhase(g, Date.now());
    const statusLine = phase === 'final' ? `<span class="status-final">FINAL</span>`
      : phase === 'live' ? `<span class="status-live">LIVE</span>`
      : phase === 'replay' ? `<span class="status-replay">REPLAY</span>`
      : timeStr(g.date);

    const teamLine = (team, side) => {
      if(!team) return '';
      const teamRevealed = state.revealedTeamInfo.has(`${g.id}:${side}`);
      const rec = side === 'away' ? recAway : recHome;
      const recChip = teamRevealed ? fmtRecord(rec) : null;
      const followed = isFollowed(team.id);
      return `<div class="team-line">
        <button class="follow-btn ${followed?'on':''}" data-id="${team.id}" data-name="${escapeHTML(team.name)}" title="${followed?'Unfollow':'Follow'} ${escapeHTML(team.name)}">${followed?'♥':'♡'}</button>
        <button class="team-reveal-btn ${teamRevealed?'on':''}" data-game-id="${g.id}" data-side="${side}" title="${teamRevealed?'Hide record':'Show record'}">${teamRevealed?'🙈':'👁'}</button>
        <span class="team-name ${(teamRevealed && team.winner) ? 'winner':''}">${escapeHTML(team.name)}</span>
        ${recChip ? `<span class="rec">${recChip}</span>` : ''}
      </div>`;
    };

    const animAttrs = rowIndex == null ? ` static` : ``;
    const animStyle = rowIndex == null ? '' : ` style="animation-delay:${Math.min(rowIndex*45,400)}ms"`;

    return `<div class="row ${followedGame?'followed':''} ${seen?'seen':''}${animAttrs}" data-game-id="${g.id}"${animStyle}>
      <div class="time">${statusLine}</div>
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
          <button class="seen-btn ${seen?'on':''}" data-id="${g.id}" title="${seen?'Mark as not watched':'Mark as watched'}">${seen?'☑':'☐'}</button>
          <button class="bookmark-btn ${watched?'on':''}" data-id="${g.id}" title="${watched?'Remove from watchlist':'Add to watchlist'}">${watched?'🔖':'📑'}</button>
        </div>
        ${(followedGame||(score!=null && score>=50)||close) ? `<button class="reveal-btn ${revealed?'on':''}" data-id="${g.id}" title="${revealed?'Hide watchability reasons':'Show rating reasons'}">${revealed?'🙈':'👁'}</button>` : ''}
        ${score>0 ? `<span class="watch-score ${scoreBucketClass(score)}">${score}</span>` : ''}
        ${revealed ? `
          ${followedGame ? `<span class="badge following">♥ following</span>` : ''}
          ${marquee && !followedGame ? `<span class="badge marquee">Marquee</span>` : ''}
          ${ot ? `<span class="badge nailbiter">🔥 Went to OT/SO</span>` : (close ? `<span class="badge nailbiter">🔥 One-goal game</span>` : '')}
        ` : ''}
      </div>
    </div>`;
  }

  function patchRow(gameId){
    const entry = state.renderedGames.get(gameId);
    const rowEl = board.querySelector(`.row[data-game-id="${gameId}"]`);
    if(!entry || !rowEl) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = buildRowHTML(entry.game, entry.recAway, entry.recHome, null);
    rowEl.replaceWith(wrap.firstElementChild);
  }

  function renderFollowChips(){
    if(!followListEl) return;
    if(!state.followedTeamsList.length){ followListEl.innerHTML = ''; return; }
    followListEl.innerHTML = state.followedTeamsList.map(t =>
      `<span class="chip">${escapeHTML(t.name)}<button class="chip-x" data-id="${t.id}" data-name="${escapeHTML(t.name)}" title="Unfollow">×</button></span>`
    ).join('');
  }

  async function render(){
    board.innerHTML = `<div class="loading"><span class="flicker">LOADING DAY…</span></div>`;

    let calendar;
    try{
      calendar = await ensureCalendar();
    }catch(e){
      board.innerHTML = `<div class="err">Couldn't reach ESPN's scoreboard from here (likely a network/CORS block).<br>
        Try again in a moment, or check <a href="https://www.espn.com/nhl/schedule" target="_blank" rel="noopener">espn.com/nhl</a> directly.</div>`;
      return;
    }
    if(!calendar.length){
      board.innerHTML = `<div class="empty">Couldn't find a game calendar right now — try again in a moment.</div>`;
      return;
    }

    const curIdx = currentDateIndex(calendar);
    let idx = curIdx + state.dateOffset;
    idx = Math.max(0, Math.min(idx, calendar.length - 1));
    state.dateOffset = idx - curIdx;

    const dateStr = calendar[idx];
    dayLabel.innerHTML = longDate(dateStr);
    prevBtn.disabled = idx <= 0;
    nextBtn.disabled = idx >= calendar.length - 1;

    let games;
    try{
      games = await getDayData(dateStr);
    }catch(e){
      board.innerHTML = `<div class="err">Couldn't reach ESPN's scoreboard from here (likely a network/CORS block).<br>
        Try again in a moment, or check <a href="https://www.espn.com/nhl/schedule" target="_blank" rel="noopener">espn.com/nhl</a> directly.</div>`;
      return;
    }

    if(!games.length){
      board.innerHTML = `<div class="empty">No games on the board for this day.</div>`;
      return;
    }

    // Records "entering" this date, computed per team from that team's own full-season schedule
    // (see getTeamSchedule/tallyRecordEntering) — one fetch per team playing today, not per day of season.
    const records = new Map();
    for(const g of games){
      for(const team of [g.away, g.home]){
        if(!team?.id || records.has(team.id)) continue;
        const seasonYear = seasonYearFor(new Date(g.date));
        const sched = await getTeamSchedule(team.id, seasonYear);
        records.set(team.id, tallyRecordEntering(sched, g.date));
      }
    }

    state.renderedGames.clear();
    let ordered = games.slice();
    if(state.sortMode === 'watchability'){
      const scored = ordered.map(g => {
        const recAway = g.away ? records.get(g.away.id) : null;
        const recHome = g.home ? records.get(g.home.id) : null;
        const followedAway = !!(g.away && isFollowed(g.away.id));
        const followedHome = !!(g.home && isFollowed(g.home.id));
        return { g, recAway, recHome, score: watchabilityScore(g, recAway, recHome, followedAway, followedHome) ?? -1 };
      });
      scored.sort((a,b) => b.score - a.score || new Date(a.g.date) - new Date(b.g.date));
      ordered = scored.map(x => x.g);
    }else{
      ordered.sort((a,b) => new Date(a.date) - new Date(b.date));
    }

    let html = '';
    ordered.forEach((g, i) => {
      const recAway = g.away ? records.get(g.away.id) : null;
      const recHome = g.home ? records.get(g.home.id) : null;
      state.renderedGames.set(g.id, { game:g, recAway, recHome });
      html += buildRowHTML(g, recAway, recHome, i);
    });

    board.innerHTML = html;
    renderFollowChips();
  }

  let navigating = false;
  async function step(delta){
    if(navigating) return;
    navigating = true;
    prevBtn.disabled = true; nextBtn.disabled = true;
    try{
      state.dateOffset += delta;
      await render();
    } finally {
      navigating = false;
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
    if(state.dateOffset === 0) return;
    state.dateOffset = 0;
    render();
  });

  document.addEventListener('click', (e) => {
    const sbtn = e.target.closest('.seen-btn');
    if(sbtn){ toggleSeen(sbtn.dataset.id); return; }
    const rbtn = e.target.closest('.reveal-btn');
    if(rbtn){ toggleReveal(rbtn.dataset.id); return; }
    const trbtn = e.target.closest('.team-reveal-btn');
    if(trbtn){ toggleTeamReveal(trbtn.dataset.gameId, trbtn.dataset.side); return; }
    const wbtn = e.target.closest('.bookmark-btn');
    if(wbtn){ toggleWatch(wbtn.dataset.id); return; }
    const fbtn = e.target.closest('.follow-btn, .chip-x');
    if(fbtn){ toggleFollow(fbtn.dataset.id, fbtn.dataset.name); return; }
  });

  (async function init(){
    await loadUserData();
    render();
  })();
})();
