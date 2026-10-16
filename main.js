const { app, BrowserWindow, ipcMain, shell, clipboard, screen, desktopCapturer, globalShortcut, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const si = require('systeminformation');
const { loadSkills } = require('./skills');
const { YTMusic } = require('./lib/ytmusic');
const { PhoneCam } = require('./lib/phonecam');
const { findLyrics } = require('./lib/lyrics');
const { Telegram } = require('./lib/telegram');
const { PcInput } = require('./lib/pcinput');
const { AudioBridge } = require('./lib/audiobridge');
const fileread = require('./lib/fileread');
const { deepThink, summarize: deepSummarize } = require('./lib/deepthink');

// Fone pelo celular (WebRTC): o PC anuncia o IP real em vez de um nome ".local" (padrão de privacidade do
// Chromium). Sem isso o iPhone não acha o PC, principalmente pelo Tailscale.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

const NVIDIA_BASE = 'https://integrate.api.nvidia.com/v1';
const VOICE_PORT = 8765;
const MAX_HISTORY = 30;
const MAX_TOOL_ROUNDS = 6;

// Ordem de preferência quando o modelo configurado deixa de existir. A NVIDIA aposenta modelos com
// frequência (super-120b saiu em 03/10/2026); se nenhum destes funcionar, a lista atual é consultada na hora.
const FALLBACK_MODELS = [
  'nvidia/nemotron-3-ultra-550b-a55b',
  'nvidia/nemotron-3.5-lightning-30b-a3b',
];

// ------------------------------------------------------------ persistência

// Dados ficam no próprio projeto (o disco C: está sem espaço)
app.setPath('userData', path.join(__dirname, 'data'));
const dataDir = app.getPath('userData');
const files = {
  config: path.join(dataDir, 'config.json'),
  history: path.join(dataDir, 'history.json'),
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

const DEFAULT_CONFIG = {
  apiKey: process.env.NVIDIA_API_KEY || '',
  model: 'nvidia/nemotron-3-ultra-550b-a55b',
  userName: 'senhor',
  city: 'São Paulo',
  voice: 'pt-BR-AntonioNeural',
  wakeThreshold: 0.5,
  whisperModel: 'base',
  followUp: true,
  ytmPath: 'E:\\Apps\\YouTubeMusic\\YouTube Music.exe',
  ytmToken: '',
  projectsDir: 'E:\\Projetos',
  currentProject: '',
  githubToken: '',
  visionModel: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
  // Esforço máximo: modelo rápido para gerar e avaliar as abordagens em paralelo (a resposta final usa o `model`)
  fastModel: 'nvidia/nemotron-3-super-120b-a12b',
  hotkeyListen: 'Control+Alt+J',
  hotkeyToggle: 'Control+Alt+K',
  miniOrb: true,
  miniPos: null,
  disabledSkills: [],
  phoneEnabled: false,
  phoneToken: '',
  telegramToken: '',
  telegramChatId: null,
  telegramUser: '',
  telegramAlerts: true,
  bargeIn: true,      // interromper o JARVIS falando por cima
  voiceFx: true,      // efeito de voz de IA
  bootGreeting: true, // abertura falada ao iniciar
};
let config = { ...DEFAULT_CONFIG, ...readJson(files.config, {}) };
let history = readJson(files.history, []);
const saveConfig = () => writeJson(files.config, config);

// ------------------------------------------------------------ janela

let win;
let mini; // orb flutuante que aparece quando a janela principal é minimizada
let oficinaWin = null; // janela dedicada da Oficina (normalmente no segundo monitor)

// Eventos que o mini-orb também precisa receber
const MINI_CHANNELS = new Set(['voice-status', 'mic-level', 'speak-level', 'ai-start', 'ai-delta', 'ai-done', 'focus']);

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  // o celular também acompanha as tarefas
  if (channel === 'tasks' && typeof phonecam !== 'undefined') phonecam.send({ t: 'tasks', tasks: payload });
  // ...e, para o modo carro, os lembretes e o resumo das agentes
  if (channel === 'reminders' && typeof phonecam !== 'undefined') phonecam.send({ t: 'reminders', reminders: payload });
  if (channel === 'agent' && typeof pushAgentsToPhone === 'function') pushAgentsToPhone();
  if (typeof telegramHook === 'function') telegramHook(channel, payload);
  if (MINI_CHANNELS.has(channel) && mini && !mini.isDestroyed() && mini.isVisible()) mini.webContents.send(channel, payload);
  // a janela da Oficina acompanha todos os eventos ao vivo
  if (oficinaWin && !oficinaWin.isDestroyed()) oficinaWin.webContents.send(channel, payload);
}
const toast = (text, type = 'ok') => send('toast', { type, text });

const APP_ICON = path.join(__dirname, 'src', 'assets', 'icon.png');

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 820,
    minHeight: 560,
    frame: false,
    backgroundColor: '#050505',
    icon: APP_ICON,
    title: 'J.A.R.V.I.S.',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // continua falando/animando mesmo minimizado
    },
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.on('minimize', () => showMini(true));
  win.on('hide', () => showMini(true));
  win.on('restore', () => showMini(false));
  win.on('show', () => showMini(false));
  // Fechar a janela principal encerra tudo: o mini-orb é outra janela e impediria o app de sair
  win.on('closed', () => {
    if (mini && !mini.isDestroyed()) mini.destroy();
    if (oficinaWin && !oficinaWin.isDestroyed()) oficinaWin.destroy();
    audioBridge.stop('janela fechada'); // a janela invisível do fone também impediria o app de sair
  });
}

const MINI_SIZE = { width: 320, height: 200 };

