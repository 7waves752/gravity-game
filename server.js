const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static('public'));

// Хранилище игровых комнат
const rooms = new Map();
const roomTimers = new Map(); // Таймеры для удаления комнат

// Функция для установки таймера удаления комнаты
function setRoomDeletionTimer(roomId) {
    // Очищаем старый таймер, если есть
    if (roomTimers.has(roomId)) {
        clearTimeout(roomTimers.get(roomId));
    }
    
    // Устанавливаем новый таймер на 5 минут
    const timer = setTimeout(() => {
        rooms.delete(roomId);
        roomTimers.delete(roomId);
        console.log(`Комната ${roomId} удалена по таймауту`);
    }, 5 * 60 * 1000); // 5 минут
    
    roomTimers.set(roomId, timer);
}

// Функция для отмены таймера (когда игрок возвращается)
function cancelRoomDeletionTimer(roomId) {
    if (roomTimers.has(roomId)) {
        clearTimeout(roomTimers.get(roomId));
        roomTimers.delete(roomId);
    }
}

// Генерация уникального ID комнаты
function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on('connection', (socket) => {
    console.log('Игрок подключился:', socket.id);

    // Создание новой комнаты
    socket.on('createRoom', () => {
        const roomId = generateRoomId();
        const room = {
            id: roomId,
            players: [socket.id],
            board: Array(10).fill(null).map(() => Array(10).fill(null)),
            currentPlayer: 'X',
            playerRoles: { [socket.id]: 'X' },
            gameOver: false
        };
        
        rooms.set(roomId, room);
        socket.join(roomId);
        socket.emit('roomCreated', { roomId, role: 'X' });
        console.log(`Комната создана: ${roomId}`);
    });

    // Присоединение к комнате
    socket.on('joinRoom', (roomId) => {
        const room = rooms.get(roomId);
        
        if (!room) {
            socket.emit('error', 'Комната не найдена');
            return;
        }

        if (room.players.length >= 2) {
            socket.emit('error', 'Комната заполнена');
            return;
        }

        // Отменяем таймер удаления, если игрок вернулся
        cancelRoomDeletionTimer(roomId);

        room.players.push(socket.id);
        room.playerRoles[socket.id] = 'O';
        socket.join(roomId);
        
        socket.emit('roomJoined', { roomId, role: 'O' });
        
        // Уведомляем обоих игроков о готовности
        io.to(roomId).emit('gameStart', {
            board: room.board,
            currentPlayer: room.currentPlayer,
            players: room.players.length
        });
        
        console.log(`Игрок присоединился к комнате: ${roomId}`);
    });

    // Обработка хода
    socket.on('makeMove', ({ roomId, col }) => {
        const room = rooms.get(roomId);
        
        if (!room) {
            socket.emit('error', 'Комната не найдена');
            return;
        }

        if (room.gameOver) {
            return;
        }

        // Проверяем, что ходит правильный игрок
        if (room.playerRoles[socket.id] !== room.currentPlayer) {
            socket.emit('error', 'Не ваш ход!');
            return;
        }

        // Находим самую нижнюю свободную ячейку
        let row = -1;
        for (let r = 9; r >= 0; r--) {
            if (room.board[r][col] === null) {
                row = r;
                break;
            }
        }

        if (row === -1) {
            return; // Колонка заполнена
        }

        // Делаем ход
        room.board[row][col] = room.currentPlayer;

        // Проверяем победу
        const winningCells = checkWin(room.board, row, col, room.currentPlayer);
        
        if (winningCells) {
            room.gameOver = true;
            io.to(roomId).emit('gameOver', {
                winner: room.currentPlayer,
                winningCells,
                board: room.board
            });
        } else if (isBoardFull(room.board)) {
            room.gameOver = true;
            io.to(roomId).emit('gameOver', {
                winner: null,
                board: room.board
            });
        } else {
            // Меняем игрока
            room.currentPlayer = room.currentPlayer === 'X' ? 'O' : 'X';
            
            // Отправляем обновление всем в комнате
            io.to(roomId).emit('moveMade', {
                row,
                col,
                player: room.playerRoles[socket.id],
                currentPlayer: room.currentPlayer,
                board: room.board
            });
        }
    });

    // Перезапуск игры
    socket.on('resetGame', (roomId) => {
        const room = rooms.get(roomId);
        
        if (!room) return;

        room.board = Array(10).fill(null).map(() => Array(10).fill(null));
        room.currentPlayer = 'X';
        room.gameOver = false;

        io.to(roomId).emit('gameReset', {
            board: room.board,
            currentPlayer: room.currentPlayer
        });
    });

    // Отключение
    socket.on('disconnect', () => {
        console.log('Игрок отключился:', socket.id);
        
        // Находим комнату игрока
        for (let [roomId, room] of rooms.entries()) {
            if (room.players.includes(socket.id)) {
                // Удаляем игрока из списка
                room.players = room.players.filter(id => id !== socket.id);
                
                // Если в комнате остался один игрок - уведомляем его
                if (room.players.length === 1) {
                    io.to(roomId).emit('playerDisconnected', { 
                        message: 'Соперник отключился. Комната будет удалена через 5 минут, если он не вернется.' 
                    });
                    
                    // Устанавливаем таймер удаления комнаты
                    setRoomDeletionTimer(roomId);
                    console.log(`Комната ${roomId}: игрок отключился, установлен таймер удаления`);
                } else if (room.players.length === 0) {
                    // Если комната пустая - удаляем сразу
                    rooms.delete(roomId);
                    cancelRoomDeletionTimer(roomId);
                    console.log(`Комната ${roomId} удалена (оба игрока вышли)`);
                }
                
                break;
            }
        }
    });
});

// Проверка победы
function checkWin(board, row, col, player) {
    const directions = [
        [[0, 1], [0, -1]],   // горизонталь
        [[1, 0], [-1, 0]],   // вертикаль
        [[1, 1], [-1, -1]],  // диагональ \
        [[1, -1], [-1, 1]]   // диагональ /
    ];

    for (let [dir1, dir2] of directions) {
        const cells = [[row, col]];
        
        for (let [dr, dc] of [dir1]) {
            let r = row + dr;
            let c = col + dc;
            while (r >= 0 && r < 10 && c >= 0 && c < 10 && board[r][c] === player) {
                cells.push([r, c]);
                r += dr;
                c += dc;
            }
        }
        
        for (let [dr, dc] of [dir2]) {
            let r = row + dr;
            let c = col + dc;
            while (r >= 0 && r < 10 && c >= 0 && c < 10 && board[r][c] === player) {
                cells.push([r, c]);
                r += dr;
                c += dc;
            }
        }

        if (cells.length >= 4) {
            return cells;
        }
    }

    return null;
}

// Проверка заполненности доски
function isBoardFull(board) {
    return board.every(row => row.every(cell => cell !== null));
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
    console.log(`Откройте http://localhost:${PORT}`);
});
