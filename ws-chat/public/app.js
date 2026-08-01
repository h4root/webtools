import { createVoice } from './voice.js';
import { createCall } from './call.js';
import { icon, setButton } from './icons.js';
import { mountSettings, settings } from './settings.js';
import autoAnimate from './vendor/auto-animate.mjs';

const gate = document.getElementById('gate');
const nickForm = document.getElementById('nick-form');
const nickInput = document.getElementById('nick-input');
const gateError = document.getElementById('gate-error');
const appEl = document.getElementById('app');
const meEl = document.getElementById('me');
const channelListEl = document.getElementById('channel-list');
const dmListEl = document.getElementById('dm-list');
const channelAddBtn = document.getElementById('channel-add');
const chatTitle = document.getElementById('chat-title');
const logEl = document.getElementById('log');
const typingEl = document.getElementById('typing');
const composer = document.getElementById('composer');
const textInput = document.getElementById('text-input');
const menuBtn = document.getElementById('menu-btn');
const sidebar = document.getElementById('sidebar');
const backdrop = document.getElementById('backdrop');
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

const RECONNECT_MS = 2000;
const TYPING_SEND_MS = 2500;
const TYPING_SHOW_MS = 5000;
const REACTIONS = ['👍', '❤️', '😂', '🔥', '🎉', '😮', '😢', '👀'];

let activePicker = null;

let myNick = '';
let pendingNick = '';
let joined = false;
let channels = [];
let online = [];
let active = { kind: 'channel', id: 'general' };
let voiceActive = false;
let callPhase = 'idle';
let lastTypingSent = 0;
let ws = null;
let reconnectTimer = null;

const conversations = new Map();
const loaded = new Set();
const unread = new Map();
const typing = new Map();

function keyOf(kind, id) {
  return kind === 'channel' ? `ch:${id}` : `dm:${id.toLowerCase()}`;
}
function activeKey() {
  return keyOf(active.kind, active.id);
}
function messageKey(msg) {
  if (msg.channel) return `ch:${msg.channel}`;
  const other = msg.from === myNick ? msg.to : msg.from;
  return `dm:${other.toLowerCase()}`;
}
function convOf(key) {
  if (!conversations.has(key)) conversations.set(key, []);
  return conversations.get(key);
}

function wsSend(message) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

const voice = createVoice({
  send: wsSend,
  onState: renderVoice,
  onError: (reason) => systemLine(reason),
});