function createMini() {
  const { workArea } = screen.getPrimaryDisplay();
  const pos = config.miniPos || { x: workArea.x + workArea.width - MINI_SIZE.width - 16, y: workArea.y + workArea.height - MINI_SIZE.height - 16 };
  mini = new BrowserWindow({
    ...MINI_SIZE, ...pos,
    frame: false, transparent: true, resizable: false, alwaysOnTop: true, skipTaskbar: true,
    focusable: false, hasShadow: false, show: false, title: 'JARVIS mini',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  mini.setAlwaysOnTop(true, 'floating');
  // A área transparente deixa os cliques passarem; o renderer liga os cliques só em cima do orb
  mini.setIgnoreMouseEvents(true, { forward: true });
  mini.loadFile(path.join(__dirname, 'src', 'mini.html'));
}

function showMini(visible) {
  if (!mini || mini.isDestroyed()) return;
  if (visible && config.miniOrb !== false) {
    // Se o monitor onde ele estava foi desconectado, volta para o canto da tela principal
    const [x, y] = mini.getPosition();
    const onScreen = screen.getAllDisplays().some(({ workArea: a }) => x + 40 > a.x && x < a.x + a.width - 40 && y + 40 > a.y && y < a.y + a.height - 40);
    if (!onScreen) {
      const { workArea: a } = screen.getPrimaryDisplay();
      mini.setPosition(a.x + a.width - MINI_SIZE.width - 16, a.y + a.height - MINI_SIZE.height - 16);
    }
    mini.showInactive();
  } else mini.hide();
}

// Sobreposição transparente por cima de um monitor (identificar monitores, brilho onde a janela chegou).
// Recebe retângulos em pixels físicos (vêm da API do Windows) e converte para as coordenadas do Electron.
const OVERLAY_CSS = `html,body{margin:0;height:100%;overflow:hidden;background:transparent;font-family:Michroma,'Segoe UI',sans-serif}
@keyframes inout{0%{opacity:0;transform:scale(1.08)}12%{opacity:1;transform:none}80%{opacity:1}100%{opacity:0}}
.id{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
background:radial-gradient(ellipse at center,rgba(0,0,0,.62),rgba(0,0,0,.25) 60%,transparent);animation:inout 3.8s ease both}
.num{font-size:360px;line-height:1;color:#fbf1e1;text-shadow:0 0 60px rgba(233,214,182,.6),0 0 4px #e9d6b6}
.lbl{margin-top:14px;font-size:22px;letter-spacing:.4em;color:#e9d6b6;text-transform:uppercase}
.here{margin-top:10px;font-size:14px;letter-spacing:.3em;color:#e2a04a}
.frame{position:absolute;border:2px solid #fbf1e1;border-radius:6px;box-shadow:0 0 30px rgba(233,214,182,.7),inset 0 0 30px rgba(233,214,182,.35);animation:inout 1.5s ease both}
.tag{position:absolute;padding:4px 12px;background:rgba(0,0,0,.75);border-left:2px solid #e9d6b6;color:#fbf1e1;font-size:13px;letter-spacing:.2em;animation:inout 1.5s ease both}`;
function monitorOverlay(spec) {
  const esc = (s) => String(s || '').replace(/[<>&"]/g, '');
  for (const d of screen.getAllDisplays()) {
    const phys = screen.dipToScreenRect(null, d.bounds);
    let body = '', ms = 4000;
    if (spec.kind === 'identify') {
      const m = spec.monitors.find((x) => Math.abs(x.rect.x - phys.x) < 4 && Math.abs(x.rect.y - phys.y) < 4);
      if (!m) continue;
      body = `<div class="id"><div class="num">${m.number}</div><div class="lbl">${esc(m.label) || 'monitor'}</div>${m.here ? '<div class="here">VOCÊ ESTÁ AQUI</div>' : ''}</div>`;
    } else if (spec.kind === 'highlight') {
      const r = spec.rect;
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      if (cx < phys.x || cx >= phys.x + phys.width || cy < phys.y || cy >= phys.y + phys.height) continue;
      const dip = screen.screenToDipRect(null, { x: r.x, y: r.y, width: r.w, height: r.h });
      const x = dip.x - d.bounds.x, y = dip.y - d.bounds.y;
      body = `<div class="frame" style="left:${x + 4}px;top:${y + 4}px;width:${dip.width - 12}px;height:${dip.height - 12}px"></div>`
        + `<div class="tag" style="left:${x + 18}px;top:${y + 18}px">${esc(spec.label)}</div>`;
      ms = 1700;
    } else continue;
    const ov = new BrowserWindow({
      ...d.bounds, title: 'jarvis-overlay', frame: false, transparent: true, resizable: false, movable: false,
      focusable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true, show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    ov.setIgnoreMouseEvents(true);
    ov.setAlwaysOnTop(true, 'screen-saver');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>jarvis-overlay</title><link href="https://fonts.googleapis.com/css2?family=Michroma&display=swap" rel="stylesheet"><style>${OVERLAY_CSS}</style></head><body>${body}</body></html>`;
    ov.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    ov.once('ready-to-show', () => ov.showInactive());
    setTimeout(() => { if (!ov.isDestroyed()) ov.destroy(); }, ms);
  }
}

function toggleMain() {
  if (!win) return;
  if (win.isMinimized() || !win.isVisible()) { win.show(); win.restore(); win.focus(); }
  else win.minimize();
}

// ------------------------------------------------------------ skills

const ytm = new YTMusic({
  getToken: () => config.ytmToken,
  setToken: (t) => { config.ytmToken = t; saveConfig(); },
  exePath: config.ytmPath,
});

let skills; // carregadas em app.whenReady (algumas usam APIs do Electron)

// Token fixo do celular: o link salvo nos favoritos continua valendo depois de reiniciar
if (!config.phoneToken) { config.phoneToken = require('crypto').randomBytes(12).toString('hex'); saveConfig(); }
const phonecam = new PhoneCam(dataDir, config.phoneToken);
phonecam.on('message', (m) => onPhoneMessage(m).catch((e) => console.error('[celular]', e)));
let lastFrameSent = 0;
phonecam.on('connected', () => {
  send('camera-state', { connected: true });
  toast('Câmera do celular conectada.');
});
phonecam.on('disconnected', () => { phoneDrive = false; send('camera-state', { connected: false }); audioBridge.stop('celular desconectou'); });

// ---- Fone pelo celular: som do PC no fone Bluetooth do celular + microfone do fone no lugar do mic do PC
const audioBridge = new AudioBridge({
  phone: phonecam,
  voicePcm: (buf) => { if (pyWs && pyWs.readyState === WebSocket.OPEN) pyWs.send(buf); },
});
audioBridge.on('state', ({ state }) => {
  if (state === 'connected') toast('🎧 Som do PC indo para o celular (caixas do PC mudas).');
  else if (state === 'off') toast('🔊 Som de volta às caixas do PC.');
});
audioBridge.on('mic', (on) => toast(on ? '🎙 Microfone do fone ativo: diga "Hey Jarvis".' : '🎙 Microfone do PC de volta.'));

// ---- JARVIS Drive (modo carro no celular)
let phoneDrive = false;
const DRIVE_NOTE = `O usuário está DIRIGINDO (modo carro do celular). Segurança em primeiro lugar:
- Responda com UMA frase curta. Nada de listas, números longos, links, códigos ou detalhes.
- Nunca mostre painéis, gráficos ou textos para ler. Se algo exigir leitura ou atenção, diga que deixa para quando ele parar (e crie uma tarefa se fizer sentido).
- Rotas ("me leva para...", "como chego em...") → drive_navigate. Agenda = lembretes e tarefas. "Como estão as agentes?" → code_task_status, resumido em uma frase.

`;
// Resumo das agentes para o bloco "Projetos" do modo carro (no máximo a cada 3 s)
let agentsPushTimer = null;
function pushAgentsToPhone() {
  if (agentsPushTimer || !phonecam.connected) return;
  agentsPushTimer = setTimeout(() => {
    agentsPushTimer = null;
    const api = skills.get('codeagent').api;
    const names = Object.fromEntries(api.agents().map((a) => [a.id, a.short]));
    const list = api.list().filter((j) => !j.hidden && (j.status === 'running' || (j.status === 'done' && j.files?.length && !j.lab) || (j.status === 'failed' && Date.now() - (j.finishedAt || 0) < 3600000)))
      .map((j) => ({ agent: names[j.agent], project: j.lab ? 'laboratório' : j.project, status: j.status, phase: j.phase }));
    phonecam.send({ t: 'agents', list });
  }, 3000);
}
// Na primeira vez que o Tailscale conecta, o link do modo carro vai para o Telegram (é só tocar no celular)
function sendDriveLink(tries = 0) {
  const info = phonecam.info();
  if (!info.driveUrl || config.driveLinkSent) return;
  // o bot do Telegram pode ainda estar iniciando: tenta de novo por alguns minutos
  if (!telegram || telegramState.status !== 'paired') { if (tries < 10) setTimeout(() => sendDriveLink(tries + 1), 20000); return; }
  telegram.send(`🚗 <b>JARVIS Drive</b> pronto!\n\nAbra este link no celular (com o Tailscale ligado), aceite o aviso de segurança uma vez e adicione à tela inicial:\n${info.driveUrl}`)
    .then(() => { config.driveLinkSent = true; saveConfig(); }).catch(() => {});
}
phonecam.on('remote', (info) => {
  console.log('[celular] Tailscale:', info.remoteUrl);
  send('phone-remote', info);
  sendDriveLink();
});

phonecam.on('frame', (jpeg) => {
  // O HUD recebe no máximo ~8 quadros por segundo
  const oficinaOpen = oficinaWin && !oficinaWin.isDestroyed();
  if (Date.now() - lastFrameSent < 120 || ((!win || win.isMinimized()) && !oficinaOpen)) return;
  lastFrameSent = Date.now();
  send('camera-frame', jpeg.toString('base64'));
});

const skillCtx = {
  get config() { return config; },
  turnId: 0, // incrementa a cada fala do usuário (usado nas confirmações)
  readClipboard: () => clipboard.readText(),
  lookAtScreen: (question) => lookAtScreen(question),
  vision: (question, jpegBase64) => visionAsk(question, jpegBase64),
  captureScreen: () => captureScreen(),
  sendScreensToTelegram: () => sendScreens(),
  oficinaWindow: (open) => (open ? openOficinaWindow() : (closeOficinaWindow(), { ok: true })),
  oficinaWindowOpen: () => !!(oficinaWin && !oficinaWin.isDestroyed()),
  get phoneDrive() { return phoneDrive && phonecam.connected; },
  focusApi: () => skills.get('focus')?.api,
  sendTelegram: (text) => (telegram ? telegram.send(text) : Promise.reject(new Error('Telegram desligado'))),
  phonecam,
  complete: (prompt, opts) => complete(prompt, opts),
  chatWithTools: (messages, tools, opts) => chatWithTools(messages, tools, opts),
  runTool: (name, args) => skills.run(name, args),
  saveConfig,
  dataDir,
  readJson,
  writeJson,
  send,
  toast,
  ytm,
  announce: (text, opts) => announce(text, opts),
  synthesize: (text, opts) => synthesize(text, opts),
  monitorOverlay: (spec) => monitorOverlay(spec),
  get forgeState() { return forgeState; },
  streamText: (prompt, onText, signal, opts) => streamText(prompt, onText, signal, opts),
  get docState() { return docState; },
  notifyRemote: (text, opts) => notifyRemote(text, opts),
  channel: 'pc',
};

// ------------------------------------------------------------ serviço de voz (Python)

let pyProc = null;
let pyWs = null;
let voiceReady = false;

function startVoiceService() {
  const venvPython = path.join(__dirname, '.venv', 'Scripts', 'python.exe');
  const pythonExe = fs.existsSync(venvPython) ? venvPython : 'python';
  pyProc = spawn(pythonExe, [path.join(__dirname, 'python', 'voice_service.py')], {
    cwd: __dirname,
    env: { ...process.env, JARVIS_PORT: String(VOICE_PORT), JARVIS_WHISPER: config.whisperModel, PYTHONIOENCODING: 'utf-8' },
    windowsHide: true,
  });
  pyProc.stderr.on('data', (d) => console.log(d.toString().trimEnd()));
  pyProc.stdout.on('data', (d) => console.log(d.toString().trimEnd()));
  pyProc.on('exit', (code) => {
    console.log('[voice] processo encerrado', code);
    voiceReady = false;
    send('voice-status', { state: 'offline' });
  });
  connectVoice();
}

function connectVoice() {
  const ws = new WebSocket(`ws://127.0.0.1:${VOICE_PORT}`);
  ws.on('open', () => {
    pyWs = ws;
    voiceSend({ cmd: 'config', voice: config.voice, wake_threshold: config.wakeThreshold });
  });
  ws.on('message', (raw) => onVoiceEvent(JSON.parse(raw.toString())));
  ws.on('close', () => {
    pyWs = null;
    if (pyProc && pyProc.exitCode === null) setTimeout(connectVoice, 1000);
  });
  ws.on('error', () => {});
}

function voiceSend(msg) {
  if (pyWs && pyWs.readyState === WebSocket.OPEN) pyWs.send(JSON.stringify(msg));
}

// Transcreve áudio que chegou de fora (microfone do celular, voz do Telegram) usando o Whisper do serviço de voz
const transcribeWaiters = new Map();
let transcribeCounter = 0;
function transcribeAudio(buffer) {
  return new Promise((resolve, reject) => {
    if (!pyWs) { reject(new Error('serviço de voz desligado')); return; }
    const id = ++transcribeCounter;
    transcribeWaiters.set(id, { resolve, reject });
    voiceSend({ cmd: 'transcribe', id, data: buffer.toString('base64') });
    setTimeout(() => { if (transcribeWaiters.delete(id)) reject(new Error('a transcrição demorou demais')); }, 60000);
  });
}

// Abaixa a música enquanto o JARVIS está ouvindo/falando e devolve quando ele volta a esperar
function assistantActive(active) {
  if (!config.ytmToken) return;
  (active ? ytm.duck() : ytm.unduck()).catch(() => {});
}

function onVoiceEvent(ev) {
  switch (ev.event) {
    case 'ready':
      voiceReady = true;
      send('voice-status', { state: 'idle' });
      if (!greeted) { greeted = true; setTimeout(bootGreeting, 1500); }
      break;
    case 'status':
      send('voice-status', { state: 'loading', message: ev.message });
      break;
    case 'wake':
      assistantActive(true);
      send('voice-status', { state: 'wake' });
      break;
    case 'listening':
      assistantActive(true);
      send('voice-status', { state: 'listening' });
      break;
    case 'processing':
      send('voice-status', { state: 'processing' });
      break;
    case 'no_speech':
      assistantActive(false);
      send('voice-status', { state: 'idle' });
      break;
    case 'level':
      send('mic-level', ev.value);
      break;
    case 'barge_in':
      // O usuário falou por cima: corta a resposta atual (ele já está gravando o novo pedido)
      if (currentAbort) currentAbort.abort();
      currentAbort = null;
      busy = false;
      send('barge-in');
      break;
    case 'transcript':
      handleUserInput(ev.text, { fromVoice: true });
      break;
    case 'audio':
      // Respostas de pedidos feitos pelo celular tocam no celular, não no PC
      if (ttsWaiters.has(ev.id)) {
        const w = ttsWaiters.get(ev.id);
        ttsWaiters.delete(ev.id);
        if (ev.error || !ev.data) w.reject(new Error(ev.error || 'TTS vazio')); else w.resolve({ data: ev.data, words: ev.words || [] });
      } else if (phoneTts.delete(ev.id)) phonecam.send({ t: 'audio', data: ev.data });
      else send('tts-audio', { id: ev.id, data: ev.data });
      break;
    case 'ogg': {
      const w = oggWaiters.get(ev.id);
      if (!w) break;
      oggWaiters.delete(ev.id);
      if (ev.error || !ev.data) w.reject(new Error(ev.error || 'OGG vazio')); else w.resolve(ev.data);
      break;
    }
    case 'transcription': {
      const w = transcribeWaiters.get(ev.id);
      if (!w) break;
      transcribeWaiters.delete(ev.id);
      if (ev.error && !ev.text) w.reject(new Error(ev.error)); else w.resolve(ev.text || '');
      break;
    }
    case 'error':
      toast(ev.message, 'error');
      break;
  }
}

// ------------------------------------------------------------ IA (Nemotron + tool calling)

const CHANNEL_NOTE = {
  telegram: 'Este pedido chegou pelo TELEGRAM: o usuário está longe do PC e vai LER a resposta (não há voz; ignore a regra de respostas faladas abaixo). Pode usar listas curtas e ser um pouco mais completo, sem exagero.\n\n',
  phone: 'Este pedido chegou pelo app do CELULAR do usuário (ele pode estar longe da tela do PC).\n\n',
};

const TG_VOICE_NOTE = 'Este pedido chegou por MENSAGEM DE VOZ no Telegram e a sua resposta vai virar ÁUDIO com a sua voz (como um rádio): fale de 1 a 3 frases naturais, sem listas, sem markdown, sem emojis e sem links.\n\n';
let tgVoiceTurn = false; // o pedido atual do Telegram veio por áudio
let chatTurn = false; // o pedido atual foi DIGITADO na tela de Chat

const CHAT_NOTE = `O usuário DIGITOU na tela de Chat do JARVIS (estilo ChatGPT) e vai LER a resposta. Esqueça a regra de respostas faladas e curtas: responda de forma completa e bem organizada, sem enrolar, usando markdown (títulos ##, listas, **negrito**, tabelas markdown, blocos de código com a linguagem). Explicações de código vão direto na resposta (não precisa de show_in_chat).
Deixe o chat rico quando ajudar de verdade: números, comparações e evolução no tempo → show_visual (os cards aparecem DENTRO do chat); fotos de algo → show_images; levantar requisitos, enquete, quiz ou várias perguntas → chat_ask; uma pergunta com 2 a 4 respostas → offer_choices.

`;
const CHAT_SCREEN_NOTE = 'O usuário está com a tela de Chat aberta: show_visual, show_images e chat_ask aparecem dentro da conversa.\n\n';

function systemPrompt(channel = 'pc') {
  const now = new Date();
  return `Você é J.A.R.V.I.S., a inteligência artificial pessoal de ${config.userName}, inspirada no assistente do Tony Stark.
Personalidade: elegante, educado, levemente sarcástico e espirituoso, extremamente competente. Trate o usuário por "${config.userName}".
O usuário é programador e ouve música no YouTube Music enquanto trabalha.
Idioma: sempre português do Brasil.

${channel === 'telegram' && tgVoiceTurn ? TG_VOICE_NOTE : CHANNEL_NOTE[channel] || ''}${channel === 'pc' ? (chatTurn ? CHAT_NOTE : uiScreen === 'chat' ? CHAT_SCREEN_NOTE : '') : ''}${channel === 'phone' && phoneDrive ? DRIVE_NOTE : ''}${forgeState.active ? `O usuário está com o modelo 3D "${forgeState.model}" aberto em tela cheia${forgeState.selected ? `, com a peça "${forgeState.selected.nome}" (grupo ${forgeState.selected.grupo}) selecionada` : ''}. "Essa peça" = a selecionada. Para mexer no modelo use holo3d_control.\n\n` : ''}${docState.active ? `O usuário está ASSISTINDO a um documentário narrado por você sobre "${docState.title}", agora pausado na cena "${docState.scene || ''}" (última fala: "${docState.line || ''}"${docState.entities?.length ? `; na tela: ${docState.entities.join(', ')}` : ''}). Perguntas como "quem é essa pessoa?" ou "explica melhor" se referem a essa cena: chame documentary_aside (com busca = artigo da Wikipedia do assunto) para mostrar um cartão e responda falando em 2 a 3 frases; termine lembrando que ele pode dizer "continua". Para controlar o documentário use documentary_control.${docState.quiz?.waiting ? ` AGORA o documentário está no QUIZ final esperando a resposta (A: ${docState.quiz.options[0]}; B: ${docState.quiz.options[1]}; C: ${docState.quiz.options[2]}). Se a fala for uma resposta, chame documentary_control com action "answer" e choice (0=A, 1=B, 2=C) e não fale nada.` : ''}

` : ''}Suas respostas são FALADAS em voz alta: seja breve (1 a 2 frases na maioria dos casos), natural, sem markdown, sem listas, sem emojis, sem rubricas como "(risos)" ou "*pausa*". Escreva números e siglas como devem ser falados quando ajudar a pronúncia.

Como responder (padrão de assistente premium):
- A resposta vem na primeira frase. Nada de "Claro!", "Com certeza!", "Ótima pergunta" nem repetir o pedido de volta.
- Entenda o que ele quer de verdade e, quando fizer sentido, antecipe o próximo passo útil (ex.: vai chover → sugira o guarda-chuva), sem sermão.
- Pedido ambíguo em que errar custaria caro ou irritaria: não chute, chame offer_choices com 2 a 4 caminhos e pergunte em uma frase. Se for barato corrigir, escolha o mais provável e faça.
- REGRA: sempre que for terminar com uma pergunta cujas respostas prováveis cabem em 2 a 4 opções, chame offer_choices com essas opções no MESMO turno (o usuário clica em vez de digitar). Pergunta sem botões só quando a resposta for livre (um nome, um texto).
- Quando houver próximos passos naturais (depois de uma pesquisa: aprofundar, comparar, salvar nas notas; depois de explicar um erro: aplicar a correção), ofereça com offer_choices em vez de terminar com "quer mais alguma coisa?". Só quando ajudar de verdade, não em toda resposta.
- Honestidade: se não tiver certeza, diga o grau de confiança em poucas palavras; se não conseguir, diga o que faltou e ofereça uma alternativa.
- Varie o jeito de começar as frases entre uma resposta e outra.

Data e hora atuais: ${now.toLocaleString('pt-BR', { dateStyle: 'full', timeStyle: 'short' })}.
Cidade do usuário: ${config.city}.
${skillCtx.memory ? skillCtx.memory.promptBlock() : ''}${skillCtx.projectMemory ? skillCtx.projectMemory.promptBlock() : ''}${skillCtx.knowledge ? skillCtx.knowledge.promptBlock(skillCtx.lastUserText, skillCtx.turnId) : ''}
Memória: quando o usuário contar algo duradouro sobre ele (preferências, gostos, rotina, pessoas, datas importantes, tecnologias), guarde com memory_remember sem anunciar demais. Use o que você sabe para personalizar as respostas.

Ferramentas:
- Use as ferramentas sempre que o pedido envolver uma ação ou informação atual. Nunca invente resultados.
- NUNCA diga que fez algo (tocar, pular, pausar, ajustar volume, abrir, criar lembrete) sem ter chamado a ferramenta neste turno. Cada novo pedido exige uma nova chamada, mesmo que seja parecido com um anterior.
- Para saber o que está tocando, chame music_now_playing (a música muda sozinha; não confie no histórico).
- Chame a ferramenta direto, sem anunciar antes. Depois do resultado, confirme em uma frase curta (ex: "Tocando Numb, do Linkin Park.").
- Se uma ferramenta falhar, explique o problema em poucas palavras.
- Programação: o usuário guarda os projetos em ${config.projectsDir}. Projeto atual: ${config.currentProject ? path.basename(config.currentProject) : 'nenhum'}. Ao explicar código/erros, fale só um resumo de 1 a 2 frases e mande o detalhe (código, passos) com show_in_chat.
- Dossiês (o que o usuário te ENSINOU sobre um assunto: empresa, projeto, cliente): "aprende isso sobre X", "anota no dossiê de X" → knowledge_teach. Assunto com dossiê listado mas fora do contexto → knowledge_read. Arquivos anexados aparecem na mensagem do usuário como [Arquivo anexado] ou [Imagem anexada]; responda sobre eles direto. Se ele pedir para guardar um anexo como conhecimento, use knowledge_teach com o conteúdo relevante organizado.
- Memória dos projetos: "onde eu parei?", "o que eu tava fazendo no X?", "me situa", "retoma o projeto" → project_recap. Quando ele DECIDIR algo sobre um projeto (tecnologia, arquitetura, regra de produto) ou explicar o que o projeto é → project_memory_save, sem anunciar demais. Pendência de projeto ("falta fazer o login") → task_add com project. Ao abrir um projeto que tem memória, mencione em meia frase onde ele parou.
- Ações sensíveis (commit, push, matar processo): chame a ferramenta direto, sem perguntar antes; ela devolve needs_confirmation. Aí pergunte "Confirma?" e, se o usuário disser sim, chame de novo com args_after_yes.
- "Bom dia", "briefing", "novidades" → briefing_show (mostra cards animados na tela). Modo foco/pomodoro → focus_start.
- Tarefas ("preciso fazer X", "adiciona na lista") → task_add; ideias soltas ("anota que...") → note_add.
- "Modo oficina", "abre a oficina no outro monitor" → workshop_window(open=true); "fecha a oficina" → workshop_window(open=false). "Mostra a oficina aqui" → open_screen(oficina).
- "Conte a história de X", "faz um documentário sobre X", "me apresenta X como documentário" → documentary_start (tela cheia com narração e imagens). Não narre você mesmo.
- "Onde fica X?", "me mostra X no mapa", rotas, distâncias, "onde aconteceu X" → map_show (mapa vivo narrado). Com o mapa aberto, outra pergunta sobre lugar ("e Pripyat?") → map_show de novo.
- Monitores e janelas (o usuário tem 2 monitores; "aqui" = onde o mouse está, "ali"/"lá" = o outro): "joga isso ali", "leva o vídeo pro outro monitor", "código aqui e documentação lá" (várias janelas numa chamada só) → window_move. Minimizar/maximizar/focar → window_action. "Identifica os monitores", "o que está aberto?" → monitors_info.
- "Desliga o PC", "reinicia", "desliga daqui a 30 minutos", "coloca pra dormir" → pc_power (pede confirmação sozinho). "Cancela o desligamento", "não desliga" → pc_power_cancel.
- Modelos 3D desmontáveis em tela cheia ("me mostra um motor V8 em 3D", "abre o reator arc", "quero ver por dentro") → holo3d_show. Com o modelo aberto: "desmonta", "monta", "isola os pistões", "corta ao meio", "acelera", "para", "o que é essa peça?" → holo3d_control.
- "Mostra um holograma" /"projeta o reator arc / a Terra / o sistema solar / um átomo / o DNA" → hologram_show; "fecha o holograma" → hologram_close.
- Pedidos para ESCREVER/ALTERAR código ou CRIAR um projeto/site/app ("cria um endpoint", "corrige o bug X", "cria um site de petshop") → code_task. Você tem uma equipe de 3 agentes de código (FRIDAY, EDITH, KAREN) que trabalham em paralelo, acompanhadas na Oficina: para vários projetos no mesmo pedido, chame code_task uma vez para CADA projeto. "Aplica o da Friday" → code_task_accept(agent); "descarta" → code_task_discard; "pede pra Edith deixar o tema azul" → code_task_adjust; "como estão as agentes?" → code_task_status.
- Se o usuário falar em CODEX ("pede pro Codex criar...", "abre o Codex e faz...", "manda o Codex...") → codex_task (NÃO code_task): você abre o projeto no VS Code e o Codex faz o trabalho; você avisa quando ele terminar. Projeto novo → new_project. Ajuste no que o Codex acabou de fazer ("agora pede pra ele deixar azul") → codex_task com follow_up=true. "O Codex terminou?" / "o que o Codex fez?" → codex_status; "para o Codex" → codex_cancel.
- "Liga a presença", "fica de olho se eu estou na mesa", "me avisa da postura" → presence_start. "Há quanto tempo estou sentado?" → presence_status. "Calibra minha postura" → presence_calibrate. "Me lembra de levantar a cada 40 minutos" → presence_settings.
- "Tenho uma ideia", "prototipa", "faz um MVP rapidinho de..." (testar uma ideia, sem pedir projeto no disco) → lab_start: protótipo instantâneo no navegador, montado ao vivo.${skillCtx.labPrompt?.() || ''}
- Pesquisa: pergunta rápida ou fato atual → web_search; "pesquisa a fundo", assunto amplo ou quando ele quer entender bem → research_deep; "compara A e B", "qual é melhor" → compare (bibliotecas JS: kind=npm; Python: kind=pypi); "resume esse link/artigo" → read_link; "quem é / o que é" (pessoa, lugar, empresa, conceito) → knowledge_card.
- Respostas visuais: comparações, números, rankings, evolução no tempo ou "me mostra" → show_visual (ou currency_chart / project_dashboard). Fale só o principal; o detalhe fica na tela.
- Celular: "conecta o celular/a câmera" → camera_connect. Saindo de casa ("vou sair, vigia o quarto") → sentinel_start; ao voltar → sentinel_stop. Desenho/rascunho de tela → sketch_to_code (ajustes depois: sketch_refine).
- Tela do iPhone no PC ("espelha meu iPhone", "quero ver a tela do celular", "para o espelhamento") → phone_mirror. Só dá para VER, não controlar (limite da Apple). "Joga o iPhone ali" → window_move com janela "iphone".
- Câmera do celular: "o que você está vendo", "olha isso" (algo físico) → camera_look. Para a TELA do computador use look_at_screen.
- Finanças: "gastei 45 no ifood", "paguei 120 de gasolina ontem", "recebi o salário de 3500" → finance_add (um por gasto; vários gastos numa frase = várias chamadas). "Apaga o último gasto" → finance_undo. "Quanto gastei esse mês?", "como estão minhas finanças?" → finance_summary. "Quanto gastei com uber?" → finance_list. "Meu limite de lazer é 300" → finance_budget. Contas fixas (cadastrar, "paguei a luz", "quais contas faltam?") → finance_bill.
- Música: para "toca X" use music_play escolhendo bem o kind (artista → artist, nome de música → song, "minha playlist X" → my_playlist, "minhas curtidas" → liked, gênero/clima → playlist).
${skillCtx.prevChoices ? `
Na sua resposta anterior apareceram estes botões: ${skillCtx.prevChoices.map((c, i) => `${i + 1}) "${c}"`).join('; ')}. Se o usuário disser "a primeira", "a segunda", "a última" etc., é a ordem destes botões.
` : ''}
LEMBRETE FINAL (vale para toda resposta): comece direto, sem "Claro", "Certo" ou "Com certeza". ${channel === 'telegram' && !tgVoiceTurn ? 'No Telegram pode usar listas curtas.' : 'Nada de markdown nem listas numeradas na resposta falada: se precisar de lista ou detalhe, mande com show_in_chat e fale só o essencial.'} Se a sua resposta termina perguntando algo com respostas previsíveis, chame offer_choices junto.`;
}

let currentAbort = null;
let busy = false;

// Servidores da NVIDIA às vezes respondem "ocupado" ou falham de forma passageira (429/5xx): tenta de novo antes de desistir
async function nvidiaFetch(endpoint, body, signal) {
  const waits = [1500, 4000];
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(NVIDIA_BASE + endpoint, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        Accept: body?.stream ? 'text/event-stream' : 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    if (![429, 500, 502, 503, 504].includes(res.status) || attempt >= waits.length || signal?.aborted) return res;
    console.log(`[ia] NVIDIA ${res.status}, tentando de novo em ${waits[attempt] / 1000}s`);
    await new Promise((r) => setTimeout(r, waits[attempt]));
  }
}

// Envia para a API e, se o modelo tiver sido aposentado (410) ou sumido da conta (404),
// troca para outro que funcione: primeiro a lista de reserva, depois os modelos que a NVIDIA oferece agora.
async function postChat(body, signal) {
  const send1 = async () => {
    let r = await nvidiaFetch('/chat/completions', body, signal);
    if (r.status === 400 && body.chat_template_kwargs) {
      delete body.chat_template_kwargs; // alguns modelos não aceitam
      r = await nvidiaFetch('/chat/completions', body, signal);
    }
    return r;
  };
  let res = await send1();
  if (res.status !== 404 && res.status !== 410) return res;

  const original = body.model;
  const tried = new Set([original]);
  const candidates = [...FALLBACK_MODELS, ...(await discoverChatModels().catch(() => []))];
  for (const m of candidates) {
    if (tried.has(m)) continue;
    tried.add(m);
    console.log(`[ia] modelo ${body.model} indisponível (${res.status}), tentando ${m}`);
    body.model = m;
    res = await send1();
    if (res.ok) {
      if (config.model === original) { config.model = m; saveConfig(); }
      if (config.codeModel === original) { config.codeModel = m; saveConfig(); }
      toast(`A NVIDIA aposentou o modelo ${original.split('/').pop()}. Agora usando ${m.split('/').pop()}.`);
      return res;
    }
    if (res.status !== 404 && res.status !== 410) return res;
  }
  return res;
}

// Modelos de conversa Nemotron disponíveis agora na conta (maiores primeiro)
async function discoverChatModels() {
  const res = await nvidiaFetch('/models');
  const { data } = await res.json();
  const rank = (id) => (/ultra/.test(id) ? 0 : /super/.test(id) ? 1 : /lightning/.test(id) ? 2 : /nano/.test(id) ? 3 : 4);
  return data.map((m) => m.id)
    .filter((id) => /nemotron/i.test(id) && !/embed|safety|reward|parse|guard|omni|vl|vision|rerank/i.test(id))
    .sort((a, b) => rank(a) - rank(b));
}

// Faz uma rodada de streaming. Devolve o texto e as chamadas de ferramenta pedidas pelo modelo.
// thinking: liga o raciocínio do Nemotron (esforço médio/máximo); ele chega em delta.reasoning_content,
// separado da resposta, e vai para onReasoning (a tela mostra "Pensando…")
async function streamCompletion(messages, onText, signal, { temperature = 0.6, thinking = false, maxTokens = 1024, onReasoning } = {}) {
  const body = {
    model: config.model,
    messages,
    stream: true,
    temperature,
    top_p: 0.95,
    frequency_penalty: 0.2, // reduz o risco de o modelo entrar em loop repetindo palavras
    max_tokens: maxTokens,
    tools: skills.definitions(config.disabledSkills),
    tool_choice: 'auto',
    chat_template_kwargs: { enable_thinking: thinking },
  };
  const res = await postChat(body, signal);
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`API NVIDIA ${res.status}: ${txt.slice(0, 200)}`);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let inThink = false;
  const calls = [];

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const l = line.trim();
      if (!l.startsWith('data:')) continue;
      const data = l.slice(5).trim();
      if (data === '[DONE]') continue;
      let delta;
      try { delta = JSON.parse(data).choices?.[0]?.delta; } catch { continue; }
      if (!delta) continue;
      if (delta.reasoning_content && onReasoning) onReasoning(delta.reasoning_content);

      for (const tc of delta.tool_calls || []) {
        const i = tc.index ?? calls.length;
        calls[i] = calls[i] || { id: tc.id || `call_${Date.now()}_${i}`, name: '', args: '' };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].name += tc.function.name;
        if (tc.function?.arguments) calls[i].args += tc.function.arguments;
      }

      const content = delta.content;
      if (!content) continue;
      // Remove blocos <think>...</think> caso o modelo raciocine em voz alta
      let out = '';
      let rest = content;
      while (rest) {
        if (inThink) {
          const end = rest.indexOf('</think>');
          if (end === -1) { rest = ''; } else { inThink = false; rest = rest.slice(end + 8); }
        } else {
          const start = rest.indexOf('<think>');
          if (start === -1) { out += rest; rest = ''; } else { out += rest.slice(0, start); inThink = true; rest = rest.slice(start + 7); }
        }
      }
      if (out) {
        text += out;
        // Modelo em loop ("ellsellsellsells..."): para na hora e deixa quem chamou tentar de novo
        if (text.length > 40 && /(.{2,10}?)\1{6,}$/s.test(text.slice(-160))) {
          const err = new Error('DEGENERATE');
          err.partial = text;
          throw err;
        }
        onText(out);
      }
    }
  }
  return { text, calls: calls.filter((c) => c && c.name) };
}

// Chamada simples (sem streaming nem ferramentas) para tarefas internas das skills
async function complete(prompt, { maxTokens = 800 } = {}) {
  const res = await postChat({
    model: config.model,
    max_tokens: maxTokens,
    temperature: 0.4,
    frequency_penalty: 0.1,
    chat_template_kwargs: { enable_thinking: false },
    messages: [{ role: 'user', content: prompt }],
  }, AbortSignal.timeout(180000));
  if (!res.ok) throw new Error(`API NVIDIA ${res.status}`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// Botões automáticos: quando a resposta pede uma decisão e o modelo não chamou offer_choices
// (com ~100 ferramentas ele costuma esquecer), uma chamada curta gera as opções.
let offeredChoices = null; // opções mostradas na última resposta (para "a segunda" por voz)
const ASKS_USER = /\?|me (diz|diga|fala|conta)|é só (me )?dizer|qual (você )?prefere|quer que eu|escolh/i;

async function suggestChoices(userText, answer) {
  const prompt = `Você cria botões de resposta rápida para um assistente pessoal.
Pedido do usuário: "${userText.slice(0, 500)}"
Resposta do assistente: "${answer.slice(0, 1500)}"

Se a resposta pede uma decisão ou informação do usuário cujas respostas prováveis cabem em 2 a 4 opções curtas, escreva essas opções do jeito que o usuário clicaria (até 40 caracteres cada, português do Brasil, sem numeração). Se a resposta pede várias coisas, faça as opções só para a primeira/mais importante. Se não fizer sentido ter botões (resposta livre, nada a decidir), devolva [].
Responda SOMENTE com um array JSON de strings.`;
  const res = await postChat({
    model: config.model,
    max_tokens: 150,
    temperature: 0.3,
    chat_template_kwargs: { enable_thinking: false },
    messages: [{ role: 'user', content: prompt }],
  }, AbortSignal.timeout(12000));
  if (!res.ok) throw new Error(`API NVIDIA ${res.status}`);
  const data = await res.json();
  const raw = (data.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '');
  const list = JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] || '[]');
  const clean = (Array.isArray(list) ? list : []).filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim().slice(0, 60)).slice(0, 4);
  return clean.length >= 2 ? clean : null;
}

// Texto em streaming, sem ferramentas (o diretor do documentário escreve o roteiro linha a linha)
async function streamText(prompt, onText, signal, { maxTokens = 4000, temperature = 0.7 } = {}) {
  const res = await postChat({
    model: config.model,
    messages: [{ role: 'user', content: prompt }],
    stream: true, temperature, top_p: 0.95, frequency_penalty: 0.1, max_tokens: maxTokens,
    chat_template_kwargs: { enable_thinking: false },
  }, signal);
  if (!res.ok) throw new Error(`API NVIDIA ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const l = line.trim();
      if (!l.startsWith('data:') || l === 'data: [DONE]') continue;
      try {
        const d = JSON.parse(l.slice(5)).choices?.[0]?.delta?.content;
        if (d) onText(d);
      } catch {}
    }
  }
}

// Síntese de voz com o instante de cada palavra (para sincronizar a tela com a narração)
const ttsWaiters = new Map();
function synthesize(text, { rate = '+0%' } = {}) {
  return new Promise((resolve, reject) => {
    if (!pyWs) { reject(new Error('serviço de voz desligado')); return; }
    const id = ++ttsCounter;
    ttsWaiters.set(id, { resolve, reject });
    voiceSend({ cmd: 'speak', id, text, timed: true, rate });
    setTimeout(() => { if (ttsWaiters.delete(id)) reject(new Error('a síntese demorou demais')); }, 45000);
  });
}

// Uma rodada com ferramentas, sem streaming (usado pelo agente de código)
async function chatWithTools(messages, tools, { maxTokens = 6000 } = {}) {
  const body = {
    model: config.codeModel || config.model,
    messages, tools, tool_choice: 'auto',
    max_tokens: maxTokens, temperature: 0.2,
    chat_template_kwargs: { enable_thinking: false },
  };
  const res = await postChat(body, AbortSignal.timeout(240000));
  if (!res.ok) throw new Error(`API NVIDIA ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const msg = (await res.json()).choices?.[0]?.message || {};
  return {
    content: (msg.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim(),
    tool_calls: (msg.tool_calls || []).filter((c) => c.function?.name),
  };
}

// Print da tela principal analisado pelo modelo de visão
async function lookAtScreen(question) {
  const image = await captureScreen();
  return visionAsk(`Se houver código ou mensagem de erro, transcreva os trechos relevantes.\n\n${question}`, image);
}

// Print da tela principal em JPEG (base64), escondendo o JARVIS durante a captura
async function captureScreen() {
  const display = screen.getPrimaryDisplay();
  const sf = display.scaleFactor;
  const width = Math.round(display.size.width * sf), height = Math.round(display.size.height * sf);
  // Esconde o JARVIS para ele não aparecer no print
  const wasVisible = win && win.isVisible() && !win.isMinimized();
  if (wasVisible) { win.minimize(); await new Promise((r) => setTimeout(r, 400)); }
  let image;
  try {
    const [src] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
    image = src.thumbnail.resize({ width: 1280 }).toJPEG(70).toString('base64');
  } finally {
    if (wasVisible) win.restore();
  }
  return image;
}

// Pergunta ao modelo de visão sobre uma imagem JPEG (base64)
async function visionAsk(question, jpegBase64) {
  const res = await nvidiaFetch('/chat/completions', {
    model: config.visionModel,
    max_tokens: 900,
    temperature: 0.2,
    chat_template_kwargs: { enable_thinking: false },
    messages: [{ role: 'user', content: [
      { type: 'text', text: `Responda em português do Brasil, de forma objetiva.\n\n${question}` },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpegBase64}` } },
    ] }],
  });
  if (!res.ok) throw new Error(`Visão: API NVIDIA ${res.status}`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// Divide o texto em frases para começar a falar antes da resposta terminar
class SentenceSplitter {
  constructor(onSentence) {
    this.buf = '';
    this.onSentence = onSentence;
  }
  push(text) {
    this.buf += text;
    // Frase = texto até pontuação seguida de espaço (não corta "3.5") ou até quebra de linha
    const re = /[\s\S]*?(?:[.!?…]+\s+|\n+)/y;
    let m, last = 0;
    while ((m = re.exec(this.buf)) && m[0]) {
      this.emit(m[0]);
      last = re.lastIndex;
    }
    this.buf = this.buf.slice(last);
  }
  flush() {
    this.emit(this.buf);
    this.buf = '';
  }
  emit(s) {
    const clean = s.replace(/[*#`_>]+/g, '').replace(/\s+/g, ' ').trim();
    if (clean && /[\p{L}\p{N}]/u.test(clean)) this.onSentence(clean);
  }
}

let ttsCounter = 0;

// Últimas mensagens do histórico, começando sempre numa mensagem do usuário
// (não pode começar com um resultado de ferramenta solto)
function recentHistory() {
  let start = Math.max(0, history.length - MAX_HISTORY);
  while (start < history.length && history[start].role !== 'user') start++;
  return history.slice(start);
}

function parseArgs(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

// De onde veio o pedido define para onde vai a resposta:
//   pc        → fala nas caixas do PC (padrão)
//   phone     → texto no app do celular; a fala toca no celular (ou em lugar nenhum, se ele desligar)
//   telegram  → só texto, enviado de volta pelo bot
const CHANNEL_ICON = { phone: '📱 ', telegram: '✈ ' };

// Documentário em exibição: pausa/continua/volta/pula/encerra são resolvidos na hora, sem passar pelo modelo
let docState = { active: false };
let forgeState = { active: false }; // modelo 3D aberto na Fábrica de Hologramas
const DOC_COMMANDS = [
  ['stop', /\b(fecha|feche|encerra|encerrar|termina|sai|sair|para|parar)\b.*\b(document[áa]rio|v[íi]deo|apresenta[çc][ãa]o|mapa)\b/],
  ['resume', /^(pode )?(continua|continue|continuar|segue|siga|prossiga|retoma|retome|play|vai)\b/],
  ['pause', /^(pausa|pause|pausar|para|pare|espera|espere)\b/],
  ['image', /^(volta|volte|voltar|mostra|mostre)\b.*\b(imagem|foto|pintura|quadro)/],
  ['back', /^(volta|volte|voltar|anterior|repete|repita|de novo)\b/],
  ['next', /^(pula|pule|avança|avance|pr[óo]xim[oa])\b/],
];
// Resposta do quiz do documentário: "letra B", "é a C", "a segunda", "B" ou o texto de uma das opções
function quizAnswer(text, options = []) {
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const t = norm(text).replace(/^(ei )?jarvis /, '');
  const letter = (s) => ({ a: 0, b: 1, be: 1, c: 2, ce: 2, se: 2 })[s];
  let m = t.match(/\b(letra|alternativa|opcao|resposta)\s+(a|b|be|c|ce|se)\b/);
  if (m) return letter(m[2]);
  if ((m = t.match(/(?:^|\b(?:e|eh|seria|acho que e)\s+(?:a\s+|o\s+)?)(a|b|be|c|ce)$/))) return letter(m[1]);
  if (/\b(primeira|primeiro)\b/.test(t)) return 0;
  if (/\b(segunda|segundo)\b/.test(t)) return 1;
  if (/\b(terceira|terceiro|ultima|ultimo)\b/.test(t)) return 2;
  // o texto de uma opção: a que tiver mais palavras (de 3+ letras) presentes na fala
  let best = -1, score = 0;
  options.forEach((o, i) => {
    const ws = norm(o).split(' ').filter((w) => w.length > 2);
    const hit = ws.filter((w) => t.split(' ').includes(w)).length;
    if (ws.length && hit / ws.length >= 0.5 && hit > score) { best = i; score = hit; }
  });
  return best >= 0 ? best : null;
}

function docCommand(text) {
  const t = text.toLowerCase().replace(/^\s*(ei,?\s*)?jarvis[\s,.!]*/i, '').replace(/[.!?]+$/, '').trim();
  if (t.split(/\s+/).length > 7) return null;
  for (const [action, re] of DOC_COMMANDS) if (re.test(t)) return action;
  return null;
}

async function handleUserInput(text, { fromVoice = false, channel = 'pc', speakHere = true, chatMode = false, attachments = [], effort = 'min', reply } = {}) {
  text = (text || '').trim();
  // "/max ..." (Telegram, chat) ou "pensa no máximo" na fala liga o esforço máximo só neste pedido
  if (/^\/max\b/i.test(text)) { effort = 'max'; text = text.replace(/^\/max\b\s*/i, ''); }
  else if (MAX_EFFORT_RE.test(text)) effort = 'max';
  if (!['min', 'mid', 'max'].includes(effort)) effort = 'min';
  if (!text && attachments.length) text = attachments.some((a) => a.kind === 'image') ? 'O que você vê aqui?' : 'Dá uma olhada nisso.';
  if (!text) return;

  if (channel === 'pc' && docState.active) {
    const choice = docState.quiz?.waiting ? quizAnswer(text, docState.quiz.options) : null;
    if (docState.quiz?.waiting) console.log('[doc] quiz ouviu:', JSON.stringify(text), '->', choice);
    if (choice !== null) {
      send('user-message', text);
      send('doc-command', { action: 'answer', choice });
      voiceSend({ cmd: 'resume' });
      send('voice-status', { state: 'idle' });
      return;
    }
    const action = docCommand(text);
    if (action) {
      send('user-message', text);
      send('doc-command', { action });
      voiceSend({ cmd: 'resume' });
      send('voice-status', { state: 'idle' });
      return;
    }
    send('doc-command', { action: 'hold' }); // é uma pergunta: o documentário espera a resposta
  }

  if (currentAbort) currentAbort.abort();
  const abort = new AbortController();
  currentAbort = abort;
  busy = true;
  skillCtx.turnId++;
  skillCtx.lastUserText = text;
  skillCtx.channel = channel;
  skillCtx.lastChoices = null;
  skillCtx.prevChoices = offeredChoices;
  offeredChoices = null;

  const onPc = channel === 'pc';
  chatTurn = onPc && chatMode;
  const speak = (s) => {
    if (onPc && (!chatMode || speakHere)) sayText(s);
    else if (channel === 'phone' && speakHere) sayText(s, 'phone');
  };
  const delta = (d) => {
    send('ai-delta', d);
    if (channel === 'phone') phonecam.send({ t: 'delta', text: d });
  };
  let fullText = '';

  if (onPc) {
    voiceSend({ cmd: 'pause' });
    assistantActive(true);
  }
  send('user-message', (CHANNEL_ICON[channel] || '') + text + (attachments.length ? `
📎 ${attachments.map((a) => a.name).join(' · ')}` : ''));
  send('voice-status', { state: 'thinking' });

  if (!config.apiKey) {
    const msg = `${config.userName}, preciso de uma chave da API da NVIDIA para pensar. Abra as configurações no ícone de engrenagem.`;
    send('ai-start');
    delta(msg);
    speak(msg);
    if (reply) reply(msg);
    finishTurn(fromVoice, abort, channel);
    return;
  }

  // Anexos: texto extraído entra na mensagem; imagens passam antes pelo modelo de visão
  let histUser = null;
  let userContent = text;
  if (attachments.length) {
    const blocks = await attachmentBlocks(text, attachments, onPc);
    if (abort.signal.aborted) return;
    userContent = [text, ...blocks.map((b) => b.full)].join('\n\n');
    histUser = [text, ...blocks.map((b) => b.short)].join('\n\n');
  }
  // Esforço máximo: o conselho (lib/deepthink.js) roda antes; o quadro aparece no chat e o resumo
  // entra na mensagem, para o modelo escrever a recomendação final (e para "aprofunda a 2" depois)
  let effortNote = effort === 'mid' ? MID_EFFORT_NOTE : '';
  if (effort === 'max') {
    try {
      const result = await deepThink({
        request: text,
        context: deepContext(text, attachments.length ? userContent : ''),
        call: deepCall,
        emit: (e) => { if (onPc) send('ai-deep', e); },
        signal: abort.signal,
      });
      const summary = deepSummarize(result);
      userContent = `${userContent}\n\n${summary}`;
      histUser = `${histUser || text}\n\n${summary}`;
      effortNote = onPc ? (chatTurn ? MAX_EFFORT_NOTE_CHAT : MAX_EFFORT_NOTE_VOICE) : MAX_EFFORT_NOTE_REMOTE;
    } catch (e) {
      if (abort.signal.aborted) return;
      console.error('[esforço máximo]', e);
      if (onPc) send('ai-deep', { stage: 'error', message: e.message });
      effortNote = MID_EFFORT_NOTE; // sem o conselho, pelo menos pensa antes de responder
    }
  }
  const thinking = effort !== 'min';
  const maxTokens = chatTurn || channel === 'telegram' ? (thinking ? 6000 : 4096) : thinking ? 2048 : 1024;
  const onReasoning = onPc && thinking ? (r) => send('ai-thinking', r) : undefined;

  const turn = [{ role: 'user', content: userContent }];
  const spoken = [];
  let retriedDegenerate = false;

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const splitter = new SentenceSplitter((s) => { spoken.push(s); speak(s); });
      send('ai-start');
      const messages = [{ role: 'system', content: systemPrompt(channel) + effortNote }, ...recentHistory(), ...turn];
      let streamed;
      try {
        streamed = await streamCompletion(messages, (d) => {
          splitter.push(d);
          delta(d);
        }, abort.signal, { temperature: retriedDegenerate ? 0.3 : 0.6, thinking, maxTokens, onReasoning });
      } catch (e) {
        // Resposta em loop: descarta e tenta de novo uma vez, mais "conservador"
        if (e.message !== 'DEGENERATE' || retriedDegenerate) throw e;
        retriedDegenerate = true;
        console.log('[ia] resposta degenerada, tentando de novo');
        round--;
        continue;
      }
      const { text: replyText, calls } = streamed;
      if (replyText) fullText += (fullText ? '\n' : '') + replyText;
      splitter.flush();

      if (!calls.length) {
        turn.push({ role: 'assistant', content: replyText || '(feito)' });
        break;
      }

      turn.push({
        role: 'assistant',
        content: replyText || null,
        tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })),
      });

      send('voice-status', { state: 'searching' });
      const results = await Promise.all(calls.map(async (c) => {
        const args = parseArgs(c.args);
        console.log('[tool]', c.name, JSON.stringify(args));
        const arg = Object.values(args).filter((v) => typeof v !== 'object').join(' · ');
        send('action', { name: c.name, arg });
        // Passo visível no chat ("Pesquisando na web… ✓"), como nos assistentes premium
        if (onPc) send('ai-step', { id: c.id, name: c.name, arg, state: 'run' });
        const result = await skills.run(c.name, args);
        console.log('[tool] ->', JSON.stringify(result).slice(0, 300));
        if (onPc) send('ai-step', { id: c.id, name: c.name, state: result?.ok === false || result?.error ? 'err' : 'ok' });
        return { role: 'tool', tool_call_id: c.id, content: JSON.stringify(result) };
      }));
      if (abort.signal.aborted) return;
      turn.push(...results);
      // Ação sensível esperando "sim": mostra os botões no chat também
      if (onPc && results.some((r) => /"needs_confirmation":true/.test(r.content))) send('ai-choices', ['Sim', 'Não']);
      send('voice-status', { state: 'thinking' });
    }

    // O turno inteiro vai para o histórico, incluindo as chamadas de ferramenta: se ficasse só o
    // texto falado ("Tocando X"), o modelo aprenderia a responder sem chamar a ferramenta.
    // Resultados longos (busca, clima) são resumidos.
    if (histUser) turn[0] = { role: 'user', content: histUser }; // no histórico, anexos grandes vão resumidos
    history.push(...turn.map((m) => (m.role === 'tool' && m.content.length > 400 ? { ...m, content: m.content.slice(0, 400) + '…' } : m)));
    history = history.slice(-MAX_HISTORY * 3);
    writeJson(files.history, history);
    if (!spoken.length) { speak('Feito.'); fullText = fullText || 'Feito.'; }
    logConversation((CHANNEL_ICON[channel] || '') + text, spoken.join(' '), turn);
    try { skillCtx.projectMemory?.journalTurn(text, spoken.join(' '), turn); } catch (e) { console.error('[projmem]', e.message); }
    // Se a última rodada pediu confirmação, o Telegram mostra botões Sim/Não
    const lastTools = turn.filter((m) => m.role === 'tool').slice(-3);
    const needsConfirmation = lastTools.some((m) => /"needs_confirmation":true/.test(m.content));
    let choices = skillCtx.lastChoices;
    const autoChoices = !choices && !needsConfirmation && channel !== 'phone' && ASKS_USER.test(fullText.slice(-600))
      ? suggestChoices(text, fullText).catch((e) => { console.log('[ia] escolhas automáticas:', e.message); return null; })
      : null;
    if (autoChoices && channel === 'telegram') choices = await autoChoices;
    else if (autoChoices && onPc) {
      // no PC não segura o fim do turno: os botões aparecem assim que ficarem prontos
      const turnId = skillCtx.turnId;
      autoChoices.then((c) => {
        if (!c || skillCtx.turnId !== turnId) return;
        offeredChoices = c;
        send('ai-choices', c);
      });
    }
    if (choices) offeredChoices = choices;
    if (reply) reply(fullText.trim(), { needsConfirmation, choices });
    if (channel === 'phone') phonecam.send({ t: 'done' });
  } catch (err) {
    if (abort.signal.aborted) return;
    console.error(err);
    const msg = err.message === 'DEGENERATE'
      ? `Me enrolei com essa, ${config.userName}. Pode pedir de outro jeito?`
      : /API NVIDIA (401|403)/.test(err.message)
      ? `Minha chave de acesso à NVIDIA foi recusada, ${config.userName}. Verifique as configurações.`
      : /API NVIDIA (404|410)/.test(err.message)
        ? `O modelo de IA configurado não está mais disponível, ${config.userName}. Escolha outro nas configurações.`
        : /API NVIDIA 429/.test(err.message)
          ? `Atingi o limite de uso da API da NVIDIA por enquanto, ${config.userName}. Tente em alguns instantes.`
          : 'Perdi a conexão com meus servidores por um instante. Tente novamente.';
    delta('\n' + msg);
    toast(err.message, 'error');
    speak(msg);
    if (reply) reply(msg);
    if (channel === 'phone') phonecam.send({ t: 'done' });
  }
  finishTurn(fromVoice, abort, channel);
}

// Registro completo das conversas (o histórico do modelo é curto; este é para a tela de Memória)
const conversationsFile = path.join(dataDir, 'conversations.jsonl');
function logConversation(user, reply, turn) {
  const tools = turn.flatMap((m) => (m.tool_calls || []).map((c) => c.function.name));
  try {
    fs.appendFileSync(conversationsFile, JSON.stringify({ at: Date.now(), user, reply, tools }) + '\n');
  } catch (e) { console.error('[log]', e.message); }
}

function readConversations(limit = 400) {
  try {
    const lines = fs.readFileSync(conversationsFile, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l));
  } catch { return []; }
}

