let chatMessages, chatInput, sendButton, chatList, fileInput, attachBtn;
let authModalWrapper, appContainer, loginView, registerView, loginBtn, registerBtn;

const statusIndicator = document.createElement('div');

const WS_URL = `ws://${window.location.host}`;
const RECONNECT_INTERVAL = 3000;
const AUTH_COOKIE_NAME = 'chat_auth_token';

let CURRENT_USER_NAME = '';
let CURRENT_USER_ID = null;
let SELECTED_CHAT_ID = null;
let ws = null;

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
        let c = ca[i].trim();
        if (c.indexOf(nameEQ) === 0) return c.substring(nameEQ.length);
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

function showChatUI() {
    authModalWrapper.style.display = 'none';
    appContainer.style.display = 'grid';
    connectWebSocket();
    loadUsers();
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

async function handleLogin() {
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value.trim();

    if (!email || !password) {
        alert('Заполните все поля');
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
        alert('Заполните все поля');
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
    USER_COLORS.set(CURRENT_USER_ID, getUserColor(CURRENT_USER_ID));
    setCookie(AUTH_COOKIE_NAME, JSON.stringify({ name: user.name, id: user.id }), 7);
    showChatUI();
}

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
    chatList.innerHTML = '';
    users.forEach(user => {
        if (user.id === CURRENT_USER_ID) return;
        const color = getUserColor(user.id);
        const initial = user.name.charAt(0).toUpperCase();

        const item = document.createElement('div');
        item.classList.add('chat-item');
        item.dataset.userId = user.id;
        item.innerHTML = `
            <div class="chat-item-avatar" style="background-color: ${color}">${initial}</div>
            <div class="chat-item-info">
                <div class="chat-item-name">${user.name}</div>
                <div class="chat-item-preview">Нажмите, чтобы написать</div>
            </div>
        `;
        item.addEventListener('click', () => {
            document.querySelectorAll('.chat-item').forEach(el => el.classList.remove('active'));
            item.classList.add('active');
            SELECTED_CHAT_ID = user.id;
            document.querySelector('.chat-header-name').textContent = user.name;
            document.querySelector('.chat-header-avatar').textContent = initial;
            document.querySelector('.chat-header-avatar').style.backgroundColor = color;
            document.querySelector('.chat-header-status').textContent = 'В сети';
            chatMessages.innerHTML = '';
            chatInput.focus();
        });
        chatList.appendChild(item);
    });
}

function sendMessage() {
    const text = chatInput.value.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
    const message = {
        sender: CURRENT_USER_NAME,
        type: 'text',
        text,
        senderId: CURRENT_USER_ID,
        targetId: SELECTED_CHAT_ID
    };
    ws.send(JSON.stringify(message));
    displayMessage(CURRENT_USER_NAME, text, new Date().toLocaleTimeString(), false, CURRENT_USER_ID, 'text');
    chatInput.value = '';
}

function sendImageMessage(url) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const message = {
        sender: CURRENT_USER_NAME,
        type: 'image',
        content: url,
        senderId: CURRENT_USER_ID,
        targetId: SELECTED_CHAT_ID
    };
    ws.send(JSON.stringify(message));
    displayMessage(CURRENT_USER_NAME, url, new Date().toLocaleTimeString(), false, CURRENT_USER_ID, 'image');
}
function displayMessage(sender, content, timestamp, isSystem = false, senderId = null, type = 'text') {
    const messageDiv = document.createElement('div');
    messageDiv.classList.add('message');

    if (isSystem) {
        messageDiv.classList.add('system');
        messageDiv.textContent = content;
    } else {
        const isSent = senderId === CURRENT_USER_ID;
        messageDiv.classList.add(isSent ? 'sent' : 'received');

        if (!isSent && senderId) {
            const color = getUserColor(senderId);
            messageDiv.style.backgroundColor = color;
            messageDiv.style.color = 'white';
        }

        const contentWrapper = document.createElement('div');
        
        if (!isSent) {
            const nameSpan = document.createElement('div');
            nameSpan.style.fontWeight = 'bold';
            nameSpan.style.fontSize = '12px';
            nameSpan.style.marginBottom = '4px';
            nameSpan.textContent = sender;
            contentWrapper.appendChild(nameSpan);
        }

        if (type === 'image') {
            const img = document.createElement('img');
            img.src = content; 
            img.classList.add('message-image');
            img.loading = "lazy";
            img.onclick = () => openImageViewer(content);
            contentWrapper.appendChild(img);
        } else {
            const textSpan = document.createElement('span');
            textSpan.classList.add('message-text-content');
            textSpan.textContent = content || ''; 
            contentWrapper.appendChild(textSpan);
        }

        const timeSmall = document.createElement('small');
        timeSmall.classList.add('timestamp');
        timeSmall.textContent = timestamp || new Date().toLocaleTimeString();

        messageDiv.appendChild(contentWrapper);
        messageDiv.appendChild(timeSmall);
    }

    chatMessages.appendChild(messageDiv);
    scrollToBottom();
}

function scrollToBottom() {
    requestAnimationFrame(() => {
        chatMessages.scrollTop = chatMessages.scrollHeight;
    });
}

function updateStatus(text, color) {
    if (statusIndicator) {
        statusIndicator.textContent = text;
        statusIndicator.style.color = color;
    }
}

