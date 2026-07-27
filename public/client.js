const socket = io();
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const minimapCanvas = document.getElementById('minimapCanvas');
const mmCtx = minimapCanvas.getContext('2d');

let gameState = 'LOBBY';
let staticMap = null;
let syncData = null;
let myId = null;
let loopRunning = false;

const imageCache = {};
const animStates = {}; 
let availablePhotos = [];

let camera = { x: 0, y: 0 };

const AudioSys = {
    ctx: new (window.AudioContext || window.webkitAudioContext)(),
    playTone(f, t, d, v=0.1) {
        if(this.ctx.state === 'suspended') this.ctx.resume();
        const osc = this.ctx.createOscillator(); const gain = this.ctx.createGain();
        osc.type = t; osc.frequency.setValueAtTime(f, this.ctx.currentTime);
        gain.gain.setValueAtTime(v, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + d);
        osc.connect(gain); gain.connect(this.ctx.destination);
        osc.start(); osc.stop(this.ctx.currentTime + d);
    },
    bossSpot() { this.playTone(150, 'sawtooth', 0.8, 0.3); },
    item() { this.playTone(900, 'sine', 0.2, 0.1); this.playTone(1200, 'sine', 0.3, 0.1); },
    heartbeat() { this.playTone(60, 'sine', 0.1, 0.4); setTimeout(() => this.playTone(60, 'sine', 0.2, 0.4), 200); }
};
let lastHeartbeat = 0;

const keys = { up: false, down: false, left: false, right: false, run: false, sneak: false };
window.addEventListener('keydown', (e) => {
    if(['KeyW','ArrowUp','KeyS','ArrowDown','KeyA','ArrowLeft','KeyD','ArrowRight','ShiftLeft','ControlLeft','KeyC','Space','KeyE'].includes(e.code)){
        if(e.code==='KeyW'||e.code==='ArrowUp') keys.up = true; if(e.code==='KeyS'||e.code==='ArrowDown') keys.down = true;
        if(e.code==='KeyA'||e.code==='ArrowLeft') keys.left = true; if(e.code==='KeyD'||e.code==='ArrowRight') keys.right = true;
        if(e.code==='ShiftLeft') keys.run = true; if(e.code==='ControlLeft'||e.code==='KeyC') keys.sneak = true;
        if(e.code==='Space' && gameState === 'PLAYING') socket.emit('action', 'HIDE');
        if(e.code==='KeyE' && gameState === 'PLAYING') socket.emit('action', 'INTERACT');
        if(gameState === 'PLAYING') socket.emit('input', keys);
    }
});
window.addEventListener('keyup', (e) => {
    if(['KeyW','ArrowUp','KeyS','ArrowDown','KeyA','ArrowLeft','KeyD','ArrowRight','ShiftLeft','ControlLeft','KeyC'].includes(e.code)){
        if(e.code==='KeyW'||e.code==='ArrowUp') keys.up = false; if(e.code==='KeyS'||e.code==='ArrowDown') keys.down = false;
        if(e.code==='KeyA'||e.code==='ArrowLeft') keys.left = false; if(e.code==='KeyD'||e.code==='ArrowRight') keys.right = false;
        if(e.code==='ShiftLeft') keys.run = false; if(e.code==='ControlLeft'||e.code==='KeyC') keys.sneak = false;
        if(gameState === 'PLAYING') socket.emit('input', keys);
    }
});

socket.on('connect', () => { myId = socket.id; });

socket.on('photoList', (photos) => {
    availablePhotos = photos;
    let listDiv = document.getElementById('photo-list');
    listDiv.innerHTML = '';
    photos.forEach(foto => {
        if(!imageCache[foto]) { let img = new Image(); img.src = `/fotos/${foto}`; imageCache[foto] = img; }
        let imgEl = document.createElement('img');
        imgEl.src = `/fotos/${foto}`; imgEl.className = 'photo-option';
        imgEl.onclick = () => { socket.emit('updateAvatar', foto); document.getElementById('photo-modal').style.display = 'none'; };
        listDiv.appendChild(imgEl);
    });
});

function openPhotoModal() { document.getElementById('photo-modal').style.display = 'block'; }

