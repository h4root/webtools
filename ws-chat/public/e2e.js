export const ENVELOPE_VERSION = 1;

const ALGORITHM = { name: 'ECDH', namedCurve: 'P-256' };
const IV_BYTES = 12;
const KEY_BYTES = 32;

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text) {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

async function wrappingKey(privateKey, publicRaw, deviceId, salt, usages) {
  const peer = await crypto.subtle.importKey('raw', publicRaw, ALGORITHM, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256);
  const base = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode(deviceId) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    usages,
  );
}

export async function seal(text, recipients) {
  if (!recipients.length) throw new Error('Некому адресовать сообщение');

  const ephemeral = await crypto.subtle.generateKey(ALGORITHM, false, ['deriveBits']);
  const epk = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));

  const messageKey = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const key = await crypto.subtle.importKey('raw', messageKey, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));

  const to = [];
  for (const recipient of recipients) {
    const wrapping = await wrappingKey(ephemeral.privateKey, fromBase64(recipient.key), recipient.id, epk, ['encrypt']);
    const wrapIv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapIv }, wrapping, messageKey);
    to.push({ id: recipient.id, iv: toBase64(wrapIv), ct: toBase64(wrapped) });
  }

  return { v: ENVELOPE_VERSION, epk: toBase64(epk), iv: toBase64(iv), ct: toBase64(ct), to };
}

export async function open(envelope, device) {
  if (envelope?.v !== ENVELOPE_VERSION) return null;
  const slot = envelope.to?.find((item) => item.id === device.id);
  if (!slot) return null;

  try {
    const epk = fromBase64(envelope.epk);
    const wrapping = await wrappingKey(device.privateKey, epk, device.id, epk, ['decrypt']);
    const messageKey = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(slot.iv) },
      wrapping,
      fromBase64(slot.ct),
    );
    const key = await crypto.subtle.importKey('raw', messageKey, 'AES-GCM', false, ['decrypt']);
    const text = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(envelope.iv) }, key, fromBase64(envelope.ct));
    return new TextDecoder().decode(text);
  } catch {
    return null;
  }
}
