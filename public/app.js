// =====================================================
//  مافيا — واجهة اللاعب
// =====================================================
'use strict';

const $ = (s) => document.querySelector(s);
const main = $('#main');
const KEY = 'mafia_session';

let session = loadSession();
let state = null;
let es = null;
let offset = 0;            // فرق الساعة بين جهازك والسيرفر
let lastPhaseKey = '';
let lastChatId = 0;
let unread = 0;
let flipped = false;
let busy = false;
let lastBeat = Date.now();
let curTab = 'chat';
const cache = {};          // آخر HTML لكل جزء، عشان ما نرسم إشي ما تغيّر

// ---------------- أدوات ----------------
function loadSession() { try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; } }
function saveSession(s) { try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch (e) {} }
function deviceId() {
  try {
    let d = localStorage.getItem('mafia_device');
    if (!d) { d = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('mafia_device', d); }
    return d;
  } catch (e) { return ''; }
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initial = (n) => esc([...String(n).trim()][0] || '?');
function put(el, key, html) { if (cache[key] !== html) { el.innerHTML = html; cache[key] = html; } }

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}

async function api(action, data = {}, withSession = true) {
  const body = { action, ...data };
  if (withSession && session) Object.assign(body, { code: session.code, pid: session.pid, token: session.token });
  try {
    const r = await fetch('/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (j.error) toast(j.error);
    return j;
  } catch (e) {
    toast('ما في اتصال بالسيرفر، تأكد من النت');
    return { error: 'network' };
  }
}

const R = (id) => (state && state.roles[id]) || { name: '?', icon: '?', team: 'town', desc: '' };
const P = (id) => state.players.find((p) => p.id === id);
const teamName = { mafia: 'فريق المافيا', town: 'فريق المدينة', neutral: 'لحاله' };
const ORD = ['الأولى', 'الثانية', 'الثالثة', 'الرابعة', 'الخامسة', 'السادسة', 'السابعة', 'الثامنة', 'التاسعة', 'العاشرة'];
const DAYORD = ['الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس', 'السادس', 'السابع', 'الثامن', 'التاسع', 'العاشر'];
const ord = (n, list) => list[n - 1] || String(n);

// ---------------- الاتصال ----------------
function connect() {
  if (es) es.close();
  const q = new URLSearchParams({ code: session.code, pid: session.pid, token: session.token });
  es = new EventSource('/events?' + q);
  lastBeat = Date.now();
  es.onopen = () => { lastBeat = Date.now(); $('#conn').classList.add('hidden'); };
  es.onmessage = (e) => {
    lastBeat = Date.now();
    $('#conn').classList.add('hidden');
    state = JSON.parse(e.data);
    offset = state.now - Date.now();
    render();
    if (window.Voice) Voice.onState(state);
  };
  es.addEventListener('ping', () => { lastBeat = Date.now(); });
  es.addEventListener('signal', (e) => { if (window.Voice) Voice.onSignal(JSON.parse(e.data)); });
  es.addEventListener('kicked', () => leaveLocal('طلعت من الغرفة'));
  es.onerror = () => {
    $('#conn').classList.remove('hidden');
    if (es.readyState === 2) setTimeout(tryResume, 2500);
  };
}

async function tryResume() {
  if (!session) return;
  const r = await api('resume');
  if (r.ok || r.code) connect();
  else if (r.error !== 'network') leaveLocal();
  else setTimeout(tryResume, 3000);
}

function leaveLocal(msg) {
  if (es) es.close();
  es = null; session = null; state = null; lastPhaseKey = ''; lastChatId = 0;
  for (const k in cache) delete cache[k];
  saveSession(null);
  if (window.Voice) Voice.reset();
  $('#conn').classList.add('hidden');
  if (msg) toast(msg);
  renderHome();
}

// ---------------- الصفحة الرئيسية ----------------
function renderHome() {
  document.body.classList.remove('night');
  $('#stripInfo').innerHTML = '';
  $('#side').classList.add('hidden');
  $('#dock').classList.add('hidden');
  $('#sideToggle').classList.add('hidden');
  $('#shell').classList.add('solo');
  $('#clock').classList.add('hidden');
  for (const k in cache) delete cache[k];
  const urlCode = new URLSearchParams(location.search).get('room') || '';
  let savedName = '';
  try { savedName = localStorage.getItem('mafia_name') || ''; } catch (e) {}
  main.innerHTML = `
    <div class="home">
      <div class="hero">
        <div class="fan" aria-hidden="true">
          <div class="card"><span class="ini">؟</span></div>
          <div class="card face mafia"><span class="ini">🔪</span><span class="rname">مافيا</span></div>
          <div class="card"><span class="ini">؟</span></div>
        </div>
        <h1>مافيا</h1>
      </div>
      <p class="tagline">كل واحد من جواله، والأدوار بتتوزع بالسر. المافيا بيقتلوا بالليل، والمدينة بتكشفهم بالنهار.</p>
      <div class="form">
        <div>
          <label class="fl" for="nameIn">اسمك باللعبة</label>
          <input id="nameIn" maxlength="20" placeholder="مثلاً: أبو العبد" value="${esc(savedName)}">
        </div>
        <button class="btn red wide" data-act="create">اعمل غرفة جديدة</button>
        <div class="or">أو ادخل غرفة صاحبك</div>
        <div class="joinrow">
          <input id="codeIn" class="codein" maxlength="4" placeholder="الكود" value="${esc(urlCode)}" aria-label="كود الغرفة">
          <button class="btn line" data-act="join">ادخل</button>
        </div>
        <div style="text-align:center"><button class="link" data-act="rules">كيف بنلعب؟</button></div>
      </div>
    </div>`;
  if (urlCode) $('#nameIn').focus();
}

async function doCreateOrJoin(kind) {
  const name = $('#nameIn').value.trim();
  if (!name) return toast('اكتب اسمك أول');
  try { localStorage.setItem('mafia_name', name); } catch (e) {}
  const data = { name, device: deviceId() };
  if (kind === 'join') {
    data.code = $('#codeIn').value.trim().toUpperCase();
    if (data.code.length !== 4) return toast('الكود 4 حروف أو أرقام');
  }
  const r = await api(kind, data, false);
  if (r.error) return;
  session = { code: r.code, pid: r.pid, token: r.token };
  saveSession(session);
  history.replaceState(null, '', '?room=' + r.code);
  connect();
}

// ---------------- الستارة بين المراحل ----------------
function curtain(title, sub, red) {
  const c = $('#curtain');
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  $('#curtainTitle').textContent = title;
  $('#curtainSub').textContent = sub || '';
  c.classList.toggle('red', !!red);
  c.classList.add('show');
  clearTimeout(curtain._t);
  curtain._t = setTimeout(() => c.classList.remove('show'), 1500);
}
function phaseCurtain(s) {
  const me = s.me;
  switch (s.phase) {
    case 'reveal': return curtain('وُزّعت الأوراق', 'شوف دورك بالسر');
    case 'night': return curtain('حلّ الليل', 'الليلة ' + ord(s.day, ORD));
    case 'day': return curtain('طلع الصبح', 'اليوم ' + ord(s.day, DAYORD));
    case 'vote': return curtain('التصويت', 'مين لازم يطلع؟');
    case 'dusk': return curtain('المغرب', s.lastEvent && s.lastEvent.out ? `طلع ${s.lastEvent.out.name}` : 'ما حدا طلع');
    case 'ended': {
      const t = s.winner === 'town' ? 'فازت المدينة' : s.winner === 'mafia' ? 'فازت المافيا' : 'فاز المهرج';
      return curtain(t, iWon() ? 'مبروك، فزت' : 'خسرت هالمرة', s.winner !== 'town');
    }
    case 'lobby': return me ? null : null;
  }
}
function iWon() {
  const s = state;
  if (!s.winner) return false;
  if (s.winner === 'jester') return s.winnerId === s.me.id;
  return R(s.me.role).team === s.winner;
}

// ---------------- الرسم ----------------
function render() {
  if (!state) return;
  const s = state;
  const key = s.phase + ':' + s.day;
  if (key !== lastPhaseKey) {
    if (lastPhaseKey) {
      phaseCurtain(s);
      if (navigator.vibrate) { try { navigator.vibrate(120); } catch (e) {} }
    }
    if (s.phase === 'reveal') flipped = false;
    lastPhaseKey = key;
    window.scrollTo({ top: 0 });
  }
  document.body.classList.toggle('night', s.phase === 'night');
  $('#shell').classList.remove('solo');
  $('#side').classList.remove('hidden');
  $('#dock').classList.remove('hidden');
  $('#sideToggle').classList.remove('hidden');
  $('#clock').classList.remove('hidden');

  const views = { lobby: vLobby, reveal: vReveal, night: vNight, day: vDay, vote: vVote, dusk: vDusk, ended: vEnded };
  const v = (views[s.phase] || vLobby)();
  put(main, 'main', v.main);
  put($('#dock'), 'dock', v.dock || '');
  renderStrip();
  renderSide();
  tick();
}

function renderStrip() {
  const s = state;
  let h = `<span class="pill">غرفة <span class="code">${esc(s.code)}</span></span>`;
  if (s.deadline) h += `<span class="pill time" id="timePill">--</span>`;
  h += `<button class="pill mic hidden" id="micPill" data-vact="mute"></button>`;
  if (s.me.role) h += `<button class="pill role" data-act="myrole">ورقتي</button>`;
  put($('#stripInfo'), 'strip', h);
  if (window.Voice) Voice.paintMic();
}

// العدّاد بيتحدث كل ربع ثانية
function tick() {
  const pill = $('#timePill');
  const fill = $('#clockFill');
  const clock = $('#clock');
  if (!state || !state.deadline) { if (fill) fill.style.width = '0'; return; }
  const left = Math.max(0, state.deadline - (Date.now() + offset));
  const sec = Math.ceil(left / 1000);
  const urgent = sec <= 10;
  if (pill) {
    pill.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    pill.classList.toggle('urgent', urgent);
  }
  const total = (state.phaseTotal || 1) * 1000;
  fill.style.width = Math.min(100, (left / total) * 100) + '%';
  clock.classList.toggle('urgent', urgent);
}
setInterval(tick, 250);

// ---------------- الورقة ----------------
// ورقة اللاعب: مقلوبة (ظهر أحمر) أو مكشوفة (وجه فاتح مع الدور)
function card(p, o = {}) {
  const s = state;
  const r = p.role ? R(p.role) : null;
  const face = !!r && (p.id === s.me.id || !p.alive || s.phase === 'ended' || o.showRole);
  const cls = ['card', face ? 'face' : '', face && r.team === 'mafia' ? 'mafia' : '', p.alive || s.phase === 'lobby' ? '' : 'dead',
    p.id === s.me.id ? 'me' : '', p.online ? '' : 'off', o.sel ? 'sel' : ''].filter(Boolean).join(' ');
  const inner = `
    ${!face && r ? `<span class="corner" title="${esc(r.name)}">${r.icon}</span>` : ''}
    ${p.bot ? '<span class="mic" title="بوت">🤖</span>' : p.voice ? '<span class="mic" title="بالصوت">🎙️</span>' : ''}
    ${o.votes ? `<span class="votes">${o.votes}</span>` : ''}
    ${face ? `<span class="ini">${r.icon}</span><span class="rname">${esc(r.name)}</span>` : `<span class="ini">${p.alive || s.phase === 'lobby' ? initial(p.name) : '✝'}</span>`}
    ${o.who ? `<span class="who">${o.who}</span>` : ''}
    <span class="nm">${p.id === s.hostId ? '👑 ' : ''}${esc(p.name)}${p.id === s.me.id ? ' (أنت)' : ''}</span>`;
  if (o.act) {
    return `<button class="${cls}" data-act="${o.act}" data-id="${p.id}" ${o.disabled ? 'disabled' : ''} aria-pressed="${o.sel ? 'true' : 'false'}" aria-label="${esc(p.name)}">${inner}</button>`;
  }
  return `<div class="${cls}">${o.kick ? `<button class="kick" data-act="kick" data-id="${p.id}" aria-label="اطرد ${esc(p.name)}">✕</button>` : ''}${inner}</div>`;
}
const tableOf = (list, fn) => `<div class="table">${list.map(fn).join('')}</div>`;

// ---------------- اللوبي ----------------
function vLobby() {
  const s = state;
  const n = s.players.length;
  const isHost = s.me.isHost;
  const st = s.settings;
  const bots = s.players.filter((p) => p.bot).length;
  const counts = {};
  (s.rolePreview || []).forEach((r) => (counts[r] = (counts[r] || 0) + 1));
  const order = ['godfather', 'mafia', 'doctor', 'detective', 'sniper', 'mayor', 'jester', 'citizen'];
  const lineup = s.rolePreview
    ? `<div class="lineup">${order.filter((r) => counts[r]).map((r) => `<span class="lu ${R(r).team === 'mafia' ? 'mafia' : ''}">${R(r).icon} ${esc(R(r).name)} <span class="n">${counts[r]}</span></span>`).join('')}</div>`
    : `<p class="muted" style="color:var(--ash)">بدكم ${s.minPlayers} لاعبين على الأقل. ضايل ${s.minPlayers - n}.</p>`;
  const pc = s.pace[st.pace];
  const paceHint = `الليل ${pc.night} ث • النقاش ${Math.round(pc.day / 60 * 10) / 10} د • التصويت ${pc.vote} ث`;

  const settings = isHost ? `
    <div class="section"><h2>الإعدادات</h2>
      <div class="settings">
        <div class="row"><div><div class="lbl">سرعة اللعب</div><div class="hint">${paceHint}</div></div>
          <div class="seg">${[['fast', 'سريعة'], ['normal', 'عادية'], ['slow', 'هادية']].map(([k, t]) => `<button class="${st.pace === k ? 'on' : ''}" data-act="pace" data-v="${k}">${t}</button>`).join('')}</div></div>
        <div class="row"><div><div class="lbl">الأدوار الجانبية</div><div class="hint">${st.sideMode === 'auto' ? 'بتدخل لحالها كل ما زاد عددكم' : 'إنت بتختار أي دور يدخل'}</div></div>
          <div class="seg"><button class="${st.sideMode === 'auto' ? 'on' : ''}" data-act="mode" data-v="auto">تلقائي</button><button class="${st.sideMode === 'custom' ? 'on' : ''}" data-act="mode" data-v="custom">يدوي</button></div></div>
        ${st.sideMode === 'custom' ? s.sideRoles.map((r) => `<button class="toggle" data-act="side" data-v="${r}"><span>${R(r).icon} ${esc(R(r).name)}</span><span class="switch ${st.side[r] ? 'on' : ''}"></span></button>`).join('') : ''}
        <button class="toggle" data-act="reveal"><span><span class="lbl">اكشف دور اللي بيموت</span></span><span class="switch ${st.revealOnDeath ? 'on' : ''}"></span></button>
      </div>
    </div>` : `<div class="section"><p style="color:var(--ash)">السرعة: ${({ fast: 'سريعة', normal: 'عادية', slow: 'هادية' })[st.pace]} (${paceHint}). المضيف بيختار الإعدادات.</p></div>`;

  return {
    main: `
      <div class="lobby-head">
        <div><div class="sub">كود الغرفة، ابعته لصحابك</div><div class="big-code">${esc(s.code)}</div></div>
        <button class="btn line sm" data-act="copy">انسخ رابط الدعوة</button>
      </div>
      ${tableOf(s.players, (p) => card(p, { kick: isHost && p.id !== s.me.id }))}
      ${isHost ? `<div class="botrow">
        <button class="btn line sm" data-act="addBot" ${n >= s.maxPlayers ? 'disabled' : ''}>🤖 أضف بوت</button>
        ${bots ? `<button class="btn line sm" data-act="removeBots">شيل البوتات (${bots})</button>` : ''}
        <span class="hint">عددكم ناقص؟ ضيف بوتات. بيلعبوا لحالهم: بيختاروا بالليل وبيصوّتوا بالنهار.</span>
      </div>` : bots ? `<p class="hint" style="margin-top:12px">🤖 في ${bots} ${bots === 1 ? 'بوت' : 'بوتات'} بالغرفة، بيلعبوا لحالهم.</p>` : ''}
      <div class="section"><h2>الأوراق بهالجولة${s.rolePreview ? ` (${n} لاعبين)` : ''}</h2>${lineup}</div>
      ${settings}`,
    dock: isHost
      ? `<button class="btn red" data-act="start" ${n < s.minPlayers ? 'disabled' : ''}>وزّع الأوراق وابدأ</button><button class="btn line" data-act="leave">اطلع</button>`
      : `<span class="msg">بانتظار المضيف يبدأ اللعبة</span><button class="btn line" data-act="leave">اطلع</button>`,
  };
}

// ---------------- كشف الدور ----------------
function vReveal() {
  const s = state;
  const r = R(s.me.role);
  const mates = s.players.filter((p) => p.id !== s.me.id && p.role && R(p.role).team === 'mafia');
  const ready = s.players.filter((p) => p.ready).length;
  const meReady = P(s.me.id)?.ready;
  return {
    main: `
      <div class="stage"><h1>دورك</h1><p>اقلب الورقة. ما حدا غيرك بيشوفها.</p></div>
      <div class="reveal">
        <button class="flip ${flipped ? 'open' : ''}" data-act="flip" aria-label="اقلب ورقتك">
          <div class="side-a"><div class="card"><span class="ini">؟</span><span class="tap">اضغط لتقلبها</span></div></div>
          <div class="side-b ${r.team}">
            <div class="big">${r.icon}</div>
            <div class="rn">${esc(r.name)}</div>
            <div class="tm ${r.team}">${teamName[r.team]}</div>
            <div class="ds">${esc(r.desc)}</div>
            ${r.team === 'mafia' ? `<div class="mates">${mates.length ? 'شركاؤك: ' + mates.map((m) => esc(m.name)).join('، ') : 'إنت المافيا الوحيد'}</div>` : ''}
          </div>
        </button>
      </div>`,
    dock: meReady
      ? `<span class="msg">جاهز. بانتظار الباقي <b>${ready}/${s.players.length}</b></span>`
      : `<button class="btn red" data-act="ready" ${flipped ? '' : 'disabled'}>شفت دوري، جاهز</button><span class="msg">${ready}/${s.players.length} جاهزين</span>`,
  };
}

// ---------------- الليل ----------------
function vNight() {
  const s = state;
  const me = s.me;
  const r = R(me.role);
  const mv = (s.night && s.night.mafiaVotes) || [];
  let main = `<div class="stage"><h1>الليلة ${ord(s.day, ORD)}</h1>`;
  let dock = '';

  if (!me.alive) {
    const ch = (s.night && s.night.choices) || {};
    main += `<p>إنت ميت. بتتفرج على اللي بيصير بالسر، وممنوع تحكي للعايشين.</p></div>`;
    main += tableOf(s.players, (p) => {
      const t = ch[p.id];
      return card(p, { who: p.alive && t ? `← ${t === 'skip' ? 'ما أطلق' : esc(P(t)?.name)}` : '' });
    });
    dock = `<span class="msg">إنت بتتفرج</span>`;
  } else if (!s.night.canAct) {
    main += `<p>نام. ما عندك شي تعمله الليلة، والصبح بيطلع لحاله لما يخلص الوقت.</p></div>`;
    main += tableOf(s.players, (p) => card(p, { showRole: R(me.role).team === 'mafia' && p.role && R(p.role).team === 'mafia' }));
    dock = `<span class="msg">نايم... 😴</span>`;
  } else {
    const my = s.night.myChoice;
    let prompt, ok;
    if (r.team === 'mafia') { prompt = 'اختاروا مين تقتلوا الليلة. إذا اختلفتوا، بيطلع اللي عليه أكثر أصوات.'; ok = (p) => p.alive && !(p.role && R(p.role).team === 'mafia'); }
    else if (me.role === 'doctor') { prompt = s.doctorSelfUsed ? 'اختار مين تحمي الليلة. حميت حالك قبل، فما بتقدر مرة ثانية.' : 'اختار مين تحمي الليلة. بتقدر تحمي حالك مرة وحدة باللعبة.'; ok = (p) => p.alive && !(p.id === me.id && s.doctorSelfUsed); }
    else if (me.role === 'detective') { prompt = 'اختار مين تفحص. النتيجة بتوصلك لحالك الصبح.'; ok = (p) => p.alive && p.id !== me.id; }
    else { prompt = 'معك رصاصة وحدة باللعبة كلها. بدك تطلقها الليلة؟'; ok = (p) => p.alive && p.id !== me.id; }
    main += `<p>${prompt}</p></div>`;
    main += tableOf(s.players, (p) => {
      const picks = r.team === 'mafia' ? mv.filter((m) => m.target === p.id).map((m) => esc(m.name)) : [];
      return card(p, { act: 'nightPick', disabled: !ok(p), sel: my === p.id, who: picks.length ? '🔪 ' + picks.join('، ') : '', showRole: r.team === 'mafia' && p.role && R(p.role).team === 'mafia' });
    });
    const chosen = my && my !== 'skip' ? P(my) : null;
    dock = (me.role === 'sniper' ? `<button class="btn ${my === 'skip' ? 'on' : 'line'}" data-act="nightPick" data-id="skip">مش الليلة</button>` : '')
      + `<span class="msg">${chosen ? `اخترت <b>${esc(chosen.name)}</b>. بتقدر تغيّر لحد ما يخلص الوقت.` : my === 'skip' ? 'ما رح تطلق الليلة.' : 'اضغط على ورقة لتختار.'}</span>`;
  }
  main += notebook();
  return { main, dock };
}

function notebook() {
  const me = state.me;
  if (me.role !== 'detective' || !me.notes.length) return '';
  return `<div class="notebook"><h3>دفتر المحقق</h3><ul>${me.notes.map((n) =>
    `<li><span>الليلة ${ord(n.day, ORD)}: ${esc(n.name)}</span><span class="${n.result === 'mafia' ? 'mafia' : ''}">${n.result === 'mafia' ? 'مافيا' : 'بريء'}</span></li>`).join('')}</ul></div>`;
}

// ---------------- الإعلانات ----------------
function morning() {
  const e = state.lastEvent;
  if (!e || e.type !== 'morning') return '';
  let h = e.killed.length
    ? e.killed.map((k) => `<div class="ann kill"><span class="ico">💀</span><span><b>${esc(k.name)}</b> انقتل الليلة${k.role ? `، وكان ${R(k.role).icon} ${esc(R(k.role).name)}` : ''}</span></div>`).join('')
    : `<div class="ann"><span class="ico">🕊️</span><span>ليلة هادية، ما مات حدا</span></div>`;
  if (e.saved) h += `<div class="ann"><span class="ico">💉</span><span>حدا كان رح يموت، بس الطبيب أنقذه</span></div>`;
  return `<div class="announce">${h}</div>`;
}
function voteResult() {
  const e = state.lastEvent;
  if (!e || e.type !== 'vote') return '';
  if (e.out) return `<div class="announce"><div class="ann kill"><span class="ico">⚖️</span><span>المدينة طلّعت <b>${esc(e.out.name)}</b>${e.out.role ? `، وكان ${R(e.out.role).icon} ${esc(R(e.out.role).name)}` : ''}</span></div></div>`;
  return `<div class="announce"><div class="ann"><span class="ico">🤝</span><span>${e.tie ? 'تعادل بالأصوات' : 'المدينة تخطّت'}، ما حدا طلع اليوم</span></div></div>`;
}
const mafiaMate = (p) => R(state.me.role).team === 'mafia' && p.role && R(p.role).team === 'mafia';

// ---------------- النهار ----------------
function vDay() {
  const s = state;
  return {
    main: `
      <div class="stage"><h1>صباح اليوم ${ord(s.day, DAYORD)}</h1><p>ناقشوا مين بتشكّوا فيه. التصويت بيبلش لحاله لما يخلص الوقت.</p></div>
      ${morning()}
      ${tableOf(s.players, (p) => card(p, { showRole: mafiaMate(p) }))}
      ${notebook()}`,
    dock: s.me.isHost
      ? `<button class="btn red" data-act="startVote">ابدأ التصويت الآن</button><button class="btn line" data-act="extend">زيد 30 ثانية</button>`
      : `<span class="msg">${s.me.alive ? 'وقت النقاش' : 'إنت ميت، بتتفرج بس'}</span>`,
  };
}

// ---------------- التصويت ----------------
function vVote() {
  const s = state;
  const votes = s.votes || {};
  const alive = s.players.filter((p) => p.alive);
  const voted = Object.keys(votes).length;
  const my = votes[s.me.id];
  const counts = {};
  Object.values(votes).forEach((t) => (counts[t] = (counts[t] || 0) + 1));
  const votersOf = (id) => Object.entries(votes).filter(([, t]) => t === id).map(([v]) => esc(P(v)?.name)).join('، ');
  const target = my && my !== 'skip' ? P(my) : null;
  return {
    main: `
      <div class="stage"><h1>التصويت</h1><p>${voted} من ${alive.length} صوّتوا. إذا صار تعادل، ما حدا بيطلع.</p></div>
      ${tableOf(s.players, (p) => p.alive
        ? card(p, { act: 'vote', disabled: !s.me.alive || p.id === s.me.id, sel: my === p.id, votes: counts[p.id], who: votersOf(p.id), showRole: mafiaMate(p) })
        : card(p))}`,
    dock: s.me.alive
      ? `<button class="btn ${my === 'skip' ? 'on' : 'line'}" data-act="vote" data-id="skip">تخطّي${counts.skip ? ` (${counts.skip})` : ''}</button>
         <span class="msg">${target ? `صوّتت على <b>${esc(target.name)}</b>. بتقدر تغيّر.` : my === 'skip' ? 'اخترت تتخطى.' : 'اضغط على ورقة اللي بتشك فيه.'}</span>`
      : `<span class="msg">الميت ما بيصوّت</span>`,
  };
}

// ---------------- المغرب ----------------
function vDusk() {
  const s = state;
  return {
    main: `
      <div class="stage"><h1>المغرب</h1><p>الليل جاي بعد شوي.</p></div>
      ${voteResult()}
      ${tableOf(s.players, (p) => card(p, { showRole: mafiaMate(p) }))}`,
    dock: `<span class="msg">الليل بيبلش لحاله</span>`,
  };
}

// ---------------- النهاية ----------------
function vEnded() {
  const s = state;
  const icon = s.winner === 'town' ? '🏙️' : s.winner === 'mafia' ? '🔪' : '🃏';
  const title = s.winner === 'town' ? 'فازت المدينة' : s.winner === 'mafia' ? 'فازت المافيا' : `فاز المهرج ${esc(P(s.winnerId)?.name || '')}`;
  const won = iWon();
  return {
    main: `
      <div class="verdict"><div class="big">${icon}</div><h1>${title}</h1><div class="me-res ${won ? 'win' : ''}">${won ? 'مبروك، فزت' : 'خسرت هالمرة'}</div></div>
      ${morning()}${voteResult()}
      ${tableOf(s.players, (p) => card(p))}`,
    dock: s.me.isHost
      ? `<button class="btn red" data-act="restart">جولة جديدة</button><button class="btn line" data-act="leave">اطلع</button>`
      : `<span class="msg">بانتظار المضيف يبدأ جولة جديدة</span><button class="btn line" data-act="leave">اطلع</button>`,
  };
}

// ---------------- العمود الجانبي ----------------
function renderSide() {
  const s = state;
  // السجل
  const log = s.log || [];
  put($('#pane-log'), 'log', log.length
    ? `<ul class="loglist">${log.slice().reverse().map((l) => `<li><span class="d">${l.day ? 'يوم ' + l.day : ''}</span><span>${l.icon} ${esc(l.text)}</span></li>`).join('')}</ul>`
    : `<div class="empty">لسا ما صار إشي. أول ما يموت حدا أو يطلع بالتصويت، بيبيّن هون.</div>`);
  // الأدوار
  const counts = s.roleCounts || (s.rolePreview || []).reduce((m, r) => { m[r] = (m[r] || 0) + 1; return m; }, {});
  const order = ['godfather', 'mafia', 'doctor', 'detective', 'sniper', 'mayor', 'jester', 'citizen'];
  const list = order.filter((r) => counts[r]);
  put($('#pane-roles'), 'roles', list.length
    ? `<div class="rolelist">${list.map((r) => `<div class="rr"><div class="ri">${R(r).icon}</div><div><div class="rt">${esc(R(r).name)} <span class="n">× ${counts[r]}</span></div><div class="rd">${esc(R(r).desc)}</div></div></div>`).join('')}</div>`
    : `<div class="empty">الأدوار بتبيّن لما يصير عددكم ${s.minPlayers} أو أكثر.</div>`);
  renderChat();
}

function setTab(t) {
  curTab = t;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  ['chat', 'log', 'roles'].forEach((k) => $('#pane-' + k).classList.toggle('hidden', k !== t));
  if (t === 'chat') { unread = 0; updateBadges(); const b = $('#chatMsgs'); b.scrollTop = b.scrollHeight; }
}
const sideOpen = () => window.innerWidth > 920 || $('#side').classList.contains('open');
function updateBadges() {
  const show = unread > 0;
  $('#chatBadge').textContent = unread; $('#chatBadge').classList.toggle('hidden', !show || curTab === 'chat');
  $('#sideBadge').textContent = unread; $('#sideBadge').classList.toggle('hidden', !show);
}

function renderChat() {
  const s = state;
  const ch = s.chatChannel;
  const titles = { public: 'الكل بيشوف هالدردشة', mafia: 'دردشة المافيا، ما حدا غيركم بيشوفها', dead: 'دردشة الأموات' };
  const t = $('#chatTitle');
  t.textContent = ch ? titles[ch] : 'الدردشة مقفلة بالليل';
  t.className = 'chan' + (ch === 'mafia' ? ' mafia' : '');
  const input = $('#chatInput');
  input.disabled = !ch;
  input.placeholder = ch ? (ch === 'mafia' ? 'خططوا بالسر' : 'اكتب رسالة') : 'نايمين، ما في حكي';

  const newest = s.chat.length ? s.chat[s.chat.length - 1].id : 0;
  if (newest === lastChatId) return;
  const box = $('#chatMsgs');
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const added = lastChatId ? s.chat.filter((m) => m.id > lastChatId && m.ch !== 'system').length : 0;
  lastChatId = newest;
  const tag = { mafia: 'مافيا: ', dead: 'ميت: ' };
  box.innerHTML = s.chat.map((m) => m.ch === 'system'
    ? `<div class="msg system">${esc(m.text)}</div>`
    : `<div class="msg ${m.ch} ${m.from === s.me.name ? 'me' : ''}"><b>${tag[m.ch] || ''}${esc(m.from)}</b>${esc(m.text)}</div>`).join('');
  if (near || added) box.scrollTop = box.scrollHeight;
  if (added && (!sideOpen() || curTab !== 'chat')) { unread += added; updateBadges(); }
}

$('#chatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  await api('chat', { text });
});