socket.on('lobbyUpdate', (playersArray) => {
    // O servidor só emite isso quando está em estado LOBBY. Se o cliente ainda
    // achava que estava em PLAYING/GAMEOVER (ex: depois de um reinício do
    // servidor), força a volta pra tela de lobby em vez de ficar preso.
    if(gameState !== 'LOBBY') {
        gameState = 'LOBBY'; syncData = null; staticMap = null;
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        document.getElementById('lobby').classList.add('active');
        document.getElementById('hud').classList.add('hidden');
    }
    const grid = document.getElementById('lobby-grid'); grid.innerHTML = '';
    playersArray.forEach(p => {
        let isMe = p.id === myId;
        let card = document.createElement('div');
        card.className = `player-card ${p.ready ? 'ready' : ''} ${isMe ? 'me' : ''}`;
        
        let avatarHTML = p.avatar ? `<img src="/fotos/${p.avatar}" class="avatar-img" onclick="${isMe ? 'openPhotoModal()' : ''}">` : 
                                    `<div class="avatar-img" style="background:${p.color}; display:flex; align-items:center; justify-content:center; cursor:${isMe?'pointer':'default'};" onclick="${isMe ? 'openPhotoModal()' : ''}">${isMe?'📸':''}</div>`;
        
        card.innerHTML = `<h3>${p.name}</h3>${avatarHTML}<p>${p.ready ? 'Pronto ✓' : 'Aguardando...'}</p>`;
        if(isMe && !p.ready) {
            if(p.avatar) {
                let btn = document.createElement('button'); btn.innerText = "Estou Pronto!";
                btn.onclick = () => { AudioSys.ctx.resume(); socket.emit('setReady', true); };
                card.appendChild(btn);
            } else {
                let hint = document.createElement('p');
                hint.innerText = "Escolha uma foto para continuar 📸";
                hint.style.color = '#facc15'; hint.style.fontSize = '13px';
                card.appendChild(hint);
                let btn = document.createElement('button'); btn.innerText = "Escolher Foto";
                btn.onclick = () => openPhotoModal();
                card.appendChild(btn);
            }
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
    if(!resizeListenerAdded) { window.addEventListener('resize', resizeCanvas); resizeListenerAdded = true; }
    // Só inicia um novo loop de desenho se não houver um já rodando.
    // Sem essa checagem, um 'gameStart' que chega enquanto o loop anterior
    // ainda está de pé (ex: depois de reconectar após o servidor reiniciar)
    // cria um SEGUNDO loop rodando em paralelo, e cada um desenha sua
    // própria camada escura por cima da outra — a tela vai ficando cada
    // vez mais preta a cada "reinício".
    if(!loopRunning) { loopRunning = true; requestAnimationFrame(renderLoop); }
});

socket.on('resetToLobby', () => {
    gameState = 'LOBBY'; syncData = null; staticMap = null;
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('lobby').classList.add('active');
    document.getElementById('hud').classList.add('hidden');
});

const lightCanvas = document.createElement('canvas');
const lightCtx = lightCanvas.getContext('2d');

let resizeListenerAdded = false;
function resizeCanvas() {
    canvas.width = window.innerWidth; canvas.height = window.innerHeight;
    lightCanvas.width = window.innerWidth; lightCanvas.height = window.innerHeight;
}

socket.on('syncState', (state) => { syncData = state; updateHUD(); });

socket.on('bossAlert', (msg) => {
    let alertDiv = document.getElementById('hud-alert'); document.getElementById('alert-text').innerText = msg;
    alertDiv.classList.remove('hidden'); setTimeout(() => { alertDiv.classList.add('hidden'); }, 4000);
});

socket.on('audioPlay', (snd) => { if(AudioSys[snd]) AudioSys[snd](); });

socket.on('errorMsg', (msg) => { alert(msg); });

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
    document.getElementById('stamina-fill').style.width = `${me.stamina}%`; document.getElementById('noise-fill').style.width = `${me.noise}%`;
    let min = String(Math.floor(syncData.time / 60)).padStart(2, '0'); let sec = String(syncData.time % 60).padStart(2, '0');
    document.getElementById('hud-time').innerText = `Tempo: ${min}:${sec}`;
    let gm = syncData.gameManager;
    if(gm.currentObjectiveIndex < gm.objectivesList.length) {
        document.getElementById('objective-text').innerText = gm.objectivesList[gm.currentObjectiveIndex].name;
    } else { document.getElementById('objective-text').innerText = "FUJA PELA SAÍDA!"; document.getElementById('objective-text').style.color = "#4caf50"; }
    document.getElementById('alive-count').innerText = Object.values(syncData.players).filter(p => !p.isDead).length;
}

function renderLoop() {
    if(gameState !== 'PLAYING') { loopRunning = false; return; }
    if(!syncData) { requestAnimationFrame(renderLoop); return; }
    
    let me = syncData.players[myId];
    if(me && !me.isDead) {
        camera.x = (me.x + me.w/2) - canvas.width/2;
        camera.y = (me.y + me.h/2) - canvas.height/2;
    }
    
    camera.x = Math.max(0, Math.min(camera.x, staticMap.w - canvas.width));
    camera.y = Math.max(0, Math.min(camera.y, staticMap.h - canvas.height));

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save(); ctx.translate(-camera.x, -camera.y);

    drawMap();
    
    if(syncData.gameManager.activeItem) {
        let itm = syncData.gameManager.activeItem;
        ctx.fillStyle = itm.color; ctx.beginPath(); ctx.arc(itm.x + itm.w/2, itm.y + itm.h/2, itm.w/2, 0, Math.PI*2); ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
    }

    let entities = [ ...Object.values(syncData.players).filter(p => !p.isDead), syncData.boss ].sort((a,b) => a.y - b.y);
    entities.forEach(e => { if(e.hasOwnProperty('stamina')) drawStickmanPlayer(e); else drawBossMan(e); });

    ctx.restore(); 
    
    drawLighting(me); // Sistema de sombras avançado com recortes perfeitos
    
    if(me && !me.isDead) {
        let distToBoss = Math.hypot(syncData.boss.x - me.x, syncData.boss.y - me.y);
        if(distToBoss < 400) {
            let heartbeatInterval = Math.max(300, distToBoss * 1.5);
            if(Date.now() - lastHeartbeat > heartbeatInterval) {
                AudioSys.heartbeat(); lastHeartbeat = Date.now();
                ctx.fillStyle = `rgba(239, 68, 68, ${0.4 - (distToBoss/1000)})`; ctx.fillRect(0, 0, canvas.width, canvas.height);
            }
        }
    }
    drawMinimap();
    requestAnimationFrame(renderLoop);
}

function drawMap() {
    ctx.fillStyle = '#cbd5e1'; ctx.fillRect(0, 0, staticMap.w, staticMap.h);
    staticMap.zones.forEach(z => {
        ctx.fillStyle = 'rgba(255,255,255,0.2)'; ctx.fillRect(z.x, z.y, z.w, z.h);
        ctx.fillStyle = '#94a3b8'; ctx.font = 'bold 32px Roboto'; ctx.textAlign = 'center';
        ctx.fillText(z.name, z.x + z.w/2, z.y + z.h/2); ctx.textAlign = 'left';
    });
    staticMap.hidingSpots.forEach(s => { ctx.fillStyle = '#64748b'; ctx.fillRect(s.x, s.y, s.w, s.h); });
    let exitLocked = syncData.gameManager.currentObjectiveIndex < syncData.gameManager.objectivesList.length;
    ctx.fillStyle = exitLocked ? '#dc2626' : '#22c55e'; ctx.fillRect(staticMap.exit.x, staticMap.exit.y, staticMap.exit.w, staticMap.exit.h);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 16px Roboto'; ctx.fillText("SAÍDA", staticMap.exit.x + 25, staticMap.exit.y - 5);
    staticMap.walls.forEach(w => { ctx.fillStyle = '#0f172a'; ctx.fillRect(w.x, w.y, w.w, w.h); });
}

function drawStickmanPlayer(p) {
    if(p.isHidden) return;
    let cx = p.x + p.w/2; let cy = p.y + p.h; 
    
    if(!animStates[p.id]) animStates[p.id] = { cycle: 0 };
    if(p.isMoving) animStates[p.id].cycle += p.inputs.run ? 0.4 : 0.2;
    else animStates[p.id].cycle = 0;
    
    let legSwing = Math.sin(animStates[p.id].cycle) * 12;

    ctx.save();
    // Ao agachar (Sneak) o personagem fica transparente em vez de ficar cinza escuro invisível
    if (p.inputs.sneak) ctx.globalAlpha = 0.4; 

    ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.ellipse(cx, cy, 14, 6, 0, 0, Math.PI*2); ctx.fill();

    ctx.strokeStyle = p.color; // SEMPRE usa a cor neon radiante do player
    ctx.lineWidth = 6; ctx.lineCap = 'round';

    ctx.beginPath(); ctx.moveTo(cx, cy - 15); ctx.lineTo(cx - 5 + legSwing, cy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, cy - 15); ctx.lineTo(cx + 5 - legSwing, cy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, cy - 35); ctx.lineTo(cx, cy - 15); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, cy - 30); ctx.lineTo(cx - 10 - legSwing, cy - 15); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, cy - 30); ctx.lineTo(cx + 10 + legSwing, cy - 15); ctx.stroke();

    let headY = cy - 45;
    let img = p.avatar ? imageCache[p.avatar] : null;
    
    if(img && img.complete && img.naturalWidth > 0) {
        ctx.save();
        ctx.beginPath(); ctx.arc(cx, headY, 14, 0, Math.PI*2); ctx.clip();
        
        // CORREÇÃO DA FOTO: Aplica um object-fit cover perfeito recortando o centro da foto
        let size = Math.min(img.naturalWidth, img.naturalHeight);
        let sx = (img.naturalWidth - size) / 2;
        let sy = (img.naturalHeight - size) / 2;
        ctx.drawImage(img, sx, sy, size, size, cx - 14, headY - 14, 28, 28);
        
        ctx.restore();
        
        ctx.strokeStyle = p.color; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx, headY, 14, 0, Math.PI*2); ctx.stroke();
    } else {
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(cx, headY, 12, 0, Math.PI*2); ctx.fill();
    }
    ctx.restore(); 
    
    if(p.id === myId) {
        ctx.fillStyle = '#fff'; ctx.font = '12px Roboto'; ctx.textAlign = 'center';
        ctx.fillText("VOCÊ", cx, headY - 20); ctx.textAlign = 'left';
    }
}

