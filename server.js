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
  mafia:     { name: 'مافيا',        team: 'mafia',   icon: '🔪', side: false,
               desc: 'كل ليلة بتتفق مع باقي المافيا على شخص تقتلوه. بتفوزوا لما يصير عددكم مساوي أو أكثر من الباقيين.' },
  godfather: { name: 'زعيم المافيا', team: 'mafia',   icon: '🎩', side: true,
               desc: 'أنت من المافيا وبتختار الضحية معهم، بس لما المحقق يفحصك بتطلعله بريء.' },
  doctor:    { name: 'الطبيب',       team: 'town',    icon: '💉', side: false,
               desc: 'كل ليلة بتختار شخص تحميه من القتل. بتقدر تحمي حالك مرة وحدة بس باللعبة كلها.' },
  detective: { name: 'المحقق',       team: 'town',    icon: '🔍', side: false,
               desc: 'كل ليلة بتفحص شخص وبتعرف إذا هو مافيا ولا بريء. النتيجة بتوصلك لحالك.' },
  sniper:    { name: 'القناص',       team: 'town',    icon: '🎯', side: true,
               desc: 'معك رصاصة وحدة باللعبة كلها، بتقدر تطلقها بأي ليلة. انتبه لا تقتل واحد بريء!' },
  mayor:     { name: 'العمدة',       team: 'town',    icon: '⚖️', side: true,
               desc: 'مواطن من المدينة، بس صوتك بالتصويت بالنهار بيتحسب صوتين.' },
  jester:    { name: 'المهرج',       team: 'neutral', icon: '🃏', side: true,
               desc: 'ما إلك فريق. بتفوز لحالك إذا صوّتوا عليك وطلّعوك بالنهار. خلّيهم يشكّوا فيك!' },
  citizen:   { name: 'مواطن',        team: 'town',    icon: '👤', side: false,
               desc: 'ما عندك قدرة خاصة. ركّز بالنقاش واكشف المافيا بالتصويت.' },
};
const SIDE_ROLES = ['godfather', 'sniper', 'mayor', 'jester'];
// أقل عدد لاعبين لتدخل كل شخصية جانبية تلقائياً
const SIDE_MIN = { godfather: 7, sniper: 8, mayor: 9, jester: 10 };

function mafiaCount(n) {
  if (n <= 5) return 1;
  if (n <= 8) return 2;
  if (n <= 11) return 3;
  if (n <= 15) return 4;
  return 5;
}

