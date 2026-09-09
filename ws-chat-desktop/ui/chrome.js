const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const RESTORE = String.fromCharCode(0xe923);
const MAXIMIZE = String.fromCharCode(0xe922);

const title = document.getElementById('title');
const back = document.getElementById('back');
const max = document.getElementById('max');

function on(id, command) {
  document.getElementById(id).addEventListener('click', () => invoke(command));
}

on('back', 'go_back');
on('home', 'go_home');
on('min', 'win_minimize');
on('max', 'win_toggle_maximize');
on('close', 'win_close');

listen('chrome:title', (event) => {
  title.textContent = event.payload;
});

listen('chrome:home', (event) => {
  // На странице выбора сервера возвращаться некуда.
  back.disabled = event.payload;
  document.getElementById('home').disabled = event.payload;
});

listen('chrome:maximized', (event) => {
  max.textContent = event.payload ? RESTORE : MAXIMIZE;
  max.title = event.payload ? 'Свернуть в окно' : 'Развернуть';
});

// Полоса грузится параллельно с содержимым и могла пропустить первые события.
invoke('chrome_ready');
