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

const MAP_W = 2400, MAP_H = 1800;
const map = {
    w: MAP_W, h: MAP_H,
    zones: [
        {name: "RECEPÇÃO", x: 100, y: 100, w: 600, h: 400}, {name: "FARMÁCIA", x: 800, y: 100, w: 400, h: 400},
        {name: "LABORATÓRIO", x: 1300, y: 100, w: 500, h: 600}, {name: "RH & COMPRAS", x: 100, y: 600, w: 500, h: 500},
        {name: "RADIOLOGIA", x: 700, y: 600, w: 500, h: 500}, {name: "REFEITÓRIO", x: 100, y: 1200, w: 800, h: 500},
        {name: "ALMOXARIFADO", x: 1000, y: 1200, w: 800, h: 500},
    ],
    walls: [
        {x: 0, y: 0, w: MAP_W, h: 20}, {x: 0, y: MAP_H-20, w: MAP_W, h: 20},
        {x: 0, y: 0, w: 20, h: MAP_H}, {x: MAP_W-20, y: 0, w: 20, h: MAP_H},
        {x: 700, y: 100, w: 20, h: 400}, {x: 1220, y: 100, w: 20, h: 600},
        {x: 100, y: 520, w: 400, h: 20}, {x: 600, y: 520, w: 1200, h: 20},
        {x: 620, y: 600, w: 20, h: 500}, {x: 1220, y: 800, w: 20, h: 300},
        {x: 100, y: 1120, w: 1700, h: 20}, {x: 920, y: 1140, w: 20, h: 560}
    ],
    hidingSpots: [
        {x: 120, y: 120, w: 60, h: 60}, {x: 820, y: 120, w: 60, h: 60}, {x: 1320, y: 120, w: 60, h: 60},
        {x: 120, y: 620, w: 60, h: 60}, {x: 720, y: 620, w: 60, h: 60}, {x: 120, y: 1220, w: 60, h: 60}, {x: 1720, y: 1220, w: 60, h: 60}
    ],
    exit: { x: MAP_W/2 - 50, y: MAP_H - 40, w: 100, h: 20 }
};

const ALL_OBJECTIVES = [
    { type: 'ID_CARD', name: 'Encontrar Crachá', desc: 'Procure o crachá azul' },
    { type: 'DOCUMENTS', name: 'Recuperar Prontuários', desc: 'Pegue os documentos vermelhos' },
    { type: 'POWER', name: 'Religar Energia', desc: 'Ative o painel amarelo' },
    { type: 'KEY', name: 'Pegar Chave de Fuga', desc: 'Encontre a chave dourada' }
];

let gameManager = { objectivesList: [], currentObjectiveIndex: 0, activeItem: null, globalEvent: 'NONE', eventTimer: 0 };

let boss = {
    x: MAP_W/2, y: MAP_H/2, w: 32, h: 32, state: 'PATROL', angle: 0, targetId: null, lastKnownPos: null,
    waypoints: [ {x: 400, y: 300}, {x: 1000, y: 300}, {x: 1500, y: 400}, {x: 350, y: 850}, {x: 950, y: 850}, {x: 500, y: 1450}, {x: 1400, y: 1450} ],
    wpIndex: 0, prevX: 0, prevY: 0, stuckTimer: 0, isMoving: false
};

function rectIntersect(r1, r2) { return !(r2.x > r1.x + r1.w || r2.x + r2.w < r1.x || r2.y > r1.y + r1.h || r2.y + r2.h < r1.y); }
function dist(x1, y1, x2, y2) { return Math.hypot(x2 - x1, y2 - y1); }

const colors = ['#00bcd4', '#e91e63', '#ff9800', '#9c27b0', '#8bc34a', '#ffeb3b'];

