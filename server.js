const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Rede de segurança: se algo inesperado der errado em qualquer lugar, loga o
// erro mas NÃO derruba o processo. Antes, qualquer exceção não tratada matava
// o servidor inteiro, e todo mundo via tela preta / erro 503 até alguém (ou
// o gerenciador do processo) reiniciar na mão.
process.on('uncaughtException', (err) => {
    console.error('[uncaughtException] erro inesperado, servidor continua rodando:', err);
});
process.on('unhandledRejection', (err) => {
    console.error('[unhandledRejection] promise sem tratamento, servidor continua rodando:', err);
});

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
        // Parede A (RECEPÇÃO | FARMÁCIA) — com abertura
        {x: 700, y: 100, w: 20, h: 165}, {x: 700, y: 365, w: 20, h: 135},
        // Parede B (FARMÁCIA/RECEPÇÃO | LABORATÓRIO) — com abertura
        {x: 1220, y: 100, w: 20, h: 265}, {x: 1220, y: 465, w: 20, h: 235},
        // Parede C (RECEPÇÃO | RH & COMPRAS) — com abertura
        {x: 100, y: 520, w: 155, h: 20}, {x: 355, y: 520, w: 145, h: 20},
        // Parede D (topo | meio) — duas aberturas
        {x: 600, y: 520, w: 325, h: 20}, {x: 1025, y: 520, w: 360, h: 20}, {x: 1485, y: 520, w: 315, h: 20},
        // Parede E (RH & COMPRAS | RADIOLOGIA) — com abertura
        {x: 620, y: 600, w: 20, h: 195}, {x: 620, y: 895, w: 20, h: 205},
        // Parede F (RADIOLOGIA | ALMOXARIFADO, trecho superior) — com abertura
        {x: 1220, y: 800, w: 20, h: 85}, {x: 1220, y: 985, w: 20, h: 115},
        // Parede G (meio | baixo) — duas aberturas
        {x: 100, y: 1120, w: 500, h: 20}, {x: 700, y: 1120, w: 500, h: 20}, {x: 1300, y: 1120, w: 500, h: 20},
        // Parede H (REFEITÓRIO | ALMOXARIFADO) — com abertura
        {x: 920, y: 1140, w: 20, h: 215}, {x: 920, y: 1455, w: 20, h: 245}
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

// Pontos usados pra navegação do chefe: centro de cada setor + centro de cada
// abertura/porta do mapa. Servem tanto pra ele explorar tudo aleatoriamente
// (PATROL) quanto pra achar o caminho até uma abertura quando alguém está
// bloqueado por uma parede (CHASE/SEARCH).
const ROOM_CENTERS = [
    {x: 400, y: 300}, {x: 1000, y: 300}, {x: 1550, y: 400}, {x: 1700, y: 250}, {x: 350, y: 850},
    {x: 950, y: 850}, {x: 500, y: 1450}, {x: 1400, y: 1450}, {x: 1700, y: 1450}
];
const PASSAGES = [
    {x: 710, y: 315}, {x: 1230, y: 415}, {x: 305, y: 530}, {x: 975, y: 530}, {x: 1435, y: 530},
    {x: 630, y: 845}, {x: 1230, y: 935}, {x: 650, y: 1130}, {x: 1250, y: 1130}, {x: 930, y: 1405},
    {x: 760, y: 300}, {x: 1270, y: 400}
];
const PATROL_POINTS = [...ROOM_CENTERS, ...PASSAGES];

// Testa se o segmento de reta (x1,y1)-(x2,y2) cruza o retângulo `rect` de verdade
// (Liang-Barsky) — precisa ser preciso pra achar aberturas corretamente, uma
// simples comparação de caixas delimitadoras erra demais em segmentos longos.
function segmentHitsRect(x1, y1, x2, y2, rect) {
    let dx = x2 - x1, dy = y2 - y1;
    let p = [-dx, dx, -dy, dy];
    let q = [x1 - rect.x, rect.x + rect.w - x1, y1 - rect.y, rect.y + rect.h - y1];
    let u1 = 0, u2 = 1;
    for (let i = 0; i < 4; i++) {
        if (p[i] === 0) {
            if (q[i] < 0) return false;
        } else {
            let t = q[i] / p[i];
            if (p[i] < 0) { if (t > u2) return false; if (t > u1) u1 = t; }
            else { if (t < u1) return false; if (t < u2) u2 = t; }
        }
    }
    return true;
}

// Checa se dá pra "ver" (linha reta) de um ponto a outro sem nenhuma parede no meio
function hasClearPath(x1, y1, x2, y2) {
    for (let i = 0; i < map.walls.length; i++) {
        if (segmentHitsRect(x1, y1, x2, y2, map.walls[i])) return false;
    }
    return true;
}

