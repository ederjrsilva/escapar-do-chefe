const socket = io();

const lobbyDiv = document.getElementById('lobby');
const gameContainer = document.getElementById('game-container');
const playerNameInput = document.getElementById('playerName');
const startButton = document.getElementById('startButton');
const photoOptions = document.querySelectorAll('.photo-option');
const errorMsg = document.getElementById('error-msg');
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

let selectedPhoto = null;
let imagesLoaded = {};

// Handle photo selection & validation
photoOptions.forEach(img => {
    const src = img.getAttribute('data-photo');
    const imageObj = new Image();
    imageObj.src = src;
    imagesLoaded[src] = imageObj;

    img.addEventListener('click', () => {
        photoOptions.forEach(p => p.classList.remove('selected'));
        img.classList.add('selected');
        selectedPhoto = src;
        errorMsg.classList.add('error-hidden');
        checkStartReady();
    });
});

playerNameInput.addEventListener('input', checkStartReady);

function checkStartReady() {
    if (selectedPhoto && playerNameInput.value.trim().length > 0) {
        startButton.disabled = false;
    } else {
        startButton.disabled = true;
    }
}

startButton.addEventListener('click', () => {
    if (!selectedPhoto) {
        errorMsg.classList.remove('error-hidden');
        return;
    }

    const name = playerNameInput.value.trim() || 'Jogador';
    socket.emit('joinGame', { name, photo: selectedPhoto });

    lobbyDiv.classList.add('hidden');
    gameContainer.classList.remove('hidden');
});

// Movement handling
const keys = { left: false, right: false, up: false, down: false };

window.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') keys.left = true;
    if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') keys.right = true;
    if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') keys.up = true;
    if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') keys.down = true;
});

window.addEventListener('keyup', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') keys.left = false;
    if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') keys.right = false;
    if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') keys.up = false;
    if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') keys.down = false;
});

setInterval(() => {
    if (!gameContainer.classList.contains('hidden')) {
        socket.emit('playerMove', keys);
    }
}, 1000 / 60);

// Render game state (High visibility, fixed dark rendering)
socket.on('gameState', (state) => {
    ctx.fillStyle = '#0f3460';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw subtle grid
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    for (let x = 0; x < canvas.width; x += 40) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
    }
    for (let y = 0; y < canvas.height; y += 40) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
    }

    // Draw Boss
    if (state.boss) {
        ctx.save();
        ctx.shadowColor = '#e94560';
        ctx.shadowBlur = 15;
        ctx.fillStyle = '#e94560';
        ctx.beginPath();
        ctx.arc(state.boss.x, state.boss.y, 25, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
        ctx.restore();

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 14px Segoe UI';
        ctx.textAlign = 'center';
        ctx.fillText('CHEFE', state.boss.x, state.boss.y - 32);
    }

    // Draw Players
    for (let id in state.players) {
        const p = state.players[id];
        
        ctx.save();
        ctx.beginPath();
        ctx.arc(p.x, p.y, 22, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();

        const img = imagesLoaded[p.photo];
        if (img && img.complete) {
            ctx.drawImage(img, p.x - 22, p.y - 22, 44, 44);
        } else {
            ctx.fillStyle = '#4ecca3';
            ctx.fillRect(p.x - 22, p.y - 22, 44, 44);
        }
        ctx.restore();

        ctx.beginPath();
        ctx.arc(p.x, p.y, 22, 0, Math.PI * 2);
        ctx.lineWidth = 3;
        ctx.strokeStyle = socket.id === id ? '#4ecca3' : '#ffffff';
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 13px Segoe UI';
        ctx.textAlign = 'center';
        ctx.fillText(p.name, p.x, p.y - 28);
    }
});

socket.on('caught', () => {
    alert('Você foi pego pelo chefe!');
});
