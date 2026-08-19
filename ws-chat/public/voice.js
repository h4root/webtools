import { settings, applySink } from './settings.js';

const RTC_CONFIG = { iceServers: [] };
const SPEAK_THRESHOLD = 0.045;
const DROP_GRACE_MS = 8000;

export function createVoice({ send, onState, onError, onSpeaking, getNick }) {
  const calls = new Map();
  const mutedPeers = new Set();
  let localStream = null;
  let channel = null;
  let muted = false;
  let deafened = false;
  let audioCtx = null;
  let localAnalyser = null;
  let rafId = null;
  let joining = false;

  function emit() {
    onState?.({ channel, muted, deafened });
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

  function speakingLoop() {
    if (!channel) return;
    const speakers = [];
    const me = getNick?.();
    if (me && !muted && !deafened && rms(localAnalyser) > SPEAK_THRESHOLD) speakers.push(me);
    for (const [nick, call] of calls) {
      if (rms(call.analyser) > SPEAK_THRESHOLD) speakers.push(nick);
    }
    onSpeaking?.(speakers);
    rafId = requestAnimationFrame(speakingLoop);
  }

  function applyMic() {
    if (!localStream) return;
    for (const track of localStream.getAudioTracks()) track.enabled = !muted && !deafened;
  }

  function applyDeafen() {
    for (const { audioEl } of calls.values()) audioEl.muted = deafened;
    applyMic();
  }

  function createPeer(nick) {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);

    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.muted = deafened;
    document.body.appendChild(audioEl);
    applySink(audioEl);

    const call = { pc, audioEl, analyser: null, dropTimer: null };

    pc.ontrack = (event) => {
      audioEl.srcObject = event.streams[0];
      applySink(audioEl);
      call.analyser = makeAnalyser(event.streams[0]);
    };
    pc.onicecandidate = (event) => {
      if (event.candidate) send({ type: 'voice-signal', to: nick, data: { kind: 'ice', candidate: event.candidate } });
    };
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'connected') {
        clearTimeout(call.dropTimer);
        call.dropTimer = null;
        return;
      }
      if (state === 'failed' || state === 'closed') {
        dropPeer(nick);
        return;
      }
      if (state === 'disconnected' && !call.dropTimer) {
        call.dropTimer = setTimeout(() => {
          call.dropTimer = null;
          if (pc.connectionState === 'disconnected') dropPeer(nick);
        }, DROP_GRACE_MS);
      }
    };

    calls.set(nick, call);
    return call;
  }

  function dropPeer(nick) {
    const call = calls.get(nick);
    if (!call) return;
    clearTimeout(call.dropTimer);
    call.pc.close();
    call.audioEl.srcObject = null;
    call.audioEl.remove();
    calls.delete(nick);
  }

  async function offerTo(nick) {
    const { pc } = createPeer(nick);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: 'voice-signal', to: nick, data: { kind: 'offer', sdp: pc.localDescription } });
  }

  function teardown() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    for (const nick of [...calls.keys()]) dropPeer(nick);
    if (localStream) {
      for (const track of localStream.getTracks()) track.stop();
      localStream = null;
    }
    if (audioCtx) {
      audioCtx.close();
      audioCtx = null;
    }
    localAnalyser = null;
    onSpeaking?.([]);
  }

  async function join(target) {
    if (channel === target || joining) return;
    joining = true;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: settings.audioConstraints(), video: false });
    } catch {
      joining = false;
      onError?.('Нет доступа к микрофону');
      return;
    }
    joining = false;

    if (channel) teardown();
    localStream = stream;
    muted = false;
    deafened = false;
    mutedPeers.clear();
    applyMic();
    localAnalyser = makeAnalyser(localStream);
    channel = target;
    send({ type: 'voice-join', channel });
    rafId = requestAnimationFrame(speakingLoop);
    emit();
  }

  function leave() {
    if (!channel) return;
    send({ type: 'voice-leave' });
    reset();
  }

  function reset() {
    channel = null;
    muted = false;
    deafened = false;
    mutedPeers.clear();
    teardown();
    emit();
  }

  // Наружу уходит не сам мут, а то, слышно тебя или нет: заглушка выключает
  // микрофон тоже, и для остальных это неотличимо.
  function announceMic() {
    send({ type: 'voice-mute', muted: muted || deafened });
  }

  function toggleMute() {
    if (!channel) return;
    muted = !muted;
    applyMic();
    announceMic();
    emit();
  }

  function toggleDeafen() {
    if (!channel) return;
    deafened = !deafened;
    applyDeafen();
    announceMic();
    emit();
  }

  async function handleRoster(rosterChannel, users) {
    if (rosterChannel !== channel) return;
    for (const { nick, muted: peerMuted } of users) {
      if (peerMuted) mutedPeers.add(nick.toLowerCase());
      if (!calls.has(nick)) await offerTo(nick);
    }
  }

  function handleMute(nick, peerMuted) {
    const lower = nick.toLowerCase();
    if (peerMuted) mutedPeers.add(lower);
    else mutedPeers.delete(lower);
  }

  function isMuted(nick) {
    if (nick.toLowerCase() === (getNick() ?? '').toLowerCase()) return muted || deafened;
    return mutedPeers.has(nick.toLowerCase());
  }

  async function handleSignal(from, data) {
    if (!channel || !data || typeof data !== 'object') return;

    if (data.kind === 'offer') {
      const call = calls.get(from) ?? createPeer(from);
      await call.pc.setRemoteDescription(data.sdp);
      const answer = await call.pc.createAnswer();
      await call.pc.setLocalDescription(answer);
      send({ type: 'voice-signal', to: from, data: { kind: 'answer', sdp: call.pc.localDescription } });
      return;
    }

    const call = calls.get(from);
    if (!call) return;
    if (data.kind === 'answer') {
      await call.pc.setRemoteDescription(data.sdp);
    } else if (data.kind === 'ice') {
      try {
        await call.pc.addIceCandidate(data.candidate);
      } catch {}
    }
  }

  function handlePresence(map) {
    if (!channel) return;
    const members = map[channel] ?? [];
    for (const nick of [...calls.keys()]) {
      if (!members.includes(nick)) dropPeer(nick);
    }
  }

  async function applyDeviceChange() {
    if (!channel) return;
    for (const { audioEl } of calls.values()) applySink(audioEl);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: settings.audioConstraints(), video: false });
      const track = stream.getAudioTracks()[0];
      track.enabled = !muted && !deafened;
      for (const { pc } of calls.values()) {
        const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
        if (sender) await sender.replaceTrack(track);
      }
      if (localStream) for (const t of localStream.getTracks()) t.stop();
      localStream = stream;
    } catch {
      onError?.('Не удалось сменить микрофон');
    }
  }

  settings.onChange(applyDeviceChange);

  return { join, leave, reset, toggleMute, toggleDeafen, handleRoster, handleMute, isMuted, handleSignal, handlePresence };
}