// Acha a melhor abertura pra ir até (toX,toY). Prioriza aberturas que, dali,
// já enxergam o alvo de verdade (senão o chefe podia escolher uma abertura
// "mais perto" só na conta, mas que continua sem visão do alvo depois de
// chegar lá, e ficava preso recalculando a mesma escolha ruim pra sempre).
function findBestPassage(fromX, fromY, toX, toY) {
    let bestClear = null, bestClearScore = Infinity;
    let bestAny = null, bestAnyScore = Infinity;
    PASSAGES.forEach(p => {
        let score = dist(fromX, fromY, p.x, p.y) + dist(p.x, p.y, toX, toY);
        if (score < bestAnyScore) { bestAnyScore = score; bestAny = p; }
        if (hasClearPath(p.x, p.y, toX, toY) && score < bestClearScore) { bestClearScore = score; bestClear = p; }
    });
    return bestClear || bestAny;
}

function pickRandomPatrolPoint(exclude) {
    let choices = PATROL_POINTS;
    if (exclude) choices = PATROL_POINTS.filter(p => dist(p.x, p.y, exclude.x, exclude.y) > 5);
    return choices[Math.floor(Math.random() * choices.length)];
}

let gameManager = { level: 1, globalEvent: 'NONE', eventTimer: 0, objectivesCollected: 0, totalObjectives: TOTAL_OBJECTIVES, activeItem: null, speakCooldown: 300 };

function createBoss() {
    return {
        x: MAP_W/2, y: MAP_H/2, w: 32, h: 32, state: 'PATROL', angle: 0, targetId: null, lastKnownPos: null,
        patrolTarget: null, navWaypoint: null, progressCheck: null,
        prevX: 0, prevY: 0, stuckTimer: 0, isMoving: false, speechText: null, speechTimer: 0, role: 'boss'
    };
}

let boss = createBoss();

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
        io.emit('bossAlert', `Colete os ${gameManager.totalObjectives} itens espalhados e fuja do chefe!`);
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
    boss = createBoss();
    npc.x = 1400; npc.y = 1450; npc.wpIndex = 0; npc.speechText = null; npc.speechTimer = 0; npc.speakCooldown = 150; npc.isMoving = false; npc.holdingId = null; npc.holdTimer = 0; npc.grabCooldown = 0;
    gameManager.level = 1; gameManager.globalEvent = 'NONE'; gameManager.eventTimer = 0;
    gameManager.objectivesCollected = 0; gameManager.activeItem = null; gameManager.speakCooldown = 300;
    // Reseta o "pronto" de todo mundo também — sem isso, o lobby ficava travado
    // em "Iniciando..." pra sempre depois de uma partida, pois todo mundo
    // continuava marcado como pronto sem ninguém apertar o botão de novo.
    // Também devolve cada jogador pra posição inicial de spawn — sem isso,
    // eles "nasciam" no ponto exato onde tinham sido pegos na partida anterior.
    let spawnIndex = 0;
    Object.values(players).forEach(p => {
        p.isDead = false; p.saved = false; p.isHidden = false; p.ready = false; p.heldByNpc = false;
        p.x = 200 + (spawnIndex * 50); p.y = 200;
        p.stamina = 100; p.noise = 0; p.isMoving = false;
        spawnIndex++;
    });
    io.emit('resetToLobby');
    io.emit('lobbyUpdate', Object.values(players));
}

