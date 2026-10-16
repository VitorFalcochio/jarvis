// App do JARVIS no celular: conversa (voz e texto), controle da música, tarefas e câmera.
const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.search).get('t');
let ws;

// ------------------------------------------------------------ conexão

function connect() {
  ws = new WebSocket(`wss://${location.host}/ws?t=${token}`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    $('st').textContent = 'conectado';
    $('dot').classList.add('on');
    send({ t: 'hello' });
    if (drive.on) send({ t: 'mode', drive: true });
    driveConn(true);
  };
  ws.onclose = () => {
    $('st').textContent = 'reconectando...';
    $('dot').classList.remove('on');
    driveConn(false);
    // o PC desliga a ponte de áudio quando o celular desconecta; aqui o botão volta a "Ouvir"
    if (ear.pc) { earStop(false); earStatus('A conexão com o PC caiu. Toque em "Ouvir" de novo.', 'err'); }
    setTimeout(connect, 1500);
  };
  ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch {} };
}
const send = (msg) => ws && ws.readyState === 1 && ws.send(JSON.stringify(msg));

// ------------------------------------------------------------ abas

function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => {
    if (t.id === 'tab-cam') t.classList.toggle('off', name !== 'cam');
    else t.hidden = t.id !== `tab-${name}`;
  });
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ------------------------------------------------------------ conversa

const chat = $('chat');
let aiBubble = null;

function bubble(cls, text) {
  chat.querySelector('.hint')?.remove();
  const el = document.createElement('div');
  el.className = `msg ${cls}`;
  if (text) el.textContent = text;
  chat.append(el);
  chat.scrollTop = chat.scrollHeight;
  return el;
}

function ask(text) {
  text = text.trim();
  if (!text) return;
  unlockAudio();
  bubble('user', text);
  aiBubble = null;
  send({ t: 'text', text, speakHere: $('speakHere').checked });
}

$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  ask($('text').value);
  $('text').value = '';
});

// Respostas faladas no celular: fila de mp3 tocada em ordem pelo Web Audio.
// iPhone/Android só liberam o áudio depois de um toque do usuário: o AudioContext é criado/retomado no toque.
let actx = null;
const audioQueue = [];
let playingAudio = false;
function unlockAudio() {
  if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
  if (actx.state === 'suspended') actx.resume();
}
async function playNext() {
  if (playingAudio || !audioQueue.length || !actx) return;
  playingAudio = true;
  const b64 = audioQueue.shift();
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const buffer = await actx.decodeAudioData(bytes.buffer);
    const src = actx.createBufferSource();
    src.buffer = buffer;
    src.connect(actx.destination);
    src.onended = () => { playingAudio = false; if (!audioQueue.length) driveMic('idle'); playNext(); };
    src.start();
    driveMic('speaking');
  } catch {
    playingAudio = false;
    playNext();
  }
}

// Segurar para falar: grava no celular e o PC transcreve
let recorder = null, chunks = [], recStart = 0;
async function startRec(e) {
  e.preventDefault();
  unlockAudio();
  if (recorder) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    chunks = [];
    recorder.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data);
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: recorder.mimeType });
      recorder = null;
      $('mic').classList.remove('rec');
      if (Date.now() - recStart < 500) return; // toque acidental
      $('mic').classList.add('busy');
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      send({ t: 'audio', data: btoa(bin), mime: blob.type, speakHere: $('speakHere').checked });
    };
    recorder.start();
    recStart = Date.now();
    $('mic').classList.add('rec');
    navigator.vibrate?.(30);
    setTimeout(() => recorder?.state === 'recording' && recorder.stop(), 30000);
  } catch (err) {
    bubble('sys', `Não consegui usar o microfone: ${err.message}`);
  }
}
function stopRec(e) {
  e.preventDefault();
  if (recorder?.state === 'recording') recorder.stop();
}
$('mic').addEventListener('pointerdown', startRec);
$('mic').addEventListener('pointerup', stopRec);
$('mic').addEventListener('pointerleave', stopRec);
$('mic').addEventListener('pointercancel', stopRec);

// ------------------------------------------------------------ mensagens do PC