const call = createCall({
  send: wsSend,
  onState: renderCall,
  onLevels: renderLevels,
  onError: (reason) => systemLine(reason),
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
    loaded.clear();
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
    case 'channels':
      channels = message.list;
      if (!channels.includes(active.id) && active.kind === 'channel') active.id = channels[0] ?? 'general';
      renderChannels();
      requestHistory(active);
      break;
    case 'presence':
      online = message.users.filter((nick) => nick !== myNick);
      renderChannels();
      call.handlePresence(message.users);
      break;
    case 'history': {
      const key = message.channel ? `ch:${message.channel}` : `dm:${message.to.toLowerCase()}`;
      conversations.set(key, message.messages);
      loaded.add(key);
      if (key === activeKey()) renderLog();
      break;
    }
    case 'message':
      receiveMessage(message.msg);
      break;
    case 'edited':
      applyEdit(message.id, message.text);
      break;
    case 'deleted':
      applyDelete(message.id);
      break;
    case 'reaction':
      applyReaction(message.id, message.reactions);
      break;
    case 'typing':
      receiveTyping(message);
      break;
    case 'system':
      systemLine(message.text);
      break;
    case 'error':
      if (!joined) gateError.textContent = message.reason;
      else systemLine(message.reason);
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

function enterApp() {
  joined = true;
  gate.hidden = true;
  appEl.hidden = false;
  meEl.textContent = `@${myNick}`;
  renderChannels();
  updateTitle();
  textInput.focus();
}

function receiveMessage(msg) {
  const key = messageKey(msg);
  convOf(key).push(msg);
  clearTyping(key, msg.from);
  if (key === activeKey()) {
    appendRow(msg);
    renderTyping();
  } else {
    unread.set(key, (unread.get(key) ?? 0) + 1);
  }
  renderChannels();
}

function systemLine(text) {
  const key = activeKey();
  const msg = { id: -Date.now(), from: '', text, ts: Date.now(), edited: false, system: true };
  convOf(key).push(msg);
  appendRow(msg);
}

function findMessage(id) {
  for (const list of conversations.values()) {
    const m = list.find((x) => x.id === id);
    if (m) return m;
  }
  return null;
}

function applyEdit(id, text) {
  const msg = findMessage(id);
  if (!msg) return;
  msg.text = text;
  msg.edited = true;
  const row = logEl.querySelector(`[data-id="${id}"]`);
  if (row) fillRow(row, msg);
}

function applyDelete(id) {
  for (const list of conversations.values()) {
    const idx = list.findIndex((x) => x.id === id);
    if (idx !== -1) list.splice(idx, 1);
  }
  logEl.querySelector(`[data-id="${id}"]`)?.remove();
}

function openConversation(kind, id) {
  active = { kind, id };
  unread.set(activeKey(), 0);
  updateTitle();
  renderChannels();
  requestHistory(active);
  renderLog();
  renderTyping();
  updateCallButton();
  closeSidebar();
  textInput.focus();
}

function requestHistory(target) {
  const key = keyOf(target.kind, target.id);
  if (loaded.has(key)) return;
  loaded.add(key);
  wsSend(target.kind === 'channel' ? { type: 'history', channel: target.id } : { type: 'history', to: target.id });
}

function updateTitle() {
  chatTitle.textContent = active.kind === 'channel' ? `# ${active.id}` : `@ ${active.id}`;
}

function updateCallButton() {
  const canCall = callPhase === 'idle' && active.kind === 'dm' && online.includes(active.id);
  callBtn.hidden = !canCall;
}

function renderChannels() {
  channelListEl.replaceChildren();
  for (const name of channels) {
    channelListEl.appendChild(navItem('channel', name, `# ${name}`));
  }
  dmListEl.replaceChildren();
  for (const nick of online) {
    dmListEl.appendChild(navItem('dm', nick, `@ ${nick}`));
  }
  updateCallButton();
}

function navItem(kind, id, label) {
  const key = keyOf(kind, id);
  const item = document.createElement('li');
  const isActive = kind === active.kind && id.toLowerCase() === active.id.toLowerCase();
  item.className = isActive ? 'channel active' : 'channel';

  const text = document.createElement('span');
  text.textContent = label;
  item.appendChild(text);

  const count = unread.get(key) ?? 0;
  if (count > 0 && !isActive) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = String(count);
    item.appendChild(badge);
  }

  item.addEventListener('click', () => openConversation(kind, id));
  return item;
}

// --- сообщения ---

const logAnimation = autoAnimate(logEl, { duration: 180, disrespectUserMotionPreference: true });

function applyMotionState() {
  if (settings.animationsEnabled()) logAnimation.enable();
  else logAnimation.disable();
}

function timeLabel(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function renderText(parent, text) {
  let mentionsMe = false;
  const parts = text.split(/(@[\p{L}\p{N}_.-]+)/gu);
  for (const part of parts) {
    if (part.startsWith('@') && part.length > 1) {
      const span = document.createElement('span');
      span.className = 'mention';
      span.textContent = part;
      if (part.slice(1).toLowerCase() === myNick.toLowerCase()) {
        span.classList.add('me');
        mentionsMe = true;
      }
      parent.appendChild(span);
    } else if (part) {
      parent.appendChild(document.createTextNode(part));
    }
  }
  return mentionsMe;
}

function fillRow(row, msg) {
  row.replaceChildren();
  if (!msg.mine) {
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = msg.from;
    row.appendChild(who);
  }
  const text = document.createElement('span');
  text.className = 'text';
  const mentionsMe = renderText(text, msg.text);
  row.appendChild(text);

  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = (msg.edited ? 'изм. · ' : '') + timeLabel(msg.ts);
  row.appendChild(meta);

  row.classList.toggle('mention', mentionsMe && !msg.mine);

  const actions = document.createElement('span');
  actions.className = 'row-actions';
  const react = document.createElement('button');
  react.type = 'button';
  react.title = 'Реакция';
  react.appendChild(icon('smiley', 14));
  react.addEventListener('click', (e) => {
    e.stopPropagation();
    openReactionPicker(react, msg);
  });
  actions.appendChild(react);

  if (msg.mine) {
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.title = 'Изменить';
    edit.appendChild(icon('pencil', 14));
    edit.addEventListener('click', (e) => {
      e.stopPropagation();
      startEdit(row, msg);
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.title = 'Удалить';
    del.appendChild(icon('trash', 14));
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm('Удалить сообщение?')) wsSend({ type: 'delete', id: msg.id });
    });
    actions.append(edit, del);
  }
  row.appendChild(actions);

  renderReactions(row, msg);
}

function renderReactions(row, msg, changed = new Set()) {
  row.querySelector('.reactions')?.remove();
  const reactions = msg.reactions;
  if (!reactions || Object.keys(reactions).length === 0) return;

  const box = document.createElement('div');
  box.className = 'reactions';
  for (const [emoji, users] of Object.entries(reactions)) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'reaction';
    if (users.includes(myNick)) chip.classList.add('mine');
    if (changed.has(emoji)) chip.classList.add('bump');
    chip.title = users.join(', ');
    const face = document.createElement('span');
    face.textContent = emoji;
    const count = document.createElement('span');
    count.className = 'rcount';
    count.textContent = String(users.length);
    chip.append(face, count);
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!chip.classList.contains('mine')) burstReaction(emoji, chip.closest('.row'));
      wsSend({ type: 'react', id: msg.id, emoji });
    });
    box.appendChild(chip);
  }
  row.appendChild(box);
}

