import { setButton } from './icons.js';
import { formatStats } from './format.js';
import {
  callBtn,
  callIncoming,
  callIncomingText,
  callAccept,
  callDecline,
  callPanel,
  peerName,
  partyMe,
  partyPeer,
  callStatus,
  callStats,
  callMute,
  callHangup,
  callGrip,
} from './dom.js';

// Панель звонка плавает поверх ленты, поэтому её дают сдвинуть: иначе она
// закрывает как раз то сообщение, из-за которого звонят.
function makeDraggable(panel, handle) {
  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;

  handle.addEventListener('pointerdown', (event) => {
    dragging = true;
    const rect = panel.getBoundingClientRect();
    offsetX = event.clientX - rect.left;
    offsetY = event.clientY - rect.top;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const x = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, event.clientX - offsetX));
    const y = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, event.clientY - offsetY));
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
  });
  handle.addEventListener('pointerup', (event) => {
    dragging = false;
    handle.releasePointerCapture(event.pointerId);
  });
}

function setMeter(party, level, speaking) {
  party.querySelector('.meter > i').style.width = `${Math.min(100, Math.round(level * 140))}%`;
  party.querySelector('.ring').classList.toggle('speaking', speaking);
}

export function createCallView({ call, getPeer, onPhase }) {
  function renderStats(stats) {
    callStats.replaceChildren();
    if (!stats) return;
    const dot = document.createElement('span');
    dot.className = `q-dot ${stats.quality}`;
    const text = document.createElement('span');
    text.textContent = formatStats(stats);
    callStats.append(dot, text);
  }

  function render(state) {
    const inCall = state.phase === 'outgoing' || state.phase === 'active';

    callIncoming.hidden = state.phase !== 'incoming';
    if (state.phase === 'incoming') callIncomingText.textContent = `${state.peer} звонит…`;

    callPanel.hidden = !inCall;
    if (inCall) {
      peerName.textContent = state.peer ?? '';
      callStatus.textContent = state.phase === 'outgoing' ? 'Звоним…' : 'На связи';
      callMute.hidden = state.phase !== 'active';
      setButton(callMute, state.muted ? 'sound-off' : 'microphone', state.muted ? 'Выкл' : 'Микро');
      callMute.classList.toggle('muted', state.muted);
      renderStats(state.stats);
    } else {
      setMeter(partyMe, 0, false);
      setMeter(partyPeer, 0, false);
    }

    onPhase(state.phase);
  }

  function renderLevels(levels) {
    setMeter(partyMe, levels.local, levels.localSpeaking);
    setMeter(partyPeer, levels.remote, levels.remoteSpeaking);
  }

  setButton(callBtn, 'phone', 'Позвонить');
  setButton(callAccept, 'phone', 'Принять');
  setButton(callDecline, 'cross', 'Отклонить');
  setButton(callHangup, 'phone', 'Завершить');

  callBtn.addEventListener('click', () => call.invite(getPeer()));
  callAccept.addEventListener('click', () => call.accept());
  callDecline.addEventListener('click', () => call.decline());
  callMute.addEventListener('click', () => call.toggleMute());
  callHangup.addEventListener('click', () => call.hangup());
  makeDraggable(callPanel, callGrip);

  return { render, renderLevels };
}