function onMessage(m) {
  if (drive.on) driveMessage(m);
  switch (m.t) {
    case 'transcript':
      $('mic').classList.remove('busy');
      if (m.text) { bubble('user', m.text); aiBubble = null; } else bubble('sys', 'Não entendi o áudio. Tente de novo.');
      break;
    case 'delta':
      if (!aiBubble) aiBubble = bubble('ai', '');
      aiBubble.textContent += m.text;
      chat.scrollTop = chat.scrollHeight;
      if (camAsking) {
        // a primeira parte da resposta substitui o "Olhando..."
        const fresh = $('camAnswer').dataset.fresh === '1';
        $('camAnswer').dataset.fresh = '';
        showCamAnswer(fresh ? m.text.trimStart() : m.text, !fresh);
      }
      break;
    case 'done':
      $('mic').classList.remove('busy');
      aiBubble = null;
      camAsking = false;
      break;
    case 'screen':
      if (screenOn && m.data) $('pcScreen').src = `data:image/jpeg;base64,${m.data}`;
      if (m.monitors) { monitors = m.monitors; $('pcMonitor').hidden = !screenOn || monitors < 2; }
      break;
    case 'audio':
      if (m.data) { audioQueue.push(m.data); playNext(); }
      break;
    case 'alert':
      showAlert(m.text, m.image);
      break;
    case 'now-playing':
      renderMusic(m.song);
      $('dSong').textContent = m.song ? `${m.song.title} · ${m.song.artist}` : 'Nada tocando';
      $('dPlay').textContent = m.song && !m.song.paused ? '⏸' : '▶';
      break;
    case 'volume':
      if (typeof m.value === 'number') $('mVol').value = m.value;
      break;
    case 'tasks':
      renderTasks(m.tasks);
      drive.tasks = m.tasks || [];
      renderDriveAgenda();
      break;
    case 'reminders':
      drive.reminders = m.reminders || [];
      renderDriveAgenda();
      break;
    case 'agents':
      drive.agents = m.list || [];
      renderDriveProjects();
      break;
    case 'navigate':
      showRoute(m);
      break;
    case 'sentinel':
      $('sentinel').hidden = !m.active;
      break;
    case 'presence-cmd':
      if (m.calibrate) { pres.baseline = null; pres.calib = []; }
      else togglePresence(!!m.on);
      break;
    case 'rtc':
      earSignal(m);
      break;
    case 'ear-state':
      if (m.state === 'error' || m.state === 'failed') { earStop(false); earStatus(`Falhou: ${m.error || 'sem conexão de áudio'}`, 'err'); }
      break;
  }
}

function showAlert(text, image) {
  navigator.vibrate?.([200, 100, 200, 100, 400]);
  const el = bubble('alert-msg', `⚠ ${text}`);
  if (image) { const img = document.createElement('img'); img.src = `data:image/jpeg;base64,${image}`; el.append(img); }
  const banner = $('alert');
  banner.textContent = `⚠ ${text}`;
  banner.hidden = false;
  clearTimeout(showAlert.t);
  showAlert.t = setTimeout(() => { banner.hidden = true; }, 8000);
  if ('Notification' in window && Notification.permission === 'granted') new Notification('JARVIS', { body: text });
}

// ------------------------------------------------------------ música

function renderMusic(s) {
  $('mTitle').textContent = s ? s.title : 'Nada tocando';
  $('mArtist').textContent = s ? s.artist : 'Peça uma música na aba Falar';
  if (s?.cover) { if ($('cover').src !== s.cover) $('cover').src = s.cover; } else $('cover').removeAttribute('src');
  $('mToggle').textContent = s && !s.paused ? '⏸' : '▶';
  $('mProgress').style.width = s?.duration ? `${Math.min(100, (s.elapsed / s.duration) * 100)}%` : '0';
}
document.querySelectorAll('[data-m]').forEach((b) => b.addEventListener('click', () => { navigator.vibrate?.(15); send({ t: 'music', action: b.dataset.m }); }));
let volTimer;
$('mVol').addEventListener('input', () => { clearTimeout(volTimer); volTimer = setTimeout(() => send({ t: 'volume', value: Number($('mVol').value) }), 150); });

// ------------------------------------------------------------ tarefas

function renderTasks(tasks) {
  const ul = $('tasks');
  ul.innerHTML = '';
  if (!tasks.length) { const li = document.createElement('li'); li.textContent = 'Nada pendente. 🎉'; li.className = 'muted'; ul.append(li); return; }
  tasks.forEach((t) => {
    const li = document.createElement('li');
    if (t.status === 'doing') li.classList.add('doing');
    const btn = document.createElement('button');
    btn.title = 'Concluir';
    btn.addEventListener('click', () => { li.classList.add('done'); navigator.vibrate?.(20); send({ t: 'task-done', id: t.id }); });
    const txt = document.createElement('div');
    txt.textContent = t.text;
    if (t.status === 'doing' || t.due) {
      const small = document.createElement('small');
      small.textContent = [t.status === 'doing' ? 'fazendo' : '', t.due ? `até ${t.due.split('-').reverse().slice(0, 2).join('/')}` : ''].filter(Boolean).join(' · ');
      txt.append(small);
    }
    li.append(btn, txt);
    ul.append(li);
  });
}
$('taskForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('taskText').value.trim();
  if (!text) return;
  send({ t: 'task-add', text });
  $('taskText').value = '';
});

// ------------------------------------------------------------ câmera

const v = $('v');
const canvas = document.createElement('canvas');
const ctx2d = canvas.getContext('2d');
let stream = null, facing = 'environment', frameTimer, wakeLock;

function setCamUi() {
  const on = !!stream;
  $('camGo').classList.toggle('on', on);
  $('camMsg').style.display = on ? 'none' : '';
  // câmera da frente: espelha a imagem (como um espelho/selfie)
  document.querySelector('.cam-view').classList.toggle('mirror', on && facing === 'user');
}

async function startCam() {
  if (stream) stream.getTracks().forEach((tr) => tr.stop());
  stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  v.srcObject = stream;
  setCamUi();
  keepAwake();
}

function stopCam() {
  if (stream) stream.getTracks().forEach((tr) => tr.stop());
  stream = null;
  v.srcObject = null;
  clearInterval(frameTimer);
  if (gesturesOn) toggleGestures();
  if (pres.on) togglePresence(false);
  setCamUi();
}

async function keepAwake() { try { wakeLock = await navigator.wakeLock.request('screen'); } catch {} }

