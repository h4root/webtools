import { settings, applySink } from './settings.js';

const RTC_CONFIG = { iceServers: [] };

export function createVoice({ send, onState, onError }) {
  const calls = new Map();
  let localStream = null;
  let channel = null;
  let muted = false;
  let deafened = false;

  function emit() {
    onState?.({ channel, muted, deafened });
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

  async function join(target) {
    if (channel === target) return;
    if (channel) teardown();
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: settings.audioConstraints(), video: false });
    } catch {
      onError?.('Нет доступа к микрофону');
      return;
    }
    muted = false;
    deafened = false;
    applyMic();
    channel = target;
    send({ type: 'voice-join', channel });
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
    teardown();
    emit();
  }

  function toggleMute() {
    if (!channel) return;
    muted = !muted;
    applyMic();
    emit();
  }

  function toggleDeafen() {
    if (!channel) return;
    deafened = !deafened;
    applyDeafen();
    emit();
  }

  async function handleRoster(rosterChannel, users) {
    if (rosterChannel !== channel) return;
    for (const nick of users) {
      if (!calls.has(nick)) await offerTo(nick);
    }
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
      } catch {
        /* ICE может прийти раньше remoteDescription — браузер отбросит */
      }
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

  return { join, leave, reset, toggleMute, toggleDeafen, handleRoster, handleSignal, handlePresence };
}
