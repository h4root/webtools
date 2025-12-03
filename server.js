// server.js

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// 1. Обслуживание статических файлов
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 2. Создание HTTP-сервера
const server = http.createServer(app);

// 3. WebSocket-сервер
const wss = new WebSocket.Server({ server });

// Массив для хранения клиентов (с возможностью масштабирования)
const clients = new Set();

wss.on('connection', (ws) => {
    clients.add(ws);
    console.log(`Клиент подключен. Всего клиентов: ${clients.size}`);

    // Отправка приветственного сообщения
    ws.send(JSON.stringify({
        sender: 'System',
        text: 'Добро пожаловать в чат!',
        timestamp: new Date().toLocaleTimeString(),
        system: true
    }));

    ws.on('message', (message) => {
        const messageString = message.toString();
        console.log(`Сообщение получено: ${messageString}`);

        let data;
        try {
            data = JSON.parse(messageString);
            // Валидация обязательных полей
            if (!data.sender || !data.text) {
                console.warn('Некорректное сообщение — отсутствуют поля sender или text:', messageString);
                return;
            }
        } catch (e) {
            console.error('Не удалось разобрать JSON:', messageString);
            return;
        }

        // Добавление времени
        data.timestamp = new Date().toLocaleTimeString();

        // Рассылка всем, кроме системных сообщений (они уже отправлены отдельно)
        clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(data));
            }
        });
    });

    ws.on('close', () => {
        clients.delete(ws);
        console.log(`Клиент отключен. Осталось: ${clients.size}`);
    });

    ws.on('error', (error) => {
        console.error('Ошибка WebSocket:', error.message);
        clients.delete(ws); // На случай, если ошибка привела к разрыву
    });
});

// Запуск сервера
server.listen(port, '0.0.0.0', () => {
    console.log(`Сервер запущен по адресу http://localhost:${port}`);
});
