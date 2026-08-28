import { createVoice } from './voice.js';
import { createCall } from './call.js';
import { icon, setButton } from './icons.js';
import { mountSettings } from './settings.js';

import {
  gateScreen,
  nickInput,
  logoutBtn,
  appEl,
  meEl,
  channelAddBtn,
  chatTitle,
  typingEl,
  composer,
  textInput,
  attachBtn,
  fileInput,
  menuBtn,
  sidebar,
  backdrop,
  membersBtn,
  membersPanel,
  voiceAddBtn,
  callBtn,
  sendBtn,
  settingsEl,
  connBanner,
  searchBtn,
  searchInput,
  headerSearch,
  searchHead,
  searchCloseBtn,
  searchNote,
  dropBtn,
  dropCloseBtn,
  sidebarCloseBtn,
} from './dom.js';
import { createSocket } from './socket.js';
import { createAttachments } from './attachments.js';
import { createSearch } from './search.js';
import { createGate } from './gate.js';
import { createDrop } from './drop.js';
import { createContextMenu } from './menu.js';
import { createNav } from './nav.js';
import { createLog } from './log.js';
import { createReply } from './reply.js';
import { createQuote } from './quote.js';
import { createLightbox } from './lightbox.js';
import { createVoiceView } from './voiceview.js';
import { createCallView } from './callview.js';
import { keyOf, messageKey, channelSlug } from './keys.js';
import { appendMention } from './linkify.js';
import { avatarHue } from './grouping.js';
import { createTyping } from './typing.js';
import { createReactions } from './reactions.js';
import { createDropZone } from './dnd.js';
import { isNarrow, deviceLabel } from './format.js';

// Держится вручную в согласии с PROTOCOL_VERSION на сервере: вкладка,
// открытая до его обновления, узнаёт об этом по расхождению.
const PROTOCOL_VERSION = 1;
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
let voiceChannels = [];
let voicePresence = {};
let callPhase = 'idle';
let staleClient = false;

const conversations = new Map();
const loaded = new Set();
const historyReady = new Set();
const unread = new Map();
const readMarks = new Map();

function activeKey() {
  return keyOf(active.kind, active.id);
}

function convOf(key) {
  if (!conversations.has(key)) conversations.set(key, []);
  return conversations.get(key);
}

// Снимок для тех, кто только рисует: списки в боковой панели читают состояние,
// но не меняют его.
function snapshot() {
  return { me: myNick, channels, online, partners: dmPartners, active, unread, voiceChannels, voicePresence };
}

const socket = createSocket({
  isJoined: () => joined,
  hello: sendHello,
  onMessage: (message) => handleServer(message),
  onDown: () => {
    voice.reset();
    call.hangup();
    loaded.clear();
    historyReady.clear();
    renderConnState();
  },
  onQueueChange: renderConnState,
});

const send = socket.send;

const voice = createVoice({
  send,
  onState: (state) => voiceView.render(state),
  onError: (reason) => log.system(reason),
  onSpeaking: (nicks) => nav.applySpeaking(nicks),
  getNick: () => myNick,
});

let callView = null;
const call = createCall({
  send,
  onState: (state) => callView.render(state),
  onLevels: (levels) => callView.renderLevels(levels),
  onError: (reason) => log.system(reason),
});
callView = createCallView({
  call,
  getPeer: () => active.id,
  onPhase: (phase) => {
    callPhase = phase;
    updateCallButton();
  },
});

const voiceView = createVoiceView({
  voice,
  send,
  getState: snapshot,
  onError: (reason) => log.system(reason),
});

const attachments = createAttachments({
  getToken: () => authToken,
  onError: (reason) => log.system(reason),
  onOpenImage: (att) => lightbox.open(att),
});

const quote = createQuote({ urlOf: (att) => attachments.urlOf(att) });

const lightbox = createLightbox({
  getMessages: () => convOf(activeKey()),
  urlOf: (att) => attachments.urlOf(att),
});

