// =====================================================
//  لعبة المافيا أونلاين — واجهة اللاعب
// =====================================================
'use strict';

const $ = (s) => document.querySelector(s);
const main = $('#main');
const KEY = 'mafia_session';

let session = loadSession();
let state = null;
let es = null;
let lastPhaseKey = '';
let lastChatId = 0;
let unread = 0;
let flipped = false;

// ---------------- أدوات ----------------
function loadSession() { try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; } }
function saveSession(s) { try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch (e) {} }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initial = (n) => esc([...String(n).trim()][0] || '?');

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
    toast('مشكلة بالاتصال بالسيرفر');
    return { error: 'network' };
  }
}

const R = (id) => (state && state.roles[id]) || { name: '?', icon: '?', team: 'town' };
const P = (id) => state.players.find((p) => p.id === id);
const teamName = { mafia: 'فريق المافيا', town: 'فريق المدينة', neutral: 'لحاله' };

// ---------------- الاتصال ----------------
function connect() {
  if (es) es.close();
  const q = new URLSearchParams({ code: session.code, pid: session.pid, token: session.token });
  es = new EventSource('/events?' + q);
  es.onopen = () => $('#conn').classList.add('hidden');
  es.onmessage = (e) => { state = JSON.parse(e.data); render(); };
  es.addEventListener('kicked', () => leaveLocal('طلعت من الغرفة'));
  es.onerror = () => {
    $('#conn').classList.remove('hidden');
    if (es.readyState === 2) setTimeout(tryResume, 2500); // السيرفر رفض — يمكن الغرفة انحذفت
  };
}

async function tryResume() {
  if (!session) return;
  const r = await api('resume');
  if (r.ok) connect();
  else if (r.error !== 'network') leaveLocal();
  else setTimeout(tryResume, 3000);
}

function leaveLocal(msg) {
  if (es) es.close();
  es = null; session = null; state = null; lastPhaseKey = ''; lastChatId = 0;
  saveSession(null);
  $('#conn').classList.add('hidden');
  if (msg) toast(msg);
  renderHome();
}

// ---------------- الرئيسية ----------------
function renderHome() {
  document.body.classList.remove('night');
  $('#topInfo').innerHTML = '';
  $('#chat').classList.add('hidden');
  document.querySelector('.layout').classList.add('solo');
  const urlCode = new URLSearchParams(location.search).get('room') || '';
  let savedName = '';
  try { savedName = localStorage.getItem('mafia_name') || ''; } catch (e) {}
  main.innerHTML = `
    <div class="home">
      <div class="hero">
        <div class="big">مافيا</div>
        <p>المدينة نايمة... والمافيا صاحية 🔪</p>
      </div>
      <div class="card">
        <label class="muted">اسمك</label>
        <input id="nameIn" maxlength="20" placeholder="مثلاً: أبو العبد" value="${esc(savedName)}">
        <div class="spacer"></div>
        <button class="btn" data-act="create">👑 اعمل غرفة جديدة</button>
        <div class="divider">أو ادخل غرفة صاحبك</div>
        <div class="row">
          <input id="codeIn" class="code" maxlength="4" placeholder="CODE" value="${esc(urlCode)}">
          <button class="btn ghost" data-act="join" style="flex:.6">دخول</button>
        </div>
        <div class="spacer"></div>
        <div class="center"><button class="link" data-act="rules">📜 كيف بنلعب؟ وشو الأدوار؟</button></div>
      </div>
    </div>`;
  if (urlCode) $('#nameIn').focus();
}

async function doCreateOrJoin(kind) {
  const name = $('#nameIn').value.trim();
  if (!name) return toast('اكتب اسمك أول');
  try { localStorage.setItem('mafia_name', name); } catch (e) {}
  const data = { name };
  if (kind === 'join') {
    data.code = $('#codeIn').value.trim().toUpperCase();
    if (data.code.length !== 4) return toast('الكود 4 حروف');
  }
  const r = await api(kind, data, false);
  if (r.error) return;
  session = { code: r.code, pid: r.pid, token: r.token };
  saveSession(session);
  history.replaceState(null, '', '?room=' + r.code);
  connect();
}

