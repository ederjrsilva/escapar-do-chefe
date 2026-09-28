const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

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

// ===== Painel de admin (liga/desliga o jogo) =====
// Tudo isolado aqui pra não mexer no index.html/client.js.
let gameEnabled = true;
const ADMIN_PASSWORD = 'adminfajardo';

const OFF_PAGE_HTML = `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Hospital Escape</title>
<style>
    body { margin:0; height:100vh; display:flex; align-items:center; justify-content:center; background:#0f172a; color:#fff; font-family:'Roboto',sans-serif; text-align:center; padding:20px; box-sizing:border-box; }
    h1 { font-size:28px; color:#facc15; }
    p { color:#94a3b8; }
</style></head>
<body><div><h1>🏥 Estamos off, retorne no horário de almoço</h1><p>Volte mais tarde pra jogar!</p></div></body></html>`;

function adminLoginHtml(showError) {
    return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Admin - Hospital Escape</title>
<style>
    body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background:#0f172a; color:#fff; font-family:'Roboto',sans-serif; }
    .card { background:#1e293b; padding:30px 40px; border-radius:12px; border:2px solid #334155; text-align:center; }
    h1 { font-size:20px; margin-bottom:15px; }
    input { padding:10px; border-radius:8px; border:1px solid #475569; background:#0f172a; color:#fff; font-size:15px; }
    button { padding:10px 20px; font-size:15px; font-weight:bold; border:none; border-radius:8px; cursor:pointer; background:#38bdf8; color:#000; margin-left:8px; }
    button:hover { background:#0284c7; color:#fff; }
    .error { color:#ef4444; font-size:13px; margin-top:10px; }
</style></head>
<body>
    <div class="card">
        <h1>🔒 Painel do Jogo</h1>
        <form method="GET" action="/admin">
            <input type="password" name="senha" placeholder="Senha" autofocus>
            <button type="submit">Entrar</button>
        </form>
        ${showError ? '<div class="error">Senha incorreta</div>' : ''}
    </div>
</body></html>`;
}

function adminPageHtml(senha) {
    return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Admin - Hospital Escape</title>
<style>
    body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background:#0f172a; color:#fff; font-family:'Roboto',sans-serif; }
    .card { background:#1e293b; padding:30px 40px; border-radius:12px; border:2px solid #334155; text-align:center; }
    h1 { font-size:20px; margin-bottom:10px; }
    .status { font-weight:bold; font-size:18px; margin:15px 0; }
    .on { color:#4caf50; } .off { color:#ef4444; }
    button { padding:12px 24px; font-size:16px; font-weight:bold; border:none; border-radius:8px; cursor:pointer; background:#38bdf8; color:#000; }
    button:hover { background:#0284c7; color:#fff; }
</style></head>
<body>
    <div class="card">
        <h1>🔧 Painel do Jogo</h1>
        <div class="status ${gameEnabled ? 'on' : 'off'}">Status atual: ${gameEnabled ? 'LIGADO ✅' : 'DESLIGADO ⛔'}</div>
        <form method="POST" action="/admin/toggle">
            <input type="hidden" name="senha" value="${senha}">
            <button type="submit">${gameEnabled ? 'Desligar jogo' : 'Ligar jogo'}</button>
        </form>
        <div style="margin-top:20px; border-top:1px solid #334155; padding-top:15px;">
            <a href="/admin/bosses?senha=${encodeURIComponent(senha)}" style="color:#38bdf8; font-weight:bold; text-decoration:none;">🧑‍💼 Gerenciar Bosses personalizados →</a>
        </div>
    </div>
</body></html>`;
}

app.get('/admin', (req, res) => {
    const senha = req.query.senha || '';
    if (senha !== ADMIN_PASSWORD) {
        return res.send(adminLoginHtml(req.query.senha !== undefined));
    }
    res.send(adminPageHtml(senha));
});

app.post('/admin/toggle', express.urlencoded({ extended: true }), (req, res) => {
    if (req.body.senha !== ADMIN_PASSWORD) {
        return res.status(403).send('Senha incorreta');
    }
    gameEnabled = !gameEnabled;
    console.log(`[admin] jogo ${gameEnabled ? 'LIGADO' : 'DESLIGADO'} via /admin`);
    res.redirect('/admin?senha=' + encodeURIComponent(req.body.senha));
});

// Se o jogo estiver desligado, a página principal mostra o aviso em vez do
// jogo. Isso roda ANTES do express.static, então intercepta só a rota "/".
app.get('/', (req, res, next) => {
    if (!gameEnabled) return res.send(OFF_PAGE_HTML);
    next();
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

// ===== Sistema de Bosses personalizáveis =====
// A movimentação, velocidade, IA de perseguição, obstáculos etc. do chefe são
// SEMPRE as mesmas (ver a lógica de PATROL/CHASE/SEARCH mais abaixo) — o que
// muda de um boss pro outro é só a aparência (visual) e as frases que ele fala.
const MAX_BOSSES = 6;
const BOSSES_DIR = path.join(__dirname, 'fotos', 'bosses');
const BOSSES_DATA_FILE = path.join(__dirname, 'bosses-data.json');
try { if (!fs.existsSync(BOSSES_DIR)) fs.mkdirSync(BOSSES_DIR, { recursive: true }); } catch (e) { console.error('[bosses] não foi possível criar pasta de fotos/bosses:', e); }

// "O Caçador" é o boss atual/original. Fica sempre fixo como o primeiro card,
// com a lógica e frases 100% originais. A foto abaixo é só o retrato dele
// usado no CARD de seleção — durante a partida ele continua sendo desenhado
// do jeito procedural de sempre (ver client.js: drawBossMan trata bossId
// 'default' como caso especial), então visualmente em jogo nada muda.
const DEFAULT_BOSS = {
    id: 'default',
    name: 'O Caçador',
    isDefault: true,
    appearance: {
        gender: 'male', skinColor: '#fca5a5', hairColor: '#d1d5db', eyeColor: '#ff0000', bodyColor: '#94a3b8', lipColor: '#c2410c',
        facePhoto: 'bosses/default-face.png'
    },
    phrasesPatrol: [...BOSS_PATROL_PHRASES],
    phraseSpot: "Te achei, nó cego!",
    phraseCatch: "Te peguei, nó cego!"
};

function loadBosses() {
    try {
        if (fs.existsSync(BOSSES_DATA_FILE)) {
            let saved = JSON.parse(fs.readFileSync(BOSSES_DATA_FILE, 'utf8'));
            if (Array.isArray(saved)) return [DEFAULT_BOSS, ...saved.filter(b => b && b.id && b.id !== 'default')];
        }
    } catch (e) { console.error('[bosses] erro ao carregar bosses-data.json, usando só o padrão:', e); }
    return [DEFAULT_BOSS];
}
function saveBosses() {
    try { fs.writeFileSync(BOSSES_DATA_FILE, JSON.stringify(bosses.filter(b => !b.isDefault), null, 2)); }
    catch (e) { console.error('[bosses] erro ao salvar bosses-data.json:', e); }
}

let bosses = loadBosses();
let activeBossDef = DEFAULT_BOSS; // boss em uso na partida atual (ou o padrão, fora de partida)

// Lista "pública" enviada aos clientes (lobby / seleção / cards) — mesmos
// campos que o admin cadastra, sem nada sensível.
function publicBossList() {
    return bosses.map(b => ({ id: b.id, name: b.name, appearance: b.appearance, isDefault: !!b.isDefault }));
}

const bossPhotoUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, BOSSES_DIR),
        filename: (req, file, cb) => {
            let ext = (path.extname(file.originalname || '').toLowerCase().match(/\.(jpg|jpeg|png|webp)$/) || ['.jpg'])[0];
            cb(null, `boss-${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
        }
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (/\.(jpg|jpeg|png|webp)$/i.test(file.originalname || '')) cb(null, true);
        else cb(new Error('Formato de imagem inválido (use jpg, jpeg, png ou webp).'));
    }
});

function requireAdmin(req, res, next) {
    const senha = (req.query && req.query.senha) || (req.body && req.body.senha) || '';
    if (senha !== ADMIN_PASSWORD) return res.status(403).send('Senha incorreta. <a href="/admin" style="color:#38bdf8;">Voltar</a>');
    req.adminSenha = senha;
    next();
}

function bossCardPreviewHtml(b) {
    let img = b.appearance.facePhoto
        ? `<img src="/fotos/${b.appearance.facePhoto}" style="width:100%;height:100%;object-fit:cover;">`
        : `<div style="width:100%;height:100%;background:${b.appearance.skinColor};position:relative;">
             <div style="position:absolute;top:38%;left:20%;width:12%;height:10%;background:${b.appearance.eyeColor};"></div>
             <div style="position:absolute;top:38%;right:20%;width:12%;height:10%;background:${b.appearance.eyeColor};"></div>
           </div>`;
    return `<div style="width:90px;height:90px;border-radius:8px;overflow:hidden;background:#0f172a;border:2px solid #475569;">${img}</div>`;
}

function bossesListHtml(senha, message) {
    let podeAdicionar = bosses.length < MAX_BOSSES;
    let cardsHtml = bosses.map(b => `
        <div style="background:#1e293b; border:2px solid #334155; border-radius:10px; padding:14px; display:flex; gap:14px; align-items:center; width:420px;">
            ${bossCardPreviewHtml(b)}
            <div style="flex:1; text-align:left;">
                <div style="font-weight:bold; font-size:16px;">${b.name} ${b.isDefault ? '<span style="color:#facc15;font-size:11px;">(padrão)</span>' : ''}</div>
                <div style="font-size:12px; color:#94a3b8; margin-top:4px;">${(b.isDefault ? b.phrasesPatrol : b.phrasesPatrol).length} frase(s) de patrulha</div>
                <div style="margin-top:10px; display:flex; gap:8px;">
                    ${b.isDefault ? '' : `
                        <a href="/admin/bosses/edit/${b.id}?senha=${encodeURIComponent(senha)}"><button type="button">Editar</button></a>
                        <form method="POST" action="/admin/bosses/delete/${b.id}" onsubmit="return confirm('Excluir este boss?');">
                            <input type="hidden" name="senha" value="${senha}">
                            <button type="submit" style="background:#ef4444;">Excluir</button>
                        </form>
                    `}
                </div>
            </div>
        </div>
    `).join('');

    return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Bosses - Hospital Escape</title>
<style>
    body { margin:0; min-height:100vh; background:#0f172a; color:#fff; font-family:'Roboto',sans-serif; padding:30px; box-sizing:border-box; }
    h1 { font-size:22px; } a { color:#38bdf8; }
    button { padding:8px 14px; font-size:14px; font-weight:bold; border:none; border-radius:6px; cursor:pointer; background:#38bdf8; color:#000; }
    button:hover { background:#0284c7; color:#fff; }
    .list { display:flex; flex-direction:column; gap:14px; margin:20px 0; }
    .msg { background:#78350f; border:1px solid #facc15; color:#fde68a; padding:10px 14px; border-radius:8px; margin-bottom:15px; max-width:460px; }
    .top-bar { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; }
</style></head>
<body>
    <div class="top-bar">
        <h1>🧑‍💼 Bosses personalizados (${bosses.length}/${MAX_BOSSES})</h1>
        <div><a href="/admin?senha=${encodeURIComponent(senha)}">← Voltar ao painel</a></div>
    </div>
    ${message ? `<div class="msg">${message}</div>` : ''}
    <div class="list">${cardsHtml}</div>
    ${podeAdicionar
        ? `<a href="/admin/bosses/new?senha=${encodeURIComponent(senha)}"><button type="button">+ Criar novo boss</button></a>`
        : `<div class="msg">Limite de ${MAX_BOSSES} bosses atingido! Para adicionar um novo, edite ou exclua algum já existente.</div>`}
</body></html>`;
}

function bossFormHtml(senha, boss) {
    let isEdit = !!boss;
    let b = boss || { id: '', name: '', appearance: { gender: 'male', skinColor: '#fca5a5', hairColor: '#334155', eyeColor: '#ff0000', bodyColor: '#94a3b8', lipColor: '#be123c', facePhoto: null }, phrasesPatrol: [], phraseSpot: '', phraseCatch: '' };
    let action = isEdit ? `/admin/bosses/edit/${b.id}` : '/admin/bosses/create';
    let currentPhotoHtml = b.appearance.facePhoto
        ? `<div style="margin:10px 0;"><img src="/fotos/${b.appearance.facePhoto}" style="width:80px;height:80px;border-radius:50%;object-fit:cover;border:2px solid #475569;"><div style="font-size:11px;color:#94a3b8;">Foto atual (envie outra abaixo pra substituir)</div></div>`
        : '';

    return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${isEdit ? 'Editar' : 'Novo'} Boss - Hospital Escape</title>
<style>
    body { margin:0; min-height:100vh; background:#0f172a; color:#fff; font-family:'Roboto',sans-serif; padding:30px; box-sizing:border-box; display:flex; justify-content:center; }
    .card { background:#1e293b; padding:26px 30px; border-radius:12px; border:2px solid #334155; max-width:420px; width:100%; }
    h1 { font-size:19px; margin-top:0; }
    label { display:block; font-size:13px; color:#94a3b8; margin:14px 0 5px; }
    input[type=text], textarea { width:100%; box-sizing:border-box; padding:9px; border-radius:6px; border:1px solid #475569; background:#0f172a; color:#fff; font-size:14px; }
    input[type=color] { width:60px; height:36px; border:none; border-radius:6px; cursor:pointer; vertical-align:middle; }
    textarea { min-height:90px; font-family:inherit; }
    .row { display:flex; gap:16px; flex-wrap:wrap; }
    .row > div { flex:1; min-width:120px; }
    button { margin-top:20px; padding:11px 22px; font-size:15px; font-weight:bold; border:none; border-radius:8px; cursor:pointer; background:#38bdf8; color:#000; }
    button:hover { background:#0284c7; color:#fff; }
    a { color:#94a3b8; font-size:13px; }
    .gender-switch { display:flex; background:#0f172a; border:1px solid #475569; border-radius:999px; padding:3px; width:max-content; }
    .gender-switch input { display:none; }
    .gender-switch label { margin:0; padding:7px 20px; border-radius:999px; cursor:pointer; color:#94a3b8; font-size:14px; font-weight:bold; }
    .gender-switch input:checked + label { background:#38bdf8; color:#000; }
    #g-female:checked + label { background:#f472b6; }
</style></head>
<body>
    <div class="card">
        <h1>${isEdit ? '✏️ Editar' : '➕ Novo'} Boss</h1>
        <form method="POST" action="${action}" enctype="multipart/form-data">
            <input type="hidden" name="senha" value="${senha}">
            <label>Nome do boss</label>
            <input type="text" name="name" maxlength="30" required value="${b.name || ''}" placeholder="Ex: A Supervisora">

            <label>Qual o gênero do boss?</label>
            <div class="gender-switch">
                <input type="radio" id="g-male" name="gender" value="male" ${b.appearance.gender !== 'female' ? 'checked' : ''} onchange="updGender()">
                <label for="g-male">Masculino</label>
                <input type="radio" id="g-female" name="gender" value="female" ${b.appearance.gender === 'female' ? 'checked' : ''} onchange="updGender()">
                <label for="g-female">Feminino</label>
            </div>
            <p id="gender-hint" style="font-size:12px;color:#94a3b8;"></p>

            <div class="row">
                <div><label>Cor da pele</label><input type="color" name="skinColor" value="${b.appearance.skinColor}"></div>
                <div><label>Cor do cabelo</label><input type="color" name="hairColor" value="${b.appearance.hairColor}"></div>
                <div><label>Cor dos olhos</label><input type="color" name="eyeColor" value="${b.appearance.eyeColor}"></div>
                <div><label id="body-label">Cor do corpo/roupa</label><input type="color" name="bodyColor" value="${b.appearance.bodyColor}"></div>
                <div id="lip-wrap" style="display:none;"><label>Cor do batom</label><input type="color" name="lipColor" value="${b.appearance.lipColor || '#be123c'}"></div>
            </div>
            <p style="font-size:12px;color:#94a3b8;">As cores acima só valem se você <b>não</b> enviar uma foto de rosto — a foto sempre tem prioridade sobre a cor da pele/olhos.</p>

            ${currentPhotoHtml}
            <label>Foto real do rosto (opcional — mesmo enquadramento circular usado nos personagens jogáveis)</label>
            <input type="file" name="facePhoto" accept=".jpg,.jpeg,.png,.webp">

            <label>Frases de patrulha (uma por linha — ditas aleatoriamente enquanto ele ronda)</label>
            <textarea name="phrasesPatrol" placeholder="Cadê vocês?
Sei que estão aqui...">${(b.phrasesPatrol || []).join('\n')}</textarea>

            <label>Frase ao avistar alguém</label>
            <input type="text" name="phraseSpot" maxlength="60" value="${b.phraseSpot || ''}" placeholder="Te achei!">

            <label>Frase ao capturar alguém</label>
            <input type="text" name="phraseCatch" maxlength="60" value="${b.phraseCatch || ''}" placeholder="Te peguei!">

            <div style="margin-top:20px;">
                <button type="submit">${isEdit ? 'Salvar alterações' : 'Criar boss'}</button>
                <a href="/admin/bosses?senha=${encodeURIComponent(senha)}" style="margin-left:14px;">Cancelar</a>
            </div>
        </form>
    </div>
    <script>
        function updGender() {
            var f = document.getElementById('g-female').checked;
            document.getElementById('lip-wrap').style.display = f ? 'block' : 'none';
            document.getElementById('body-label').innerText = f ? 'Cor do vestido' : 'Cor do corpo/roupa';
            document.getElementById('gender-hint').innerText = f
                ? 'Feminino: corpo de senhora (vestido + colar), cabelo longo/coque e batom personalizáveis.'
                : 'Masculino: mantém o corpo do velho (camisa social + gravata) e o rosto personalizável.';
        }
        updGender();
    </script>
</body></html>`;
}

app.get('/admin/bosses', requireAdmin, (req, res) => res.send(bossesListHtml(req.adminSenha)));

app.get('/admin/bosses/new', requireAdmin, (req, res) => {
    if (bosses.length >= MAX_BOSSES) return res.send(bossesListHtml(req.adminSenha, `Limite de ${MAX_BOSSES} bosses atingido! Edite ou exclua algum já existente antes de criar um novo.`));
    res.send(bossFormHtml(req.adminSenha, null));
});

app.get('/admin/bosses/edit/:id', requireAdmin, (req, res) => {
    let b = bosses.find(x => x.id === req.params.id && !x.isDefault);
    if (!b) return res.redirect('/admin/bosses?senha=' + encodeURIComponent(req.adminSenha));
    res.send(bossFormHtml(req.adminSenha, b));
});

app.post('/admin/bosses/create', (req, res, next) => bossPhotoUpload.single('facePhoto')(req, res, err => {
    if (err) return res.status(400).send(`Erro no upload: ${err.message} <a href="javascript:history.back()">Voltar</a>`);
    next();
}), requireAdmin, (req, res) => {
    const senha = req.adminSenha;
    if (bosses.length >= MAX_BOSSES) {
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.send(bossesListHtml(senha, `Limite de ${MAX_BOSSES} bosses atingido! Edite ou exclua algum já existente antes de criar um novo.`));
    }
    let phrasesPatrol = String(req.body.phrasesPatrol || '').split('\n').map(s => s.trim()).filter(Boolean);
    let newBoss = {
        id: 'b' + Date.now() + Math.round(Math.random() * 1000),
        name: String(req.body.name || '').trim().slice(0, 30) || 'Boss sem nome',
        isDefault: false,
        appearance: {
            gender: req.body.gender === 'female' ? 'female' : 'male',
            skinColor: req.body.skinColor || '#fca5a5',
            hairColor: req.body.hairColor || '#334155',
            eyeColor: req.body.eyeColor || '#ff0000',
            bodyColor: req.body.bodyColor || '#94a3b8',
            lipColor: req.body.lipColor || '#be123c',
            facePhoto: req.file ? `bosses/${req.file.filename}` : null
        },
        phrasesPatrol: phrasesPatrol.length ? phrasesPatrol : ['Cadê vocês?'],
        phraseSpot: String(req.body.phraseSpot || '').trim() || 'Te achei!',
        phraseCatch: String(req.body.phraseCatch || '').trim() || 'Te peguei!'
    };
    bosses.push(newBoss);
    saveBosses();
    io.emit('bossesUpdated', publicBossList());
    res.redirect('/admin/bosses?senha=' + encodeURIComponent(senha));
});

app.post('/admin/bosses/edit/:id', (req, res, next) => bossPhotoUpload.single('facePhoto')(req, res, err => {
    if (err) return res.status(400).send(`Erro no upload: ${err.message} <a href="javascript:history.back()">Voltar</a>`);
    next();
}), requireAdmin, (req, res) => {
    const senha = req.adminSenha;
    let b = bosses.find(x => x.id === req.params.id && !x.isDefault);
    if (!b) { if (req.file) fs.unlink(req.file.path, () => {}); return res.redirect('/admin/bosses?senha=' + encodeURIComponent(senha)); }

    let phrasesPatrol = String(req.body.phrasesPatrol || '').split('\n').map(s => s.trim()).filter(Boolean);
    b.name = String(req.body.name || '').trim().slice(0, 30) || b.name;
    b.appearance = {
        gender: req.body.gender === 'female' ? 'female' : 'male',
        lipColor: req.body.lipColor || b.appearance.lipColor || '#be123c',
        skinColor: req.body.skinColor || b.appearance.skinColor,
        hairColor: req.body.hairColor || b.appearance.hairColor,
        eyeColor: req.body.eyeColor || b.appearance.eyeColor,
        bodyColor: req.body.bodyColor || b.appearance.bodyColor,
        facePhoto: b.appearance.facePhoto
    };
    if (req.file) {
        let oldPhoto = b.appearance.facePhoto;
        b.appearance.facePhoto = `bosses/${req.file.filename}`;
        if (oldPhoto) { let oldPath = path.join(__dirname, 'fotos', oldPhoto); fs.unlink(oldPath, () => {}); }
    }
    b.phrasesPatrol = phrasesPatrol.length ? phrasesPatrol : b.phrasesPatrol;
    b.phraseSpot = String(req.body.phraseSpot || '').trim() || b.phraseSpot;
    b.phraseCatch = String(req.body.phraseCatch || '').trim() || b.phraseCatch;

    saveBosses();
    io.emit('bossesUpdated', publicBossList());
    res.redirect('/admin/bosses?senha=' + encodeURIComponent(senha));
});

app.post('/admin/bosses/delete/:id', express.urlencoded({ extended: true }), requireAdmin, (req, res) => {
    const senha = req.adminSenha;
    let idx = bosses.findIndex(x => x.id === req.params.id && !x.isDefault);
    if (idx !== -1) {
        let removed = bosses[idx];
        if (removed.appearance.facePhoto) { let p2 = path.join(__dirname, 'fotos', removed.appearance.facePhoto); fs.unlink(p2, () => {}); }
        bosses.splice(idx, 1);
        saveBosses();
        io.emit('bossesUpdated', publicBossList());
    }
    res.redirect('/admin/bosses?senha=' + encodeURIComponent(senha));
});

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

// bossDef: qual boss (aparência + nome) representar nesse round. A lógica de
// movimentação abaixo (PATROL/CHASE/SEARCH, velocidade, colisão com paredes)
// é sempre a mesma pra qualquer boss — só a aparência/frases mudam.
function createBoss(bossDef) {
    let def = bossDef || DEFAULT_BOSS;
    return {
        x: MAP_W/2, y: MAP_H/2, w: 32, h: 32, state: 'PATROL', angle: 0, targetId: null, lastKnownPos: null,
        patrolTarget: null, navWaypoint: null, progressCheck: null,
        prevX: 0, prevY: 0, stuckTimer: 0, isMoving: false, speechText: null, speechTimer: 0, role: 'boss',
        bossId: def.id, name: def.name, appearance: def.appearance
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

// socket.id -> bossId votado. Zerado a cada nova votação/reset.
let bossVotes = {};

function startBossVote() {
    gameState = 'BOSS_VOTE';
    bossVotes = {};
    io.emit('bossVoteStart', publicBossList());
}

function broadcastVoteState() {
    let pList = Object.values(players);
    let tally = {};
    bosses.forEach(b => tally[b.id] = { count: 0, voters: [] });
    Object.entries(bossVotes).forEach(([sid, bossId]) => {
        if (!tally[bossId]) return;
        tally[bossId].count++;
        let p = players[sid];
        if (p) tally[bossId].voters.push(p.name);
    });
    io.emit('bossVoteUpdate', { tally, votedCount: Object.keys(bossVotes).length, totalPlayers: pList.length });

    if (pList.length > 0 && Object.keys(bossVotes).length === pList.length) {
        let maxCount = Math.max(...Object.values(tally).map(t => t.count));
        let topBossIds = Object.entries(tally).filter(([id, t]) => t.count === maxCount && t.count > 0).map(([id]) => id);
        if (topBossIds.length > 1) {
            // Empate: não inicia, avisa todo mundo e espera alguém trocar o voto.
            io.emit('bossVoteTie', topBossIds.map(id => (bosses.find(b => b.id === id) || {}).name).filter(Boolean));
        } else if (topBossIds.length === 1) {
            beginMatchWithBoss(topBossIds[0]);
        }
    }
}

function beginMatchWithBoss(bossId) {
    activeBossDef = bosses.find(b => b.id === bossId) || DEFAULT_BOSS;
    gameState = 'PLAYING'; startTime = Date.now();
    boss = createBoss(activeBossDef);
    gameManager.level = 1; gameManager.objectivesCollected = 0; gameManager.speakCooldown = 300;
    npc.x = 1400; npc.y = 1450; npc.wpIndex = 0; npc.speechText = null; npc.speechTimer = 0; npc.speakCooldown = 150; npc.holdingId = null; npc.holdTimer = 0; npc.grabCooldown = 0;
    spawnNextObjective();
    io.emit('bossAlert', `Colete os ${gameManager.totalObjectives} itens espalhados e fuja do chefe!`);
    io.emit('gameStart', map);
}

io.on('connection', (socket) => {
    if(!gameEnabled) { socket.disconnect(); return; }
    if(gameState !== 'LOBBY') { socket.emit('gameFull'); socket.disconnect(); return; }

    let photoFiles = [];
    try {
        const fotosDir = path.join(__dirname, 'fotos');
        if (fs.existsSync(fotosDir)) {
            // Arquivos começando com "npc-" são reservados a personagens fixos
            // (ex: o trabalhador ambiente) e não aparecem como opção de avatar.
            photoFiles = fs.readdirSync(fotosDir).filter(file => /\.(jpg|jpeg|png|webp)$/i.test(file) && !/^(npc-|boss)/i.test(file));
        }
    } catch (e) { console.log("Erro ao ler pasta de fotos."); }
    socket.emit('photoList', photoFiles);
    socket.emit('bossesList', publicBossList());

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
            socket.emit('errorMsg', 'Escolha uma foto antes de avançar!');
            return;
        }
        p.ready = isReady;
        io.emit('lobbyUpdate', Object.values(players));
        checkGameStart();
    });

    // Votação do boss: cada jogador clica no card do boss que quer, podendo
    // trocar o voto livremente até a partida começar. Quando todos votarem,
    // ou o boss mais votado assume, ou (em empate) espera alguém mudar de voto.
    socket.on('voteBoss', (bossId) => {
        if (gameState !== 'BOSS_VOTE' || !players[socket.id]) return;
        if (!bosses.find(b => b.id === bossId)) return;
        bossVotes[socket.id] = bossId;
        broadcastVoteState();
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

    socket.on('disconnect', () => {
        delete players[socket.id];
        delete bossVotes[socket.id];
        // Só reemite o lobby-grid se ainda estivermos no lobby — durante a
        // votação/partida isso é tratado por broadcastVoteState/syncState,
        // pra não jogar todo mundo de volta pra tela de lobby sem necessidade.
        if (gameState === 'LOBBY') io.emit('lobbyUpdate', Object.values(players));
        else if (gameState === 'BOSS_VOTE') broadcastVoteState();
        if(Object.keys(players).length === 0) resetGame();
    });
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
    // Todo mundo "avançou" (pronto + avatar escolhido): em vez de começar a
    // partida direto, agora abre a votação do boss.
    if(gameState === 'LOBBY' && pList.length > 0 && pList.every(p => p.ready && p.avatar)) {
        startBossVote();
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
    bossVotes = {};
    activeBossDef = DEFAULT_BOSS;
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
        p.inputs = { up: false, down: false, left: false, right: false, run: false, sneak: false };
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
            let patrolPhrases = (activeBossDef.phrasesPatrol && activeBossDef.phrasesPatrol.length) ? activeBossDef.phrasesPatrol : BOSS_PATROL_PHRASES;
            bossSay(patrolPhrases[Math.floor(Math.random() * patrolPhrases.length)]);
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
        if(boss.state !== 'CHASE') { io.emit('audioPlay', 'bossSpot'); bossSay(activeBossDef.phraseSpot); }
        boss.state = 'CHASE'; boss.targetId = closestP.id;
    } else if(boss.state === 'CHASE') { boss.state = 'SEARCH'; boss.targetId = null; }

    pList.forEach(p => {
        if(!p.isDead && !p.isHidden && rectIntersect(p, boss)) {
            p.isDead = true; p.isHidden = false; bossSay(activeBossDef.phraseCatch); io.emit('playerCaught', { id: p.id, name: p.name }); checkEndGameCondition();
        }
    });

    io.emit('syncState', { players: players, boss: boss, npc: npc, gameManager: gameManager, mapExit: map.exit, time: Math.floor((Date.now() - startTime) / 1000) });

    } catch (err) {
        console.error('[game loop] erro num tick, esse frame foi ignorado mas o servidor continua rodando:', err);
    }
}, 1000 / 30);

server.listen(3000, () => console.log(`Servidor rodando na porta 3000`));
