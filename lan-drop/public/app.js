const meEl = document.getElementById('me');
const hintEl = document.getElementById('hint');
const peersEl = document.getElementById('peers');
const transfersEl = document.getElementById('transfers');
const fileInput = document.getElementById('file-input');

const RECONNECT_MS = 2000;
const CHUNK_SIZE = 16 * 1024;
const BUFFER_LIMIT = 1 * 1024 * 1024;
const RTC_CONFIG = { iceServers: [] };

let myId = '';
let ws = null;
let reconnectTimer = null;
let pickTarget = null;
const peers = new Map();
const sessions = new Map();

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}`;
}

function connect() {
  ws = new WebSocket(wsUrl());
  ws.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    handleServer(message);
  });
  ws.addEventListener('close', scheduleReconnect);
  ws.addEventListener('error', () => ws.close());
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_MS);
}

function signal(to, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'signal', to, data }));
  }
}

function handleServer(message) {
  switch (message.type) {
    case 'welcome':
      myId = message.id;
      meEl.textContent = `вы: ${message.name}`;
      break;
    case 'peers':
      peers.clear();
      for (const peer of message.peers) peers.set(peer.id, peer);
      renderPeers();
      break;
    case 'peer-joined':
      peers.set(message.peer.id, message.peer);
      renderPeers();
      break;
    case 'peer-left':
      peers.delete(message.id);
      renderPeers();
      break;
    case 'signal':
      handleSignal(message.from, message.data);
      break;
  }
}

function renderPeers() {
  peersEl.replaceChildren();
  if (peers.size === 0) {
    hintEl.textContent = 'Никого рядом. Откройте lan-drop на другом устройстве в этой сети.';
    return;
  }
  hintEl.textContent = 'Нажмите на устройство, чтобы отправить файлы.';
  for (const peer of peers.values()) {
    const li = document.createElement('li');
    li.className = 'peer';
    li.textContent = peer.name;
    li.addEventListener('click', () => startPick(peer.id));
    peersEl.append(li);
  }
}

function startPick(peerId) {
  pickTarget = peerId;
  fileInput.value = '';
  fileInput.click();
}

fileInput.addEventListener('change', () => {
  const files = [...fileInput.files];
  if (pickTarget && files.length > 0) sendFiles(pickTarget, files);
  pickTarget = null;
});

function newSessionId() {
  return `${myId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function sendFiles(peerId, files) {
  const sid = newSessionId();
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const channel = pc.createDataChannel('files');
  channel.binaryType = 'arraybuffer';
  const total = files.reduce((sum, f) => sum + f.size, 0);
  const view = createTransferView(`→ ${peers.get(peerId)?.name ?? peerId}`);

  const session = { pc, channel, view };
  sessions.set(sid, session);

  pc.onicecandidate = (event) => {
    if (event.candidate) signal(peerId, { kind: 'ice', sid, candidate: event.candidate });
  };
  pc.onconnectionstatechange = () => {
    if (['failed', 'disconnected'].includes(pc.connectionState)) failTransfer(sid, 'соединение потеряно');
  };

  channel.onopen = async () => {
    try {
      let sent = 0;
      for (const file of files) {
        channel.send(JSON.stringify({ t: 'file', name: file.name, size: file.size, mime: file.type }));
        sent = await sendFileBody(channel, file, sent, total, view);
      }
      channel.send(JSON.stringify({ t: 'done' }));
      view.done('отправлено');
      setTimeout(() => closeSession(sid), 1500);
    } catch {
      failTransfer(sid, 'ошибка отправки');
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  signal(peerId, { kind: 'offer', sid, sdp: pc.localDescription });
}

async function sendFileBody(channel, file, sentBefore, total, view) {
  let offset = 0;
  let sent = sentBefore;
  while (offset < file.size) {
    if (channel.bufferedAmount > BUFFER_LIMIT) await waitForDrain(channel);
    const slice = file.slice(offset, offset + CHUNK_SIZE);
    const buffer = await slice.arrayBuffer();
    channel.send(buffer);
    offset += buffer.byteLength;
    sent += buffer.byteLength;
    view.progress(sent / total);
  }
  return sent;
}

function waitForDrain(channel) {
  return new Promise((resolve) => {
    channel.bufferedAmountLowThreshold = BUFFER_LIMIT / 2;
    channel.addEventListener('bufferedamountlow', () => resolve(), { once: true });
  });
}

async function handleSignal(from, data) {
  if (!data || typeof data !== 'object') return;
  const { kind, sid } = data;

  if (kind === 'offer') {
    await acceptOffer(from, sid, data.sdp);
    return;
  }

  const session = sessions.get(sid);
  if (!session) return;

  if (kind === 'answer') {
    await session.pc.setRemoteDescription(data.sdp);
  } else if (kind === 'ice') {
    try {
      await session.pc.addIceCandidate(data.candidate);
    } catch {
      /* кандидат может прийти до remoteDescription — браузер отбросит */
    }
  }
}

async function acceptOffer(from, sid, sdp) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const view = createTransferView(`← ${peers.get(from)?.name ?? from}`);
  const incoming = { name: '', size: 0, mime: '', received: 0, chunks: [], total: 0 };
  const session = { pc, view };
  sessions.set(sid, session);

  pc.onicecandidate = (event) => {
    if (event.candidate) signal(from, { kind: 'ice', sid, candidate: event.candidate });
  };
  pc.onconnectionstatechange = () => {
    if (['failed', 'disconnected'].includes(pc.connectionState)) failTransfer(sid, 'соединение потеряно');
  };

  pc.ondatachannel = (event) => {
    const channel = event.channel;
    channel.binaryType = 'arraybuffer';
    channel.onmessage = (msg) => receiveChunk(sid, incoming, msg.data);
  };

  await pc.setRemoteDescription(sdp);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  signal(from, { kind: 'answer', sid, sdp: pc.localDescription });
}

function receiveChunk(sid, incoming, chunk) {
  const session = sessions.get(sid);
  if (!session) return;

  if (typeof chunk === 'string') {
    const meta = JSON.parse(chunk);
    if (meta.t === 'file') {
      incoming.name = meta.name;
      incoming.size = meta.size;
      incoming.mime = meta.mime;
      incoming.received = 0;
      incoming.chunks = [];
    } else if (meta.t === 'done') {
      session.view.done('получено');
      setTimeout(() => closeSession(sid), 1500);
    }
    return;
  }

  incoming.chunks.push(chunk);
  incoming.received += chunk.byteLength;
  session.view.progress(incoming.size ? incoming.received / incoming.size : 0);

  if (incoming.received >= incoming.size) {
    saveFile(incoming.name, incoming.mime, incoming.chunks);
    incoming.chunks = [];
  }
}

function saveFile(name, mime, chunks) {
  const blob = new Blob(chunks, { type: mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function closeSession(sid) {
  const session = sessions.get(sid);
  if (!session) return;
  session.channel?.close();
  session.pc.close();
  session.view.remove();
  sessions.delete(sid);
}

function failTransfer(sid, reason) {
  const session = sessions.get(sid);
  if (!session) return;
  session.view.fail(reason);
  session.channel?.close();
  session.pc.close();
  sessions.delete(sid);
}

function createTransferView(label) {
  const li = document.createElement('li');
  li.className = 'transfer';
  const title = document.createElement('span');
  title.className = 'transfer-label';
  title.textContent = label;
  const bar = document.createElement('div');
  bar.className = 'bar';
  const fill = document.createElement('div');
  fill.className = 'fill';
  bar.append(fill);
  li.append(title, bar);
  transfersEl.append(li);

  return {
    progress(ratio) {
      fill.style.width = `${Math.min(100, Math.round(ratio * 100))}%`;
    },
    done(text) {
      fill.style.width = '100%';
      li.classList.add('ok');
      title.textContent = `${label} — ${text}`;
    },
    fail(text) {
      li.classList.add('err');
      title.textContent = `${label} — ${text}`;
    },
    remove() {
      li.remove();
    },
  };
}

connect();
