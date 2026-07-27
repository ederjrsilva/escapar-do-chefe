const socket = io();
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

let gameState = 'LOBBY';
let staticMap = null;
let syncData = null;
let myId = null;
let availablePhotos = [];

const avatars = {}; 

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

const keys = { up: false, down: false, left: false, right: false, run: false };
window.addEventListener('keydown', (e) => {
    let key = e.code; let updated = false;
    if(key === 'KeyW' || key === 'ArrowUp') { keys.up = true; updated = true; }
    if(key === 'KeyS' || key === 'ArrowDown') { keys.down = true; updated = true; }
    if(key === 'KeyA' || key === 'ArrowLeft') { keys.left = true; updated = true; }
    if(key === 'KeyD' || key === 'ArrowRight') { keys.right = true; updated = true; }
    if(key === 'ShiftLeft' || key === 'ShiftRight') { keys.run = true; updated = true; }
    
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

socket.on('connect', () => { myId = socket.id; });
socket.on('photoList', (list) => { availablePhotos = list; });

socket.on('lobbyUpdate', (playersArray) => {
    const grid = document.getElementById('lobby-grid');
    grid.innerHTML = '';
    
    playersArray.forEach(p => {
        let isMe = p.id === myId;
        
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
            let selectTitle = document.createElement('p');
            selectTitle.innerText = "Escolha seu avatar:";
            selectTitle.style.fontSize = "11px";
            selectTitle.style.marginTop = "8px";
            card.appendChild(selectTitle);

            let photoContainer = document.createElement('div');
            photoContainer.style.display = 'flex';
            photoContainer.style.gap = '8px';
            photoContainer.style.justifyContent = 'center';
            photoContainer.style.flexWrap = 'wrap';
            photoContainer.style.margin = '8px 0';

            if (availablePhotos.length > 0) {
                availablePhotos.forEach(filename => {
                    let thumb = document.createElement('img');
                    thumb.src = `/fotos/${filename}`;
                    thumb.style.width = '42px';
                    thumb.style.height = '42px';
                    thumb.style.borderRadius = '50%';
                    thumb.style.cursor = 'pointer';
                    thumb.style.border = p.avatar === thumb.src ? '2px solid #4fc3f7' : '2px solid #555';
                    thumb.style.objectFit = 'cover';
                    
                    thumb.onclick = () => {
                        let tempImg = new Image();
                        tempImg.crossOrigin = "anonymous";
                        tempImg.onload = () => {
                            let cvs = document.createElement('canvas');
                            cvs.width = 64; cvs.height = 64;
                            let tCtx = cvs.getContext('2d');
                            tCtx.drawImage(tempImg, 0, 0, 64, 64);
                            socket.emit('updateAvatar', cvs.toDataURL('image/jpeg', 0.8));
                        };
                        tempImg.src = thumb.src;
                    };
                    photoContainer.appendChild(thumb);
                });
            } else {
                let errText = document.createElement('p');
                errText.innerText = "Coloque imagens na pasta 'fotos'!";
                errText.style.fontSize = "10px";
                errText.style.color = "#ff5252";
                photoContainer.appendChild(errText);
            }
            card.appendChild(photoContainer);
            
            let btn = document.createElement('button');
            btn.innerText = "Estou Pronto!";
            btn.onclick = () => { AudioSys.ctx.resume(); socket.emit('setReady', true); };
            card.appendChild(btn);
        }
        grid.appendChild(card);
    });

    let allReady = playersArray.length > 0 && playersArray.every(p => p.ready);
    let startBtn = document.getElementById('btn-start');
    startBtn.innerText = allReady ? "Iniciando em breve..." : "Aguardando todos ficarem Prontos...";
});

socket.on('gameStart', (mapData) => {
    gameState = 'PLAYING';
    staticMap = mapData;
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('hud').classList.remove('hidden');
    requestAnimationFrame(renderLoop);
});

socket.on('syncState', (state) => { syncData = state; });

socket.on('bossAlert', (msg) => {
    AudioSys.alert();
    AudioSys.bossSpeak();
    let alertDiv = document.getElementById('hud-alert');
    document.getElementById('alert-text').innerText = msg;
    alertDiv.classList.remove('hidden');
    setTimeout(() => { alertDiv.classList.add('hidden'); }, 3000);
});

// Mensagem quando o próprio jogador é pego (Modo Espectador)
socket.on('playerCaught', (data) => {
    if (data.id === myId) {
        let alertDiv = document.getElementById('hud-alert');
        document.getElementById('alert-text').innerText = "VOCÊ FOI PEGO! Assistindo restantes...";
        alertDiv.classList.remove('hidden');
    }
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

socket.on('resetToLobby', () => { window.location.reload(); });
document.getElementById('btn-restart').onclick = () => { window.location.reload(); };

function renderLoop() {
    if(gameState !== 'PLAYING') return;

    if(!syncData || !syncData.players || !syncData.boss) {
        requestAnimationFrame(renderLoop);
        return;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawMap();

    let playersArr = Object.values(syncData.players);
    let entities = [ ...playersArr, syncData.boss ].sort((a,b) => a.y - b.y);
    entities.forEach(e => {
        if(e.hasOwnProperty('stamina')) drawPlayer(e);
        else drawBoss(e);
    });

    let min = String(Math.floor(syncData.time / 60)).padStart(2, '0');
    let sec = String(syncData.time % 60).padStart(2, '0');
    document.getElementById('hud-time').innerText = `${min}:${sec}`;

    requestAnimationFrame(renderLoop);
}

function drawMap() {
    ctx.fillStyle = '#e2e8f0'; ctx.fillRect(0, 0, 1400, 900);
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1;
    for(let i = 0; i < 1400; i += 64) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 900); ctx.stroke(); }
    for(let i = 0; i < 900; i += 64) { ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(1400, i); ctx.stroke(); }

    ctx.fillStyle = 'rgba(15, 23, 42, 0.12)';
    ctx.font = 'bold 22px Roboto';
    ctx.textAlign = 'center';
    ctx.fillText("COMPRAS", 400, 150);
    ctx.fillText("FINANCEIRO", 1000, 150);
    ctx.fillText("RECURSOS HUMANOS", 700, 500);
    ctx.fillText("CONTRATOS", 700, 770);
    ctx.textAlign = 'left';

    if (staticMap && staticMap.furniture) {
        staticMap.furniture.forEach(f => {
            ctx.fillStyle = 'rgba(0,0,0,0.15)';
            ctx.fillRect(f.x + 2, f.y + 4, f.w, f.h);
            ctx.fillStyle = '#b45309';
            ctx.fillRect(f.x, f.y, f.w, f.h);
            ctx.strokeStyle = '#78350f';
            ctx.lineWidth = 2;
            ctx.strokeRect(f.x, f.y, f.w, f.h);

            ctx.fillStyle = '#1e293b';
            ctx.fillRect(f.x + f.w/2 - 14, f.y + 12, 28, 16);
            ctx.fillStyle = '#38bdf8';
            ctx.fillRect(f.x + f.w/2 - 12, f.y + 14, 24, 12);
            ctx.fillStyle = '#0f172a';
            ctx.fillRect(f.x + f.w/2 - 3, f.y + 28, 6, 4);
        });
    }

    ctx.fillStyle = syncData.mapState.exitLocked ? '#dc2626' : '#16a34a';
    ctx.fillRect(staticMap.exit.x, staticMap.exit.y, staticMap.exit.w, staticMap.exit.h);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 13px Roboto'; ctx.fillText("SAÍDA", staticMap.exit.x + 30, staticMap.exit.y - 10);

    if(!syncData.mapState.keyCollected) {
        ctx.fillStyle = '#facc15';
        ctx.beginPath(); ctx.arc(staticMap.key.x + 15, staticMap.key.y + 15, 15, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#ca8a04'; ctx.lineWidth = 2; ctx.stroke();
    }

    staticMap.hidingSpots.forEach(s => {
        ctx.fillStyle = '#1e3a8a'; ctx.fillRect(s.x, s.y, s.w, s.h);
        ctx.fillStyle = '#3b82f6'; ctx.fillRect(s.x, s.y - 15, s.w, s.h);
    });

    staticMap.walls.forEach(w => {
        let isFurniture = staticMap.furniture && staticMap.furniture.some(f => f.x === w.x && f.y === w.y);
        if(!isFurniture) {
            ctx.fillStyle = '#334155'; ctx.fillRect(w.x, w.y, w.w, w.h);
            ctx.fillStyle = '#475569'; ctx.fillRect(w.x, w.y - 30, w.w, w.h + 30);
        }
    });
}

function drawPlayer(p) {
    // Se o jogador estiver morto (foi pego) ou escondido, ele some do cenário
    if(p.isDead || p.isHidden) return;
    
    let cx = p.x + p.w/2; let cy = p.y + p.h/2;
    let swing = p.isMoving ? Math.sin(Date.now() / 120) * 12 : 0;

    ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.ellipse(cx, p.y + p.h + 5, p.w/1.5, p.h/3, 0, 0, Math.PI*2); ctx.fill();

    ctx.strokeStyle = '#334155'; ctx.lineWidth = 6; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(cx - 6, cy + 10); ctx.lineTo(cx - 6 + swing, cy + 25); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx + 6, cy + 10); ctx.lineTo(cx + 6 - swing, cy + 25); ctx.stroke();

    ctx.strokeStyle = p.color; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(cx - 15, cy - 5); ctx.lineTo(cx - 18 - swing, cy + 12); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx + 15, cy - 5); ctx.lineTo(cx + 18 + swing, cy + 12); ctx.stroke();

    ctx.fillStyle = p.color; ctx.fillRect(p.x, p.y - 5, p.w, p.h + 10);

    if (avatars[p.id] && avatars[p.id].complete) {
        ctx.save(); ctx.beginPath(); ctx.arc(cx, cy - 20, 20, 0, Math.PI*2); ctx.clip();
        ctx.drawImage(avatars[p.id], cx - 20, cy - 40, 40, 40); ctx.restore();
    } else {
        ctx.fillStyle = '#e2e8f0'; ctx.beginPath(); ctx.arc(cx, cy - 20, 16, 0, Math.PI*2); ctx.fill();
    }

    if(p.id === myId) {
        ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(cx - 15, cy - 50, 30, 4);
        ctx.fillStyle = p.stamina < 30 ? '#ef4444' : '#22c55e';
        ctx.fillRect(cx - 15, cy - 50, (p.stamina/100)*30, 4);
        
        ctx.fillStyle = '#38bdf8'; ctx.font = 'bold 10px Roboto'; ctx.textAlign = 'center';
        ctx.fillText("VOCÊ", cx, cy - 60); ctx.textAlign = 'left';
    }
}

function drawBoss(b) {
    let cx = b.x + b.w/2; let cy = b.y + b.h/2;
    let isMoving = b.state !== 'SEARCH';
    let swing = isMoving ? Math.sin(Date.now() / 150) * 15 : 0;

    ctx.fillStyle = b.state === 'CHASE' ? 'rgba(239, 68, 68, 0.18)' : 'rgba(234, 179, 8, 0.18)';
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, 400, b.angle - Math.PI/5, b.angle + Math.PI/5); ctx.lineTo(cx, cy); ctx.fill();

    ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.beginPath(); ctx.ellipse(cx, b.y + b.h + 5, b.w/1.5, b.h/3, 0, 0, Math.PI*2); ctx.fill();
    ctx.strokeStyle = '#1e293b'; ctx.lineWidth = 7; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(cx - 8, cy + 10); ctx.lineTo(cx - 8 + swing, cy + 30); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx + 8, cy + 10); ctx.lineTo(cx + 8 - swing, cy + 30); ctx.stroke();
    ctx.strokeStyle = '#c2410c'; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(cx - 20, cy - 5); ctx.lineTo(cx - 22 - swing, cy + 15); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx + 20, cy - 5); ctx.lineTo(cx + 22 + swing, cy + 15); ctx.stroke();
    ctx.fillStyle = '#0f172a'; ctx.fillRect(b.x, b.y - 10, b.w, b.h + 15);

    ctx.fillStyle = '#fbbf24'; ctx.beginPath(); ctx.arc(cx, cy - 25, 18, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#94a3b8'; ctx.beginPath(); ctx.arc(cx - 16, cy - 22, 6, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.arc(cx + 16, cy - 22, 6, 0, Math.PI * 2); ctx.fill();
    let dirX = Math.cos(b.angle) * 5;
    ctx.fillStyle = '#dc2626'; ctx.fillRect(cx - 8 + dirX, cy - 30, 4, 4); ctx.fillRect(cx + 4 + dirX, cy - 30, 4, 4);
    ctx.strokeStyle = '#1e293b'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(cx - 10 + dirX, cy - 33); ctx.lineTo(cx - 3 + dirX, cy - 30); ctx.stroke(); ctx.beginPath(); ctx.moveTo(cx + 10 + dirX, cy - 33); ctx.lineTo(cx + 3 + dirX, cy - 30); ctx.stroke();

    if (b.speechTimer > 0 && b.currentSpeech) {
        ctx.fillStyle = '#fff'; 
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') {
            ctx.roundRect(cx - 110, cy - 80, 220, 30, 10);
        } else {
            ctx.rect(cx - 110, cy - 80, 220, 30);
        }
        ctx.fill();
        ctx.fillStyle = '#000'; ctx.font = 'bold 11px Roboto'; ctx.textAlign = 'center';
        ctx.fillText(b.currentSpeech, cx, cy - 60); ctx.textAlign = 'left'; 
    }
}
