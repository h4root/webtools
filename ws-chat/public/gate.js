import { deviceLabel, secureContext } from './format.js';
import {
  nickForm,
  nickInput,
  passwordInput,
  gateError,
  gateHint,
  gateInsecure,
  gateSubmit,
  gateMain,
  gateTabs,
  modeGuestBtn,
  modeLoginBtn,
  modeRegisterBtn,
  modeLinkBtn,
  linkBackBtn,
  linkBox,
  linkCodeEl,
  linkExpiryEl,
} from './dom.js';

const MODES = {
  guest: {
    label: 'Продолжить как гость',
    hint: 'Ник занимается на время: нажмёшь «Выйти» — он освободится, а всё написанное будет стёрто. Личность живёт сутки без захода.',
  },
  login: {
    label: 'Войти',
    hint: 'Ник закреплён за паролем, история и вложения останутся на месте.',
  },
  register: {
    label: 'Создать аккаунт',
    hint: 'Пароль от 8 символов. Ник закрепится за тобой навсегда, история переживёт выход.',
  },
  link: { label: '', hint: '' },
};

const FLASH_MS = 1800;

export function createGate({ request }) {
  let mode = 'guest';
  let pending = null;
  let timer = null;
  let flashUntil = 0;

  function setBusy(busy) {
    gateSubmit.disabled = busy;
    nickInput.disabled = busy;
    passwordInput.disabled = busy;
    for (const tab of gateTabs.children) tab.disabled = busy;
  }

  function showError(text) {
    gateError.textContent = text;
  }

  function setMode(next) {
    mode = next;
    gateError.textContent = '';

    const linking = next === 'link';
    gateMain.hidden = linking;
    linkBox.hidden = !linking;
    modeLinkBtn.hidden = linking;
    linkBackBtn.hidden = !linking;

    if (linking) {
      clearInterval(timer);
      timer = null;
      return;
    }

    const needsPassword = next === 'login' || next === 'register';
    gateSubmit.textContent = MODES[next].label;
    gateHint.textContent = MODES[next].hint;
    passwordInput.hidden = !needsPassword;
    passwordInput.autocomplete = next === 'register' ? 'new-password' : 'current-password';
    for (const tab of gateTabs.children) tab.classList.toggle('active', tab.id === `mode-${next}`);

    (needsPassword && nickInput.value ? passwordInput : nickInput).focus();
  }

  // Плашка уровня страницы, а не поля: иначе она то появлялась бы, то исчезала
  // при переключении вкладок и дёргала высоту формы.
  function warnIfInsecure() {
    gateInsecure.hidden = secureContext();
    gateInsecure.textContent = 'Соединение не шифруется: в этой сети видно всё, включая пароль при входе.';
  }

  // Отсчёт живёт в той же строке и переписывает её каждую секунду, поэтому
  // сообщение не восстанавливаем по таймеру, а просто просим отсчёт помолчать.
  function flashNote(text) {
    flashUntil = Date.now() + FLASH_MS;
    linkExpiryEl.textContent = text;
  }

  function showLinkCode(code, expiresAt) {
    linkCodeEl.textContent = `${code.slice(0, 3)}-${code.slice(3)}`;
    linkCodeEl.title = 'Нажми, чтобы скопировать';
    clearInterval(timer);
    timer = setInterval(() => {
      if (Date.now() < flashUntil) return;
      const left = Math.round((expiresAt - Date.now()) / 1000);
      if (left > 0) {
        linkExpiryEl.textContent = `Код действует ещё ${left} с`;
        return;
      }
      clearInterval(timer);
      linkExpiryEl.textContent = 'Код истёк — нажми «войти с другого устройства» ещё раз';
      linkCodeEl.textContent = '';
    }, 1000);
    linkExpiryEl.textContent = `Код действует ещё ${Math.round((expiresAt - Date.now()) / 1000)} с`;
  }

  function requestLinkCode() {
    flashUntil = 0;
    linkCodeEl.textContent = '…';
    linkExpiryEl.textContent = '';
    request({ type: 'link-request', device: deviceLabel() });
  }

  nickForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const nick = nickInput.value.trim();
    if (!nick) return;
    const password = passwordInput.value;
    if (mode !== 'guest' && !password) {
      gateError.textContent = 'Введи пароль';
      return;
    }

    pending =
      mode === 'guest'
        ? { mode: 'guest', nick, device: deviceLabel() }
        : { mode, nick, password, device: deviceLabel() };
    gateError.textContent = '';
    setBusy(true);
    request({ type: 'auth', ...pending });
    passwordInput.value = '';
  });

  modeGuestBtn.addEventListener('click', () => setMode('guest'));
  modeLoginBtn.addEventListener('click', () => setMode('login'));
  modeRegisterBtn.addEventListener('click', () => setMode('register'));
  linkBackBtn.addEventListener('click', () => setMode('guest'));
  modeLinkBtn.addEventListener('click', () => {
    setMode('link');
    requestLinkCode();
  });

  // Буфер обмена доступен только в защищённом контексте, а код чаще всего
  // смотрят с телефона по http — поэтому есть запасной путь через выделение.
  linkCodeEl.addEventListener('click', async () => {
    const code = linkCodeEl.textContent.trim();
    if (!code || code === '…') return;

    try {
      await navigator.clipboard.writeText(code);
      flashNote('Код скопирован');
    } catch {
      getSelection()?.selectAllChildren(linkCodeEl);
      flashNote('Код выделен — скопируй вручную');
    }
  });

  return {
    setMode,
    setBusy,
    showError,
    showLinkCode,
    warnIfInsecure,
    mode: () => mode,
    pending: () => pending,
    clearPending() {
      pending = null;
    },
  };
}
