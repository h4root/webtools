const STORE_KEY = 'ws-chat-settings';

export const FONTS = {
  jetbrains: { label: 'JetBrains Mono', stack: "'JetBrains Mono', monospace" },
  victor: { label: 'Victor Mono', stack: "'Victor Mono', monospace" },
  plex: { label: 'IBM Plex Mono', stack: "'IBM Plex Mono', monospace" },
  system: { label: 'Системный', stack: "ui-monospace, 'Courier New', monospace" },
};

const DEFAULTS = {
  inputId: '',
  outputId: '',
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  font: 'jetbrains',
};

function load() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

const state = load();
const listeners = new Set();

function persist() {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
}

function notify() {
  for (const cb of listeners) cb();
}

export const settings = {
  audioConstraints() {
    return {
      deviceId: state.inputId ? { exact: state.inputId } : undefined,
      echoCancellation: state.echoCancellation,
      noiseSuppression: state.noiseSuppression,
      autoGainControl: state.autoGainControl,
    };
  },
  outputId() {
    return state.outputId;
  },
  font() {
    return state.font;
  },
  onChange(cb) {
    listeners.add(cb);
  },
  applyFont() {
    document.documentElement.style.setProperty('--font', FONTS[state.font].stack);
  },
};

export function applySink(mediaEl) {
  if (state.outputId && typeof mediaEl.setSinkId === 'function') {
    mediaEl.setSinkId(state.outputId).catch(() => {});
  }
}

async function listDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return {
      inputs: devices.filter((d) => d.kind === 'audioinput'),
      outputs: devices.filter((d) => d.kind === 'audiooutput'),
    };
  } catch {
    return { inputs: [], outputs: [] };
  }
}

export function mountSettings(root) {
  settings.applyFont();

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'settings-toggle';
  toggle.title = 'Настройки';

  const popup = document.createElement('div');
  popup.className = 'settings-popup';
  popup.hidden = true;

  root.append(toggle, popup);

  const outputSupported = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

  async function render() {
    const { inputs, outputs } = await listDevices();
    popup.replaceChildren();

    popup.append(
      section('Микрофон', deviceSelect(inputs, state.inputId, (v) => set('inputId', v))),
    );
    if (outputSupported) {
      popup.append(section('Динамик', deviceSelect(outputs, state.outputId, (v) => set('outputId', v))));
    }
    popup.append(
      section(
        'Эффекты',
        checkbox('Шумоподавление', state.noiseSuppression, (v) => set('noiseSuppression', v)),
        checkbox('Эхоподавление', state.echoCancellation, (v) => set('echoCancellation', v)),
        checkbox('Автоусиление', state.autoGainControl, (v) => set('autoGainControl', v)),
      ),
    );
    popup.append(section('Шрифт', fontSelect()));
  }

  function set(key, value) {
    state[key] = value;
    persist();
    notify();
  }

  function fontSelect() {
    const wrap = document.createElement('div');
    wrap.className = 'settings-fonts';
    for (const [key, meta] of Object.entries(FONTS)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = meta.label;
      b.style.fontFamily = meta.stack;
      b.className = key === state.font ? 'active' : '';
      b.addEventListener('click', () => {
        state.font = key;
        persist();
        settings.applyFont();
        render();
      });
      wrap.appendChild(b);
    }
    return wrap;
  }

  toggle.addEventListener('click', async () => {
    popup.hidden = !popup.hidden;
    if (!popup.hidden) await render();
  });

  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    if (!popup.hidden) render();
  });

  return { toggle };
}

function section(title, ...nodes) {
  const s = document.createElement('div');
  s.className = 'settings-section';
  const h = document.createElement('div');
  h.className = 'settings-title';
  h.textContent = title;
  s.append(h, ...nodes);
  return s;
}

function deviceSelect(devices, current, onChange) {
  const select = document.createElement('select');
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = 'По умолчанию';
  select.appendChild(auto);
  for (const d of devices) {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || 'Устройство';
    if (d.deviceId === current) opt.selected = true;
    select.appendChild(opt);
  }
  if (devices.length === 0) {
    auto.textContent = 'Разреши микрофон, чтобы увидеть устройства';
  }
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

function checkbox(label, checked, onChange) {
  const wrap = document.createElement('label');
  wrap.className = 'settings-check';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  const span = document.createElement('span');
  span.textContent = label;
  wrap.append(input, span);
  return wrap;
}
