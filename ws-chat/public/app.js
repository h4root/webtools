import { createVoice } from './voice.js';
import { createCall } from './call.js';
import { icon, setButton } from './icons.js';
import { mountSettings, settings } from './settings.js';
import autoAnimate from './vendor/auto-animate.mjs';

import {
  gateScreen,
  nickInput,
  logoutBtn,
  appEl,
  meEl,
  channelListEl,
  dmListEl,
  channelAddBtn,
  chatTitle,
  logEl,
  typingEl,
  composer,
  textInput,
  replyBar,
  attachBtn,
  fileInput,
  menuBtn,
  sidebar,
  backdrop,
  membersBtn,
  membersPanel,
  membersListEl,
  voiceListEl,
  voiceAddBtn,
  voiceStatus,
  voiceConn,
  voiceMuteBtn,
  voiceDeafenBtn,
  voiceLeaveBtn,
  callBtn,
  callIncoming,
  callIncomingText,
  callAccept,
  callDecline,
  callPanel,
  peerName,
  partyMe,
  partyPeer,
  callStatus,
  callStats,
  callMute,
  callHangup,
  callGrip,
  sendBtn,
  settingsEl,
  connBanner,
  jumpNewBtn,
  searchBtn,
  searchInput,
  searchCloseBtn,
  searchNote,
  dropBtn,
  dropCloseBtn,
  sidebarCloseBtn,
} from './dom.js';
import { createAttachments } from './attachments.js';
import { createSearch } from './search.js';
import { createGate } from './gate.js';
import { createDrop } from './drop.js';
import { isNarrow, timeLabel, formatSize, formatStats, deviceLabel, secureContext } from './format.js';

const RECONNECT_MS = 2000;
const RECONNECT_MAX_MS = 15000;
const TYPING_SEND_MS = 2500;
const TYPING_SHOW_MS = 5000;
const REACTIONS = ['👍', '❤️', '😂', '🔥', '🎉', '😮', '😢', '👀'];

let activePicker = null;

const TOKEN_KEY = 'ws-chat-token';
const BASE_TITLE = document.title;

let myNick = '';
let authToken = '';
let isGuest = false;
let passwordNote = null;
let sessionsNote = null;
let linkNote = null;
let joined = false;
let channels = [];
let online = [];
let dmPartners = [];
let active = { kind: 'channel', id: 'general' };
let voiceChannel = null;
let voiceChannels = [];
let voicePresence = {};
let callPhase = 'idle';
let lastTypingSent = 0;
let replyingTo = null;
let ws = null;
let reconnectTimer = null;
let reconnectDelay = RECONNECT_MS;
let outbox = [];
let missedBelow = 0;

const conversations = new Map();
const loaded = new Set();
const historyReady = new Set();
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

const QUEUEABLE = new Set(['message', 'edit', 'delete', 'react', 'channel-create', 'voice-channel-create']);

function wsSend(message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
    return;
  }
  if (joined && QUEUEABLE.has(message.type) && outbox.length < 100) {
    outbox.push(message);
    renderConnState();
  }
}

function flushOutbox() {
  const pending = outbox;
  outbox = [];
  for (const message of pending) wsSend(message);
}

function renderConnState() {
  const online = ws && ws.readyState === WebSocket.OPEN && joined;
  connBanner.hidden = Boolean(online);
  if (online) return;
  connBanner.textContent = outbox.length
    ? `Нет связи — переподключаюсь, в очереди ${outbox.length}`
    : 'Нет связи — переподключаюсь…';
}

const voice = createVoice({
  send: wsSend,
  onState: renderVoice,
  onError: (reason) => systemLine(reason),
  onSpeaking: (nicks) => applySpeaking(nicks),
  getNick: () => myNick,
});

const call = createCall({
  send: wsSend,
  onState: renderCall,
  onLevels: renderLevels,
  onError: (reason) => systemLine(reason),
});

const attachments = createAttachments({
  getToken: () => authToken,
  onError: (reason) => systemLine(reason),
});