const typing = createTyping({ send, onChange: renderTyping });
const reactions = createReactions({ send, getNick: () => myNick, findMessage: (id) => findMessage(id) });
const gate = createGate({ request: socket.request });

function copy(text, done) {
  navigator.clipboard.writeText(text).then(
    () => log.system(done),
    () => log.system('Не удалось скопировать'),
  );
}

createContextMenu({
  getNick: () => myNick,
  findMessage: (id) => findMessage(id),
  channelCount: () => channels.length,
  voiceCurrent: () => voiceView.current(),
  actions: {
    reply: ({ message }) => reply.set(message),
    react: ({ message, row }) => reactions.open(row, message),
    'copy-text': ({ message }) => copy(message.text, 'Текст скопирован'),
    jump: ({ message }) => log.scrollTo(message.replyTo.id),
    edit: ({ message }) => log.edit(message),
    delete: ({ message }) => {
      if (confirm('Удалить сообщение?')) send({ type: 'delete', id: message.id });
    },
    dm: ({ nick }) => openConversation('dm', nick),
    mention: ({ nick }) => {
      textInput.value = appendMention(textInput.value, nick);
      textInput.focus();
    },
    'copy-nick': ({ nick }) => copy(nick, 'Ник скопирован'),
    'open-link': ({ link }) => window.open(link, '_blank', 'noopener,noreferrer'),
    'copy-link': ({ link }) => copy(link, 'Адрес скопирован'),
    'mark-read': () => markActiveRead(),
    find: () => showPanel('search'),
    'to-bottom': () => log.scrollToBottom(),
    'open-image': ({ attachment }) => lightbox.open(attachment),
    download: ({ attachment }) => attachments.download(attachment),
    'copy-file': ({ attachment }) => copy(attachment.name, 'Имя файла скопировано'),
    'open-channel': ({ channel }) => openConversation('channel', channel.name),
    'copy-channel': ({ channel }) => copy(channel.name, 'Имя канала скопировано'),
    'delete-channel': ({ channel }) => {
      if (confirm(`Удалить канал #${channel.name} вместе с историей?`)) send({ type: 'channel-delete', name: channel.name });
    },
    'voice-toggle': ({ voice: target }) => {
      if (target.joined) voice.leave();
      else voice.join(target.name);
    },
    'delete-voice': ({ voice: target }) => {
      if (confirm(`Удалить голосовой канал ${target.name}?`)) send({ type: 'voice-channel-delete', name: target.name });
    },
  },
});
createDropZone({ isReady: () => joined, onFiles: (files) => attachments.add(files) });

const nav = createNav({
  getState: snapshot,
  send,
  onOpen: (kind, id) => openConversation(kind, id),
});

const reply = createReply({ quote });

const log = createLog({
  getNick: () => myNick,
  send,
  attachments,
  reactions,
  quote,
  onReply: (msg) => reply.set(msg),
  getMessages: () => convOf(activeKey()),
  onSeen: () => markActiveRead(),
  onRendered: () => search.flushJump(),
});

const drop = createDrop({
  getToken: () => authToken,
  onPendingChange: () => renderDocumentTitle(),
});

const search = createSearch({
  send,
  getNick: () => myNick,
  openConversation: (kind, id) => openConversation(kind, id),
  activeKey,
  findRow: (id) => log.rowOf(id),
  scrollToMessage: (id) => log.scrollTo(id),
  historyArrived: (key) => historyReady.has(key),
});

function sendHello() {
  if (authToken) socket.request({ type: 'auth', mode: 'resume', token: authToken });
  else if (gate.mode() === 'link') socket.request({ type: 'link-request', device: deviceLabel() });
  else if (gate.pending()) socket.request({ type: 'auth', ...gate.pending() });
}

