(function(){
  // Same real per-browser/device localStorage shim used on the CFB/NFL boards, kept as its own copy
  // here so this file has no dependency on app.js — deliberately self-contained.
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

  const LEAGUES = {
    'eng.1': { label: 'Premier League', accent: 'eng1' },
    'esp.1': { label: 'La Liga',        accent: 'esp1' },
    'fra.1': { label: 'Ligue 1',        accent: 'fra1' },
    'ger.1': { label: 'Bundesliga',     accent: 'ger1' },
    'ita.1': { label: 'Serie A',        accent: 'ita1' }
  };

  const state = {
    league: window.APP_LEAGUE || 'eng.1',
    mdOffset: 0,           // matchdays from "current", independent per league (no cross-league correlation)
    sortMode: 'time',
    watchedKeys: new Set(),      // "league:gameId" — kept separate from the CFB/NFL watchlist for now
    seenGames: new Set(),        // "league:gameId"
    followedTeams: new Set(),    // "league:teamId"
    followedTeamsList: [],
    revealedRows: new Set(),         // badge reveal, not persisted — same reasoning as the CFB/NFL boards
    revealedTeamInfo: new Set(),     // record reveal, not persisted
    renderedGames: new Map(),
    seasons: {}    // league -> { seasonYear, matchdays: [[games...], ...] } once fetched
  };

  const board = document.getElementById('board');
  const mdLabel = document.getElementById('mdLabel');
  const prevBtn = document.getElementById('prevMD');
  const nextBtn = document.getElementById('nextMD');
  const jumpNowBtn = document.getElementById('jumpNowMD');
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

  function fmtYYYYMMDD(d){
    return d.getUTCFullYear() + String(d.getUTCMonth()+1).padStart(2,'0') + String(d.getUTCDate()).padStart(2,'0');
  }

  // European domestic seasons run roughly Aug–May/June. This just needs a window generous enough to
  // contain the whole season, not exact dates — July onward counts as "this season's year."
  function seasonWindow(){
    const now = new Date();
    const y = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
    return {
      seasonYear: y,
      start: new Date(Date.UTC(y, 7, 1)),
      end: new Date(Date.UTC(y+1, 5, 15))
    };
  }

  function parseSoccerEvent(ev){
    const comp = ev.competitions?.[0] || {};
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
      completed: !!ev.status?.type?.completed,
      state: ev.status?.type?.state,
      venue: comp.venue?.fullName || null,
      network,
      away: mapTeam(away),
      home: mapTeam(home)
    };
  }

  // No reliable "matchday number" query param confirmed for ESPN's soccer scoreboard, so this fetches
  // the whole season's fixtures in one request and clusters them itself: sort by kickoff, and whenever
  // the gap since the previous game exceeds ~3 days, start a new matchday. That reliably separates one
  // weekend's round from the next even though it won't always match ESPN's own official matchday label —
  // acceptable per your steer that exact date alignment doesn't matter here.
  function clusterMatchdays(events){
    const sorted = events.slice().sort((a,b) => new Date(a.date) - new Date(b.date));
    const GAP_MS = 3 * 24 * 60 * 60 * 1000;
    const groups = [];
    let current = [];
    let lastMs = null;
    sorted.forEach(ev => {
      const ms = new Date(ev.date).getTime();
      if(lastMs !== null && (ms - lastMs) > GAP_MS){
        groups.push(current);
        current = [];
      }
      current.push(ev);
      lastMs = ms;
    });
    if(current.length) groups.push(current);
    return groups;
  }

  async function fetchSeason(league){
    if(state.seasons[league]) return state.seasons[league];
    const { seasonYear, start, end } = seasonWindow();
    const cacheKey = `soccer:v1:${league}:${seasonYear}`;
    try{
      const cached = await storage.get(cacheKey);
      if(cached && cached.value){
        const parsed = JSON.parse(cached.value);
        state.seasons[league] = parsed;
        return parsed;
      }
    }catch(e){}

    const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/scoreboard?dates=${fmtYYYYMMDD(start)}-${fmtYYYYMMDD(end)}&limit=1000`;
    const raw = await fetchJSON(url);
    const games = (raw.events || []).map(parseSoccerEvent);
    const matchdays = clusterMatchdays(games);
    const result = { seasonYear, matchdays };
    try{ await storage.set(cacheKey, JSON.stringify(result)); }catch(e){}
    state.seasons[league] = result;
    return result;
  }

  // Index (0-based) of the matchday containing "now," or the next one if we're between rounds.
  function currentMatchdayIndex(season){
    const now = Date.now();
    for(let i=0; i<season.matchdays.length; i++){
      const md = season.matchdays[i];
      const last = new Date(md[md.length-1].date).getTime();
      if(last >= now) return i;
    }
    return Math.max(0, season.matchdays.length - 1);
  }

  function isWatched(league, gameId){ return state.watchedKeys.has(`${league}:${gameId}`); }
  function isSeen(league, gameId){ return state.seenGames.has(`${league}:${gameId}`); }
  function isFollowed(league, teamId){ return state.followedTeams.has(`${league}:${teamId}`); }

  async function loadUserData(){
    try{
      const w = await storage.get('soccer:watchlist:games');
      if(w && w.value) state.watchedKeys = new Set(JSON.parse(w.value));
    }catch(e){}
    try{
      const s = await storage.get('soccer:seen:games');
      if(s && s.value) state.seenGames = new Set(JSON.parse(s.value));
    }catch(e){}
    try{
      const t = await storage.get('soccer:follow:teams');
      if(t && t.value){
        state.followedTeamsList = JSON.parse(t.value);
        state.followedTeams = new Set(state.followedTeamsList.map(x => `${x.league}:${x.id}`));
      }
    }catch(e){}
  }
  async function saveWatched(){ try{ await storage.set('soccer:watchlist:games', JSON.stringify(Array.from(state.watchedKeys))); }catch(e){} }
  async function saveSeen(){ try{ await storage.set('soccer:seen:games', JSON.stringify(Array.from(state.seenGames))); }catch(e){} }
  async function saveFollowed(){ try{ await storage.set('soccer:follow:teams', JSON.stringify(state.followedTeamsList)); }catch(e){} }

  function toggleWatch(league, gameId){
    const key = `${league}:${gameId}`;
    if(state.watchedKeys.has(key)) state.watchedKeys.delete(key); else state.watchedKeys.add(key);
    saveWatched();
    patchRow(league, gameId);
  }
  function toggleSeen(league, gameId){
    const key = `${league}:${gameId}`;
    if(state.seenGames.has(key)) state.seenGames.delete(key); else state.seenGames.add(key);
    saveSeen();
    patchRow(league, gameId);
  }
  function toggleFollow(league, teamId, teamName){
    const key = `${league}:${teamId}`;
    if(state.followedTeams.has(key)){
      state.followedTeams.delete(key);
      state.followedTeamsList = state.followedTeamsList.filter(x => `${x.league}:${x.id}` !== key);
    }else{
      state.followedTeams.add(key);
      state.followedTeamsList.push({ league, id: teamId, name: teamName });
    }
    saveFollowed();
    renderFollowChips();
    for(const [k, entry] of state.renderedGames){
      if(!k.startsWith(league+':')) continue;
      if((entry.game.away && entry.game.away.id === teamId) || (entry.game.home && entry.game.home.id === teamId)){
        patchRow(league, entry.game.id);
      }
    }
  }
  function toggleReveal(league, gameId){
    const key = `${league}:${gameId}`;
    if(state.revealedRows.has(key)) state.revealedRows.delete(key); else state.revealedRows.add(key);
    patchRow(league, gameId);
  }
  function toggleTeamReveal(league, gameId, side){
    const key = `${league}:${gameId}:${side}`;
    if(state.revealedTeamInfo.has(key)) state.revealedTeamInfo.delete(key); else state.revealedTeamInfo.add(key);
    patchRow(league, gameId);
  }

  // W-D-L + points, tallied from completed matchdays strictly before `uptoIndex` (0-based).
  function recordsEntering(season, uptoIndex){
    const map = new Map();
    for(let i=0; i<uptoIndex; i++){
      (season.matchdays[i] || []).forEach(g => {
        if(!g.completed || !g.home || !g.away) return;
        const tie = !g.home.winner && !g.away.winner;
        [g.home, g.away].forEach(team => {
          if(!team?.id) return;
          const rec = map.get(team.id) || { w:0, d:0, l:0 };
          if(tie) rec.d++; else if(team.winner) rec.w++; else rec.l++;
          map.set(team.id, rec);
        });
      });
    }
    return map;
  }
  function fmtRecord(rec){
    if(!rec) return null;
    return `${rec.w}-${rec.d}-${rec.l} · ${rec.w*3+rec.d}pts`;
  }

  const MAJOR_NETS = ['NBC','Peacock','ESPN','FOX','FS1','Paramount+','CBS','USA','TNT','beIN'];

  function isCloseFinish(g){
    if(!g.completed || g.away?.score == null || g.home?.score == null) return false;
    return Math.abs(g.away.score - g.home.score) <= 1;
  }
  function isUpset(g, recAway, recHome){
    if(!g.completed || !recAway || !recHome) return false;
    const ptsA = recAway.w*3 + recAway.d, ptsH = recHome.w*3 + recHome.d;
    if(ptsH > ptsA + 6 && g.away?.winner) return true;
    if(ptsA > ptsH + 6 && g.home?.winner) return true;
    return false;
  }

  // No spread/moneyline data used yet (ESPN's soccer odds shape isn't confirmed) — this is a lighter
  // formula than the CFB/NFL one: broadcast slot, how close the two teams are in the table, and a
  // retroactive bump for a tight final score or a result against the run of form.
  function starScore(g, recAway, recHome, followed){
    if(followed) return 3;
    let s = 0;
    if(g.network && MAJOR_NETS.some(n => g.network.includes(n))) s++;
    if(recAway && recHome){
      const ptsA = recAway.w*3+recAway.d, ptsH = recHome.w*3+recHome.d;
      if(Math.abs(ptsA-ptsH) <= 6) s++;
    }
    if(g.completed && (isCloseFinish(g) || isUpset(g, recAway, recHome))) s += 2;
    return Math.max(0, Math.min(s, 3));
  }

  function escapeHTML(s){
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function dayKey(iso){
    return new Date(iso).toLocaleDateString(undefined, { weekday:'long', month:'short', day:'numeric' });
  }
  function timeStr(iso){
    return new Date(iso).toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit', timeZoneName:'short' });
  }
  function shortDate(iso){
    return new Date(iso).toLocaleDateString(undefined, { weekday:'short', month:'numeric', day:'numeric' });
  }

  // The whole season is fetched once and cached indefinitely (see fetchSeason), so a match's
  // `state`/`completed` fields reflect whatever the scoreboard looked like at that one fetch — they
  // go stale fast (e.g. a season fetched before kickoff stays frozen on "pre" for the rest of the
  // season). `completed` is trustworthy once true (a finished match never becomes unfinished), but
  // for everything else we reason from the kickoff clock instead of trusting a possibly-stale flag.
  const TYPICAL_DURATION_MS = 2.25 * 60 * 60 * 1000; // 90min + stoppage + halftime, with a buffer

  function statusPhase(g, nowMs){
    if(g.completed) return 'final';
    const kickoff = new Date(g.date).getTime();
    if(nowMs < kickoff) return 'upcoming';
    return (nowMs - kickoff) < TYPICAL_DURATION_MS ? 'live' : 'replay';
  }

  function buildRowHTML(league, g, recAway, recHome, rowIndex, opts={}){
    const followedGame = (g.away && isFollowed(league, g.away.id)) || (g.home && isFollowed(league, g.home.id));
    const stars = starScore(g, recAway, recHome, followedGame);
    const close = isCloseFinish(g);
    const watched = isWatched(league, g.id);
    const seen = isSeen(league, g.id);
    const revealed = state.revealedRows.has(`${league}:${g.id}`);

    const phase = statusPhase(g, Date.now());
    const statusLine = phase === 'final' ? `<span class="status-final">FINAL</span>`
      : phase === 'live' ? `<span class="status-live">LIVE</span>`
      : phase === 'replay' ? `<span class="status-replay">REPLAY</span>`
      : timeStr(g.date);
    const dateMini = opts.showDate ? `<div class="date-mini">${shortDate(g.date)}</div>` : '';

    const teamLine = (team, side) => {
      if(!team) return '';
      const teamRevealed = state.revealedTeamInfo.has(`${league}:${g.id}:${side}`);
      const rec = side === 'away' ? recAway : recHome;
      const recChip = teamRevealed ? fmtRecord(rec) : null;
      const followed = isFollowed(league, team.id);
      return `<div class="team-line">
        <button class="follow-btn ${followed?'on':''}" data-league="${league}" data-id="${team.id}" data-name="${escapeHTML(team.name)}" title="${followed?'Unfollow':'Follow'} ${escapeHTML(team.name)}">${followed?'♥':'♡'}</button>
        <button class="team-reveal-btn ${teamRevealed?'on':''}" data-league="${league}" data-id="${g.id}" data-side="${side}" title="${teamRevealed?'Hide record':'Show record'}">${teamRevealed?'🙈':'👁'}</button>
        <span class="team-name ${(teamRevealed && team.winner) ? 'winner':''}">${escapeHTML(team.name)}</span>
        ${recChip ? `<span class="rec">${recChip}</span>` : ''}
      </div>`;
    };

    const animAttrs = rowIndex == null ? ` static` : ``;
    const animStyle = rowIndex == null ? '' : ` style="animation-delay:${Math.min(rowIndex*45,400)}ms"`;

    return `<div class="row ${followedGame?'followed':''} ${seen?'seen':''}${animAttrs}" data-league="${league}" data-game-id="${g.id}"${animStyle}>
      <div class="time">${dateMini}${statusLine}</div>
      <div class="matchup">
        ${teamLine(g.away, 'away')}
        <div class="at">v</div>
        ${teamLine(g.home, 'home')}
        <div class="venue-net">
          ${g.network ? `<span class="net">${escapeHTML(g.network)}</span>` : ''}
          ${g.venue ? `<span>${escapeHTML(g.venue)}</span>` : ''}
        </div>
      </div>
      <div class="flags">
        <div class="icon-row">
          <button class="seen-btn ${seen?'on':''}" data-league="${league}" data-id="${g.id}" title="${seen?'Mark as not watched':'Mark as watched'}">${seen?'☑':'☐'}</button>
          <button class="bookmark-btn ${watched?'on':''}" data-league="${league}" data-id="${g.id}" title="${watched?'Remove from watchlist':'Add to watchlist'}">${watched?'🔖':'📑'}</button>
        </div>
        ${(followedGame||stars>=2||close) ? `<button class="reveal-btn ${revealed?'on':''}" data-league="${league}" data-id="${g.id}" title="${revealed?'Hide watchability reasons':'Show rating reasons'}">${revealed?'🙈':'👁'}</button>` : ''}
        ${stars>0 ? `<span class="stars">${'★'.repeat(stars)}${'☆'.repeat(3-stars)}</span>` : ''}
        ${revealed ? `
          ${followedGame ? `<span class="badge following">♥ following</span>` : ''}
          ${stars>=2 && !followedGame ? `<span class="badge marquee">Marquee</span>` : ''}
          ${close ? `<span class="badge nailbiter">🔥 Tight finish</span>` : ''}
        ` : ''}
      </div>
    </div>`;
  }

  function patchRow(league, gameId){
    const entry = state.renderedGames.get(`${league}:${gameId}`);
    const rowEl = board.querySelector(`.row[data-league="${league}"][data-game-id="${gameId}"]`);
    if(!entry || !rowEl) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = buildRowHTML(league, entry.game, entry.recAway, entry.recHome, null, { showDate: entry.showDate });
    rowEl.replaceWith(wrap.firstElementChild);
  }

  function renderFollowChips(){
    if(!followListEl) return;
    if(!state.followedTeamsList.length){ followListEl.innerHTML = ''; return; }
    followListEl.innerHTML = state.followedTeamsList.map(t =>
      `<span class="chip">${escapeHTML(t.name)}<button class="chip-x" data-league="${t.league}" data-id="${t.id}" data-name="${escapeHTML(t.name)}" title="Unfollow">×</button></span>`
    ).join('');
  }

  async function render(){
    const league = state.league;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.league === league));

    board.innerHTML = `<div class="loading"><span class="flicker">LOADING MATCHDAY…</span></div>`;

    let season;
    try{
      season = await fetchSeason(league);
    }catch(e){
      board.innerHTML = `<div class="err">Couldn't reach ESPN's scoreboard from here (likely a network/CORS block).<br>
        Try again in a moment, or check <a href="https://www.espn.com/soccer/schedule/_/league/${league}" target="_blank" rel="noopener">espn.com/soccer</a> directly.</div>`;
      return;
    }

    if(!season.matchdays.length){
      board.innerHTML = `<div class="empty">No fixtures found for this league right now.</div>`;
      return;
    }

    const curIdx = currentMatchdayIndex(season);
    let idx = curIdx + state.mdOffset;
    idx = Math.max(0, Math.min(idx, season.matchdays.length - 1));
    // clamp mdOffset itself too, so repeatedly hitting an edge doesn't drift the offset further
    state.mdOffset = idx - curIdx;

    mdLabel.innerHTML = `MATCHDAY ${idx+1}<span class="yr">${season.seasonYear}–${String(season.seasonYear+1).slice(2)}</span>`;
    prevBtn.disabled = idx <= 0;
    nextBtn.disabled = idx >= season.matchdays.length - 1;

    const games = season.matchdays[idx];
    const records = recordsEntering(season, idx);

    state.renderedGames.clear();
    let html = '';

    if(state.sortMode === 'watchability'){
      const scored = games.map(g => {
        const recAway = g.away ? records.get(g.away.id) : null;
        const recHome = g.home ? records.get(g.home.id) : null;
        const followedGame = (g.away && isFollowed(league, g.away.id)) || (g.home && isFollowed(league, g.home.id));
        return { g, recAway, recHome, stars: starScore(g, recAway, recHome, followedGame) };
      });
      scored.sort((a,b) => b.stars - a.stars || new Date(a.g.date) - new Date(b.g.date));
      scored.forEach((item, i) => {
        state.renderedGames.set(`${league}:${item.g.id}`, { game:item.g, recAway:item.recAway, recHome:item.recHome, showDate:true });
        html += buildRowHTML(league, item.g, item.recAway, item.recHome, i, { showDate:true });
      });
    }else{
      const groups = new Map();
      games.slice().sort((a,b) => new Date(a.date) - new Date(b.date)).forEach(g => {
        const k = dayKey(g.date);
        if(!groups.has(k)) groups.set(k, []);
        groups.get(k).push(g);
      });
      let rowIndex = 0;
      groups.forEach((rows, day) => {
        html += `<div class="day-group"><div class="day-label">${day}</div>`;
        rows.forEach(g => {
          const recAway = g.away ? records.get(g.away.id) : null;
          const recHome = g.home ? records.get(g.home.id) : null;
          state.renderedGames.set(`${league}:${g.id}`, { game:g, recAway, recHome, showDate:false });
          html += buildRowHTML(league, g, recAway, recHome, rowIndex);
          rowIndex++;
        });
        html += `</div>`;
      });
    }

    board.innerHTML = html;
    renderFollowChips();
  }

  let navigating = false;
  async function step(delta){
    if(navigating) return;
    navigating = true;
    prevBtn.disabled = true; nextBtn.disabled = true;
    try{
      state.mdOffset += delta;
      await render();
    } finally {
      navigating = false;
    }
  }

  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => {
      state.league = t.dataset.league;
      state.mdOffset = 0;
      render();
    });
  });
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
    if(state.mdOffset === 0) return;
    state.mdOffset = 0;
    render();
  });

  document.addEventListener('click', (e) => {
    const sbtn = e.target.closest('.seen-btn');
    if(sbtn){ toggleSeen(sbtn.dataset.league, sbtn.dataset.id); return; }
    const rbtn = e.target.closest('.reveal-btn');
    if(rbtn){ toggleReveal(rbtn.dataset.league, rbtn.dataset.id); return; }
    const trbtn = e.target.closest('.team-reveal-btn');
    if(trbtn){ toggleTeamReveal(trbtn.dataset.league, trbtn.dataset.id, trbtn.dataset.side); return; }
    const wbtn = e.target.closest('.bookmark-btn');
    if(wbtn){ toggleWatch(wbtn.dataset.league, wbtn.dataset.id); return; }
    const fbtn = e.target.closest('.follow-btn, .chip-x');
    if(fbtn){ toggleFollow(fbtn.dataset.league, fbtn.dataset.id, fbtn.dataset.name); return; }
  });

  (async function init(){
    await loadUserData();
    render();
  })();
})();