function applyReaction(id, reactions) {
  const msg = findMessage(id);
  if (!msg) return;
  const old = msg.reactions ?? {};
  const changed = new Set();
  for (const emoji of new Set([...Object.keys(old), ...Object.keys(reactions)])) {
    if ((old[emoji]?.length ?? 0) !== (reactions[emoji]?.length ?? 0)) changed.add(emoji);
  }
  msg.reactions = Object.keys(reactions).length ? reactions : undefined;
  const row = logEl.querySelector(`[data-id="${id}"]`);
  if (row) renderReactions(row, msg, changed);
}

function burstReaction(emoji, row) {
  if (!settings.animationsEnabled() || !row) return;
  const rect = row.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.bottom;
  for (let i = 0; i < 6; i++) {
    const p = document.createElement('span');
    p.className = 'reaction-burst';
    p.textContent = emoji;
    p.style.left = `${cx}px`;
    p.style.top = `${cy}px`;
    p.style.fontSize = `${22 + Math.random() * 18}px`;
    p.style.setProperty('--dx', `${(Math.random() - 0.5) * 120}px`);
    p.style.setProperty('--dy', `${-60 - Math.random() * 90}px`);
    p.style.setProperty('--rot', `${(Math.random() - 0.5) * 80}deg`);
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 1150);
  }
}

function openReactionPicker(anchor, msg) {
  closeReactionPicker();
  const pick = document.createElement('div');
  pick.className = 'react-picker';
  for (const emoji of REACTIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = emoji;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!msg.reactions?.[emoji]?.includes(myNick)) burstReaction(emoji, logEl.querySelector(`[data-id="${msg.id}"]`));
      wsSend({ type: 'react', id: msg.id, emoji });
      closeReactionPicker();
    });
    pick.appendChild(b);
  }
  document.body.appendChild(pick);

  const r = anchor.getBoundingClientRect();
  const pad = 8;
  const left = Math.max(pad, Math.min(window.innerWidth - pick.offsetWidth - pad, r.left + r.width / 2 - pick.offsetWidth / 2));
  let top = r.top - pick.offsetHeight - pad;
  if (top < pad) top = Math.min(window.innerHeight - pick.offsetHeight - pad, r.bottom + pad);
  pick.style.left = `${left}px`;
  pick.style.top = `${top}px`;

  activePicker = pick;
  setTimeout(() => document.addEventListener('click', closeReactionPicker, { once: true }), 0);
}

function closeReactionPicker() {
  activePicker?.remove();
  activePicker = null;
}

function createRow(msg) {
  const row = document.createElement('div');
  if (msg.system) {
    row.className = 'row system';
    row.textContent = msg.text;
    return row;
  }
  msg.mine = msg.from === myNick;
  row.className = msg.mine ? 'row mine' : 'row';
  row.dataset.id = String(msg.id);
  fillRow(row, msg);
  return row;
}