// ---------------- الرسم الرئيسي ----------------
function render() {
  if (!state) return;
  const s = state;
  const phaseKey = s.phase + ':' + s.day;
  const phaseChanged = phaseKey !== lastPhaseKey;
  if (phaseChanged) {
    if (lastPhaseKey && navigator.vibrate) { try { navigator.vibrate(120); } catch (e) {} }
    if (s.phase === 'reveal') flipped = false;
    lastPhaseKey = phaseKey;
  }
  document.body.classList.toggle('night', s.phase === 'night');
  document.querySelector('.layout').classList.remove('solo');
  renderTop();

  const views = { lobby: vLobby, reveal: vReveal, night: vNight, day: vDay, vote: vVote, dusk: vDusk, ended: vEnded };
  main.innerHTML = (views[s.phase] || vLobby)();
  renderChat();
  if (phaseChanged) window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderTop() {
  const s = state;
  let html = `<span class="chip">🏠 ${esc(s.code)}</span>`;
  if (s.me.role) {
    const r = R(s.me.role);
    html += `<button class="chip red" data-act="myrole">${r.icon} دورك: ${esc(r.name)}</button>`;
  }
  if (s.me.isHost) html += `<span class="chip">👑 مضيف</span>`;
  $('#topInfo').innerHTML = html;
}

// شريط أزرار المضيف
function hostBar(buttons) {
  if (!state.me.isHost || !buttons) return '';
  return `<div class="host-bar"><div class="lbl">👑 تحكم المضيف</div><div class="row">${buttons}</div></div>`;
}

function playersMini() {
  const s = state;
  return `<div class="card"><h3>👥 اللاعبين (${s.players.filter((p) => p.alive).length} عايشين من ${s.players.length})</h3>
    <ul class="plist">${s.players.map((p) => {
      const r = p.role ? R(p.role) : null;
      return `<li class="${p.alive ? '' : 'dead'} ${p.id === s.me.id ? 'me' : ''} ${p.online ? '' : 'off'}">
        <span class="avatar">${p.alive ? initial(p.name) : '💀'}</span>
        <span class="nm">${esc(p.name)}${p.id === s.me.id ? ' (أنت)' : ''}</span>
        ${r ? `<span title="${esc(r.name)}">${r.icon}</span>` : ''}
        <span class="dot ${p.online ? 'on' : ''}"></span>
      </li>`;
    }).join('')}</ul></div>`;
}

function deadBanner() {
  if (state.me.alive || state.phase === 'ended') return '';
  return `<div class="dead-banner">💀 أنت ميت — صرت تتفرج وبتشوف كل الأدوار. ممنوع تحكي للعايشين! (دردشة الأموات بس)</div>`;
}

// ---------------- اللوبي ----------------
function vLobby() {
  const s = state;
  const n = s.players.length;
  const isHost = s.me.isHost;
  const st = s.settings;

  let preview;
  if (s.rolePreview) {
    const counts = {};
    s.rolePreview.forEach((r) => (counts[r] = (counts[r] || 0) + 1));
    const order = ['godfather', 'mafia', 'doctor', 'detective', 'sniper', 'mayor', 'jester', 'citizen'];
    preview = `<div class="roles-preview">${order.filter((r) => counts[r]).map((r) => {
      const d = R(r);
      return `<span class="rchip ${d.team === 'mafia' ? 'mafia' : ''} ${s.sideRoles.includes(r) ? 'side' : ''}">${d.icon} ${esc(d.name)} <span class="cnt">×${counts[r]}</span></span>`;
    }).join('')}</div>`;
  } else {
    preview = `<div class="note">لازم يكون في ${s.minPlayers} لاعبين على الأقل عشان نبلّش. ضايل ${s.minPlayers - n}.</div>`;
  }

  const sideAuto = s.sideRoles.map((r) => `${R(r).icon} ${R(r).name} من ${s.sideMin[r]}`).join(' • ');
  const settingsHtml = isHost ? `
    <div class="card">
      <h3>⚙️ إعدادات الأدوار الجانبية</h3>
      <div class="seg">
        <button class="${st.sideMode === 'auto' ? 'on' : ''}" data-act="mode" data-v="auto">تلقائي حسب العدد</button>
        <button class="${st.sideMode === 'custom' ? 'on' : ''}" data-act="mode" data-v="custom">اختيار يدوي</button>
      </div>
      <div class="spacer"></div>
      ${st.sideMode === 'auto'
        ? `<div class="note">كل ما زاد عددكم بتنضاف أدوار جانبية تلقائياً:<br>${sideAuto}</div>`
        : s.sideRoles.map((r) => `<div class="toggle" data-act="side" data-v="${r}"><span>${R(r).icon} ${esc(R(r).name)} <span class="muted" style="font-size:13px">— ${esc(R(r).desc)}</span></span><span class="switch ${st.side[r] ? 'on' : ''}"></span></div>`).join('')
          + `<div class="note" style="margin-top:8px">إذا العدد ما بيكفي، بتنشال الأدوار الجانبية الزايدة تلقائياً.</div>`}
      <div class="spacer"></div>
      <div class="toggle" data-act="reveal"><span>💀 كشف دور اللي بيموت</span><span class="switch ${st.revealOnDeath ? 'on' : ''}"></span></div>
    </div>` : '';

  return `
    <div class="card">
      <div class="room-code">
        <div><div class="muted">كود الغرفة — ابعته لصحابك</div><div class="code-box">${esc(s.code)}</div></div>
        <button class="btn small ghost" data-act="copy">🔗 نسخ رابط الدعوة</button>
      </div>
    </div>
    <div class="card">
      <h3>👥 اللاعبين (${n}/${s.maxPlayers})</h3>
      <ul class="plist">${s.players.map((p) => `
        <li class="${p.id === s.me.id ? 'me' : ''} ${p.online ? '' : 'off'}">
          <span class="avatar">${initial(p.name)}</span>
          <span class="nm">${p.id === s.hostId ? '👑 ' : ''}${esc(p.name)}${p.id === s.me.id ? ' (أنت)' : ''}</span>
          <span class="dot ${p.online ? 'on' : ''}"></span>
          ${isHost && p.id !== s.me.id ? `<button class="x" title="طرد" data-act="kick" data-id="${p.id}">✕</button>` : ''}
        </li>`).join('')}</ul>
    </div>
    <div class="card">
      <h3>🎭 توزيع الأدوار ${s.rolePreview ? `لـ ${n} لاعبين` : ''}</h3>
      ${preview}
      <div class="spacer"></div>
      <button class="link" data-act="rules">شو بيعمل كل دور؟</button>
    </div>
    ${settingsHtml}
    <div class="row">
      ${isHost
        ? `<button class="btn" data-act="start" ${n < s.minPlayers ? 'disabled' : ''}>🔪 ابدأ اللعبة</button>`
        : `<div class="note center" style="flex:2">⏳ بانتظار المضيف يبدأ اللعبة...</div>`}
      <button class="btn ghost" data-act="leave" style="flex:.5">خروج</button>
    </div>`;
}

// ---------------- كشف الدور ----------------
function roleCardHtml(roleId) {
  const r = R(roleId);
  const mates = state.players.filter((p) => p.id !== state.me.id && p.role && R(p.role).team === 'mafia');
  return `
    <div class="role-card ${flipped ? 'flipped' : ''}" data-act="flip">
      <div class="role-inner">
        <div class="face front"><div class="q">؟</div><h2 style="margin-top:18px">اضغط لتشوف دورك</h2><p class="muted">تأكد إنه ما حدا بيطّلع على شاشتك 👀</p></div>
        <div class="face back ${r.team}">
          <div class="role-icon">${r.icon}</div>
          <div class="role-name">${esc(r.name)}</div>
          <div class="team-tag ${r.team}">${teamName[r.team]}</div>
          <div class="role-desc">${esc(r.desc)}</div>
          ${r.team === 'mafia' && mates.length ? `<div class="mates">🤝 شركاؤك: ${mates.map((m) => `${esc(m.name)} ${R(m.role).icon}`).join('، ')}</div>` : ''}
          ${r.team === 'mafia' && !mates.length ? `<div class="mates">أنت المافيا الوحيد... بالتوفيق 😈</div>` : ''}
        </div>
      </div>
    </div>`;
}

function vReveal() {
  const s = state;
  const readyCount = s.players.filter((p) => p.ready).length;
  const meReady = s.players.find((p) => p.id === s.me.id)?.ready;
  return `
    <div class="card">
      <div class="phase-head"><div class="icon">🎭</div><h2>وزّعنا الأدوار</h2><p>شوف دورك واحفظه بالسر</p></div>
      <div class="spacer"></div>
      ${roleCardHtml(s.me.role)}
      <div class="spacer"></div>
      ${meReady
        ? `<div class="done-msg">✓ جاهز — بانتظار الباقي (${readyCount}/${s.players.length})</div>`
        : `<button class="btn" data-act="ready" ${flipped ? '' : 'disabled'}>✓ شفت دوري، أنا جاهز</button>
           <div class="done-msg">${readyCount}/${s.players.length} جاهزين</div>`}
    </div>
    ${hostBar(`<button class="btn host dark" data-act="force">⏭️ ابدأ الليل الآن</button>`)}`;
}

// ---------------- الليل ----------------
function vNight() {
  const s = state;
  const me = s.me;
  const r = R(me.role);
  let body = '';

  if (!me.alive) {
    // الأموات بيتفرجوا على اختيارات الليل
    const ch = (s.night && s.night.choices) || {};
    const lines = s.players.filter((p) => p.alive && ch[p.id]).map((p) => {
      const t = ch[p.id] === 'skip' ? 'ما أطلق' : esc(P(ch[p.id])?.name);
      return `<li><span>${R(p.role).icon} ${esc(p.name)}</span><span>← ${t}</span></li>`;
    });
    body = `<div class="card"><h3>👻 اللي صاير هالليلة</h3>${lines.length ? `<ul class="notes">${lines.join('')}</ul>` : '<p class="muted">لسا ما حدا اختار...</p>'}</div>`;
  } else if (!s.night.canAct) {
    body = `<div class="card sleep"><div class="zz">😴</div><h2>نام بهدوء...</h2><p class="muted">ما عندك شي تعمله الليلة. استنى لحد ما يطلع الصبح، وادعي إنك تصحى 🙏</p></div>`;
  } else {
    const myChoice = s.night.myChoice;
    let prompt = '';
    let filter = (p) => p.alive;
    let extra = '';
    if (r.team === 'mafia') {
      prompt = '🔪 اختاروا ضحية الليلة';
      filter = (p) => p.alive && !(p.role && R(p.role).team === 'mafia');
    } else if (me.role === 'doctor') {
      prompt = '💉 مين بدك تحمي الليلة؟';
      filter = (p) => p.alive && !(p.id === me.id && s.doctorSelfUsed);
    } else if (me.role === 'detective') {
      prompt = '🔍 مين بدك تفحص الليلة؟';
      filter = (p) => p.alive && p.id !== me.id;
    } else if (me.role === 'sniper') {
      prompt = '🎯 معك رصاصة وحدة... بدك تطلقها الليلة؟';
      filter = (p) => p.alive && p.id !== me.id;
      extra = `<div class="spacer"></div><button class="btn ${myChoice === 'skip' ? '' : 'ghost'}" data-act="nightPick" data-id="skip">✋ لا، مش الليلة</button>`;
    }
    const mv = s.night.mafiaVotes || [];
    body = `<div class="card">
      <h2>${prompt}</h2>
      ${me.role === 'doctor' && !s.doctorSelfUsed ? '<p class="muted">بتقدر تحمي حالك مرة وحدة بس.</p>' : ''}
      ${r.team === 'mafia' && mv.length > 1 ? '<p class="muted">إذا اختلفتوا، بيتم اختيار الأكثر أصوات (وإذا تعادلتوا، عشوائي بينهم).</p>' : ''}
      <div class="targets">${s.players.filter((p) => p.alive || false).map((p) => {
        const ok = filter(p);
        const tags = r.team === 'mafia' ? mv.filter((m) => m.target === p.id).map((m) => esc(m.name)).join('، ') : '';
        return `<button class="target ${myChoice === p.id ? 'sel' : ''}" data-act="nightPick" data-id="${p.id}" ${ok ? '' : 'disabled'}>
          <span class="avatar">${initial(p.name)}</span>
          <span class="tn">${esc(p.name)}${p.id === me.id ? ' (أنت)' : ''}</span>
          <div class="tags">${tags ? '🔪 ' + tags : (p.role && p.id !== me.id ? R(p.role).icon + ' ' + esc(R(p.role).name) : '')}</div>
        </button>`;
      }).join('')}</div>
      ${extra}
      ${myChoice ? `<div class="done-msg">✓ تم الاختيار — بتقدر تغيّر لحد ما الكل يخلص</div>` : ''}
    </div>`;
  }

  return `
    <div class="card"><div class="phase-head"><div class="icon"><span class="moon">🌙</span></div><h2>الليلة ${s.day}</h2><p>المدينة نايمة... أصحاب الأدوار بيشتغلوا بالسر</p></div></div>
    ${deadBanner()}
    ${body}
    ${detectiveNotes()}
    ${hostBar(`<button class="btn host dark" data-act="force" data-confirm="1">⏭️ إنهاء الليل (اللي ما اختار بيتخطى)</button>`)}
    ${playersMini()}`;
}

function detectiveNotes() {
  const me = state.me;
  if (me.role !== 'detective' || !me.notes.length) return '';
  return `<div class="card"><h3>🔍 دفتر المحقق (سري)</h3><ul class="notes">${me.notes.map((n) =>
    `<li><span>الليلة ${n.day}: ${esc(n.name)}</span><span class="res-${n.result}">${n.result === 'mafia' ? '🔪 مافيا!' : '✓ بريء'}</span></li>`).join('')}</ul></div>`;
}

// ---------------- النهار ----------------
function morningEvents() {
  const e = state.lastEvent;
  if (!e || e.type !== 'morning') return '';
  let html = '';
  if (e.killed.length) {
    html += e.killed.map((k) => `<div class="event kill"><span class="e-icon">💀</span><span>${esc(k.name)} انقتل الليلة${k.role ? ` — كان <b>${R(k.role).icon} ${esc(R(k.role).name)}</b>` : ''}</span></div>`).join('');
  } else {
    html += `<div class="event calm"><span class="e-icon">🕊️</span><span>ليلة هادية... ما مات حدا!</span></div>`;
  }
  if (e.saved) html += `<div class="event save"><span class="e-icon">💉</span><span>في حدا كان رح يموت... بس الطبيب أنقذه!</span></div>`;
  return html;
}

function vDay() {
  const s = state;
  return `
    <div class="card"><div class="phase-head"><div class="icon">☀️</div><h2>صباح اليوم ${s.day}</h2><p>صحيت المدينة...</p></div>
      <div class="spacer"></div>${morningEvents()}</div>
    ${deadBanner()}
    ${detectiveNotes()}
    <div class="card center"><h2>🗣️ وقت النقاش</h2><p class="muted">احكوا مع بعض: مين بتشكّوا فيه؟ لما تجهزوا، المضيف بيفتح التصويت.</p></div>
    ${hostBar(`<button class="btn host" data-act="startVote">🗳️ افتح التصويت</button>`)}
    ${playersMini()}`;
}

// ---------------- التصويت ----------------
function vVote() {
  const s = state;
  const votes = s.votes || {};
  const aliveP = s.players.filter((p) => p.alive);
  const voted = Object.keys(votes).length;
  const myVote = votes[s.me.id];
  const counts = {};
  Object.values(votes).forEach((t) => (counts[t] = (counts[t] || 0) + 1));
  const votersOf = (id) => Object.entries(votes).filter(([, t]) => t === id).map(([v]) => esc(P(v)?.name)).join('، ');

  return `
    <div class="card"><div class="phase-head"><div class="icon">🗳️</div><h2>التصويت — اليوم ${s.day}</h2><p>مين لازم يطلع من المدينة؟ (${voted}/${aliveP.length} صوّتوا)</p></div></div>
    ${deadBanner()}
    <div class="card">
      <div class="targets">${aliveP.map((p) => `
        <button class="target ${myVote === p.id ? 'sel' : ''}" data-act="vote" data-id="${p.id}" ${!s.me.alive || p.id === s.me.id ? 'disabled' : ''}>
          ${counts[p.id] ? `<span class="votes">${counts[p.id]}</span>` : ''}
          <span class="avatar">${initial(p.name)}</span>
          <span class="tn">${esc(p.name)}${p.id === s.me.id ? ' (أنت)' : ''}</span>
          <div class="voters">${votersOf(p.id)}</div>
        </button>`).join('')}</div>
      <div class="spacer"></div>
      ${s.me.alive ? `<button class="btn ${myVote === 'skip' ? '' : 'ghost'}" data-act="vote" data-id="skip">🤷 تخطي — ما بدي أصوّت على حدا ${counts.skip ? `(${counts.skip})` : ''}</button>` : ''}
      ${myVote ? `<div class="done-msg">✓ صوّتت — بتقدر تغيّر صوتك لحد ما الكل يخلص</div>` : ''}
      <p class="muted center" style="font-size:13px;margin:10px 0 0">إذا صار تعادل، ما حدا بيطلع.</p>
    </div>
    ${hostBar(`<button class="btn host dark" data-act="force" data-confirm="1">⏭️ إنهاء التصويت الآن</button>`)}
    ${playersMini()}`;
}

// ---------------- نتيجة التصويت ----------------
function voteEvent() {
  const e = state.lastEvent;
  if (!e || e.type !== 'vote') return '';
  if (e.out) return `<div class="event kill"><span class="e-icon">⚖️</span><span>المدينة طلّعت ${esc(e.out.name)}${e.out.role ? ` — كان <b>${R(e.out.role).icon} ${esc(R(e.out.role).name)}</b>` : ''}</span></div>`;
  return `<div class="event calm"><span class="e-icon">🤝</span><span>${e.tie ? 'صار تعادل بالأصوات' : 'المدينة قررت تتخطى'}... ما حدا طلع اليوم.</span></div>`;
}

function vDusk() {
  const s = state;
  return `
    <div class="card"><div class="phase-head"><div class="icon">🌆</div><h2>المغرب — نتيجة التصويت</h2><p>الشمس بتغيب... والليل جاي</p></div>
      <div class="spacer"></div>${voteEvent()}</div>
    ${deadBanner()}
    ${hostBar(`<button class="btn host" data-act="startNight">🌙 ابدأ الليل</button>`)}
    ${!s.me.isHost ? '<div class="note center">⏳ بانتظار المضيف يبدأ الليل...</div><div class="spacer"></div>' : ''}
    ${playersMini()}`;
}

// ---------------- النهاية ----------------
function vEnded() {
  const s = state;
  const myTeam = R(s.me.role).team;
  let icon, title;
  if (s.winner === 'town') { icon = '🏙️'; title = 'فازت المدينة!'; }
  else if (s.winner === 'mafia') { icon = '🔪'; title = 'فازت المافيا!'; }
  else { icon = '🃏'; title = `فاز المهرج ${esc(P(s.winnerId)?.name || '')}!`; }
  const iWon = s.winner === 'jester' ? s.winnerId === s.me.id : myTeam === s.winner;
  return `
    <div class="card winner">
      <div class="big-icon">${icon}</div>
      <h2>${title}</h2>
      <div class="me-res ${iWon ? 'win' : ''}">${iWon ? '🏆 مبروك، فزت!' : '😵 خسرت هالمرة'}</div>
      <div class="spacer"></div>
      ${morningEvents()}${voteEvent()}
    </div>
    <div class="card">
      <h3>🎭 الأدوار الحقيقية</h3>
      <table class="reveal-table">${s.players.map((p) => `
        <tr class="${p.alive ? '' : 'dead'}"><td>${p.alive ? '❤️' : '💀'} ${esc(p.name)}${p.id === s.me.id ? ' (أنت)' : ''}</td>
        <td>${R(p.role).icon} ${esc(R(p.role).name)}</td><td class="muted">${teamName[R(p.role).team]}</td></tr>`).join('')}
      </table>
    </div>
    <div class="row">
      ${s.me.isHost ? `<button class="btn" data-act="restart">🔁 جولة جديدة</button>` : `<div class="note center" style="flex:2">⏳ بانتظار المضيف يبدأ جولة جديدة...</div>`}
      <button class="btn ghost" data-act="leave" style="flex:.5">خروج</button>
    </div>`;
}

// ---------------- الدردشة ----------------
function renderChat() {
  const s = state;
  const chatEl = $('#chat');
  chatEl.classList.remove('hidden');
  const ch = s.chatChannel;
  const titles = { public: '💬 الدردشة العامة', mafia: '🔪 دردشة المافيا (سرية)', dead: '👻 دردشة الأموات' };
  $('#chatTitle').textContent = ch ? titles[ch] : '🤫 الدردشة مقفلة بالليل';
  $('.chat-head').classList.toggle('mafia', ch === 'mafia');
  const input = $('#chatInput');
  input.disabled = !ch;
  input.placeholder = ch ? (ch === 'mafia' ? 'خططوا بالسر...' : 'اكتب رسالة...') : 'نايمين... ما في حكي 😴';

  const newest = s.chat.length ? s.chat[s.chat.length - 1].id : 0;
  if (newest === lastChatId) return;
  const box = $('#chatMsgs');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const added = s.chat.filter((m) => m.id > lastChatId && m.ch !== 'system').length;
  lastChatId = newest;
  const tag = { mafia: '[مافيا]', dead: '[أموات]' };
  box.innerHTML = s.chat.map((m) => m.ch === 'system'
    ? `<div class="msg system">${esc(m.text)}</div>`
    : `<div class="msg ${m.ch} ${m.from === s.me.name ? 'me' : ''}">${tag[m.ch] ? `<span class="tag">${tag[m.ch]}</span>` : ''}<b>${esc(m.from)}:</b>${esc(m.text)}</div>`).join('');
  if (nearBottom || added) box.scrollTop = box.scrollHeight;
  if (!chatEl.classList.contains('open') && window.innerWidth <= 900 && added) {
    unread += added;
    $('#chatBadge').textContent = unread;
    $('#chatBadge').classList.remove('hidden');
  }
}

$('#chatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  await api('chat', { text });
});
$('#chatToggle').addEventListener('click', () => {
  if (window.innerWidth > 900) return;
  $('#chat').classList.toggle('open');
  unread = 0;
  $('#chatBadge').classList.add('hidden');
  const box = $('#chatMsgs');
  box.scrollTop = box.scrollHeight;
});