// Форма входа шлёт либо в живой сокет, либо поднимает его: sendHello
// повторит запрос сама, как только соединение откроется.
function request(message) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  else connect();
}

const gate = createGate({ request });

const drop = createDrop({
  getToken: () => authToken,
  onPendingChange: () => renderDocumentTitle(),
});

const search = createSearch({
  send: wsSend,
  getNick: () => myNick,
  openConversation: (kind, id) => openConversation(kind, id),
  keyOf,
  activeKey,
  findRow: (id) => logEl.querySelector(`[data-id="${id}"]`),
  scrollToMessage: (id) => scrollToMessage(id),
  historyArrived: (key) => historyReady.has(key),
});

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}`;
}

function sendHello() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (authToken) ws.send(JSON.stringify({ type: 'auth', mode: 'resume', token: authToken }));
  else if (gate.mode() === 'link') ws.send(JSON.stringify({ type: 'link-request', device: deviceLabel() }));
  else if (gate.pending()) ws.send(JSON.stringify({ type: 'auth', ...gate.pending() }));
}

function connect() {
  ws = new WebSocket(wsUrl());
  ws.addEventListener('open', () => {
    reconnectDelay = RECONNECT_MS;
    sendHello();
  });
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
    historyReady.clear();
    renderConnState();
    scheduleReconnect();
  });
  ws.addEventListener('error', () => ws.close());
}

function scheduleReconnect() {
  if (reconnectTimer || !joined) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(RECONNECT_MAX_MS, reconnectDelay * 2);
}

function handleAuthError(message) {
  const wait = message.retryAfterMs ? ` Подожди ${Math.ceil(message.retryAfterMs / 1000)} с.` : '';

  if (authToken) {
    forgetToken();
    if (joined) {
      returnToGate(message.reason + wait);
    } else {
      gate.showError(message.reason + wait);
      gate.setBusy(false);
    }
    return;
  }
  gate.showError(message.reason + wait);
  gate.setBusy(false);
}

function forgetToken() {
  authToken = '';
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

function handleServer(message) {
  switch (message.type) {
    case 'welcome':
      myNick = message.nick;
      authToken = message.token;
      isGuest = message.guest;
      gate.clearPending();
      try {
        localStorage.setItem(TOKEN_KEY, authToken);
      } catch {}
      reconnectDelay = RECONNECT_MS;
      if (!joined) enterApp();
      renderConnState();
      flushOutbox();
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
      renderMembers();
      call.handlePresence(message.users);
      break;
    case 'dms':
      dmPartners = message.list.map((d) => ({ nick: d.nick, ts: d.ts }));
      renderChannels();
      break;
    case 'history': {
      const key = message.channel ? `ch:${message.channel}` : `dm:${message.to.toLowerCase()}`;
      conversations.set(key, message.messages);
      loaded.add(key);
      historyReady.add(key);
      if (key === activeKey()) renderLog();
      break;
    }
    case 'search':
      search.renderResults(message.query, message.messages);
      break;
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
    case 'auth-error':
      handleAuthError(message);
      break;
    case 'logged-out':
      finishLogout(message.reason);
      break;
    case 'sessions':
      sessionsNote?.(message.list);
      break;
    case 'link-code':
      gate.showLinkCode(message.code, message.expiresAt);
      break;
    case 'link-approved':
      linkNote?.(`Подключено: ${message.device}`);
      linkNote = null;
      break;
    case 'password-changed':
      passwordNote?.('Пароль изменён. Остальные устройства придётся авторизовать заново.');
      passwordNote = null;
      break;
    case 'purged':
      forgetUser(message.nick);
      break;
    case 'error':
      if (!joined) gate.showError(message.reason);
      else if (linkNote) {
        linkNote(message.reason);
        linkNote = null;
      } else systemLine(message.reason);
      break;
    case 'voice-channels':
      voiceChannels = message.list;
      renderVoiceChannels();
      break;
    case 'voice-roster':
      voice.handleRoster(message.channel, message.users);
      break;
    case 'voice-mute':
      voice.handleMute(message.nick, message.muted);
      renderVoiceChannels();
      break;
    case 'voice-left':
      voice.reset();
      systemLine(message.reason);
      break;
    case 'voice-signal':
      voice.handleSignal(message.from, message.data);
      break;
    case 'voice-presence':
      voicePresence = message.channels;
      renderVoiceChannels();
      renderMembers();
      voice.handlePresence(message.channels);
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

function finishLogout(reason) {
  forgetToken();
  gate.clearPending();
  outbox = [];
  if (ws) {
    const socket = ws;
    ws = null;
    socket.close();
  }
  returnToGate(reason ?? (isGuest ? 'Гостевая личность стёрта' : 'Вы вышли'));
}

function returnToGate(reason) {
  joined = false;
  voice.reset();
  call.hangup();
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  conversations.clear();
  loaded.clear();
  historyReady.clear();
  unread.clear();
  typing.clear();
  renderDocumentTitle();
  dmPartners = [];
  online = [];
  attachments.releaseUrls();
  logEl.replaceChildren();
  search.reset();
  drop.stop();
  drop.setPanel(false);
  closeSidebar();
  appEl.hidden = true;
  gateScreen.hidden = false;
  connBanner.hidden = true;
  gate.setBusy(false);
  gate.setMode(isGuest ? 'guest' : 'login');
  gate.showError(reason ?? '');
  nickInput.value = myNick;
  nickInput.focus();
}

function forgetUser(nick) {
  const lower = nick.toLowerCase();
  for (const [key, list] of conversations) {
    if (key === `dm:${lower}`) {
      conversations.delete(key);
      loaded.delete(key);
      unread.delete(key);
      continue;
    }
    const left = list.filter((msg) => msg.from.toLowerCase() !== lower);
    for (const msg of left) {
      if (msg.replyTo && msg.replyTo.from.toLowerCase() === lower) delete msg.replyTo;
    }
    conversations.set(key, left);
  }
  dmPartners = dmPartners.filter((p) => p.nick.toLowerCase() !== lower);
  if (active.kind === 'dm' && active.id.toLowerCase() === lower) openConversation('channel', channels[0] ?? 'general');
  else renderLog();
  renderChannels();
}

function enterApp() {
  joined = true;
  gateScreen.hidden = true;
  appEl.hidden = false;
  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  avatar.textContent = myNick.slice(0, 1).toUpperCase();
  const name = document.createElement('span');
  name.className = isGuest ? 'me-name guest' : 'me-name';
  name.textContent = `@${myNick}`;
  meEl.replaceChildren(avatar, name);
  renderChannels();
  updateTitle();
  drop.start();
  textInput.focus();
}

function receiveMessage(msg) {
  const key = messageKey(msg);
  convOf(key).push(msg);
  clearTyping(key, msg.from);
  if (msg.to !== undefined) rememberPartner(msg.from === myNick ? msg.to : msg.from, msg.ts);
  if (key === activeKey()) {
    appendRow(msg);
    renderTyping();
  } else {
    unread.set(key, (unread.get(key) ?? 0) + 1);
  }
  renderChannels();
}

function rememberPartner(nick, ts) {
  if (!nick || nick === myNick) return;
  const lower = nick.toLowerCase();
  const known = dmPartners.find((p) => p.nick.toLowerCase() === lower);
  if (known) known.ts = Math.max(known.ts, ts);
  else dmPartners.push({ nick, ts });
}

function systemLine(text) {
  appendRow({ id: 0, from: '', text, ts: Date.now(), edited: false, system: true });
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

// Сообщение в фоновой вкладке иначе никак не заметить: сам чат не на виду.
function renderDocumentTitle() {
  let total = drop.pending();
  for (const count of unread.values()) total += count;
  document.title = total > 0 ? `(${total}) ${BASE_TITLE}` : BASE_TITLE;
}

function renderChannels() {
  renderDocumentTitle();
  channelListEl.replaceChildren();
  for (const name of channels) {
    channelListEl.appendChild(navItem('channel', name, `# ${name}`));
  }
  dmListEl.replaceChildren();
  for (const nick of dmList()) {
    dmListEl.appendChild(navItem('dm', nick, `@ ${nick}`, !isOnline(nick)));
  }
  updateCallButton();
}

