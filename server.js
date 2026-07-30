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
        {name: "CONTRATOS", x: 100, y: 100, w: 600, h: 400}, {name: "FARMÁCIA", x: 800, y: 100, w: 400, h: 400},
        {name: "FINANCEIRO", x: 1300, y: 100, w: 500, h: 600}, {name: "RH & COMPRAS", x: 100, y: 600, w: 500, h: 500},
        {name: "COMPRAS", x: 700, y: 600, w: 500, h: 500}, {name: "REFEITÓRIO", x: 100, y: 1200, w: 800, h: 500},
        {name: "ESTACIONAMENTO", x: 1000, y: 1200, w: 800, h: 500},
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

const BOSS_PATROL_PHRASES = [
    "Cadê a Letícia?", "Cadê a Marilyn?", "Cadê o Rickson?",
    "Cadê a Keila?", "Cadê a Aline?", "Cadê o Léo?"
];
const NPC_PHRASES = ["Nem eu nem tu", "Pode vir, meu patrão", "Me dá um real"];
const NPC_HOLD_PHRASES = ["Eu aceito Pix", "Me paga aí que eu solto", "Não vou te soltar", "Rapaz, eu tava doente", "Nem eu nem tu"];
const TOTAL_OBJECTIVES = 20;

let gameManager = { level: 1, globalEvent: 'NONE', eventTimer: 0, objectivesCollected: 0, totalObjectives: TOTAL_OBJECTIVES, activeItem: null, speakCooldown: 300 };

let boss = {
    x: MAP_W/2, y: MAP_H/2, w: 32, h: 32, state: 'PATROL', angle: 0, targetId: null, lastKnownPos: null,
    waypoints: [ {x: 400, y: 300}, {x: 1000, y: 300}, {x: 1500, y: 400}, {x: 350, y: 850}, {x: 950, y: 850}, {x: 500, y: 1450}, {x: 1400, y: 1450} ],
    wpIndex: 0, prevX: 0, prevY: 0, stuckTimer: 0, isMoving: false, speechText: null, speechTimer: 0, role: 'boss'
};

// Personagem ambiente: fica andando de um lado pro outro. Se encostar em algum
// jogador, segura ele parado por 2 segundos (só um por vez) antes de soltar.
let npc = {
    x: 1400, y: 1450, w: 30, h: 30, angle: 0, isMoving: false, prevX: 0, prevY: 0, stuckTimer: 0,
    waypoints: [ {x: 1400, y: 1450}, {x: 500, y: 1450}, {x: 950, y: 850}, {x: 350, y: 850}, {x: 1500, y: 400}, {x: 1000, y: 300}, {x: 400, y: 300} ],
    wpIndex: 0, speechText: null, speechTimer: 0, speakCooldown: 150, role: 'npc',
    holdingId: null, holdTimer: 0, grabCooldown: 0
};

// Faz o chefe "falar": mostra um balão de fala (via speechText/speechTimer, sincronizado
// no syncState) e dispara um evento à parte pra tocar o som só uma vez.
function bossSay(text, ttlFrames = 90) {
    boss.speechText = text;
    boss.speechTimer = ttlFrames;
    io.emit('bossSpeak', text);
}

function npcSay(text, ttlFrames = 90) {
    npc.speechText = text;
    npc.speechTimer = ttlFrames;
    io.emit('npcSpeak', text);
}

function rectIntersect(r1, r2) { return !(r2.x > r1.x + r1.w || r2.x + r2.w < r1.x || r2.y > r1.y + r1.h || r2.y + r2.h < r1.y); }
function dist(x1, y1, x2, y2) { return Math.hypot(x2 - x1, y2 - y1); }

const colors = ['#00bcd4', '#e91e63', '#ff9800', '#9c27b0', '#8bc34a', '#ffeb3b'];

