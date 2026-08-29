import { fingerprint } from './fingerprint.js';

const DB = 'ws-chat-keys';
const STORE = 'device';
const RECORD = 'current';

// Пара живёт в браузере и наружу не выходит: закрытый ключ помечен
// неизвлекаемым, поэтому даже свой же код не сможет его прочитать — только
// попросить браузер посчитать общий секрет.
const ALGORITHM = { name: 'ECDH', namedCurve: 'P-256' };

function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function withStore(db, mode, run) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = run(tx.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function load(db) {
  const saved = await withStore(db, 'readonly', (store) => store.get(RECORD));
  return saved ?? null;
}

async function create(db) {
  const pair = await crypto.subtle.generateKey(ALGORITHM, false, ['deriveKey', 'deriveBits']);
  const raw = await crypto.subtle.exportKey('raw', pair.publicKey);
  const record = { privateKey: pair.privateKey, publicKey: pair.publicKey, raw };
  await withStore(db, 'readwrite', (store) => store.put(record, RECORD));
  return record;
}

function toBase64(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

// Ключ у каждого устройства свой и заводится один раз: пересоздать его — то же
// самое, что сменить устройство, и собеседникам придётся сверять заново.
export async function deviceKey() {
  const db = await open();
  const record = (await load(db)) ?? (await create(db));
  db.close();

  const digest = await crypto.subtle.digest('SHA-256', record.raw);
  return {
    publicKey: record.publicKey,
    privateKey: record.privateKey,
    published: toBase64(record.raw),
    fingerprint: fingerprint(digest),
  };
}

// Отпечаток чужого ключа считается по тем же правилам — иначе сверять было бы
// нечего.
export async function keyFingerprint(base64) {
  const raw = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return fingerprint(await crypto.subtle.digest('SHA-256', raw));
}
