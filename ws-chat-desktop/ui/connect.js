import { normalizeAddress, addressLabel, rememberAddress, downgraded } from './address.js';

const STORE_KEY = 'ws-chat-servers';
const PROBE_MS = 4000;

const form = document.getElementById('form');
const input = document.getElementById('address');
const button = document.getElementById('connect');
const note = document.getElementById('note');
const recentBox = document.getElementById('recent-box');
const recentList = document.getElementById('recent');

function readRecent() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]');
    return Array.isArray(saved) ? saved.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function saveRecent(list) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
  } catch {}
}

function say(text, kind = 'error') {
  note.hidden = !text;
  note.textContent = text;
  note.className = `note ${kind}`;
}

function busy(on) {
  button.disabled = on;
  button.textContent = on ? 'Проверяю…' : 'Подключиться';
}

// Прежде чем уводить окно на сервер, спрашиваем его самого: так опечатка в
// адресе видна сразу, а не пустой страницей без объяснений. Запрос идёт через
// нативную часть — у окна свой origin, и обычный fetch сюда не пустили бы.
const request = window.__TAURI__?.http?.fetch ?? fetch;

async function probe(origin) {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), PROBE_MS);
  try {
    const res = await request(`${origin}/health`, { signal: stop.signal });
    const body = await res.json();
    if (typeof body?.status !== 'string') return { ok: false, reason: 'По этому адресу отвечает не ws-chat' };
    return { ok: true, degraded: body.status !== 'ok', reason: body.reason };
  } catch (error) {
    if (error.name === 'AbortError') return { ok: false, reason: 'Сервер не ответил за четыре секунды' };
    return { ok: false, reason: 'Не удалось соединиться — проверь адрес и что сервер запущен' };
  } finally {
    clearTimeout(timer);
  }
}

async function go(raw) {
  const origin = normalizeAddress(raw);
  if (!origin) {
    say('Непонятный адрес. Пример: 192.168.1.10:3000');
    input.focus();
    return;
  }

  if (downgraded(readRecent(), origin)) {
    say('Раньше этот сервер отвечал по https, а сейчас предлагает открытое соединение. Пароль по нему уйдёт незашифрованным — проверь, что происходит, прежде чем входить.');
    return;
  }

  busy(true);
  say('');
  const result = await probe(origin);
  busy(false);

  if (!result.ok) {
    // Самоподписанный сертификат системный webview просто отвергает, и со
    // стороны это выглядит как «сервер не отвечает».
    const hint = origin.startsWith('https:')
      ? ' Если сертификат самоподписанный, система его не примет — добавь его в доверенные.'
      : '';
    say(result.reason + hint);
    return;
  }

  saveRecent(rememberAddress(readRecent(), origin));
  if (result.degraded) say(`Сервер отвечает, но ${result.reason ?? 'работает не полностью'}. Открываю.`, 'warn');
  location.replace(origin);
}

function renderRecent() {
  const list = readRecent();
  recentBox.hidden = list.length === 0;
  recentList.replaceChildren();
  for (const origin of list) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = addressLabel(origin);
    button.addEventListener('click', () => go(origin));
    item.appendChild(button);
    recentList.appendChild(item);
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  go(input.value);
});

renderRecent();
input.value = readRecent()[0] ?? '';
input.focus();
input.select();
