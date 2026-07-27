const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let gameState = 'LOBBY'; 
let players = {};
let startTime = 0;
let nextPlayerNumber = 1;

// Gerador de Mapa do Hospital (Muito maior, 2400x1800)
const MAP_W = 2400, MAP_H = 1800;
const map = {
    w: MAP_W, h: MAP_H,
    zones: [
        {name: "RECEPÇÃO", x: 100, y: 100, w: 600, h: 400},
        {name: "FARMÁCIA", x: 800, y: 100, w: 400, h: 400},
        {name: "LABORATÓRIO", x: 1300, y: 100, w: 500, h: 600},
        {name: "RH & COMPRAS", x: 100, y: 600, w: 500, h: 500},
        {name: "RADIOLOGIA", x: 700, y: 600, w: 500, h: 500},
        {name: "REFEITÓRIO", x: 100, y: 1200, w: 800, h: 500},
        {name: "ALMOXARIFADO", x: 1000, y: 1200, w: 800, h: 500},
    ],
    walls: [
        // Bordas
        {x: 0, y: 0, w: MAP_W, h: 20}, {x: 0, y: MAP_H-20, w: MAP_W, h: 20},
        {x: 0, y: 0, w: 20, h: MAP_H}, {x: MAP_W-20, y: 0, w: 20, h: MAP_H},
        // Paredes internas estruturais
        {x: 700, y: 100, w: 20, h: 400}, {x: 1220, y: 100, w: 20, h: 600},
        {x: 100, y: 520, w: 400, h: 20}, {x: 600, y: 520, w: 1200, h: 20},
        {x: 620, y: 600, w: 20, h: 500}, {x: 1220, y: 800, w: 20, h: 300},
        {x: 100, y: 1120, w: 1700, h: 20}, {x: 920, y: 1140, w: 20, h: 560}
    ],
    hidingSpots: [ // Armários e Banheiros
        {x: 120, y: 120, w: 60, h: 60}, {x: 820, y: 120, w: 60, h: 60},
        {x: 1320, y: 120, w: 60, h: 60}, {x: 120, y: 620, w: 60, h: 60},
        {x: 720, y: 620, w: 60, h: 60}, {x: 120, y: 1220, w: 60, h: 60},
        {x: 1720, y: 1220, w: 60, h: 60}
    ],
    exit: { x: MAP_W/2 - 50, y: MAP_H - 40, w: 100, h: 20 }
};

// Sistema de Objetivos Aleatórios
const ALL_OBJECTIVES = [
    { type: 'ID_CARD', name: 'Encontrar Crachá do RH', desc: 'Procure o crachá azul no setor de RH & Compras.' },
    { type: 'DOCUMENTS', name: 'Recuperar Prontuários', desc: 'Pegue os documentos vermelhos na Recepção.' },
    { type: 'POWER', name: 'Religar Energia', desc: 'Ative o painel amarelo no Almoxarifado.' },
    { type: 'KEY', name: 'Pegar Chave de Fuga', desc: 'Encontre a chave dourada no Laboratório.' }
];

let gameManager = {
    objectivesList: [],
    currentObjectiveIndex: 0,
    activeItem: null,
    globalEvent: 'NONE', // 'NONE', 'BLACKOUT', 'ALARM'
    eventTimer: 0
};

let boss = {
    x: MAP_W/2, y: MAP_H/2, w: 32, h: 32, state: 'PATROL', angle: 0, targetId: null, lastKnownPos: null,
    waypoints: [
        {x: 400, y: 300}, {x: 1000, y: 300}, {x: 1500, y: 400}, 
        {x: 350, y: 850}, {x: 950, y: 850}, {x: 500, y: 1450}, {x: 1400, y: 1450}
    ],
    wpIndex: 0, prevX: 0, prevY: 0, stuckTimer: 0
};

function rectIntersect(r1, r2) {
    return !(r2.x > r1.x + r1.w || r2.x + r2.w < r1.x || r2.y > r1.y + r1.h || r2.y + r2.h < r1.y);
}
function dist(x1, y1, x2, y2) { return Math.hypot(x2 - x1, y2 - y1); }

const colors = ['#00bcd4', '#e91e63', '#ff9800', '#9c27b0', '#8bc34a', '#ffeb3b'];