function renderConnState() {
  const live = socket.isOpen() && joined;
  // Сервер обновился, а эта вкладка осталась на старом коде: дальше она может
  // не понять новых сообщений, поэтому говорим об этом вместо молчания.
  if (staleClient) {
    connBanner.hidden = false;
    connBanner.textContent = 'Чат обновился — перезагрузи страницу';
    return;
  }
  connBanner.hidden = Boolean(live);
  if (live) return;
  const queued = socket.queued();
  connBanner.textContent = queued ? `Нет связи — переподключаюсь, в очереди ${queued}` : 'Нет связи — переподключаюсь…';
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

function markKey(mark) {
  return mark.channel ? `ch:${mark.channel}` : `dm:${mark.to.toLowerCase()}`;
}

function handleServer(message) {
  switch (message.type) {
    case 'welcome':
      if (message.protocol !== PROTOCOL_VERSION) staleClient = true;
      myNick = message.nick;
      authToken = message.token;
      isGuest = message.guest;
      gate.clearPending();
      try {
        localStorage.setItem(TOKEN_KEY, authToken);
      } catch {}
      if (!joined) enterApp();
      renderConnState();
      socket.flush();
      break;
    case 'channels':
      channels = message.list;
      if (!channels.includes(active.id) && active.kind === 'channel') active.id = channels[0] ?? 'general';
      typing.watch(activeKey());
      renderChannels();
      requestHistory(active);
      break;
    case 'presence':
      online = message.users.filter((nick) => nick !== myNick);
      renderChannels();
      nav.renderMembers();
      call.handlePresence(message.users);
      break;
    case 'dms':
      dmPartners = message.list.map((d) => ({ nick: d.nick, ts: d.ts }));
      renderChannels();
      break;
    case 'history': {
      const key = markKey(message);
      conversations.set(key, message.messages);
      loaded.add(key);
      historyReady.add(key);
      if (key === activeKey()) log.render();
      break;
    }
    case 'search':
      search.renderResults(message.query, message.messages);
      break;
    case 'reads':
      for (const mark of message.list) {
        readMarks.set(markKey(mark), mark.id);
        if (mark.unread) unread.set(markKey(mark), mark.unread);
      }
      renderChannels();
      break;
    // Прочитано на другом устройстве этого же аккаунта.
    case 'read': {
      const key = markKey(message);
      readMarks.set(key, Math.max(readMarks.get(key) ?? 0, message.id));
      unread.set(key, 0);
      renderChannels();
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
      reactions.apply(message.id, message.reactions);
      break;
    case 'typing':
      typing.receive(message);
      break;
    case 'system':
      log.system(message.text);
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
      } else log.system(message.reason);
      break;
    case 'voice-channels':
      voiceChannels = message.list;
      voiceView.renderChannels();
      break;
    case 'voice-roster':
      voice.handleRoster(message.channel, message.users);
      break;
    case 'voice-mute':
      voice.handleMute(message.nick, message.muted);
      voiceView.renderChannels();
      break;
    case 'voice-left':
      voice.reset();
      if (message.reason) log.system(message.reason);
      break;
    case 'voice-signal':
      voice.handleSignal(message.from, message.data);
      break;
    case 'voice-presence':
      voicePresence = message.channels;
      voiceView.renderChannels();
      nav.renderMembers();
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
  socket.stop();
  returnToGate(reason ?? (isGuest ? 'Гостевая личность стёрта' : 'Вы вышли'));
}

function returnToGate(reason) {
  joined = false;
  voice.reset();
  call.hangup();
  socket.reset();
  conversations.clear();
  loaded.clear();
  historyReady.clear();
  unread.clear();
  readMarks.clear();
  typing.reset();
  renderDocumentTitle();
  dmPartners = [];
  online = [];
  attachments.releaseUrls();
  lightbox.close();
  log.clear();
  reply.clear();
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
  else log.render();
  renderChannels();
}

function enterApp() {
  joined = true;
  gateScreen.hidden = true;
  appEl.hidden = false;
  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  avatar.style.setProperty('--hue', avatarHue(myNick));
  avatar.textContent = myNick.slice(0, 1).toUpperCase();
  const name = document.createElement('span');
  name.className = isGuest ? 'me-name guest' : 'me-name';
  name.textContent = `@${myNick}`;
  meEl.replaceChildren(avatar, name);
  renderChannels();
  updateTitle();
  typing.watch(activeKey());
  drop.start();
  textInput.focus();
}

function receiveMessage(msg) {
  if (msg.nonce) socket.confirm(msg.nonce);
  const key = messageKey(msg, myNick);
  const list = convOf(key);
  // Повтор после обрыва возвращает то же сообщение: показать его второй раз
  // нельзя.
  if (list.some((known) => known.id === msg.id)) return;
  list.push(msg);
  typing.clear(key, msg.from);
  if (msg.to !== undefined) rememberPartner(msg.from === myNick ? msg.to : msg.from, msg.ts);
  if (key === activeKey()) {
    log.append(msg);
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

function findMessage(id) {
  for (const list of conversations.values()) {
    const found = list.find((msg) => msg.id === id);
    if (found) return found;
  }
  return null;
}

function applyEdit(id, text) {
  const msg = findMessage(id);
  if (!msg) return;
  msg.text = text;
  msg.edited = true;
  log.update(msg);
}

function applyDelete(id) {
  for (const list of conversations.values()) {
    const idx = list.findIndex((msg) => msg.id === id);
    if (idx !== -1) list.splice(idx, 1);
  }
  log.remove(id);
}

// Прочитанным считается то, что ты видел: разговор открыт и ты внизу. Отметка
// только растёт, поэтому лишних сообщений на сервер не уходит.
function markActiveRead() {
  const key = activeKey();
  const list = conversations.get(key);
  const newest = list?.length ? list[list.length - 1].id : 0;
  if (!newest || (readMarks.get(key) ?? 0) >= newest) return;
  readMarks.set(key, newest);
  unread.set(key, 0);
  send(active.kind === 'channel' ? { type: 'read', channel: active.id, id: newest } : { type: 'read', to: active.id, id: newest });
}

function openConversation(kind, id) {
  active = { kind, id };
  unread.set(activeKey(), 0);
  updateTitle();
  renderChannels();
  requestHistory(active);
  log.render();
  typing.watch(activeKey());
  updateCallButton();
  closeSidebar();
  textInput.focus();
}

function requestHistory(target) {
  const key = keyOf(target.kind, target.id);
  if (loaded.has(key)) return;
  loaded.add(key);
  send(target.kind === 'channel' ? { type: 'history', channel: target.id } : { type: 'history', to: target.id });
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
  nav.renderChannels();
  updateCallButton();
}

function renderTyping(nicks) {
  typingEl.replaceChildren();
  if (nicks.length === 0) return;
  const verb = nicks.length === 1 ? 'печатает' : 'печатают';
  typingEl.appendChild(document.createTextNode(`${nicks.join(', ')} ${verb} `));
  const dots = document.createElement('span');
  dots.className = 'typing-dots';
  dots.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
  typingEl.appendChild(dots);
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
  showPanel(null);
}

logoutBtn.addEventListener('click', () => {
  const question = isGuest
    ? 'Выйти? Гостевая личность стирается: ник освободится, а все твои сообщения и вложения будут удалены безвозвратно.'
    : 'Выйти из аккаунта на этом устройстве?';
  if (confirm(question)) send({ type: 'logout' });
});

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = textInput.value.trim();
  const files = attachments.pending();
  if (!text && files.length === 0) return;
  const base = active.kind === 'channel' ? { channel: active.id } : { to: active.id };
  socket.sendMessage({
    type: 'message',
    ...base,
    text,
    replyTo: reply.id(),
    attachments: files.length ? files : undefined,
    nonce: socket.newNonce(),
  });
  textInput.value = '';
  attachments.clear();
  reply.clear();
});

attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  attachments.add([...fileInput.files]);
  fileInput.value = '';
});

