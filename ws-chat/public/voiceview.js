import { icon, setButton } from './icons.js';
import { channelSlug } from './keys.js';
import { deleteButton } from './nav.js';
import { voiceListEl, voiceAddBtn, voiceStatus, voiceConn, voiceMuteBtn, voiceDeafenBtn, voiceLeaveBtn } from './dom.js';

export function createVoiceView({ voice, send, getState, onError }) {
  let joined = null;

  function render(state) {
    joined = state.channel;
    voiceStatus.hidden = !state.channel;
    if (state.channel) {
      voiceConn.replaceChildren(icon('sound-on', 14));
      const label = document.createElement('span');
      label.textContent = state.channel;
      voiceConn.appendChild(label);
      // Заглушка выключает и микрофон, поэтому кнопка не должна выглядеть живой.
      const micOff = state.muted || state.deafened;
      setButton(voiceMuteBtn, micOff ? 'mic-off' : 'microphone');
      voiceMuteBtn.classList.toggle('muted', micOff);
      setButton(voiceDeafenBtn, state.deafened ? 'sound-off' : 'sound-on');
      voiceDeafenBtn.classList.toggle('muted', state.deafened);
    }
    renderChannels();
  }

  function memberRow(nick, channel) {
    const { me } = getState();
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = nick === me ? `${nick} (вы)` : nick;
    item.appendChild(label);
    // Про мут известно только по своему каналу: сервер рассылает его тем, кто
    // рядом, и знать про соседние комнаты незачем.
    if (channel === joined && voice.isMuted(nick)) {
      item.classList.add('muted');
      item.title = 'Микрофон выключен';
      item.appendChild(icon('mic-off', 13));
    }
    return item;
  }

  function renderChannels() {
    const { voiceChannels, voicePresence } = getState();
    voiceListEl.replaceChildren();
    for (const name of voiceChannels) {
      const li = document.createElement('li');
      li.className = 'voice-chan';
      li.dataset.voice = name;

      const head = document.createElement('div');
      head.className = name === joined ? 'channel voice-chan-head active' : 'channel voice-chan-head';
      head.appendChild(icon('sound-on', 14));
      const label = document.createElement('span');
      label.textContent = name;
      head.appendChild(label);
      head.addEventListener('click', () => {
        if (joined === name) voice.leave();
        else voice.join(name);
      });
      head.appendChild(deleteButton(`Удалить голосовой канал ${name}?`, () => send({ type: 'voice-channel-delete', name })));
      li.appendChild(head);

      const members = voicePresence[name] ?? [];
      if (members.length) {
        const ul = document.createElement('ul');
        ul.className = 'voice-members';
        for (const nick of members) ul.appendChild(memberRow(nick, name));
        li.appendChild(ul);
      }
      voiceListEl.appendChild(li);
    }
  }

  setButton(voiceLeaveBtn, 'cross');

  voiceMuteBtn.addEventListener('click', () => voice.toggleMute());
  voiceDeafenBtn.addEventListener('click', () => voice.toggleDeafen());
  voiceLeaveBtn.addEventListener('click', () => voice.leave());
  voiceAddBtn.addEventListener('click', () => {
    const name = prompt('Имя голосового канала (латиница, цифры, дефис):');
    if (!name) return;
    const slug = channelSlug(name);
    if (!slug) {
      onError('Недопустимое имя канала');
      return;
    }
    send({ type: 'voice-channel-create', name: slug });
  });

  return { render, renderChannels, current: () => joined };
}