function sendFrames() {
  clearInterval(frameTimer);
  frameTimer = setInterval(() => {
    if (!ws || ws.readyState !== 1 || !v.videoWidth || ws.bufferedAmount > 1e6) return;
    // com gestos ligados, menos quadros (o que importa ali são os pontos da mão);
    // só com a presença ligada, 1 quadro a cada 2 s (a análise roda aqui no celular)
    if ((gesturesOn || pres.on) && (frameTimer.skip = (frameTimer.skip || 0) + 1) % (gesturesOn ? 4 : 16)) return;
    const w = Math.min(960, v.videoWidth), h = Math.round(v.videoHeight * w / v.videoWidth);
    canvas.width = w; canvas.height = h;
    ctx2d.drawImage(v, 0, 0, w, h);
    canvas.toBlob((b) => b && b.arrayBuffer().then((buf) => ws.send(buf)), 'image/jpeg', 0.7);
  }, 125);
}

async function ensureCam() {
  if (stream) return true;
  try {
    await startCam();
    sendFrames();
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    return true;
  } catch (e) {
    $('camMsg').style.display = '';
    $('camMsg').textContent = `Não consegui acessar a câmera: ${e.message}`;
    return false;
  }
}

$('camGo').addEventListener('click', () => (stream ? stopCam() : ensureCam()));
$('camFlip').addEventListener('click', async () => {
  facing = facing === 'environment' ? 'user' : 'environment';
  navigator.vibrate?.(15);
  if (stream) { try { await startCam(); } catch (e) { bubble('sys', `Não consegui virar a câmera: ${e.message}`); } }
});

// ---- perguntar sobre o que a câmera vê / desenho → código (resposta aparece por cima do vídeo)
let camAsking = false;
function showCamAnswer(text, append) {
  const box = $('camAnswer');
  box.hidden = false;
  box.textContent = append ? box.textContent + text : text;
  box.scrollTop = box.scrollHeight;
}

async function askCamera(question) {
  if (!(await ensureCam())) return;
  unlockAudio();
  $('askSheet').hidden = true;
  camAsking = true;
  showCamAnswer('👁 Olhando...');
  $('camAnswer').dataset.fresh = '1';
  await new Promise((r) => setTimeout(r, 700)); // garante quadros novos chegando ao PC
  send({ t: 'text', text: `Olhe pela câmera do celular e responda: ${question}`, speakHere: $('speakHere').checked });
}

$('camAsk').addEventListener('click', () => {
  const sheet = $('askSheet');
  sheet.hidden = !sheet.hidden;
  if (!sheet.hidden) setTimeout(() => $('askText').focus(), 50);
});
document.querySelectorAll('#askSheet [data-q]').forEach((b) => b.addEventListener('click', () => askCamera(b.dataset.q)));
$('askForm').addEventListener('submit', (e) => {
  e.preventDefault();
  askCamera($('askText').value.trim() || 'O que você está vendo?');
  $('askText').value = '';
});
$('camSketch').addEventListener('click', async () => {
  if (!(await ensureCam())) return;
  unlockAudio();
  camAsking = true;
  showCamAnswer('✏ Lendo o desenho e escrevendo o código... (cerca de 1 minuto)');
  $('camAnswer').dataset.fresh = '1';
  await new Promise((r) => setTimeout(r, 700));
  send({ t: 'text', text: 'Transforma em código o desenho de tela que estou mostrando na câmera do celular', speakHere: $('speakHere').checked });
});
$('camAnswer').addEventListener('click', () => { $('camAnswer').hidden = true; });

// ------------------------------------------------------------ gestos (reconhecimento de mão no próprio celular)
// O MediaPipe roda aqui no celular e só os 21 pontos da mão vão para o PC (bem mais leve que vídeo)

const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1';
let landmarker = null, gesturesOn = false, lastSent = 0, handVisible = false;
const hc = $('handCanvas'), hctx = hc.getContext('2d');

