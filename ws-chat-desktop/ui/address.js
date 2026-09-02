const SCHEMES = new Set(['http:', 'https:']);

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