// ---------------- النوافذ ----------------
function openModal(html) {
  $('#modalBox').innerHTML = html + `<div class="spacer"></div><button class="btn ghost" data-act="closeModal">سكّر</button>`;
  $('#modal').classList.remove('hidden');
}
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); });

const RULES_ROLES = {
  mafia: { name: 'مافيا', team: 'mafia', icon: '🔪', desc: 'كل ليلة بتتفق مع باقي المافيا على شخص تقتلوه.' },
  godfather: { name: 'زعيم المافيا', team: 'mafia', icon: '🎩', desc: 'من المافيا، بس بيطلع بريء لما المحقق يفحصه.' },
  doctor: { name: 'الطبيب', team: 'town', icon: '💉', desc: 'كل ليلة بيحمي شخص من القتل (حاله مرة وحدة بس).' },
  detective: { name: 'المحقق', team: 'town', icon: '🔍', desc: 'كل ليلة بيفحص شخص وبيعرف إذا مافيا ولا بريء.' },
  sniper: { name: 'القناص', team: 'town', icon: '🎯', desc: 'رصاصة وحدة باللعبة كلها، بيطلقها بالليل.' },
  mayor: { name: 'العمدة', team: 'town', icon: '⚖️', desc: 'صوته بالتصويت بيتحسب صوتين.' },
  jester: { name: 'المهرج', team: 'neutral', icon: '🃏', desc: 'بيفوز لحاله إذا المدينة صوّتت عليه وطلّعته.' },
  citizen: { name: 'مواطن', team: 'town', icon: '👤', desc: 'ما عنده قدرة، سلاحه النقاش والتصويت.' },
};
function showRules() {
  const roles = state ? state.roles : RULES_ROLES;
  openModal(`
    <h2>📜 كيف بنلعب؟</h2>
    <p>كل لاعب بياخد دور سري. <b>المافيا</b> بيعرفوا بعض، والباقي ما بيعرفوا مين مين.</p>
    <p>🌙 <b>بالليل:</b> المافيا بيختاروا ضحية، الطبيب بيحمي حدا، والمحقق بيفحص حدا.<br>
    ☀️ <b>بالنهار:</b> بنعرف مين مات، بنتناقش، وبعدين بنصوّت مين يطلع.<br>
    🏆 <b>المدينة بتفوز</b> لما تطلّع كل المافيا. <b>المافيا بتفوز</b> لما يصير عددهم مساوي أو أكثر من الباقيين.</p>
    <h3 style="margin-top:14px">الأدوار</h3>
    ${Object.entries(roles).map(([, r]) => `<div class="role-row"><div class="ri">${r.icon}</div><div><b>${esc(r.name)}</b> <span class="muted">(${teamName[r.team]})</span><br><span class="muted">${esc(r.desc)}</span></div></div>`).join('')}
    <h3 style="margin-top:14px">توزيع المافيا حسب العدد</h3>
    <p class="muted">4–5 لاعبين: 1 • 6–8: 2 • 9–11: 3 • 12–15: 4 • 16–20: 5<br>الأدوار الجانبية بتدخل تلقائياً: زعيم المافيا من 7، القناص من 8، العمدة من 9، المهرج من 10 (والمضيف بيقدر يختار يدوي).</p>`);
}

