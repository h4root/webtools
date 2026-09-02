import { createReceiver } from './transfer.js';

const RECONNECT_MS = 2000;
const CHUNK_SIZE = 16 * 1024;
const BUFFER_LIMIT = 1 * 1024 * 1024;
const DROP_GRACE_MS = 8000;
const RTC_CONFIG = { iceServers: [] };

function defaultUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} ГБ`;
}

function safeName(name) {
  return String(name).replace(/[/\\]/g, '_').slice(0, 255) || 'file';
}

export function mountLanDrop(container, options = {}) {
  const url = options.url ?? defaultUrl();

  const meEl = el('div', 'lan-drop-me');
  const hintEl = el('p', 'lan-drop-hint', 'Ищу устройства в этой сети…');
  const peersEl = el('ul', 'lan-drop-peers');
  const asksEl = el('ul', 'lan-drop-asks');
  const transfersEl = el('ul', 'lan-drop-transfers');
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.hidden = true;
  container.append(meEl, hintEl, peersEl, asksEl, transfersEl, fileInput);

  const peers = new Map();
  const sessions = new Map();
  const asks = new Map();
  let myId = '';
  let ws = null;
  let reconnectTimer = null;
  let pickTarget = null;
  let destroyed = false;

  function connect() {
    ws = new WebSocket(url);
    ws.addEventListener('open', () => {
      if (!options.auth) return;
      const pass = typeof options.auth === 'function' ? options.auth() : options.auth;
      ws.send(typeof pass === 'string' ? pass : JSON.stringify(pass));
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
    ws.addEventListener('close', scheduleReconnect);
    ws.addEventListener('error', () => ws.close());
  }

  function scheduleReconnect() {
    if (reconnectTimer || destroyed) return;
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
        dropSessionsWith(message.id);
        break;
      case 'signal':
        handleSignal(message.from, message.data);
        break;
      case 'error':
        hintEl.textContent = message.reason;
        break;
    }
  }

  function peerName(id) {
    return peers.get(id)?.name ?? id;
  }

  function dropAsk(sid) {
    const ask = asks.get(sid);
    if (!ask) return;
    ask.node.remove();
    asks.delete(sid);
    options.onPending?.(asks.size);
  }

  function renderPeers() {
    peersEl.replaceChildren();
    if (peers.size === 0) {
      hintEl.textContent = options.emptyHint ?? 'Никого рядом. Откройте lan-drop на другом устройстве в этой сети.';
      return;
    }
    hintEl.textContent = 'Нажмите на устройство, чтобы отправить файлы.';
    for (const peer of peers.values()) {
      const li = el('li', 'peer', peer.name);
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
    if (pickTarget && files.length > 0) askPeer(pickTarget, files);
    pickTarget = null;
  });

  function askPeer(peerId, files) {
    const sid = crypto.randomUUID();
    const total = files.reduce((sum, f) => sum + f.size, 0);
    const view = createTransferView(`→ ${peerName(peerId)}`, `ждём ответа · ${files.length} шт · ${formatSize(total)}`, () =>
      abortTransfer(sid, 'отменено вами', true),
    );

    sessions.set(sid, { role: 'send', peerId, files, total, view, pc: null, channel: null, dropTimer: null, cancelled: false });
    signal(peerId, {
      kind: 'ask',
      sid,
      files: files.map((f) => ({ name: f.name, size: f.size, mime: f.type })),
      total,
    });
  }

  async function beginSend(sid) {
    const session = sessions.get(sid);
    if (!session || session.pc) return;

    const pc = new RTCPeerConnection(RTC_CONFIG);
    const channel = pc.createDataChannel('files');
    channel.binaryType = 'arraybuffer';
    session.pc = pc;
    session.channel = channel;
    session.view.status('соединяемся…');

    watchConnection(session, sid);
    pc.onicecandidate = (event) => {
      if (event.candidate) signal(session.peerId, { kind: 'ice', sid, candidate: event.candidate });
    };

    channel.onopen = async () => {
      try {
        let sent = 0;
        session.view.status('передаём…');
        for (const file of session.files) {
          channel.send(JSON.stringify({ t: 'file', name: file.name, size: file.size, mime: file.type }));
          sent = await sendFileBody(session, channel, file, sent);
        }
        if (session.cancelled) return;
        channel.send(JSON.stringify({ t: 'done' }));
        session.view.done('отправлено');
        setTimeout(() => closeSession(sid), 1500);
      } catch {
        failTransfer(sid, 'ошибка отправки');
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    signal(session.peerId, { kind: 'offer', sid, sdp: pc.localDescription });
  }

  async function sendFileBody(session, channel, file, sentBefore) {
    let offset = 0;
    let sent = sentBefore;
    while (offset < file.size) {
      if (session.cancelled) return sent;
      if (channel.readyState !== 'open') throw new Error('канал закрыт');
      if (channel.bufferedAmount > BUFFER_LIMIT) await waitForDrain(channel);
      const slice = file.slice(offset, offset + CHUNK_SIZE);
      const buffer = await slice.arrayBuffer();
      channel.send(buffer);
      offset += buffer.byteLength;
      sent += buffer.byteLength;
      session.view.progress(sent / session.total);
    }
    return sent;
  }

  function waitForDrain(channel) {
    return new Promise((resolve) => {
      channel.bufferedAmountLowThreshold = BUFFER_LIMIT / 2;
      const settle = () => {
        channel.removeEventListener('bufferedamountlow', settle);
        channel.removeEventListener('close', settle);
        resolve();
      };
      channel.addEventListener('bufferedamountlow', settle);
      channel.addEventListener('close', settle);
    });
  }

  function watchConnection(session, sid) {
    session.pc.onconnectionstatechange = () => {
      const state = session.pc.connectionState;
      if (state === 'connected') {
        clearTimeout(session.dropTimer);
        session.dropTimer = null;
        return;
      }
      if (state === 'failed' || state === 'closed') {
        failTransfer(sid, 'соединение потеряно');
        return;
      }
      if (state === 'disconnected' && !session.dropTimer) {
        session.view.status('связь пропала, ждём…');
        session.dropTimer = setTimeout(() => {
          session.dropTimer = null;
          if (session.pc?.connectionState === 'disconnected') failTransfer(sid, 'соединение потеряно');
        }, DROP_GRACE_MS);
      }
    };
  }

  async function handleSignal(from, data) {
    if (!data || typeof data !== 'object') return;
    const { kind, sid } = data;

    if (kind === 'ask') {
      showAsk(from, sid, data.files ?? [], data.total ?? 0);
      return;
    }
    if (kind === 'accept') {
      await beginSend(sid);
      return;
    }
    if (kind === 'decline') {
      const session = sessions.get(sid);
      if (session) {
        session.view.fail('отклонено');
        sessions.delete(sid);
      }
      return;
    }
    if (kind === 'cancel') {
      dropAsk(sid);
      abortTransfer(sid, 'отменено на той стороне', false);
      return;
    }
    if (kind === 'offer') {
      await acceptOffer(from, sid, data.sdp);
      return;
    }

    const session = sessions.get(sid);
    if (!session?.pc) return;

    if (kind === 'answer') {
      await session.pc.setRemoteDescription(data.sdp);
    } else if (kind === 'ice') {
      try {
        await session.pc.addIceCandidate(data.candidate);
      } catch {}
    }
  }

  function showAsk(from, sid, files, total) {
    const li = el('li', 'ask');
    const streams = supportsDiskWrite();
    const lines = files.slice(0, 5).map((f) => `${safeName(f.name)} · ${formatSize(f.size)}`);
    if (files.length > 5) lines.push(`…и ещё ${files.length - 5}`);

    li.append(el('div', 'ask-who', `${peerName(from)} хочет отправить ${files.length} файл(ов) · ${formatSize(total)}`));
    li.append(el('div', 'ask-files', lines.join('\n')));
    if (!streams) {
      li.append(el('div', 'ask-warn', 'Этот браузер не умеет писать на диск по ходу приёма: файл будет целиком храниться в памяти вкладки.'));
    }

    const actions = el('div', 'ask-actions');
    const accept = el('button', 'ask-accept', 'Принять');
    const decline = el('button', 'ask-decline', 'Отклонить');
    accept.type = 'button';
    decline.type = 'button';
    actions.append(accept, decline);
    li.append(actions);
    asksEl.append(li);
    asks.set(sid, { node: li, from });
    options.onPending?.(asks.size);

    decline.addEventListener('click', () => {
      dropAsk(sid);
      signal(from, { kind: 'decline', sid });
    });

    accept.addEventListener('click', async () => {
      accept.disabled = true;
      decline.disabled = true;
      let openSink;
      try {
        openSink = await chooseSink(files);
      } catch {
        dropAsk(sid);
        signal(from, { kind: 'decline', sid });
        return;
      }
      if (!asks.has(sid)) return;
      dropAsk(sid);
      prepareReceive(from, sid, total, openSink);
      signal(from, { kind: 'accept', sid });
    });
  }

  function supportsDiskWrite() {
    return typeof window.showSaveFilePicker === 'function' || typeof window.showDirectoryPicker === 'function';
  }

  async function chooseSink(files) {
    if (files.length === 1 && typeof window.showSaveFilePicker === 'function') {
      const handle = await window.showSaveFilePicker({ suggestedName: safeName(files[0].name) });
      let used = false;
      return async () => {
        if (used) throw new Error('ожидался один файл');
        used = true;
        return diskSink(await handle.createWritable());
      };
    }

    if (typeof window.showDirectoryPicker === 'function') {
      const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
      return async (meta) => {
        const handle = await dir.getFileHandle(safeName(meta.name), { create: true });
        return diskSink(await handle.createWritable());
      };
    }

    return async (meta) => memorySink(meta);
  }

  function diskSink(writable) {
    return {
      write: (chunk) => writable.write(chunk),
      close: () => writable.close(),
      abort: () => writable.abort?.(),
    };
  }

  function memorySink(meta) {
    const chunks = [];
    return {
      write(chunk) {
        chunks.push(chunk);
      },
      close() {
        const blob = new Blob(chunks, { type: meta.mime || 'application/octet-stream' });
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = safeName(meta.name);
        a.click();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
        chunks.length = 0;
      },
      abort() {
        chunks.length = 0;
      },
    };
  }

  function prepareReceive(from, sid, total, openSink) {
    const view = createTransferView(`← ${peerName(from)}`, 'соединяемся…', () => abortTransfer(sid, 'отменено вами', true));
    let done = 0;

    const receiver = createReceiver({
      openSink,
      onFileStart: (file) => view.status(`принимаем ${safeName(file.name)}`),
      onProgress: (got, size) => view.progress(total ? (done + got) / total : got / (size || 1)),
      onFileDone: (file) => {
        done += file.size;
        view.progress(total ? done / total : 1);
      },
      onDone: () => {
        view.done('получено');
        setTimeout(() => closeSession(sid), 1500);
      },
    });

    sessions.set(sid, { role: 'receive', peerId: from, view, receiver, pc: null, dropTimer: null, cancelled: false });
  }

  async function acceptOffer(from, sid, sdp) {
    const session = sessions.get(sid);
    if (!session || session.role !== 'receive' || session.pc) return;

    const pc = new RTCPeerConnection(RTC_CONFIG);
    session.pc = pc;
    watchConnection(session, sid);

    pc.onicecandidate = (event) => {
      if (event.candidate) signal(from, { kind: 'ice', sid, candidate: event.candidate });
    };
    pc.ondatachannel = (event) => {
      const channel = event.channel;
      channel.binaryType = 'arraybuffer';
      session.channel = channel;
      let queue = Promise.resolve();
      channel.onmessage = (msg) => {
        queue = queue.then(() => session.receiver.handle(msg.data)).catch(() => failTransfer(sid, 'ошибка записи'));
      };
    };

    await pc.setRemoteDescription(sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    signal(from, { kind: 'answer', sid, sdp: pc.localDescription });
  }

  function dropSessionsWith(peerId) {
    for (const [sid, session] of sessions) {
      if (session.peerId === peerId) failTransfer(sid, 'устройство отключилось');
    }
    for (const [sid, ask] of asks) {
      if (ask.from === peerId) dropAsk(sid);
    }
  }

  function closeSession(sid) {
    const session = sessions.get(sid);
    if (!session) return;
    clearTimeout(session.dropTimer);
    session.channel?.close();
    session.pc?.close();
    session.view.remove();
    sessions.delete(sid);
  }

  function abortTransfer(sid, reason, tellPeer) {
    const session = sessions.get(sid);
    if (!session) return;
    session.cancelled = true;
    clearTimeout(session.dropTimer);
    if (tellPeer) signal(session.peerId, { kind: 'cancel', sid });
    session.view.fail(reason);
    session.receiver?.abort();
    session.channel?.close();
    session.pc?.close();
    sessions.delete(sid);
  }

  function failTransfer(sid, reason) {
    abortTransfer(sid, reason, false);
  }

  function createTransferView(label, initial, onCancel) {
    const li = el('li', 'transfer');
    const title = el('span', 'transfer-label', label);
    const state = el('span', 'transfer-status', initial ?? '');
    const cancel = el('button', 'transfer-cancel', 'Отменить');
    const bar = el('div', 'bar');
    const fill = el('div', 'fill');
    cancel.type = 'button';
    cancel.title = 'Прервать передачу';
    cancel.addEventListener('click', () => {
      cancel.disabled = true;
      onCancel?.();
    });
    const head = el('div', 'transfer-head');
    head.append(title, cancel);
    bar.append(fill);
    li.append(head, state, bar);
    transfersEl.append(li);

    return {
      status(text) {
        state.textContent = text;
      },
      progress(ratio) {
        fill.style.width = `${Math.min(100, Math.round(ratio * 100))}%`;
      },
      done(text) {
        fill.style.width = '100%';
        li.classList.add('ok');
        state.textContent = text;
        cancel.remove();
      },
      fail(text) {
        li.classList.add('err');
        state.textContent = text;
        cancel.remove();
      },
      remove() {
        li.remove();
      },
    };
  }

  connect();

  return {
    destroy() {
      destroyed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        ws.removeEventListener('close', scheduleReconnect);
        ws.close();
      }
      for (const sid of [...sessions.keys()]) closeSession(sid);
      asks.clear();
      options.onPending?.(0);
      container.replaceChildren();
    },
  };
}
