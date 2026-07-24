const socket = io();
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

let gameState = 'LOBBY';
let staticMap = null; // Recebe o mapa do servidor 1x
let syncData = null;  // Atualizações constantes
let myId = null;
let bossSpeechTimer = 0;

// Imagens cacheadas para não recarregar
const avatars = {}; 

// ==========================================
// ÁUDIO (Mesmo sistema, acionado por rede)
// ==========================================
const AudioSys = {
    ctx: new (window.AudioContext || window.webkitAudioContext)(),
    playTone(freq, type, duration, vol=0.1) {
        if(this.ctx.state === 'suspended') this.ctx.resume();
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = type; osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
        gain.gain.setValueAtTime(vol, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + duration);
        osc.connect(gain); gain.connect(this.ctx.destination);
        osc.start(); osc.stop(this.ctx.currentTime + duration);
    },
    footstep() { this.playTone(100, 'square', 0.05, 0.01); },
    alert() { this.playTone(800, 'sawtooth', 0.3, 0.2); this.playTone(600, 'sawtooth', 0.4, 0.2); },
    item() { this.playTone(1200, 'sine', 0.2, 0.1); },
    bossSpeak() {
        let count = 6;
        let playSyllable = () => {
            if (count <= 0) return;
            this.playTone(130 + Math.random() * 40, 'square', 0.1, 0.05);
            setTimeout(playSyllable, 80); count--;
        };
        playSyllable();
    }
};

// ==========================================
// CONTROLES UNIVERSAIS (W,A,S,D)
// ==========================================
const keys = { up: false, down: false, left: false, right: false, run: false };
window.addEventListener('keydown', (e) => {
    let key = e.code; let updated = false;
    if(key === 'KeyW' || key === 'ArrowUp') { keys.up = true; updated = true; }
    if(key === 'KeyS' || key === 'ArrowDown') { keys.down = true; updated = true; }
    if(key === 'KeyA' || key === 'ArrowLeft') { keys.left = true; updated = true; }
    if(key === 'KeyD' || key === 'ArrowRight') { keys.right = true; updated = true; }
    if(key === 'ShiftLeft' || key === 'ShiftRight') { keys.run = true; updated = true; }
    
    // Ações disparadas uma vez só
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
    
    if(updated && gameState === 'PLAYING') socket.emit('input', keys);
});

// ==========================================
// SOCKET EVENTS
// ==========================================
socket.on('connect', () => { myId = socket.id; });

socket.on('lobbyUpdate', (playersArray) => {
    const grid = document.getElementById('lobby-grid');
    grid.innerHTML = '';
    
    playersArray.forEach(p => {
        let isMe = p.id === myId;
        
        // Cachear imagem localmente
        if (p.avatar && !avatars[p.id]) {
            let img = new Image(); img.src = p.avatar;
            avatars[p.id] = img;
        }

        let card = document.createElement('div');
        card.className = `player-card ${p.ready ? 'ready' : ''} ${isMe ? 'me' : ''}`;
        card.innerHTML = `
            <h3>${p.name} ${isMe ? '(Você)' : ''}</h3>
            ${p.avatar ? `<img src="${p.avatar}">` : `<div style="width:64px;height:64px;border-radius:50%;background:${p.color};margin:10px auto;"></div>`}
            <p>${p.ready ? 'Pronto ✓' : 'Aguardando...'}</p>
        `;

        if(isMe && !p.ready) {
            let input = document.createElement('input');
            input.type = 'file'; input.accept = 'image/*'; input.style.display = 'block'; input.style.margin = '10px auto';
            input.onchange = (e) => {
                const file = e.target.files[0];
                if(file) {
                    const reader = new FileReader();
                    reader.onload = (ev) => {
                        // Comprime e corta a imagem antes de enviar (Evita crashes e lag)
                        let tempImg = new Image();
                        tempImg.onload = () => {
                            let cvs = document.createElement('canvas');
                            cvs.width = 64; cvs.height = 64;
                            let tCtx = cvs.getContext('2d');
                            tCtx.drawImage(tempImg, 0, 0, 64, 64);
                            socket.emit('updateAvatar', cvs.toDataURL('image/jpeg', 0.8));
                        };
                        tempImg.src = ev.target.result;
                    };
                    reader.readAsDataURL(file);
                }
            };
            
            let btn = document.createElement('button');
            btn.innerText = "Estou Pronto!";
            btn.onclick = () => { AudioSys.ctx.resume(); socket.emit('setReady', true); };
            
            card.appendChild(input);
            card.appendChild(btn);
        }
        grid.appendChild(card);
    });

    // Se todos prontos, avisa visualmente
    let allReady = playersArray.length > 0 && playersArray.every(p => p.ready);
    let startBtn = document.getElementById('btn-start');
    if (allReady) {
        startBtn.innerText = "Iniciando em breve...";
    } else {
        startBtn.innerText = "Aguardando todos ficarem Prontos...";
    }
});

