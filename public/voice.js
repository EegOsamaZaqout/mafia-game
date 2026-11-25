// =====================================================
//  الصوت المباشر جوّا اللعبة (WebRTC — كل لاعب متصل بالباقي مباشرة)
//  القواعد:
//   • اللوبي ونهاية اللعبة: الكل بيسمع الكل
//   • النهار والتصويت: العايشين بيحكوا والكل بيسمع
//   • الليل: المافيا بيسمعوا بعض بس، والباقي ما بيسمعوا ولا بيحكوا
//   • الأموات: بيحكوا مع الأموات بس، وبيسمعوا العايشين (وبالليل بيسمعوا المافيا)
// =====================================================
'use strict';

const Voice = (() => {
  const vs = Math.random().toString(36).slice(2, 10); // رقم جلسة الصوت لهالصفحة
  const peers = new Map(); // playerId -> { pc, vs, tx, audio, pending, an, buf, speaking }
  const early = new Map(); // ICE candidates وصلت قبل ما نعمل الاتصال
  const creating = new Set();
  const self = { an: null, buf: null, speaking: false };
  let st = null;
  let joined = false;
  let joining = false;
  let muted = false;
  let stream = null;
  let track = null;
  let ice = null;
  let audioCtx = null;
  let blocked = false;
  let autoTried = false;
  let lastBarHtml = '';

  const bar = () => document.getElementById('voiceBar');
  const sig = (to, data) => api('signal', { to, vs, data }).catch(() => {});

  async function getIce() {
    if (ice) return ice;
    try { ice = await fetch('/ice').then((r) => r.json()); }
    catch (e) { ice = [{ urls: 'stun:stun.l.google.com:19302' }]; }
    return ice;
  }

  // ---------- مين بيسمع مين ----------
  const isMafia = (role) => !!(role && st.roles[role] && st.roles[role].team === 'mafia');
  const open = () => st.phase === 'lobby' || st.phase === 'ended';
  function canSpeakTo(o) {
    const me = st.me;
    if (open()) return true;
    if (!me.alive) return !o.alive;
    if (st.phase === 'night') return isMafia(me.role) && (!o.alive || isMafia(o.role));
    return true;
  }
  function canHear(o) {
    const me = st.me;
    if (open()) return true;
    if (!o.alive) return !me.alive;
    if (st.phase === 'night') return me.alive ? isMafia(me.role) && isMafia(o.role) : isMafia(o.role);
    return true;
  }
  const P = (id) => st.players.find((p) => p.id === id);

  // ---------- الاتصالات ----------
  function wanted() {
    if (!joined || !st) return [];
    return st.players.filter((p) => p.id !== st.me.id && p.voice && p.online);
  }

  async function sync() {
    if (!st) return;
    const want = new Set(wanted().map((p) => p.id));
    for (const pid of [...peers.keys()]) if (!want.has(pid)) closePeer(pid);
    for (const pid of want) {
      if (!peers.has(pid) && !creating.has(pid) && st.me.id < pid) {
        creating.add(pid);
        try { await createPeer(pid, null, true); } catch (e) { console.warn('voice peer', e); }
        finally { creating.delete(pid); }
      }
    }
    applyRouting();
    renderBar();
  }

  async function createPeer(pid, remoteVs, initiator) {
    const pc = new RTCPeerConnection({ iceServers: await getIce() });
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.playsInline = true;
    audio.style.display = 'none';
    document.body.appendChild(audio);
    const peer = { pc, vs: remoteVs, tx: null, audio, pending: early.get(pid) || [], speaking: false, an: null, buf: null };
    early.delete(pid);
    peers.set(pid, peer);

    pc.onicecandidate = (e) => { if (e.candidate) sig(pid, { cand: e.candidate }); };
    pc.ontrack = (e) => {
      const ms = (e.streams && e.streams[0]) || new MediaStream([e.track]);
      audio.srcObject = ms;
      playAudio(audio);
      attachAnalyser(peer, ms);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        closePeer(pid);
        if (initiator) setTimeout(sync, 1500);
      }
      renderBar();
    };

    if (initiator) {
      peer.tx = pc.addTransceiver('audio', { direction: 'sendrecv', streams: stream ? [stream] : [] });
      await peer.tx.sender.replaceTrack(sendTrackFor(pid));
      await pc.setLocalDescription(await pc.createOffer());
      sig(pid, { sdp: pc.localDescription });
    }
    return peer;
  }

  function closePeer(pid) {
    const peer = peers.get(pid);
    if (!peer) return;
    try { peer.pc.close(); } catch (e) {}
    try { peer.audio.srcObject = null; peer.audio.remove(); } catch (e) {}
    peers.delete(pid);
  }

  async function flush(peer) {
    const list = peer.pending.splice(0);
    for (const c of list) { try { await peer.pc.addIceCandidate(c); } catch (e) {} }
  }

  async function onSignal(msg) {
    if (!joined || !st) return;
    const { from, data } = msg;
    const rvs = msg.vs;
    let peer = peers.get(from);
    try {
      if (data.sdp && data.sdp.type === 'offer') {
        if (peer) { closePeer(from); peer = null; } // عرض جديد = الطرف الثاني عمل رفرش
        peer = await createPeer(from, rvs, false);
        await peer.pc.setRemoteDescription(data.sdp);
        peer.tx = peer.pc.getTransceivers()[0];
        if (peer.tx) {
          peer.tx.direction = 'sendrecv';
          await peer.tx.sender.replaceTrack(sendTrackFor(from));
        }
        await peer.pc.setLocalDescription(await peer.pc.createAnswer());
        sig(from, { sdp: peer.pc.localDescription });
        await flush(peer);
        applyRouting();
      } else if (data.sdp && data.sdp.type === 'answer') {
        if (!peer || peer.pc.signalingState !== 'have-local-offer') return;
        peer.vs = rvs;
        await peer.pc.setRemoteDescription(data.sdp);
        await flush(peer);
      } else if (data.cand) {
        if (!peer) {
          if (!early.has(from)) early.set(from, []);
          early.get(from).push(data.cand);
        } else if (!peer.pc.remoteDescription) {
          peer.pending.push(data.cand);
        } else {
          try { await peer.pc.addIceCandidate(data.cand); } catch (e) {}
        }
      }
    } catch (e) { console.warn('voice signal', e); }
  }

  // ---------- توجيه الصوت حسب مرحلة اللعبة ----------
  function sendTrackFor(pid) {
    const o = st && P(pid);
    return o && canSpeakTo(o) ? track : null;
  }
  function applyRouting() {
    if (!st) return;
    for (const [pid, peer] of peers) {
      const o = P(pid);
      if (!o) continue;
      const send = canSpeakTo(o) ? track : null;
      if (peer.tx && peer.tx.sender.track !== send) peer.tx.sender.replaceTrack(send).catch(() => {});
      peer.audio.muted = !canHear(o);
    }
  }

  // ---------- مؤشر مين عم يحكي ----------
  function ensureCtx() {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!audioCtx && C) audioCtx = new C();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  }
  function attachAnalyser(obj, ms) {
    if (!audioCtx) return;
    try {
      const src = audioCtx.createMediaStreamSource(ms);
      const an = audioCtx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      obj.an = an;
      obj.buf = new Uint8Array(an.fftSize);
    } catch (e) {}
  }
  function level(obj) {
    if (!obj.an) return 0;
    obj.an.getByteTimeDomainData(obj.buf);
    let sum = 0;
    for (const v of obj.buf) { const d = v - 128; sum += d * d; }
    return Math.sqrt(sum / obj.buf.length);
  }
  setInterval(() => {
    if (!joined) return;
    let changed = false;
    const check = (obj, on) => {
      const sp = on && level(obj) > 5;
      if (sp !== obj.speaking) { obj.speaking = sp; changed = true; }
    };
    check(self, !muted && track && track.enabled);
    for (const [pid, peer] of peers) { const o = st && P(pid); check(peer, !!o && canHear(o)); }
    if (changed) renderBar();
  }, 200);

  function playAudio(a) {
    const p = a.play();
    if (p && p.catch) p.catch(() => { blocked = true; renderBar(); });
  }

  // ---------- انضمام / خروج ----------
  async function join(auto) {
    if (joined || joining) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.RTCPeerConnection) {
      if (!auto) toast('متصفحك ما بيدعم الصوت، جرّب Chrome');
      return;
    }
    joining = true;
    renderBar();
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false,
      });
    } catch (e) {
      joining = false;
      renderBar();
      if (!auto) toast('لازم تسمح للمتصفح يستخدم المايك 🎙️');
      return;
    }
    track = stream.getAudioTracks()[0];
    track.enabled = !muted;
    ensureCtx();
    attachAnalyser(self, stream);
    await getIce();
    joined = true;
    joining = false;
    try { sessionStorage.setItem('voiceOn', '1'); } catch (e) {}
    await api('voice', { on: true });
    sync();
  }

  function leave(silent) {
    joined = false;
    joining = false;
    for (const pid of [...peers.keys()]) closePeer(pid);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null; track = null; self.an = null; self.speaking = false;
    try { sessionStorage.removeItem('voiceOn'); } catch (e) {}
    if (!silent) api('voice', { on: false });
    renderBar();
  }

  function toggleMute() {
    muted = !muted;
    if (track) track.enabled = !muted;
    renderBar();
  }

  function unblock() {
    ensureCtx();
    blocked = false;
    for (const peer of peers.values()) playAudio(peer.audio);
    renderBar();
  }

  // ---------- الواجهة ----------
  function statusText() {
    const me = st.me;
    if (open()) return '🔊 الكل بيسمع الكل';
    if (!me.alive) return st.phase === 'night' ? '👻 بتحكي مع الأموات، وبتسمع المافيا' : '👻 بتحكي مع الأموات بس، وبتسمع الكل';
    if (st.phase === 'night') return isMafia(me.role) ? '🔪 الليل: بتحكي مع المافيا بس' : '🌙 الليل: الصوت مقفول... نام 😴';
    return '☀️ الكل بيسمع الكل';
  }

  // زر المايك الصغير بالشريط العلوي
  function paintMic() {
    const b = document.getElementById('micPill');
    if (!b) return;
    b.classList.toggle('hidden', !joined);
    b.classList.toggle('on', joined && !muted);
    b.textContent = muted ? '🔇' : '🎙️';
    b.setAttribute('aria-label', muted ? 'شغّل المايك' : 'سكّر المايك');
  }

  function renderBar() {
    paintMic();
    const el = bar();
    if (!el) return;
    if (!st) { el.classList.add('hidden'); lastBarHtml = ''; return; }
    el.classList.remove('hidden');
    const inVoice = st.players.filter((p) => p.voice && p.online);
    let html;
    if (!joined) {
      html = `<button class="btn sm red" data-vact="join" ${joining ? 'disabled' : ''}>${joining ? 'جاري الاتصال...' : '🎙️ انضم للصوت'}</button>
        <span class="vnote">${inVoice.length ? `${inVoice.length} بالصوت: ${inVoice.map((p) => esc(p.name)).join('، ')}` : 'ما حدا بالصوت لسا'}</span>`;
    } else {
      const chips = [`<span class="vchip me ${self.speaking ? 'talk' : ''}">${muted ? '🔇' : '🎙️'} أنت</span>`];
      for (const p of st.players) {
        if (p.id === st.me.id || !(p.voice && p.online)) continue;
        const peer = peers.get(p.id);
        const state = peer ? peer.pc.connectionState : 'new';
        const ok = state === 'connected';
        const heard = canHear(p);
        chips.push(`<span class="vchip ${peer && peer.speaking ? 'talk' : ''} ${heard ? '' : 'off'} ${ok ? '' : 'wait'}" title="${ok ? '' : 'جاري الاتصال...'}">${ok ? (heard ? '🔊' : '🔈') : '⏳'} ${esc(p.name)}</span>`);
      }
      html = `<button class="btn sm ${muted ? 'line' : ''}" data-vact="mute">${muted ? '🔇 المايك مسكّر' : '🎙️ المايك شغال'}</button>
        <button class="btn sm line" data-vact="leave">اطلع من الصوت</button>
        ${blocked ? '<button class="btn sm red" data-vact="unblock">🔈 شغّل الصوت</button>' : ''}
        <span class="vstatus">${statusText()}</span>
        <div class="vchips">${chips.join('')}</div>`;
    }
    if (html !== lastBarHtml) { el.innerHTML = html; lastBarHtml = html; }
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-vact]');
    if (!b) return;
    const a = b.dataset.vact;
    if (a === 'join') join(false);
    else if (a === 'leave') leave(false);
    else if (a === 'mute') toggleMute();
    else if (a === 'unblock') unblock();
  });
  // أول لمسة على الصفحة بتفك حظر تشغيل الصوت بالموبايل
  document.addEventListener('pointerdown', () => { if (blocked) unblock(); else if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {}); });

  function onState(s) {
    st = s;
    if (!autoTried) {
      autoTried = true;
      let was = false;
      try { was = sessionStorage.getItem('voiceOn') === '1'; } catch (e) {}
      if (was) join(true); // رجّعه للصوت بعد الرفرش
    }
    if (joined) sync(); else renderBar();
  }

  function reset() { leave(true); st = null; autoTried = false; renderBar(); }

  return { onState, onSignal, reset, paintMic };
})();
window.Voice = Voice;
