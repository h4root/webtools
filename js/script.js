// js/script.js

// DOM-элементы (объявлены, но не инициализированы)
let chatMessages, chatInput, sendButton;
const statusIndicator = document.createElement('div');

// --- Настройка ---
const WS_URL = `ws://${window.location.host}`;
const RECONNECT_INTERVAL = 3000;

// Пользователь
let CURRENT_USER_NAME = localStorage.getItem('chat_username');
let CURRENT_USER_ID = localStorage.getItem('chat_user_id');

// --- Функция: модальное окно ввода имени ---
function showUsernamePrompt() {
    return new Promise((resolve) => {
        const backdrop = document.createElement('div');
        backdrop.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background-color: rgba(0, 0, 0, 0.7); display: flex; align-items: center; justify-content: center;
            z-index: 1000;
        `;

        const modal = document.createElement('div');
        modal.style.cssText = `
            background: var(--color-panel-bg, rgba(22, 22, 35, 0.8));
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 16px;
            padding: 24px;
            width: 90%;
            max-width: 400px;
            color: white;
            backdrop-filter: blur(10px);
            text-align: center;
        `;

        modal.innerHTML = `
            <h3 style="margin-bottom: 16px; font-weight: 600;">Введите ваше имя</h3>
            <input type="text" id="username-input"
                   placeholder="Ваше имя"
                   maxlength="20"
                   style="
                      width: 100%;
                      padding: 12px;
                      margin-bottom: 16px;
                      border-radius: 8px;
                      border: 1px solid rgba(255, 255, 255, 0.2);
                      background: rgba(255, 255, 255, 0.05);
                      color: white;
                      font-size: 14px;
                   ">
            <div style="display: flex; gap: 10px; justify-content: center;">
                <button id="username-cancel" style="
                    padding: 8px 16px;
                    border-radius: 8px;
                    border: none;
                    background: rgba(255, 255, 255, 0.1);
                    color: #aaa;
                    cursor: pointer;
                ">Отмена</button>
                <button id="username-ok" style="
                    padding: 8px 16px;
                    border-radius: 8px;
                    border: none;
                    background: #007aff;
                    color: white;
                    cursor: pointer;
                ">ОК</button>
            </div>
        `;

        const input = modal.querySelector('#username-input');
        input.value = CURRENT_USER_NAME || '';
        input.focus();

        modal.querySelector('#username-ok').onclick = () => {
            const name = input.value.trim() || 'Аноним';
            resolve(name);
            document.body.removeChild(backdrop);
        };

        modal.querySelector('#username-cancel').onclick = () => {
            resolve(CURRENT_USER_NAME || 'Аноним');
            document.body.removeChild(backdrop);
        };

        input.onkeypress = (e) => {
            if (e.key === 'Enter') modal.querySelector('#username-ok').click();
        };

        backdrop.appendChild(modal);
        document.body.appendChild(backdrop);
    });
}

// --- Генерация цвета ---
function getUserColor(userId) {
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
        hash = userId.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 70%, 50%)`;
}

const USER_COLORS = new Map();

// --- Отправка сообщения ---
function sendMessage() {
    const text = chatInput.value.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;

    const message = {
        sender: CURRENT_USER_NAME,
        text,
        senderId: CURRENT_USER_ID,
        timestamp: new Date().toLocaleTimeString()
    };

    try {
        ws.send(JSON.stringify(message));
        chatInput.value = '';
    } catch (err) {
        console.error('Ошибка отправки:', err);
        updateStatus('Ошибка', 'red');
    }
}

// --- Отображение сообщений ---
function displayMessage(sender, text, timestamp, isSystem = false, senderId = null) {
    const messageDiv = document.createElement('div');
    messageDiv.classList.add('message');

    if (isSystem) {
        messageDiv.classList.add('system');
        messageDiv.textContent = text;
    } else {
        const isSent = senderId === CURRENT_USER_ID;
        messageDiv.classList.add(isSent ? 'sent' : 'received');

        if (!isSent && senderId) {
            if (!USER_COLORS.has(senderId)) {
                USER_COLORS.set(senderId, getUserColor(senderId));
            }
            messageDiv.style.backgroundColor = USER_COLORS.get(senderId);
            messageDiv.style.color = 'white';
        }

        const contentSpan = document.createElement('span');
        contentSpan.classList.add('message-text-content');
        contentSpan.innerHTML = isSent
            ? text
            : `<strong>${sender}</strong>: ${text}`;

        const timeSmall = document.createElement('small');
        timeSmall.classList.add('timestamp');
        timeSmall.textContent = timestamp || new Date().toLocaleTimeString();

        messageDiv.appendChild(contentSpan);
        messageDiv.appendChild(timeSmall);
    }

    chatMessages.appendChild(messageDiv);
    scrollToBottom();
}

function scrollToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function updateStatus(text, color) {
    statusIndicator.textContent = text;
    statusIndicator.style.color = color;
}

// --- WebSocket ---
let ws = null;

function connectWebSocket() {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
        console.log('✅ Подключено');
        updateStatus('Онлайн', 'green');
        ws.send(JSON.stringify({
            system: true,
            sender: 'System',
            text: `${CURRENT_USER_NAME} присоединился к чату.`,
            senderId: CURRENT_USER_ID
        }));
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            displayMessage(data.sender, data.text, data.timestamp, data.system, data.senderId);
        } catch (err) {
            console.error('Ошибка парсинга:', event.data);
        }
    };

    ws.onclose = () => {
        updateStatus('Переподключение...', 'orange');
        setTimeout(connectWebSocket, RECONNECT_INTERVAL);
    };

    ws.onerror = (error) => {
        console.error('❌ Ошибка WebSocket:', error);
    };
}

// --- ИНИЦИАЛИЗАЦИЯ ПОСЛЕ ЗАГРУЗКИ DOM ---
document.addEventListener('DOMContentLoaded', async () => {
    // 1. Запрашиваем имя
    const username = await showUsernamePrompt();
    CURRENT_USER_NAME = username;
    localStorage.setItem('chat_username', CURRENT_USER_NAME);

    if (!CURRENT_USER_ID) {
        CURRENT_USER_ID = 'user_' + Math.random().toString(36).substr(2, 9);
        localStorage.setItem('chat_user_id', CURRENT_USER_ID);
    }

    USER_COLORS.set(CURRENT_USER_ID, getUserColor(CURRENT_USER_ID));

    // 2. Инициализируем DOM-элементы
    chatMessages = document.querySelector('.chat-messages');
    chatInput = document.querySelector('.chat-input');
    sendButton = document.querySelector('.chat-send-btn');

    // 3. Добавляем индикатор
    statusIndicator.id = 'connection-status';
    statusIndicator.textContent = 'Подключение...';
    statusIndicator.style.cssText = `
        text-align: center;
        font-size: 12px;
        color: #7f8c9b;
        padding: 10px;
        margin-top: -10px;
    `;
    chatMessages.parentElement.insertBefore(statusIndicator, chatMessages);

    // 4. Назначаем обработчики событий
    sendButton.addEventListener('click', sendMessage);
    chatInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            sendMessage();
        }
    });

    // 5. Подключаем WebSocket
    connectWebSocket();
});