async function loadLandmarker() {
  const { FilesetResolver, HandLandmarker } = await import(`${MP}/vision_bundle.mjs`);
  const files = await FilesetResolver.forVisionTasks(`${MP}/wasm`);
  return HandLandmarker.createFromOptions(files, {
    baseOptions: {
      modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    numHands: 1,
  });
}

function drawHand(lm) {
  hc.width = hc.clientWidth; hc.height = hc.clientHeight;
  hctx.clearRect(0, 0, hc.width, hc.height);
  if (!lm || !v.videoWidth) return;
  // o vídeo usa object-fit: contain; converte para a área visível
  const scale = Math.min(hc.width / v.videoWidth, hc.height / v.videoHeight);
  const w = v.videoWidth * scale, h = v.videoHeight * scale, ox = (hc.width - w) / 2, oy = (hc.height - h) / 2;
  hctx.fillStyle = '#e9d6b6';
  for (const p of lm) { hctx.beginPath(); hctx.arc(ox + p[0] * w, oy + p[1] * h, 4, 0, Math.PI * 2); hctx.fill(); }
}

function handLoop() {
  if (!gesturesOn) return;
  if (landmarker && v.videoWidth && v.readyState >= 2) {
    const now = performance.now();
    const res = landmarker.detectForVideo(v, now);
    const lm = res.landmarks?.[0]?.map((p) => [Math.round(p.x * 1000) / 1000, Math.round(p.y * 1000) / 1000, Math.round(p.z * 1000) / 1000]) || null;
    drawHand(lm);
    if (lm && now - lastSent > 45) { // ~20 por segundo
      lastSent = now;
      handVisible = true;
      send({ t: 'hand', lm, mirror: facing === 'user' });
    } else if (!lm && handVisible) {
      handVisible = false;
      send({ t: 'hand', lm: null });
    }
  }
  requestAnimationFrame(handLoop);
}

async function toggleGestures() {
  const btn = $('gestures');
  if (gesturesOn) {
    gesturesOn = false;
    btn.classList.remove('green');
    drawHand(null);
    send({ t: 'hand', lm: null });
    return;
  }
  try {
    btn.textContent = '…';
    if (!stream) {
      facing = 'user'; // para gestos, a câmera da frente olhando para você costuma ser o melhor
      if (!(await ensureCam())) { btn.textContent = '✋'; return; }
    }
    if (!landmarker) landmarker = await loadLandmarker();
    gesturesOn = true;
    btn.classList.add('green');
    requestAnimationFrame(handLoop);
  } catch (e) {
    bubble('sys', `Não consegui carregar o reconhecimento de mãos: ${e.message}`);
  }
  btn.textContent = '✋';
}
$('gestures').addEventListener('click', toggleGestures);

// ------------------------------------------------------------ presença na mesa e postura
// O MediaPipe Pose roda aqui no celular (apoiado olhando para você) e só manda para o PC
// { present, posture } uma vez por segundo. Postura: altura da cabeça acima dos ombros, dividida
// pela largura dos ombros, comparada com a calibração (os primeiros ~5 s, sentado direito).

const pres = { on: false, timer: null, baseline: null, calib: [], lastSend: 0, present: false, posture: null };
let poser = null;

async function loadPoser() {
  const { FilesetResolver, PoseLandmarker } = await import(`${MP}/vision_bundle.mjs`);
  const files = await FilesetResolver.forVisionTasks(`${MP}/wasm`);
  return PoseLandmarker.createFromOptions(files, {
    baseOptions: {
      modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    numPoses: 1,
  });
}

function presTick() {
  if (!pres.on || !poser || !v.videoWidth || v.readyState < 2) return;
  const now = performance.now();
  let lm = null;
  try { lm = poser.detectForVideo(v, now).landmarks?.[0] || null; } catch { return; }
  const vis = (i) => !!lm && (lm[i].visibility ?? 1) > 0.5;
  const present = !!lm && vis(0) && (vis(11) || vis(12));
  let posture = null;
  if (present && vis(11) && vis(12)) {
    const shoulders = Math.hypot(lm[11].x - lm[12].x, lm[11].y - lm[12].y);
    const ratio = ((lm[11].y + lm[12].y) / 2 - lm[0].y) / shoulders;
    if (!pres.baseline) {
      pres.calib.push(ratio);
      if (pres.calib.length >= 15) pres.baseline = [...pres.calib].sort((a, b) => a - b)[7]; // mediana
    } else posture = ratio < pres.baseline * 0.8 ? 'bad' : 'ok';
  }
  pres.present = present;
  pres.posture = posture;
  renderPres();
  if (now - pres.lastSend > 1000) { pres.lastSend = now; send({ t: 'presence', present, posture }); }
}

function renderPres() {
  const pill = $('presPill');
  pill.hidden = !pres.on;
  if (!pres.on) return;
  let line;
  if (!pres.present) line = '<span class="away">Ninguém na mesa</span>';
  else if (!pres.baseline) line = `Calibrando: sente direito… (${pres.calib.length}/15)`;
  else line = pres.posture === 'bad' ? '<span class="bad">Você está aqui · postura curvada</span>' : '<span class="ok">Você está aqui · postura boa</span>';
  if (pill.dataset.line === line) return;
  pill.dataset.line = line;
  pill.innerHTML = `<b>🪑 Presença na mesa</b>${line}<button type="button" id="presCalib">Recalibrar postura</button>`;
  $('presCalib').onclick = () => { pres.baseline = null; pres.calib = []; navigator.vibrate?.(20); };
}

async function togglePresence(force) {
  const want = typeof force === 'boolean' ? force : !pres.on;
  const btn = $('presence');
  if (!want) {
    if (!pres.on) return;
    pres.on = false;
    clearInterval(pres.timer);
    btn.classList.remove('green');
    renderPres();
    send({ t: 'presence', off: true });
    return;
  }
  if (pres.on) return;
  try {
    btn.textContent = '…';
    if (!stream) {
      facing = 'user'; // o celular fica de frente para você
      if (!(await ensureCam())) { btn.textContent = '🪑'; return; }
    }
    if (!poser) poser = await loadPoser();
    Object.assign(pres, { on: true, baseline: null, calib: [], present: false, posture: null });
    btn.classList.add('green');
    pres.timer = setInterval(presTick, 333);
    showTab('cam');
    renderPres();
  } catch (e) {
    bubble('sys', `Não consegui carregar a detecção de presença: ${e.message}`);
  }
  btn.textContent = '🪑';
}
$('presence').addEventListener('click', () => togglePresence());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });

// ------------------------------------------------------------ PC: touchpad, tela ao vivo e atalhos

const pad = $('pad');
let screenOn = false, monitor = 0, monitors = 1;
const pc = (cmd) => send({ t: 'pc', ...cmd });

