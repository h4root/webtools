const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;
const USERS_FILE = path.join(__dirname, 'users.json');
const ALLOWED_DOMAINS = [
    'gmail.com', 'yandex.ru', 'ya.ru', 
    'mail.ru', 'bk.ru', 'inbox.ru', 'list.ru', 
    'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'rambler.ru'
];

app.use(express.static(path.join(__dirname)));
app.use(express.json());

if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify([]));
}

function validateEmail(email) {
    if (!email || !email.includes('@')) return false;
    const domain = email.split('@')[1].toLowerCase();
    return ALLOWED_DOMAINS.includes(domain);
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/api/register', (req, res) => {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
        return res.status(400).json({ error: 'Заполните все поля' });
    }

    if (password.length < 6) {
        return res.status(400).json({ error: 'Пароль должен быть не менее 6 символов' });
    }

    if (!validateEmail(email)) {
        return res.status(400).json({ 
            error: 'Используйте популярные почтовые сервисы (Gmail, Yandex, Mail.ru и др.)' 
        });
    }

    const users = JSON.parse(fs.readFileSync(USERS_FILE));

    if (users.find(u => u.email === email)) {
        return res.status(400).json({ error: 'Пользователь с такой почтой уже существует' });
    }

    const newUser = {
        id: 'user_' + Math.random().toString(36).substr(2, 9),
        name,
        email,
        password
    };

    users.push(newUser);
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));

    res.json({ success: true, user: { id: newUser.id, name: newUser.name } });
});

app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    const users = JSON.parse(fs.readFileSync(USERS_FILE));
    
    const user = users.find(u => u.email === email && u.password === password);

    if (!user) {
        return res.status(401).json({ error: 'Неверная почта или пароль' });
    }

    res.json({ success: true, user: { id: user.id, name: user.name } });
});

app.get('/api/users', (req, res) => {
    try {
        const users = JSON.parse(fs.readFileSync(USERS_FILE));
        // Отправляем только безопасные данные (без паролей и email)
        const safeUsers = users.map(u => ({
            id: u.id,
            name: u.name
        }));
        res.json(safeUsers);
    } catch (e) {
        res.status(500).json({ error: 'Ошибка чтения пользователей' });
    }
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const clients = new Set();

wss.on('connection', (ws) => {
    clients.add(ws);

    ws.send(JSON.stringify({
        sender: 'System',
        text: 'Добро пожаловать в чат!',
        timestamp: new Date().toLocaleTimeString(),
        system: true
    }));

    ws.on('message', (message) => {
        const messageString = message.toString();
        let data;
        try {
            data = JSON.parse(messageString);
            if (!data.sender || !data.text) return;
        } catch (e) {
            return;
        }

        data.timestamp = new Date().toLocaleTimeString();

        clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(data));
            }
        });
    });

    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
});

server.listen(port, '0.0.0.0', () => {
    console.log(`Сервер запущен по адресу http://localhost:${port}`);
});