io.on('connection', (socket) => {
    if(gameState !== 'LOBBY') { socket.emit('gameFull'); socket.disconnect(); return; }

    let photoFiles = [];
    try {
        const fotosDir = path.join(__dirname, 'fotos');
        if (fs.existsSync(fotosDir)) {
            // Arquivos começando com "npc-" são reservados a personagens fixos
            // (ex: o trabalhador ambiente) e não aparecem como opção de avatar.
            photoFiles = fs.readdirSync(fotosDir).filter(file => /\.(jpg|jpeg|png|webp)$/i.test(file) && !/^npc-/i.test(file));
        }
    } catch (e) { console.log("Erro ao ler pasta de fotos."); }
    socket.emit('photoList', photoFiles);

    players[socket.id] = {
        id: socket.id, ready: false, name: `Jogador ${nextPlayerNumber}`, color: colors[(nextPlayerNumber-1) % colors.length], avatar: null,
        x: 200 + (Object.keys(players).length * 50), y: 200, w: 30, h: 30,
        stamina: 100, noise: 0, isHidden: false, isDead: false, isMoving: false, heldByNpc: false,
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
        let p = players[socket.id]; if(!p || p.isDead || p.heldByNpc || gameState !== 'PLAYING') return;
        if(actionType === 'HIDE') {
            let nearHiding = map.hidingSpots.find(s => rectIntersect(p, {x: s.x-20, y: s.y-20, w: s.w+40, h: s.h+40}));
            if(nearHiding && !p.isHidden) { p.isHidden = true; p.x = nearHiding.x + 15; p.y = nearHiding.y + 15; } 
            else if (p.isHidden) p.isHidden = false;
        }
        if(actionType === 'INTERACT' && !p.isHidden) {
            if(gameManager.activeItem && rectIntersect(p, gameManager.activeItem)) {
                io.emit('audioPlay', 'item');
                gameManager.objectivesCollected++;
                spawnNextObjective();
            } else if(gameManager.objectivesCollected >= gameManager.totalObjectives && rectIntersect(p, {x: map.exit.x, y: map.exit.y - 20, w: map.exit.w, h: map.exit.h + 20})) {
                p.isDead = true; p.saved = true; socket.emit('gameOver', { won: true, msg: "Você escapou!" }); checkEndGameCondition();
            }
        }
    });

    socket.on('disconnect', () => { delete players[socket.id]; io.emit('lobbyUpdate', Object.values(players)); if(Object.keys(players).length === 0) resetGame(); });
});

function spawnNextObjective() {
    if(gameManager.objectivesCollected >= gameManager.totalObjectives) {
        gameManager.activeItem = null;
        io.emit('bossAlert', "Tudo coletado! CORRAM PARA A SAÍDA!");
        return;
    }
    let item;
    let tries = 0;
    do {
        item = { x: 150 + Math.random() * (MAP_W - 300), y: 150 + Math.random() * (MAP_H - 300), w: 30, h: 30, color: '#facc15' };
        tries++;
    } while (map.walls.some(w => rectIntersect(item, w)) && tries < 30);
    gameManager.activeItem = item;
}

function checkGameStart() {
    let pList = Object.values(players);
    if(pList.length > 0 && pList.every(p => p.ready && p.avatar)) {
        gameState = 'PLAYING'; startTime = Date.now();
        gameManager.level = 1; gameManager.objectivesCollected = 0; gameManager.speakCooldown = 300;
        npc.x = 1400; npc.y = 1450; npc.wpIndex = 0; npc.speechText = null; npc.speechTimer = 0; npc.speakCooldown = 150; npc.holdingId = null; npc.holdTimer = 0; npc.grabCooldown = 0;
        spawnNextObjective();
        io.emit('bossAlert', `Pegue as ${gameManager.totalObjectives} seringas e fuja do chefe!`);
        io.emit('gameStart', map);
    }
}

function checkEndGameCondition() {
    if(gameState !== 'PLAYING') return; // evita disparar duas vezes no mesmo fim de partida
    let pList = Object.values(players); let aliveAndNotSaved = pList.filter(p => !p.isDead);
    if(pList.length > 0 && aliveAndNotSaved.length === 0) {
        let anyoneSaved = pList.some(p => p.saved);
        gameState = 'GAMEOVER';
        io.emit('gameOver', { won: anyoneSaved, msg: anyoneSaved ? "Fim da partida. Sobreviventes escaparam!" : "O Chefe pegou todos!" });
        // Reinicia o servidor pro estado inicial pouco depois — os clientes
        // também recarregam a própria página nesse meio tempo (ver client.js),
        // então quando reconectarem já vão encontrar tudo limpo, como se
        // fosse a primeira partida.
        setTimeout(resetGame, 4500);
    }
}