setInterval(() => {
    try {
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
        // Exploração aleatória: em vez de girar sempre na mesma ordem por 7
        // pontos fixos, sorteia o próximo destino entre TODOS os setores e
        // aberturas do mapa — assim ele cobre o cenário inteiro com o tempo,
        // em vez de ficar preso rodando sempre pelo mesmo lado.
        if(!boss.patrolTarget || dist(boss.x, boss.y, boss.patrolTarget.x, boss.patrolTarget.y) < 20) {
            boss.patrolTarget = pickRandomPatrolPoint(boss.patrolTarget);
        }
        targetX = boss.patrolTarget.x; targetY = boss.patrolTarget.y;
    } 
    else if(boss.state === 'CHASE' && players[boss.targetId] && !players[boss.targetId].isDead) {
        let tgt = players[boss.targetId];
        boss.lastKnownPos = {x: tgt.x, y: tgt.y};
        if(hasClearPath(boss.x, boss.y, tgt.x, tgt.y)) {
            // Caminho livre até a pessoa: vai direto
            targetX = tgt.x; targetY = tgt.y; boss.navWaypoint = null;
        } else {
            // Tem parede no meio (ex: ele viu/ouviu alguém bem perto do outro
            // lado). Em vez de ficar empurrando a parede, mira na abertura
            // mais próxima que o aproxima da pessoa.
            boss.navWaypoint = findBestPassage(boss.x, boss.y, tgt.x, tgt.y);
            let via = boss.navWaypoint || tgt;
            targetX = via.x; targetY = via.y;
        }
    } 
    else if(boss.state === 'SEARCH') {
        if(boss.lastKnownPos) {
            let lp = boss.lastKnownPos;
            if(hasClearPath(boss.x, boss.y, lp.x, lp.y)) {
                targetX = lp.x; targetY = lp.y; boss.navWaypoint = null;
            } else {
                boss.navWaypoint = findBestPassage(boss.x, boss.y, lp.x, lp.y);
                let via = boss.navWaypoint || lp;
                targetX = via.x; targetY = via.y;
            }
            if(dist(boss.x, boss.y, lp.x, lp.y) < 20) { boss.state = 'PATROL'; boss.navWaypoint = null; }
        } else boss.state = 'PATROL';
    }

    let dx = targetX - boss.x; let dy = targetY - boss.y;
    let distToTarget = dist(boss.x, boss.y, targetX, targetY);
    if(distToTarget > 2) boss.angle = Math.atan2(dy, dx);

    // Nunca anda mais do que falta pro alvo — sem isso, quando ele fica bem
    // perto de um ponto (ex: o meio de uma abertura), cada passo ultrapassava
    // o alvo e ele ficava oscilando pra frente e pra trás no mesmo lugar.
    let moveDist = Math.min(speed, distToTarget);
    let nextX = boss.x + Math.cos(boss.angle) * moveDist; let nextY = boss.y + Math.sin(boss.angle) * moveDist;
    let hitX = false, hitY = false;
    map.walls.forEach(w => {
        if(rectIntersect({x: nextX, y: boss.y, w: boss.w, h: boss.h}, w)) hitX = true;
        if(rectIntersect({x: boss.x, y: nextY, w: boss.w, h: boss.h}, w)) hitY = true;
    });
    if(!hitX) boss.x = nextX; if(!hitY) boss.y = nextY;

    boss.isMoving = (Math.abs(boss.x - boss.prevX) > 0.5 || Math.abs(boss.y - boss.prevY) > 0.5);

    // SISTEMA ANTI-TRAVAMENTO (UNSTUCK)
    // Chegar bem em cima do alvo atual (distância ~0) e ficar parado ali por
    // um instante É normal — é só o momento em que ele vai recalcular o
    // próximo destino. Isso não conta como "travado".
    let arrivedAtTarget = distToTarget < 4;
    if (!boss.isMoving && !arrivedAtTarget) {
        boss.stuckTimer++;
        if (boss.stuckTimer > 15) { // Se ficar parado contra a parede por 0.5 seg
            boss.state = 'PATROL';
            boss.targetId = null;
            boss.navWaypoint = null;
            boss.patrolTarget = pickRandomPatrolPoint(boss.patrolTarget); // Muda a rota

            // Dá um leve empurrãozinho na direção do novo destino pra soltar do polígono
            let angleToWp = Math.atan2(boss.patrolTarget.y - boss.y, boss.patrolTarget.x - boss.x);
            boss.x += Math.cos(angleToWp) * 10;
            boss.y += Math.sin(angleToWp) * 10;
            
            boss.stuckTimer = 0;
        }
    } else {
        boss.stuckTimer = 0;
    }

    // Segunda rede de segurança: às vezes ele fica "deslizando" só num eixo
    // perto de uma quina (isMoving continua true porque tecnicamente se move
    // um pouco a cada frame), sem nunca conseguir de fato atravessar. A cada
    // 1,5s, checa se ele progrediu de verdade; se não, força uma nova rota.
    if (!boss.progressCheck) boss.progressCheck = { x: boss.x, y: boss.y, timer: 45 };
    boss.progressCheck.timer--;
    if (boss.progressCheck.timer <= 0) {
        if (dist(boss.x, boss.y, boss.progressCheck.x, boss.progressCheck.y) < 25) {
            boss.state = 'PATROL';
            boss.targetId = null;
            boss.navWaypoint = null;
            boss.patrolTarget = pickRandomPatrolPoint(boss.patrolTarget);
            let angleToWp = Math.atan2(boss.patrolTarget.y - boss.y, boss.patrolTarget.x - boss.x);
            boss.x += Math.cos(angleToWp) * 12;
            boss.y += Math.sin(angleToWp) * 12;
        }
        boss.progressCheck = { x: boss.x, y: boss.y, timer: 45 };
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
                isSeen = hasClearPath(boss.x, boss.y, p.x, p.y);
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

    } catch (err) {
        console.error('[game loop] erro num tick, esse frame foi ignorado mas o servidor continua rodando:', err);
    }
}, 1000 / 30);

server.listen(3000, () => console.log(`Servidor rodando na porta 3000`));
