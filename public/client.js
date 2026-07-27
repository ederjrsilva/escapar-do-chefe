const socket = io();
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const minimapCanvas = document.getElementById('minimapCanvas');
const mmCtx = minimapCanvas.getContext('2d');

let gameState = 'LOBBY';
let staticMap = null;
let syncData = null;
let myId = null;

// Câmera Dinâmica
let camera = { x: 0, y: 0 };

const AudioSys = {
    ctx: new (window.AudioContext || window.webkitAudioContext)(),
    playTone(freq, type, duration, vol=0.1) {
        if(this.ctx.state === 'suspended') this.ctx.resume();
        const osc = this.ctx.createOscillator(); const gain = this.ctx.createGain();
        osc.type = type; osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
        gain.gain.setValueAtTime(vol, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + duration);
        osc.connect(gain); gain.connect(this.ctx.destination);
        osc.start(); osc.stop(this.ctx.currentTime + duration);
    },
    bossSpot() { this.playTone(150, 'sawtooth', 0.8, 0.3); },
    item() { this.playTone(900, 'sine', 0.2, 0.1); this.playTone(1200, 'sine', 0.3, 0.1); },
    heartbeat() { 
        this.playTone(60, 'sine', 0.1, 0.4); 
        setTimeout(() => this.playTone(60, 'sine', 0.2, 0.4), 200); 
    }
};

let lastHeartbeat = 0;

const keys = { up: false, down: false, left: false, right: false, run: false, sneak: false };
window.addEventListener('keydown', (e) => {
    let key = e.code; let updated = false;
    if(key === 'KeyW' || key === 'ArrowUp') { keys.up = true; updated = true; }
    if(key === 'KeyS' || key === 'ArrowDown') { keys.down = true; updated = true; }
    if(key === 'KeyA' || key === 'ArrowLeft') { keys.left = true; updated = true; }
    if(key === 'KeyD' || key === 'ArrowRight') { keys.right = true; updated = true; }
    if(key === 'ShiftLeft' || key === 'ShiftRight') { keys.run = true; updated = true; }
    if(key === 'ControlLeft' || key === 'KeyC') { keys.sneak = true; updated = true; } // Botão de furtividade
    
    if(key === 'Space' && gameState === 'PLAYING') socket.emit('action', 'HIDE');
    if(key === 'KeyE' && gameState === 'PLAYING') socket.emit('action', 'INTERACT');

    if(updated && gameState === 'PLAYING') socket.emit('input', keys);
});
window.addEventListener('keyup', (e) => {
    let key = e.code; let updated = false;
    if(key === 'KeyW' || key === 'ArrowUp') { keys.up = false; updated = true; }
    if(key === 'KeyS' || key === 'ArrowDown') { keys.down = false; updated = true; }
    if(key === 'KeyA' || key === 'ArrowLeft') { keys.left = false; updated = true; }
    if(key === 'KeyD' || key === 'ArrowRight') { keys.right = false; updated = true; }
    if(key === 'ShiftLeft' || key === 'ShiftRight') { keys.run = false; updated = true; }
    if(key === 'ControlLeft' || key === 'KeyC') { keys.sneak = false; updated = true; }
    
    if(updated && gameState === 'PLAYING') socket.emit('input', keys);
});

socket.on('connect', () => { myId = socket.id; });

socket.on('lobbyUpdate', (playersArray) => {
    const grid = document.getElementById('lobby-grid');
    grid.innerHTML = '';
    playersArray.forEach(p => {
        let isMe = p.id === myId;
        let card = document.createElement('div');
        card.className = `player-card ${p.ready ? 'ready' : ''} ${isMe ? 'me' : ''}`;
        card.innerHTML = `<h3>${p.name}</h3><div style="width:40px;height:40px;border-radius:50%;background:${p.color};margin:10px auto;"></div><p>${p.ready ? 'Pronto ✓' : 'Aguardando...'}</p>`;
        if(isMe && !p.ready) {
            let btn = document.createElement('button'); btn.innerText = "Estou Pronto!";
            btn.onclick = () => { AudioSys.ctx.resume(); socket.emit('setReady', true); };
            card.appendChild(btn);
        }
        grid.appendChild(card);
    });
    document.getElementById('btn-start').innerText = (playersArray.length > 0 && playersArray.every(p => p.ready)) ? "Iniciando..." : "Aguardando todos ficarem Prontos...";
});

socket.on('gameStart', (mapData) => {
    gameState = 'PLAYING'; staticMap = mapData;
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('hud').classList.remove('hidden');
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    requestAnimationFrame(renderLoop);
});

function resizeCanvas() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }

socket.on('syncState', (state) => { syncData = state; updateHUD(); });

socket.on('bossAlert', (msg) => {
    let alertDiv = document.getElementById('hud-alert');
    document.getElementById('alert-text').innerText = msg; alertDiv.classList.remove('hidden');
    setTimeout(() => { alertDiv.classList.add('hidden'); }, 4000);
});