function isOnline(nick) {
  const lower = nick.toLowerCase();
  return nick === myNick || online.some((n) => n.toLowerCase() === lower);
}

// Свежие переписки сверху, как в мессенджерах. Ниже — те, кому ещё не писали:
// они попадают в список просто потому, что сейчас в сети, и двигать их нечему.
function dmList() {
  const seen = new Map();
  for (const nick of online) if (nick !== myNick) seen.set(nick.toLowerCase(), nick);
  for (const partner of dmPartners) if (partner.nick !== myNick) seen.set(partner.nick.toLowerCase(), partner.nick);
  if (active.kind === 'dm' && !seen.has(active.id.toLowerCase())) seen.set(active.id.toLowerCase(), active.id);

  return [...seen.entries()]
    .map(([lower, nick]) => ({ nick, ts: dmPartners.find((p) => p.nick.toLowerCase() === lower)?.ts ?? 0 }))
    .sort((a, b) => b.ts - a.ts || Number(isOnline(b.nick)) - Number(isOnline(a.nick)) || a.nick.localeCompare(b.nick))
    .map((entry) => entry.nick);
}

function navItem(kind, id, label, offline = false) {
  const key = keyOf(kind, id);
  const item = document.createElement('li');
  const isActive = kind === active.kind && id.toLowerCase() === active.id.toLowerCase();
  item.className = isActive ? 'channel active' : 'channel';
  if (offline) item.classList.add('offline');

  const text = document.createElement('span');
  text.textContent = label;
  item.appendChild(text);

  const count = unread.get(key) ?? 0;
  if (count > 0 && !isActive) {
    item.classList.add('unread');
    const badge = document.createElement('span');
    badge.className = 'badge';
    // Четырёхзначный счётчик растянул бы строку и вытеснил имя канала.
    badge.textContent = count > 99 ? '99+' : String(count);
    item.appendChild(badge);
  }

  if (kind === 'channel' && channels.length > 1) {
    item.appendChild(deleteButton(`Удалить канал #${id} вместе с историей?`, () => wsSend({ type: 'channel-delete', name: id })));
  }

  item.addEventListener('click', () => openConversation(kind, id));
  return item;
}