io.on('connection', (socket) => {
    if(gameState !== 'LOBBY') { socket.emit('gameFull'); socket.disconnect(); return; }

    players[socket.id] = {
        id: socket.id, ready: false, name: `Jogador ${nextPlayerNumber}`, color: colors[(nextPlayerNumber-1) % colors.length],
        x: 200 + (Object.keys(players).length * 50), y: 200, w: 26, h: 26,
        stamina: 100, noise: 0, isHidden: false, isDead: false,
        inputs: { up: false, down: false, left: false, right: false, run: false, sneak: false }
    };
    nextPlayerNumber++;
    io.emit('lobbyUpdate', Object.values(players));

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
            let nearHiding = map.hidingSpots.find(s => rectIntersect(p, {x: s.x-20, y: s.y-20, w: s.w+40, h: s.h+40}));
            if(nearHiding && !p.isHidden) {
                p.isHidden = true; p.x = nearHiding.x + 15; p.y = nearHiding.y + 15;
            } else if (p.isHidden) p.isHidden = false;
        }

        if(actionType === 'INTERACT' && !p.isHidden) {
            // Coletar objetivo atual
            if(gameManager.activeItem && rectIntersect(p, gameManager.activeItem)) {
                io.emit('audioPlay', 'item');
                gameManager.currentObjectiveIndex++;
                spawnNextObjective();
            }
            // Saída
            else if(gameManager.currentObjectiveIndex >= gameManager.objectivesList.length && rectIntersect(p, {x: map.exit.x, y: map.exit.y - 20, w: map.exit.w, h: map.exit.h + 20})) {
                p.isDead = true; // Marca como "salvo" sumindo do mapa
                p.saved = true;
                socket.emit('gameOver', { won: true, msg: "Você escapou do hospital!" });
                checkEndGameCondition();
            }
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('lobbyUpdate', Object.values(players));
        if(Object.keys(players).length === 0) resetGame();
    });
});

function spawnNextObjective() {
    if(gameManager.currentObjectiveIndex < gameManager.objectivesList.length) {
        let curr = gameManager.objectivesList[gameManager.currentObjectiveIndex];
        // Define posições baseadas no setor do objetivo
        let pos = {x:0, y:0};
        if(curr.type === 'ID_CARD') pos = {x: 300, y: 700};
        if(curr.type === 'DOCUMENTS') pos = {x: 400, y: 300};
        if(curr.type === 'POWER') pos = {x: 1400, y: 1400};
        if(curr.type === 'KEY') pos = {x: 1500, y: 400};
        
        // Randomiza um pouco a posição dentro do setor
        gameManager.activeItem = { x: pos.x + Math.random()*100, y: pos.y + Math.random()*100, w: 30, h: 30, color: (curr.type==='ID_CARD'?'#3b82f6':curr.type==='DOCUMENTS'?'#ef4444':curr.type==='POWER'?'#eab308':'#f59e0b'), type: curr.type };
        io.emit('bossAlert', `Novo Objetivo: ${curr.name}`);
    } else {
        gameManager.activeItem = null;
        io.emit('bossAlert', "Tudo concluído! CORRA PARA A SAÍDA!");
    }
}

function checkGameStart() {
    let pList = Object.values(players);
    if(pList.length > 0 && pList.every(p => p.ready)) {
        gameState = 'PLAYING';
        startTime = Date.now();
        // Randomiza objetivos
        gameManager.objectivesList = [...ALL_OBJECTIVES].sort(() => Math.random() - 0.5);
        gameManager.currentObjectiveIndex = 0;
        spawnNextObjective();
        io.emit('gameStart', map);
    }
}

function checkEndGameCondition() {
    let pList = Object.values(players);
    let aliveAndNotSaved = pList.filter(p => !p.isDead);
    if(pList.length > 0 && aliveAndNotSaved.length === 0) {
        let anyoneSaved = pList.some(p => p.saved);
        if(anyoneSaved) io.emit('gameOver', { won: true, msg: "Fim da partida. Sobreviventes escaparam!" });
        else io.emit('gameOver', { won: false, msg: "O Chefe pegou todos no Hospital. Fim de jogo." });
        resetGame();
    }
}

function resetGame() {
    gameState = 'LOBBY';
    boss = { x: MAP_W/2, y: MAP_H/2, w: 32, h: 32, state: 'PATROL', angle: 0, targetId: null, lastKnownPos: null, wpIndex: 0, prevX: 0, prevY: 0, stuckTimer: 0 };
    Object.values(players).forEach(p => { p.isDead = false; p.saved = false; p.isHidden = false; });
    io.emit('resetToLobby');
}