function connectWebSocket() {
    if (ws) ws.close();
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
            if (data.senderId === CURRENT_USER_ID && !data.system) return;
            displayMessage(
                data.sender,
                data.type === 'image' ? data.content : data.text,
                data.timestamp,
                data.system,
                data.senderId,
                data.type || 'text'
            );
        } catch (err) {
            console.error('Ошибка парсинга:', event.data);
        }
    };

    ws.onclose = () => {
        updateStatus('Переподключение...', 'orange');
        setTimeout(connectWebSocket, RECONNECT_INTERVAL);
    };

    ws.onerror = (error) => {
        console.error('WebSocket Error:', error);
        ws.close();
    };
}

function compressImage(file, maxWidth, quality) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                try {
                    let { width, height } = img;
                    if (width > maxWidth) {
                        height *= maxWidth / width;
                        width = maxWidth;
                    }
                    if (width > 8192 || height > 8192) {
                        return reject(new Error('Изображение слишком велико'));
                    }
                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, width, height);
                    const result = canvas.toDataURL('image/jpeg', quality);
                    resolve(result);
                } catch (err) {
                    reject(err);
                }
            };
            img.onerror = () => reject(new Error('Ошибка загрузки изображения'));
            img.src = e.target.result;
        };
        reader.onerror = () => reject(new Error('Ошибка чтения файла'));
        reader.readAsDataURL(file);
    });
}

async function handleFileUpload(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
        alert('Можно загружать только изображения');
        return;
    }
    if (file.size > 10 * 1024 * 1024) {
        alert('Файл слишком большой (макс. 10 МБ)');
        return;
    }

    try {
        updateStatus('Сжатие...', 'orange');
        const compressedBase64 = await compressImage(file, 1600, 0.7);
        const newFileName = file.name.replace(/\.[^/.]+$/, "") + ".jpg";

        updateStatus('Загрузка...', 'orange');
        const response = await fetch('/api/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: compressedBase64, name: newFileName })
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.error || `Ошибка ${response.status}`);
        }

        const data = await response.json();
        sendImageMessage(data.url);
    } catch (err) {
        console.error('Ошибка загрузки изображения:', err);
        alert(`Ошибка: ${err.message}`);
    } finally {
        updateStatus('Онлайн', 'green');
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    authModalWrapper = document.getElementById('auth-modal-wrapper');
    appContainer = document.getElementById('app-container');
    loginView = document.getElementById('login-view');
    registerView = document.getElementById('register-view');
    loginBtn = document.getElementById('login-btn');
    registerBtn = document.getElementById('register-btn');
    chatMessages = document.querySelector('.chat-messages');
    chatInput = document.querySelector('.chat-input');
    sendButton = document.querySelector('.chat-send-btn');
    chatList = document.querySelector('.chat-list');
    fileInput = document.getElementById('file-input');
    attachBtn = document.querySelector('.chat-attach-btn');

    statusIndicator.id = 'connection-status';
    statusIndicator.textContent = 'Подключение...';
    statusIndicator.style.cssText = 'text-align: center; font-size: 12px; color: #7f8c9b; padding: 10px;';
    if (chatMessages?.parentElement) {
        chatMessages.parentElement.insertBefore(statusIndicator, chatMessages);
    }

    sendButton?.addEventListener('click', sendMessage);
    chatInput?.addEventListener('keypress', e => {
        if (e.key === 'Enter') {
            e.preventDefault();
            sendMessage();
        }
    });

    attachBtn?.addEventListener('click', e => {
        e.preventDefault();
        fileInput.click();
    });
    fileInput?.addEventListener('change', e => {
        if (e.target.files[0]) {
            handleFileUpload(e.target.files[0]);
            e.target.value = '';
        }
    });

    document.getElementById('show-login-link')?.addEventListener('click', showLoginView);
    document.getElementById('show-register-link')?.addEventListener('click', showRegisterView);
    loginBtn?.addEventListener('click', handleLogin);
    registerBtn?.addEventListener('click', handleRegister);
    document.getElementById('login-password')?.addEventListener('keypress', e => e.key === 'Enter' && handleLogin());
    document.getElementById('register-password')?.addEventListener('keypress', e => e.key === 'Enter' && handleRegister());

    const authCookie = getCookie(AUTH_COOKIE_NAME);
    if (authCookie) {
        try {
            const token = JSON.parse(authCookie);
            if (token.name && token.id) {
                handleAuthSuccess(token);
                return;
            }
        } catch (e) {
            console.error('Ошибка куки:', e);
        }
    }
    showAuthModal();
});

let imageViewerModal, imageViewerImg, imageViewerClose;

function initImageViewer() {
    const modalHtml = `
        <div id="image-viewer-modal" class="image-viewer-modal">
            <span class="image-viewer-close">&times;</span>
            <img class="image-viewer-content" id="image-viewer-img" alt="Просмотр изображения">
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);

    imageViewerModal = document.getElementById('image-viewer-modal');
    imageViewerImg = document.getElementById('image-viewer-img');
    imageViewerClose = document.querySelector('.image-viewer-close');

    imageViewerClose.onclick = () => {
        imageViewerModal.style.display = 'none';
    };

    imageViewerModal.onclick = (e) => {
        if (e.target === imageViewerModal) {
            imageViewerModal.style.display = 'none';
        }
    };

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && imageViewerModal.style.display === 'flex') {
            imageViewerModal.style.display = 'none';
        }
    });
}
function openImageViewer(src) {
    if (!imageViewerModal) initImageViewer();
    imageViewerImg.src = src;
    imageViewerModal.style.display = 'flex';
}
document.addEventListener('DOMContentLoaded', () => {
    initImageViewer();
});