// ------------------------------------------------------------ esforço (mínimo / médio / máximo)

const MAX_EFFORT_RE = /\b(pens[ae]r?|analis[ae]r?|reflit[ae])\b.{0,20}\b(no m[aá]ximo|a fundo|bem fundo|com calma|com esfor[cç]o m[aá]ximo)\b|\besfor[cç]o m[aá]ximo\b/i;

const MID_EFFORT_NOTE = `

ESFORÇO MÉDIO: pense antes de responder. Considere 2 ou 3 caminhos possíveis, escolha o melhor para o contexto dele e confira a resposta (erros, casos de borda, se responde mesmo o que foi pedido) antes de entregar. Quando houver uma alternativa relevante, mencione em uma frase.`;

const MAX_EFFORT_NOTE_CHAT = `

ESFORÇO MÁXIMO: um conselho de especialistas já explorou várias abordagens e você já avaliou e deu notas; o resumo está no fim da mensagem do usuário e o QUADRO COMPARATIVO com as opções e notas JÁ ESTÁ NA TELA (não repita o quadro nem liste todas as opções de novo). Escreva, em markdown:
1. **A recomendação** e por que ela vence no caso DELE (2 a 4 frases, citando o contexto que você conhece).
2. **Primeiros passos** concretos da recomendada (3 a 5 itens, acionáveis já).
3. **Quando escolher outra** (1 ou 2 opções, uma frase cada).
Termine chamando offer_choices com: "Aprofunda a recomendada", "Transforma em plano", "Mistura as 2 melhores", "Me dá ideias mais ousadas".`;

