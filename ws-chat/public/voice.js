import { settings, applySink } from './settings.js';

const RTC_CONFIG = { iceServers: [] };

export function createVoice({ send, onState, onError }) {
  const calls = new Map();
  let localStream = null;
  let active = false;
  let muted = false;
  let users = [];

  function emit() {
    onState?.({ active, muted, users });
  }

  function applyMute() {
    if (!localStream) return;
    for (const track of localStream.getAudioTracks()) track.enabled = !muted;
  }

  function createPeer(nick) {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);

    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    document.body.appendChild(audioEl);
    applySink(audioEl);

    pc.ontrack = (event) => {
      audioEl.srcObject = event.streams[0];
      applySink(audioEl);
    };
    pc.onicecandidate = (event) => {
      if (event.candidate) send({ type: 'voice-signal', to: nick, data: { kind: 'ice', candidate: event.candidate } });
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) dropPeer(nick);
    };

    const call = { pc, audioEl };
    calls.set(nick, call);
    return call;
  }

  function dropPeer(nick) {
    const call = calls.get(nick);
    if (!call) return;
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
    for (const nick of [...calls.keys()]) dropPeer(nick);
    if (localStream) {
      for (const track of localStream.getTracks()) track.stop();
      localStream = null;
    }
  }

  async function join() {
    if (active) return;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: settings.audioConstraints(), video: false });
    } catch {
      onError?.('Нет доступа к микрофону');
      return;
    }
    muted = false;
    applyMute();
    active = true;
    send({ type: 'voice-join' });
    emit();
  }

  async function applyDeviceChange() {
    if (!active) return;
    for (const { audioEl } of calls.values()) applySink(audioEl);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: settings.audioConstraints(), video: false });
      const track = stream.getAudioTracks()[0];
      track.enabled = !muted;
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

  function leave() {
    if (!active) return;
    send({ type: 'voice-leave' });
    reset();
  }

  function reset() {
    active = false;
    muted = false;
    users = [];
    teardown();
    emit();
  }

  function toggleMute() {
    if (!active) return;
    muted = !muted;
    applyMute();
    emit();
  }

  async function handleRoster(present) {
    if (!active) return;
    for (const nick of present) {
      if (!calls.has(nick)) await offerTo(nick);
    }
  }

  async function handleSignal(from, data) {
    if (!active || !data || typeof data !== 'object') return;

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
      } catch {
        /* ICE может прийти раньше remoteDescription — браузер отбросит */
      }
    }
  }

  function handlePresence(nicks) {
    users = nicks;
    if (active) {
      for (const nick of [...calls.keys()]) {
        if (!nicks.includes(nick)) dropPeer(nick);
      }
    }
    emit();
  }

  return { join, leave, reset, toggleMute, handleRoster, handleSignal, handlePresence };
}