function deleteButton(question, onConfirm) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'chan-del';
  btn.title = 'Удалить';
  btn.appendChild(icon('cross', 12));
  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    if (confirm(question)) onConfirm();
  });
  return btn;
}

function renderMembers() {
  membersListEl.replaceChildren();
  const inVoice = new Set();
  for (const [ch, nicks] of Object.entries(voicePresence)) {
    if (!nicks.length) continue;
    for (const n of nicks) inVoice.add(n.toLowerCase());
    membersListEl.appendChild(memberGroup(ch, nicks, 'sound-on'));
  }
  const rest = [myNick, ...online]
    .filter((n, i, arr) => arr.indexOf(n) === i && !inVoice.has(n.toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
  membersListEl.appendChild(memberGroup('В сети', rest));
}

function memberGroup(label, nicks, iconName) {
  const wrap = document.createElement('div');
  wrap.className = 'member-group';
  const head = document.createElement('div');
  head.className = 'member-head';
  if (iconName) head.appendChild(icon(iconName, 13));
  const text = document.createElement('span');
  text.textContent = `${label} — ${nicks.length}`;
  head.appendChild(text);
  wrap.appendChild(head);
  for (const nick of nicks) wrap.appendChild(memberRow(nick));
  return wrap;
}

function memberRow(nick) {
  const row = document.createElement('div');
  row.className = 'member';
  row.dataset.nick = nick.toLowerCase();
  const av = document.createElement('span');
  av.className = 'm-avatar';
  av.textContent = nick.slice(0, 1).toUpperCase();
  const name = document.createElement('span');
  name.className = 'm-name';
  name.textContent = nick === myNick ? `${nick} (вы)` : nick;
  row.append(av, name);
  if (nick !== myNick) row.addEventListener('click', () => openConversation('dm', nick));
  return row;
}

function applySpeaking(nicks) {
  const set = new Set(nicks.map((n) => n.toLowerCase()));
  for (const row of membersListEl.querySelectorAll('.member')) {
    row.classList.toggle('speaking', set.has(row.dataset.nick));
  }
}

const logAnimation = autoAnimate(logEl, { duration: 180, disrespectUserMotionPreference: true });

function applyMotionState() {
  if (settings.animationsEnabled()) logAnimation.enable();
  else logAnimation.disable();
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

  if (msg.replyTo) {
    const quote = document.createElement('button');
    quote.type = 'button';
    quote.className = 'reply-quote';
    const qwho = document.createElement('span');
    qwho.className = 'rq-who';
    qwho.textContent = msg.replyTo.from;
    const qtext = document.createElement('span');
    qtext.className = 'rq-text';
    qtext.textContent = msg.replyTo.text || 'вложение';
    quote.append(qwho, qtext);
    quote.addEventListener('click', (e) => {
      e.stopPropagation();
      scrollToMessage(msg.replyTo.id);
    });
    row.appendChild(quote);
  }

  if (!msg.mine) {
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = msg.from;
    row.appendChild(who);
  }

  let mentionsMe = false;
  if (msg.text) {
    const text = document.createElement('span');
    text.className = 'text';
    mentionsMe = renderText(text, msg.text);
    row.appendChild(text);
  }

  if (msg.attachments?.length) row.appendChild(attachments.render(msg.attachments));

  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = (msg.edited ? 'изм. · ' : '') + timeLabel(msg.ts);
  row.appendChild(meta);

  row.classList.toggle('mention', mentionsMe && !msg.mine);

  const actions = document.createElement('span');
  actions.className = 'row-actions';
  const reply = document.createElement('button');
  reply.type = 'button';
  reply.title = 'Ответить';
  reply.appendChild(icon('reply', 14));
  reply.addEventListener('click', (e) => {
    e.stopPropagation();
    setReply(msg);
  });
  actions.appendChild(reply);
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

const BOTTOM_SLACK_PX = 80;

function atBottom() {
  return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight <= BOTTOM_SLACK_PX;
}

function scrollToBottom() {
  logEl.scrollTop = logEl.scrollHeight;
  missedBelow = 0;
  renderJumpNew();
}

function renderJumpNew() {
  jumpNewBtn.hidden = missedBelow === 0;
  if (missedBelow) jumpNewBtn.textContent = `↓ новых: ${missedBelow}`;
}

function appendRow(msg) {
  const stick = atBottom() || msg.from === myNick || msg.system;
  logEl.appendChild(createRow(msg));
  if (stick) {
    scrollToBottom();
  } else {
    missedBelow++;
    renderJumpNew();
  }
}

function renderLog() {
  logAnimation.disable();
  logEl.replaceChildren();
  for (const msg of convOf(activeKey())) logEl.appendChild(createRow(msg));
  missedBelow = 0;
  scrollToBottom();
  applyMotionState();
  search.flushJump();
}

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

function renderVoice(state) {
  voiceChannel = state.channel;
  voiceStatus.hidden = !state.channel;
  if (state.channel) {
    voiceConn.replaceChildren(icon('sound-on', 14));
    const label = document.createElement('span');
    label.textContent = state.channel;
    voiceConn.appendChild(label);
    setButton(voiceMuteBtn, state.muted ? 'mic-off' : 'microphone');
    voiceMuteBtn.classList.toggle('muted', state.muted);
    setButton(voiceDeafenBtn, state.deafened ? 'sound-off' : 'sound-on');
    voiceDeafenBtn.classList.toggle('muted', state.deafened);
  }
  renderVoiceChannels();
}

function renderVoiceChannels() {
  voiceListEl.replaceChildren();
  for (const name of voiceChannels) {
    const li = document.createElement('li');
    li.className = 'voice-chan';

    const head = document.createElement('div');
    head.className = name === voiceChannel ? 'channel voice-chan-head active' : 'channel voice-chan-head';
    head.appendChild(icon('sound-on', 14));
    const label = document.createElement('span');
    label.textContent = name;
    head.appendChild(label);
    head.addEventListener('click', () => {
      if (voiceChannel === name) voice.leave();
      else voice.join(name);
    });
    head.appendChild(deleteButton(`Удалить голосовой канал ${name}?`, () => wsSend({ type: 'voice-channel-delete', name })));
    li.appendChild(head);

    const members = voicePresence[name] ?? [];
    if (members.length) {
      const ul = document.createElement('ul');
      ul.className = 'voice-members';
      for (const nick of members) {
        const m = document.createElement('li');
        const label = document.createElement('span');
        label.textContent = nick === myNick ? `${nick} (вы)` : nick;
        m.appendChild(label);
        // Про мут известно только по своему каналу: сервер рассылает его тем,
        // кто рядом, и знать про соседние комнаты незачем.
        if (name === voiceChannel && voice.isMuted(nick)) {
          m.classList.add('muted');
          m.title = 'Микрофон выключен';
          m.appendChild(icon('mic-off', 13));
        }
        ul.appendChild(m);
      }
      li.appendChild(ul);
    }
    voiceListEl.appendChild(li);
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

function setMeter(party, level, speaking) {
  party.querySelector('.meter > i').style.width = `${Math.min(100, Math.round(level * 140))}%`;
  party.querySelector('.ring').classList.toggle('speaking', speaking);
}

function renderLevels(levels) {
  setMeter(partyMe, levels.local, levels.localSpeaking);
  setMeter(partyPeer, levels.remote, levels.remoteSpeaking);
}

function openSidebar() {
  if (isNarrow()) closeRightPanels();
  sidebar.classList.add('open');
  backdrop.hidden = false;
}
function closeSidebar() {
  sidebar.classList.remove('open');
  backdrop.hidden = true;
}

function closeRightPanels() {
  drop.setPanel(false);
  membersPanel.hidden = true;
  membersBtn.classList.remove('active');
}

function scrollToMessage(id) {
  const row = logEl.querySelector(`[data-id="${id}"]`);
  if (!row) return;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.classList.remove('flash');
  void row.offsetWidth;
  row.classList.add('flash');
}

function setReply(msg) {
  replyingTo = { id: msg.id, from: msg.from, text: msg.text || 'вложение' };
  renderReplyBar();
  textInput.focus();
}

function cancelReply() {
  replyingTo = null;
  renderReplyBar();
}

function renderReplyBar() {
  replyBar.replaceChildren();
  if (!replyingTo) {
    replyBar.hidden = true;
    return;
  }
  replyBar.hidden = false;
  const label = document.createElement('span');
  label.className = 'reply-bar-text';
  const who = document.createElement('b');
  who.textContent = replyingTo.from;
  label.append('Ответ ', who, `: ${replyingTo.text.slice(0, 80)}`);
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'reply-cancel';
  cancel.appendChild(icon('cross', 14));
  cancel.addEventListener('click', cancelReply);
  replyBar.append(label, cancel);
}


logoutBtn.addEventListener('click', () => {
  const question = isGuest
    ? 'Выйти? Гостевая личность стирается: ник освободится, а все твои сообщения и вложения будут удалены безвозвратно.'
    : 'Выйти из аккаунта на этом устройстве?';
  if (confirm(question)) wsSend({ type: 'logout' });
});

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = textInput.value.trim();
  const files = attachments.pending();
  if (!text && files.length === 0) return;
  const base = active.kind === 'channel' ? { channel: active.id } : { to: active.id };
  wsSend({
    type: 'message',
    ...base,
    text,
    replyTo: replyingTo?.id,
    attachments: files.length ? files : undefined,
  });
  textInput.value = '';
  attachments.clear();
  cancelReply();
});

attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  attachments.add([...fileInput.files]);
  fileInput.value = '';
});
textInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && replyingTo) cancelReply();
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