const MAX_EFFORT_NOTE_VOICE = `

ESFORÇO MÁXIMO: você já explorou várias abordagens e o quadro comparativo com as opções está na tela. FALE só a recomendação e o porquê em 2 a 3 frases, e diga que o detalhe está na tela.`;

const MAX_EFFORT_NOTE_REMOTE = `

ESFORÇO MÁXIMO: você já explorou várias abordagens (resumo no fim da mensagem do usuário). Responda com: a recomendação e por quê; depois as outras opções numa lista curta (título + nota + 1 frase cada); depois 3 primeiros passos da recomendada.`;

// O que o conselho sabe sobre o usuário: dossiês, projeto atual, memória, conversa recente e anexos
function deepContext(text, attached = '') {
  const parts = [];
  const kb = skillCtx.knowledge?.promptBlock(text, skillCtx.turnId);
  if (kb) parts.push(kb.trim());
  const pm = skillCtx.projectMemory?.promptBlock();
  if (pm) parts.push(pm.trim());
  const facts = skillCtx.memory?.promptBlock();
  if (facts) parts.push(facts.trim());
  const recent = recentHistory()
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'Usuário' : 'JARVIS'}: ${m.content.slice(0, 300)}`);
  if (recent.length) parts.push(`Conversa recente:\n${recent.join('\n')}`);
  if (attached) parts.push(`Anexos do pedido:\n${attached.slice(0, 6000)}`);
  return parts.join('\n\n').slice(0, 9000);
}

// Chamada simples ao modelo rápido (gerar/avaliar abordagens). Se ele for aposentado, o postChat troca e guardamos a troca.
async function deepCall(kind, prompt, { maxTokens = 1500, temperature = 0.5, signal } = {}) {
  const model = config.fastModel || config.model;
  const body = {
    model,
    max_tokens: maxTokens,
    temperature,
    chat_template_kwargs: { enable_thinking: false },
    messages: [{ role: 'user', content: prompt }],
  };
  const res = await postChat(body, signal || AbortSignal.timeout(120000));
  if (!res.ok) throw new Error(`API NVIDIA ${res.status}`);
  if (body.model !== model && config.fastModel === model) { config.fastModel = body.model; saveConfig(); }
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// Monta o texto de cada anexo. full = vai para o modelo neste turno; short = fica no histórico.
const ATTACH_FULL = 60000;
const ATTACH_HIST = 8000;
async function attachmentBlocks(text, attachments, onPc) {
  return Promise.all(attachments.slice(0, 8).map(async (a, i) => {
    const name = String(a.name || `anexo ${i + 1}`).slice(0, 120);
    if (a.kind === 'image' && a.jpeg) {
      const id = `vision-${Date.now()}-${i}`;
      if (onPc) send('ai-step', { id, name: 'look_attachment', arg: name, state: 'run' });
      try {
        const seen = await visionAsk(`O usuário anexou esta imagem ("${name}") e escreveu: "${text}". Descreva com precisão tudo que for útil para responder: textos visíveis (transcreva literalmente códigos, mensagens de erro, números e tabelas), elementos da interface, objetos, pessoas, gráficos. Não responda ao usuário; só descreva.`, a.jpeg);
        if (onPc) send('ai-step', { id, name: 'look_attachment', state: 'ok' });
        const block = `[Imagem anexada: ${name}]
