import { icon } from './icons.js';
import { replyBar, textInput } from './dom.js';

export function createReply() {
  let target = null;

  function render() {
    replyBar.replaceChildren();
    if (!target) {
      replyBar.hidden = true;
      return;
    }
    replyBar.hidden = false;
    const label = document.createElement('span');
    label.className = 'reply-bar-text';
    const who = document.createElement('b');
    who.textContent = target.from;
    label.append('Ответ ', who, `: ${target.text.slice(0, 80)}`);
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'reply-cancel';
    cancel.appendChild(icon('cross', 14));
    cancel.addEventListener('click', clear);
    replyBar.append(label, cancel);
  }

  function set(msg) {
    target = { id: msg.id, from: msg.from, text: msg.text || 'вложение' };
    render();
    textInput.focus();
  }

  function clear() {
    target = null;
    render();
  }

  textInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && target) clear();
  });

  return { set, clear, id: () => target?.id };
}