// ---------------- الأزرار (event delegation) ----------------
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const id = el.dataset.id;
  if (el.disabled) return;
  if (el.dataset.confirm && !confirm('متأكد؟')) return;

  switch (act) {
    case 'create': return doCreateOrJoin('create');
    case 'join': return doCreateOrJoin('join');
    case 'rules': return showRules();
    case 'closeModal': return $('#modal').classList.add('hidden');
    case 'myrole': {
      const r = R(state.me.role);
      return openModal(`<div class="center"><div class="role-icon">${r.icon}</div><div class="role-name">${esc(r.name)}</div><div class="team-tag ${r.team}" style="display:inline-block">${teamName[r.team]}</div><p class="role-desc">${esc(r.desc)}</p></div>`);
    }
    case 'copy': {
      const link = `${location.origin}/?room=${state.code}`;
      try { await navigator.clipboard.writeText(link); toast('✓ انسخ الرابط، ابعته لصحابك'); }
      catch (err) { prompt('انسخ الرابط:', link); }
      return;
    }
    case 'flip': flipped = true; return render();
    case 'mode': return api('settings', { settings: { sideMode: el.dataset.v } });
    case 'side': return api('settings', { settings: { side: { [el.dataset.v]: !state.settings.side[el.dataset.v] } } });
    case 'reveal': return api('settings', { settings: { revealOnDeath: !state.settings.revealOnDeath } });
    case 'kick': if (confirm('تطرد ' + (P(id)?.name || '') + '؟')) api('kick', { target: id }); return;
    case 'start': return api('start');
    case 'ready': return api('ready');
    case 'nightPick': return api('night', { target: id });
    case 'startVote': return api('startVote');
    case 'vote': return api('vote', { target: id });
    case 'startNight': return api('startNight');
    case 'force': return api('force');
    case 'restart': return api('restart');
    case 'leave': {
      if (!confirm('بدك تطلع من الغرفة؟')) return;
      await api('leave');
      history.replaceState(null, '', '/');
      return leaveLocal();
    }
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !state && (e.target.id === 'codeIn' || e.target.id === 'nameIn')) {
    doCreateOrJoin(e.target.id === 'codeIn' || $('#codeIn').value.trim() ? 'join' : 'create');
  }
});

// ---------------- البداية ----------------
if (session) { renderHome(); tryResume(); }
else renderHome();
