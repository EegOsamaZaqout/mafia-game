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
let nightMode = 'kill';    // المافيا بالليل: قتل أو إسكات
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
const teamName = { mafia: 'فريق المافيا', town: 'فريق الصالحين' };
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
    case 'defense': return curtain('التبرير', (s.accused || []).map((id) => (P(id) || {}).name).join(' و '));
    case 'revote': return curtain('إعادة التصويت', 'غيّر أو ثبّت');
    case 'dusk': return curtain('المغرب', s.lastEvent && s.lastEvent.out ? `طلع ${s.lastEvent.out.name}` : 'ما حدا طلع');
    case 'revenge': return curtain('الولد الصالح', 'بيختار مين يطلع معه', true);
    case 'ended': {
      const t = s.winner === 'town' ? 'فاز الصالحين' : 'فازت المافيا';
      return curtain(t, iWon() ? 'مبروك، فزت' : 'خسرت هالمرة', s.winner !== 'town');
    }
    case 'lobby': return me ? null : null;
  }
}
function iWon() {
  const s = state;
  if (!s.winner) return false;
  return R(s.me.role).team === s.winner;
}

// ---------------- الرسم ----------------
function render() {
  if (!state) return;
  const s = state;
  const key = s.phase + ':' + s.day + ':' + ((s.accused || []).join(','));
  if (key !== lastPhaseKey) {
    if (lastPhaseKey) {
      phaseCurtain(s);
      if (navigator.vibrate) { try { navigator.vibrate(120); } catch (e) {} }
    }
    if (s.phase === 'reveal') flipped = false;
    if (s.phase === 'night') nightMode = 'kill';
    lastPhaseKey = key;
    window.scrollTo({ top: 0 });
  }
  document.body.classList.toggle('night', s.phase === 'night');
  $('#shell').classList.remove('solo');
  $('#side').classList.remove('hidden');
  $('#dock').classList.remove('hidden');
  $('#sideToggle').classList.remove('hidden');
  $('#clock').classList.remove('hidden');

  const views = { lobby: vLobby, reveal: vReveal, night: vNight, day: vDay, vote: vVote, defense: vDefense, revote: vRevote, dusk: vDusk, revenge: vRevenge, ended: vEnded };
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
  const face = !!r && (p.id === s.me.id || !p.alive || s.phase === 'ended' || o.showRole || p.id === s.mayorRevealed);
  const cls = ['card', face ? 'face' : '', face && r.team === 'mafia' ? 'mafia' : '', p.alive || s.phase === 'lobby' ? '' : 'dead',
    p.id === s.me.id ? 'me' : '', p.online ? '' : 'off', o.sel ? 'sel' : '', o.cls || ''].filter(Boolean).join(' ');
  const inner = `
    ${!face && r ? `<span class="corner" title="${esc(r.name)}">${r.icon}</span>` : ''}
    ${p.bot ? '<span class="mic" title="بوت">🤖</span>' : p.voice ? '<span class="mic" title="بالصوت">🎙️</span>' : ''}
    ${s.silenced === p.id && ['day', 'vote', 'defense', 'revote', 'dusk', 'revenge'].includes(s.phase) && p.alive ? '<span class="hush" title="مسكَّت اليوم">🤐</span>' : ''}
    ${o.order ? `<span class="order">${o.order}</span>` : ''}
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
  const order = ['shaykh', 'silencer', 'mafia', 'mayor', 'goodboy', 'medic', 'sniper', 'citizen'];
  const lineup = s.rolePreview
    ? `<div class="lineup">${order.filter((r) => counts[r]).map((r) => `<span class="lu ${R(r).team === 'mafia' ? 'mafia' : ''}">${R(r).icon} ${esc(R(r).name)} <span class="n">${counts[r]}</span></span>`).join('')}</div>`
    : `<p class="muted" style="color:var(--ash)">بدكم ${s.minPlayers} لاعبين على الأقل. ضايل ${s.minPlayers - n}.</p>`;
  const pc = s.pace[st.pace];
  const paceHint = `الليل ${pc.night} ث • دور الحكي دقيقة • التصويت ${pc.vote} ث`;

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
        <span class="hint">${s.aiBots ? '🧠 البوتات مربوطة بالذكاء الاصطناعي (Gemini): بتحلل وبتحكي بالدردشة.' : 'عددكم ناقص؟ ضيف بوتات. بيحللوا التصويتات وبيلعبوا لحالهم.'}</span>
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
  const n = s.night || {};
  const mf = n.mafia || null; // اختيارات المافيا (للمافيا والأموات بس)
  const isMafia = r.team === 'mafia';
  let main = `<div class="stage"><h1>الليلة ${ord(s.day, ORD)}</h1>`;
  let dock = '';
  const mafiaTags = (p) => {
    if (!mf) return '';
    const t = [];
    if (mf.kill === p.id) t.push('🎩 اغتيال');
    if (mf.silence === p.id) t.push('🤐 تسكيت');
    return t.join('<br>');
  };

  if (!me.alive) {
    const ch = n.choices || {};
    main += `<p>إنت طالع من اللعبة. بتتفرج على اللي بيصير بالسر، وممنوع تحكي للعايشين.</p></div>`;
    main += tableOf(s.players, (p) => {
      const t = ch[p.id];
      const mine = p.alive && t ? `← ${t === 'skip' ? 'ما أطلق' : esc(P(t)?.name)}` : '';
      return card(p, { who: [mine, mafiaTags(p)].filter(Boolean).join('<br>') });
    });
    dock = `<span class="msg">إنت بتتفرج</span>`;
  } else if (!n.canAct) {
    if (isMafia && mf) {
      // مافيا عادي: بيشوف شو اختار الشيخ ومافيا التسكيت
      main += `<p>${mf.killer ? `${esc(mf.killer)} بيختار الاغتيال الليلة` : ''}${mf.silencer ? ` و${esc(mf.silencer)} بيختار التسكيت` : ''}. ساعدهم بدردشة المافيا.</p></div>`;
      main += tableOf(s.players, (p) => card(p, { who: mafiaTags(p), showRole: p.role && R(p.role).team === 'mafia' }));
      dock = `<span class="msg">إحكي مع المافيا بالدردشة 🔪</span>`;
    } else {
      main += `<p>نام. ما عندك شي تعمله الليلة، والصبح بيطلع لحاله لما يخلص الوقت.</p></div>`;
      main += tableOf(s.players, (p) => card(p));
      dock = `<span class="msg">نايم... 😴</span>`;
    }
  } else {
    // دور إله شغل الليلة. إذا عنده شغلتين (اغتيال وتسكيت) بيبدّل بينهم
    const both = n.needKill && n.needSilence;
    const mode = both ? nightMode : n.needSilence ? 'silence' : 'kill';
    const my = n.myChoice;
    const mySil = n.mySilence;
    let prompt, ok;
    if (mode === 'silence') {
      prompt = 'اختار أي لاعب تسكّته (حتى حالك أو واحد من المافيا). ما رح يقدر يحكي بكرا، بس بيصوّت.';
      ok = (p) => p.alive;
    } else if (n.isKiller) {
      prompt = me.role === 'shaykh' ? 'اختار شخص واحد تغتاله الليلة.' : 'الشيخ طلع من اللعبة، فإنت صرت تختار الاغتيال. اختار شخص واحد.';
      ok = (p) => p.alive && !(p.role && R(p.role).team === 'mafia');
    } else if (me.role === 'medic') {
      prompt = 'توقّع مين رح يغتال شيخ المافيا الليلة. إذا توقعت صح، بتنقذه.';
      ok = (p) => p.alive;
    } else {
      prompt = 'معك رصاصة وحدة باللعبة كلها. إذا أصبت مافيا بيطلع، وإذا أصبت صالح بتطلع إنت وهو.';
      ok = (p) => p.alive && p.id !== me.id;
    }
    main += `<p>${prompt}</p></div>`;
    main += tableOf(s.players, (p) => card(p, {
      act: 'nightPick', disabled: !ok(p), sel: (mode === 'silence' ? mySil : my) === p.id,
      who: mafiaTags(p), showRole: isMafia && p.role && R(p.role).team === 'mafia',
    }));
    const nm = (id) => (id && id !== 'skip' ? esc(P(id)?.name || '') : id === 'skip' ? 'بلا' : '—');
    if (both) {
      dock = `<div class="seg" role="group" aria-label="شو بدك تختار">
          <button class="${mode === 'kill' ? 'on' : ''}" data-act="nightMode" data-v="kill">🎩 الاغتيال${my ? ' ✓' : ''}</button>
          <button class="${mode === 'silence' ? 'on' : ''}" data-act="nightMode" data-v="silence">🤐 التسكيت${mySil ? ' ✓' : ''}</button>
        </div>`;
    }
    if (mode === 'silence') {
      dock += `<button class="btn sm ${mySil === 'skip' ? 'on' : 'line'}" data-act="nightPick" data-id="skip">بلا تسكيت</button>
        <span class="msg">${both ? `الاغتيال: <b>${nm(my)}</b> • ` : ''}التسكيت: <b>${nm(mySil)}</b></span>`;
    } else if (me.role === 'sniper' && !n.isKiller) {
      dock += `<button class="btn ${my === 'skip' ? 'on' : 'line'}" data-act="nightPick" data-id="skip">مش الليلة</button>
        <span class="msg">${my && my !== 'skip' ? `رح تقنص <b>${nm(my)}</b>` : my === 'skip' ? 'ما رح تطلق الليلة' : 'اضغط على ورقة لتقنص'}</span>`;
    } else {
      dock += `<span class="msg">${my ? `اخترت <b>${nm(my)}</b>${both ? ` • التسكيت: <b>${nm(mySil)}</b>` : ''}. بتقدر تغيّر لحد ما يخلص الوقت.` : 'اضغط على ورقة لتختار.'}</span>`;
    }
  }
  return { main, dock };
}

function notebook() { return ''; }

// ---------------- الإعلانات ----------------
function morning() {
  const e = state.lastEvent;
  if (!e || e.type !== 'morning') return '';
  const why = { kill: 'اغتالته المافيا', sniped: 'انقنص', backfire: 'القناص أصاب صالح، فطلع معه' };
  const ico = { kill: '💀', sniped: '🎯', backfire: '🎯' };
  let h = e.killed.length
    ? e.killed.map((k) => `<div class="ann kill"><span class="ico">${ico[k.cause] || '💀'}</span><span><b>${esc(k.name)}</b> ${why[k.cause] || 'طلع من اللعبة'}${k.role ? `، وكان ${R(k.role).icon} ${esc(R(k.role).name)}` : ''}</span></div>`).join('')
    : `<div class="ann"><span class="ico">🕊️</span><span>ليلة هادية، ما طلع حدا</span></div>`;
  if (e.saved) h += `<div class="ann"><span class="ico">🚑</span><span>الإسعاف توقّع صح وأنقذ حدا من الاغتيال</span></div>`;
  if (e.silenced) h += `<div class="ann kill"><span class="ico">🤐</span><span><b>${esc(e.silenced.name)}</b> مسكَّت اليوم، ما بيقدر يحكي بس بيقدر يصوّت</span></div>`;
  h += revengeAnn();
  return `<div class="announce">${h}</div>`;
}
function revengeAnn() {
  const v = state.lastEvent && state.lastEvent.revenge;
  if (!v) return '';
  const t = v.target;
  return `<div class="ann kill"><span class="ico">🧒</span><span>الولد الصالح ${esc(v.by)} أخد <b>${esc(t.name)}</b> معه${t.role ? `، وكان ${R(t.role).icon} ${esc(R(t.role).name)}` : ''}</span></div>`;
}
function voteResult() {
  const e = state.lastEvent;
  if (!e || e.type !== 'vote') return '';
  if (e.out) return `<div class="announce"><div class="ann kill"><span class="ico">⚖️</span><span>المدينة طلّعت <b>${esc(e.out.name)}</b>${e.out.role ? `، وكان ${R(e.out.role).icon} ${esc(R(e.out.role).name)}` : ''}</span></div></div>`;
  return `<div class="announce"><div class="ann"><span class="ico">🤝</span><span>${e.tie ? 'تعادل بالأصوات' : 'المدينة تخطّت'}، ما حدا طلع اليوم</span></div></div>`;
}
const mafiaMate = (p) => R(state.me.role).team === 'mafia' && p.role && R(p.role).team === 'mafia';

// ---------------- النهار ----------------
// زر العمدة: يكشف كرته (صوته بيصير بـ 3)
function mayorBtn() {
  const s = state;
  if (s.me.role !== 'mayor' || !s.me.alive || s.mayorRevealed || s.silenced === s.me.id) return '';
  return `<button class="btn line" data-act="revealMayor">⚖️ اكشف كرتي</button>`;
}
const hushedMe = () => state.silenced === state.me.id && state.me.alive;

// رقم دور كل لاعب بالنقاش، وإذا هو اللي عم يحكي هلأ
function turnInfo(p) {
  const t = state.turn;
  if (!t) return {};
  const i = t.queue.indexOf(p.id);
  if (i < 0) return {};
  if (t.speaker === p.id) return { order: '🎤', cls: 'speaking' };
  return { order: i < t.idx ? '✓' : String(i + 1), cls: i < t.idx ? 'spoke' : '' };
}
const nameOf = (id) => esc((P(id) || {}).name || '');

function speakerDock(kind) {
  const s = state;
  const t = s.turn || {};
  const mine = t.speaker === s.me.id;
  let html = '';
  if (mine) html += `<button class="btn red" data-act="endTurn">${kind === 'defense' ? 'خلصت تبريري' : 'خلصت كلامي'}</button><span class="msg">دورك هلأ! احكي بالصوت أو اكتب. إلك دقيقة.</span>`;
  else html += `<span class="msg">${t.speaker ? `🎤 دور <b>${nameOf(t.speaker)}</b>${kind === 'defense' ? ' يبرر' : ' يحكي'}. الكل ساكت.` : ''}${!s.me.alive ? ' (إنت طالع من اللعبة)' : hushedMe() ? ' (إنت مسكَّت اليوم 🤐)' : ''}</span>`;
  html += mayorBtn();
  if (s.me.isHost && !mine && t.speaker) html += `<button class="btn line sm" data-act="skipTurn">تخطّي الدور</button>`;
  if (s.me.isHost && kind === 'talk') html += `<button class="btn line sm" data-act="startVote">ابدأ التصويت الآن</button>`;
  return html;
}

function vDay() {
  const s = state;
  const t = s.turn || { queue: [], idx: 0 };
  const left = Math.max(0, t.queue.length - t.idx - 1);
  return {
    main: `
      <div class="stage"><h1>صباح اليوم ${ord(s.day, DAYORD)}</h1><p>النقاش بالدور: كل واحد بيحكي مرة وحدة والباقي ساكتين. ${left ? `ضايل ${left} بعد اللي عم يحكي.` : 'هاد آخر واحد، وبعده التصويت.'}</p></div>
      ${morning()}
      ${tableOf(s.players, (p) => card(p, Object.assign({ showRole: mafiaMate(p) }, turnInfo(p))))}`,
    dock: speakerDock('talk'),
  };
}

// التبرير: اللي عليه أكثر أصوات بيحكي مرة وحدة
function vDefense() {
  const s = state;
  const accused = s.accused || [];
  const votes = s.votes || {};
  const w = (id) => (id === s.mayorRevealed ? 3 : 1);
  const counts = {};
  Object.entries(votes).forEach(([v, x]) => (counts[x] = (counts[x] || 0) + w(v)));
  return {
    main: `
      <div class="stage"><h1>التبرير</h1><p>${accused.map(nameOf).join(' و ')} ${accused.length > 1 ? 'عليهم' : 'عليه'} أكثر أصوات. كل واحد بيبرر مرة وحدة، وبعدين بتقدروا تغيّروا أصواتكم.</p></div>
      ${tableOf(s.players, (p) => card(p, Object.assign({ showRole: mafiaMate(p), votes: counts[p.id], cls: accused.includes(p.id) ? 'accused' : '' }, turnInfo(p))))}`,
    dock: speakerDock('defense'),
  };
}

// إعادة التصويت: كل واحد بيغيّر أو بيثبّت
function vRevote() {
  const s = state;
  const votes = s.votes || {};
  const done = s.revoteDone || [];
  const alive = s.players.filter((p) => p.alive);
  const my = votes[s.me.id];
  const w = (id) => (id === s.mayorRevealed ? 3 : 1);
  const counts = {};
  Object.entries(votes).forEach(([v, x]) => (counts[x] = (counts[x] || 0) + w(v)));
  const votersOf = (id) => Object.entries(votes).filter(([, x]) => x === id).map(([v]) => nameOf(v) + (w(v) > 1 ? ' ×3' : '')).join('، ');
  const iDone = done.includes(s.me.id);
  return {
    main: `
      <div class="stage"><h1>بدك تغيّر صوتك؟</h1><p>${done.length} من ${alive.length} قرروا. إذا حدا ثاني صار عليه أصوات أكثر بيبرر هو، وإذا ما حدا غيّر بيطلع اللي عليه أكثر أصوات.</p></div>
      ${tableOf(s.players, (p) => p.alive
        ? card(p, { act: 'vote', disabled: !s.me.alive || p.id === s.me.id, sel: my === p.id, votes: counts[p.id], who: votersOf(p.id), showRole: mafiaMate(p), cls: (s.accused || []).includes(p.id) ? 'accused' : '' })
        : card(p))}`,
    dock: !s.me.alive ? `<span class="msg">اللي طالع من اللعبة ما بيصوّت</span>`
      : `<button class="btn ${iDone && my !== 'skip' ? 'on' : 'red'}" data-act="keepVote" ${iDone ? 'disabled' : ''}>${iDone ? '✓ ثبّتت' : (my ? 'ثبّت صوتي' : 'ما بدي أصوّت')}</button>
         <button class="btn ${my === 'skip' ? 'on' : 'line'}" data-act="vote" data-id="skip">تخطّي</button>
         ${mayorBtn()}
         <span class="msg">${my && my !== 'skip' ? `صوتك على <b>${nameOf(my)}</b>. اضغط ورقة ثانية لتغيّر.` : 'اضغط ورقة لتصوّت.'}</span>`,
  };
}

// ---------------- الولد الصالح ----------------
function vRevenge() {
  const s = state;
  const rv = s.revenge || {};
  const mine = rv.pid === s.me.id;
  return {
    main: `
      <div class="stage"><h1>الولد الصالح</h1><p>${mine
        ? 'طلعت من اللعبة، بس إلك حق تختار شخص واحد يطلع معك. اختار اللي بتشك إنه مافيا.'
        : `${esc(rv.name || '')} كان الولد الصالح، وهلأ بيختار شخص يطلع معه...`}</p></div>
      ${morning()}${voteResult()}
      ${tableOf(s.players, (p) => mine && p.alive ? card(p, { act: 'revenge' }) : card(p, { showRole: mafiaMate(p) }))}`,
    dock: mine ? `<span class="msg">اضغط على ورقة اللي بدك تاخده معك</span>` : `<span class="msg">بانتظار الولد الصالح يختار</span>`,
  };
}

// ---------------- التصويت ----------------
function vVote() {
  const s = state;
  const votes = s.votes || {};
  const alive = s.players.filter((p) => p.alive);
  const voters = alive;
  const voted = Object.keys(votes).length;
  const my = votes[s.me.id];
  const w = (id) => (id === s.mayorRevealed ? 3 : 1); // العمدة المكشوف صوته بـ 3
  const counts = {};
  Object.entries(votes).forEach(([v, t]) => (counts[t] = (counts[t] || 0) + w(v)));
  const votersOf = (id) => Object.entries(votes).filter(([, t]) => t === id).map(([v]) => esc(P(v)?.name) + (w(v) > 1 ? ' ×3' : '')).join('، ');
  const target = my && my !== 'skip' ? P(my) : null;
  const canVote = s.me.alive;
  return {
    main: `
      <div class="stage"><h1>التصويت</h1><p>${voted} من ${voters.length} صوّتوا. اللي عليه أكثر أصوات بيطلع، وإذا صار تعادل ما حدا بيطلع.</p></div>
      ${tableOf(s.players, (p) => p.alive
        ? card(p, { act: 'vote', disabled: !canVote || p.id === s.me.id, sel: my === p.id, votes: counts[p.id], who: votersOf(p.id), showRole: mafiaMate(p) })
        : card(p))}`,
    dock: canVote
      ? `<button class="btn ${my === 'skip' ? 'on' : 'line'}" data-act="vote" data-id="skip">تخطّي${counts.skip ? ` (${counts.skip})` : ''}</button>
         ${mayorBtn()}
         <span class="msg">${target ? `صوّتت على <b>${esc(target.name)}</b>${w(s.me.id) > 1 ? ' بـ 3 أصوات' : ''}. بتقدر تغيّر.` : my === 'skip' ? 'اخترت تتخطى.' : 'اضغط على ورقة اللي بتشك فيه.'}</span>`
      : `<span class="msg">اللي طالع من اللعبة ما بيصوّت</span>`,
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
  const icon = s.winner === 'town' ? '🏙️' : '🔪';
  const title = s.winner === 'town' ? 'فاز الصالحين' : 'فازت المافيا';
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
  const order = ['shaykh', 'silencer', 'mafia', 'mayor', 'goodboy', 'medic', 'sniper', 'citizen'];
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
  const hushed = s.silenced === s.me.id && ['day', 'vote', 'defense', 'revote', 'dusk', 'revenge'].includes(s.phase);
  const tk = s.turn && s.turn.speaker;
  t.textContent = ch ? (tk === s.me.id ? '🎤 دورك! اكتب أو احكي' : titles[ch])
    : hushed ? 'مافيا التسكيت سكّتك اليوم، ما بتقدر تكتب'
    : s.phase === 'night' ? 'الدردشة مقفلة بالليل'
    : ['vote', 'revote'].includes(s.phase) ? 'التصويت بصمت'
    : tk ? `🎤 دور ${(P(tk) || {}).name || ''} يحكي، الكل ساكت` : 'الدردشة مقفلة';
  t.className = 'chan' + (ch === 'mafia' ? ' mafia' : '');
  const input = $('#chatInput');
  input.disabled = !ch;
  input.placeholder = ch ? (ch === 'mafia' ? 'خططوا بالسر' : 'اكتب رسالة') : hushed ? 'مسكَّت 🤐' : s.phase === 'night' ? 'نايمين، ما في حكي' : 'استنى دورك';

  const newest = s.chat.length ? s.chat[s.chat.length - 1].id : 0;
  if (newest === lastChatId) return;
  const box = $('#chatMsgs');
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const added = lastChatId ? s.chat.filter((m) => m.id > lastChatId && m.ch !== 'system').length : 0;
  lastChatId = newest;
  const tag = { mafia: '🔪 ', dead: '👻 ' };
  let prev = null;
  box.innerHTML = s.chat.map((m) => {
    if (m.ch === 'system') { prev = null; return `<div class="cmsg system">${esc(m.text)}</div>`; }
    const mine = m.from === s.me.name;
    const same = prev && prev.from === m.from && prev.ch === m.ch; // رسائل ورا بعض من نفس الشخص: بلا اسم
    prev = m;
    const bot = (s.players.find((p) => p.name === m.from) || {}).bot;
    return `<div class="cmsg ${m.ch} ${mine ? 'me' : ''} ${same ? 'cont' : ''}">
      ${same || mine ? '' : `<div class="from" style="color:${nameColor(m.from)}">${tag[m.ch] || ''}${esc(m.from)}${bot ? ' <span class="bt">🤖</span>' : ''}</div>`}
      <div class="txt">${esc(m.text)}</div></div>`;
  }).join('');
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

// لون ثابت لكل لاعب بالدردشة
const NAME_COLORS = ['#FF8A80', '#FFD180', '#B9F6CA', '#80D8FF', '#EA80FC', '#FFFF8D', '#A7FFEB', '#FF9E80', '#CFD8DC', '#F48FB1', '#B388FF', '#CCFF90'];
function nameColor(n) {
  let h = 0;
  for (const ch of String(n)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return NAME_COLORS[h % NAME_COLORS.length];
}

// ---------------- النوافذ ----------------
function openModal(html) {
  $('#modalBox').innerHTML = html + `<div style="margin-top:16px"><button class="btn line wide" data-act="closeModal">سكّر</button></div>`;
  $('#modal').classList.remove('hidden');
}
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); });

function showRules() {
  openModal(`
    <h2>كيف بنلعب؟</h2>
    <p>كل واحد بياخد كرت فيه دور سري. المافيا بيعرفوا بعض، والصالحين ما بيعرفوا مين مين.</p>
    <p><b>بالليل:</b> شيخ المافيا بيختار مين يغتال، ومافيا التسكيت بيختار مين يسكّت، والإسعاف بيتوقع مين رح ينغتال، والقناص بيقرر إذا بدو يطلق رصاصته.</p>
    <p><b>بالنهار:</b> كل واحد بيحكي مرة وحدة بدوره (دقيقة)، والدور بيبلش من اللي بعد المسكوت. بعدين التصويت. اللي عليه أكثر أصوات بيبرر مرة وحدة، وبعدين اللي بده يغيّر صوته بيغيّر: إذا صار حدا ثاني عليه أكثر بيبرر هو، وإذا ما حدا غيّر بيطلع وبينكشف كرته. إذا تعادلوا بيبرروا الاثنين، وإذا ضل تعادل ما حدا بيطلع.</p>
    <p><b>الفوز:</b> الصالحين بيفوزوا لما تطلع كل المافيا. المافيا بيفوزوا لما يصير عدد الصالحين قد عددهم.</p>
    <h3 style="margin-top:14px">الأدوار</h3>
    ${['shaykh', 'silencer', 'mafia', 'mayor', 'goodboy', 'medic', 'sniper', 'citizen'].map((k) => {
      const r = (state && state.roles[k]) || null;
      return r ? `<div class="rr" style="display:grid;grid-template-columns:36px 1fr;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)"><div style="font-size:24px;text-align:center">${r.icon}</div><div><b>${esc(r.name)}</b> <span style="color:var(--ash)">(${teamName[r.team]})</span><br><span style="color:var(--ash);font-size:14px">${esc(r.desc)}</span></div></div>` : '';
    }).join('') || `<p style="color:var(--ash)">شيخ المافيا، مافيا التسكيت، المافيا، عمدة الصالحين، الولد الصالح، الإسعاف، القناص، والمواطن الصالح.</p>`}
    <p style="color:var(--ash);margin-top:12px">بـ 14 لاعب: 3 مافيا (الشيخ، التسكيت، مافيا) و11 صالحين (العمدة، الولد الصالح، الإسعاف، القناص، و7 مواطنين). لما العدد أقل، الأدوار بتنقص لحالها.</p>`);
}

// ---------------- الأفعال ----------------
async function pick(el, action, target, extra = {}) {
  document.querySelectorAll(`[data-act="${el.dataset.act}"]`).forEach((b) => b.classList.remove('sel', 'on'));
  el.classList.add(el.classList.contains('card') ? 'sel' : 'on');
  const r = await api(action, { target, ...extra });
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
    case 'nightPick': {
      const n = state.night || {};
      const silence = n.needSilence && (!n.needKill || nightMode === 'silence');
      return pick(el, 'night', id, silence ? { kind: 'silence' } : {});
    }
    case 'nightMode': nightMode = el.dataset.v; delete cache.main; delete cache.dock; return render();
    case 'revealMayor':
      if (!confirm('بدك تكشف كرتك قدام الكل؟ الكل رح يعرف إنك العمدة، وصوتك بيصير بـ 3.')) return;
      return once(el, () => api('revealMayor'));
    case 'revenge': if (confirm('تاخد ' + (P(id)?.name || '') + ' معك؟')) pick(el, 'revenge', id); return;
    case 'vote': return pick(el, 'vote', id);
    case 'startVote': return once(el, () => api('startVote'));
    case 'endTurn': return once(el, () => api('endTurn'));
    case 'skipTurn': return once(el, () => api('skipTurn'));
    case 'keepVote': return once(el, () => api('keepVote'));
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