io.on('connection', (socket) => {
    if(gameState !== 'LOBBY') { socket.emit('gameFull'); socket.disconnect(); return; }

    let photoFiles = [];
    try {
        const fotosDir = path.join(__dirname, 'fotos');
        if (fs.existsSync(fotosDir)) {
            photoFiles = fs.readdirSync(fotosDir).filter(file => /\.(jpg|jpeg|png|webp)$/i.test(file));
        }
    } catch (e) { console.log("Erro ao ler pasta de fotos."); }
    socket.emit('photoList', photoFiles);

    players[socket.id] = {
        id: socket.id, ready: false, name: `Jogador ${nextPlayerNumber}`, color: colors[(nextPlayerNumber-1) % colors.length], avatar: null,
        x: 200 + (Object.keys(players).length * 50), y: 200, w: 30, h: 30,
        stamina: 100, noise: 0, isHidden: false, isDead: false, isMoving: false,
        inputs: { up: false, down: false, left: false, right: false, run: false, sneak: false }
    };
    nextPlayerNumber++;
    io.emit('lobbyUpdate', Object.values(players));

    socket.on('updateAvatar', (fotoFilename) => {
        if(players[socket.id]) { players[socket.id].avatar = fotoFilename; io.emit('lobbyUpdate', Object.values(players)); }
    });

    socket.on('setReady', (isReady) => {
        let p = players[socket.id];
        if(!p) return;
        if(isReady && !p.avatar) {
            socket.emit('errorMsg', 'Escolha uma foto antes de ficar pronto!');
            return;
        }
        p.ready = isReady;
        io.emit('lobbyUpdate', Object.values(players));
        checkGameStart();
    });

    socket.on('input', (inputs) => { if(players[socket.id] && gameState === 'PLAYING' && !players[socket.id].isDead) players[socket.id].inputs = inputs; });

    socket.on('action', (actionType) => {
        let p = players[socket.id]; if(!p || p.isDead || gameState !== 'PLAYING') return;
        if(actionType === 'HIDE') {
            let nearHiding = map.hidingSpots.find(s => rectIntersect(p, {x: s.x-20, y: s.y-20, w: s.w+40, h: s.h+40}));
            if(nearHiding && !p.isHidden) { p.isHidden = true; p.x = nearHiding.x + 15; p.y = nearHiding.y + 15; } 
            else if (p.isHidden) p.isHidden = false;
        }
        if(actionType === 'INTERACT' && !p.isHidden) {
            if(gameManager.activeItem && rectIntersect(p, gameManager.activeItem)) {
                io.emit('audioPlay', 'item'); gameManager.currentObjectiveIndex++; spawnNextObjective();
            } else if(gameManager.currentObjectiveIndex >= gameManager.objectivesList.length && rectIntersect(p, {x: map.exit.x, y: map.exit.y - 20, w: map.exit.w, h: map.exit.h + 20})) {
                p.isDead = true; p.saved = true; socket.emit('gameOver', { won: true, msg: "Você escapou!" }); checkEndGameCondition();
            }
        }
    });

    socket.on('disconnect', () => { delete players[socket.id]; io.emit('lobbyUpdate', Object.values(players)); if(Object.keys(players).length === 0) resetGame(); });
});

function spawnNextObjective() {
    if(gameManager.currentObjectiveIndex < gameManager.objectivesList.length) {
        let curr = gameManager.objectivesList[gameManager.currentObjectiveIndex];
        gameManager.activeItem = { x: 300 + Math.random()*1000, y: 300 + Math.random()*800, w: 30, h: 30, color: '#facc15', type: curr.type };
        io.emit('bossAlert', `Novo Objetivo: ${curr.name}`);
    } else {
        gameManager.activeItem = null; io.emit('bossAlert', "Tudo concluído! CORRA PARA A SAÍDA!");
    }
}

function checkGameStart() {
    let pList = Object.values(players);
    if(pList.length > 0 && pList.every(p => p.ready && p.avatar)) {
        gameState = 'PLAYING'; startTime = Date.now();
        gameManager.objectivesList = [...ALL_OBJECTIVES].sort(() => Math.random() - 0.5);
        gameManager.currentObjectiveIndex = 0; spawnNextObjective();
        io.emit('gameStart', map);
    }
}

function checkEndGameCondition() {
    let pList = Object.values(players); let aliveAndNotSaved = pList.filter(p => !p.isDead);
    if(pList.length > 0 && aliveAndNotSaved.length === 0) {
        let anyoneSaved = pList.some(p => p.saved);
        io.emit('gameOver', { won: anyoneSaved, msg: anyoneSaved ? "Fim da partida. Sobreviventes escaparam!" : "O Chefe pegou todos!" });
        resetGame();
    }
}

