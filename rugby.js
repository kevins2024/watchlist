(function(){
  // Same real per-browser/device localStorage shim used on the other boards, kept as its own copy
  // here so this file has no dependency on app.js/soccer.js/intl-soccer.js — deliberately self-contained.
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

  // ESPN's rugby league ids for the national-team competitions (as opposed to the club competitions —
  // Top 14, URC, Gallagher Prem, Super Rugby, etc. — which live under other ids and aren't included here).
  const COMPETITIONS = {
    '180659': { label: 'Six Nations' },
    '244293': { label: 'Rugby Championship' },
    '17567':  { label: 'Nations Championship' },
    '289234': { label: 'Test Matches' },
    '164205': { label: 'World Cup' },
    '268565': { label: 'British & Irish Lions' }
  };

  // Everything except the catch-all "Test Matches" bucket (which mixes tier-1 nations with minor
  // ones) is a marquee fixture by default — a small prestige bump in the watchability score.
  const PRESTIGE = new Set(['180659', '244293', '17567', '164205', '268565']);

  const state = {
    comp: window.APP_COMP || '180659',
    windowOffset: 0,          // Test-window index offset from "current", independent per competition
    sortMode: 'time',
    watchedKeys: new Set(),      // "comp:gameId"
    seenGames: new Set(),
    followedTeams: new Set(),    // "comp:teamId"
    followedTeamsList: [],
    revealedRows: new Set(),         // badge reveal, not persisted — same reasoning as the other boards
    revealedTeamInfo: new Set(),     // record reveal, not persisted
    renderedGames: new Map(),
    competitions: {}    // comp -> { windows: [[games...], ...] }, in-memory only for this page view
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

  function parseEvent(ev){
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

  // International rugby windows (a Six Nations round, an autumn Test series, a Rugby Championship
  // round) cluster the same way the soccer boards' matchdays/windows do: sort by kickoff, start a new
  // group whenever the gap since the previous game passes ~4 days. Rugby rounds are typically a single
  // weekend (Fri–Sun, occasionally with a Saturday-to-Saturday full week between rounds), so a slightly
  // wider gap than the soccer boards' 3 days avoids splitting a Friday-night-plus-weekend round in two.
  function clusterWindows(events){
    const sorted = events.slice().sort((a,b) => new Date(a.date) - new Date(b.date));
    const GAP_MS = 4 * 24 * 60 * 60 * 1000;
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

  // Same reasoning as the international-soccer board: these competitions run in scattered windows
  // across the calendar (some, like the World Cup, only once every 4 years) rather than one continuous
  // season, so this pulls a few calendar years around today and merges them, deduping by event id.
  // Deliberately NOT persisted to localStorage — an indefinite cache would go stale the same way the
  // CFB week-0/week-1 split once did, since next year's slate keeps filling in over time. The
  // in-memory `state.competitions` cache below still avoids re-fetching while paging within one visit.
  async function fetchCompetition(comp){
    if(state.competitions[comp]) return state.competitions[comp];
    const nowYear = new Date().getFullYear();
    const years = [nowYear - 1, nowYear, nowYear + 1];
    const byId = new Map();
    for(const y of years){
      try{
        const url = `https://site.api.espn.com/apis/site/v2/sports/rugby/${comp}/scoreboard?dates=${y}&limit=1000`;
        const raw = await fetchJSON(url);
        (raw.events || []).forEach(ev => { if(!byId.has(ev.id)) byId.set(ev.id, parseEvent(ev)); });
      }catch(e){ /* that year's fetch failed — whatever other years succeeded still show */ }
    }
    const games = Array.from(byId.values());
    const windows = clusterWindows(games);
    const result = { windows };
    state.competitions[comp] = result;
    return result;
  }

  // Index (0-based) of the window containing "now," or the next one if we're between windows.
  function currentWindowIndex(comp){
    const now = Date.now();
    const windows = comp.windows;
    for(let i=0; i<windows.length; i++){
      const last = new Date(windows[i][windows[i].length-1].date).getTime();
      if(last >= now) return i;
    }
    return Math.max(0, windows.length - 1);
  }

  function isWatched(comp, gameId){ return state.watchedKeys.has(`${comp}:${gameId}`); }
  function isSeen(comp, gameId){ return state.seenGames.has(`${comp}:${gameId}`); }
  function isFollowed(comp, teamId){ return state.followedTeams.has(`${comp}:${teamId}`); }

  async function loadUserData(){
    try{
      const w = await storage.get('rugby:watchlist:games');
      if(w && w.value) state.watchedKeys = new Set(JSON.parse(w.value));
    }catch(e){}
    try{
      const s = await storage.get('rugby:seen:games');
      if(s && s.value) state.seenGames = new Set(JSON.parse(s.value));
    }catch(e){}
    try{
      const t = await storage.get('rugby:follow:teams');
      if(t && t.value){
        state.followedTeamsList = JSON.parse(t.value);
        state.followedTeams = new Set(state.followedTeamsList.map(x => `${x.comp}:${x.id}`));
      }
    }catch(e){}
  }
  async function saveWatched(){ try{ await storage.set('rugby:watchlist:games', JSON.stringify(Array.from(state.watchedKeys))); }catch(e){} }
  async function saveSeen(){ try{ await storage.set('rugby:seen:games', JSON.stringify(Array.from(state.seenGames))); }catch(e){} }
  async function saveFollowed(){ try{ await storage.set('rugby:follow:teams', JSON.stringify(state.followedTeamsList)); }catch(e){} }

  function toggleWatch(comp, gameId){
    const key = `${comp}:${gameId}`;
    if(state.watchedKeys.has(key)) state.watchedKeys.delete(key); else state.watchedKeys.add(key);
    saveWatched();
    patchRow(comp, gameId);
  }
  function toggleSeen(comp, gameId){
    const key = `${comp}:${gameId}`;
    if(state.seenGames.has(key)) state.seenGames.delete(key); else state.seenGames.add(key);
    saveSeen();
    patchRow(comp, gameId);
  }
  function toggleFollow(comp, teamId, teamName){
    const key = `${comp}:${teamId}`;
    if(state.followedTeams.has(key)){
      state.followedTeams.delete(key);
      state.followedTeamsList = state.followedTeamsList.filter(x => `${x.comp}:${x.id}` !== key);
    }else{
      state.followedTeams.add(key);
      state.followedTeamsList.push({ comp, id: teamId, name: teamName });
    }
    saveFollowed();
    renderFollowChips();
    for(const [k, entry] of state.renderedGames){
      if(!k.startsWith(comp+':')) continue;
      if((entry.game.away && entry.game.away.id === teamId) || (entry.game.home && entry.game.home.id === teamId)){
        patchRow(comp, entry.game.id);
      }
    }
  }
  function toggleReveal(comp, gameId){
    const key = `${comp}:${gameId}`;
    if(state.revealedRows.has(key)) state.revealedRows.delete(key); else state.revealedRows.add(key);
    patchRow(comp, gameId);
  }
  function toggleTeamReveal(comp, gameId, side){
    const key = `${comp}:${gameId}:${side}`;
    if(state.revealedTeamInfo.has(key)) state.revealedTeamInfo.delete(key); else state.revealedTeamInfo.add(key);
    patchRow(comp, gameId);
  }

  // Plain W-D-L, tallied from completed windows strictly before `uptoIndex` (0-based), within this
  // competition only. Deliberately not converted to a points table — bonus-point scoring differs by
  // competition (Six Nations, Rugby Championship, and Nations Championship each weight it differently)
  // and getting that wrong would be worse than just showing the plain record.
  function recordsEntering(compData, uptoIndex){
    const map = new Map();
    for(let i=0; i<uptoIndex; i++){
      (compData.windows[i] || []).forEach(g => {
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
    return rec.d ? `${rec.w}-${rec.l}-${rec.d}` : `${rec.w}-${rec.l}`;
  }

  const MAJOR_NETS = ['ABC','ESPN','ESPN2','NBC','Peacock','Sky Sports','ITV','TNT Sports'];

  // A converted try is 7 — within one score of that is a genuinely open finish, not just a low-scoring
  // but comfortable win (rugby's final margins run much higher than soccer's).
  function isCloseFinish(g){
    if(!g.completed || g.away?.score == null || g.home?.score == null) return false;
    return Math.abs(g.away.score - g.home.score) <= 7;
  }
  function isUpset(g, recAway, recHome){
    if(!g.completed || !recAway || !recHome) return false;
    const diffAway = recAway.w - recAway.l, diffHome = recHome.w - recHome.l;
    if(diffHome > diffAway + 2 && g.away?.winner) return true;
    if(diffAway > diffHome + 2 && g.home?.winner) return true;
    return false;
  }

  // No standings/odds data reliably available, so this stays a light formula: broadcast slot,
  // competition prestige, how close the two teams' records are so far, and a retroactive bump for a
  // tight final score or an upset.
  function starScore(comp, g, recAway, recHome, followed){
    if(followed) return 3;
    let s = 0;
    if(PRESTIGE.has(comp)) s++;
    if(g.network && MAJOR_NETS.some(n => g.network.includes(n))) s++;
    if(recAway && recHome){
      const diffAway = recAway.w - recAway.l, diffHome = recHome.w - recHome.l;
      if(Math.abs(diffAway - diffHome) <= 2) s++;
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

  // This board fetches fresh every page load (see fetchCompetition) rather than caching the schedule
  // forever, so there's no stale "state" field to worry about — but the clock-based fallback still
  // matters for the common case of a completed game whose `completed` flag genuinely hasn't flipped
  // yet moments after full time.
  const TYPICAL_DURATION_MS = 2.25 * 60 * 60 * 1000; // 80 min + a break + a buffer for stoppage/extra time

  function statusPhase(g, nowMs){
    if(g.completed) return 'final';
    const kickoff = new Date(g.date).getTime();
    if(nowMs < kickoff) return 'upcoming';
    return (nowMs - kickoff) < TYPICAL_DURATION_MS ? 'live' : 'replay';
  }

  function buildRowHTML(comp, g, recAway, recHome, rowIndex, opts={}){
    const followedGame = (g.away && isFollowed(comp, g.away.id)) || (g.home && isFollowed(comp, g.home.id));
    const stars = starScore(comp, g, recAway, recHome, followedGame);
    const close = isCloseFinish(g);
    const watched = isWatched(comp, g.id);
    const seen = isSeen(comp, g.id);
    const revealed = state.revealedRows.has(`${comp}:${g.id}`);

    const phase = statusPhase(g, Date.now());
    const statusLine = phase === 'final' ? `<span class="status-final">FINAL</span>`
      : phase === 'live' ? `<span class="status-live">LIVE</span>`
      : phase === 'replay' ? `<span class="status-replay">REPLAY</span>`
      : timeStr(g.date);
    const dateMini = opts.showDate ? `<div class="date-mini">${shortDate(g.date)}</div>` : '';

    const teamLine = (team, side) => {
      if(!team) return '';
      const teamRevealed = state.revealedTeamInfo.has(`${comp}:${g.id}:${side}`);
      const rec = side === 'away' ? recAway : recHome;
      const recChip = teamRevealed ? fmtRecord(rec) : null;
      const followed = isFollowed(comp, team.id);
      return `<div class="team-line">
        <button class="follow-btn ${followed?'on':''}" data-comp="${comp}" data-id="${team.id}" data-name="${escapeHTML(team.name)}" title="${followed?'Unfollow':'Follow'} ${escapeHTML(team.name)}">${followed?'♥':'♡'}</button>
        <button class="team-reveal-btn ${teamRevealed?'on':''}" data-comp="${comp}" data-id="${g.id}" data-side="${side}" title="${teamRevealed?'Hide record':'Show record'}">${teamRevealed?'🙈':'👁'}</button>
        <span class="team-name ${(teamRevealed && team.winner) ? 'winner':''}">${escapeHTML(team.name)}</span>
        ${recChip ? `<span class="rec">${recChip}</span>` : ''}
      </div>`;
    };

    const animAttrs = rowIndex == null ? ` static` : ``;
    const animStyle = rowIndex == null ? '' : ` style="animation-delay:${Math.min(rowIndex*45,400)}ms"`;

    return `<div class="row ${followedGame?'followed':''} ${seen?'seen':''}${animAttrs}" data-comp="${comp}" data-game-id="${g.id}"${animStyle}>
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
          <button class="seen-btn ${seen?'on':''}" data-comp="${comp}" data-id="${g.id}" title="${seen?'Mark as not watched':'Mark as watched'}">${seen?'☑':'☐'}</button>
          <button class="bookmark-btn ${watched?'on':''}" data-comp="${comp}" data-id="${g.id}" title="${watched?'Remove from watchlist':'Add to watchlist'}">${watched?'🔖':'📑'}</button>
        </div>
        ${(followedGame||stars>=2||close) ? `<button class="reveal-btn ${revealed?'on':''}" data-comp="${comp}" data-id="${g.id}" title="${revealed?'Hide watchability reasons':'Show rating reasons'}">${revealed?'🙈':'👁'}</button>` : ''}
        ${stars>0 ? `<span class="stars">${'★'.repeat(stars)}${'☆'.repeat(3-stars)}</span>` : ''}
        ${revealed ? `
          ${followedGame ? `<span class="badge following">♥ following</span>` : ''}
          ${stars>=2 && !followedGame ? `<span class="badge marquee">Marquee</span>` : ''}
          ${close ? `<span class="badge nailbiter">🔥 Tight finish</span>` : ''}
        ` : ''}
      </div>
    </div>`;
  }

  function patchRow(comp, gameId){
    const entry = state.renderedGames.get(`${comp}:${gameId}`);
    const rowEl = board.querySelector(`.row[data-comp="${comp}"][data-game-id="${gameId}"]`);
    if(!entry || !rowEl) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = buildRowHTML(comp, entry.game, entry.recAway, entry.recHome, null, { showDate: entry.showDate });
    rowEl.replaceWith(wrap.firstElementChild);
  }

  function renderFollowChips(){
    if(!followListEl) return;
    if(!state.followedTeamsList.length){ followListEl.innerHTML = ''; return; }
    followListEl.innerHTML = state.followedTeamsList.map(t =>
      `<span class="chip">${escapeHTML(t.name)}<button class="chip-x" data-comp="${t.comp}" data-id="${t.id}" data-name="${escapeHTML(t.name)}" title="Unfollow">×</button></span>`
    ).join('');
  }

  async function render(){
    const comp = state.comp;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.comp === comp));

    board.innerHTML = `<div class="loading"><span class="flicker">LOADING WINDOW…</span></div>`;

    let compData;
    try{
      compData = await fetchCompetition(comp);
    }catch(e){
      board.innerHTML = `<div class="err">Couldn't reach ESPN's scoreboard from here (likely a network/CORS block).<br>
        Try again in a moment, or check <a href="https://www.espn.com/rugby/fixtures" target="_blank" rel="noopener">espn.com/rugby</a> directly.</div>`;
      return;
    }

    if(!compData.windows.length){
      board.innerHTML = `<div class="empty">No fixtures found for this competition in the surrounding year or two — it may just not be active right now.</div>`;
      mdLabel.textContent = '—';
      return;
    }

    const curIdx = currentWindowIndex(compData);
    let idx = curIdx + state.windowOffset;
    idx = Math.max(0, Math.min(idx, compData.windows.length - 1));
    state.windowOffset = idx - curIdx;

    const games = compData.windows[idx];
    const windowLabel = shortDate(games[0].date) + (games.length>1 ? ' – ' + shortDate(games[games.length-1].date) : '');
    mdLabel.innerHTML = `WINDOW ${idx+1}<span class="yr">${windowLabel}</span>`;
    prevBtn.disabled = idx <= 0;
    nextBtn.disabled = idx >= compData.windows.length - 1;

    const records = recordsEntering(compData, idx);

    state.renderedGames.clear();
    let html = '';

    if(state.sortMode === 'watchability'){
      const scored = games.map(g => {
        const recAway = g.away ? records.get(g.away.id) : null;
        const recHome = g.home ? records.get(g.home.id) : null;
        const followedGame = (g.away && isFollowed(comp, g.away.id)) || (g.home && isFollowed(comp, g.home.id));
        return { g, recAway, recHome, stars: starScore(comp, g, recAway, recHome, followedGame) };
      });
      scored.sort((a,b) => b.stars - a.stars || new Date(a.g.date) - new Date(b.g.date));
      scored.forEach((item, i) => {
        state.renderedGames.set(`${comp}:${item.g.id}`, { game:item.g, recAway:item.recAway, recHome:item.recHome, showDate:true });
        html += buildRowHTML(comp, item.g, item.recAway, item.recHome, i, { showDate:true });
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
          state.renderedGames.set(`${comp}:${g.id}`, { game:g, recAway, recHome, showDate:false });
          html += buildRowHTML(comp, g, recAway, recHome, rowIndex);
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
      state.windowOffset += delta;
      await render();
    } finally {
      navigating = false;
    }
  }

  document.querySelectorAll('.tab[data-comp]').forEach(t => {
    t.addEventListener('click', () => {
      state.comp = t.dataset.comp;
      state.windowOffset = 0;
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
    if(state.windowOffset === 0) return;
    state.windowOffset = 0;
    render();
  });

  document.addEventListener('click', (e) => {
    const sbtn = e.target.closest('.seen-btn');
    if(sbtn){ toggleSeen(sbtn.dataset.comp, sbtn.dataset.id); return; }
    const rbtn = e.target.closest('.reveal-btn');
    if(rbtn){ toggleReveal(rbtn.dataset.comp, rbtn.dataset.id); return; }
    const trbtn = e.target.closest('.team-reveal-btn');
    if(trbtn){ toggleTeamReveal(trbtn.dataset.comp, trbtn.dataset.id, trbtn.dataset.side); return; }
    const wbtn = e.target.closest('.bookmark-btn');
    if(wbtn){ toggleWatch(wbtn.dataset.comp, wbtn.dataset.id); return; }
    const fbtn = e.target.closest('.follow-btn, .chip-x');
    if(fbtn){ toggleFollow(fbtn.dataset.comp, fbtn.dataset.id, fbtn.dataset.name); return; }
  });

  (async function init(){
    await loadUserData();
    render();
  })();
})();