function resetGame() {
    gameState = 'LOBBY';
    boss = { x: MAP_W/2, y: MAP_H/2, w: 32, h: 32, state: 'PATROL', angle: 0, targetId: null, lastKnownPos: null, wpIndex: 0, prevX: 0, prevY: 0, stuckTimer: 0, isMoving: false, speechText: null, speechTimer: 0, role: 'boss' };
    npc.x = 1400; npc.y = 1450; npc.wpIndex = 0; npc.speechText = null; npc.speechTimer = 0; npc.speakCooldown = 150; npc.isMoving = false; npc.holdingId = null; npc.holdTimer = 0; npc.grabCooldown = 0;
    gameManager.level = 1; gameManager.globalEvent = 'NONE'; gameManager.eventTimer = 0;
    gameManager.objectivesCollected = 0; gameManager.activeItem = null; gameManager.speakCooldown = 300;
    // Reseta o "pronto" de todo mundo também — sem isso, o lobby ficava travado
    // em "Iniciando..." pra sempre depois de uma partida, pois todo mundo
    // continuava marcado como pronto sem ninguém apertar o botão de novo.
    Object.values(players).forEach(p => { p.isDead = false; p.saved = false; p.isHidden = false; p.ready = false; p.heldByNpc = false; });
    io.emit('resetToLobby');
    io.emit('lobbyUpdate', Object.values(players));
}