// بيرجع قائمة الأدوار حسب عدد اللاعبين والإعدادات
function buildRoles(n, settings) {
  const on = (r) => settings.sideMode === 'auto' ? n >= SIDE_MIN[r] : !!settings.side[r];
  let m = mafiaCount(n);
  const list = [];
  if (on('godfather')) { list.push('godfather'); m--; }
  for (let i = 0; i < m; i++) list.push('mafia');
  list.push('doctor', 'detective');
  const extras = ['sniper', 'mayor', 'jester'].filter(on);
  // إذا العدد ما بيكفي، بنشيل الجانبية من الآخر
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
    settings: { sideMode: 'auto', side: { godfather: true, sniper: true, mayor: true, jester: true }, revealOnDeath: true },
    day: 0,
    night: null,
    votes: {},
    lastEvent: null,
    winner: null,
    winnerId: null,
    doctorSelfUsed: false,
    sniperUsed: false,
    chat: [],
    chatSeq: 0,
    clients: new Map(), // playerId -> Set(res)
    lastActivity: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

function addPlayer(room, name) {
  const p = { id: rid(), token: rid() + rid(), name, role: null, alive: true, ready: false, notes: [], conns: 0 };
  room.players.push(p);
  if (!room.hostId) room.hostId = p.id;
  return p;
}

function removePlayer(room, id) {
  room.players = room.players.filter((p) => p.id !== id);
  const set = room.clients.get(id);
  if (set) for (const res of set) { try { res.write('event: kicked\ndata: {}\n\n'); res.end(); } catch (e) {} }
  room.clients.delete(id);
  if (room.hostId === id) room.hostId = room.players[0] ? room.players[0].id : null;
  if (!room.players.length) rooms.delete(room.code);
}

// ---------------- مراحل اللعبة ----------------
function startGame(room) {
  const roles = shuffle(buildRoles(room.players.length, room.settings));
  room.players.forEach((p, i) => { p.role = roles[i]; p.alive = true; p.ready = false; p.notes = []; });
  Object.assign(room, {
    phase: 'reveal', day: 0, night: null, votes: {}, lastEvent: null, winner: null, winnerId: null,
    doctorSelfUsed: false, sniperUsed: false, chat: [],
  });
  sys(room, 'بدأت اللعبة! كل واحد يشوف دوره بالسر 🤫');
}

function startNight(room) {
  room.day++;
  room.phase = 'night';
  room.night = { choices: {} };
  room.votes = {};
  sys(room, `🌙 الليلة ${room.day} — المدينة نامت.`);
}

function nightActors(room) {
  return alive(room).filter((p) =>
    teamOf(p) === 'mafia' || p.role === 'doctor' || p.role === 'detective' || (p.role === 'sniper' && !room.sniperUsed));
}

function nightAction(room, p, target) {
  if (room.phase !== 'night') throw 'مش وقت الليل';
  if (!p.alive) throw 'أنت ميت 💀';
  if (!nightActors(room).includes(p)) throw 'ما عندك شي تعمله الليلة';
  const t = getP(room, target);
  if (target === 'skip') {
    if (p.role !== 'sniper') throw 'لازم تختار حدا';
  } else {
    if (!t || !t.alive) throw 'اختيار غير صالح';
    if (teamOf(p) === 'mafia' && teamOf(t) === 'mafia') throw 'ما بتقدر تقتل واحد من المافيا';
    if ((p.role === 'detective' || p.role === 'sniper') && t.id === p.id) throw 'ما بتقدر تختار حالك';
    if (p.role === 'doctor' && t.id === p.id && room.doctorSelfUsed) throw 'حميت حالك قبل، ما بتقدر مرة ثانية';
  }
  room.night.choices[p.id] = target;
  if (nightActors(room).every((a) => a.id in room.night.choices)) resolveNight(room);
}

function topOf(tally) {
  const keys = Object.keys(tally);
  if (!keys.length) return { max: 0, top: [] };
  const max = Math.max(...keys.map((k) => tally[k]));
  return { max, top: keys.filter((k) => tally[k] === max) };
}

function pubDead(room, p) {
  return { id: p.id, name: p.name, role: room.settings.revealOnDeath ? p.role : null };
}

function resolveNight(room) {
  const ch = room.night.choices;
  const a = alive(room);
  // المافيا: الأغلبية، وإذا تعادل بنختار عشوائي من المتعادلين
  const tally = {};
  a.filter((p) => teamOf(p) === 'mafia').forEach((p) => {
    const t = ch[p.id];
    if (t && t !== 'skip') tally[t] = (tally[t] || 0) + 1;
  });
  const { top } = topOf(tally);
  const mafiaTarget = top.length ? top[crypto.randomInt(top.length)] : null;

  const doctor = a.find((p) => p.role === 'doctor');
  const save = doctor ? ch[doctor.id] || null : null;
  if (doctor && save === doctor.id) room.doctorSelfUsed = true;

  const sniper = a.find((p) => p.role === 'sniper');
  let shot = null;
  if (sniper && !room.sniperUsed && ch[sniper.id] && ch[sniper.id] !== 'skip') { shot = ch[sniper.id]; room.sniperUsed = true; }

  const detective = a.find((p) => p.role === 'detective');
  if (detective && ch[detective.id]) {
    const t = getP(room, ch[detective.id]);
    const isMafia = teamOf(t) === 'mafia' && t.role !== 'godfather';
    detective.notes.push({ day: room.day, name: t.name, result: isMafia ? 'mafia' : 'innocent' });
  }

  const deaths = new Set();
  let saved = false;
  if (mafiaTarget) { if (mafiaTarget === save) saved = true; else deaths.add(mafiaTarget); }
  if (shot) { if (shot === save) saved = true; else deaths.add(shot); }
  deaths.forEach((id) => { getP(room, id).alive = false; });

  room.lastEvent = { type: 'morning', day: room.day, killed: [...deaths].map((id) => pubDead(room, getP(room, id))), saved };
  room.night = null;
  room.phase = 'day';
  sys(room, deaths.size ? `☀️ طلع الصبح... ${[...deaths].map((id) => getP(room, id).name).join(' و ')} ما صحي 💀` : '☀️ طلع الصبح وما مات حدا الليلة!');
  checkWin(room);
}

function castVote(room, p, target) {
  if (room.phase !== 'vote') throw 'التصويت مش مفتوح';
  if (!p.alive) throw 'الميت ما بيصوّت 💀';
  if (target !== 'skip') {
    const t = getP(room, target);
    if (!t || !t.alive) throw 'اختيار غير صالح';
    if (t.id === p.id) throw 'ما بتقدر تصوّت على حالك';
  }
  room.votes[p.id] = target;
  if (alive(room).every((x) => x.id in room.votes)) resolveVote(room);
}

function resolveVote(room) {
  const tally = {};
  for (const [pid, t] of Object.entries(room.votes)) {
    const voter = getP(room, pid);
    if (!voter || !voter.alive) continue;
    tally[t] = (tally[t] || 0) + (voter.role === 'mayor' ? 2 : 1);
  }
  const { max, top } = topOf(tally);
  let out = null;
  if (max > 0 && top.length === 1 && top[0] !== 'skip') out = getP(room, top[0]);
  room.votes = {};
  if (out) {
    out.alive = false;
    room.lastEvent = { type: 'vote', day: room.day, out: pubDead(room, out), tie: false };
    sys(room, `⚖️ المدينة قررت تطلّع ${out.name}`);
    if (out.role === 'jester') {
      room.winner = 'jester'; room.winnerId = out.id; room.phase = 'ended';
      sys(room, `🃏 ${out.name} كان المهرج وضحك على الكل!`);
      return;
    }
  } else {
    room.lastEvent = { type: 'vote', day: room.day, out: null, tie: top.length > 1 };
    sys(room, '⚖️ ما حدا طلع اليوم.');
  }
  room.phase = 'dusk';
  checkWin(room);
}

function checkWin(room) {
  if (room.phase === 'ended') return;
  const a = alive(room);
  const m = a.filter((p) => teamOf(p) === 'mafia').length;
  let w = null;
  if (m === 0) w = 'town';
  else if (m >= a.length - m) w = 'mafia';
  if (w) {
    room.winner = w; room.phase = 'ended';
    sys(room, w === 'town' ? '🏙️ فازت المدينة! انكشفت كل المافيا.' : '🔪 فازت المافيا! سيطروا على المدينة.');
  }
}

function backToLobby(room) {
  room.players = room.players.filter((p) => p.conns > 0 || p.id === room.hostId);
  room.players.forEach((p) => { p.role = null; p.alive = true; p.ready = false; p.notes = []; });
  Object.assign(room, { phase: 'lobby', day: 0, night: null, votes: {}, lastEvent: null, winner: null, winnerId: null, chat: [] });
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
    if (inGame && q.role && (q.id === p.id || omni || (myTeam === 'mafia' && teamOf(q) === 'mafia') || (!q.alive && room.settings.revealOnDeath))) role = q.role;
    return { id: q.id, name: q.name, alive: q.alive, online: q.conns > 0, ready: q.ready, role };
  });

  let night = null;
  if (room.phase === 'night') {
    const actors = nightActors(room);
    night = { canAct: actors.includes(p), myChoice: room.night.choices[p.id] || null };
    if (myTeam === 'mafia' || omni) {
      night.mafiaVotes = alive(room).filter((x) => teamOf(x) === 'mafia').map((x) => ({ id: x.id, name: x.name, target: room.night.choices[x.id] || null }));
    }
    if (omni) night.choices = room.night.choices;
  }

  return {
    code: room.code,
    me: { id: p.id, name: p.name, role: p.role, alive: p.alive, notes: p.notes, isHost: room.hostId === p.id },
    hostId: room.hostId,
    phase: room.phase,
    day: room.day,
    settings: room.settings,
    rolePreview: room.phase === 'lobby' && room.players.length >= MIN_PLAYERS ? buildRoles(room.players.length, room.settings) : null,
    minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS, sideMin: SIDE_MIN,
    players,
    night,
    votes: room.phase === 'vote' ? room.votes : null,
    doctorSelfUsed: p.role === 'doctor' ? room.doctorSelfUsed : undefined,
    sniperUsed: p.role === 'sniper' ? room.sniperUsed : undefined,
    lastEvent: room.lastEvent,
    winner: room.winner, winnerId: room.winnerId,
    chatChannel: chatChannel(room, p),
    chat: room.chat.filter((m) => canSee(room, p, m.ch)).slice(-80),
    roles: ROLES, sideRoles: SIDE_ROLES,
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

// ---------------- الـ API ----------------
function handleAction(body) {
  const { action } = body;
  if (action === 'create') {
    const name = cleanName(body.name);
    if (!name) throw 'اكتب اسمك';
    const room = newRoom();
    const p = addPlayer(room, name);
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
    const p = addPlayer(room, name);
    sys(room, `${name} دخل الغرفة`);
    broadcast(room);
    return { code: room.code, pid: p.id, token: p.token };
  }

  const p = getP(room, body.pid);
  if (!p || p.token !== body.token) throw 'الجلسة انتهت';
  const isHost = room.hostId === p.id;
  const hostOnly = () => { if (!isHost) throw 'هاي للمضيف بس'; };

  switch (action) {
    case 'resume': return { code: room.code };
    case 'settings': {
      hostOnly();
      if (room.phase !== 'lobby') throw 'ما بتقدر تغيّر وقت اللعب';
      const s = body.settings || {};
      if (s.sideMode === 'auto' || s.sideMode === 'custom') room.settings.sideMode = s.sideMode;
      if (s.side) for (const r of SIDE_ROLES) if (r in s.side) room.settings.side[r] = !!s.side[r];
      if ('revealOnDeath' in s) room.settings.revealOnDeath = !!s.revealOnDeath;
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
    case 'night': nightAction(room, p, body.target); break;
    case 'startVote': {
      hostOnly();
      if (room.phase !== 'day') throw 'مش وقت التصويت';
      room.phase = 'vote'; room.votes = {};
      sys(room, '🗳️ بلّش التصويت! مين بتشكّوا فيه؟');
      break;
    }
    case 'vote': castVote(room, p, body.target); break;
    case 'startNight': {
      hostOnly();
      if (room.phase !== 'dusk') throw 'مش وقت الليل';
      startNight(room);
      break;
    }
    case 'force': {
      hostOnly();
      if (room.phase === 'reveal') startNight(room);
      else if (room.phase === 'night') resolveNight(room);
      else if (room.phase === 'vote') resolveVote(room);
      break;
    }
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
      if (!ch) throw 'الدردشة مقفلة بالليل 🤫';
      pushChat(room, { ch, from: p.name, text });
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
    req.on('data', (c) => { data += c; if (data.length > 10000) { reject(new Error('too big')); req.destroy(); } });
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

// ---------------- تشغيل السيرفر ----------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/events') return handleEvents(req, res, url);
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
  for (const room of rooms.values()) for (const set of room.clients.values()) for (const res of set) { try { res.write(': ping\n\n'); } catch (e) {} }
}, 20000);
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
