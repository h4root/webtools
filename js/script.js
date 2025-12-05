// js/script.js

// DOM-элементы
let chatMessages, chatInput, sendButton, chatList;
let authModalWrapper, appContainer, loginView, registerView, loginBtn, registerBtn;
const statusIndicator = document.createElement('div');

// --- Настройка ---
const WS_URL = `ws://${window.location.host}`;
const RECONNECT_INTERVAL = 3000;
const AUTH_COOKIE_NAME = 'chat_auth_token';

// Пользователь
let CURRENT_USER_NAME = '';
let CURRENT_USER_ID = null;
let SELECTED_CHAT_ID = null; // ID пользователя, с которым чатимся (пока null)

// --- Утилиты ---
function setCookie(name, value, days) {
    let expires = "";
    if (days) {
        const date = new Date();
        date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
        expires = "; expires=" + date.toUTCString();
    }
    document.cookie = name + "=" + (value || "") + expires + "; path=/";
}

function getCookie(name) {
    const nameEQ = name + "=";
    const ca = document.cookie.split(';');
    for (let i = 0; i < ca.length; i++) {
        let c = ca[i];
        while (c.charAt(0) === ' ') c = c.substring(1, c.length);
        if (c.indexOf(nameEQ) === 0) return c.substring(nameEQ.length, c.length);
    }
    return null;
}