function ripple(x, y) {
  const r = document.createElement('i');
  r.className = 'tap';
  r.style.left = `${x}px`;
  r.style.top = `${y}px`;
  pad.append(r);
  setTimeout(() => r.remove(), 500);
}

// Área visível da imagem da tela do PC dentro do touchpad (object-fit: contain)
function screenRect() {
  const img = $('pcScreen');
  if (!screenOn || !img.naturalWidth) return null;
  const b = pad.getBoundingClientRect();
  const s = Math.min(b.width / img.naturalWidth, b.height / img.naturalHeight);
  const w = img.naturalWidth * s, h = img.naturalHeight * s;
  return { x: b.left + (b.width - w) / 2, y: b.top + (b.height - h) / 2, w, h };
}

// Gestos do touchpad: 1 dedo arrasta = move; toque = clique; 2 dedos = rolar; toque longo = clique direito
// Com a tela do PC visível, um toque clica EXATAMENTE no ponto tocado da imagem
const touches = new Map();
let gesture = null; // { start, moved, fingers, lastX, lastY, lastScrollY, longTimer }
let moveAcc = { x: 0, y: 0 }, moveTimer = null;

function flushMove() {
  moveTimer = null;
  if (moveAcc.x || moveAcc.y) pc({ cmd: 'move', dx: Math.round(moveAcc.x), dy: Math.round(moveAcc.y) });
  moveAcc = { x: 0, y: 0 };
}

pad.addEventListener('pointerdown', (e) => {
  pad.setPointerCapture(e.pointerId);
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  pad.classList.add('active');
  if (touches.size === 1) {
    gesture = { start: performance.now(), moved: 0, fingers: 1, lastX: e.clientX, lastY: e.clientY, x0: e.clientX, y0: e.clientY };
    gesture.longTimer = setTimeout(() => {
      if (gesture && gesture.moved < 10 && gesture.fingers === 1) { pc({ cmd: 'click', button: 'right' }); navigator.vibrate?.(30); ripple(e.clientX - pad.getBoundingClientRect().left, e.clientY - pad.getBoundingClientRect().top); gesture.done = true; }
    }, 550);
  } else if (gesture) {
    gesture.fingers = Math.max(gesture.fingers, touches.size);
    gesture.lastScrollY = [...touches.values()].reduce((a, t) => a + t.y, 0) / touches.size;
  }
});

pad.addEventListener('pointermove', (e) => {
  if (!touches.has(e.pointerId) || !gesture) return;
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (touches.size >= 2) {
    const y = [...touches.values()].reduce((a, t) => a + t.y, 0) / touches.size;
    const dy = y - (gesture.lastScrollY ?? y);
    if (Math.abs(dy) > 12) { pc({ cmd: 'scroll', amount: Math.round(-dy * 4) }); gesture.lastScrollY = y; gesture.moved += Math.abs(dy); }
    return;
  }
  const dx = e.clientX - gesture.lastX, dy = e.clientY - gesture.lastY;
  gesture.lastX = e.clientX; gesture.lastY = e.clientY;
  gesture.moved += Math.abs(dx) + Math.abs(dy);
  if (screenOn) return; // com a tela visível, o toque é absoluto (clica onde tocar)
  // aceleração: movimentos rápidos andam mais
  const speed = Math.hypot(dx, dy), k = speed > 12 ? 3.2 : speed > 5 ? 2.2 : 1.4;
  moveAcc.x += dx * k; moveAcc.y += dy * k;
  if (!moveTimer) moveTimer = setTimeout(flushMove, 16);
});

function endTouch(e) {
  if (!touches.has(e.pointerId)) return;
  touches.delete(e.pointerId);
  if (touches.size || !gesture) return;
  clearTimeout(gesture.longTimer);
  pad.classList.remove('active');
  const quick = performance.now() - gesture.start < 300 && gesture.moved < 12;
  const b = pad.getBoundingClientRect();
  if (!gesture.done && quick) {
    if (gesture.fingers >= 2) { pc({ cmd: 'click', button: 'right' }); }
    else if (screenOn && screenRect()) {
      const r = screenRect();
      const rx = (gesture.x0 - r.x) / r.w, ry = (gesture.y0 - r.y) / r.h;
      if (rx >= 0 && rx <= 1 && ry >= 0 && ry <= 1) pc({ cmd: 'tap', x: rx, y: ry, monitor });
    } else pc({ cmd: 'click', button: 'left' });
    ripple(gesture.x0 - b.left, gesture.y0 - b.top);
    navigator.vibrate?.(10);
  }
  gesture = null;
}
pad.addEventListener('pointerup', endTouch);
pad.addEventListener('pointercancel', endTouch);

$('pcScreenBtn').addEventListener('click', () => {
  screenOn = !screenOn;
  $('pcScreenBtn').classList.toggle('on', screenOn);
  $('pcMonitor').hidden = !screenOn || monitors < 2;
  $('padLabel').style.display = screenOn ? 'none' : '';
  $('pcHint').textContent = screenOn ? 'Toque na imagem para clicar ali · 2 dedos = rolar · segurar = clique direito' : 'Arraste para mover o mouse · toque = clique · 2 dedos = rolar';
  if (!screenOn) $('pcScreen').removeAttribute('src');
  pc({ cmd: screenOn ? 'screen-start' : 'screen-stop', monitor });
});
$('pcMonitor').addEventListener('click', () => {
  monitor = (monitor + 1) % monitors;
  $('pcMonitor').textContent = `Monitor ${monitor + 1}`;
  pc({ cmd: 'screen-start', monitor });
});
document.querySelectorAll('[data-k]').forEach((b) => b.addEventListener('click', () => {
  navigator.vibrate?.(10);
  const k = b.dataset.k;
  if (k === 'left' || k === 'right') pc({ cmd: 'click', button: k });
  else pc({ cmd: 'key', key: k });
}));
$('typeForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('typeText').value;
  if (!text) return;
  pc({ cmd: 'type', text });
  $('typeText').value = '';
});