textInput.addEventListener('input', () => {
  if (textInput.value.trim()) typing.send(active);
});

channelAddBtn.addEventListener('click', () => {
  const name = prompt('Имя канала (латиница, цифры, дефис):');
  if (!name) return;
  const slug = channelSlug(name);
  if (!slug) {
    log.system('Недопустимое имя канала');
    return;
  }
  send({ type: 'channel-create', name: slug });
});

menuBtn.addEventListener('click', () => {
  if (sidebar.classList.contains('open')) closeSidebar();
  else openSidebar();
});
backdrop.addEventListener('click', closeSidebar);

// Поле поиска одно на весь чат, но живёт в двух местах: на широком экране
// стоит в шапке на виду, на узком там нет места — и оно переезжает в саму
// панель, иначе искать было бы нечем.
const wide = window.matchMedia('(min-width: 721px)');

function placeSearchField() {
  const home = wide.matches ? headerSearch : searchHead;
  if (searchInput.parentElement !== home) {
    if (home === searchHead) home.insertBefore(searchInput, searchCloseBtn);
    else home.appendChild(searchInput);
  }
}

wide.addEventListener('change', placeSearchField);

// Правых панелей три, а места под них — одно: открытая вытесняет соседнюю.
// Иначе на нешироком окне третья уезжает под боковую панель.
function showPanel(name) {
  membersPanel.hidden = name !== 'members';
  membersBtn.classList.toggle('active', name === 'members');
  drop.setPanel(name === 'drop');
  search.setPanel(name === 'search');
  if (name && isNarrow()) closeSidebar();
}

