const STORE_KEY = 'ws-chat-settings';

const FONTS = {
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
  theme: 'og',
  motion: 'system',
  notifications: false,
};

const THEMES = {
  og: 'OG',
  'glass-light': 'Стекло · светлое',
  'glass-dark': 'Стекло · тёмное',
};

const MOTIONS = {
  system: 'Система',
  on: 'Вкл',
  off: 'Выкл',
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
const motionListeners = new Set();

function persist() {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
}

function notify() {
  for (const cb of listeners) cb();
}

function notifyMotion() {
  for (const cb of motionListeners) cb();
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
  onMotionChange(cb) {
    motionListeners.add(cb);
  },
  theme() {
    return state.theme;
  },
  applyTheme() {
    const root = document.documentElement;
    if (state.theme === 'og') delete root.dataset.theme;
    else root.dataset.theme = state.theme;
  },
  applyFont() {
    document.documentElement.style.setProperty('--font', FONTS[state.font].stack);
  },
  motion() {
    return state.motion;
  },
  notifications() {
    return state.notifications;
  },
  setNotifications(on) {
    state.notifications = on;
    persist();
  },
  animationsEnabled() {
    if (state.motion === 'on') return true;
    if (state.motion === 'off') return false;
    return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  },
  applyMotion() {
    const root = document.documentElement.classList;
    root.toggle('motion-on', state.motion === 'on');
    root.toggle('motion-off', state.motion === 'off');
  },
};

settings.applyTheme();

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

export function mountSettings(root, account = {}) {
  settings.applyFont();
  settings.applyMotion();
  settings.applyTheme();

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'settings-toggle';
  toggle.title = 'Настройки';

  const popup = document.createElement('div');
  popup.className = 'settings-popup';
  popup.hidden = true;

  root.append(toggle);
  document.body.append(popup);

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
    popup.append(section('Тема', themeSelect()));
    popup.append(section('Шрифт', fontSelect()));
    popup.append(section('Анимации', motionSelect()));
    if (account.canChangePassword?.()) popup.append(section('Пароль', passwordForm()));
    popup.append(section('Уведомления', notifyRow()));
    if (account.onSessions) popup.append(section('Устройства', fingerprintRow(), linkForm(), deviceList()));
    if (account.onLogoutEverywhere) popup.append(section('Сессии', logoutEverywhere()));
  }

  function passwordForm() {
    const form = document.createElement('form');
    form.className = 'settings-password';

    const current = document.createElement('input');
    current.type = 'password';
    current.placeholder = 'текущий пароль';
    current.autocomplete = 'current-password';
    const next = document.createElement('input');
    next.type = 'password';
    next.placeholder = 'новый пароль';
    next.autocomplete = 'new-password';
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = 'сменить';
    const note = document.createElement('p');
    note.className = 'settings-note';

    form.append(current, next, submit, note);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (next.value.length < 8) {
        note.textContent = 'Новый пароль от 8 символов';
        return;
      }
      note.textContent = 'Меняем…';
      account.onChangePassword(current.value, next.value, (message) => {
        note.textContent = message;
        current.value = '';
        next.value = '';
      });
    });
    return form;
  }

  function linkForm() {
    const form = document.createElement('form');
    form.className = 'settings-password';

    const input = document.createElement('input');
    input.placeholder = 'код с нового устройства';
    input.maxLength = 16;
    input.autocomplete = 'off';
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = 'подключить';
    const note = document.createElement('p');
    note.className = 'settings-note';

    form.append(input, submit, note);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const code = input.value.trim();
      if (!code) return;
      if (!confirm('Подключить устройство? Оно получит полный доступ к твоему аккаунту. Вводи код, только если сам его видишь на своём устройстве.')) return;
      note.textContent = 'Подключаю…';
      account.onApproveLink(code, (message) => {
        note.textContent = message;
        input.value = '';
      });
    });
    return form;
  }

  function notifyRow() {
    const wrap = document.createElement('div');
    wrap.className = 'settings-notify';

    const button = document.createElement('button');
    button.type = 'button';
    const note = document.createElement('p');
    note.className = 'settings-note';

    const paint = () => {
      const on = settings.notifications();
      button.textContent = on ? 'Выключить' : 'Включить';
      button.classList.toggle('active', on);
      note.textContent = on
        ? 'Приходят, когда окно свёрнуто: личные сообщения и упоминания. Остальное из каналов не тревожит.'
        : 'Пока выключены. Включённые приходят только в свёрнутом окне и только на личное или упоминание.';
    };

    if (!account.notifications?.supported()) {
      button.disabled = true;
      button.textContent = 'Недоступны';
      note.textContent = 'Браузер разрешает уведомления только по https или на самом localhost. С телефона по открытому адресу их не будет.';
      wrap.append(button, note);
      return wrap;
    }

    button.addEventListener('click', async () => {
      if (settings.notifications()) {
        settings.setNotifications(false);
        paint();
        return;
      }
      const answer = await account.notifications.ask();
      if (answer !== 'granted') {
        note.textContent = 'Браузер отказал. Разрешение выдаётся в настройках сайта, рядом с адресной строкой.';
        return;
      }
      settings.setNotifications(true);
      paint();
    });

    paint();
    wrap.append(button, note);
    return wrap;
  }

  function fingerprintRow() {
    const wrap = document.createElement('div');
    wrap.className = 'settings-fingerprint';

    const label = document.createElement('span');
    label.className = 'fp-label';
    label.textContent = 'Отпечаток этого устройства';

    const value = document.createElement('code');
    value.className = 'fp-value';
    value.textContent = '…';

    const note = document.createElement('p');
    note.className = 'settings-note';
    note.textContent = 'Сверь его с собеседником другим способом — тогда видно, что переписку никто не подменяет.';

    wrap.append(label, value, note);
    account.fingerprint().then(
      (print) => {
        value.textContent = print || 'не завёлся';
      },
      () => {
        value.textContent = 'не завёлся';
      },
    );
    return wrap;
  }

  function deviceList() {
    const wrap = document.createElement('div');
    wrap.className = 'settings-devices';
    wrap.textContent = 'Загружаю…';
    account.onSessions((list) => renderDevices(wrap, list));
    return wrap;
  }

  function renderDevices(wrap, list) {
    wrap.replaceChildren();
    if (!list.length) {
      wrap.textContent = 'Активных сессий нет';
      return;
    }
    for (const session of list) {
      const row = document.createElement('div');
      row.className = session.current ? 'device current' : 'device';

      const label = document.createElement('span');
      label.className = 'device-name';
      label.textContent = session.device || 'неизвестное устройство';
      const when = document.createElement('span');
      when.className = 'device-when';
      when.textContent = session.current ? 'это устройство' : `был(а) ${relativeTime(session.lastSeenAt)}`;
      row.append(label, when);

      if (!session.current) {
        const kill = document.createElement('button');
        kill.type = 'button';
        kill.textContent = 'отозвать';
        kill.addEventListener('click', () => account.onRevokeSession(session.id));
        row.append(kill);
      }
      wrap.append(row);
    }
  }

  function logoutEverywhere() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'settings-danger';
    button.textContent = 'выйти со всех устройств';
    button.addEventListener('click', () => {
      if (confirm('Выйти со всех устройств? Войти заново придётся везде, включая это.')) {
        account.onLogoutEverywhere();
      }
    });
    return button;
  }

  function motionSelect() {
    const wrap = document.createElement('div');
    wrap.className = 'settings-fonts';
    for (const [key, label] of Object.entries(MOTIONS)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.className = key === state.motion ? 'active' : '';
      b.addEventListener('click', () => {
        state.motion = key;
        persist();
        settings.applyMotion();
        notifyMotion();
        render();
      });
      wrap.appendChild(b);
    }
    return wrap;
  }

  function set(key, value) {
    state[key] = value;
    persist();
    notify();
  }

  function themeSelect() {
    const wrap = document.createElement('div');
    wrap.className = 'settings-themes';
    for (const [key, label] of Object.entries(THEMES)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.className = key === state.theme ? 'active' : '';
      b.addEventListener('click', () => {
        state.theme = key;
        persist();
        settings.applyTheme();
        render();
      });
      wrap.appendChild(b);
    }
    return wrap;
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

function relativeTime(ts) {
  const minutes = Math.round((Date.now() - ts) / 60000);
  if (minutes < 2) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  return `${Math.round(hours / 24)} дн назад`;
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
