const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use('/fotos', express.static(path.join(__dirname, 'fotos')));

let gameState = 'LOBBY'; 
let players = {};
let startTime = 0;
let nextPlayerNumber = 1;

const map = {
    walls: [
        {x: 0, y: 0, w: 1400, h: 20}, {x: 0, y: 880, w: 1400, h: 20},
        {x: 0, y: 0, w: 20, h: 900}, {x: 1380, y: 0, w: 20, h: 900},
        {x: 200, y: 200, w: 400, h: 200}, {x: 800, y: 200, w: 400, h: 200},
        {x: 400, y: 550, w: 600, h: 150},
        {x: 0, y: 400, w: 100, h: 20}, {x: 1300, y: 400, w: 100, h: 20}
    ],
    hidingSpots: [
        {x: 50, y: 50, w: 60, h: 60}, {x: 1280, y: 50, w: 60, h: 60},
        {x: 50, y: 800, w: 60, h: 60}, {x: 1280, y: 800, w: 60, h: 60},
        {x: 670, y: 300, w: 60, h: 60}, {x: 670, y: 700, w: 60, h: 60}
    ],
    key: { x: 700, y: 450, w: 30, h: 30, collected: false },
    exit: { x: 650, y: 860, w: 100, h: 20, locked: true }
};

let boss = {
    x: 700, y: 700, w: 32, h: 32, state: 'PATROL', angle: Math.PI, targetId: null, lastKnownPos: null,
    // Waypoints ajustados para longe das quinas e barreiras laterais
    waypoints: [{x:700, y:820}, {x:150, y:820}, {x:150, y:100}, {x:700, y:100}, {x:1250, y:100}, {x:1250, y:820}],
    wpIndex: 0,
    currentSpeech: "",
    speechTimer: 0,
    speechCooldown: 0,
    // Variáveis do sistema anti-stuck
    prevX: 700, prevY: 700,
    stuckTimer: 0
};

const searchPhrases = [
    "cadê o Rickson?",
    "cadê a Marilyn?",
    "cadê a Aline?",
    "cadê o Éder?",
    "cadê a Keila?",
    "cadê a Letícia?",
    "cadê o Léo?"
];

function rectIntersect(r1, r2) {
    return !(r2.x > r1.x + r1.w || r2.x + r2.w < r1.x || r2.y > r1.y + r1.h || r2.y + r2.h < r1.y);
}
function dist(x1, y1, x2, y2) { return Math.hypot(x2 - x1, y2 - y1); }

const colors = ['#00bcd4', '#e91e63', '#ff9800', '#9c27b0', '#8bc34a', '#ffeb3b'];
let colorIndex = 0;

