'use strict';

const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const GS = 30;
const COUNTDOWN_SECONDS = 3;
const HEARTBEAT_MS = 20000;
const ROOM_CODE_LENGTH = 6;
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rooms = new Map();
const clients = new Set();

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webmanifest': 'application/manifest+json; charset=utf-8'
};

const server = http.createServer((req, res) => {
    let pathname;
    try {
        pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
        res.writeHead(400);
        res.end('Invalid URL');
        return;
    }

    const relativePath = (pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));
    const filePath = path.resolve(__dirname, relativePath);
    if (filePath !== __dirname && !filePath.startsWith(__dirname + path.sep)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(err.code === 'ENOENT' ? 'File not found' : 'Unable to read file');
            return;
        }
        const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
        res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
        });
        res.end(data);
    });
});

const wss = new WebSocketServer({ server });

function send(player, message) {
    if (player && player.ws.readyState === WebSocket.OPEN) {
        player.ws.send(JSON.stringify(message));
    }
}

function broadcastOnlineCount() {
    const message = { type: 'onlineCount', count: clients.size };
    for (const player of clients) send(player, message);
}

function makeRoomCode() {
    let code;
    do {
        code = '';
        for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
            code += ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)];
        }
    } while (rooms.has(code));
    return code;
}

function createRoom(isPublic) {
    const room = {
        code: makeRoomCode(),
        public: isPublic,
        players: [],
        phase: 'lobby',
        timerInterval: null,
        countdownInterval: null,
        startedAt: 0
    };
    rooms.set(room.code, room);
    return room;
}

function other(player) {
    if (!player.room) return null;
    return player.room.players.find(candidate => candidate !== player) || null;
}

function sendLobby(room) {
    if (!room) return;
    for (const player of room.players) {
        const opponent = other(player);
        send(player, {
            type: 'lobby',
            code: room.code,
            phase: room.phase,
            ready: player.ready,
            opponentPresent: !!opponent,
            opponentReady: !!(opponent && opponent.ready)
        });
    }
}

function broadcastRoom(room, message) {
    if (!room) return;
    for (const player of room.players) send(player, message);
}

function stopTimer(room) {
    if (room && room.timerInterval) {
        clearInterval(room.timerInterval);
        room.timerInterval = null;
    }
}

function stopCountdown(room) {
    if (room && room.countdownInterval) {
        clearInterval(room.countdownInterval);
        room.countdownInterval = null;
    }
}

function removeRoomIfEmpty(room) {
    if (room && room.players.length === 0) {
        stopTimer(room);
        stopCountdown(room);
        rooms.delete(room.code);
    }
}

function cancelCountdown(room) {
    if (!room || room.phase !== 'countdown') return;
    stopCountdown(room);
    room.phase = 'lobby';
    broadcastRoom(room, { type: 'countdown', n: null });
    sendLobby(room);
}

function tryStartCountdown(room) {
    if (!room || room.phase !== 'lobby' || room.players.length !== 2 || !room.players.every(player => player.ready)) return;

    room.phase = 'countdown';
    let number = COUNTDOWN_SECONDS;
    broadcastRoom(room, { type: 'countdown', n: number });

    room.countdownInterval = setInterval(() => {
        if (room.players.length !== 2 || !room.players.every(player => player.ready)) {
            cancelCountdown(room);
            return;
        }
        number--;
        if (number > 0) {
            broadcastRoom(room, { type: 'countdown', n: number });
        } else {
            stopCountdown(room);
            startRound(room);
        }
    }, 1000);
}

function startRound(room) {
    if (!room || room.players.length !== 2) {
        cancelCountdown(room);
        return;
    }
    room.phase = 'playing';
    room.startedAt = Date.now();
    for (const player of room.players) {
        player.ready = false;
        player.state = 'playing';
        player.time = null;
    }
    broadcastRoom(room, { type: 'start' });

    stopTimer(room);
    room.timerInterval = setInterval(() => {
        if (room.phase !== 'playing') return;
        broadcastRoom(room, { type: 'timer', time: Date.now() - room.startedAt });
    }, 1000);
}

function summary(player) {
    return player ? { state: player.state, time: player.time } : { state: 'left', time: null };
}

function finishRound(room, winner, tieReason) {
    if (!room || room.phase !== 'playing') return;
    room.phase = 'lobby';
    stopTimer(room);

    for (const player of room.players) {
        const opponent = other(player);
        const result = !winner ? 'tie' : (winner === player ? 'win' : 'lose');
        const reason = !winner ? tieReason : (winner === player ? 'cleared' : 'opponent_cleared');
        send(player, {
            type: 'end',
            result,
            reason,
            you: summary(player),
            opponent: summary(opponent)
        });
        player.ready = false;
    }
    sendLobby(room);
}

function isValidGrid(grid) {
    return Array.isArray(grid) && grid.length === GS &&
        grid.every(row => Array.isArray(row) && row.length === GS);
}

function joinPlayer(player, room, isPrivateRoom) {
    if (player.room) {
        send(player, { type: 'roomError', message: 'You are already in a lobby.' });
        return;
    }
    if (!room || room.players.length >= 2 || room.phase !== 'lobby') {
        send(player, { type: 'roomError', message: 'That lobby is full or already playing.' });
        return;
    }

    player.room = room;
    player.ready = false;
    player.state = 'idle';
    player.time = null;
    room.players.push(player);

    send(player, { type: 'joinedRoom', code: room.code, private: !room.public });
    sendLobby(room);
}

