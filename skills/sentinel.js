// Modo sentinela: vigia o ambiente pela câmera do celular enquanto o usuário está fora.
// 1) detecção de movimento local, comparando miniaturas cinza dos quadros (leve, sem modelo)
// 2) havendo movimento, a IA de visão confirma se é uma pessoa (evita alarme com luz, cortina, pet)
// 3) pessoa confirmada → foto + alerta no celular, no Telegram e no HUD; aviso falado no PC
const { nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const W = 64, H = 48;
const PIXEL_DIFF = 28;         // diferença de brilho (0-255) para um pixel contar como mudado
const MOTION_RATIO = 0.035;    // fração de pixels mudados para considerar movimento
const PERSON_COOLDOWN = 60000; // depois de um alerta, espera 1 min antes do próximo
const FALSE_COOLDOWN = 8000;   // movimento sem pessoa: espera um pouco antes de checar de novo

let ctxRef;
let s = null; // estado da vigília

function grayThumb(jpeg) {
  const bmp = nativeImage.createFromBuffer(jpeg).resize({ width: W, height: H }).toBitmap(); // BGRA
  const g = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) g[i] = 0.114 * bmp[i * 4] + 0.587 * bmp[i * 4 + 1] + 0.299 * bmp[i * 4 + 2];
  return g;
}

function publish() {
  const info = s ? { active: true, armed: Date.now() >= s.armedAt, armedAt: s.armedAt, events: s.events.length } : { active: false };
  ctxRef.send('sentinel', info);
  ctxRef.phonecam.send({ t: 'sentinel', active: !!s });
}

async function onFrame(jpeg) {
  if (!s || s.checking || Date.now() < s.armedAt) return;
  const now = Date.now();
  if (now - s.lastSample < 330) return; // ~3 amostras por segundo bastam
  s.lastSample = now;
  s.lastFrameAt = now;
  s.staleWarned = false;

  let g;
  try { g = grayThumb(jpeg); } catch { return; }
  if (!s.bg) { s.bg = g; return; }

  let changed = 0;
  for (let i = 0; i < g.length; i++) if (Math.abs(g[i] - s.bg[i]) > PIXEL_DIFF) changed++;
  // fundo se adapta devagar (mudanças lentas de luz não disparam)
  for (let i = 0; i < g.length; i++) s.bg[i] = s.bg[i] * 0.92 + g[i] * 0.08;
  const ratio = changed / g.length;
  s.streak = ratio > MOTION_RATIO ? s.streak + 1 : 0;
  if (s.streak < 2 || now < s.cooldownUntil) return;

  // Movimento confirmado em 2 amostras seguidas: a IA de visão decide se é gente
  s.checking = true;
  s.streak = 0;
  try {
    const answer = await ctxRef.vision(
      'Esta imagem é de uma câmera de segurança doméstica. Há alguma PESSOA (ou parte de uma pessoa: braço, rosto, corpo) visível? ' +
      'Responda SOMENTE com JSON: {"pessoa": true ou false, "descricao": "descrição curta do que aparece"}',
      jpeg.toString('base64'));
    const json = JSON.parse(answer.slice(answer.indexOf('{'), answer.lastIndexOf('}') + 1));
    if (json.pessoa === true) await alarm(jpeg, json.descricao || 'pessoa detectada');
    else s.cooldownUntil = Date.now() + FALSE_COOLDOWN;
  } catch (e) {
    console.error('[sentinela]', e.message);
    s.cooldownUntil = Date.now() + FALSE_COOLDOWN;
  } finally {
    if (s) s.checking = false;
  }
}