io.on('connection', (socket) => {
    if(gameState !== 'LOBBY' || Object.keys(players).length >= 6) {
        socket.emit('gameFull');
        socket.disconnect();
        return;
    }

    let photoFiles = [];
    try {
        const fotosDir = path.join(__dirname, 'fotos');
        if (fs.existsSync(fotosDir)) {
            photoFiles = fs.readdirSync(fotosDir).filter(file => /\.(jpg|jpeg|png|webp)$/i.test(file));
        }
    } catch (e) {
        console.log("Erro ao ler pasta de fotos.");
    }
    socket.emit('photoList', photoFiles);

    players[socket.id] = {
        id: socket.id, ready: false, name: `Jogador ${nextPlayerNumber}`,
        color: colors[colorIndex % colors.length], avatar: null,
        x: 80 + (Object.keys(players).length * 80), y: 80, w: 26, h: 26,
        stamina: 100, isHidden: false, isMoving: false, isDead: false,
        inputs: { up: false, down: false, left: false, right: false, run: false }
    };
    colorIndex++;
    nextPlayerNumber++;

    io.emit('lobbyUpdate', Object.values(players));

    socket.on('updateAvatar', (base64Image) => {
        if(players[socket.id]) {
            players[socket.id].avatar = base64Image;
            io.emit('lobbyUpdate', Object.values(players));
        }
    });

    socket.on('setReady', (isReady) => {
        if(players[socket.id]) {
            players[socket.id].ready = isReady;
            io.emit('lobbyUpdate', Object.values(players));
            checkGameStart();
        }
    });

    socket.on('input', (inputs) => {
        if(players[socket.id] && gameState === 'PLAYING' && !players[socket.id].isDead) {
            players[socket.id].inputs = inputs;
        }
    });

    socket.on('action', (actionType) => {
        let p = players[socket.id];
        if(!p || p.isDead || gameState !== 'PLAYING') return;

        if(actionType === 'HIDE') {
            let nearHiding = map.hidingSpots.find(s => rectIntersect(p, {x: s.x-10, y: s.y-10, w: s.w+20, h: s.h+20}));
            if(nearHiding && !p.isHidden) {
                p.isHidden = true; p.x = nearHiding.x + 15; p.y = nearHiding.y + 15;
            } else if (p.isHidden) p.isHidden = false;
        }

        if(actionType === 'INTERACT' && !p.isHidden) {
            if(!map.key.collected && rectIntersect(p, map.key)) {
                map.key.collected = true; map.exit.locked = false;
                io.emit('audioPlay', 'item');
            }
            if(rectIntersect(p, {x: map.exit.x, y: map.exit.y - 20, w: map.exit.w, h: map.exit.h + 20}) && !map.exit.locked) {
                delete players[socket.id];
                socket.emit('gameOver', { won: true, msg: "Você escapou em segurança!" });
                if(Object.keys(players).length === 0) resetGame();
            }
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('lobbyUpdate', Object.values(players));
        if(Object.keys(players).length === 0) {
            nextPlayerNumber = 1;
            resetGame();
        }
    });
});

function checkGameStart() {
    let pList = Object.values(players);
    if(pList.length > 0 && pList.every(p => p.ready)) {
        gameState = 'PLAYING';
        startTime = Date.now();
        io.emit('gameStart', map);
    }
}

function resetGame() {
    gameState = 'LOBBY';
    map.key.collected = false; 
    map.exit.locked = true;
    boss.x = 700; 
    boss.y = 700;
    boss.prevX = 700;
    boss.prevY = 700;
    boss.stuckTimer = 0;
    boss.state = 'PATROL'; 
    boss.targetId = null;
    boss.wpIndex = 0;
    boss.currentSpeech = "";
    boss.speechTimer = 0;
    boss.speechCooldown = 0;
    io.emit('resetToLobby');
}

setInterval(() => {
    if(gameState !== 'PLAYING') return;

    let pList = Object.values(players);

    // 1. Movimentação dos jogadores
    pList.forEach(p => {
        if(p.isDead) return;
        if(p.isHidden) {
            p.stamina = Math.min(p.stamina + 0.4, 100); p.isMoving = false; return;
        }
        let speed = 4; let dx = 0; let dy = 0;
        if(p.inputs.up) dy = -speed; if(p.inputs.down) dy = speed;
        if(p.inputs.left) dx = -speed; if(p.inputs.right) dx = speed;
        p.isMoving = (dx !== 0 || dy !== 0);

        if(p.inputs.run && p.stamina > 0 && p.isMoving) {
            speed = 7; p.stamina -= 1.2;
            if(dx !== 0) dx = (dx > 0) ? speed : -speed;
            if(dy !== 0) dy = (dy > 0) ? speed : -speed;
        } else {
            p.stamina = Math.min(p.stamina + 0.4, 100);
        }

        let nextX = p.x + dx; let nextY = p.y + dy;
        let hitX = false, hitY = false;
        map.walls.forEach(w => {
            if(rectIntersect({x: nextX, y: p.y, w: p.w, h: p.h}, w)) hitX = true;
            if(rectIntersect({x: p.x, y: nextY, w: p.w, h: p.h}, w)) hitY = true;
        });
        if(!hitX) p.x = nextX; if(!hitY) p.y = nextY;
    });

    // 2. IA do Chefe
    let speed = boss.state === 'CHASE' ? 7.2 : 3;
    let targetX = boss.x, targetY = boss.y;

    if(boss.state === 'PATROL') {
        let wp = boss.waypoints[boss.wpIndex];
        targetX = wp.x; targetY = wp.y;
        if(dist(boss.x, boss.y, wp.x, wp.y) < 15) boss.wpIndex = (boss.wpIndex + 1) % boss.waypoints.length;
    } 
    else if(boss.state === 'CHASE' && players[boss.targetId] && !players[boss.targetId].isDead) {
        targetX = players[boss.targetId].x; targetY = players[boss.targetId].y;
        boss.lastKnownPos = {x: targetX, y: targetY};
    } 
    else if(boss.state === 'SEARCH') {
        if(boss.lastKnownPos) {
            targetX = boss.lastKnownPos.x; targetY = boss.lastKnownPos.y;
            if(dist(boss.x, boss.y, targetX, targetY) < 15) boss.state = 'PATROL';
        } else boss.state = 'PATROL';
    }

    if (boss.state === 'PATROL' || boss.state === 'SEARCH') {
        if (boss.speechCooldown > 0) {
            boss.speechCooldown--;
        } else if (boss.speechTimer <= 0) {
            let randomPhrase = searchPhrases[Math.floor(Math.random() * searchPhrases.length)];
            boss.currentSpeech = randomPhrase;
            boss.speechTimer = 90;
            boss.speechCooldown = 150 + Math.random() * 150;
            io.emit('audioPlay', 'bossSpeak');
        }
    }

    if (boss.speechTimer > 0) {
        boss.speechTimer--;
    } else if (boss.speechTimer === 0 && boss.state !== 'CHASE') {
        boss.currentSpeech = "";
    }

    let dx = targetX - boss.x; let dy = targetY - boss.y;
    if(dist(boss.x, boss.y, targetX, targetY) > 2) boss.angle = Math.atan2(dy, dx);
    
    let nextX = boss.x + Math.cos(boss.angle) * speed;
    let nextY = boss.y + Math.sin(boss.angle) * speed;
    let hitX = false, hitY = false;
    map.walls.forEach(w => {
        if(rectIntersect({x: nextX, y: boss.y, w: boss.w, h: boss.h}, w)) hitX = true;
        if(rectIntersect({x: boss.x, y: nextY, w: boss.w, h: boss.h}, w)) hitY = true;
    });
    if(!hitX) boss.x = nextX; if(!hitY) boss.y = nextY;

    // --- Sistema Anti-Stuck do Boss ---
    // Se ele se moveu menos que 0.5 pixels neste quadro, ele incrementa o timer
    if (Math.abs(boss.x - boss.prevX) < 0.5 && Math.abs(boss.y - boss.prevY) < 0.5 && boss.state !== 'SEARCH') {
        boss.stuckTimer++;
        if (boss.stuckTimer > 45) { // Passou 1.5 segundo completamente preso
            if (boss.state === 'PATROL') {
                // Pula pro próximo waypoint
                boss.wpIndex = (boss.wpIndex + 1) % boss.waypoints.length;
            } else if (boss.state === 'CHASE') {
                // Desiste da perseguição pra não ficar esfregando a cara na parede
                boss.state = 'SEARCH';
                boss.targetId = null;
            }
            boss.stuckTimer = 0;
        }
    } else {
        boss.stuckTimer = 0; // Se andou normalmente, reseta
    }
    
    boss.prevX = boss.x;
    boss.prevY = boss.y;
    // ----------------------------------

    let closestP = null; let closestDist = Infinity;
    pList.forEach(p => {
        if(p.isDead || p.isHidden) return;
        let d = dist(boss.x, boss.y, p.x, p.y);
        if(d < 400) {
            let angleTo = Math.atan2(p.y - boss.y, p.x - boss.x);
            let angleDiff = Math.abs(boss.angle - angleTo);
            if(angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;
            if(angleDiff < Math.PI / 2.5) {
                let hasLOS = true;
                map.walls.forEach(w => {
                    if (Math.min(boss.x, p.x) < w.x+w.w && Math.max(boss.x, p.x) > w.x &&
                        Math.min(boss.y, p.y) < w.y+w.h && Math.max(boss.y, p.y) > w.y) hasLOS = false;
                });
                if(hasLOS && d < closestDist) { closestDist = d; closestP = p; }
            }
        }
    });

    if(closestP) {
        if(boss.state !== 'CHASE') {
            io.emit('bossAlert', "Te achei, nó cego!");
            boss.currentSpeech = "Te achei, nó cego!";
            boss.speechTimer = 180;
        }
        boss.state = 'CHASE'; boss.targetId = closestP.id;
    } else if(boss.state === 'CHASE') {
        boss.state = 'SEARCH'; boss.targetId = null;
    }

    pList.forEach(p => {
        if(!p.isDead && !p.isHidden && rectIntersect(p, boss)) {
            p.isDead = true;
            p.isHidden = false;
            io.emit('playerCaught', { id: p.id, name: p.name });
            io.emit('audioPlay', 'alert');
        }
    });

    let activePlayers = pList.filter(p => !p.isDead);
    if(pList.length > 0 && activePlayers.length === 0) {
        io.emit('gameOver', { won: false, msg: "O Chefe pegou todo mundo! Fim de jogo." });
        resetGame();
    }

    io.emit('syncState', {
        players: players,
        boss: boss,
        mapState: { keyCollected: map.key.collected, exitLocked: map.exit.locked },
        time: Math.floor((Date.now() - startTime) / 1000)
    });

}, 1000 / 30);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
