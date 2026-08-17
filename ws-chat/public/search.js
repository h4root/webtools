import { timeLabel, isNarrow } from './format.js';
import { searchBtn, searchPanel, searchInput, searchNote, searchResults } from './dom.js';

const HINT = 'Ищем только там, куда у тебя есть доступ: каналы и твои личные переписки.';
const DEBOUNCE_MS = 250;

export function createSearch({ send, getNick, openConversation, keyOf, activeKey, findRow, scrollToMessage, historyArrived }) {
  let query = '';
  let timer = null;
  let jump = null;

  function setPanel(open) {
    searchPanel.hidden = !open;
    searchBtn.classList.toggle('active', open);
    if (open) searchInput.focus();
  }

  function isOpen() {
    return !searchPanel.hidden;
  }

  function run() {
    query = searchInput.value.trim();
    if (!query) {
      searchResults.replaceChildren();
      searchNote.textContent = HINT;
      return;
    }
    searchNote.textContent = 'Ищем…';
    send({ type: 'search', query });
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(run, DEBOUNCE_MS);
  }

  function targetOf(msg) {
    if (msg.channel) return { kind: 'channel', id: msg.channel };
    const other = msg.from.toLowerCase() === getNick().toLowerCase() ? msg.to : msg.from;
    return { kind: 'dm', id: other };
  }

  function hitNode(msg) {
    const target = targetOf(msg);
    const li = document.createElement('li');
    li.className = 'search-hit';

    const head = document.createElement('div');
    head.className = 'search-hit-head';
    const where = document.createElement('span');
    where.className = 'search-hit-where';
    where.textContent = target.kind === 'channel' ? `# ${target.id}` : `@ ${target.id}`;
    const when = document.createElement('span');
    when.className = 'search-hit-when';
    when.textContent = timeLabel(msg.ts);
    head.append(where, when);

    const body = document.createElement('div');
    body.className = 'search-hit-body';
    body.textContent = `${msg.from}: ${msg.text}`;

    li.append(head, body);
    li.addEventListener('click', () => {
      jump = { key: keyOf(target.kind, target.id), id: msg.id };
      openConversation(target.kind, target.id);
      if (isNarrow()) setPanel(false);
    });
    return li;
  }

  // Ответы могут прийти не в том порядке, в каком набирали: показываем только
  // тот, что отвечает нынешнему запросу.
  function renderResults(forQuery, messages) {
    if (forQuery !== query) return;
    searchResults.replaceChildren();

    if (messages.length === 0) {
      searchNote.textContent = 'Ничего не нашлось.';
      return;
    }
    searchNote.textContent = `Нашлось: ${messages.length}`;
    for (const msg of messages) searchResults.append(hitNode(msg));
  }

  // Найденное может оказаться старше загруженного куска истории — тогда честнее
  // сказать об этом, чем молча открыть разговор и ничего не подсветить.
  function flushJump() {
    if (!jump || jump.key !== activeKey()) return;
    if (findRow(jump.id)) {
      scrollToMessage(jump.id);
      jump = null;
      return;
    }
    // Запрошенная история — ещё не пришедшая: сдаваться можно только после
    // ответа сервера, иначе отказ вынесен до того, как смотреть было куда.
    if (historyArrived(jump.key)) {
      jump = null;
      searchNote.textContent = 'Разговор открыт, но сообщение старше загруженной истории.';
    }
  }

  function reset() {
    clearTimeout(timer);
    query = '';
    jump = null;
    searchInput.value = '';
    searchResults.replaceChildren();
    searchNote.textContent = HINT;
    setPanel(false);
  }

  return { setPanel, isOpen, schedule, renderResults, flushJump, reset, hint: HINT };
}
