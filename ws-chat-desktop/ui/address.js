const SCHEMES = new Set(['http:', 'https:']);

// Адрес люди списывают с экрана сервера и набирают по-разному: с портом и
// без, со схемой и без, иногда со слэшем на конце. Приводим к одному виду,
// чтобы «недавние» не размножались на пять записей об одном сервере.
export function normalizeAddress(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;

  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }

  if (!SCHEMES.has(url.protocol) || !url.hostname) return null;
  return url.origin;
}

export function addressLabel(origin) {
  const url = new URL(origin);
  return url.protocol === 'https:' ? `${url.host} · зашифровано` : url.host;
}

export function rememberAddress(list, origin, limit = 5) {
  return [origin, ...list.filter((item) => item !== origin)].slice(0, limit);
}

// К этому серверу уже ходили по https, а теперь предлагают простой http.
// Само по себе так не бывает: либо сервер переставили, либо кто-то в сети
// уводит соединение туда, где пароль виден целиком.
export function downgraded(list, origin) {
  const now = new URL(origin);
  if (now.protocol !== 'http:') return false;
  return list.some((known) => {
    try {
      const seen = new URL(known);
      return seen.protocol === 'https:' && seen.host === now.host;
    } catch {
      return false;
    }
  });
}