O que a imagem mostra (sua visão):
${seen}`;
        return { full: block, short: block.slice(0, ATTACH_HIST) };
      } catch (e) {
        if (onPc) send('ai-step', { id, name: 'look_attachment', state: 'err' });
        const block = `[Imagem anexada: ${name}] (não consegui analisar: ${e.message})`;
        return { full: block, short: block };
      }
    }
    const body = String(a.text || '');
    const head = `[Arquivo anexado: ${name}${a.meta ? ` · ${a.meta}` : ''}]`;
    const fence = (t, max) => `${head}
\`\`\`
${t.slice(0, max)}${t.length > max ? `
... (cortado: ${t.length} caracteres no total)` : ''}
\`\`\``;
    return { full: fence(body, ATTACH_FULL), short: fence(body, ATTACH_HIST) };
  }));
}

function finishTurn(fromVoice, abort, channel = 'pc') {
  if (currentAbort !== abort) return;
  currentAbort = null;
  busy = false;
  send('ai-done', { followUp: fromVoice && channel === 'pc' && config.followUp });
}

// target 'phone': o mp3 vai para o celular em vez de tocar no PC
const phoneTts = new Set();
function sayText(text, target = 'pc') {
  const id = ++ttsCounter;
  if (target === 'phone') phoneTts.add(id);
  else send('tts-expect', { id, text });
  voiceSend({ cmd: 'speak', id, text });
}

// Fala algo por iniciativa própria (lembretes, avisos). Também aparece no celular, se conectado.
function announce(text, { phone = true } = {}) {
  if (phone) phonecam.send({ t: 'alert', text });
  // no carro, o aviso é falado no celular (ninguém vai ler a tela dirigindo)
  if (phoneDrive && phonecam.connected) sayText(text, 'phone');
  if (busy) return;
  voiceSend({ cmd: 'pause' });
  assistantActive(true);
  send('ai-start');
  send('ai-delta', text);
  sayText(text);
  send('ai-done', { followUp: false });
}

// Abertura ao iniciar: "Bom dia, senhor. Todos os sistemas online." + um resumo rápido do dia
let greeted = false;
async function bootGreeting() {
  try { await bootGreetingInner(); } catch (e) { console.error('[abertura]', e); }
}
async function bootGreetingInner() {
  console.log('[abertura] iniciando', { ativa: config.bootGreeting, busy });
  if (!config.bootGreeting || busy) return;
  const h = new Date().getHours();
  const period = h < 5 ? 'Boa noite' : h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
  const parts = [`${period}, ${config.userName}. Todos os sistemas online.`];
  const pending = skillCtx.getTasks().filter((t) => !t.done).length;
  if (pending) parts.push(`Você tem ${pending === 1 ? 'uma tarefa pendente' : `${pending} tarefas pendentes`}.`);
  const next = skills.get('reminders').getAll().filter((r) => r.at - Date.now() < 12 * 3600000).sort((a, b) => a.at - b.at)[0];
  if (next) parts.push(`Próximo lembrete às ${new Date(next.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}: ${next.text}.`);
  try {
    const w = await skills.runDirect('get_weather', {});
    if (w?.now) parts.push(`Lá fora, ${w.now.temp} graus e ${w.now.condition}.`);
  } catch {}
  send('boot-greeting');
  announce(parts.join(' '), { phone: false });
}

// Avisos importantes que precisam chegar mesmo com você longe do PC: celular + Telegram
function notifyRemote(text, { image, phone = true, buttons } = {}) {
  if (phone) phonecam.send({ t: 'alert', text, image: image ? image.toString('base64') : undefined });
  if (phone && phoneDrive && phonecam.connected) sayText(text.replace(/<[^>]+>/g, '').replace(/[🛠✅🗑📄🛡⚠]/gu, '').split('\n\n')[0].slice(0, 220), 'phone');
  if (telegram && config.telegramAlerts !== false) telegram.notify(text, image, buttons).catch((e) => console.error('[telegram]', e.message));
}

// ------------------------------------------------------------ Telegram

let telegram = null;
let telegramState = { status: 'off' };