// Loop Principal do Servidor (30 fps)
setInterval(() => {
    if(gameState !== 'PLAYING') return;

    // Gerenciador de Eventos Aleatórios
    if(Math.random() < 0.002 && gameManager.globalEvent === 'NONE') { // 0.2% chance por frame de acontecer
        gameManager.globalEvent = Math.random() > 0.5 ? 'BLACKOUT' : 'ALARM';
        gameManager.eventTimer = 300; // 10 segundos a 30fps
        io.emit('bossAlert', gameManager.globalEvent === 'BLACKOUT' ? "ALERTA: QUEDA DE ENERGIA!" : "ALERTA: ALARME DISPARADO!");
    }
    if(gameManager.eventTimer > 0) {
        gameManager.eventTimer--;
        if(gameManager.eventTimer <= 0) gameManager.globalEvent = 'NONE';
    }

    let pList = Object.values(players);

    // 1. Jogadores: Movimento e Ruído
    pList.forEach(p => {
        if(p.isDead) return;
        if(p.isHidden) { p.stamina = Math.min(p.stamina + 0.5, 100); p.noise = 0; return; }
        
        let dx = 0; let dy = 0;
        let speed = p.inputs.sneak ? 2 : 4.5;
        p.noise = p.inputs.sneak ? 5 : 20; // Raio de barulho base
        
        if(p.inputs.up) dy = -speed; if(p.inputs.down) dy = speed;
        if(p.inputs.left) dx = -speed; if(p.inputs.right) dx = speed;
        
        let isMoving = (dx !== 0 || dy !== 0);

        if(p.inputs.run && p.stamina > 0 && isMoving && !p.inputs.sneak) {
            speed = 8; p.stamina -= 1.5; p.noise = 100; // Correr faz muito barulho
            dx = (dx > 0) ? speed : (dx < 0 ? -speed : 0);
            dy = (dy > 0) ? speed : (dy < 0 ? -speed : 0);
        } else {
            p.stamina = Math.min(p.stamina + 0.3, 100);
        }
        if(!isMoving) p.noise = 0;
        if(gameManager.globalEvent === 'ALARM') p.noise += 50; // Alarme esconde passos, mas atrai o chefe

        let nextX = p.x + dx; let nextY = p.y + dy;
        let hitX = false, hitY = false;
        map.walls.forEach(w => {
            if(rectIntersect({x: nextX, y: p.y, w: p.w, h: p.h}, w)) hitX = true;
            if(rectIntersect({x: p.x, y: nextY, w: p.w, h: p.h}, w)) hitY = true;
        });
        if(!hitX) p.x = nextX; if(!hitY) p.y = nextY;
    });

    // 2. IA do Chefe (Visão + Audição)
    let speed = boss.state === 'CHASE' ? 8.5 : 3.5;
    let targetX = boss.x, targetY = boss.y;

    if(boss.state === 'PATROL') {
        let wp = boss.waypoints[boss.wpIndex];
        targetX = wp.x; targetY = wp.y;
        if(dist(boss.x, boss.y, wp.x, wp.y) < 20) boss.wpIndex = (boss.wpIndex + 1) % boss.waypoints.length;
    } 
    else if(boss.state === 'CHASE' && players[boss.targetId] && !players[boss.targetId].isDead) {
        targetX = players[boss.targetId].x; targetY = players[boss.targetId].y;
        boss.lastKnownPos = {x: targetX, y: targetY};
    } 
    else if(boss.state === 'SEARCH') {
        if(boss.lastKnownPos) {
            targetX = boss.lastKnownPos.x; targetY = boss.lastKnownPos.y;
            if(dist(boss.x, boss.y, targetX, targetY) < 20) boss.state = 'PATROL';
        } else boss.state = 'PATROL';
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

    // Anti-Stuck Melhorado
    if (Math.abs(boss.x - boss.prevX) < 1 && Math.abs(boss.y - boss.prevY) < 1 && boss.state !== 'SEARCH') {
        boss.stuckTimer++;
        if (boss.stuckTimer > 30) {
            if (boss.state === 'PATROL') boss.wpIndex = (boss.wpIndex + 1) % boss.waypoints.length;
            else if (boss.state === 'CHASE') { boss.state = 'SEARCH'; boss.targetId = null; }
            boss.stuckTimer = 0;
        }
    } else boss.stuckTimer = 0;
    boss.prevX = boss.x; boss.prevY = boss.y;

    // Detecção (Visão e Audição)
    let closestDist = Infinity; let closestP = null;
    let sightRadius = gameManager.globalEvent === 'BLACKOUT' ? 200 : 500;

    pList.forEach(p => {
        if(p.isDead || p.isHidden) return;
        let d = dist(boss.x, boss.y, p.x, p.y);
        
        // Audição: Se o jogador faz barulho e o raio de barulho alcança o chefe
        let isHeard = d < (p.noise * 3); 

        // Visão (Cone)
        let isSeen = false;
        if(d < sightRadius) {
            let angleTo = Math.atan2(p.y - boss.y, p.x - boss.x);
            let angleDiff = Math.abs(boss.angle - angleTo);
            if(angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;
            if(angleDiff < Math.PI / 2.5) { // Cone de visão
                let hasLOS = true;
                map.walls.forEach(w => { // Checagem simples de parede
                    if (Math.min(boss.x, p.x) < w.x+w.w && Math.max(boss.x, p.x) > w.x &&
                        Math.min(boss.y, p.y) < w.y+w.h && Math.max(boss.y, p.y) > w.y) hasLOS = false;
                });
                isSeen = hasLOS;
            }
        }

        if((isSeen || isHeard) && d < closestDist) { closestDist = d; closestP = p; }
    });

    if(closestP) {
        if(boss.state !== 'CHASE') {
            io.emit('audioPlay', 'bossSpot');
            boss.speechTimer = 180;
        }
        boss.state = 'CHASE'; boss.targetId = closestP.id;
    } else if(boss.state === 'CHASE') {
        boss.state = 'SEARCH'; boss.targetId = null;
    }

    // Captura
    pList.forEach(p => {
        if(!p.isDead && !p.isHidden && rectIntersect(p, boss)) {
            p.isDead = true; p.isHidden = false;
            io.emit('playerCaught', { id: p.id });
            checkEndGameCondition();
        }
    });

    io.emit('syncState', {
        players: players, boss: boss, gameManager: gameManager, mapExit: map.exit,
        time: Math.floor((Date.now() - startTime) / 1000)
    });

}, 1000 / 30);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