function drawBossMan(b) {
    let cx = b.x + b.w/2; let cy = b.y + b.h; 
    
    if(!animStates['boss']) animStates['boss'] = { cycle: 0 };
    if(b.isMoving) animStates['boss'].cycle += b.state === 'CHASE' ? 0.5 : 0.2;
    else animStates['boss'].cycle = 0;
    
    let legSwing = Math.sin(animStates['boss'].cycle) * 12;

    ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.beginPath(); ctx.ellipse(cx, cy, 16, 7, 0, 0, Math.PI*2); ctx.fill();

    // Roupa (Corpo) - Clareada para Azul Acinzentado (#475569) em vez de quase preto para ficar bem visível
    ctx.strokeStyle = '#475569'; ctx.lineWidth = 8; ctx.lineCap = 'round';
    
    ctx.beginPath(); ctx.moveTo(cx, cy - 15); ctx.lineTo(cx - 5 + legSwing, cy); ctx.stroke(); 
    ctx.beginPath(); ctx.moveTo(cx, cy - 15); ctx.lineTo(cx + 5 - legSwing, cy); ctx.stroke(); 
    ctx.beginPath(); ctx.moveTo(cx, cy - 35); ctx.quadraticCurveTo(cx - 5, cy - 25, cx, cy - 15); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, cy - 32); ctx.lineTo(cx - 15, cy - 25 - legSwing); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, cy - 32); ctx.lineTo(cx + 15, cy - 25 + legSwing); ctx.stroke();

    let headY = cy - 45;
    ctx.fillStyle = '#fca5a5'; 
    ctx.beginPath(); ctx.arc(cx, headY, 12, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#d1d5db';
    ctx.beginPath(); ctx.arc(cx - 11, headY, 5, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + 11, headY, 5, 0, Math.PI*2); ctx.fill();
    
    ctx.fillStyle = '#ff0000'; // Olhos
    ctx.fillRect(cx - 7, headY - 3, 4, 3);
    ctx.fillRect(cx + 3, headY - 3, 4, 3);
    
    ctx.strokeStyle = '#000'; ctx.lineWidth = 2; // Sobrancelha
    ctx.beginPath(); ctx.moveTo(cx - 9, headY - 6); ctx.lineTo(cx - 3, headY - 4); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx + 9, headY - 6); ctx.lineTo(cx + 3, headY - 4); ctx.stroke();
}

