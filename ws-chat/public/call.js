import { settings, applySink } from './settings.js';

const RTC_CONFIG = { iceServers: [] };
const RING_TIMEOUT_MS = 30000;
// Сколько ждать восстановления ICE, прежде чем считать звонок оборванным.
const DROP_GRACE_MS = 8000;
const STATS_MS = 1000;
const SPEAK_THRESHOLD = 0.045;

export function createCall({ send, onState, onLevels, onError }) {
  let phase = 'idle';
  let peer = null;
  let muted = false;
  let stats = null;
  let pc = null;
  let localStream = null;
  let remoteAudio = null;
  let ringTimer = null;
  let dropTimer = null;
  let statsTimer = null;
  let rafId = null;
  let audioCtx = null;
  let localAnalyser = null;
  let remoteAnalyser = null;
  let lastBytes = 0;
  let lastBytesAt = 0;

  function emit() {
    onState?.({ phase, peer, muted, stats });
  }

  function applyMute() {
    if (!localStream) return;
    for (const track of localStream.getAudioTracks()) track.enabled = !muted;
  }

  function makeAnalyser(stream) {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    return analyser;
  }

  function rms(analyser) {
    if (!analyser) return 0;
    const buf = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) {
      const x = (v - 128) / 128;
      sum += x * x;
    }
    return Math.sqrt(sum / buf.length);
  }

  function meterLoop() {
    if (phase !== 'active') return;
    const local = rms(localAnalyser);
    const remote = rms(remoteAnalyser);
    onLevels?.({
      local,
      remote,
      localSpeaking: !muted && local > SPEAK_THRESHOLD,
      remoteSpeaking: remote > SPEAK_THRESHOLD,
    });
    rafId = requestAnimationFrame(meterLoop);
  }

  async function startMedia() {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: settings.audioConstraints(), video: false });
    muted = false;
    applyMute();
    localAnalyser = makeAnalyser(localStream);
  }

  async function applyDeviceChange() {
    if (phase !== 'active') return;
    if (remoteAudio) applySink(remoteAudio);
    if (!pc) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: settings.audioConstraints(), video: false });
      const track = stream.getAudioTracks()[0];
      track.enabled = !muted;
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
      if (sender) await sender.replaceTrack(track);
      if (localStream) for (const t of localStream.getTracks()) t.stop();
      localStream = stream;
      localAnalyser = makeAnalyser(localStream);
    } catch {
      onError?.('Не удалось сменить микрофон');
    }
  }

  function createPeer() {
    pc = new RTCPeerConnection(RTC_CONFIG);
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);

    remoteAudio = document.createElement('audio');
    remoteAudio.autoplay = true;
    document.body.appendChild(remoteAudio);
    applySink(remoteAudio);

    pc.ontrack = (event) => {
      remoteAudio.srcObject = event.streams[0];
      remoteAnalyser = makeAnalyser(event.streams[0]);
      applySink(remoteAudio);
    };
    pc.onicecandidate = (event) => {
      if (event.candidate) send({ type: 'call-signal', to: peer, data: { kind: 'ice', candidate: event.candidate } });
    };
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'connected') {
        clearDropTimer();
        return;
      }
      if (state === 'failed' || state === 'closed') {
        clearDropTimer();
        onError?.('Соединение потеряно');
        hangup();
        return;
      }
      // disconnected — это ещё не разрыв: пара секунд потерь в Wi-Fi, и ICE
      // сам восстанавливается. Раньше на этом звонок обрывался.
      if (state === 'disconnected' && !dropTimer) {
        dropTimer = setTimeout(() => {
          dropTimer = null;
          if (pc.connectionState === 'disconnected') {
            onError?.('Соединение потеряно');
            hangup();
          }
        }, DROP_GRACE_MS);
      }
    };
  }

  function startStats() {
    lastBytes = 0;
    lastBytesAt = performance.now();
    statsTimer = setInterval(pollStats, STATS_MS);
    rafId = requestAnimationFrame(meterLoop);
  }

  async function pollStats() {
    if (!pc) return;
    try {
      stats = await readStats(pc);
    } catch {
      return;
    }
    emit();
  }

  async function readStats(connection) {
    const report = await connection.getStats();
    const byId = new Map();
    report.forEach((r) => byId.set(r.id, r));

    let pair = null;
    report.forEach((r) => {
      if (r.type === 'transport' && r.selectedCandidatePairId) pair = byId.get(r.selectedCandidatePairId);
    });
    if (!pair) report.forEach((r) => {
      if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r;
    });

    let inbound = null;
    report.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'audio') inbound = r;
    });

    const local = pair ? byId.get(pair.localCandidateId) : null;
    const remote = pair ? byId.get(pair.remoteCandidateId) : null;
    const codecRow = inbound && inbound.codecId ? byId.get(inbound.codecId) : null;

    const rttMs = pair && pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null;
    const jitterMs = inbound && inbound.jitter != null ? Math.round(inbound.jitter * 1000) : null;

    let lossPct = null;
    if (inbound && inbound.packetsReceived != null) {
      const lost = inbound.packetsLost ?? 0;
      const total = lost + inbound.packetsReceived;
      lossPct = total > 0 ? Math.round((lost / total) * 1000) / 10 : 0;
    }

    let kbps = null;
    if (inbound && inbound.bytesReceived != null) {
      const now = performance.now();
      const dt = (now - lastBytesAt) / 1000;
      if (lastBytes && dt > 0) kbps = Math.round(((inbound.bytesReceived - lastBytes) * 8) / dt / 1000);
      lastBytes = inbound.bytesReceived;
      lastBytesAt = now;
    }

    return {
      rttMs,
      jitterMs,
      lossPct,
      kbps,
      protocol: local?.protocol ? local.protocol.toUpperCase() : null,
      localType: local?.candidateType ?? null,
      remoteType: remote?.candidateType ?? null,
      codec: codecRow?.mimeType ? codecRow.mimeType.replace('audio/', '') : null,
      quality: rateQuality(rttMs, lossPct),
    };
  }

  function rateQuality(rttMs, lossPct) {
    if (rttMs == null) return 'unknown';
    if (rttMs < 80 && (lossPct ?? 0) < 2) return 'good';
    if (rttMs < 200 && (lossPct ?? 0) < 7) return 'ok';
    return 'poor';
  }

  function clearRing() {
    if (ringTimer) {
      clearTimeout(ringTimer);
      ringTimer = null;
    }
  }

  function clearDropTimer() {
    if (dropTimer) {
      clearTimeout(dropTimer);
      dropTimer = null;
    }
  }

  function teardown() {
    clearRing();
    clearDropTimer();
    if (statsTimer) clearInterval(statsTimer);
    if (rafId) cancelAnimationFrame(rafId);
    statsTimer = null;
    rafId = null;
    if (pc) pc.close();
    pc = null;
    if (localStream) {
      for (const track of localStream.getTracks()) track.stop();
      localStream = null;
    }
    if (remoteAudio) {
      remoteAudio.srcObject = null;
      remoteAudio.remove();
      remoteAudio = null;
    }
    if (audioCtx) {
      audioCtx.close();
      audioCtx = null;
    }
    localAnalyser = null;
    remoteAnalyser = null;
  }

  function reset() {
    teardown();
    phase = 'idle';
    peer = null;
    muted = false;
    stats = null;
    emit();
  }

  function invite(nick) {
    if (phase !== 'idle') return;
    peer = nick;
    phase = 'outgoing';
    send({ type: 'call-invite', to: nick });
    ringTimer = setTimeout(() => {
      send({ type: 'call-end', to: peer });
      onError?.(`${peer} не отвечает`);
      reset();
    }, RING_TIMEOUT_MS);
    emit();
  }

  async function accept() {
    if (phase !== 'incoming') return;
    clearRing();
    try {
      await startMedia();
    } catch {
      onError?.('Нет доступа к микрофону');
      send({ type: 'call-decline', to: peer, reason: 'no-mic' });
      reset();
      return;
    }
    phase = 'active';
    send({ type: 'call-accept', to: peer });
    startStats();
    emit();
  }

  function decline() {
    if (phase !== 'incoming') return;
    send({ type: 'call-decline', to: peer });
    reset();
  }

  function hangup() {
    if (phase === 'idle') return;
    if (peer) send({ type: 'call-end', to: peer });
    reset();
  }

  function toggleMute() {
    if (phase !== 'active') return;
    muted = !muted;
    applyMute();
    emit();
  }

  async function onAccepted(from) {
    if (phase !== 'outgoing' || from !== peer) return;
    clearRing();
    try {
      await startMedia();
    } catch {
      onError?.('Нет доступа к микрофону');
      hangup();
      return;
    }
    phase = 'active';
    createPeer();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: 'call-signal', to: peer, data: { kind: 'offer', sdp: pc.localDescription } });
    startStats();
    emit();
  }

  async function onSignal(from, data) {
    if (from !== peer || !data || typeof data !== 'object') return;

    if (data.kind === 'offer') {
      if (!pc) createPeer();
      await pc.setRemoteDescription(data.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: 'call-signal', to: peer, data: { kind: 'answer', sdp: pc.localDescription } });
      return;
    }
    if (!pc) return;
    if (data.kind === 'answer') {
      await pc.setRemoteDescription(data.sdp);
    } else if (data.kind === 'ice') {
      try {
        await pc.addIceCandidate(data.candidate);
      } catch {
        /* ICE может прийти раньше remoteDescription — браузер отбросит */
      }
    }
  }

  function handleMessage(message) {
    switch (message.type) {
      case 'call-invite':
        if (phase !== 'idle') {
          send({ type: 'call-decline', to: message.from, reason: 'busy' });
          return;
        }
        peer = message.from;
        phase = 'incoming';
        emit();
        break;
      case 'call-accept':
        onAccepted(message.from);
        break;
      case 'call-decline':
        if (message.from === peer) {
          onError?.(message.reason === 'busy' ? `${peer} занят` : `${peer} отклонил звонок`);
          reset();
        }
        break;
      case 'call-end':
        if (message.from === peer) {
          if (message.reason === 'offline') onError?.(`${peer} не в сети`);
          reset();
        }
        break;
      case 'call-signal':
        onSignal(message.from, message.data);
        break;
    }
  }

  function handlePresence(users) {
    if (peer && phase !== 'idle' && !users.includes(peer)) reset();
  }

  settings.onChange(applyDeviceChange);

  return { invite, accept, decline, hangup, toggleMute, handleMessage, handlePresence };
}