membersBtn.addEventListener('click', () => {
  showPanel(membersPanel.hidden ? 'members' : null);
});

dropBtn.addEventListener('click', () => {
  showPanel(drop.isOpen() ? null : 'drop');
});

searchBtn.addEventListener('click', () => {
  showPanel(search.isOpen() ? null : 'search');
});

searchInput.addEventListener('input', () => {
  // Панель поднимается сама, как только есть что искать: лишний клик по лупе
  // на широком экране не нужен.
  if (searchInput.value.trim()) showPanel('search');
  else search.setPanel(false);
  search.schedule();
});

searchCloseBtn.addEventListener('click', () => search.clear());
dropCloseBtn.addEventListener('click', () => drop.setPanel(false));
sidebarCloseBtn.addEventListener('click', closeSidebar);

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (lightbox.isOpen()) return;
  if (sidebar.classList.contains('open')) closeSidebar();
  else if (search.isOpen()) search.clear();
  else if (drop.isOpen()) drop.setPanel(false);
});

function initUI() {
  placeSearchField();
  gate.warnIfInsecure();
  gate.setMode('guest');
  logoutBtn.appendChild(icon('sign-out', 16));
  sidebarCloseBtn.appendChild(icon('cross', 18));
  dropCloseBtn.appendChild(icon('cross', 16));
  searchBtn.appendChild(icon('search', 18));
  searchCloseBtn.appendChild(icon('cross', 16));
  searchNote.textContent = search.hint;
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
      send({ type: 'sessions' });
    },
    onRevokeSession: (id) => send({ type: 'session-revoke', id }),
    onApproveLink: (code, done) => {
      linkNote = done;
      send({ type: 'link-approve', code });
    },
    onChangePassword: (current, next, done) => {
      passwordNote = done;
      send({ type: 'change-password', current, next });
    },
    onLogoutEverywhere: () => send({ type: 'logout', everywhere: true }),
  });
  setButton(toggle, 'gear');
  membersPanel.hidden = window.innerWidth <= 720;
  membersBtn.classList.toggle('active', !membersPanel.hidden);

  try {
    authToken = localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    authToken = '';
  }
  if (authToken) {
    gate.setBusy(true);
    socket.connect();
  }
}

initUI();
