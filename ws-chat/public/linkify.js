const MENTION = /^[\p{L}\p{N}_.-]+/u;
const LINK_START = /https?:\/\//i;
const TRAILING = /[.,;:!?]+$/;

function isAllowed(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function trimTail(raw) {
  let value = raw.replace(TRAILING, '');
  while (value.endsWith(')')) {
    const opens = (value.match(/\(/g) ?? []).length;
    const closes = (value.match(/\)/g) ?? []).length;
    if (opens >= closes) break;
    value = value.slice(0, -1).replace(TRAILING, '');
  }
  return value;
}

function pushText(parts, value) {
  if (!value) return;
  const last = parts[parts.length - 1];
  if (last?.kind === 'text') last.value += value;
  else parts.push({ kind: 'text', value });
}

export function splitText(text) {
  const parts = [];
  let i = 0;
  let plain = '';

  while (i < text.length) {
    const rest = text.slice(i);

    const link = rest.match(LINK_START);
    if (link && link.index === 0) {
      const raw = rest.split(/\s/)[0];
      const value = trimTail(raw);
      if (value.length > link[0].length && isAllowed(value)) {
        pushText(parts, plain);
        plain = '';
        parts.push({ kind: 'link', value });
        i += value.length;
        continue;
      }
    }

    if (text[i] === '@' && !isWordChar(text[i - 1])) {
      const name = rest.slice(1).match(MENTION);
      if (name) {
        pushText(parts, plain);
        plain = '';
        parts.push({ kind: 'mention', value: `@${name[0]}` });
        i += name[0].length + 1;
        continue;
      }
    }

    plain += text[i];
    i++;
  }

  pushText(parts, plain);
  return parts;
}

function isWordChar(char) {
  return char !== undefined && /[\p{L}\p{N}]/u.test(char);
}

export function shortenUrl(url) {
  if (url.length <= 60) return url;
  return `${url.slice(0, 45)}…${url.slice(-12)}`;
}

export function appendMention(value, nick) {
  const gap = value && !value.endsWith(' ') ? ' ' : '';
  return `${value}${gap}@${nick} `;
}
