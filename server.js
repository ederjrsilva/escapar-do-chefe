const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const players = {};
let boss = {
    x: 400,
    y: 300,
    speed: 2.5,
    radius: 30
};

// Game loop for Boss AI (Enhanced Expertise & Detection)
setInterval(() => {
    const playerKeys = Object.keys(players);
    if (playerKeys.length > 0) {
        let closestPlayer = null;
        let minDistance = Infinity;

        for (let id of playerKeys) {
            const p = players[id];
            const dx = p.x - boss.x;
            const dy = p.y - boss.y;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist < minDistance) {
                minDistance = dist;
                closestPlayer = p;
            }
        }

        if (closestPlayer) {
            const dx = closestPlayer.x - boss.x;
            const dy = closestPlayer.y - boss.y;
            const angle = Math.atan2(dy, dx);

            // Boss speed increases when close to a player (aggro boost)
            let currentSpeed = boss.speed;
            if (minDistance < 250) {
                currentSpeed = boss.speed * 1.4;
            }

            boss.x += Math.cos(angle) * currentSpeed;
            boss.y += Math.sin(angle) * currentSpeed;

            // Collision check with players
            for (let id of playerKeys) {
                const p = players[id];
                const pDist = Math.hypot(p.x - boss.x, p.y - boss.y);
                if (pDist < boss.radius + 20) {
                    io.to(id).emit('caught');
                }
            }
        }
    }

    io.emit('gameState', { players, boss });
}, 1000 / 60);

io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    socket.on('joinGame', (data) => {
        players[socket.id] = {
            id: socket.id,
            name: data.name || 'Jogador',
            photo: data.photo || 'fotos/foto1.jpg',
            x: Math.random() * 600 + 100,
            y: Math.random() * 400 + 100,
            score: 0
        };
    });

    socket.on('playerMove', (movement) => {
        const player = players[socket.id];
        if (player) {
            const speed = 4;
            if (movement.left) player.x -= speed;
            if (movement.right) player.x += speed;
            if (movement.up) player.y -= speed;
            if (movement.down) player.y += speed;

            player.x = Math.max(20, Math.min(780, player.x));
            player.y = Math.max(20, Math.min(580, player.y));
        }
    });

    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        delete players[socket.id];
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
