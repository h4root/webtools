import { createVoice } from './voice.js';
import { createCall } from './call.js';
import { icon, setButton } from './icons.js';
import { mountSettings } from './settings.js';
import autoAnimate from './vendor/auto-animate.mjs';

const gate = document.getElementById('gate');
const nickForm = document.getElementById('nick-form');
const nickInput = document.getElementById('nick-input');
const gateError = document.getElementById('gate-error');
const appEl = document.getElementById('app');
const meEl = document.getElementById('me');
const channelsEl = document.getElementById('channels');
const chatTitle = document.getElementById('chat-title');
const logEl = document.getElementById('log');
const composer = document.getElementById('composer');
const textInput = document.getElementById('text-input');
const voiceToggle = document.getElementById('voice-toggle');
const voiceMute = document.getElementById('voice-mute');
const voiceUsers = document.getElementById('voice-users');
const callBtn = document.getElementById('call-btn');
const callIncoming = document.getElementById('call-incoming');
const callIncomingText = document.getElementById('call-incoming-text');
const callAccept = document.getElementById('call-accept');
const callDecline = document.getElementById('call-decline');
const callPanel = document.getElementById('call-panel');
const peerName = document.getElementById('peer-name');
const partyMe = document.getElementById('party-me');
const partyPeer = document.getElementById('party-peer');
const callStatus = document.getElementById('call-status');
const callStats = document.getElementById('call-stats');
const callMute = document.getElementById('call-mute');
const callHangup = document.getElementById('call-hangup');
const callGrip = document.getElementById('call-grip');
const sendBtn = document.getElementById('send-btn');
const settingsEl = document.getElementById('settings');

const PUBLIC = 'public';
const RECONNECT_MS = 2000;

let myNick = '';
let pendingNick = '';
let joined = false;
let activeChannel = PUBLIC;
let online = [];
let voiceActive = false;
let callPhase = 'idle';
const history = new Map([[PUBLIC, []]]);
const unread = new Map();
let ws = null;
let reconnectTimer = null;

function wsSend(message) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

const voice = createVoice({
  send: wsSend,
  onState: renderVoice,
  onError: (reason) => pushMessage(activeChannel, { system: true, text: reason }),
});