async function startTelegram() {
  if (telegram) telegram.stop();
  telegram = null;
  if (!config.telegramToken) { telegramState = { status: 'off' }; return; }
  const tg = new Telegram({
    token: config.telegramToken,
    chatId: config.telegramChatId,
    onPaired: (chatId, from) => {
      config.telegramChatId = chatId;
      config.telegramUser = from.username ? `@${from.username}` : from.first_name;
      saveConfig();
      telegramState = { ...telegramState, status: 'paired', user: config.telegramUser };
      toast(`Telegram pareado com ${config.telegramUser}.`);
    },
    onText: (text) => (text.startsWith('/') ? telegramCommand(text.slice(1).split(/[\s@]/)[0].toLowerCase()) : telegramAsk(text)),
    onVoice: async (audio) => {
      let text = '';
      try { text = await transcribeAudio(audio); } catch (e) { await tg.send(`Não consegui transcrever o áudio (${e.message}).`); return; }
      if (!text) { await tg.send('Não entendi o áudio.'); return; }
      // o que ele entendeu vai na legenda da própria resposta de voz (sem mensagem extra antes)
      await telegramAsk(text, { voice: true });
    },
    onPhoto: async (image, caption) => {
      send('user-message', `✈ [foto] ${caption || ''}`);
      const question = caption || 'O que tem nesta foto? Descreva de forma útil e breve.';
      // Uma chamada só: se for comprovante/nota, já extrai o gasto; senão, responde a pergunta normalmente
      const fin = skills.get('financas')?.api;
      const prompt = fin ? `Analise a imagem e responda SOMENTE com um JSON.
Se for cupom fiscal, nota, recibo, comprovante de pagamento ou PIX, ou boleto/conta: {"receipt":true,"total":<número>,"description":"<loja ou o que foi>","category":"<uma de: ${fin.categories.join(', ')}>","date":"<YYYY-MM-DD ou null>","type":"expense" ou "income" (PIX/transferência RECEBIDA = income)}
Caso contrário: {"receipt":false,"answer":"<sua resposta para: ${question.replace(/"/g, "'")}>"}` : question;
      const raw = await visionAsk(prompt, image.toString('base64')).catch((e) => `Não consegui analisar a foto (${e.message}).`);
      let parsed = null;
      if (fin) try { parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || ''); } catch {}
      if (parsed?.receipt && Number(parsed.total) > 0) {
        const r = { type: parsed.type === 'income' ? 'income' : 'expense', amount: Number(parsed.total), description: String(parsed.description || 'Comprovante').slice(0, 80), category: parsed.category, date: parsed.date || undefined };
        const id = fin.stageReceipt(r);
        const value = r.amount.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
        await tg.send(`🧾 Li o comprovante: **${value}** · ${r.description}${parsed.category ? ` · ${parsed.category}` : ''}${r.date ? ` · ${r.date.split('-').reverse().join('/')}` : ''}\nRegistro como ${r.type === 'income' ? 'entrada' : 'gasto'}?`,
          { buttons: [[{ text: '✅ Registrar', data: `fin:receipt:${id}` }, { text: '❌ Ignorar', data: `fin:skip:${id}` }]] });
        return;
      }
      await tg.send(parsed?.answer || raw);
    },
    onCallback: (data, msg) => telegramButton(data, msg),
  });
  try {
    const bot = await tg.start();
    telegram = tg;
    telegramState = config.telegramChatId
      ? { status: 'paired', bot: `@${bot.username}`, user: config.telegramUser }
      : { status: 'waiting', bot: `@${bot.username}`, code: tg.pairCode };
  } catch (e) {
    telegramState = { status: 'error', error: e.message };
    toast(`Telegram: ${e.message}`, 'error');
  }
}

// Pedido em linguagem natural vindo do Telegram. Enquanto ele roda, o tgTurn guarda o que precisa
// virar imagem (painéis) ou mensagem de progresso (pesquisas).
let tgTurn = null;
const TG_YES_NO = [[{ text: '✅ Sim', data: 'confirm:yes' }, { text: '❌ Não', data: 'confirm:no' }]];
let tgChoices = []; // últimas opções oferecidas com offer_choices

function telegramAsk(text, { voice = false } = {}) {
  const tg = telegram;
  return new Promise((resolve) => {
    const turnState = { panel: null, progressId: null, lastProgress: 0 };
    tgTurn = turnState;
    tgVoiceTurn = voice;
    // pedido por áudio: o topo do chat mostra "gravando áudio..." em vez de "digitando..."
    const action = voice ? 'record_voice' : 'typing';
    tg.typing(action);
    const typing = setInterval(() => tg.typing(action), 4500);
    const heard = voice ? `*🎙 “${text.replace(/\*/g, '')}”*\n\n` : '';
    handleUserInput(text, {
      channel: 'telegram',
      reply: async (answer, info = {}) => {
        clearInterval(typing);
        try {
          if (turnState.progressId) await tg.edit(turnState.progressId, '✅ Pronto.');
          // botões de escolha: o callback leva só o índice (limite de 64 bytes do Telegram)
          if (info.choices?.length) tgChoices = info.choices;
          const buttons = info.needsConfirmation ? TG_YES_NO
            : info.choices?.length ? info.choices.map((c, i) => [{ text: c, data: `choice:${i}` }])
            : undefined;
          let sentVoice = false;
          if (voice && answer) {
            tg.typing('record_voice');
            try {
              const ogg = await voiceNote(answer);
              // legenda: o que ele entendeu (itálico) + a resposta; se for longa demais, a resposta segue separada
              const caption = heard + answer;
              await tg.sendVoice(ogg, caption.length <= 1000 ? caption : heard.trim(), { buttons });
              if (caption.length > 1000) await tg.send(answer);
              sentVoice = true;
            } catch (e) { console.error('[telegram] voz:', e.message); }
          }
          if (!sentVoice) await tg.send(heard + answer, { buttons });
          // Painel visual (gráfico, briefing, comparação, holograma) também vai como imagem
          if (turnState.panel) {
            await new Promise((r) => setTimeout(r, turnState.panelWait || 3500));
            const img = await capturePanel(turnState.panel);
            if (img) await tg.sendPhoto(img);
          }
        } catch (e) { console.error('[telegram]', e.message); }
        if (tgTurn === turnState) { tgTurn = null; tgVoiceTurn = false; }
        resolve();
      },
    });
  });
}

// Mensagem de voz com a voz e o efeito do JARVIS
const fxWaiters = new Map();
const oggWaiters = new Map();
let fxCounter = 0;
function waitFor(map, id, ms, what) {
  return new Promise((resolve, reject) => {
    map.set(id, { resolve, reject });
    setTimeout(() => { if (map.delete(id)) reject(new Error(`${what} demorou demais`)); }, ms);
  });
}
ipcMain.on('fx-result', (_, r) => {
  const w = fxWaiters.get(r.id);
  if (!w) return;
  fxWaiters.delete(r.id);
  if (r.error || !r.pcm) w.reject(new Error(r.error || 'efeito vazio')); else w.resolve(r.pcm);
});
async function voiceNote(text) {
  const speech = String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*_#`>|~]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s+/g, ' ').trim().slice(0, 1500);
  if (!speech) throw new Error('nada para falar');
  const { data } = await synthesize(speech, { rate: '+6%' });
  if (!win || win.isDestroyed()) throw new Error('janela principal fechada');
  const id = ++fxCounter;
  win.webContents.send('fx-render', { id, data });
  const pcm = await waitFor(fxWaiters, id, 30000, 'o efeito de voz');
  voiceSend({ cmd: 'ogg', id, pcm });
  return Buffer.from(await waitFor(oggWaiters, id, 30000, 'a conversão para OGG'), 'base64');
}

// Eventos da interface que interessam ao Telegram durante um pedido feito por lá
function telegramHook(channel, payload) {
  if (telegram && channel === 'agent' && payload?.origin === 'telegram') agentProgress(payload);
  const t = tgTurn;
  if (!t || !telegram) return;
  if ((channel === 'visual' || channel === 'briefing') && !payload?.loading) {
    t.panel = '#briefing';
    t.panelWait = 900 + (payload?.cards?.length || 8) * 420; // espera os cards "pipocarem"
  }
  if (channel === 'hologram') { t.panel = '#holo'; t.panelWait = 2000; }
  if (channel === 'research-progress') {
    if (payload.phase === 'done') { t.panel = '#rsView'; t.panelWait = 1200; return; }
    // progresso ao vivo, editando a mesma mensagem (no máximo a cada 2,5 s)
    if (Date.now() - t.lastProgress < 2500 && payload.phase === 'reading') return;
    t.lastProgress = Date.now();
    const sources = payload.sources || [];
    const done = sources.filter((s) => s.status === 'done').length;
    const text = { plan: '🧭 Planejando a pesquisa...', search: '🔎 Buscando na internet...', reading: `📖 Lendo as fontes: ${done} de ${sources.length}`, writing: '✍ Escrevendo o relatório...' }[payload.phase];
    if (!text) return;
    if (t.progressId) telegram.edit(t.progressId, text);
    else { t.progressId = -1; telegram.send(text).then((m) => { t.progressId = m?.message_id; }).catch(() => {}); }
  }
}

// Progresso das agentes de código quando a tarefa veio do Telegram (uma mensagem por trabalho, editada ao vivo)
const agentMsgs = new Map(); // job.id → { id, last }
function agentProgress(job) {
  if (job.status !== 'running') return;
  const m = agentMsgs.get(job.id) || { id: null, last: 0 };
  agentMsgs.set(job.id, m);
  if (Date.now() - m.last < 3000) return;
  m.last = Date.now();
  const who = (skills.get('codeagent').api.agents().find((a) => a.id === job.agent) || {}).short || 'Agente';
  const text = `🛠 <b>${who}</b> · ${job.project}: ${job.phase || 'trabalhando'}...\n${job.steps.slice(-5).map((s) => `${s.icon} ${s.text}`).join('\n')}`;
  if (m.id) telegram.edit(m.id, text);
  else { m.id = -1; telegram.send(text).then((r) => { m.id = r?.message_id; }).catch(() => {}); }
}

// Recorta um painel da janela do JARVIS como imagem (para mandar no Telegram)
async function capturePanel(selector) {
  if (!win || win.isDestroyed() || win.isMinimized() || !win.isVisible()) return null;
  const rect = await win.webContents.executeJavaScript(`(() => {
    const e = document.querySelector(${JSON.stringify(selector)});
    if (!e || e.hidden || !e.offsetWidth) return null;
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  })()`).catch(() => null);
  if (!rect) return null;
  const img = await win.webContents.capturePage(rect);
  return img.isEmpty() ? null : img.toJPEG(85);
}

// Print de todos os monitores (sem esconder o JARVIS: é para ver como o PC está)
async function captureAllScreens() {
  const displays = displaysByX();
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1440 } });
  return displays.map((d) => (sources.find((s) => s.display_id === String(d.id)) || sources[0]).thumbnail.toJPEG(80));
}

let lastStats = null;
function statusText() {
  const pending = skillCtx.getTasks().filter((t) => !t.done);
  const disk = (() => { try { const s = fs.statfsSync('C:/'); return (s.bavail * s.bsize) / 1e9; } catch { return null; } })();
  const h = Math.floor(os.uptime() / 3600), mi = Math.floor((os.uptime() % 3600) / 60);
  return [
    '🖥 <b>Status do PC</b>',
    lastStats ? `CPU ${lastStats.cpu}% · RAM ${lastStats.ram}%` : '',
    `Ligado há ${h}h ${mi}min`,
    disk !== null ? `Disco C: ${disk.toFixed(disk < 10 ? 2 : 0)} GB livres${disk < 2 ? ' ⚠' : ''}` : '',
    `🎵 ${lastSong ? `${lastSong.paused ? '⏸' : '▶'} ${lastSong.title} - ${lastSong.artist}` : 'nada tocando'}`,
    `✅ ${pending.length} tarefa(s) pendente(s)`,
    `🛡 Sentinela ${skillCtx.sentinelActive?.() ? '<b>ativa</b>' : 'desligada'}`,
    `📱 Celular ${phonecam.connected ? 'conectado' : 'desconectado'}`,
  ].filter(Boolean).join('\n');
}

const TG_MENU = [
  [{ text: '🖥 Status', data: 'menu:status' }, { text: '📸 Print', data: 'menu:print' }],
  [{ text: '⏮', data: 'm:previous' }, { text: '⏯', data: 'm:toggle' }, { text: '⏭', data: 'm:next' }, { text: '♥', data: 'm:like' }],
  [{ text: '☀ Briefing', data: 'menu:briefing' }, { text: '✅ Tarefas', data: 'menu:tasks' }, { text: '💰 Finanças', data: 'menu:finance' }],
  [{ text: '🛡 Sentinela', data: 'menu:sentinel' }, { text: '⏱ Foco 25 min', data: 'menu:focus' }],
  [{ text: '🔒 Bloquear PC', data: 'menu:lock' }, { text: '⏻ Desligar', data: 'menu:shutdown' }, { text: '✖ Cancelar desligamento', data: 'menu:shutdown_cancel' }],
];

function tasksMessage() {
  const pending = skillCtx.getTasks().filter((t) => !t.done).slice(0, 12);
  if (!pending.length) return { text: '✅ Nenhuma tarefa pendente.', buttons: undefined };
  return {
    text: `✅ **Tarefas** (toque para concluir)\n${pending.map((t) => `${t.status === 'doing' ? '▶' : '◻'} ${t.text}`).join('\n')}`,
    buttons: pending.map((t) => [{ text: `✓ ${t.text.slice(0, 40)}`, data: `task:${t.id}` }]),
  };
}

async function sendScreens() {
  const shots = await captureAllScreens();
  await telegram.sendAlbum(shots, `📸 ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`);
}

async function telegramCommand(cmd) {
  const tg = telegram;
  switch (cmd) {
    case 'menu': case 'start': return tg.send('<b>J.A.R.V.I.S.</b> · o que deseja?', { buttons: TG_MENU });
    case 'status': return tg.send(statusText(), { buttons: [[{ text: '📸 Print', data: 'menu:print' }, { text: '🔄 Atualizar', data: 'menu:status' }]] });
    case 'print': return sendScreens();
    case 'briefing': return telegramAsk('Me dá o briefing do dia');
    case 'musica': return tg.send(`🎵 ${lastSong ? `${lastSong.title} - ${lastSong.artist}` : 'Nada tocando'}`, { buttons: [TG_MENU[1]] });
    case 'tarefas': { const m = tasksMessage(); return tg.send(m.text, { buttons: m.buttons }); }
    case 'financas': case 'gastos': { const fin = skills.get('financas').api; return tg.send(fin.summaryText(), { buttons: fin.menuButtons }); }
    case 'contas': { const m = skills.get('financas').api.billsMessage(); return tg.send(m.text, { buttons: m.buttons }); }
    case 'sentinela': return telegramButton('menu:sentinel');
    default: return telegramAsk(`/${cmd}`);
  }
}

