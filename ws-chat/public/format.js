const NARROW = 720;

export function isNarrow() {
  return window.innerWidth <= NARROW;
}

export function timeLabel(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

export function formatStats(s) {
  const parts = [];
  if (s.rttMs != null) parts.push(`${s.rttMs} мс`);
  if (s.protocol) parts.push(s.protocol);
  if (s.localType && s.remoteType) parts.push(`${s.localType}↔${s.remoteType}`);
  if (s.codec) parts.push(s.codec);
  if (s.lossPct != null) parts.push(`потери ${s.lossPct}%`);
  if (s.jitterMs != null) parts.push(`джиттер ${s.jitterMs} мс`);
  if (s.kbps != null) parts.push(`${s.kbps} кбит/с`);
  return parts.join(' · ');
}

export function deviceLabel() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return '';
}

export function secureContext() {
  return location.protocol === 'https:' || ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
}
