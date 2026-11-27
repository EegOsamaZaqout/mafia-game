'use strict';
// =====================================================
//  لعبة المافيا أونلاين — السيرفر
//  بدون أي مكتبات خارجية: Node.js فقط (http + Server-Sent Events)
// =====================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 20;

// ---------------- الأدوار ----------------
const ROLES = {
  shaykh:   { name: 'شيخ المافيا',    team: 'mafia', icon: '🎩',
              desc: 'إنت قائد المافيا. كل ليلة بتختار شخص واحد تغتاله وتطلّعه من اللعبة.' },
  silencer: { name: 'مافيا التسكيت',  team: 'mafia', icon: '🤐',
              desc: 'كل ليلة بتختار أي لاعب (حتى حالك أو واحد من المافيا) تمنعه من الحكي بالنهار اللي بعدها. بيقدر يصوّت بس ما بيحكي.' },
  mafia:    { name: 'مافيا',          team: 'mafia', icon: '🔪',
              desc: 'إنت من المافيا وبتعرف شركاءك. ساعدهم بالنقاش والتصويت. إذا طلع الشيخ، إنت بتصير تختار الاغتيال.' },
  mayor:    { name: 'عمدة الصالحين',  team: 'town',  icon: '⚖️',
              desc: 'بالنهار بتقدر تكشف كرتك قدام الكل بأي وقت. بعد ما تكشفه، صوتك بالتصويت بيتحسب 3 أصوات.' },
  goodboy:  { name: 'الولد الصالح',   team: 'town',  icon: '🧒',
              desc: 'قدرتك بتشتغل لما تطلع: إذا اغتالوك أو طلّعوك بالتصويت، بتختار شخص واحد يطلع معك. إذا كان مافيا بيطلع مافيا، وإذا كان صالح بيطلع صالح.' },
  medic:    { name: 'الإسعاف',        team: 'town',  icon: '🚑',
              desc: 'كل ليلة بتتوقع مين رح يغتال شيخ المافيا. إذا توقعت صح، بتنقذه من الموت.' },
  sniper:   { name: 'القناص',         team: 'town',  icon: '🎯',
              desc: 'معك رصاصة وحدة باللعبة كلها، بتطلقها بأي ليلة. إذا أصبت مافيا بيطلع، وإذا أصبت صالح بتطلع إنت وهو.' },
  citizen:  { name: 'مواطن صالح',     team: 'town',  icon: '👤',
              desc: 'ما عندك قدرة خاصة. ركّز بالنقاش واكشف المافيا بالتصويت.' },
};
// الأدوار اللي المضيف بيقدر يشغّلها أو يطفيها
const SIDE_ROLES = ['silencer', 'mayor', 'goodboy', 'sniper'];
// مدة كل مرحلة بالثواني حسب سرعة اللعب اللي بيختارها المضيف
const SCALE = Number(process.env.PACE_SCALE || 1); // للتجربة بس: بيسرّع المؤقتات
const PACE = {
  fast:   { reveal: 20, night: 30, day: 90,  vote: 30, dusk: 6, revenge: 15 },
  normal: { reveal: 30, night: 45, day: 150, vote: 45, dusk: 7, revenge: 20 },
  slow:   { reveal: 40, night: 60, day: 240, vote: 60, dusk: 8, revenge: 25 },
};
// أقل عدد لاعبين ليدخل كل دور تلقائياً
const SIDE_MIN = { mayor: 5, sniper: 6, silencer: 7, goodboy: 8 };

// عدد المافيا حسب عدد اللاعبين (14 لاعب = 3 مافيا و11 صالحين)
function mafiaCount(n) {
  if (n <= 6) return 1;
  if (n <= 10) return 2;
  if (n <= 16) return 3;
  return 4;
}

// بيرجع قائمة الأدوار حسب عدد اللاعبين والإعدادات
function buildRoles(n, settings) {
  const on = (r) => settings.sideMode === 'auto' ? n >= SIDE_MIN[r] : !!settings.side[r];
  let m = mafiaCount(n);
  const list = ['shaykh'];
  m--;
  if (m > 0 && on('silencer')) { list.push('silencer'); m--; }
  for (let i = 0; i < m; i++) list.push('mafia');
  list.push('medic');
  const extras = ['mayor', 'sniper', 'goodboy'].filter(on);
  while (list.length + extras.length > n && extras.length) extras.pop();
  list.push(...extras);
  while (list.length < n) list.push('citizen');
  return list.slice(0, n);
}