const call = createCall({
  send: wsSend,
  onState: renderCall,
  onLevels: renderLevels,
  onError: (reason) => pushMessage(activeChannel, { system: true, text: reason }),
});

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}`;
}

function connect() {
  ws = new WebSocket(wsUrl());
  ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'hello', nick: pendingNick })));
  ws.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    handleServer(message);
  });
  ws.addEventListener('close', () => {
    voice.reset();
    call.hangup();
    scheduleReconnect();
  });
  ws.addEventListener('error', () => ws.close());
}

function scheduleReconnect() {
  if (reconnectTimer || !joined) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_MS);
}

function handleServer(message) {
  switch (message.type) {
    case 'welcome':
      myNick = message.nick;
      pendingNick = message.nick;
      if (!joined) enterApp();
      break;
    case 'presence':
      online = message.users.filter((nick) => nick !== myNick);
      renderChannels();
      call.handlePresence(message.users);
      break;
    case 'chat': {
      const channel = message.channel === 'public' ? PUBLIC : otherParty(message);
      pushMessage(channel, {
        from: message.from,
        text: message.text,
        mine: message.from === myNick,
      });
      break;
    }
    case 'system':
      pushMessage(PUBLIC, { system: true, text: message.text });
      break;
    case 'error':
      if (!joined) gateError.textContent = message.reason;
      else pushMessage(activeChannel, { system: true, text: message.reason });
      break;
    case 'voice-roster':
      voice.handleRoster(message.users);
      break;
    case 'voice-signal':
      voice.handleSignal(message.from, message.data);
      break;
    case 'voice-presence':
      voice.handlePresence(message.users);
      break;
    case 'call-invite':
    case 'call-accept':
    case 'call-decline':
    case 'call-end':
    case 'call-signal':
      call.handleMessage(message);
      break;
  }
}

function otherParty(message) {
  return message.from === myNick ? message.to : message.from;
}

function enterApp() {
  joined = true;
  gate.hidden = true;
  appEl.hidden = false;
  meEl.textContent = `@${myNick}`;
  setActive(PUBLIC);
}

function pushMessage(channel, entry) {
  if (!history.has(channel)) history.set(channel, []);
  history.get(channel).push(entry);
  if (channel === activeChannel) {
    appendRow(entry);
  } else {
    unread.set(channel, (unread.get(channel) ?? 0) + 1);
  }
  renderChannels();
}

function setActive(channel) {
  activeChannel = channel;
  unread.set(channel, 0);
  chatTitle.textContent = channel === PUBLIC ? '# public' : `@ ${channel}`;
  renderChannels();
  renderLog();
  updateCallButton();
  textInput.focus();
}

function updateCallButton() {
  const canCall = callPhase === 'idle' && activeChannel !== PUBLIC && online.includes(activeChannel);
  callBtn.hidden = !canCall;
}

function renderChannels() {
  channelsEl.replaceChildren();
  for (const channel of [PUBLIC, ...online]) {
    const item = document.createElement('li');
    item.className = channel === activeChannel ? 'channel active' : 'channel';

    const label = document.createElement('span');
    label.textContent = channel === PUBLIC ? '# public' : `@ ${channel}`;
    item.appendChild(label);

    const count = unread.get(channel) ?? 0;
    if (count > 0 && channel !== activeChannel) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = String(count);
      item.appendChild(badge);
    }

    item.addEventListener('click', () => setActive(channel));
    channelsEl.appendChild(item);
  }
  updateCallButton();
}

function renderVoice(state) {
  voiceActive = state.active;
  setButton(voiceToggle, state.active ? 'cross' : 'microphone', state.active ? 'Выйти' : 'Голос');
  voiceToggle.classList.toggle('active', state.active);

  voiceMute.hidden = !state.active;
  setButton(voiceMute, state.muted ? 'sound-off' : 'microphone', state.muted ? 'Выкл' : 'Микро');
  voiceMute.classList.toggle('muted', state.muted);

  voiceUsers.replaceChildren();
  for (const nick of state.users) {
    const li = document.createElement('li');
    li.textContent = nick === myNick ? `${nick} (вы)` : nick;
    voiceUsers.appendChild(li);
  }
}

function renderCall(state) {
  callPhase = state.phase;
  const inCall = state.phase === 'outgoing' || state.phase === 'active';

  callIncoming.hidden = state.phase !== 'incoming';
  if (state.phase === 'incoming') callIncomingText.textContent = `${state.peer} звонит…`;

  callPanel.hidden = !inCall;
  if (inCall) {
    peerName.textContent = state.peer ?? '';
    callStatus.textContent = state.phase === 'outgoing' ? 'Звоним…' : 'На связи';
    callMute.hidden = state.phase !== 'active';
    setButton(callMute, state.muted ? 'sound-off' : 'microphone', state.muted ? 'Выкл' : 'Микро');
    callMute.classList.toggle('muted', state.muted);
    renderStats(state.stats);
  } else {
    setMeter(partyMe, 0, false);
    setMeter(partyPeer, 0, false);
  }

  updateCallButton();
}

function renderStats(stats) {
  callStats.replaceChildren();
  if (!stats) return;
  const dot = document.createElement('span');
  dot.className = `q-dot ${stats.quality}`;
  const text = document.createElement('span');
  text.textContent = formatStats(stats);
  callStats.append(dot, text);
}

function formatStats(s) {
  const parts = [];
  if (s.rttMs != null) parts.push(`${s.rttMs} мс`);
  if (s.protocol) parts.push(s.protocol);
  if (s.localType && s.remoteType) parts.push(`${s.localType}↔${s.remoteType}`);
  if (s.codec) parts.push(s.codec);
  if (s.lossPct != null) parts.push(`потери ${s.lossPct}%`);
  if (s.jitterMs != null) parts.push(`джиттер ${s.jitterMs} мс`);
  if (s.kbps != null) parts.push(`${s.kbps} кбит/с`);
  return parts.join(' · ');
}

function setMeter(party, level, speaking) {
  party.querySelector('.meter > i').style.width = `${Math.min(100, Math.round(level * 140))}%`;
  party.querySelector('.ring').classList.toggle('speaking', speaking);
}

function renderLevels(levels) {
  setMeter(partyMe, levels.local, levels.localSpeaking);
  setMeter(partyPeer, levels.remote, levels.remoteSpeaking);
}

const logAnimation = autoAnimate(logEl, { duration: 180 });

function createRow(entry) {
  const row = document.createElement('div');
  if (entry.system) {
    row.className = 'row system';
    row.textContent = entry.text;
  } else {
    row.className = entry.mine ? 'row mine' : 'row';
    if (!entry.mine) {
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = entry.from;
      row.appendChild(who);
    }
    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = entry.text;
    row.appendChild(text);
  }
  return row;
}

function appendRow(entry) {
  logEl.appendChild(createRow(entry));
  logEl.scrollTop = logEl.scrollHeight;
}

function renderLog() {
  logAnimation.disable();
  logEl.replaceChildren();
  for (const entry of history.get(activeChannel) ?? []) logEl.appendChild(createRow(entry));
  logEl.scrollTop = logEl.scrollHeight;
  logAnimation.enable();
}

nickForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const nick = nickInput.value.trim();
  if (!nick) return;
  pendingNick = nick;
  gateError.textContent = '';
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'hello', nick }));
  } else {
    connect();
  }
});

voiceToggle.addEventListener('click', () => {
  if (voiceActive) voice.leave();
  else voice.join();
});

voiceMute.addEventListener('click', () => voice.toggleMute());

callBtn.addEventListener('click', () => call.invite(activeChannel));
callAccept.addEventListener('click', () => call.accept());
callDecline.addEventListener('click', () => call.decline());
callMute.addEventListener('click', () => call.toggleMute());
callHangup.addEventListener('click', () => call.hangup());

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = textInput.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  const message =
    activeChannel === PUBLIC
      ? { type: 'public', text }
      : { type: 'direct', to: activeChannel, text };
  ws.send(JSON.stringify(message));
  textInput.value = '';
});

function makeDraggable(panel, handle) {
  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;

  handle.addEventListener('pointerdown', (event) => {
    dragging = true;
    const rect = panel.getBoundingClientRect();
    offsetX = event.clientX - rect.left;
    offsetY = event.clientY - rect.top;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const x = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, event.clientX - offsetX));
    const y = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, event.clientY - offsetY));
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
  });
  handle.addEventListener('pointerup', (event) => {
    dragging = false;
    handle.releasePointerCapture(event.pointerId);
  });
}

function initUI() {
  setButton(voiceToggle, 'microphone', 'Голос');
  setButton(callBtn, 'phone', 'Позвонить');
  setButton(callAccept, 'phone', 'Принять');
  setButton(callDecline, 'cross', 'Отклонить');
  setButton(callHangup, 'phone', 'Завершить');
  setButton(sendBtn, 'chevron-right');
  const { toggle } = mountSettings(settingsEl);
  setButton(toggle, 'gear');
  makeDraggable(callPanel, callGrip);
}

initUI();
