import { icon } from './icons.js';
import { replyBar, textInput } from './dom.js';

export function createReply({ quote }) {
  let target = null;

  function render() {
    replyBar.replaceChildren();
    if (!target) {
      replyBar.hidden = true;
      return;
    }
    replyBar.hidden = false;
    replyBar.appendChild(icon('reply', 16));
    replyBar.appendChild(quote.render(target));
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'reply-cancel';
    cancel.title = 'Отменить ответ';
    cancel.appendChild(icon('cross', 14));
    cancel.addEventListener('click', clear);
    replyBar.appendChild(cancel);
  }

  function set(msg) {
    target = { id: msg.id, from: msg.from, text: msg.text, media: msg.attachments?.[0] };
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