function getUserColor(userId) {
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
        hash = userId.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 70%, 50%)`;
}

const USER_COLORS = new Map();

// --- Управление UI ---
function showChatUI() {
    authModalWrapper.style.display = 'none';
    appContainer.style.display = 'grid';
    connectWebSocket();
    loadUsers(); // Загружаем список пользователей после входа
}

function showAuthModal() {
    authModalWrapper.style.display = 'flex';
    appContainer.style.display = 'none';
    showLoginView();
}

function showLoginView(e) {
    if (e) e.preventDefault();
    loginView.style.display = 'block';
    registerView.style.display = 'none';
    document.getElementById('login-email').focus();
}

function showRegisterView(e) {
    if (e) e.preventDefault();
    loginView.style.display = 'none';
    registerView.style.display = 'block';
    document.getElementById('register-name').focus();
}

// --- API Запросы ---
async function handleLogin() {
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value.trim();

    if (!email || !password) {
        alert('Пожалуйста, заполните все поля');
        return;
    }

    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        const data = await response.json();
        if (response.ok) handleAuthSuccess(data.user);
        else alert(data.error || 'Ошибка входа');
    } catch (error) {
        console.error('Ошибка сети:', error);
    }
}

async function handleRegister() {
    const name = document.getElementById('register-name').value.trim();
    const email = document.getElementById('register-email').value.trim();
    const password = document.getElementById('register-password').value.trim();

    if (!name || !email || !password) {
        alert('Пожалуйста, заполните все поля');
        return;
    }

    try {
        const response = await fetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, email, password })
        });
        const data = await response.json();
        if (response.ok) handleAuthSuccess(data.user);
        else alert(data.error || 'Ошибка регистрации');
    } catch (error) {
        console.error('Ошибка сети:', error);
    }
}

function handleAuthSuccess(user) {
    CURRENT_USER_NAME = user.name;
    CURRENT_USER_ID = user.id;

    const tokenData = JSON.stringify({ name: user.name, id: user.id });
    setCookie(AUTH_COOKIE_NAME, tokenData, 7);

    USER_COLORS.set(CURRENT_USER_ID, getUserColor(CURRENT_USER_ID));
    showChatUI();
}

// --- Работа со списком пользователей ---
async function loadUsers() {
    try {
        const response = await fetch('/api/users');
        if (response.ok) {
            const users = await response.json();
            renderUserList(users);
        }
    } catch (error) {
        console.error('Ошибка загрузки пользователей:', error);
    }
}

function renderUserList(users) {
    chatList.innerHTML = ''; // Очищаем список

    users.forEach(user => {
        // Не показываем себя в списке
        if (user.id === CURRENT_USER_ID) return;

        const userColor = getUserColor(user.id);
        const initial = user.name.charAt(0).toUpperCase();

        const chatItem = document.createElement('div');
        chatItem.classList.add('chat-item');
        chatItem.dataset.userId = user.id;
        
        // HTML структура элемента списка
        chatItem.innerHTML = `
            <div class="chat-item-avatar" style="background-color: ${userColor}">${initial}</div>
            <div class="chat-item-info">
                <div class="chat-item-name">${user.name}</div>
                <div class="chat-item-preview">Нажмите, чтобы написать</div>
            </div>
        `;

        // Обработчик клика (выбор чата)
        chatItem.addEventListener('click', () => {
            document.querySelectorAll('.chat-item').forEach(el => el.classList.remove('active'));
            chatItem.classList.add('active');
            SELECTED_CHAT_ID = user.id;
            
            // Обновляем заголовок чата (визуально)
            document.querySelector('.chat-header-name').textContent = user.name;
            document.querySelector('.chat-header-avatar').textContent = initial;
            document.querySelector('.chat-header-avatar').style.backgroundColor = userColor;
            document.querySelector('.chat-header-status').textContent = 'В сети'; // Пока заглушка
            
            // Очищаем сообщения (пока мы не умеем грузить историю)
            chatMessages.innerHTML = ''; 
            
            // Фокус на ввод
            chatInput.focus();
        });

        chatList.appendChild(chatItem);
    });
}

// --- Чат и WebSocket ---
function sendMessage() {
    const text = chatInput.value.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;

    // Формируем сообщение. Если выбран чат, добавляем targetId (для будущего лс)
    const message = {
        sender: CURRENT_USER_NAME,
        text,
        senderId: CURRENT_USER_ID,
        targetId: SELECTED_CHAT_ID // ID получателя (если есть)
    };

    try {
        ws.send(JSON.stringify(message));
        
        // Сразу отображаем свое сообщение
        displayMessage(CURRENT_USER_NAME, text, new Date().toLocaleTimeString(), false, CURRENT_USER_ID);
        
        chatInput.value = '';
    } catch (err) {
        console.error('Ошибка отправки:', err);
        updateStatus('Ошибка', 'red');
    }
}

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
            const color = getUserColor(senderId);
            messageDiv.style.backgroundColor = color;
            messageDiv.style.color = 'white';
        }

        const contentSpan = document.createElement('span');
        contentSpan.classList.add('message-text-content');
        contentSpan.innerHTML = isSent ? text : `<strong>${sender}</strong>: ${text}`;

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

let ws = null;

function connectWebSocket() {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
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
            
            // Если это мое же сообщение (которое вернулось с сервера) - игнорируем, 
            // так как мы его уже нарисовали в sendMessage. 
            // Исключение: системные сообщения.
            if (data.senderId === CURRENT_USER_ID && !data.system) return;

            displayMessage(data.sender, data.text, data.timestamp, data.system, data.senderId);
        } catch (err) {
            console.error('Ошибка парсинга:', event.data);
        }
    };

    ws.onclose = () => {
        updateStatus('Переподключение...', 'orange');
        setTimeout(connectWebSocket, RECONNECT_INTERVAL);
    };
    ws.onerror = (error) => console.error('WebSocket Error:', error);
}

// --- Инициализация ---
document.addEventListener('DOMContentLoaded', async () => {
    // Инициализация элементов
    authModalWrapper = document.getElementById('auth-modal-wrapper');
    appContainer = document.getElementById('app-container');
    loginView = document.getElementById('login-view');
    registerView = document.getElementById('register-view');
    loginBtn = document.getElementById('login-btn');
    registerBtn = document.getElementById('register-btn');
    
    chatMessages = document.querySelector('.chat-messages');
    chatInput = document.querySelector('.chat-input');
    sendButton = document.querySelector('.chat-send-btn');
    chatList = document.querySelector('.chat-list'); // Получаем список чатов

    // Индикатор статуса
    statusIndicator.id = 'connection-status';
    statusIndicator.textContent = 'Подключение...';
    statusIndicator.style.cssText = 'text-align: center; font-size: 12px; color: #7f8c9b; padding: 10px; margin-top: -10px;';
    if (chatMessages && chatMessages.parentElement) {
        chatMessages.parentElement.insertBefore(statusIndicator, chatMessages);
    }
    
    // Обработчики
    sendButton.addEventListener('click', sendMessage);
    chatInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); sendMessage(); }
    });

    // Авто-вход
    const authCookie = getCookie(AUTH_COOKIE_NAME);
    if (authCookie) {
        try {
            const token = JSON.parse(authCookie);
            if (token.name && token.id) {
                handleAuthSuccess(token);
                return;
            }
        } catch (e) { console.error('Ошибка токена:', e); }
    }
    
    showAuthModal(); 
    
    // UI Обработчики
    document.getElementById('show-login-link').addEventListener('click', showLoginView);
    document.getElementById('show-register-link').addEventListener('click', showRegisterView);
    loginBtn.addEventListener('click', handleLogin);
    registerBtn.addEventListener('click', handleRegister);
    document.getElementById('login-password').addEventListener('keypress', (e) => { if (e.key === 'Enter') handleLogin(); });
    document.getElementById('register-password').addEventListener('keypress', (e) => { if (e.key === 'Enter') handleRegister(); });
});