socket.on('gameStart', (mapData) => {
    gameState = 'PLAYING';
    staticMap = mapData;
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('hud').classList.remove('hidden');
    requestAnimationFrame(renderLoop);
});

socket.on('syncState', (state) => {
    syncData = state;
});

socket.on('bossAlert', (msg) => {
    AudioSys.alert();
    AudioSys.bossSpeak();
    bossSpeechTimer = 180; // Duração do balão
    let alertDiv = document.getElementById('hud-alert');
    document.getElementById('alert-text').innerText = msg;
    alertDiv.classList.remove('hidden');
    setTimeout(() => { alertDiv.classList.add('hidden'); }, 3000);
});

socket.on('audioPlay', (snd) => { if(AudioSys[snd]) AudioSys[snd](); });

socket.on('gameOver', (data) => {
    gameState = 'GAMEOVER';
    document.getElementById('hud').classList.add('hidden');
    document.getElementById('game-over').classList.add('active');
    document.getElementById('end-title').innerText = data.won ? "SUCESSO!" : "FIM DE JOGO";
    document.getElementById('end-title').style.color = data.won ? "#4caf50" : "#ff5252";
    document.getElementById('end-msg').innerText = data.msg;
});

socket.on('resetToLobby', () => {
    window.location.reload(); // Forma mais segura de resetar todos pro Lobby original
});

document.getElementById('btn-restart').onclick = () => { window.location.reload(); };

// ==========================================
// MOTOR DE RENDERIZAÇÃO
// ==========================================
function renderLoop() {
    if(gameState !== 'PLAYING' || !syncData) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawMap();

    // Organizar por Y para sobreposição 3D fake
    let entities = [ ...Object.values(syncData.players), syncData.boss ].sort((a,b) => a.y - b.y);
    entities.forEach(e => {
        if(e.hasOwnProperty('stamina')) drawPlayer(e);
        else drawBoss(e);
    });

    // Atualiza HUD Tempo
    let min = String(Math.floor(syncData.time / 60)).padStart(2, '0');
    let sec = String(syncData.time % 60).padStart(2, '0');
    document.getElementById('hud-time').innerText = `${min}:${sec}`;

    if(bossSpeechTimer > 0) bossSpeechTimer--;

    requestAnimationFrame(renderLoop);
}

function drawMap() {
    ctx.fillStyle = '#cfd8dc'; ctx.fillRect(0,0,1400,900);
    ctx.strokeStyle = '#b0bec5'; ctx.lineWidth = 1;
    for(let i=0; i<1400; i+=64) { ctx.beginPath(); ctx.moveTo(i,0); ctx.lineTo(i,900); ctx.stroke(); }
    for(let i=0; i<900; i+=64) { ctx.beginPath(); ctx.moveTo(0,i); ctx.lineTo(1400,i); ctx.stroke(); }

    ctx.fillStyle = syncData.mapState.exitLocked ? '#d32f2f' : '#388e3c';
    ctx.fillRect(staticMap.exit.x, staticMap.exit.y, staticMap.exit.w, staticMap.exit.h);
    ctx.fillStyle = '#fff'; ctx.font = '14px Arial'; ctx.fillText("SAÍDA", staticMap.exit.x+30, staticMap.exit.y-10);

    if(!syncData.mapState.keyCollected) {
        ctx.fillStyle = '#ffeb3b';
        ctx.beginPath(); ctx.arc(staticMap.key.x+15, staticMap.key.y+15, 15, 0, Math.PI*2); ctx.fill();
    }

    staticMap.hidingSpots.forEach(s => {
        ctx.fillStyle = '#283593'; ctx.fillRect(s.x, s.y, s.w, s.h);
        ctx.fillStyle = '#3f51b5'; ctx.fillRect(s.x, s.y - 15, s.w, s.h);
    });

    staticMap.walls.forEach(w => {
        ctx.fillStyle = '#455a64'; ctx.fillRect(w.x, w.y, w.w, w.h);
        ctx.fillStyle = '#607d8b'; ctx.fillRect(w.x, w.y - 30, w.w, w.h + 30);
    });
}