socket.on('playerCaught', (data) => {
    if (data.id === myId) document.getElementById('alert-text').innerText = "VOCÊ FOI PEGO! Assista aos outros.";
});

socket.on('audioPlay', (snd) => { if(AudioSys[snd]) AudioSys[snd](); });

socket.on('gameOver', (data) => {
    gameState = 'GAMEOVER'; document.getElementById('hud').classList.add('hidden');
    document.getElementById('game-over').classList.add('active');
    document.getElementById('end-title').innerText = data.won ? "SUCESSO!" : "FIM DE JOGO";
    document.getElementById('end-title').style.color = data.won ? "#4caf50" : "#ff5252";
    document.getElementById('end-msg').innerText = data.msg;
});

function updateHUD() {
    if(!syncData || !syncData.players[myId]) return;
    let me = syncData.players[myId];
    
    // Atualiza Barras
    document.getElementById('stamina-fill').style.width = `${me.stamina}%`;
    document.getElementById('noise-fill').style.width = `${me.noise}%`;
    
    // Atualiza Objetivos e Tempo
    let min = String(Math.floor(syncData.time / 60)).padStart(2, '0');
    let sec = String(syncData.time % 60).padStart(2, '0');
    document.getElementById('hud-time').innerText = `Tempo: ${min}:${sec}`;
    
    let gm = syncData.gameManager;
    if(gm.currentObjectiveIndex < gm.objectivesList.length) {
        let obj = gm.objectivesList[gm.currentObjectiveIndex];
        document.getElementById('objective-text').innerText = `${obj.name}\n(Setor: Procure no mapa)`;
    } else {
        document.getElementById('objective-text').innerText = "FUJA PELA SAÍDA AGORA!";
        document.getElementById('objective-text').style.color = "#4caf50";
    }

    // Sobreviventes
    let alive = Object.values(syncData.players).filter(p => !p.isDead).length;
    document.getElementById('alive-count').innerText = alive;
}

function renderLoop() {
    if(gameState !== 'PLAYING' || !syncData) return;
    
    let me = syncData.players[myId];
    if(me && !me.isDead) {
        // Câmera segue o jogador suavemente
        camera.x += (me.x - canvas.width/2 - camera.x) * 0.1;
        camera.y += (me.y - canvas.height/2 - camera.y) * 0.1;
    }
    
    // Limita a câmera ao mapa
    camera.x = Math.max(0, Math.min(camera.x, staticMap.w - canvas.width));
    camera.y = Math.max(0, Math.min(camera.y, staticMap.h - canvas.height));

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Inicia desenho do mundo com offset da câmera
    ctx.save();
    ctx.translate(-camera.x, -camera.y);

    drawMap();
    
    // Item Objetivo Atual
    if(syncData.gameManager.activeItem) {
        let itm = syncData.gameManager.activeItem;
        ctx.fillStyle = itm.color; ctx.beginPath();
        ctx.arc(itm.x + itm.w/2, itm.y + itm.h/2, itm.w/2, 0, Math.PI*2); ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
    }

    // Entidades
    let entities = [ ...Object.values(syncData.players).filter(p => !p.isDead), syncData.boss ].sort((a,b) => a.y - b.y);
    entities.forEach(e => { if(e.hasOwnProperty('stamina')) drawPlayer(e); else drawBoss(e); });

    ctx.restore(); // Fim do desenho do mundo
    
    // Sistema de Iluminação Dinâmica (Filtro por cima da tela inteira)
    drawLighting(me);
    
    // Tensão Sonora (Batimentos Cardíacos)
    if(me && !me.isDead) {
        let distToBoss = Math.hypot(syncData.boss.x - me.x, syncData.boss.y - me.y);
        if(distToBoss < 400) {
            let heartbeatInterval = Math.max(300, distToBoss * 1.5);
            if(Date.now() - lastHeartbeat > heartbeatInterval) {
                AudioSys.heartbeat(); lastHeartbeat = Date.now();
                // Efeito visual de pulso na tela (borda vermelha)
                ctx.fillStyle = `rgba(239, 68, 68, ${0.4 - (distToBoss/1000)})`;
                ctx.fillRect(0, 0, canvas.width, canvas.height);
            }
        }
    }

    drawMinimap();
    requestAnimationFrame(renderLoop);
}