// ---------------- أدوات ----------------
const rid = () => crypto.randomBytes(8).toString('hex');
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  let c;
  do { c = Array.from({ length: 4 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join(''); }
  while (rooms.has(c));
  return c;
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const teamOf = (p) => (p && p.role ? ROLES[p.role].team : null);
const alive = (room) => room.players.filter((p) => p.alive);
const getP = (room, id) => room.players.find((p) => p.id === id);
const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 20);

// ---------------- الغرف ----------------
const rooms = new Map();

function newRoom() {
  const room = {
    code: newCode(),
    hostId: null,
    players: [],
    phase: 'lobby', // lobby | reveal | night | day | vote | dusk | ended
    settings: { sideMode: 'auto', side: { silencer: true, mayor: true, goodboy: true, sniper: true }, revealOnDeath: true, pace: 'normal' },
    day: 0,
    night: null,
    votes: {},
    lastEvent: null,
    winner: null,
    winnerId: null,
    sniperUsed: false,
    mayorRevealed: null,
    revenge: null,
    chat: [],
    chatSeq: 0,
    clients: new Map(), // playerId -> Set(res)
    lastActivity: Date.now(),
    timer: null, deadline: null, phaseTotal: 0, log: [], roleList: [],
  };
  rooms.set(room.code, room);
  return room;
}

function addPlayer(room, name, device) {
  const p = { id: rid(), token: rid() + rid(), name, device: String(device || '').slice(0, 40), role: null, alive: true, ready: false, notes: [], conns: 0, voice: false };
  room.players.push(p);
  if (!room.hostId) room.hostId = p.id;
  return p;
}

function removePlayer(room, id) {
  room.players = room.players.filter((p) => p.id !== id);
  const set = room.clients.get(id);
  if (set) for (const res of set) { try { res.write('event: kicked\ndata: {}\n\n'); res.end(); } catch (e) {} }
  room.clients.delete(id);
  // المضيف دايماً إنسان، مش بوت
  if (room.hostId === id) { const h = room.players.find((x) => !x.isBot); room.hostId = h ? h.id : null; }
  if (!room.players.some((x) => !x.isBot)) { clearTimer(room); rooms.delete(room.code); }
}

// ---------------- البوتات ----------------
// لاعبين بيلعبوا لحالهم لما العدد ناقص. اختياري: المضيف بيضيفهم من اللوبي.
const BOT_NAMES = [
  'أبو صالح', 'أم خليل', 'سامر', 'رامي', 'ليان', 'ياسمين', 'خالد', 'نزار', 'جميلة', 'عبير',
  'أبو العبد', 'أم محمد', 'طارق', 'هيا', 'باسل', 'رهف', 'يوسف', 'سلمى', 'أبو فادي', 'أم أحمد',
  'مراد', 'دانة', 'حمزة', 'نور', 'زياد', 'تالا', 'أبو سمير', 'أم سعيد', 'معتز', 'لمى',
  'وسيم', 'رغد', 'عمر', 'سارة', 'أبو عمر', 'أم يوسف', 'إياد', 'غيداء', 'قصي', 'بيسان',
];
const BOT_LINES = [
  'أنا بريء والله، دوّروا على غيري',
  'في حدا ساكت كثير... مش مريح',
  '{x} حركاته مش طبيعية اليوم',
  'خلّينا نصوّت بعقل، مش عالعشوائي',
  'أنا شاكك بـ {x}',
  'مين اللي بيدافع عن {x} كثير؟',
  'ما معي دليل، بس {x} مش مريحني',
  'أنا معكم، بس لا تتسرعوا بالتصويت',
  'إمبارح الليل كان غريب... {x} وين كان؟',
  'والله لو طلّعتوني رح تندموا 😅',
];
const pickOne = (arr) => arr[crypto.randomInt(arr.length)];

function addBot(room) {
  if (room.phase !== 'lobby') throw 'بس قبل ما تبدأ اللعبة';
  if (room.players.length >= MAX_PLAYERS) throw 'الغرفة مليانة';
  const used = new Set(room.players.map((x) => x.name));
  const pool = BOT_NAMES.filter((n) => !used.has(n));
  if (!pool.length) throw 'خلصت أسامي البوتات';
  const b = addPlayer(room, pickOne(pool), '');
  b.isBot = true;
  sys(room, `🤖 ${b.name} انضم للغرفة (بوت)`);
}

// =====================================================
//  Gemini (اختياري): البوتات بتحكي بذكاء وبتحلل الدردشة
//  بيشتغل بس إذا حطيت GEMINI_API_KEY بإعدادات Render. إذا خلص الحد أو صار خطأ،
//  البوتات بترجع للعقل العادي لحالها واللعبة ما بتوقف.
// =====================================================
const AI = (() => {
  const KEY = process.env.GEMINI_API_KEY || '';
  const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
  const MOCK = process.env.GEMINI_MOCK === '1';
  const PER_MIN = Number(process.env.GEMINI_PER_MIN || 8);
  let stamps = [];
  let pauseUntil = 0;
  let lastError = '';
  const stats = { ok: 0, fail: 0 };

  const ready = () => (KEY || MOCK) && Date.now() > pauseUntil;
  function budget() {
    const now = Date.now();
    stamps = stamps.filter((t) => now - t < 60000);
    if (stamps.length >= PER_MIN) return false;
    stamps.push(now);
    return true;
  }

  function prompt(room, b, replyTo) {
    const role = ROLES[b.role];
    const nm = (id) => (getP(room, id) || {}).name || '?';
    const aliveList = alive(room).map((p) => p.name + (p.id === room.mayorRevealed ? ' (العمدة المكشوف)' : '')).join('، ');
    const deadList = room.players.filter((p) => !p.alive).map((p) => `${p.name}${room.settings.revealOnDeath ? ' (كان ' + ROLES[p.role].name + ')' : ''}`).join('، ') || 'ما حدا';
    const votes = room.hist.votes.map((r) => `اليوم ${r.day}: ` + Object.entries(r.votes).map(([v, t]) => `${nm(v)}←${t === 'skip' ? 'تخطي' : nm(t)}`).join('، ') + (r.out ? ` | طلع ${nm(r.out)}` : ' | ما حدا طلع')).join('\n') || 'لسا ما صار تصويت';
    const chat = room.chat.filter((m) => m.ch === 'public').slice(-14).map((m) => `${m.from}: ${m.text}`).join('\n') || 'لسا ما حدا حكى';
    const mates = teamOf(b) === 'mafia' ? room.players.filter((p) => p.id !== b.id && teamOf(p) === 'mafia').map((p) => p.name).join('، ') : '';
    const sc = teamOf(b) === 'mafia' ? publicSuspicion(room, b) : suspicion(room, b);
    const top = Object.entries(sc).filter(([id, v]) => Math.abs(v) < 50 && getP(room, id) && getP(room, id).alive && id !== b.id).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([id]) => nm(id)).join('، ');
    return [
      `إنت لاعب اسمه "${b.name}" بلعبة المافيا مع صحابك أونلاين. إحكي بلهجة فلسطينية عامية، جملة وحدة قصيرة (أقل من 20 كلمة)، زي إنسان حقيقي. لا تحكي إنك بوت أو ذكاء اصطناعي أبداً.`,
      `دورك السري: ${role.name} (${role.team === 'mafia' ? 'فريق المافيا' : 'فريق الصالحين'}). ${role.desc}`,
      teamOf(b) === 'mafia'
        ? `شركاءك بالمافيا: ${mates || 'ما في'}. لا تكشف دورك ولا شركاءك أبداً. حاول تبعد الشك عنكم وتتهم صالحين بشكل مقنع.`
        : 'هدفك تكشف المافيا. حلّل التصويتات والدردشة. اللي صوّت على صالحين أو دافع عن مافيا مشبوه.',
      `اليوم رقم ${room.day}. العايشين: ${aliveList}.`,
      `اللي طلعوا: ${deadList}.`,
      `التصويتات:\n${votes}`,
      `آخر الدردشة:\n${chat}`,
      top ? `حسب تحليلك، الأكثر شبهة: ${top}.` : '',
      replyTo ? `${replyTo} ذكر اسمك هلأ بالدردشة، رد عليه.` : 'قول رأيك بالنقاش هلأ.',
      'رجّع JSON بس بهالشكل: {"say": "جملتك", "suspect": "اسم لاعب عايش بتشك فيه أو فاضي"}',
    ].filter(Boolean).join('\n\n');
  }

  async function call(text) {
    if (MOCK) return { say: 'والله أنا شايف إنه في حدا ساكت كثير، خلّينا نركّز', suspect: '' };
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 9000);
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`, {
        method: 'POST',
        signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text }] }],
          generationConfig: { temperature: 0.9, maxOutputTokens: 200, responseMimeType: 'application/json' },
        }),
      });
      if (r.status === 429) { pauseUntil = Date.now() + 10 * 60 * 1000; throw new Error('429 rate limit'); }
      if (!r.ok) { pauseUntil = Date.now() + 2 * 60 * 1000; throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200)); }
      const j = await r.json();
      const raw = (((j.candidates || [])[0] || {}).content || {}).parts?.map((p) => p.text || '').join('') || '';
      const m = raw.match(/\{[\s\S]*\}/);
      const o = m ? JSON.parse(m[0]) : null;
      if (!o || typeof o.say !== 'string') throw new Error('bad output');
      return { say: o.say.replace(/\s+/g, ' ').trim().slice(0, 160), suspect: String(o.suspect || '').trim() };
    } finally { clearTimeout(to); }
  }

  async function talk(room, b, replyTo) {
    if (!ready() || !budget()) return null;
    try {
      const r = await call(prompt(room, b, replyTo));
      stats.ok++;
      return r;
    } catch (e) {
      stats.fail++;
      lastError = String(e.message || e).slice(0, 200);
      if (Date.now() > pauseUntil) pauseUntil = Date.now() + 60 * 1000; // خطأ: بنرتاح دقيقة وبنرجع نجرّب
      console.error('Gemini:', lastError);
      return null;
    }
  }

  return { ready, talk, enabled: () => !!(KEY || MOCK), status: () => ({ enabled: !!(KEY || MOCK), paused: Date.now() < pauseUntil, ...stats, lastError }) };
})();

// بنأجّل حركة البوت شوي عشان تبيّن طبيعية، وبنلغيها إذا المرحلة تغيّرت
function botLater(room, frac0, frac1, fn) {
  const sec = (PACE[room.settings.pace][room.phase] || 10) * SCALE;
  const ms = sec * 1000 * (frac0 + Math.random() * (frac1 - frac0));
  const stamp = room.phase + ':' + room.day;
  setTimeout(() => {
    if (!rooms.has(room.code) || room.phase + ':' + room.day !== stamp) return;
    try { fn(); } catch (e) { /* حركة غير صالحة — بنتجاهلها */ }
    if (rooms.has(room.code)) broadcast(room);
  }, ms);
}

function mostCommon(list) {
  const t = {};
  list.forEach((x) => (t[x] = (t[x] || 0) + 1));
  const { top } = topOf(t);
  return top.length ? pickOne(top) : null;
}

// مين بيختار الاغتيال الليلة: الشيخ، وإذا طلع فالمافيا العادي، وبعدين مافيا التسكيت
function killerOf(room) {
  for (const r of ['shaykh', 'mafia', 'silencer']) {
    const k = alive(room).find((p) => p.role === r);
    if (k) return k;
  }
  return null;
}
const silencerOf = (room) => alive(room).find((p) => p.role === 'silencer') || null;

// =====================================================
//  عقل البوتات
//  البوت الصالح ما بيغش: بيعرف بس اللي بيعرفه أي لاعب (التصويتات، مين طلع وشو كان،
//  الدردشة، العمدة إذا كشف). بوت المافيا بيعرف شركاءه بس.
// =====================================================

// الدور اللي بيقدر هاللاعب يشوفه (نفس قواعد الشاشة بالزبط)
function knownRole(room, viewer, q) {
  if (!q.role) return null;
  if (q.id === viewer.id) return q.role;
  if (teamOf(viewer) === 'mafia' && teamOf(q) === 'mafia') return q.role;
  if (!q.alive && room.settings.revealOnDeath) return q.role;
  if (q.id === room.mayorRevealed) return q.role;
  return null;
}
const knownTeam = (room, viewer, q) => { const r = knownRole(room, viewer, q); return r ? ROLES[r].team : null; };

// رقم ثابت لكل بوت/لاعب/يوم عشان البوت ما يغيّر رأيه كل ثانية
function noise(a, b, c) {
  const h = crypto.createHash('md5').update(a + '|' + b + '|' + c).digest();
  return h[0] / 255;
}

// كلمات الشك والدفاع بالدردشة
const ACCUSE_RX = /(مافيا|شاكك|بشك|شك|كذاب|كذّاب|مشبوه|صوّتوا|صوتوا|طلّعوا|طلعوا|مش مريح|مريب)/;
const DEFEND_RX = /(بريء|بريئ|صالح|مش مافيا|واثق|معنا|معانا|نظيف)/;

// بنسجّل من الدردشة مين اتهم مين (للكل، البشر والبوتات)
function noteChat(room, p, text) {
  if (!room.hist || !p) return;
  for (const q of room.players) {
    if (q.id === p.id || !q.alive) continue;
    if (!text.includes(q.name)) continue;
    const w = ACCUSE_RX.test(text) ? 1 : DEFEND_RX.test(text) ? -0.6 : 0.3;
    room.hist.talk.push({ day: room.day, from: p.id, about: q.id, w });
  }
}

// نسبة الشك من وجهة نظر لاعب صالح (بالمعلومات العامة بس)
function suspicion(room, bot) {
  const H = room.hist;
  const sc = {};
  const others = alive(room).filter((q) => q.id !== bot.id);
  for (const q of others) sc[q.id] = 0;
  const team = (id) => { const q = getP(room, id); return q ? knownTeam(room, bot, q) : null; };

  for (const round of H.votes) {
    for (const [voter, target] of Object.entries(round.votes)) {
      if (!(voter in sc) && voter !== bot.id) continue;
      if (target === 'skip') continue;
      const tt = team(target);
      if (voter in sc) {
        if (tt === 'mafia') sc[voter] -= 2.2;      // ساعد يطلّع مافيا
        else if (tt === 'town') sc[voter] += 1.3;  // صوّت على صالح
      }
      const vt = team(voter);
      if (vt === 'mafia' && target in sc) sc[target] -= 1.4;  // المافيا صوّتوا عليه: غالباً صالح
      if (vt === 'town' && voter !== bot.id && target in sc && getP(room, voter) && !getP(room, voter).alive) sc[target] += 0.4;
    }
  }
  // اللي انغتالوا كانوا صالحين، واللي شكّوا فيه قبل ما يموتوا بيصير مشبوه أكثر
  for (const d of H.deaths) {
    if (d.cause !== 'kill') continue;
    for (const round of H.votes) { const t = round.votes[d.id]; if (t && t in sc) sc[t] += 0.7; }
    for (const tk of H.talk) if (tk.from === d.id && tk.about in sc && tk.w > 0) sc[tk.about] += 0.5;
  }
  // المسكوت غالباً صالح (المافيا بيسكّتوا اللي بيخوّفهم)
  for (const id of H.silenced) if (id in sc) sc[id] -= 0.6;
  // اتهامات الدردشة
  for (const tk of H.talk) {
    if (!(tk.about in sc)) continue;
    const ft = team(tk.from);
    if (ft === 'mafia') sc[tk.about] -= 1.2 * Math.max(0, tk.w);
    else sc[tk.about] += 0.45 * tk.w;
  }
  // اقتراحات Gemini لهالبوت
  for (const [id, v] of Object.entries((bot.brain && bot.brain.hints) || {})) if (id in sc) sc[id] += v;
  for (const q of others) {
    const t = knownTeam(room, bot, q);
    if (t === 'town') sc[q.id] = -100;
    else if (t === 'mafia') sc[q.id] = 100;
    else sc[q.id] += noise(bot.id, q.id, room.day) * 0.6;
  }
  return sc;
}

// قديش اللاعب الصالح خطير على المافيا (من وجهة نظر بوت مافيا)
function danger(room, bot) {
  const H = room.hist;
  const dz = {};
  const town = alive(room).filter((q) => teamOf(q) !== 'mafia');
  for (const q of town) dz[q.id] = noise(bot.id, q.id, room.day);
  const isMafia = (id) => { const q = getP(room, id); return q && teamOf(q) === 'mafia'; };
  for (const round of H.votes) for (const [v, t] of Object.entries(round.votes)) if (v in dz && isMafia(t)) dz[v] += 2;
  for (const tk of H.talk) if (tk.from in dz && isMafia(tk.about) && tk.w > 0) dz[tk.from] += 1.2;
  if (room.mayorRevealed && room.mayorRevealed in dz) dz[room.mayorRevealed] += 6;
  return dz;
}

// الشك "العام" اللي بيشوفه الصالحين (بوت المافيا بيستعمله عشان يتّهم صح ويندمج)
function publicSuspicion(room, bot) {
  const fake = { id: bot.id + ':town', role: 'citizen', alive: true, brain: {} };
  const sc = {};
  const raw = suspicion(room, fake);
  for (const [id, v] of Object.entries(raw)) if (Math.abs(v) < 50) sc[id] = v;
  return sc;
}

const argmax = (obj, ok = () => true) => {
  let best = null, bv = -Infinity;
  for (const [k, v] of Object.entries(obj)) if (ok(k) && v > bv) { bv = v; best = k; }
  return best ? { id: best, v: bv } : null;
};

function botNight(room, b) {
  if (room.phase !== 'night' || !b.alive) return;
  const a = alive(room);
  const town = a.filter((x) => teamOf(x) !== 'mafia');
  const mayor = room.mayorRevealed && a.find((x) => x.id === room.mayorRevealed);
  // مافيا التسكيت: بيسكّت أخطر واحد ما رح ينغتال
  if (silencerOf(room) === b && !(b.id in room.night.silence)) {
    const dz = danger(room, b);
    const killPick = room.night.choices[(killerOf(room) || {}).id];
    const t = argmax(dz, (id) => id !== killPick);
    room.night.silence[b.id] = t ? t.id : 'skip';
    if (nightDone(room)) { resolveNight(room); return; }
  }
  if (b.id in room.night.choices) return;
  let t = null;
  if (killerOf(room) === b) {
    if (!town.length) return;
    const dz = danger(room, b);
    // الإسعاف غالباً بيحمي العمدة المكشوف، فمرات بنغتال الأخطر اللي بعده
    if (mayor && Math.random() < 0.45) t = mayor.id;
    else { const best = argmax(dz, (id) => !mayor || id !== mayor.id || Math.random() < 0.3); t = best ? best.id : pickOne(town).id; }
  } else if (b.role === 'medic') {
    const sc = suspicion(room, b);
    const trusted = a.filter((x) => x.id !== b.id && (sc[x.id] || 0) < 0);
    // المافيا بيغتالوا اللي صوّتوا صح؛ بنحمي الأكثر ثقة
    const best = argmax(Object.fromEntries(trusted.map((x) => [x.id, -(sc[x.id] || 0)])));
    const r = Math.random();
    if (mayor && r < 0.45) t = mayor.id;
    else if (r < 0.7 && best) t = best.id;
    else if (r < 0.85) t = b.id;
    else t = pickOne(a).id;
  } else if (b.role === 'sniper') {
    const sc = suspicion(room, b);
    const sorted = Object.entries(sc).filter(([, v]) => v > -50).sort((x, y) => y[1] - x[1]);
    const [top, second] = sorted;
    // ما بيطلق إلا إذا الشك قوي وواضح (عشان ما يقتل صالح ويطلع معه)
    if (top && (top[1] >= 100 || (top[1] >= 3 && (!second || top[1] - second[1] >= 1.2)))) t = top[0];
    else t = 'skip';
  } else return;
  nightAction(room, b, t, 'kill');
}

function leading(room, ok) {
  const t = {};
  for (const [v, x] of Object.entries(room.votes)) if (ok(x)) t[x] = (t[x] || 0) + voteWeight(room, getP(room, v) || {});
  const { top, max } = topOf(t);
  return top.length ? { id: pickOne(top), w: max } : null;
}

function botVote(room, b) {
  if (room.phase !== 'vote' || !b.alive || b.id in room.votes) return;
  const others = alive(room).filter((x) => x.id !== b.id);
  if (!others.length) return;
  if (b.role === 'mayor' && !room.mayorRevealed && room.silenced !== b.id) {
    const sc = suspicion(room, b);
    const top = argmax(sc);
    if ((top && top.v >= 2) || alive(room).length <= 6) { try { revealMayor(room, b); } catch (e) {} }
  }
  let t;
  if (teamOf(b) === 'mafia') {
    const total = alive(room).reduce((s2, x) => s2 + voteWeight(room, x), 0);
    const lead = leading(room, (id) => id !== 'skip' && id !== b.id);
    const leadP = lead && getP(room, lead.id);
    if (leadP && teamOf(leadP) === 'mafia' && lead.w >= total / 2 && Math.random() < 0.5) t = leadP.id; // بيضحّي بشريكه عشان يبيّن نظيف
    else if (leadP && teamOf(leadP) !== 'mafia' && Math.random() < 0.75) t = leadP.id;       // بيمشي مع الأغلبية
    else {
      // ما بيصوّتوا كلهم على نفس الشخص عشان ما ينكشفوا
      const ps = publicSuspicion(room, b);
      const ok = (id) => { const q = getP(room, id); return q && q.alive && teamOf(q) !== 'mafia'; };
      const best = argmax(ps, ok);
      const mateVotes = Object.entries(room.votes).filter(([v]) => { const q = getP(room, v); return q && teamOf(q) === 'mafia'; }).map(([, x]) => x);
      if (best && mateVotes.includes(best.id) && Math.random() < 0.6) {
        const alt = argmax(ps, (id) => ok(id) && id !== best.id);
        t = alt ? alt.id : best.id;
      } else t = best ? best.id : pickOne(others.filter((x) => teamOf(x) !== 'mafia').concat(others)).id;
    }
  } else {
    const sc = suspicion(room, b);
    const best = argmax(sc, (id) => sc[id] > -50);
    const lead = leading(room, (id) => id !== 'skip' && id !== b.id && (sc[id] === undefined || sc[id] > -50));
    if (best && best.v >= 1.5) t = Math.random() < 0.9 ? best.id : (lead ? lead.id : best.id);
    else if (lead && Math.random() < 0.65) t = lead.id;
    else if (best && Math.random() < 0.85) t = best.id;
    else t = 'skip';
  }
  castVote(room, b, t);
}

// جملة بالدردشة إلها سبب (بدون Gemini)
function botLine(room, b) {
  const nm = (id) => (getP(room, id) || {}).name || '';
  if (teamOf(b) === 'mafia') {
    const ps = publicSuspicion(room, b);
    const lead = room.phase === 'vote' && leading(room, (id) => id !== 'skip');
    const leadP = lead && getP(room, lead.id);
    if (leadP && teamOf(leadP) === 'mafia' && leadP.id !== b.id && Math.random() < 0.5) {
      return pickOne([`استنوا، ${leadP.name} ما بيبيّن مافيا، خلّينا نفكر منيح`, `أنا مش مقتنع بـ ${leadP.name}، في حدا ثاني ساكت`]);
    }
    const best = argmax(ps, (id) => { const q = getP(room, id); return q && q.alive && teamOf(q) !== 'mafia' && q.id !== b.id; });
    if (best) return pickOne([`أنا شاكك بـ ${nm(best.id)}، تصويته مش منطقي`, `${nm(best.id)} بيحاول يوجّه النقاش، مش مريحني`, `ركّزوا على ${nm(best.id)} شوي`]);
    return pickOne(BOT_LINES).replace('{x}', pickOne(alive(room).filter((x) => teamOf(x) !== 'mafia')).name);
  }
  const sc = suspicion(room, b);
  const best = argmax(sc, (id) => sc[id] > -50);
  if (best && best.v >= 1.5) {
    const x = nm(best.id);
    // إذا حدا قبله اتهم نفس الشخص اليوم، بيأيده بدل ما يعيد نفس الجملة
    const prev = room.chat.filter((m) => m.ch === 'public' && m.day === room.day && m.from !== b.name && m.text.includes(x)).pop();
    if (prev && Math.random() < 0.6) return pickOne([`معك حق يا ${prev.from}، ${x} مشبوه`, `أنا مع ${prev.from}، خلّينا نطلّع ${x}`, `بأيّد ${prev.from}، ${x} لازم يطلع`, `صح يا ${prev.from}، وأنا كمان لاحظت ${x}`]);
    if (best.v >= 100) return pickOne([`${x} مافيا أكيد، صوّتوا عليه`, `خلص، ${x} مكشوف، لا تضيعوا أصواتكم`]);
    const H = room.hist;
    const bad = H.votes.flatMap((r) => Object.entries(r.votes).filter(([v, t2]) => v === best.id && t2 !== 'skip' && knownTeam(room, b, getP(room, t2) || {}) === 'town').map(([, t2]) => t2));
    if (bad.length) {
      const y = nm(bad[bad.length - 1]);
      return pickOne([`${x} صوّت على ${y} وطلع صالح، هاد مشبوه`, `انتبهوا، ${x} كان مع اللي طلّعوا ${y} وهو بريء`, `أنا رح أصوّت على ${x}، تصويته على ${y} فضحه`, `مين صوّت على ${y}؟ ${x} أولهم، ركّزوا عليه`]);
    }
    return pickOne([`أنا شاكك بـ ${x}`, `${x} حركاته من أول اللعبة مش طبيعية`, `${x} بيغيّر رأيه كثير، مش مريحني`]);
  }
  if (room.mayorRevealed && getP(room, room.mayorRevealed) && getP(room, room.mayorRevealed).alive && Math.random() < 0.3) return `خلّينا نسمع رأي العمدة ${nm(room.mayorRevealed)}`;
  return pickOne(BOT_LINES).replace('{x}', pickOne(alive(room).filter((x) => x.id !== b.id)).name);
}

function botChat(room, b, replyTo) {
  if (!b.alive || !['day', 'vote', 'revenge'].includes(room.phase) || room.silenced === b.id) return;
  const say = (text) => {
    if (!text) return;
    if (room.chat.some((m) => m.ch === 'public' && m.day === room.day && m.text === text)) return; // ما بنعيد نفس الجملة
    pushChat(room, { ch: 'public', from: b.name, text, day: room.day });
    noteChat(room, b, text);
  };
  if (AI.ready()) {
    AI.talk(room, b, replyTo).then((r) => {
      if (!rooms.has(room.code) || !b.alive || room.silenced === b.id || !['day', 'vote', 'revenge'].includes(room.phase)) return;
      if (r && r.say) {
        say(r.say);
        if (r.suspect) { const q = room.players.find((x) => x.name === r.suspect); if (q) { b.brain.hints[q.id] = (b.brain.hints[q.id] || 0) + 1.2; } }
      } else say(botLine(room, b));
      broadcast(room);
    });
    return;
  }
  say(replyTo ? pickOne([`ليش بتحكي عني يا ${replyTo}؟ أنا معكم`, `${replyTo}، ركّز بالتصويتات وبتعرف مين المافيا`, `يا ${replyTo} أنا صالح والله`]) : botLine(room, b));
}

function botMayor(room, b) {
  if (b.role !== 'mayor' || !b.alive || room.mayorRevealed || room.silenced === b.id) return;
  const sc = suspicion(room, b);
  const top = argmax(sc);
  if (alive(room).length <= 6 || (top && top.v >= 2.5) || (room.day >= 3 && Math.random() < 0.5)) revealMayor(room, b);
}

function botRevenge(room, b) {
  if (room.phase !== 'revenge' || !room.revenge || room.revenge.pid !== b.id) return;
  const sc = suspicion(room, b);
  const best = argmax(sc);
  const pool = alive(room);
  if (pool.length) revengePick(room, b, best ? best.id : pickOne(pool).id);
}

// لما حدا يذكر اسم بوت بالدردشة، البوت بيرد (مرة كل 30 ثانية)
function botsHear(room, p, text) {
  for (const b of room.players) {
    if (!b.isBot || !b.alive || b.id === p.id || !text.includes(b.name)) continue;
    b.brain = b.brain || { hints: {} };
    if (Date.now() - (b.brain.lastReply || 0) < 30000) continue;
    b.brain.lastReply = Date.now();
    const stamp = room.phase + ':' + room.day;
    setTimeout(() => { if (rooms.has(room.code) && room.phase + ':' + room.day === stamp) { botChat(room, b, p.name); broadcast(room); } }, 2500 + Math.random() * 4000);
  }
}

// بداية كل مرحلة: البوتات بيبرمجوا حركتهم
function scheduleBots(room, key) {
  const bots = room.players.filter((x) => x.isBot);
  if (!bots.length) return;
  if (key === 'reveal') {
    botLater(room, 0.05, 0.15, () => {
      bots.forEach((x) => { x.ready = true; });
      if (room.players.every((x) => x.ready)) startNight(room);
    });
  } else if (key === 'night') {
    bots.forEach((b) => { if (b.alive) botLater(room, 0.15, 0.55, () => botNight(room, b)); });
  } else if (key === 'day') {
    bots.forEach((b) => {
      if (!b.alive) return;
      if (b.role === 'mayor') botLater(room, 0.1, 0.4, () => botMayor(room, b));
      if (Math.random() < 0.7) botLater(room, 0.08, 0.45, () => botChat(room, b));
      if (Math.random() < 0.35) botLater(room, 0.5, 0.85, () => botChat(room, b));
    });
  } else if (key === 'vote') {
    bots.forEach((b) => { if (b.alive) botLater(room, 0.15, 0.6, () => botVote(room, b)); });
  } else if (key === 'revenge') {
    const b = room.revenge && getP(room, room.revenge.pid);
    if (b && b.isBot) botLater(room, 0.2, 0.5, () => botRevenge(room, b));
  }
}

// ---------------- المؤقتات ----------------
function clearTimer(room) {
  clearTimeout(room.timer);
  room.timer = null; room.deadline = null; room.phaseTotal = 0;
}
function setTimer(room, key) {
  clearTimeout(room.timer);
  const sec = PACE[room.settings.pace][key] * SCALE;
  room.phaseTotal = sec;
  room.deadline = Date.now() + sec * 1000;
  const stamp = room.phase + ':' + room.day;
  room.timer = setTimeout(() => onTimeout(room, stamp), sec * 1000);
  scheduleBots(room, key);
}
// لما يخلص الوقت بننقل المرحلة لحالها — ما حدا بيقدر يعطّل اللعبة
function onTimeout(room, stamp) {
  if (!rooms.has(room.code) || room.phase + ':' + room.day !== stamp) return;
  if (room.phase === 'reveal') startNight(room);
  else if (room.phase === 'night') resolveNight(room);
  else if (room.phase === 'day') startVote(room);
  else if (room.phase === 'vote') resolveVote(room);
  else if (room.phase === 'dusk') startNight(room);
  else if (room.phase === 'revenge') finishRevenge(room);
  broadcast(room);
}
function addLog(room, icon, text) { room.log.push({ day: room.day, icon, text }); }
const roleTxt = (room, p) => (room.settings.revealOnDeath ? ` (كان ${ROLES[p.role].name})` : '');

// ---------------- مراحل اللعبة ----------------
function startGame(room) {
  const roles = shuffle(buildRoles(room.players.length, room.settings));
  room.roleList = roles.slice();
  room.players.forEach((p, i) => { p.role = roles[i]; p.alive = true; p.ready = false; p.notes = []; p.brain = { hints: {} }; });
  room.hist = { votes: [], deaths: [], talk: [], silenced: [] }; // اللي بيعرفه الكل (للبوتات)
  Object.assign(room, {
    phase: 'reveal', day: 0, night: null, votes: {}, lastEvent: null, winner: null, winnerId: null,
    sniperUsed: false, mayorRevealed: null, revenge: null, chat: [], log: [], silenced: null,
  });
  sys(room, 'بدأت اللعبة! كل واحد يشوف دوره بالسر 🤫');
  setTimer(room, 'reveal');
}

function startNight(room) {
  room.day++;
  room.phase = 'night';
  room.night = { choices: {}, silence: {} };
  room.silenced = null; // التسكيت بيخلص لما ييجي الليل
  room.votes = {};
  sys(room, `🌙 الليلة ${room.day} — المدينة نامت.`);
  setTimer(room, 'night');
}

function startDay(room) {
  room.phase = 'day';
  setTimer(room, 'day');
}

function startVote(room) {
  room.phase = 'vote';
  room.votes = {};
  sys(room, '🗳️ بلّش التصويت! مين بتشكّوا فيه؟');
  setTimer(room, 'vote');
}

// مين عنده شغل الليلة
function nightActors(room) {
  const k = killerOf(room);
  return alive(room).filter((p) =>
    p === k || p.role === 'silencer' || p.role === 'medic' || (p.role === 'sniper' && !room.sniperUsed));
}
// شو لازم يختار كل واحد بالليل
function nightNeeds(room, p) {
  const n = { kill: false, silence: false };
  if (!p.alive) return n;
  if (p === killerOf(room) || p.role === 'medic' || (p.role === 'sniper' && !room.sniperUsed)) n.kill = true;
  if (p.role === 'silencer') n.silence = true;
  return n;
}

function nightAction(room, p, target, kind) {
  if (room.phase !== 'night') throw 'مش وقت الليل';
  if (!p.alive) throw 'أنت ميت 💀';
  const need = nightNeeds(room, p);
  const t = getP(room, target);
  if (kind === 'silence') {
    if (!need.silence) throw 'التسكيت لمافيا التسكيت بس';
    if (target !== 'skip' && (!t || !t.alive)) throw 'اختيار غير صالح';
    room.night.silence[p.id] = target; // بيقدر يسكّت أي حدا، حتى حاله أو واحد من المافيا
  } else {
    if (!need.kill) throw 'ما عندك شي تعمله الليلة';
    const isKiller = p === killerOf(room);
    if (target === 'skip') {
      if (p.role !== 'sniper' || isKiller) throw 'لازم تختار حدا';
    } else {
      if (!t || !t.alive) throw 'اختيار غير صالح';
      if (isKiller && teamOf(t) === 'mafia') throw 'ما بتقدر تغتال واحد من المافيا';
      if (p.role === 'sniper' && !isKiller && t.id === p.id) throw 'ما بتقدر تقنص حالك';
    }
    room.night.choices[p.id] = target;
  }
  if (nightDone(room)) resolveNight(room);
}

// الليل بيخلص بدري لما كل واحد يختار اللي عليه
function nightDone(room) {
  return nightActors(room).every((a) => {
    const n = nightNeeds(room, a);
    return (!n.kill || a.id in room.night.choices) && (!n.silence || a.id in room.night.silence);
  });
}

function topOf(tally) {
  const keys = Object.keys(tally);
  if (!keys.length) return { max: 0, top: [] };
  const max = Math.max(...keys.map((k) => tally[k]));
  return { max, top: keys.filter((k) => tally[k] === max) };
}

function pubDead(room, p, cause) {
  return { id: p.id, name: p.name, role: room.settings.revealOnDeath ? p.role : null, cause };
}

function resolveNight(room) {
  const ch = room.night.choices;
  const killer = killerOf(room);
  const kill = killer && ch[killer.id] && ch[killer.id] !== 'skip' ? ch[killer.id] : null;
  const medic = alive(room).find((p) => p.role === 'medic');
  const save = medic ? ch[medic.id] || null : null;
  const sniper = alive(room).find((p) => p.role === 'sniper');
  const shot = sniper && !room.sniperUsed && ch[sniper.id] && ch[sniper.id] !== 'skip' ? ch[sniper.id] : null;
  const silencer = silencerOf(room);
  const sil = silencer && room.night.silence[silencer.id] && room.night.silence[silencer.id] !== 'skip' ? room.night.silence[silencer.id] : null;

  const dead = []; // [{id, cause}]
  const add = (id, cause) => { if (!dead.some((d) => d.id === id)) dead.push({ id, cause }); };
  let saved = false;
  if (kill) { if (kill === save) saved = true; else add(kill, 'kill'); }
  if (shot) {
    room.sniperUsed = true;
    const t = getP(room, shot);
    if (teamOf(t) === 'mafia') add(shot, 'sniped');
    else { add(shot, 'sniped'); add(sniper.id, 'backfire'); } // القناص أصاب صالح: بيطلعوا الاثنين
  }
  dead.forEach((d) => { getP(room, d.id).alive = false; room.hist.deaths.push({ day: room.day, id: d.id, cause: d.cause }); });

  const sp = sil && !dead.some((d) => d.id === sil) ? getP(room, sil) : null;
  room.silenced = sp ? sp.id : null;
  if (sp) room.hist.silenced.push(sp.id);
  room.lastEvent = { type: 'morning', day: room.day, killed: dead.map((d) => pubDead(room, getP(room, d.id), d.cause)), saved, silenced: sp ? { id: sp.id, name: sp.name } : null };
  room.night = null;
  sys(room, dead.length ? `☀️ طلع الصبح... ${dead.map((d) => getP(room, d.id).name).join(' و ')} طلع من اللعبة 💀` : '☀️ طلع الصبح وما طلع حدا الليلة!');
  const why = { kill: 'اغتالته المافيا', sniped: 'انقنص', backfire: 'القناص أصاب صالح فطلع معه' };
  if (dead.length) dead.forEach((d) => { const x = getP(room, d.id); addLog(room, '💀', `${x.name}: ${why[d.cause]}${roleTxt(room, x)}`); });
  else addLog(room, '🕊️', 'ليلة هادية، ما طلع حدا');
  if (saved) addLog(room, '🚑', 'الإسعاف توقّع صح وأنقذ حدا من الاغتيال');
  if (sp) { addLog(room, '🤐', `${sp.name} مسكَّت اليوم`); sys(room, `🤐 ${sp.name} مسكَّت اليوم، ما بيقدر يحكي (بس بيصوّت)`); }
  afterExit(room, dead.map((d) => d.id), 'day');
}

// بعد ما يطلع حدا: إذا الولد الصالح طلع، بيختار مين يطلع معه قبل ما نكمّل
function afterExit(room, ids, next) {
  const boy = ids.map((id) => getP(room, id)).find((p) => p && p.role === 'goodboy');
  if (boy && alive(room).length) {
    room.phase = 'revenge';
    room.revenge = { pid: boy.id, next };
    sys(room, `🧒 ${boy.name} كان الولد الصالح! بيختار شخص يطلع معه...`);
    setTimer(room, 'revenge');
    return;
  }
  continueAfter(room, next);
}
function continueAfter(room, next) {
  checkWin(room);
  if (room.phase === 'ended') return;
  if (next === 'day') startDay(room);
  else { room.phase = 'dusk'; setTimer(room, 'dusk'); }
}
function revengePick(room, p, target) {
  if (room.phase !== 'revenge' || !room.revenge || room.revenge.pid !== p.id) throw 'مش دورك';
  const t = getP(room, target);
  if (!t || !t.alive) throw 'اختيار غير صالح';
  t.alive = false;
  room.hist.deaths.push({ day: room.day, id: t.id, cause: 'revenge' });
  room.lastEvent = Object.assign({}, room.lastEvent, { revenge: { by: p.name, target: pubDead(room, t, 'revenge'), mafia: teamOf(t) === 'mafia' } });
  sys(room, `🧒 ${p.name} أخد ${t.name} معه!`);
  addLog(room, '🧒', `الولد الصالح ${p.name} أخد ${t.name} معه${roleTxt(room, t)}`);
  finishRevenge(room, true);
}
function finishRevenge(room, picked) {
  if (room.phase !== 'revenge') return;
  const next = room.revenge ? room.revenge.next : 'day';
  if (!picked) { sys(room, '🧒 الولد الصالح ما اختار حدا'); addLog(room, '🧒', 'الولد الصالح ما اختار حدا يطلع معه'); }
  room.revenge = null;
  continueAfter(room, next);
}

// العمدة بيكشف كرته: صوته بيصير بـ 3
function revealMayor(room, p) {
  if (p.role !== 'mayor') throw 'هاي للعمدة بس';
  if (!p.alive) throw 'إنت طالع من اللعبة';
  if (!['day', 'vote'].includes(room.phase)) throw 'بتقدر تكشف كرتك بالنهار بس';
  if (room.silenced === p.id) throw 'المافيا سكّتوك اليوم 🤐';
  if (room.mayorRevealed) throw 'كشفت كرتك قبل';
  room.mayorRevealed = p.id;
  sys(room, `⚖️ ${p.name} كشف كرته: هو عمدة الصالحين، وصوته صار بـ 3!`);
  addLog(room, '⚖️', `${p.name} كشف إنه عمدة الصالحين`);
}
const voteWeight = (room, p) => (p.id === room.mayorRevealed ? 3 : 1);
const canVote = (room, p) => p.alive; // المسكوت بيصوّت عادي، بس ما بيحكي

function castVote(room, p, target) {
  if (room.phase !== 'vote') throw 'التصويت مش مفتوح';
  if (!p.alive) throw 'الميت ما بيصوّت 💀';
  if (target !== 'skip') {
    const t = getP(room, target);
    if (!t || !t.alive) throw 'اختيار غير صالح';
    if (t.id === p.id) throw 'ما بتقدر تصوّت على حالك';
  }
  room.votes[p.id] = target;
  if (alive(room).filter((x) => canVote(room, x)).every((x) => x.id in room.votes)) resolveVote(room);
}

function resolveVote(room) {
  const tally = {};
  for (const [pid, t] of Object.entries(room.votes)) {
    const voter = getP(room, pid);
    if (!voter || !canVote(room, voter)) continue;
    tally[t] = (tally[t] || 0) + voteWeight(room, voter);
  }
  const { max, top } = topOf(tally);
  let out = null;
  if (max > 0 && top.length === 1 && top[0] !== 'skip') out = getP(room, top[0]);
  room.hist.votes.push({ day: room.day, votes: Object.assign({}, room.votes), out: out ? out.id : null });
  if (out) room.hist.deaths.push({ day: room.day, id: out.id, cause: 'vote' });
  room.votes = {};
  if (out) {
    out.alive = false;
    room.lastEvent = { type: 'vote', day: room.day, out: pubDead(room, out, 'vote'), tie: false };
    sys(room, `⚖️ المدينة قررت تطلّع ${out.name}`);
    addLog(room, '⚖️', `المدينة طلّعت ${out.name}${roleTxt(room, out)}`);
    afterExit(room, [out.id], 'dusk');
  } else {
    room.lastEvent = { type: 'vote', day: room.day, out: null, tie: top.length > 1 };
    sys(room, '⚖️ ما حدا طلع اليوم.');
    addLog(room, '🤝', top.length > 1 ? 'تعادل بالتصويت، ما حدا طلع' : 'المدينة تخطّت التصويت');
    continueAfter(room, 'dusk');
  }
}

// الصالحين بيفوزوا إذا طلعت كل المافيا، والمافيا بيفوزوا لما يصير عددهم قد الصالحين
function checkWin(room) {
  if (room.phase === 'ended') return;
  const a = alive(room);
  const m = a.filter((p) => teamOf(p) === 'mafia').length;
  let w = null;
  if (m === 0) w = 'town';
  else if (m >= a.length - m) w = 'mafia';
  if (w) {
    room.winner = w; room.phase = 'ended'; room.revenge = null;
    clearTimer(room);
    addLog(room, w === 'town' ? '🏙️' : '🔪', w === 'town' ? 'فاز الصالحين' : 'فازت المافيا');
    sys(room, w === 'town' ? '🏙️ فاز الصالحين! طلعت كل المافيا.' : '🔪 فازت المافيا! صار عددهم قد الصالحين.');
  }
}

function backToLobby(room) {
  room.players = room.players.filter((p) => p.conns > 0 || p.id === room.hostId || p.isBot);
  room.players.forEach((p) => { p.role = null; p.alive = true; p.ready = false; p.notes = []; });
  clearTimer(room);
  Object.assign(room, { phase: 'lobby', day: 0, night: null, votes: {}, lastEvent: null, winner: null, winnerId: null, chat: [], log: [], roleList: [], silenced: null, mayorRevealed: null, revenge: null });
}

// ---------------- الدردشة ----------------
function sys(room, text) { pushChat(room, { ch: 'system', from: null, text }); }
function pushChat(room, msg) {
  msg.id = ++room.chatSeq;
  room.chat.push(msg);
  if (room.chat.length > 150) room.chat.shift();
}
// القناة اللي بيكتب فيها اللاعب هلأ (أو null إذا مقفلة)
function chatChannel(room, p) {
  if (room.phase === 'lobby' || room.phase === 'ended') return 'public';
  if (!p.alive) return 'dead';
  if (room.phase === 'night') return teamOf(p) === 'mafia' ? 'mafia' : null;
  if (room.silenced === p.id) return null; // مسكَّت اليوم
  return 'public';
}
function canSee(room, p, ch) {
  if (ch === 'public' || ch === 'system') return true;
  const omni = room.phase === 'ended' || (room.phase !== 'lobby' && !p.alive);
  if (ch === 'mafia') return omni || teamOf(p) === 'mafia';
  if (ch === 'dead') return omni;
  return false;
}

// ---------------- اللي بيشوفه كل لاعب ----------------
function view(room, p) {
  const inGame = room.phase !== 'lobby';
  const omni = room.phase === 'ended' || (inGame && !p.alive);
  const myTeam = teamOf(p);
  const players = room.players.map((q) => {
    let role = null;
    if (inGame && q.role && (q.id === p.id || omni || (myTeam === 'mafia' && teamOf(q) === 'mafia') || (!q.alive && room.settings.revealOnDeath) || q.id === room.mayorRevealed)) role = q.role;
    return { id: q.id, name: q.name, alive: q.alive, online: q.isBot || q.conns > 0, bot: !!q.isBot, ready: q.ready, voice: q.voice && q.conns > 0, role };
  });

  let night = null;
  if (room.phase === 'night') {
    const need = nightNeeds(room, p);
    const killer = killerOf(room);
    const sil = silencerOf(room);
    night = { canAct: need.kill || need.silence, needKill: need.kill, needSilence: need.silence, isKiller: killer === p,
      myChoice: room.night.choices[p.id] || null, mySilence: room.night.silence[p.id] || null };
    if (myTeam === 'mafia' || omni) {
      night.mafia = {
        killer: killer ? killer.name : null, kill: killer ? room.night.choices[killer.id] || null : null,
        silencer: sil ? sil.name : null, silence: sil ? room.night.silence[sil.id] || null : null,
      };
    }
    if (omni) night.choices = room.night.choices;
  }

  return {
    code: room.code,
    me: { id: p.id, name: p.name, role: p.role, alive: p.alive, isHost: room.hostId === p.id },
    hostId: room.hostId,
    phase: room.phase,
    day: room.day,
    settings: room.settings,
    rolePreview: room.phase === 'lobby' && room.players.length >= MIN_PLAYERS ? buildRoles(room.players.length, room.settings) : null,
    minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS, sideMin: SIDE_MIN,
    players,
    night,
    votes: room.phase === 'vote' ? room.votes : null,
    sniperUsed: p.role === 'sniper' ? room.sniperUsed : undefined,
    mayorRevealed: room.mayorRevealed,
    revenge: room.revenge ? { pid: room.revenge.pid, name: (getP(room, room.revenge.pid) || {}).name } : null,
    lastEvent: room.lastEvent,
    silenced: room.silenced,
    now: Date.now(), deadline: room.deadline, phaseTotal: room.phaseTotal, pace: PACE,
    roleCounts: inGame ? room.roleList.reduce((m, r) => { m[r] = (m[r] || 0) + 1; return m; }, {}) : null,
    log: room.log,
    winner: room.winner, winnerId: room.winnerId,
    chatChannel: chatChannel(room, p),
    chat: room.chat.filter((m) => canSee(room, p, m.ch)).slice(-80),
    roles: ROLES, sideRoles: SIDE_ROLES,
    aiBots: AI.enabled(),
  };
}

function broadcast(room) {
  room.lastActivity = Date.now();
  for (const p of room.players) {
    const set = room.clients.get(p.id);
    if (!set || !set.size) continue;
    const data = `data: ${JSON.stringify(view(room, p))}\n\n`;
    for (const res of set) { try { res.write(data); } catch (e) {} }
  }
}

function sendTo(room, pid, event, obj) {
  const set = room.clients.get(pid);
  if (!set) return;
  const data = `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`;
  for (const res of set) { try { res.write(data); } catch (e) {} }
}

// ---------------- الـ API ----------------
function handleAction(body) {
  const { action } = body;
  if (action === 'create') {
    const name = cleanName(body.name);
    if (!name) throw 'اكتب اسمك';
    const room = newRoom();
    const p = addPlayer(room, name, body.device);
    sys(room, `${name} عمل الغرفة 👑`);
    return { code: room.code, pid: p.id, token: p.token };
  }
  const room = rooms.get(String(body.code || '').toUpperCase().trim());
  if (!room) throw 'الغرفة مش موجودة، تأكد من الكود';

  if (action === 'join') {
    const name = cleanName(body.name);
    if (!name) throw 'اكتب اسمك';
    if (room.phase !== 'lobby') throw 'اللعبة بلّشت، استنوا الجولة الجاية';
    if (room.players.length >= MAX_PLAYERS) throw 'الغرفة مليانة';
    if (room.players.some((x) => x.name === name)) throw 'الاسم مأخوذ، اختار اسم ثاني';
    if (body.device && room.players.some((x) => x.device && x.device === String(body.device).slice(0, 40))) throw 'إنت داخل هالغرفة من هالجهاز أصلاً';
    const p = addPlayer(room, name, body.device);
    sys(room, `${name} دخل الغرفة`);
    broadcast(room);
    return { code: room.code, pid: p.id, token: p.token };
  }

  const p = getP(room, body.pid);
  if (!p || p.token !== body.token) throw 'الجلسة انتهت';
  const isHost = room.hostId === p.id;
  const hostOnly = () => { if (!isHost) throw 'هاي للمضيف بس'; };

  switch (action) {
    case 'resume': return { ok: true, code: room.code };
    case 'hb': return { ok: true }; // نبضة من اللاعب عشان السيرفر ما ينام
    case 'signal': {
      // رسائل ربط الصوت (WebRTC) بين لاعبين — بنوصلها للشخص المقصود بس
      const t = getP(room, body.to);
      if (!t || t.id === p.id) return { ok: true };
      sendTo(room, t.id, 'signal', { from: p.id, vs: String(body.vs || ''), data: body.data });
      return { ok: true };
    }
    case 'voice': {
      p.voice = !!body.on;
      break;
    }
    case 'settings': {
      hostOnly();
      if (room.phase !== 'lobby') throw 'ما بتقدر تغيّر وقت اللعب';
      const s = body.settings || {};
      if (s.sideMode === 'auto' || s.sideMode === 'custom') room.settings.sideMode = s.sideMode;
      if (s.side) for (const r of SIDE_ROLES) if (r in s.side) room.settings.side[r] = !!s.side[r];
      if ('revealOnDeath' in s) room.settings.revealOnDeath = !!s.revealOnDeath;
      if (s.pace in PACE) room.settings.pace = s.pace;
      break;
    }
    case 'addBot': { hostOnly(); addBot(room); break; }
    case 'removeBots': {
      hostOnly();
      if (room.phase !== 'lobby') throw 'بس قبل ما تبدأ اللعبة';
      room.players.filter((x) => x.isBot).forEach((x) => removePlayer(room, x.id));
      sys(room, '🤖 المضيف شال البوتات');
      break;
    }
    case 'kick': {
      hostOnly();
      if (room.phase !== 'lobby') throw 'بس قبل ما تبدأ اللعبة';
      const t = getP(room, body.target);
      if (!t || t.id === p.id) throw 'اختيار غير صالح';
      removePlayer(room, t.id);
      sys(room, `${t.name} انطرد من الغرفة`);
      break;
    }
    case 'leave': {
      if (room.phase === 'lobby' || room.phase === 'ended') {
        removePlayer(room, p.id);
        sys(room, `${p.name} طلع من الغرفة`);
      }
      break;
    }
    case 'start': {
      hostOnly();
      if (room.phase !== 'lobby') throw 'اللعبة شغالة';
      if (room.players.length < MIN_PLAYERS) throw `لازم ${MIN_PLAYERS} لاعبين على الأقل`;
      startGame(room);
      break;
    }
    case 'ready': {
      if (room.phase !== 'reveal') break;
      p.ready = true;
      if (room.players.every((x) => x.ready)) startNight(room);
      break;
    }
    case 'night': nightAction(room, p, body.target, body.kind === 'silence' ? 'silence' : 'kill'); break;
    case 'revealMayor': revealMayor(room, p); break;
    case 'revenge': revengePick(room, p, body.target); break;
    case 'startVote': {
      hostOnly();
      if (room.phase !== 'day') throw 'مش وقت التصويت';
      startVote(room);
      break;
    }
    case 'extend': {
      hostOnly();
      if (room.phase !== 'day' || !room.deadline) throw 'بس وقت النقاش';
      const left = room.deadline - Date.now() + 30000;
      clearTimeout(room.timer);
      room.deadline = Date.now() + left;
      room.phaseTotal = Math.round(Math.max(room.phaseTotal, left / 1000));
      const stamp = room.phase + ':' + room.day;
      room.timer = setTimeout(() => onTimeout(room, stamp), left);
      sys(room, '⏱️ المضيف زاد 30 ثانية للنقاش');
      break;
    }
    case 'vote': castVote(room, p, body.target); break;
    case 'restart': {
      hostOnly();
      if (room.phase !== 'ended') throw 'اللعبة لسا ما خلصت';
      backToLobby(room);
      break;
    }
    case 'chat': {
      const text = String(body.text || '').trim().slice(0, 200);
      if (!text) break;
      const ch = chatChannel(room, p);
      if (!ch) throw room.silenced === p.id ? 'مافيا التسكيت سكّتك، ما بتقدر تحكي اليوم 🤐' : 'الدردشة مقفلة بالليل 🤫';
      pushChat(room, { ch, from: p.name, text, day: room.day });
      if (ch === 'public' && room.hist && room.phase !== 'lobby' && room.phase !== 'ended') { noteChat(room, p, text); botsHear(room, p, text); }
      break;
    }
    default: throw 'طلب غير معروف';
  }
  if (rooms.has(room.code)) broadcast(room);
  return { ok: true };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 100000) { reject(new Error('too big')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// ---------------- البث المباشر (SSE) ----------------
function handleEvents(req, res, url) {
  const room = rooms.get(url.searchParams.get('code') || '');
  const p = room && getP(room, url.searchParams.get('pid'));
  if (!p || p.token !== url.searchParams.get('token')) { res.writeHead(404); return res.end(); }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  if (!room.clients.has(p.id)) room.clients.set(p.id, new Set());
  room.clients.get(p.id).add(res);
  p.conns++;
  broadcast(room);
  req.on('close', () => {
    const set = room.clients.get(p.id);
    if (set && set.delete(res)) {
      p.conns = Math.max(0, p.conns - 1);
      if (p.conns === 0) p.voice = false;
      if (rooms.has(room.code)) broadcast(room);
    }
  });
}

// ---------------- الملفات ----------------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
function serveStatic(pathname, res) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (rel === '/') rel = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('مش موجود'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------------- سيرفرات الصوت (STUN/TURN) ----------------
// إذا حطيت متغير TURN_CREDENTIALS_URL على Render (رابط Open Relay من metered.ca)
// بنجيب منه سيرفرات TURN عشان الصوت يشتغل حتى على الشبكات الصعبة.
const STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
let iceCache = { at: 0, list: null };
async function getIceServers() {
  const url = process.env.TURN_CREDENTIALS_URL;
  if (!url) return STUN;
  if (iceCache.list && Date.now() - iceCache.at < 60 * 60 * 1000) return iceCache.list;
  try {
    const r = await fetch(url);
    const list = await r.json();
    if (Array.isArray(list) && list.length) { iceCache = { at: Date.now(), list: STUN.concat(list) }; return iceCache.list; }
  } catch (e) { console.error('TURN fetch failed', e.message); }
  return STUN;
}

// ---------------- تشغيل السيرفر ----------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/events') return handleEvents(req, res, url);
  if (url.pathname === '/ice') return sendJson(res, 200, await getIceServers());
  if (url.pathname === '/ai-status') return sendJson(res, 200, AI.status());
  if (url.pathname === '/api' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      sendJson(res, 200, handleAction(body));
    } catch (e) {
      sendJson(res, 200, { error: typeof e === 'string' ? e : 'صار خطأ، جرّب كمان مرة' });
      if (typeof e !== 'string') console.error(e);
    }
    return;
  }
  serveStatic(url.pathname, res);
});

// نبضة كل 20 ثانية عشان الاتصال ما ينقطع
setInterval(() => {
  for (const room of rooms.values()) for (const set of room.clients.values()) for (const res of set) { try { res.write('event: ping\ndata: 1\n\n'); } catch (e) {} }
}, 15000);
// تنظيف الغرف الفاضية كل 5 دقايق
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.players.every((p) => p.conns === 0) && now - room.lastActivity > 30 * 60 * 1000) rooms.delete(room.code);
  }
}, 5 * 60 * 1000);

if (require.main === module) {
  server.listen(PORT, () => {
    console.log('\n🔪  لعبة المافيا شغالة!');
    console.log(`   على جهازك:      http://localhost:${PORT}`);
    for (const list of Object.values(os.networkInterfaces())) {
      for (const n of list || []) if (n.family === 'IPv4' && !n.internal) console.log(`   على نفس الشبكة: http://${n.address}:${PORT}`);
    }
    console.log('');
  });
}

module.exports = { server, buildRoles, rooms };