setInterval(() => {
    if(gameState !== 'PLAYING') return;

    if(Math.random() < 0.002 && gameManager.globalEvent === 'NONE') { 
        gameManager.globalEvent = Math.random() > 0.5 ? 'BLACKOUT' : 'ALARM'; gameManager.eventTimer = 300; 
        io.emit('bossAlert', gameManager.globalEvent === 'BLACKOUT' ? "ALERTA: QUEDA DE ENERGIA!" : "ALERTA: ALARME DISPARADO!");
    }
    if(gameManager.eventTimer > 0) { gameManager.eventTimer--; if(gameManager.eventTimer <= 0) gameManager.globalEvent = 'NONE'; }

    // A cada 1 minuto de partida, o chefe fica um pouco mais rápido.
    let elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
    let newLevel = 1 + Math.floor(elapsedSeconds / 60);
    if(newLevel !== gameManager.level) {
        gameManager.level = newLevel;
        io.emit('bossAlert', `Level ${newLevel}! O Chefe está mais rápido...`);
        io.emit('audioPlay', 'bossSpot');
    }
    let speedMultiplier = 1 + (gameManager.level - 1) * 0.12;

    // Fala aleatória do chefe enquanto ele não está perseguindo ninguém
    if(boss.state !== 'CHASE') {
        gameManager.speakCooldown--;
        if(gameManager.speakCooldown <= 0) {
            bossSay(BOSS_PATROL_PHRASES[Math.floor(Math.random() * BOSS_PATROL_PHRASES.length)]);
            gameManager.speakCooldown = 300 + Math.floor(Math.random() * 300); // ~10 a 20s
        }
    }
    if(boss.speechTimer > 0) boss.speechTimer--;

    let pList = Object.values(players);

    pList.forEach(p => {
        if(p.isDead) return;
        if(p.isHidden) { p.stamina = Math.min(p.stamina + 0.5, 100); p.noise = 0; p.isMoving = false; return; }
        if(p.heldByNpc) { p.isMoving = false; p.noise = 0; return; }
        
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

    let speed = (boss.state === 'CHASE' ? 8.5 : 3.5) * speedMultiplier;
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

    // Personagem ambiente: anda de waypoint em waypoint. Se estiver segurando
    // alguém, fica parado no lugar até soltar.
    if(npc.holdingId) {
        npc.isMoving = false;
        npc.holdTimer--;
        let held = players[npc.holdingId];
        if(!held || held.isDead || npc.holdTimer <= 0) {
            // Solta o jogador (ou libera se ele morreu/saiu no meio do aperto)
            if(held) held.heldByNpc = false;
            npc.holdingId = null;
            npc.grabCooldown = 60; // ~2s de intervalo antes de poder segurar outra vez
        }
    } else {
        let npcSpeed = 2.5;
        let npcWp = npc.waypoints[npc.wpIndex];
        let npcDx = npcWp.x - npc.x; let npcDy = npcWp.y - npc.y;
        if(dist(npc.x, npc.y, npcWp.x, npcWp.y) > 2) npc.angle = Math.atan2(npcDy, npcDx);
        let npcNextX = npc.x + Math.cos(npc.angle) * npcSpeed;
        let npcNextY = npc.y + Math.sin(npc.angle) * npcSpeed;
        let npcHitX = false, npcHitY = false;
        map.walls.forEach(w => {
            if(rectIntersect({x: npcNextX, y: npc.y, w: npc.w, h: npc.h}, w)) npcHitX = true;
            if(rectIntersect({x: npc.x, y: npcNextY, w: npc.w, h: npc.h}, w)) npcHitY = true;
        });
        if(!npcHitX) npc.x = npcNextX; if(!npcHitY) npc.y = npcNextY;
        npc.isMoving = (Math.abs(npc.x - npc.prevX) > 0.5 || Math.abs(npc.y - npc.prevY) > 0.5);
        if(dist(npc.x, npc.y, npcWp.x, npcWp.y) < 20) npc.wpIndex = (npc.wpIndex + 1) % npc.waypoints.length;

        if (!npc.isMoving) {
            npc.stuckTimer++;
            if (npc.stuckTimer > 15) {
                npc.wpIndex = (npc.wpIndex + 1) % npc.waypoints.length;
                npc.stuckTimer = 0;
            }
        } else { npc.stuckTimer = 0; }

        if(npc.grabCooldown > 0) npc.grabCooldown--;
        else {
            // Se chegar bem perto de algum jogador, segura ele (só um por vez)
            let target = pList.find(p => !p.isDead && !p.isHidden && !p.heldByNpc && rectIntersect(p, npc));
            if(target) {
                npc.holdingId = target.id;
                npc.holdTimer = 60; // 2 segundos a 30fps
                target.heldByNpc = true;
                npcSay(NPC_HOLD_PHRASES[Math.floor(Math.random() * NPC_HOLD_PHRASES.length)]);
            }
        }
    }
    npc.prevX = npc.x; npc.prevY = npc.y;

    // Fala aleatória: enquanto segura alguém, usa as frases do aperto (mais
    // frequentes); andando solto, usa as frases de ambiente de sempre.
    if(npc.holdingId) {
        npc.speakCooldown--;
        if(npc.speakCooldown <= 0) {
            npcSay(NPC_HOLD_PHRASES[Math.floor(Math.random() * NPC_HOLD_PHRASES.length)]);
            npc.speakCooldown = 25; // ~0.8s — várias falas ao longo dos 2s do aperto
        }
    } else {
        npc.speakCooldown--;
        if(npc.speakCooldown <= 0) {
            npcSay(NPC_PHRASES[Math.floor(Math.random() * NPC_PHRASES.length)]);
            npc.speakCooldown = 150;
        }
    }
    if(npc.speechTimer > 0) npc.speechTimer--;

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
        if(boss.state !== 'CHASE') { io.emit('audioPlay', 'bossSpot'); bossSay("Te achei, nó cego!"); }
        boss.state = 'CHASE'; boss.targetId = closestP.id;
    } else if(boss.state === 'CHASE') { boss.state = 'SEARCH'; boss.targetId = null; }

    pList.forEach(p => {
        if(!p.isDead && !p.isHidden && rectIntersect(p, boss)) {
            p.isDead = true; p.isHidden = false; bossSay("Te peguei, nó cego!"); io.emit('playerCaught', { id: p.id, name: p.name }); checkEndGameCondition();
        }
    });

    io.emit('syncState', { players: players, boss: boss, npc: npc, gameManager: gameManager, mapExit: map.exit, time: Math.floor((Date.now() - startTime) / 1000) });

}, 1000 / 30);

server.listen(3000, () => console.log(`Servidor rodando na porta 3000`));