// ---------------- النوافذ ----------------
function openModal(html) {
  $('#modalBox').innerHTML = html + `<div style="margin-top:16px"><button class="btn line wide" data-act="closeModal">سكّر</button></div>`;
  $('#modal').classList.remove('hidden');
}
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); });

function showRules() {
  openModal(`
    <h2>كيف بنلعب؟</h2>
    <p>كل واحد بياخد ورقة فيها دور سري. المافيا بيعرفوا بعض، والباقي ما بيعرفوا مين مين.</p>
    <p><b>بالليل</b> المافيا بيختاروا ضحية، الطبيب بيحمي حدا، والمحقق بيفحص حدا. الباقي نايمين.</p>
    <p><b>بالنهار</b> بنعرف مين مات، بنتناقش، وبعدين بنصوّت مين يطلع. إذا تعادلت الأصوات، ما حدا بيطلع.</p>
    <p><b>المدينة بتفوز</b> لما تطلّع كل المافيا. <b>المافيا بتفوز</b> لما يصير عددهم قد الباقيين أو أكثر.</p>
    <p>كل مرحلة إلها وقت، ولما يخلص الوقت اللعبة بتكمّل لحالها. هيك ما حدا بيقدر يعطّلها.</p>
    <p><b>عددكم ناقص؟</b> المضيف بيقدر يضيف بوتات 🤖 من اللوبي. البوت بياخد دور زي أي لاعب، وبيلعب لحاله.</p>
    <p style="color:var(--ash)">عدد المافيا: 1 لـ 4–5 لاعبين، 2 لـ 6–8، 3 لـ 9–11، 4 لـ 12–15، و5 لـ 16–20. الأدوار الجانبية بتدخل لحالها: زعيم المافيا من 7، القناص من 8، العمدة من 9، والمهرج من 10.</p>`);
}