function drawPlayer(p) {
    if(p.isHidden) return;
    let cx = p.x + p.w/2; let cy = p.y + p.h/2;
    let swing = p.isMoving ? Math.sin(Date.now() / 120) * 12 : 0;

    ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.beginPath(); ctx.ellipse(cx, p.y + p.h + 5, p.w/1.5, p.h/3, 0, 0, Math.PI*2); ctx.fill();

    ctx.strokeStyle = '#34495e'; ctx.lineWidth = 6; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(cx - 6, cy + 10); ctx.lineTo(cx - 6 + swing, cy + 25); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx + 6, cy + 10); ctx.lineTo(cx + 6 - swing, cy + 25); ctx.stroke();

    ctx.strokeStyle = p.color; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(cx - 15, cy - 5); ctx.lineTo(cx - 18 - swing, cy + 12); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx + 15, cy - 5); ctx.lineTo(cx + 18 + swing, cy + 12); ctx.stroke();

    ctx.fillStyle = p.color; ctx.fillRect(p.x, p.y - 5, p.w, p.h + 10);

   // Só desenha se a imagem já existir e estiver 100% carregada
    if (avatars[p.id] && avatars[p.id].complete) {
        ctx.save(); ctx.beginPath(); ctx.arc(cx, cy - 20, 20, 0, Math.PI*2); ctx.clip();
        ctx.drawImage(avatars[p.id], cx - 20, cy - 40, 40, 40); ctx.restore();
    } else {
        ctx.fillStyle = '#e0e0e0'; ctx.beginPath(); ctx.arc(cx, cy - 20, 16, 0, Math.PI*2); ctx.fill();
    }

    if(p.id === myId) {
        ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(cx - 15, cy - 50, 30, 4);
        ctx.fillStyle = p.stamina < 30 ? '#ff5252' : '#00e676';
        ctx.fillRect(cx - 15, cy - 50, (p.stamina/100)*30, 4);
        
        ctx.fillStyle = '#4fc3f7'; ctx.font = '10px Arial'; ctx.textAlign = 'center';
        ctx.fillText("VOCÊ", cx, cy - 60); ctx.textAlign = 'left';
    }
}

function drawBoss(b) {
    let cx = b.x + b.w/2; let cy = b.y + b.h/2;
    let isMoving = b.state !== 'SEARCH';
    let swing = isMoving ? Math.sin(Date.now() / 150) * 15 : 0;

    ctx.fillStyle = b.state === 'CHASE' ? 'rgba(255, 0, 0, 0.2)' : 'rgba(255, 255, 0, 0.2)';
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, 400, b.angle - Math.PI/5, b.angle + Math.PI/5); ctx.lineTo(cx, cy); ctx.fill();

    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.beginPath(); ctx.ellipse(cx, b.y + b.h + 5, b.w/1.5, b.h/3, 0, 0, Math.PI*2); ctx.fill();
    ctx.strokeStyle = '#2c3e50'; ctx.lineWidth = 7; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(cx - 8, cy + 10); ctx.lineTo(cx - 8 + swing, cy + 30); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx + 8, cy + 10); ctx.lineTo(cx + 8 - swing, cy + 30); ctx.stroke();
    ctx.strokeStyle = '#e67e22'; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(cx - 20, cy - 5); ctx.lineTo(cx - 22 - swing, cy + 15); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx + 20, cy - 5); ctx.lineTo(cx + 22 + swing, cy + 15); ctx.stroke();
    ctx.fillStyle = '#212121'; ctx.fillRect(b.x, b.y - 10, b.w, b.h + 15);

    ctx.fillStyle = '#f5b041'; ctx.beginPath(); ctx.arc(cx, cy - 25, 18, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#bdc3c7'; ctx.beginPath(); ctx.arc(cx - 16, cy - 22, 6, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.arc(cx + 16, cy - 22, 6, 0, Math.PI * 2); ctx.fill();
    let dirX = Math.cos(b.angle) * 5;
    ctx.fillStyle = '#d32f2f'; ctx.fillRect(cx - 8 + dirX, cy - 30, 4, 4); ctx.fillRect(cx + 4 + dirX, cy - 30, 4, 4);
    ctx.strokeStyle = '#333'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(cx - 10 + dirX, cy - 33); ctx.lineTo(cx - 3 + dirX, cy - 30); ctx.stroke(); ctx.beginPath(); ctx.moveTo(cx + 10 + dirX, cy - 33); ctx.lineTo(cx + 3 + dirX, cy - 30); ctx.stroke();

    // Balão de fala dinâmico controlado pelo servidor
    if (b.speechTimer > 0 && b.currentSpeech) {
        // Aumentei um pouco a largura do balão para caber os nomes confortavelmente
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.roundRect(cx - 100, cy - 80, 200, 30, 10); ctx.fill();
        ctx.fillStyle = '#000'; ctx.font = 'bold 11px Arial'; ctx.textAlign = 'center';
        ctx.fillText(b.currentSpeech, cx, cy - 60); ctx.textAlign = 'left'; 
    }
}
