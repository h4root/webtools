import { createVoice } from './voice.js';

const gate = document.getElementById('gate');
const nickForm = document.getElementById('nick-form');
const nickInput = document.getElementById('nick-input');
const gateError = document.getElementById('gate-error');
const appEl = document.getElementById('app');
const meEl = document.getElementById('me');
const channelsEl = document.getElementById('channels');
const chatHeader = document.getElementById('chat-header');
const logEl = document.getElementById('log');
const composer = document.getElementById('composer');
const textInput = document.getElementById('text-input');
const voiceToggle = document.getElementById('voice-toggle');
const voiceMute = document.getElementById('voice-mute');
const voiceUsers = document.getElementById('voice-users');

const PUBLIC = 'public';
const RECONNECT_MS = 2000;

let myNick = '';
let pendingNick = '';
let joined = false;
let activeChannel = PUBLIC;
let online = [];
let voiceActive = false;
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
  onError: (reason) => pushMessage(activeChannel, { system: true, text: `⚠ ${reason}` }),
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
      else pushMessage(activeChannel, { system: true, text: `⚠ ${message.reason}` });
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
    renderLog();
  } else {
    unread.set(channel, (unread.get(channel) ?? 0) + 1);
  }
  renderChannels();
}

function setActive(channel) {
  activeChannel = channel;
  unread.set(channel, 0);
  chatHeader.textContent = channel === PUBLIC ? '# public' : `@ ${channel}`;
  renderChannels();
  renderLog();
  textInput.focus();
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
}

function renderVoice(state) {
  voiceActive = state.active;
  voiceToggle.textContent = state.active ? '📴 Выйти' : '🎙 Голос';
  voiceToggle.classList.toggle('active', state.active);

  voiceMute.hidden = !state.active;
  voiceMute.textContent = state.muted ? '🔇 Микро выкл' : '🔊 Микро вкл';
  voiceMute.classList.toggle('muted', state.muted);

  voiceUsers.replaceChildren();
  for (const nick of state.users) {
    const li = document.createElement('li');
    li.textContent = nick === myNick ? `${nick} (вы)` : nick;
    voiceUsers.appendChild(li);
  }
}

function renderLog() {
  logEl.replaceChildren();
  for (const entry of history.get(activeChannel) ?? []) {
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
    logEl.appendChild(row);
  }
  logEl.scrollTop = logEl.scrollHeight;
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