// ------------------------------------------------------------ JARVIS DRIVE (modo carro)
// Toque no microfone, fale e ele para sozinho quando você para de falar. Respostas sempre faladas aqui.
// Blocos: agenda (próximo lembrete/tarefa), música, rota (Google Maps/Waze) e projetos (agentes).

const drive = { on: false, tasks: [], reminders: [], agents: [], rec: null, answer: '' };

function driveMic(state) {
  if (!drive.on) return;
  const mic = $('dMic');
  mic.className = `d-mic ${state === 'idle' ? '' : state}`;
  $('dMicLabel').textContent = { idle: 'FALAR', listening: 'OUVINDO', thinking: 'PENSANDO', speaking: 'FALANDO' }[state] || 'FALAR';
  if (state !== 'listening') mic.querySelector('.d-ring').style.transform = '';
}
function driveCaption(text, cls = '') {
  const c = $('dCaption');
  c.textContent = text;
  c.className = `d-caption ${cls}`;
}
function driveConn(ok) {
  $('dDot').classList.toggle('on', ok);
  $('dState').textContent = ok ? 'conectado' : 'sem conexão com o PC';
}

async function keepAwakeDrive() { try { drive.lock = await navigator.wakeLock.request('screen'); } catch {} }

function setDrive(on) {
  drive.on = on;
  $('drive').hidden = !on;
  try { localStorage.setItem('jarvisDrive', on ? '1' : '0'); } catch {}
  send({ t: 'mode', drive: on });
  if (on) {
    keepAwakeDrive();
    tickDrive();
    renderDriveAgenda();
    renderDriveProjects();
    driveConn(ws && ws.readyState === 1);
    driveMic('idle');
  } else {
    drive.lock?.release?.().catch(() => {});
    stopDriveRec(true);
  }
}
$('driveBtn').addEventListener('click', () => { unlockAudio(); setDrive(true); });
$('dExit').addEventListener('click', () => setDrive(false));
// o primeiro toque em qualquer lugar libera o áudio (o navegador exige um toque)
$('drive').addEventListener('pointerdown', unlockAudio);
document.addEventListener('visibilitychange', () => { if (drive.on && document.visibilityState === 'visible') keepAwakeDrive(); });

function tickDrive() {
  $('dTime').textContent = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
setInterval(() => drive.on && tickDrive(), 10000);

// ---- gravação com detecção de silêncio (sem precisar segurar o botão)
async function startDriveRec(prefix = '') {
  unlockAudio();
  if (drive.rec) { stopDriveRec(); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (err) {
    driveCaption(`Sem acesso ao microfone: ${err.message}`, 'alert');
    return;
  }
  const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find((x) => MediaRecorder.isTypeSupported(x)) || '';
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
  const chunks = [];
  rec.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data);

  const src = actx.createMediaStreamSource(stream);
  const an = actx.createAnalyser();
  an.fftSize = 1024;
  src.connect(an);
  const buf = new Float32Array(an.fftSize);
  const t0 = performance.now();
  const st = { rec, stream, src, spoke: false, cancelled: false, prefix };
  let noise = 0.008, lastVoice = t0;
  st.timer = setInterval(() => {
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length), now = performance.now(), elapsed = now - t0;
    $('dMic').querySelector('.d-ring').style.transform = `scale(${1 + Math.min(0.5, rms * 6)})`;
    // os primeiros 350 ms medem o barulho do carro
    if (elapsed < 350) { noise = Math.max(0.004, noise * 0.7 + rms * 0.3); return; }
    if (rms > Math.max(0.018, noise * 2.8)) { st.spoke = true; lastVoice = now; }
    else if (!st.spoke) noise = noise * 0.97 + rms * 0.03;
    if (st.spoke && now - lastVoice > 1300) stopDriveRec();
    else if (!st.spoke && elapsed > 6000) stopDriveRec(true);
    else if (elapsed > 15000) stopDriveRec();
  }, 80);

  rec.onstop = async () => {
    stream.getTracks().forEach((tr) => tr.stop());
    src.disconnect();
    if (st.cancelled || !st.spoke) { driveMic('idle'); if (!st.cancelled) driveCaption('Não ouvi nada. Toque e fale de novo.'); return; }
    driveMic('thinking');
    driveCaption('Entendendo...', 'user');
    const blob = new Blob(chunks, { type: rec.mimeType });
    const b = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
    send({ t: 'audio', data: btoa(bin), mime: blob.type, speakHere: true, prefix: st.prefix || undefined });
  };
  drive.rec = st;
  rec.start();
  navigator.vibrate?.(40);
  driveMic('listening');
  driveCaption(prefix ? 'Para onde vamos?' : 'Pode falar...', 'user');
}
function stopDriveRec(cancel = false) {
  const st = drive.rec;
  if (!st) return;
  drive.rec = null;
  clearInterval(st.timer);
  st.cancelled = cancel;
  if (st.rec.state === 'recording') st.rec.stop();
  else st.stream.getTracks().forEach((tr) => tr.stop());
}
$('dMic').addEventListener('click', () => startDriveRec());