// ---------------- الأفعال ----------------
async function pick(el, action, target) {
  document.querySelectorAll(`[data-act="${el.dataset.act}"]`).forEach((b) => b.classList.remove('sel', 'on'));
  el.classList.add(el.classList.contains('card') ? 'sel' : 'on');
  const r = await api(action, { target });
  if (r.error) { delete cache.main; delete cache.dock; render(); }
}
async function once(el, fn) {
  if (busy) return;
  busy = true;
  el.disabled = true;
  el.classList.add('loading');
  try { await fn(); } finally { busy = false; el.disabled = false; el.classList.remove('loading'); }
}

document.addEventListener('click', async (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) return setTab(tab.dataset.tab);
  if (e.target.closest('#sideClose')) { $('#side').classList.remove('open'); return; }
  if (e.target.closest('#sideToggle')) {
    const side = $('#side');
    side.classList.toggle('open');
    if (side.classList.contains('open')) setTab(unread ? 'chat' : curTab);
    return;
  }
  // سكّر الدرج لما تكبس برّاه (موبايل)
  if (window.innerWidth <= 920 && $('#side').classList.contains('open') && !e.target.closest('#side')) $('#side').classList.remove('open');

  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const act = el.dataset.act;
  const id = el.dataset.id;
  switch (act) {
    case 'create': return doCreateOrJoin('create');
    case 'join': return doCreateOrJoin('join');
    case 'rules': return showRules();
    case 'closeModal': return $('#modal').classList.add('hidden');
    case 'myrole': {
      const r = R(state.me.role);
      return openModal(`<div style="text-align:center"><div style="font-size:64px">${r.icon}</div><h2>${esc(r.name)}</h2><p style="font-weight:700">${teamName[r.team]}</p><p>${esc(r.desc)}</p></div>`);
    }
    case 'copy': {
      const link = `${location.origin}/?room=${state.code}`;
      try { await navigator.clipboard.writeText(link); toast('انسخ الرابط، ابعته لصحابك'); }
      catch (err) { prompt('انسخ الرابط:', link); }
      return;
    }
    case 'flip': if (!flipped) { flipped = true; delete cache.main; delete cache.dock; render(); } return;
    case 'pace': return api('settings', { settings: { pace: el.dataset.v } });
    case 'mode': return api('settings', { settings: { sideMode: el.dataset.v } });
    case 'side': return api('settings', { settings: { side: { [el.dataset.v]: !state.settings.side[el.dataset.v] } } });
    case 'reveal': return api('settings', { settings: { revealOnDeath: !state.settings.revealOnDeath } });
    case 'kick': if (confirm('تطرد ' + (P(id)?.name || '') + '؟')) api('kick', { target: id }); return;
    case 'addBot': return once(el, () => api('addBot'));
    case 'removeBots': return once(el, () => api('removeBots'));
    case 'start': return once(el, () => api('start'));
    case 'ready': return once(el, () => api('ready'));
    case 'nightPick': return pick(el, 'night', id);
    case 'vote': return pick(el, 'vote', id);
    case 'startVote': return once(el, () => api('startVote'));
    case 'extend': return once(el, () => api('extend'));
    case 'restart': return once(el, () => api('restart'));
    case 'leave': {
      if (!confirm('بدك تطلع من الغرفة؟')) return;
      await api('leave');
      history.replaceState(null, '', '/');
      return leaveLocal();
    }
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { $('#modal').classList.add('hidden'); $('#side').classList.remove('open'); }
  if (e.key === 'Enter' && !state && (e.target.id === 'codeIn' || e.target.id === 'nameIn')) {
    doCreateOrJoin(e.target.id === 'codeIn' || $('#codeIn').value.trim() ? 'join' : 'create');
  }
});

// ---------------- حماية الاتصال ----------------
function reconnect() { if (session) { $('#conn').classList.remove('hidden'); tryResume(); } }
setInterval(() => { if (session && Date.now() - lastBeat > 40000) { lastBeat = Date.now(); reconnect(); } }, 5000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && session && (!es || es.readyState !== 1 || Date.now() - lastBeat > 20000)) reconnect();
});
window.addEventListener('online', reconnect);
setInterval(() => {
  if (session) fetch('/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'hb', ...session }) }).catch(() => {});
}, 4 * 60 * 1000);

// ---------------- البداية ----------------
renderHome();
if (session) tryResume();