jumpNewBtn.addEventListener('click', scrollToBottom);
logEl.addEventListener('scroll', () => {
  if (missedBelow && atBottom()) {
    missedBelow = 0;
    renderJumpNew();
  }
});

membersBtn.addEventListener('click', () => {
  const open = membersPanel.hidden;
  if (open && isNarrow()) {
    closeSidebar();
    drop.setPanel(false);
  }
  membersPanel.hidden = !open;
  membersBtn.classList.toggle('active', open);
});

dropBtn.addEventListener('click', () => {
  const open = !drop.isOpen();
  if (open && isNarrow()) {
    closeSidebar();
    membersPanel.hidden = true;
    membersBtn.classList.remove('active');
  }
  drop.setPanel(open);
});

searchBtn.addEventListener('click', () => {
  const open = !search.isOpen();
  if (open && isNarrow()) {
    closeSidebar();
    drop.setPanel(false);
    membersPanel.hidden = true;
    membersBtn.classList.remove('active');
  }
  search.setPanel(open);
});

searchInput.addEventListener('input', () => search.schedule());

searchCloseBtn.addEventListener('click', () => search.setPanel(false));
dropCloseBtn.addEventListener('click', () => drop.setPanel(false));
sidebarCloseBtn.addEventListener('click', closeSidebar);

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (sidebar.classList.contains('open')) closeSidebar();
  else if (search.isOpen()) search.setPanel(false);
  else if (drop.isOpen()) drop.setPanel(false);
});

