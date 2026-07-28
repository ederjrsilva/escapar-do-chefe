const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Listar fotos disponíveis na pasta de avatares
const photosDir = path.join(__dirname, 'public', 'fotos');
let availablePhotos = [];
if (fs.existsSync(photosDir)) {
    availablePhotos = fs.readdirSync(photosDir).filter(file => /\.(png|jpg|jpeg|gif)$/i.test(file));
}

let players = {};
let gameStarted = false;

const spawnPoint = { x: 100, y: 100 };
const bossSpawn = { x: 400, y: 400 };

let boss = {
    x: bossSpawn.x,
    y: bossSpawn.y,
    w: 32,
    h: 32,
    state: 'PATROL',
    angle: 0,
    speechTimer: 0,
    speechText: ''
};

let gameManager = {
    objectivesCollected: 0,
    totalObjectives: 20,
    globalEvent: null,
    activeItem: { x: 300, y: 300, w: 20, h: 20, color: '#facc15' }
};

let staticMap = {
    w: 2000,
    h: 2000,
    walls: [
        { x: 0, y: 0, w: 2000, h: 50 },
        { x: 0, y: 1950, w: 2000, h: 50 },
        { x: 0, y: 0, w: 50, h: 2000 },
        { x: 1950, y: 0, w: 50, h: 2000 }
    ],
    exit: { x: 1800, y: 1800, w: 100, h: 100 }
};

function respawnMapItems() {
    gameManager.objectivesCollected = 0;
    gameManager.activeItem = {
        x: Math.floor(Math.random() * 1500) + 200,
        y: Math.floor(Math.random() * 1500) + 200,
        w: 20,
        h: 20,
        color: '#facc15'
    };
}

function resetGameFully() {
    gameStarted = false;
    gameManager.objectivesCollected = 0;
    gameManager.globalEvent = null;

    // Reseta o estado completo de todos os jogadores para o lobby
    for (let id in players) {
        players[id].isDead = false;
        players[id].ready = false;
        players[id].stamina = 100;
        players[id].noise = 0;
        players[id].isHidden = false;
        players[id].x = spawnPoint.x + Math.random() * 50;
        players[id].y = spawnPoint.y + Math.random() * 50;
    }

    // Reseta o chefe
    boss.x = bossSpawn.x;
    boss.y = bossSpawn.y;
    boss.state = 'PATROL';
    boss.speechTimer = 0;

    respawnMapItems();

    // Envia o sinal para todos os clientes voltarem ao lobby do zero
    io.emit('resetToLobby');
}

io.on('connection', (socket) => {
    console.log(`Jogador conectado: ${socket.id}`);

    players[socket.id] = {
        id: socket.id,
        name: `Jogador_${socket.id.substring(0, 4)}`,
        color: '#' + Math.floor(Math.random()*16777215).toString(16),
        avatar: null,
        ready: false,
        x: spawnPoint.x,
        y: spawnPoint.y,
        w: 28,
        h: 28,
        stamina: 100,
        noise: 0,
        isDead: false,
        isHidden: false,
        inputs: {}
    };

    socket.emit('photoList', availablePhotos);
    socket.emit('lobbyUpdate', Object.values(players));

    socket.on('updateAvatar', (photoName) => {
        if (players[socket.id]) {
            players[socket.id].avatar = photoName;
            io.emit('lobbyUpdate', Object.values(players));
        }
    });

    socket.on('setReady', (isReady) => {
        if (players[socket.id] && players[socket.id].avatar) {
            players[socket.id].ready = isReady;
            io.emit('lobbyUpdate', Object.values(players));

            const playersArray = Object.values(players);
            if (playersArray.length > 0 && playersArray.every(p => p.ready)) {
                gameStarted = true;
                io.emit('gameStart', staticMap);
            }
        }
    });

    socket.on('input', (keys) => {
        if (players[socket.id]) {
            players[socket.id].inputs = keys;
        }
    });

    socket.on('action', (actionType) => {
        let p = players[socket.id];
        if (!p || p.isDead) return;

        if (actionType === 'INTERACT') {
            let dist = Math.hypot(p.x - gameManager.activeItem.x, p.y - gameManager.activeItem.y);
            if (dist < 50) {
                gameManager.objectivesCollected++;
                io.emit('audioPlay', 'item');
                if (gameManager.objectivesCollected >= gameManager.totalObjectives) {
                    io.emit('gameOver', { won: true, msg: 'Vocês conseguiram coletar todos os itens e fugir!' });
                    setTimeout(() => resetGameFully(), 4000);
                } else {
                    respawnMapItems();
                }
            }
        }
    });

    socket.on('disconnect', () => {
        console.log(`Jogador desconectado: ${socket.id}`);
        delete players[socket.id];
        io.emit('lobbyUpdate', Object.values(players));

        const playersArray = Object.values(players);
        if (playersArray.length === 0) {
            gameStarted = false;
        }
    });
});

// Loop principal do servidor
setInterval(() => {
    if (!gameStarted) return;

    const playersArray = Object.values(players);
    const activePlayers = playersArray.filter(p => !p.isDead);

    // Verificação rigorosa: Se a partida está rolando e não restou nenhum sobrevivente vivo
    if (gameStarted && playersArray.length > 0 && activePlayers.length === 0) {
        io.emit('gameOver', { won: false, msg: 'Todos os jogadores foram capturados!' });
        setTimeout(() => {
            resetGameFully();
        }, 3000);
        return;
    }

    // Sincroniza o estado atual do jogo com os clientes
    io.emit('syncState', {
        players,
        boss,
        gameManager,
        time: Math.floor(Date.now() / 1000) % 600
    });
}, 50);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