function resetGame() {
    gameState = 'LOBBY';
    boss = { x: MAP_W/2, y: MAP_H/2, w: 32, h: 32, state: 'PATROL', angle: 0, targetId: null, lastKnownPos: null, wpIndex: 0, prevX: 0, prevY: 0, stuckTimer: 0, isMoving: false };
    Object.values(players).forEach(p => { p.isDead = false; p.saved = false; p.isHidden = false; });
    io.emit('resetToLobby');
}

setInterval(() => {
    if(gameState !== 'PLAYING') return;

    if(Math.random() < 0.002 && gameManager.globalEvent === 'NONE') { 
        gameManager.globalEvent = Math.random() > 0.5 ? 'BLACKOUT' : 'ALARM'; gameManager.eventTimer = 300; 
        io.emit('bossAlert', gameManager.globalEvent === 'BLACKOUT' ? "ALERTA: QUEDA DE ENERGIA!" : "ALERTA: ALARME DISPARADO!");
    }
    if(gameManager.eventTimer > 0) { gameManager.eventTimer--; if(gameManager.eventTimer <= 0) gameManager.globalEvent = 'NONE'; }

    let pList = Object.values(players);

    pList.forEach(p => {
        if(p.isDead) return;
        if(p.isHidden) { p.stamina = Math.min(p.stamina + 0.5, 100); p.noise = 0; p.isMoving = false; return; }
        
        let dx = 0; let dy = 0; let speed = p.inputs.sneak ? 2 : 4.5;
        p.noise = p.inputs.sneak ? 5 : 20;
        
        if(p.inputs.up) dy = -speed; if(p.inputs.down) dy = speed;
        if(p.inputs.left) dx = -speed; if(p.inputs.right) dx = speed;
        
        p.isMoving = (dx !== 0 || dy !== 0);

        if(p.inputs.run && p.stamina > 0 && p.isMoving && !p.inputs.sneak) {
            speed = 8; p.stamina -= 1.5; p.noise = 100;
            dx = (dx > 0) ? speed : (dx < 0 ? -speed : 0); dy = (dy > 0) ? speed : (dy < 0 ? -speed : 0);
        } else { p.stamina = Math.min(p.stamina + 0.3, 100); }
        if(!p.isMoving) p.noise = 0;
        if(gameManager.globalEvent === 'ALARM') p.noise += 50;

        let nextX = p.x + dx; let nextY = p.y + dy;
        let hitX = false, hitY = false;
        map.walls.forEach(w => {
            if(rectIntersect({x: nextX, y: p.y, w: p.w, h: p.h}, w)) hitX = true;
            if(rectIntersect({x: p.x, y: nextY, w: p.w, h: p.h}, w)) hitY = true;
        });
        if(!hitX) p.x = nextX; if(!hitY) p.y = nextY;
    });

    let speed = boss.state === 'CHASE' ? 8.5 : 3.5;
    let targetX = boss.x, targetY = boss.y;

    if(boss.state === 'PATROL') {
        let wp = boss.waypoints[boss.wpIndex]; targetX = wp.x; targetY = wp.y;
        if(dist(boss.x, boss.y, wp.x, wp.y) < 20) boss.wpIndex = (boss.wpIndex + 1) % boss.waypoints.length;
    } 
    else if(boss.state === 'CHASE' && players[boss.targetId] && !players[boss.targetId].isDead) {
        targetX = players[boss.targetId].x; targetY = players[boss.targetId].y; boss.lastKnownPos = {x: targetX, y: targetY};
    } 
    else if(boss.state === 'SEARCH') {
        if(boss.lastKnownPos) {
            targetX = boss.lastKnownPos.x; targetY = boss.lastKnownPos.y;
            if(dist(boss.x, boss.y, targetX, targetY) < 20) boss.state = 'PATROL';
        } else boss.state = 'PATROL';
    }

    let dx = targetX - boss.x; let dy = targetY - boss.y;
    if(dist(boss.x, boss.y, targetX, targetY) > 2) boss.angle = Math.atan2(dy, dx);
    
    let nextX = boss.x + Math.cos(boss.angle) * speed; let nextY = boss.y + Math.sin(boss.angle) * speed;
    let hitX = false, hitY = false;
    map.walls.forEach(w => {
        if(rectIntersect({x: nextX, y: boss.y, w: boss.w, h: boss.h}, w)) hitX = true;
        if(rectIntersect({x: boss.x, y: nextY, w: boss.w, h: boss.h}, w)) hitY = true;
    });
    if(!hitX) boss.x = nextX; if(!hitY) boss.y = nextY;

    boss.isMoving = (Math.abs(boss.x - boss.prevX) > 0.5 || Math.abs(boss.y - boss.prevY) > 0.5);

    // SISTEMA ANTI-TRAVAMENTO (UNSTUCK)
    if (!boss.isMoving) {
        boss.stuckTimer++;
        if (boss.stuckTimer > 15) { // Se ficar parado contra a parede por 0.5 seg
            boss.state = 'PATROL';
            boss.targetId = null;
            boss.wpIndex = (boss.wpIndex + 1) % boss.waypoints.length; // Muda a rota
            
            // Dá um leve empurrãozinho na direção do novo waypoint pra soltar do polígono
            let wp = boss.waypoints[boss.wpIndex];
            let angleToWp = Math.atan2(wp.y - boss.y, wp.x - boss.x);
            boss.x += Math.cos(angleToWp) * 10;
            boss.y += Math.sin(angleToWp) * 10;
            
            boss.stuckTimer = 0;
        }
    } else {
        boss.stuckTimer = 0;
    }
    
    boss.prevX = boss.x; boss.prevY = boss.y;

    let closestDist = Infinity; let closestP = null;
    let sightRadius = gameManager.globalEvent === 'BLACKOUT' ? 250 : 500;

    const PROXIMITY_ALERT_RANGE = 70; // se o jogador chegar bem perto, o chefe sempre percebe, mesmo de costas

    pList.forEach(p => {
        if(p.isDead || p.isHidden) return;
        let d = dist(boss.x, boss.y, p.x, p.y);
        // Raio de audição maior e com piso mínimo, pra "andando perto" já ser suficiente pra ouvir
        let isHeard = d < (30 + p.noise * 6);
        let isSeen = false;
        let isClose = d < PROXIMITY_ALERT_RANGE;
        if(d < sightRadius) {
            let angleTo = Math.atan2(p.y - boss.y, p.x - boss.x);
            let angleDiff = Math.abs(boss.angle - angleTo);
            if(angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;
            // Campo de visão um pouco mais largo (era PI/2.5)
            if(angleDiff < Math.PI / 2 || isClose) {
                let hasLOS = true;
                map.walls.forEach(w => { 
                    if (Math.min(boss.x, p.x) < w.x+w.w && Math.max(boss.x, p.x) > w.x && Math.min(boss.y, p.y) < w.y+w.h && Math.max(boss.y, p.y) > w.y) hasLOS = false;
                });
                isSeen = hasLOS;
            }
        }
        if((isSeen || isHeard || isClose) && d < closestDist) { closestDist = d; closestP = p; }
    });

    if(closestP) {
        if(boss.state !== 'CHASE') { io.emit('audioPlay', 'bossSpot'); }
        boss.state = 'CHASE'; boss.targetId = closestP.id;
    } else if(boss.state === 'CHASE') { boss.state = 'SEARCH'; boss.targetId = null; }

    pList.forEach(p => {
        if(!p.isDead && !p.isHidden && rectIntersect(p, boss)) {
            p.isDead = true; p.isHidden = false; io.emit('playerCaught', { id: p.id }); checkEndGameCondition();
        }
    });

    io.emit('syncState', { players: players, boss: boss, gameManager: gameManager, mapExit: map.exit, time: Math.floor((Date.now() - startTime) / 1000) });

}, 1000 / 30);

server.listen(3000, () => console.log(`Servidor rodando na porta 3000`));