voiceMuteBtn.addEventListener('click', () => voice.toggleMute());
voiceDeafenBtn.addEventListener('click', () => voice.toggleDeafen());
voiceLeaveBtn.addEventListener('click', () => voice.leave());
voiceAddBtn.addEventListener('click', () => {
  const name = prompt('Имя голосового канала (латиница, цифры, дефис):');
  if (!name) return;
  const slug = name.trim().toLowerCase();
  if (!/^[a-z0-9-]{1,24}$/.test(slug)) {
    systemLine('Недопустимое имя канала');
    return;
  }
  wsSend({ type: 'voice-channel-create', name: slug });
});
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
  gate.warnIfInsecure();
  gate.setMode('guest');
  logoutBtn.appendChild(icon('sign-out', 16));
  sidebarCloseBtn.appendChild(icon('cross', 18));
  dropCloseBtn.appendChild(icon('cross', 16));
  searchBtn.appendChild(icon('search', 18));
  searchCloseBtn.appendChild(icon('cross', 16));
  searchNote.textContent = search.hint;
  setButton(voiceLeaveBtn, 'cross');
  setButton(callBtn, 'phone', 'Позвонить');
  setButton(callAccept, 'phone', 'Принять');
  setButton(callDecline, 'cross', 'Отклонить');
  setButton(callHangup, 'phone', 'Завершить');
  setButton(sendBtn, 'chevron-right');
  setButton(attachBtn, 'paperclip');
  channelAddBtn.appendChild(icon('plus', 16));
  voiceAddBtn.appendChild(icon('plus', 16));
  menuBtn.appendChild(icon('menu', 20));
  membersBtn.appendChild(icon('users', 18));
  dropBtn.appendChild(icon('paperclip', 18));
  const { toggle } = mountSettings(settingsEl, {
    canChangePassword: () => joined && !isGuest,
    onSessions: (render) => {
      sessionsNote = render;
      wsSend({ type: 'sessions' });
    },
    onRevokeSession: (id) => wsSend({ type: 'session-revoke', id }),
    onApproveLink: (code, done) => {
      linkNote = done;
      wsSend({ type: 'link-approve', code });
    },
    onChangePassword: (current, next, done) => {
      passwordNote = done;
      wsSend({ type: 'change-password', current, next });
    },
    onLogoutEverywhere: () => wsSend({ type: 'logout', everywhere: true }),
  });
  setButton(toggle, 'gear');
  makeDraggable(callPanel, callGrip);
  settings.onMotionChange(applyMotionState);
  applyMotionState();
  membersPanel.hidden = window.innerWidth <= 720;
  membersBtn.classList.toggle('active', !membersPanel.hidden);

  try {
    authToken = localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    authToken = '';
  }
  if (authToken) {
    gate.setBusy(true);
    connect();
  }
}

initUI();