async function alarm(jpeg, description) {
  const when = new Date();
  const dir = path.join(ctxRef.dataDir, 'sentinel');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `alerta-${when.toISOString().replace(/[:.]/g, '-')}.jpg`);
  fs.writeFileSync(file, jpeg);
  s.events.push({ at: when.getTime(), description, file });
  s.cooldownUntil = Date.now() + PERSON_COOLDOWN;

  const hour = when.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const text = `Sentinela: pessoa detectada às ${hour}. ${description}`;
  ctxRef.notifyRemote(text, { image: jpeg });
  ctxRef.toast(text, 'error');
  publish();
  // Aviso falado no PC: espanta quem estiver no quarto
  if (s.speak) ctxRef.announce(`Atenção. Você está sendo filmado. ${ctxRef.config.userName} já foi notificado.`, { phone: false });
}

// Câmera parou de mandar imagem durante a vigília (bateria, celular derrubado, alguém mexeu)
function watchdog() {
  if (!s || Date.now() < s.armedAt || s.staleWarned) return;
  if (Date.now() - (s.lastFrameAt || s.armedAt) > 20000) {
    s.staleWarned = true;
    ctxRef.notifyRemote('Sentinela: a câmera do celular parou de enviar imagens.');
  }
}

module.exports = {
  name: 'sentinel',
  init(ctx) {
    ctxRef = ctx;
    ctx.phonecam.on('frame', (jpeg) => onFrame(jpeg).catch(() => {}));
    ctx.phonecam.on('disconnected', () => { if (s && Date.now() >= s.armedAt) ctx.notifyRemote('Sentinela: a câmera do celular desconectou!'); });
    ctx.sentinelActive = () => !!s;
    setInterval(watchdog, 5000);
  },
  tools: [
    {
      name: 'sentinel_start',
      description: 'Liga o modo sentinela: vigia o ambiente pela câmera do celular e avisa (celular, Telegram e voz) se aparecer alguém. Use quando o usuário for sair ("vou sair, vigia o quarto").',
      parameters: {
        type: 'object',
        properties: {
          delay_seconds: { type: 'number', description: 'Segundos até armar, para o usuário sair do quadro (padrão 20)' },
          speak_warning: { type: 'boolean', description: 'Falar um aviso no PC quando detectar alguém (padrão true)' },
        },
      },
      async run({ delay_seconds = 20, speak_warning = true }, ctx) {
        const cam = ctx.phonecam;
        if (!cam.connected) return { ok: false, error: 'A câmera do celular não está conectada. Abra o JARVIS no celular e ligue a câmera.' };
        if (!cam.latest || Date.now() - cam.latestAt > 5000) return { ok: false, error: 'O celular está conectado mas a câmera não está ligada (toque em "Ligar câmera" no app).' };
        const delay = Math.max(5, Math.min(300, delay_seconds));
        s = { armedAt: Date.now() + delay * 1000, bg: null, streak: 0, lastSample: 0, cooldownUntil: 0, checking: false, events: [], speak: speak_warning, startedAt: Date.now() };
        publish();
        setTimeout(publish, delay * 1000 + 50);
        return {
          ok: true, arms_in_seconds: delay, telegram: !!ctx.config.telegramChatId,
          how_to_answer: `Confirme em 1 frase que o sentinela arma em ${delay} segundos${ctx.config.telegramChatId ? ' e que os alertas vão para o celular e o Telegram' : ' e que os alertas vão para o celular (o Telegram não está configurado)'}.`,
        };
      },
    },
    {
      name: 'sentinel_stop',
      description: 'Desliga o modo sentinela e diz o que aconteceu enquanto o usuário estava fora.',
      parameters: { type: 'object', properties: {} },
      async run() {
        if (!s) return { ok: false, error: 'O modo sentinela não está ativo' };
        const events = s.events.map((e) => ({ hora: new Date(e.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }), o_que: e.description }));
        const min = Math.floor((Date.now() - s.startedAt) / 60000);
        const watched = min < 1 ? 'menos de um minuto' : min < 60 ? `${min} minuto${min > 1 ? 's' : ''}` : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`;
        s = null;
        publish();
        return { ok: true, watched_for: watched, detections: events.length ? events : 'nenhuma pessoa detectada' };
      },
    },
  ],
};
