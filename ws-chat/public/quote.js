import { isImage, replyPreview } from './media.js';

// Цитата выглядит одинаково и в ленте, и над полем ввода: тонкая полоса цвета
// акцента, имя автора строкой выше превью и миниатюра, если ответ на картинку.
export function createQuote({ urlOf }) {
  function thumb(media) {
    const img = document.createElement('img');
    img.className = 'rq-thumb';
    img.alt = '';
    urlOf(media).then(
      (url) => {
        img.src = url;
      },
      () => img.remove(),
    );
    return img;
  }

  function render(ref, onJump) {
    const box = document.createElement(onJump ? 'button' : 'div');
    box.className = 'reply-quote';
    if (onJump) {
      box.type = 'button';
      box.addEventListener('click', (event) => {
        event.stopPropagation();
        onJump(ref.id);
      });
    }

    if (ref.media && isImage(ref.media.mime)) box.appendChild(thumb(ref.media));

    const body = document.createElement('span');
    body.className = 'rq-body';
    const who = document.createElement('span');
    who.className = 'rq-who';
    who.textContent = ref.from;
    const text = document.createElement('span');
    text.className = 'rq-text';
    text.textContent = replyPreview(ref);
    body.append(who, text);
    box.appendChild(body);
    return box;
  }

  return { render };
}