// Cliques nos botões do Telegram. O que voltar como texto aparece como aviso rápido no Telegram.
async function telegramButton(data, msg) {
  const tg = telegram;
  const [kind, arg] = [data.split(':')[0], data.slice(data.indexOf(':') + 1)];
  if (kind === 'm') {
    await skills.runDirect('music_control', { action: arg });
    setTimeout(pushNowPlaying, 800);
    return { toggle: '⏯', next: '⏭ Próxima', previous: '⏮ Anterior', like: '♥ Curtida' }[arg];
  }
  if (kind === 'task') {
    skills.get('notes').api.updateTask(arg, { status: 'done' });
    const m = tasksMessage();
    if (msg) await tg.edit(msg.message_id, m.text, { buttons: m.buttons });
    return '✓ Concluída';
  }
  if (kind === 'confirm') {
    telegramAsk(arg === 'yes' ? 'sim' : 'não');
    return arg === 'yes' ? 'Confirmado' : 'Cancelado';
  }
  if (kind === 'fin') {
    if (arg === 'panel') { telegramAsk('Mostra o painel das minhas finanças deste mês'); return 'Montando o painel...'; }
    const r = await skills.get('financas').api.button(arg);
    if (r.edit && msg) await tg.edit(msg.message_id, r.edit.text, { buttons: r.edit.buttons });
    if (r.text) await tg.send(r.text, { buttons: r.buttons });
    return r.toast || null;
  }
  if (kind === 'choice') {
    const picked = tgChoices[Number(arg)];
    if (!picked) return 'Essa escolha expirou';
    telegramAsk(picked);
    return picked.slice(0, 190);
  }
  if (kind === 'agent') {
    const api = skills.get('codeagent').api;
    const [act, id] = arg.split(':'); // botões antigos não têm id
    if (act === 'diff') {
      const job = id ? api.get(id) : api.list().reverse().find((j) => j.diff);
      if (!job?.diff) return 'Sem diff';
      await tg.sendDocument(job.diff, `${job.branch.replace(/\//g, '-')}.diff`, job.diffStat);
      return 'Diff enviado';
    }
    try {
      const r = act === 'accept' ? await api.accept(id) : await api.discard(id);
      if (msg) await tg.edit(msg.message_id, `${msg.text || ''}\n\n${act === 'accept' ? `✅ Aplicado no ${r.project} (${r.files} arquivo(s)).` : '🗑 Descartado.'}`);
      return act === 'accept' ? 'Aplicado!' : 'Descartado';
    } catch (e) { return e.message; }
  }
  // menu
  switch (arg) {
    case 'status': await tg.send(statusText()); return null;
    case 'print': await sendScreens(); return '📸';
    case 'briefing': telegramAsk('Me dá o briefing do dia'); return 'Preparando...';
    case 'tasks': { const m = tasksMessage(); await tg.send(m.text, { buttons: m.buttons }); return null; }
    case 'finance': { const fin = skills.get('financas').api; await tg.send(fin.summaryText(), { buttons: fin.menuButtons }); return null; }
    case 'focus': { const r = await skills.runDirect('focus_start', {}); return r.ok ? 'Foco iniciado' : r.error; }
    case 'lock': pcInput.key('lock'); return '🔒 PC bloqueado';
    case 'shutdown': telegramAsk('Desliga o computador em 1 minuto'); return '⏻'; // passa pela confirmação (botões Sim/Não)
    case 'shutdown_cancel': { const r = await skills.runDirect('pc_power_cancel', {}); return r.cancelado ? '✖ Desligamento cancelado' : 'Nada agendado'; }
    case 'sentinel': {
      const active = skillCtx.sentinelActive?.();
      const r = await skills.runDirect(active ? 'sentinel_stop' : 'sentinel_start', active ? {} : { delay_seconds: 10 });
      if (!r.ok) { await tg.send(`🛡 ${r.error}`); return null; }
      await tg.send(active ? `🛡 Sentinela desligada. Vigiou por ${r.watched_for}; ${Array.isArray(r.detections) ? `${r.detections.length} detecção(ões).` : 'ninguém apareceu.'}` : '🛡 Sentinela arma em 10 segundos. Alertas chegam aqui com foto.');
      return null;
    }
  }
  return null;
}

// ------------------------------------------------------------ Oficina (parede de painéis ao vivo)