// pergunta por texto (blocos), resposta falada
function driveAsk(text, caption) {
  unlockAudio();
  driveMic('thinking');
  driveCaption(caption || text, 'user');
  send({ t: 'text', text, speakHere: true });
}

// ---- mensagens do PC no modo carro
function driveMessage(m) {
  switch (m.t) {
    case 'transcript':
      if (m.text) driveCaption(`“${m.text}”`, 'user');
      else { driveMic('idle'); driveCaption('Não entendi. Toque e fale de novo.'); }
      drive.answer = '';
      break;
    case 'delta':
      drive.answer += m.text;
      driveCaption(drive.answer.trim());
      break;
    case 'done':
      drive.answer = '';
      if (!playingAudio && !audioQueue.length) driveMic('idle');
      break;
    case 'alert':
      navigator.vibrate?.([200, 100, 200]);
      driveCaption(m.text, 'alert');
      break;
  }
}

// ---- blocos
function renderDriveAgenda() {
  const now = Date.now();
  const next = (drive.reminders || []).filter((r) => r.at > now - 60000 && r.at - now < 24 * 3600000).sort((a, b) => a.at - b.at)[0];
  const tasks = (drive.tasks || []).filter((t) => !t.done);
  const tile = $('dAgenda');
  if (next) {
    const mins = Math.round((next.at - now) / 60000);
    $('dAgendaMain').textContent = next.text;
    $('dAgendaSub').textContent = mins <= 0 ? 'agora' : mins < 60 ? `em ${mins} min` : new Date(next.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    tile.classList.toggle('warn', mins <= 15);
  } else {
    $('dAgendaMain').textContent = tasks.length ? tasks[0].text : 'Nada agora';
    $('dAgendaSub').textContent = tasks.length > 1 ? `+${tasks.length - 1} tarefa${tasks.length > 2 ? 's' : ''}` : tasks.length ? 'tarefa' : '';
    tile.classList.remove('warn');
  }
}
setInterval(() => drive.on && renderDriveAgenda(), 30000);

function renderDriveProjects() {
  const list = drive.agents || [];
  const running = list.filter((a) => a.status === 'running');
  const waiting = list.filter((a) => a.status === 'done');
  const failed = list.filter((a) => a.status === 'failed');
  const first = running[0] || waiting[0] || failed[0];
  $('dProjMain').textContent = first ? `${first.agent} · ${first.project}` : 'Agentes livres';
  $('dProjSub').textContent = [running.length && `${running.length} trabalhando`, waiting.length && `${waiting.length} esperando você`, failed.length && `${failed.length} com erro`].filter(Boolean).join(' · ');
  $('dProj').classList.toggle('warn', !!(waiting.length || failed.length));
}

$('dAgenda').addEventListener('click', () => driveAsk('O que eu tenho agora? Fale o próximo lembrete e as tarefas mais importantes, em uma frase curta.', 'Agenda...'));
$('dProj').addEventListener('click', () => driveAsk('Como estão as agentes de código? Resuma em uma frase curta.', 'Projetos...'));
$('dRoute').addEventListener('click', () => startDriveRec('Rota de carro até: '));
document.querySelectorAll('[data-dm]').forEach((b) => b.addEventListener('click', () => { navigator.vibrate?.(15); send({ t: 'music', action: b.dataset.dm }); }));

// ---- rota pronta: um toque abre no Google Maps ou no Waze
function showRoute(m) {
  if (!drive.on) setDrive(true);
  $('dNavDest').textContent = m.dest;
  $('dMaps').href = m.maps;
  $('dWaze').href = m.waze;
  // no iPhone também dá para usar o Apple Maps
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  $('dApple').hidden = !ios;
  $('dApple').href = `https://maps.apple.com/?daddr=${encodeURIComponent(m.dest)}&dirflg=d`;
  $('dMaps').classList.toggle('pref', m.app === 'maps');
  $('dWaze').classList.toggle('pref', m.app === 'waze');
  $('dNav').hidden = false;
  navigator.vibrate?.(60);
}
$('dNavClose').addEventListener('click', () => { $('dNav').hidden = true; });
document.querySelectorAll('.d-nav-apps a').forEach((a) => a.addEventListener('click', () => setTimeout(() => { $('dNav').hidden = true; }, 500)));

// abre direto no modo carro pelo link com &drive=1 (ou se ele estava ligado da última vez)
(() => {
  let saved = '0';
  try { saved = localStorage.getItem('jarvisDrive') || '0'; } catch {}
  if (new URLSearchParams(location.search).get('drive') === '1' || saved === '1') setDrive(true);
})();

// ------------------------------------------------------------ fone pelo celular
// O som do PC chega por WebRTC (conexão direta pela rede local ou Tailscale) e toca no <audio>, que o iPhone
// manda para o fone Bluetooth conectado. O microfone (opcional) vai pela mesma conexão até o PC, onde vira o
// microfone do JARVIS. O celular faz a oferta; o PC responde (lib/audiobridge.js + src/audiobridge.js).
const ear = { pc: null, tr: null, mic: null, lock: null, chain: Promise.resolve() };

function earStatus(text, kind = '') {
  $('earSt').textContent = text;
  $('earDot').className = kind;
}
function earButtons() {
  const on = !!ear.pc;
  $('earGo').textContent = on ? 'Parar' : 'Ouvir o PC aqui';
  $('earGo').classList.toggle('stop', on);
  $('earMic').disabled = !on;
  $('earMic').classList.toggle('on', !!ear.mic);
  $('earMic').textContent = ear.mic ? '🎙 Microfone do fone: ligado' : '🎙 Microfone do fone: desligado';
  $('earBtn').classList.toggle('on', on && !ear.mic);
  $('earBtn').classList.toggle('mic', on && !!ear.mic);
}

// Opus em estéreo e com taxa alta no sentido PC → celular
function earStereo(sdp) {
  const pt = (sdp.match(/a=rtpmap:(\d+) opus\/48000/i) || [])[1];
  if (!pt) return sdp;
  return sdp.replace(new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`), (line, p) =>
    `a=fmtp:${pt} ${p}${p.includes('stereo=') ? '' : ';stereo=1'}${p.includes('maxaveragebitrate') ? '' : ';maxaveragebitrate=192000'}`);
}

async function earKeepAwake() { try { ear.lock = await navigator.wakeLock.request('screen'); } catch {} }

async function earStart() {
  const audio = $('earAudio');
  // o iPhone só deixa tocar som depois de um toque: "destrava" o <audio> agora, dentro do toque
  audio.srcObject = new MediaStream();
  audio.play().catch(() => {});
  earStatus('Conectando ao PC…', 'wait');
  send({ t: 'ear', action: 'start' });
  const pc = new RTCPeerConnection({ iceServers: [] });
  ear.pc = pc;
  ear.tr = pc.addTransceiver('audio', { direction: 'sendrecv' });
  pc.ontrack = (e) => {
    audio.srcObject = new MediaStream([e.track]);
    audio.play().catch(() => earStatus('Toque em "Ouvir" de novo para liberar o som', 'err'));
  };
  pc.onicecandidate = (e) => { if (e.candidate && ear.pc === pc) send({ t: 'rtc', type: 'ice', candidate: e.candidate.toJSON() }); };
  pc.onconnectionstatechange = () => {
    if (ear.pc !== pc) return;
    const s = pc.connectionState;
    if (s === 'connected') earStatus(ear.mic ? 'Tocando · microfone ligado' : 'Tocando o som do PC', 'on');
    else if (s === 'failed') { earStop(); earStatus('Não consegui conectar ao PC (mesma rede ou Tailscale?)', 'err'); }
    else if (s === 'disconnected') earStatus('Conexão instável…', 'wait');
  };
  const offer = await pc.createOffer();
  await pc.setLocalDescription({ type: 'offer', sdp: earStereo(offer.sdp) });
  send({ t: 'rtc', type: 'offer', sdp: pc.localDescription.sdp });
  earKeepAwake();
  earButtons();
}

function earStop(tellPc = true) {
  if (tellPc) send({ t: 'ear', action: 'stop' });
  if (ear.mic) { ear.mic.stop(); ear.mic = null; }
  if (ear.pc) ear.pc.close();
  ear.pc = null;
  ear.tr = null;
  $('earAudio').srcObject = null;
  ear.lock?.release?.().catch(() => {});
  ear.lock = null;
  earStatus('Desligado');
  earButtons();
}

function earSignal(m) {
  ear.chain = ear.chain.then(async () => {
    if (!ear.pc) return;
    if (m.type === 'answer') await ear.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
    else if (m.type === 'ice' && m.candidate) await ear.pc.addIceCandidate(m.candidate).catch(() => {});
  }).catch((e) => { earStop(); earStatus(`Falhou: ${e.message}`, 'err'); });
}

async function earMic(on) {
  if (!ear.tr) return;
  try {
    if (on) {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      ear.mic = s.getAudioTracks()[0];
      await ear.tr.sender.replaceTrack(ear.mic);
      send({ t: 'ear', action: 'mic', on: true });
      earStatus('Tocando · microfone ligado (diga "Hey Jarvis")', 'on');
    } else {
      await ear.tr.sender.replaceTrack(null);
      ear.mic?.stop(); // solta o microfone: o iPhone volta o fone para o modo música
      ear.mic = null;
      send({ t: 'ear', action: 'mic', on: false });
      earStatus('Tocando o som do PC', 'on');
    }
  } catch (e) {
    ear.mic = null;
    earStatus(`Microfone: ${e.message}`, 'err');
  }
  earButtons();
}

$('earBtn').addEventListener('click', () => { $('ear').hidden = false; });
$('earClose').addEventListener('click', () => { $('ear').hidden = true; });
$('ear').addEventListener('click', (e) => { if (e.target.id === 'ear') $('ear').hidden = true; });
$('earGo').addEventListener('click', () => {
  if (ear.pc) earStop();
  else earStart().catch((e) => { earStop(); earStatus(`Falhou: ${e.message}`, 'err'); });
});
$('earMic').addEventListener('click', () => earMic(!ear.mic));
// voltou para a página: a tela precisa continuar acesa
document.addEventListener('visibilitychange', () => { if (ear.pc && document.visibilityState === 'visible') earKeepAwake(); });

connect();