function findPublicRoom() {
    for (const room of rooms.values()) {
        if (room.public && room.phase === 'lobby' && room.players.length === 1) return room;
    }
    return null;
}

function handleRoomRequest(player, message) {
    if (player.room) {
        send(player, { type: 'roomError', message: 'You are already in a lobby.' });
        return;
    }

    if (message.type === 'createRoom') {
        const room = createRoom(false);
        joinPlayer(player, room, true);
        return;
    }

    if (message.type === 'joinRoom') {
        const code = String(message.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (code.length !== ROOM_CODE_LENGTH) {
            send(player, { type: 'roomError', message: 'Enter a valid 6-character room code.' });
            return;
        }
        const room = rooms.get(code);
        if (!room) {
            send(player, { type: 'roomError', message: 'Lobby not found. Check the code and try again.' });
            return;
        }
        if (room.players.length >= 2 || room.phase !== 'lobby') {
            send(player, { type: 'roomError', message: 'That lobby is full or already playing.' });
            return;
        }
        joinPlayer(player, room, true);
        return;
    }

    if (message.type === 'matchmake') {
        let room = findPublicRoom();
        if (!room) room = createRoom(true);
        joinPlayer(player, room, false);
        return;
    }

    send(player, { type: 'roomError', message: 'Unknown lobby action.' });
}

function detachPlayerFromRoom(player, notifyPlayer) {
    const room = player.room;
    if (!room) {
        if (notifyPlayer) send(player, { type: 'leftRoom' });
        return;
    }

    const previousPhase = room.phase;
    room.players = room.players.filter(candidate => candidate !== player);
    player.room = null;
    player.ready = false;

    if (previousPhase === 'countdown') cancelCountdown(room);
    if (previousPhase === 'playing') {
        stopTimer(room);
        stopCountdown(room);
        room.phase = 'lobby';
        const remaining = room.players[0];
        if (remaining) {
            const survived = remaining.state === 'playing';
            send(remaining, {
                type: 'end',
                result: survived ? 'win' : 'tie',
                reason: 'opponent_left',
                you: summary(remaining),
                opponent: { state: 'left', time: null }
            });
            remaining.ready = false;
        }
    }

    if (room.players.length) sendLobby(room);
    removeRoomIfEmpty(room);
    if (notifyPlayer) send(player, { type: 'leftRoom' });
}

function disconnectPlayer(player) {
    clients.delete(player);
    detachPlayerFromRoom(player, false);
    broadcastOnlineCount();
}

wss.on('connection', ws => {
    const player = {
        ws,
        room: null,
        ready: false,
        state: 'idle',
        time: null,
        alive: true
    };
    clients.add(player);
    broadcastOnlineCount();

    ws.on('pong', () => { player.alive = true; });

    ws.on('message', raw => {
        let message;
        try { message = JSON.parse(raw.toString()); } catch { return; }
        if (!message || typeof message.type !== 'string') return;

        if (message.type === 'leaveRoom') {
            detachPlayerFromRoom(player, true);
            return;
        }

        if (!player.room) {
            handleRoomRequest(player, message);
            return;
        }

        const room = player.room;
        if (message.type === 'ready') {
            if (room.phase === 'playing') return;
            player.ready = !!message.ready;
            if (!player.ready) cancelCountdown(room);
            sendLobby(room);
            tryStartCountdown(room);
        } else if (message.type === 'state') {
            if (room.phase !== 'playing' || !isValidGrid(message.grid)) return;
            const last = Array.isArray(message.last) && message.last.length === 2 &&
                message.last.every(Number.isInteger) &&
                message.last.every(value => value >= 0 && value < GS) ? message.last : null;
            send(other(player), { type: 'opponentUpdate', grid: message.grid, last });
        } else if (message.type === 'gameover') {
            if (room.phase !== 'playing' || player.state !== 'playing') return;
            const elapsed = Date.now() - room.startedAt;
            if (message.result === 'win') {
                player.state = 'cleared';
                player.time = elapsed;
                finishRound(room, player, null);
            } else if (message.result === 'mine') {
                player.state = 'dead';
                player.time = elapsed;
                const opponent = other(player);
                send(player, { type: 'youDied', time: elapsed });
                send(opponent, { type: 'opponentDied', time: elapsed });
                if (opponent && opponent.state === 'dead') finishRound(room, null, 'both_dead');
            }
        }
    });

    ws.on('close', () => disconnectPlayer(player));
    ws.on('error', () => { /* The close handler performs cleanup. */ });
});

setInterval(() => {
    for (const player of [...clients]) {
        if (!player.alive) {
            player.ws.terminate();
            continue;
        }
        player.alive = false;
        try { player.ws.ping(); } catch { player.ws.terminate(); }
    }
}, HEARTBEAT_MS);

function listenWithFallback(port) {
    server.once('error', err => {
        if (err.code === 'EADDRINUSE' && port < Number(process.env.PORT || 3000) + 10) {
            console.log(`Port ${port} is busy. Trying ${port + 1}...`);
            listenWithFallback(port + 1);
            return;
        }
        console.error(err);
        process.exitCode = 1;
    });
    server.listen(port, '0.0.0.0', () => {
        console.log('');
        console.log('Pinksweeper Arena server is running.');
        console.log(`Open http://localhost:${port}`);
        console.log('');
    });
}

const initialPort = Number(process.env.PORT) || 3000;
listenWithFallback(initialPort);
