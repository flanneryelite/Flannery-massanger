const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const path = require('path');
const db = require('./database/init');

const authRoutes = require('./routes/auth');
const chatRoutes = require('./routes/chats');
const messageRoutes = require('./routes/messages');
const userRoutes = require('./routes/users');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/chats', chatRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/users', userRoutes);

// WebSocket
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (token) {
        const jwt = require('jsonwebtoken');
        try {
            const user = jwt.verify(token, 'flannery_secret_key');
            socket.userId = user.id;
            socket.username = user.username;
            next();
        } catch (err) {
            next(new Error('Authentication error'));
        }
    } else {
        next(new Error('Authentication error'));
    }
});

io.on('connection', (socket) => {
    console.log(`✅ Пользователь подключился: ${socket.username}`);
    
    // Обновление статуса
    db.run('UPDATE users SET status = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?', 
        ['online', socket.userId]);
    
    // Присоединение к чатам пользователя
    db.all('SELECT chat_id FROM chat_members WHERE user_id = ?', [socket.userId], (err, chats) => {
        if (chats) {
            chats.forEach(chat => {
                socket.join(`chat_${chat.chat_id}`);
            });
        }
    });

    // Отправка сообщения
    socket.on('send_message', async (data) => {
        const { chatId, content, messageType, fileUrl, selfDestruct } = data;
        
        db.run(
            'INSERT INTO messages (chat_id, user_id, message_type, content, file_url, self_destruct_time) VALUES (?, ?, ?, ?, ?, ?)',
            [chatId, socket.userId, messageType || 'text', content, fileUrl, selfDestruct],
            function(err) {
                if (err) return;
                
                const messageData = {
                    id: this.lastID,
                    chatId,
                    userId: socket.userId,
                    username: socket.username,
                    content,
                    messageType: messageType || 'text',
                    fileUrl,
                    selfDestruct,
                    createdAt: new Date().toISOString()
                };
                
                io.to(`chat_${chatId}`).emit('new_message', messageData);
                
                // Самоуничтожение сообщения
                if (selfDestruct) {
                    setTimeout(() => {
                        db.run('UPDATE messages SET is_deleted = TRUE WHERE id = ?', [this.lastID]);
                        io.to(`chat_${chatId}`).emit('delete_message', { 
                            messageId: this.lastID,
                            chatId 
                        });
                        
                        io.to(`chat_${chatId}`).emit('message_exploded', {
                            messageId: this.lastID,
                            chatId,
                            message: '💥 Сообщение самоуничтожилось'
                        });
                    }, selfDestruct * 1000);
                }
            }
        );
    });

    // Редактирование сообщения
    socket.on('edit_message', (data) => {
        const { messageId, chatId, content } = data;
        
        db.run(
            'UPDATE messages SET content = ?, is_edited = TRUE WHERE id = ? AND user_id = ?',
            [content, messageId, socket.userId],
            (err) => {
                if (!err) {
                    io.to(`chat_${chatId}`).emit('message_edited', {
                        messageId,
                        chatId,
                        content,
                        editedAt: new Date().toISOString()
                    });
                }
            }
        );
    });

    // Удаление сообщения
    socket.on('delete_message', (data) => {
        const { messageId, chatId } = data;
        
        db.run(
            'UPDATE messages SET is_deleted = TRUE WHERE id = ? AND user_id = ?',
            [messageId, socket.userId],
            (err) => {
                if (!err) {
                    io.to(`chat_${chatId}`).emit('message_deleted', {
                        messageId,
                        chatId
                    });
                }
            }
        );
    });

    // Индикатор печати
    socket.on('typing', (data) => {
        socket.to(`chat_${data.chatId}`).emit('user_typing', {
            userId: socket.userId,
            username: socket.username,
            chatId: data.chatId
        });
    });

    socket.on('stop_typing', (data) => {
        socket.to(`chat_${data.chatId}`).emit('user_stop_typing', {
            userId: socket.userId,
            chatId: data.chatId
        });
    });

    // Прочитанные сообщения
    socket.on('mark_read', (data) => {
        io.to(`chat_${data.chatId}`).emit('messages_read', {
            userId: socket.userId,
            chatId: data.chatId
        });
    });

    // Отключение
    socket.on('disconnect', () => {
        console.log(`Пользователь отключился: ${socket.username}`);
        db.run('UPDATE users SET status = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?', 
            ['offline', socket.userId]);
        io.emit('user_status_changed', {
            userId: socket.userId,
            status: 'offline',
            lastSeen: new Date().toISOString()
        });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🔥 Flannery Messenger запущен на порту ${PORT}`);
    console.log(`🌐 Откройте http://localhost:${PORT} в браузере`);
});

// В server.js добавить после других маршрутов:
const adminRoutes = require('./routes/admin');
const supportRoutes = require('./routes/support');

app.use('/api/admin', adminRoutes);
app.use('/api/support', supportRoutes);