function drawLighting(me) {
    let isBlackout = syncData.gameManager.globalEvent === 'BLACKOUT';

    // IMPORTANTE: a escuridão e os "furos" de luz são montados numa camada
    // separada (lightCanvas), NÃO diretamente em cima do jogo já desenhado.
    // Antes, o destination-out apagava pedaços dos próprios personagens
    // (por isso eles ficavam escuros/invisíveis perto de si mesmos ou do chefe).
    lightCtx.clearRect(0, 0, lightCanvas.width, lightCanvas.height);
    lightCtx.globalCompositeOperation = 'source-over';
    lightCtx.fillStyle = isBlackout ? 'rgba(0, 0, 0, 0.98)' : 'rgba(15, 23, 42, 0.8)';
    lightCtx.fillRect(0, 0, lightCanvas.width, lightCanvas.height);

    lightCtx.globalCompositeOperation = 'destination-out';

    // Fura a escuridão em cima do Jogador
    if(me && !me.isDead) {
        let cx = me.x - camera.x + me.w/2; let cy = me.y - camera.y + me.h/2;
        let grad = lightCtx.createRadialGradient(cx, cy, 0, cx, cy, isBlackout ? 150 : 350);
        grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
        lightCtx.fillStyle = grad; lightCtx.beginPath(); lightCtx.arc(cx, cy, isBlackout ? 150 : 350, 0, Math.PI*2); lightCtx.fill();
    }

    // Fura a escuridão em volta do Boss
    let b = syncData.boss;
    let bx = b.x - camera.x + b.w/2; let by = b.y - camera.y + b.h/2;
    let bGrad = lightCtx.createRadialGradient(bx, by, 0, bx, by, 150);
    bGrad.addColorStop(0, 'rgba(255,255,255,0.9)'); bGrad.addColorStop(1, 'rgba(255,255,255,0)');
    lightCtx.fillStyle = bGrad; lightCtx.beginPath(); lightCtx.arc(bx, by, 150, 0, Math.PI*2); lightCtx.fill();

    // A Lanterna do Boss corta a escuridão permitindo ver o mapa e personagens debaixo
    let coneLength = isBlackout ? 250 : 500;
    let coneGrad = lightCtx.createRadialGradient(bx, by, 20, bx, by, coneLength);
    coneGrad.addColorStop(0, 'rgba(255,255,255,0.9)'); coneGrad.addColorStop(1, 'rgba(255,255,255,0)');

    lightCtx.fillStyle = coneGrad;
    lightCtx.beginPath(); lightCtx.moveTo(bx, by);
    lightCtx.arc(bx, by, coneLength, b.angle - Math.PI/5, b.angle + Math.PI/5);
    lightCtx.lineTo(bx, by); lightCtx.fill();

    lightCtx.globalCompositeOperation = 'source-over';

    // Cola a camada de escuridão (já com os furos) por cima do jogo, sem apagar os sprites
    ctx.drawImage(lightCanvas, 0, 0);

    // Desenha uma lente colorida volumétrica bem leve por cima da lanterna do boss (Amarela ou Vermelha)
    ctx.fillStyle = b.state === 'CHASE' ? 'rgba(239, 68, 68, 0.15)' : 'rgba(234, 179, 8, 0.15)';
    ctx.beginPath(); ctx.moveTo(bx, by);
    ctx.arc(bx, by, coneLength, b.angle - Math.PI/5, b.angle + Math.PI/5);
    ctx.lineTo(bx, by); ctx.fill();
}

function drawMinimap() {
    mmCtx.clearRect(0, 0, 150, 150);
    let scaleX = 150 / staticMap.w; let scaleY = 150 / staticMap.h;
    mmCtx.fillStyle = '#94a3b8';
    staticMap.walls.forEach(w => mmCtx.fillRect(w.x * scaleX, w.y * scaleY, w.w * scaleX, w.h * scaleY));
    let me = syncData.players[myId];
    if(me && !me.isDead && !me.isHidden) {
        mmCtx.fillStyle = '#38bdf8'; mmCtx.beginPath(); mmCtx.arc(me.x * scaleX, me.y * scaleY, 3, 0, Math.PI*2); mmCtx.fill();
    }
}