function drawMap() {
    // Chão do Hospital
    ctx.fillStyle = '#cbd5e1'; ctx.fillRect(0, 0, staticMap.w, staticMap.h);
    
    // Zonas / Setores
    staticMap.zones.forEach(z => {
        ctx.fillStyle = 'rgba(255,255,255,0.2)'; ctx.fillRect(z.x, z.y, z.w, z.h);
        ctx.fillStyle = '#94a3b8'; ctx.font = 'bold 32px Roboto'; ctx.textAlign = 'center';
        ctx.fillText(z.name, z.x + z.w/2, z.y + z.h/2); ctx.textAlign = 'left';
    });

    // Esconderijos (Armários de Hospital)
    staticMap.hidingSpots.forEach(s => {
        ctx.fillStyle = '#64748b'; ctx.fillRect(s.x, s.y, s.w, s.h);
        ctx.fillStyle = '#94a3b8'; ctx.fillRect(s.x + 5, s.y + 5, s.w - 10, s.h - 10);
    });

    // Saída
    let exitLocked = syncData.gameManager.currentObjectiveIndex < syncData.gameManager.objectivesList.length;
    ctx.fillStyle = exitLocked ? '#dc2626' : '#22c55e';
    ctx.fillRect(staticMap.exit.x, staticMap.exit.y, staticMap.exit.w, staticMap.exit.h);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 16px Roboto'; ctx.fillText("SAÍDA", staticMap.exit.x + 25, staticMap.exit.y - 5);

    // Paredes
    staticMap.walls.forEach(w => {
        ctx.fillStyle = '#0f172a'; ctx.fillRect(w.x, w.y, w.w, w.h); // Parede base escurecida
    });
}

function drawLighting(me) {
    // Cria uma máscara preta sobre a tela
    let isBlackout = syncData.gameManager.globalEvent === 'BLACKOUT';
    ctx.fillStyle = isBlackout ? 'rgba(0, 0, 0, 0.95)' : 'rgba(15, 23, 42, 0.7)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    ctx.globalCompositeOperation = 'destination-out';
    
    // Luz ao redor do próprio jogador
    if(me && !me.isDead) {
        let gradient = ctx.createRadialGradient(me.x - camera.x + me.w/2, me.y - camera.y + me.h/2, 0, me.x - camera.x + me.w/2, me.y - camera.y + me.h/2, isBlackout ? 150 : 350);
        gradient.addColorStop(0, 'rgba(255,255,255,1)');
        gradient.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = gradient;
        ctx.beginPath(); ctx.arc(me.x - camera.x + me.w/2, me.y - camera.y + me.h/2, isBlackout ? 150 : 350, 0, Math.PI*2); ctx.fill();
    }

    // Luz menor ao redor do chefe (como se ele tivesse uma lanterna fraca)
    let b = syncData.boss;
    let bGradient = ctx.createRadialGradient(b.x - camera.x + b.w/2, b.y - camera.y + b.h/2, 0, b.x - camera.x + b.w/2, b.y - camera.y + b.h/2, 200);
    bGradient.addColorStop(0, 'rgba(255,255,255,0.5)');
    bGradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = bGradient;
    ctx.beginPath(); ctx.arc(b.x - camera.x + b.w/2, b.y - camera.y + b.h/2, 200, 0, Math.PI*2); ctx.fill();

    ctx.globalCompositeOperation = 'source-over';
}

function drawPlayer(p) {
    if(p.isHidden) return;
    let cx = p.x + p.w/2; let cy = p.y + p.h/2;
    ctx.fillStyle = p.inputs.sneak ? 'rgba(0,0,0,0.5)' : p.color; // Fica escuro se furtivo
    ctx.beginPath(); ctx.arc(cx, cy, 15, 0, Math.PI*2); ctx.fill();
    if(p.id === myId) {
        ctx.fillStyle = '#fff'; ctx.font = '10px Roboto'; ctx.fillText("VOCÊ", cx - 12, cy - 20);
    }
}

function drawBoss(b) {
    let cx = b.x + b.w/2; let cy = b.y + b.h/2;
    // Cone de visão (lanterna do chefe) - Desenhado ANTES da sombra base pra brilhar um pouco
    ctx.fillStyle = b.state === 'CHASE' ? 'rgba(239, 68, 68, 0.4)' : 'rgba(234, 179, 8, 0.4)';
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, syncData.gameManager.globalEvent==='BLACKOUT'?200:500, b.angle - Math.PI/5, b.angle + Math.PI/5); ctx.lineTo(cx, cy); ctx.fill();
    
    ctx.fillStyle = '#1e293b'; ctx.beginPath(); ctx.arc(cx, cy, 20, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#ef4444'; ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI*2); ctx.fill();
}

function drawMinimap() {
    mmCtx.clearRect(0, 0, 150, 150);
    let scaleX = 150 / staticMap.w; let scaleY = 150 / staticMap.h;
    
    // Paredes no minimapa
    mmCtx.fillStyle = '#94a3b8';
    staticMap.walls.forEach(w => mmCtx.fillRect(w.x * scaleX, w.y * scaleY, w.w * scaleX, w.h * scaleY));
    
    // Jogador atual
    let me = syncData.players[myId];
    if(me && !me.isDead && !me.isHidden) {
        mmCtx.fillStyle = '#38bdf8';
        mmCtx.beginPath(); mmCtx.arc(me.x * scaleX, me.y * scaleY, 3, 0, Math.PI*2); mmCtx.fill();
    }
}