function openOficinaWindow() {
  if (oficinaWin && !oficinaWin.isDestroyed()) { oficinaWin.show(); oficinaWin.focus(); return { ok: true, already_open: true }; }
  // vai para o segundo monitor, se houver; senão abre no principal
  const primary = screen.getPrimaryDisplay();
  const target = displaysByX().find((d) => d.id !== primary.id) || primary;
  const { x, y, width, height } = target.workArea;
  oficinaWin = new BrowserWindow({
    x, y, width, height, frame: false, backgroundColor: '#050505', icon: APP_ICON, title: 'J.A.R.V.I.S. · Oficina', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  oficinaWin.loadFile(path.join(__dirname, 'src', 'oficina.html'));
  oficinaWin.once('ready-to-show', () => {
    oficinaWin.show();
    if (target.id !== primary.id) oficinaWin.setFullScreen(true);
  });
  oficinaWin.on('closed', () => { oficinaWin = null; send('oficina-window', { open: false }); });
  send('oficina-window', { open: true });
  return { ok: true, monitor: target.id === primary.id ? 'principal' : 'segundo monitor' };
}

function closeOficinaWindow() {
  if (oficinaWin && !oficinaWin.isDestroyed()) oficinaWin.close();
}

// Dados extras (rede e processos) só são coletados enquanto alguma Oficina estiver visível
const oficinaViewers = new Set();
let oficinaTimer = null, oficinaTick = 0;
function updateOficinaTimer() {
  if (oficinaViewers.size && !oficinaTimer) {
    oficinaTimer = setInterval(async () => {
      oficinaTick++;
      const data = {};
      try {
        const net = await si.networkStats();
        data.net = { rx: net.reduce((a, n) => a + (n.rx_sec || 0), 0), tx: net.reduce((a, n) => a + (n.tx_sec || 0), 0) };
      } catch {}
      if (oficinaTick % 3 === 1) {
        try {
          const p = await si.processes();
          data.procs = p.list.filter((x) => x.name && !/^(System Idle Process|Idle)$/i.test(x.name))
            .sort((a, b) => b.cpu - a.cpu).slice(0, 6)
            .map((x) => ({ name: x.name.replace(/\.exe$/i, ''), cpu: Math.round(x.cpu * 10) / 10, mem: Math.round(x.memRss / 1024) }));
        } catch {}
        try { const s = fs.statfsSync('C:/'); data.diskC = s.bavail * s.bsize; } catch {}
      }
      send('oficina-stats', data);
    }, 2000);
  } else if (!oficinaViewers.size && oficinaTimer) {
    clearInterval(oficinaTimer);
    oficinaTimer = null;
  }
}

// Letreiro (câmbio + manchetes) e clima, com cache para não consultar a internet a todo momento
let oficinaFeed = { at: 0, data: null };
async function getOficinaFeed() {
  if (oficinaFeed.data && Date.now() - oficinaFeed.at < 10 * 60000) return oficinaFeed.data;
  const b = skills.get('briefing').api;
  const [currency, news, weather] = await Promise.all([
    b.getCurrency().catch(() => null),
    b.getAiNews().catch(() => []),
    skills.runDirect('get_weather', {}).catch(() => null),
  ]);
  oficinaFeed = { at: Date.now(), data: { currency, news, weather: weather?.now ? weather : null } };
  return oficinaFeed.data;
}

// ------------------------------------------------------------ controle do PC pelo celular

const pcInput = new PcInput(dataDir);
let screenTimer = null, screenBusy = false;

// Monitores da esquerda para a direita (o "Monitor 1" do celular é o mais à esquerda)
const displaysByX = () => screen.getAllDisplays().sort((a, b) => a.bounds.x - b.bounds.x);

function startScreenStream(monitor) {
  stopScreenStream();
  const tick = async () => {
    if (screenBusy || !phonecam.connected) return;
    screenBusy = true;
    try {
      const displays = displaysByX();
      const d = displays[Math.min(monitor, displays.length - 1)];
      const width = 1100, height = Math.round(width * d.bounds.height / d.bounds.width);
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
      const src = sources.find((s) => s.display_id === String(d.id)) || sources[0];
      phonecam.send({ t: 'screen', data: src.thumbnail.toJPEG(60).toString('base64'), monitors: displays.length });
    } catch (e) {
      console.error('[tela]', e.message);
    } finally {
      screenBusy = false;
    }
  };
  tick();
  screenTimer = setInterval(tick, 400); // ~2,5 quadros por segundo: suficiente para clicar e acompanhar
}
function stopScreenStream() { clearInterval(screenTimer); screenTimer = null; }
phonecam.on('disconnected', stopScreenStream);

function handlePcControl(m) {
  switch (m.cmd) {
    case 'move': pcInput.move(m.dx, m.dy); break;
    case 'click': pcInput.click(m.button); break;
    case 'scroll': pcInput.scroll(m.amount); break;
    case 'key': pcInput.key(m.key); break;
    case 'type': pcInput.type(m.text || ''); break;
    case 'tap': {
      // toque na imagem da tela do PC: leva o mouse exatamente até aquele ponto e clica
      const displays = displaysByX();
      const d = displays[Math.min(m.monitor || 0, displays.length - 1)];
      const sf = d.scaleFactor || 1;
      pcInput.moveTo((d.bounds.x + m.x * d.bounds.width) * sf, (d.bounds.y + m.y * d.bounds.height) * sf);
      setTimeout(() => pcInput.click('left'), 30);
      break;
    }
    case 'screen-start': startScreenStream(m.monitor || 0); break;
    case 'screen-stop': stopScreenStream(); break;
  }
}

// ------------------------------------------------------------ mensagens do app do celular

async function onPhoneMessage(m) {
  switch (m.t) {
    case 'hello': {
      phonecam.send({ t: 'tasks', tasks: skillCtx.getTasks().filter((t) => !t.done) });
      if (config.ytmToken) {
        ytm.nowPlaying({ reauth: false }).then((song) => phonecam.send({ t: 'now-playing', song })).catch(() => {});
        ytm.getVolume({ reauth: false }).then((value) => phonecam.send({ t: 'volume', value })).catch(() => {});
      }
      phonecam.send({ t: 'sentinel', active: !!skillCtx.sentinelActive?.() });
      phonecam.send({ t: 'reminders', reminders: skills.get('reminders').getAll() });
      pushAgentsToPhone();
      break;
    }
    case 'presence':
      // presença na mesa: só números (presente? postura?), o vídeo fica no celular
      await skills.get('presence').api.update(m);
      break;
    case 'mode':
      phoneDrive = !!m.drive;
      console.log('[celular] modo carro', phoneDrive ? 'ligado' : 'desligado');
      break;
    case 'text':
      handleUserInput(m.text, { channel: 'phone', speakHere: m.speakHere !== false });
      break;
    case 'audio': {
      let text = '';
      try { text = await transcribeAudio(Buffer.from(m.data, 'base64')); } catch (e) { console.error('[celular] transcrição:', e.message); }
      phonecam.send({ t: 'transcript', text });
      // o bloco "Rota" do modo carro manda o contexto junto (ex: "Rota de carro até: " + "shopping Ibirapuera")
      const prefix = typeof m.prefix === 'string' ? m.prefix.slice(0, 60) : '';
      if (text) handleUserInput(prefix + text, { channel: 'phone', speakHere: m.speakHere !== false });
      break;
    }
    case 'music':
      await skills.runDirect('music_control', { action: m.action });
      setTimeout(pushNowPlaying, 700);
      break;
    case 'volume':
      ytm.forgetDuck();
      await ytm.setVolume(m.value).catch(() => {});
      break;
    case 'task-done':
      skills.get('notes').api.updateTask(m.id, { status: 'done' });
      break;
    case 'task-add':
      if (m.text) skills.get('notes').api.addTask(m.text);
      break;
    case 'pc':
      handlePcControl(m);
      break;
    case 'ear':
    case 'rtc':
      audioBridge.onPhone(m);
      break;
    case 'hand':
      // pontos da mão (gestos) vão direto para a interface, sem passar pela IA
      if (win && !win.isDestroyed()) win.webContents.send('hand', { lm: m.lm, mirror: !!m.mirror });
      break;
  }
}

// ------------------------------------------------------------ IPC

// Texto digitado. Na tela de Chat a resposta é escrita (markdown, sem voz), salvo se o usuário ligar a voz.
ipcMain.on('user-text', (_, text, opts = {}) => handleUserInput(text, {
  chatMode: !!opts.chat,
  speakHere: opts.speak !== false,
  attachments: Array.isArray(opts.attachments) ? opts.attachments : [],
  effort: opts.effort || 'min',
}));
// Lê o texto de um arquivo (anexo do chat ou importação para um dossiê)
ipcMain.handle('file-extract', async (_, { name, bytes }) => {
  try {
    if (!bytes || bytes.byteLength > 30 * 1024 * 1024) return { ok: false, error: 'Arquivo grande demais (máx. 30 MB)' };
    return { ok: true, ...(await fileread.extract(Buffer.from(bytes), name)) };
  } catch (e) { return { ok: false, error: e.message }; }
});
// Dossiês (skills/knowledge.js)
ipcMain.handle('knowledge-list', () => skillCtx.knowledge.list());
ipcMain.handle('knowledge-get', (_, id) => skillCtx.knowledge.get(id));
ipcMain.handle('knowledge-save', (_, d) => { try { return { ok: true, ...skillCtx.knowledge.save(d) }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('knowledge-remove', (_, id) => skillCtx.knowledge.remove(id));
// Tela aberta no PC (o prompt e as respostas visuais mudam na tela de Chat)
let uiScreen = 'hud';
ipcMain.on('ui-screen', (_, name) => { uiScreen = name; });
ipcMain.on('forge-state', (_, st) => { forgeState = st || { active: false }; });
ipcMain.on('doc-state', (_, st) => {
  const wasPlaying = docState.active && !docState.paused;
  docState = st || { active: false };
  if (!docState.active) skills.get('documentary')?.stop();
  const playing = docState.active && !docState.paused;
  if (playing !== wasPlaying && !busy) assistantActive(playing); // música abaixada enquanto ele narra
});
// O PC começou a falar: o microfone fica vigiando para o usuário poder interromper
ipcMain.on('tts-playing', () => voiceSend({ cmd: config.bargeIn ? 'watch' : 'pause' }));
ipcMain.on('start-listening', () => {
  if (currentAbort) currentAbort.abort();
  voiceSend({ cmd: 'listen', timeout: 6 });
});
ipcMain.on('speech-done', (_, { followUp }) => {
  if (busy) return;
  voiceSend(followUp ? { cmd: 'listen', timeout: 5 } : { cmd: 'resume' });
  if (!followUp) {
    assistantActive(false);
    send('voice-status', { state: voiceReady ? 'idle' : 'loading' });
  }
});
ipcMain.on('stop', () => {
  if (currentAbort) currentAbort.abort();
  currentAbort = null;
  busy = false;
  voiceSend({ cmd: 'resume' });
  assistantActive(false);
  send('voice-status', { state: 'idle' });
});

ipcMain.handle('get-config', () => {
  const { ytmToken, ...rest } = config;
  return { ...rest, hasKey: !!config.apiKey };
});
ipcMain.handle('save-config', (_, next) => {
  const restartVoice = next.whisperModel && next.whisperModel !== config.whisperModel;
  const telegramChanged = next.telegramToken !== undefined && next.telegramToken !== config.telegramToken;
  const hotkeysChanged = next.hotkeyListen !== undefined && (next.hotkeyListen !== config.hotkeyListen || next.hotkeyToggle !== config.hotkeyToggle);
  config = { ...config, ...next };
  saveConfig();
  voiceSend({ cmd: 'config', voice: config.voice, wake_threshold: config.wakeThreshold });
  if (restartVoice && pyProc) { pyProc.kill(); setTimeout(startVoiceService, 800); }
  if (hotkeysChanged) registerHotkeys();
  if (telegramChanged) { if (next.telegramToken !== undefined && !next.telegramToken) config.telegramChatId = null; saveConfig(); startTelegram(); }
  ytm.exePath = config.ytmPath;
  if (config.miniOrb === false) showMini(false);
  return true;
});
ipcMain.handle('list-models', async (_, apiKey) => {
  const res = await fetch(`${NVIDIA_BASE}/models`, { headers: { Authorization: `Bearer ${apiKey || config.apiKey}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { data } = await res.json();
  return data.map((m) => m.id).filter((id) => /nemotron/i.test(id)).sort();
});
ipcMain.handle('get-history', () => history);
ipcMain.handle('get-voice-status', () => (voiceReady ? 'idle' : 'loading'));
ipcMain.handle('get-reminders', () => skills.get('reminders').getAll());
ipcMain.handle('get-tasks', () => skillCtx.getTasks().filter((t) => !t.done));
ipcMain.on('briefing-request', () => handleUserInput('Me dá o briefing do dia'));
ipcMain.handle('clear-history', () => { history = []; writeJson(files.history, history); return true; });

// Botões do painel de música
ipcMain.on('music-control', (_, action) => {
  skills.run('music_control', { action }).then(pushNowPlaying);
});

ipcMain.on('open-external', (_, url) => {
  if (/^https:\/\//.test(url)) shell.openExternal(url);
});

// ------------------------------------------------------------ telas

// Ferramentas que os botões das telas podem chamar direto
const UI_TOOLS = new Set([
  'project_open', 'project_run', 'project_dashboard', 'git_pull', 'process_kill', 'docker_container', 'docker_compose',
  'music_play', 'music_control', 'reminder_cancel', 'focus_start', 'focus_stop', 'camera_connect',
]);
ipcMain.handle('run-tool', async (_, { name, args }) => {
  if (!UI_TOOLS.has(name)) return { ok: false, error: 'Ação não permitida pela interface' };
  send('action', { name, arg: Object.values(args || {}).join(' · ') });
  return skills.runDirect(name, args);
});

// Projetos
ipcMain.handle('projects-overview', () => skills.get('dev').api.overview(skillCtx));
ipcMain.handle('projects-ports', () => skills.get('dev').api.ports());
ipcMain.handle('projects-containers', () => skills.get('dev').api.containers());
ipcMain.handle('projmem-data', (_, names) => skillCtx.projectMemory.overview(names || []));
ipcMain.handle('projmem-op', (_, { op, project, id, text }) => {
  const pm = skillCtx.projectMemory;
  if (op === 'decision') return pm.addDecision(project, text);
  if (op === 'context') return pm.setContext(project, text);
  if (op === 'remove') return pm.removeItem(project, id);
  return null;
});

// Agenda
ipcMain.handle('agenda-data', () => ({
  ...skills.get('notes').api.list(),
  reminders: skills.get('reminders').getAll(),
  focus: readJson(path.join(dataDir, 'focus-stats.json'), {}),
}));
ipcMain.handle('agenda-op', (_, { op, id, text, due, changes }) => {
  const api = skills.get('notes').api;
  if (op === 'task-add') return api.addTask(text, due);
  if (op === 'task-update') return api.updateTask(id, changes || {});
  if (op === 'task-delete') return api.deleteTask(id);
  if (op === 'note-add') return api.addNote(text);
  if (op === 'note-delete') return api.deleteNote(id);
  return null;
});

// Oficina
ipcMain.on('oficina-active', (e, active) => {
  if (active) oficinaViewers.add(e.sender.id); else oficinaViewers.delete(e.sender.id);
  e.sender.once('destroyed', () => { oficinaViewers.delete(e.sender.id); updateOficinaTimer(); });
  updateOficinaTimer();
});
ipcMain.handle('oficina-feed', () => getOficinaFeed());
ipcMain.handle('oficina-status', () => ({
  phone: phonecam.connected,
  telegram: telegramState.status,
  sentinel: !!skillCtx.sentinelActive?.(),
  voice: voiceReady,
  agents: skills.get('codeagent').api.list().filter((j) => j.status === 'running').length,
  model: config.model.split('/').pop(),
  focus: skills.get('focus').api.current(),
  windowOpen: !!(oficinaWin && !oficinaWin.isDestroyed()),
}));
ipcMain.handle('oficina-window', (_, open) => (open ? openOficinaWindow() : (closeOficinaWindow(), { ok: true })));

// Agente de código
ipcMain.handle('agent-state', () => ({ agents: skills.get('codeagent').api.agents(), jobs: skills.get('codeagent').api.list() }));
// Laboratório (botões da Oficina)
ipcMain.handle('lab-action', async (_, { action, text, agent, name }) => {
  const api = skills.get('lab').api;
  try {
    if (action === 'start') { const r = await api.start(text, agent, 'pc'); return { ok: true, ...r }; }
    if (action === 'change') return { ok: true, ...(await api.change(text)) };
    if (action === 'open') return { ok: true, ...api.open() };
    if (action === 'keep') return { ok: true, ...(await api.keep(name)) };
    if (action === 'close') return await api.close();
  } catch (e) { return { ok: false, error: e.message }; }
  return { ok: false };
});
ipcMain.handle('agent-action', async (_, { action, id, text, project, newProject, agent }) => {
  const api = skills.get('codeagent').api;
  try {
    if (action === 'accept') return await api.accept(id);
    if (action === 'discard') return await api.discard(id);
    if (action === 'adjust') return await api.adjust(id, text);
    if (action === 'open') { api.openInCode(id); return { ok: true }; }
    if (action === 'clear') { api.clear(id); return { ok: true }; }
    if (action === 'start') {
      const r = await api.start({ project, newProject, task: text, agent, origin: 'pc' });
      return { ok: true, job: r.job };
    }
  } catch (e) { return { ok: false, error: e.message }; }
  return { ok: false };
});

// Pesquisas
ipcMain.handle('research-list', () => skills.get('research').api.list());
ipcMain.handle('research-get', (_, id) => skills.get('research').api.get(id));
ipcMain.handle('research-delete', (_, id) => skills.get('research').api.remove(id));

// Memória
ipcMain.handle('memory-data', () => ({ facts: skillCtx.memory.list(), conversations: readConversations() }));
ipcMain.handle('memory-op', (_, { op, id, text }) => {
  if (op === 'add') return skillCtx.memory.add(text, 'manual');
  if (op === 'remove') return skillCtx.memory.remove(id);
  if (op === 'clear-log') { try { fs.writeFileSync(conversationsFile, ''); } catch {} return true; }
  return null;
});

// Música
ipcMain.handle('music-queue', async () => { try { return await ytm.getQueue(); } catch { return []; } });
ipcMain.handle('music-playlists', async () => { try { return await ytm.libraryPlaylists(); } catch { return []; } });
ipcMain.handle('music-lyrics', (_, song) => findLyrics(song).catch(() => null));
ipcMain.handle('music-op', async (_, { op, value }) => {
  try {
    if (op === 'seek') await ytm.api('POST', '/seek-to', { seconds: Math.max(0, Math.round(value)) });
    if (op === 'queue-index') await ytm.api('PATCH', '/queue', { index: value });
    if (op === 'playlist') await ytm.playEndpoint({ watchEndpoint: { playlistId: value } });
    if (op === 'volume') { ytm.forgetDuck(); await ytm.setVolume(value); }
    setTimeout(pushNowPlaying, 600);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('music-volume', async () => { try { return await ytm.getVolume({ reauth: false }); } catch { return null; } });

// Configurações
ipcMain.handle('skills-list', () => {
  const labels = { music: 'Música', system: 'Windows (programas, volume, print)', info: 'Internet (clima, notícias, pesquisa)', reminders: 'Lembretes', dev: 'Programação (git, GitHub, portas, Docker)', briefing: 'Briefing do dia', focus: 'Modo foco', notes: 'Notas e tarefas', visual: 'Respostas visuais', camera: 'Câmera do celular', memory: 'Memória de longo prazo', nav: 'Navegação entre telas', sentinel: 'Modo sentinela', sketch: 'Desenho → código', research: 'Pesquisa profunda e comparador', codeagent: 'Agentes de código (Oficina)', lab: 'Laboratório de protótipos', drive: 'JARVIS Drive (modo carro)', presence: 'Presença na mesa e postura', holo: 'Hologramas e gestos', documentary: 'Documentários', windows: 'Monitores e janelas', conversa: 'Botões de escolha nas respostas', financas: 'Gestor financeiro (gastos, orçamentos, contas)', espelho: 'Espelhamento do iPhone (AirPlay)' };
  return skills.skills.filter((s) => s.tools?.length).map((s) => ({ name: s.name, label: labels[s.name] || s.name, tools: s.tools.length, enabled: !(config.disabledSkills || []).includes(s.name) }));
});
ipcMain.handle('telegram-status', () => telegramState);
ipcMain.handle('telegram-unpair', () => { config.telegramChatId = null; config.telegramUser = ''; saveConfig(); return startTelegram().then(() => telegramState); });
ipcMain.handle('disk-info', () => ['C:\\', 'E:\\'].map((drive) => {
  try {
    const s = fs.statfsSync(drive);
    return { drive: drive.slice(0, 2), free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch { return { drive: drive.slice(0, 2), error: true }; }
}));
ipcMain.on('test-voice', () => {
  voiceSend({ cmd: 'config', voice: config.voice, wake_threshold: config.wakeThreshold });
  announce(`Olá, ${config.userName}. Esta é a minha voz atual.`);
});
ipcMain.handle('ytm-reauth', async () => {
  config.ytmToken = '';
  saveConfig();
  try { await ytm.ensure(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});

// Mini-orb
ipcMain.on('mini-ignore', (_, ignore) => { if (mini) mini.setIgnoreMouseEvents(ignore, { forward: true }); });
ipcMain.on('mini-drag', (_, { dx, dy }) => {
  if (!mini) return;
  const [x, y] = mini.getPosition();
  mini.setPosition(x + dx, y + dy);
});
ipcMain.on('mini-drag-end', () => {
  if (!mini) return;
  const [x, y] = mini.getPosition();
  config.miniPos = { x, y };
  saveConfig();
});
ipcMain.on('show-main', () => toggleMain());
// O renderer principal manda o nível do áudio da fala para o mini-orb pulsar junto
ipcMain.on('speak-level', (_, v) => {
  if (mini && !mini.isDestroyed() && mini.isVisible()) mini.webContents.send('speak-level', v);
});

ipcMain.on('win', (_, action) => {
  if (!win) return;
  if (action === 'min') win.minimize();
  else if (action === 'max') win.isMaximized() ? win.unmaximize() : win.maximize();
  else if (action === 'close') win.close();
});

// ------------------------------------------------------------ monitor do sistema e música

async function pushStats() {
  try {
    const load = await si.currentLoad();
    const total = os.totalmem();
    lastStats = {
      cpu: Math.round(load.currentLoad),
      ram: Math.round(((total - os.freemem()) / total) * 100),
      uptime: os.uptime(),
    };
    send('stats', lastStats);
  } catch {}
}

let lastSong = null;
async function pushNowPlaying() {
  if (!config.ytmToken) return;
  try {
    const song = await ytm.nowPlaying({ reauth: false });
    lastSong = song;
    send('now-playing', song);
    phonecam.send({ t: 'now-playing', song });
  } catch {
    send('now-playing', null);
  }
}

// ------------------------------------------------------------ ciclo de vida

// Atalhos globais: funcionam com qualquer programa em foco
function registerHotkeys() {
  globalShortcut.unregisterAll();
  const keys = [
    [config.hotkeyListen, () => {
      if (currentAbort) currentAbort.abort();
      voiceSend({ cmd: 'listen', timeout: 6 });
    }],
    [config.hotkeyToggle, toggleMain],
  ];
  for (const [accel, fn] of keys) {
    if (!accel) continue;
    try {
      if (!globalShortcut.register(accel, fn)) toast(`O atalho ${accel} já está em uso por outro programa`, 'error');
    } catch { toast(`Atalho inválido: ${accel}`, 'error'); }
  }
}

app.whenReady().then(() => {
  skills = loadSkills(skillCtx);
  createWindow();
  createMini();
  registerHotkeys();
  // Captura do áudio do sistema (loopback) sem pedir tela: visualizador da tela de Música e o fone pelo
  // celular (este com loopbackWithMute: o som sai só no celular enquanto transmite)
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const audio = audioBridge.isBridgeFrame(request.frame) ? 'loopbackWithMute' : 'loopback';
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => callback({ video: sources[0], audio }));
  });
  startVoiceService();
  // O app do celular volta a funcionar sozinho depois do primeiro pareamento
  if (config.phoneEnabled) phonecam.start().catch((e) => console.error('[celular]', e.message));
  startTelegram();
  setInterval(pushStats, 2000);
  setInterval(pushNowPlaying, 3000);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  audioBridge.stop('encerrando');
  phonecam.stop();
});

app.on('window-all-closed', () => {
  if (pyProc) pyProc.kill();
  app.quit();
});app.on('before-quit', () => { if (pyProc) pyProc.kill(); skills?.get('espelho')?.stop(); });