function startEdit(row, msg) {
  row.replaceChildren();
  const input = document.createElement('input');
  input.className = 'edit-input';
  input.value = msg.text;
  input.maxLength = 2000;
  row.appendChild(input);
  input.focus();
  const commit = () => {
    const value = input.value.trim();
    if (value && value !== msg.text) wsSend({ type: 'edit', id: msg.id, text: value });
    else fillRow(row, msg);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      fillRow(row, msg);
    }
  });
  input.addEventListener('blur', () => fillRow(row, msg));
}

function appendRow(msg) {
  logEl.appendChild(createRow(msg));
  logEl.scrollTop = logEl.scrollHeight;
}

function renderLog() {
  logAnimation.disable();
  logEl.replaceChildren();
  for (const msg of convOf(activeKey())) logEl.appendChild(createRow(msg));
  logEl.scrollTop = logEl.scrollHeight;
  applyMotionState();
}

// --- typing ---

function receiveTyping(message) {
  const key = message.channel ? `ch:${message.channel}` : `dm:${message.from.toLowerCase()}`;
  addTyping(key, message.from);
}

function addTyping(key, nick) {
  if (!typing.has(key)) typing.set(key, new Map());
  const map = typing.get(key);
  if (map.has(nick)) clearTimeout(map.get(nick));
  map.set(nick, setTimeout(() => clearTyping(key, nick), TYPING_SHOW_MS));
  if (key === activeKey()) renderTyping();
}

function clearTyping(key, nick) {
  const map = typing.get(key);
  if (!map || !map.has(nick)) return;
  clearTimeout(map.get(nick));
  map.delete(nick);
  if (key === activeKey()) renderTyping();
}

function renderTyping() {
  const map = typing.get(activeKey());
  const nicks = map ? [...map.keys()] : [];
  typingEl.replaceChildren();
  if (nicks.length === 0) return;
  const verb = nicks.length === 1 ? 'печатает' : 'печатают';
  typingEl.appendChild(document.createTextNode(`${nicks.join(', ')} ${verb} `));
  const dots = document.createElement('span');
  dots.className = 'typing-dots';
  dots.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
  typingEl.appendChild(dots);
}

function sendTyping() {
  const now = Date.now();
  if (now - lastTypingSent < TYPING_SEND_MS) return;
  lastTypingSent = now;
  wsSend(active.kind === 'channel' ? { type: 'typing', channel: active.id } : { type: 'typing', to: active.id });
}

// --- голос / звонок (без изменений в логике) ---

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

// --- адаптив ---

function openSidebar() {
  sidebar.classList.add('open');
  backdrop.hidden = false;
}
function closeSidebar() {
  sidebar.classList.remove('open');
  backdrop.hidden = true;
}

// --- события ---

nickForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const nick = nickInput.value.trim();
  if (!nick) return;
  pendingNick = nick;
  gateError.textContent = '';
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'hello', nick }));
  else connect();
});

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = textInput.value.trim();
  if (!text) return;
  wsSend(active.kind === 'channel' ? { type: 'message', channel: active.id, text } : { type: 'message', to: active.id, text });
  textInput.value = '';
});

textInput.addEventListener('input', () => {
  if (textInput.value.trim()) sendTyping();
});

channelAddBtn.addEventListener('click', () => {
  const name = prompt('Имя канала (латиница, цифры, дефис):');
  if (!name) return;
  const slug = name.trim().toLowerCase();
  if (!/^[a-z0-9-]{1,24}$/.test(slug)) {
    systemLine('Недопустимое имя канала');
    return;
  }
  wsSend({ type: 'channel-create', name: slug });
});

menuBtn.addEventListener('click', () => {
  if (sidebar.classList.contains('open')) closeSidebar();
  else openSidebar();
});
backdrop.addEventListener('click', closeSidebar);

voiceToggle.addEventListener('click', () => {
  if (voiceActive) voice.leave();
  else voice.join();
});
voiceMute.addEventListener('click', () => voice.toggleMute());
callBtn.addEventListener('click', () => call.invite(active.id));
callAccept.addEventListener('click', () => call.accept());
callDecline.addEventListener('click', () => call.decline());
callMute.addEventListener('click', () => call.toggleMute());
callHangup.addEventListener('click', () => call.hangup());

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
  channelAddBtn.appendChild(icon('plus', 16));
  menuBtn.appendChild(icon('menu', 20));
  const { toggle } = mountSettings(settingsEl);
  setButton(toggle, 'gear');
  makeDraggable(callPanel, callGrip);
  settings.onMotionChange(applyMotionState);
  applyMotionState();
}

initUI();
