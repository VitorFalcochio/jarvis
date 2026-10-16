// Presença na mesa: o celular, apoiado olhando para o usuário, roda o MediaPipe Pose e manda só números
// ({ present, posture }) — o vídeo não precisa sair do celular. Aqui ficam as decisões:
//  - saiu da mesa (25 s sem ninguém): pausa a música e o pomodoro
//  - voltou: "Bem-vindo de volta, você ficou 12 minutos fora" e retoma tudo
//  - postura ruim por mais de 1 minuto: avisa (no máximo a cada 15 min)
//  - muito tempo sentado sem pausa: sugere levantar (sair 5 min ou mais conta como pausa)
const LEAVE_AFTER = 25000;      // ausência contínua para considerar que levantou
const BACK_AFTER = 3000;        // presença contínua para considerar que voltou
const BREAK_COUNTS = 5 * 60000; // sair por isso ou mais conta como pausa
const POSTURE_AFTER = 60000;    // postura ruim contínua antes de avisar
const POSTURE_EVERY = 15 * 60000;
const NUDGE_EVERY = 20 * 60000;
const STALE = 15000;            // sem notícias do celular: estado desconhecido (não conta como saída)

const DEFAULTS = { breakMinutes: 50, posture: true, autoPause: true };
const POSTURE_LINES = [
  'Postura, {name}. Costas retas e ombros para trás.',
  '{name}, você está curvado de novo. Endireita a coluna.',
  'Olha a postura, {name}. Cabeça alinhada com os ombros.',
];

let ctxRef;
let s = null;
const fresh = () => ({
  active: false, present: null, lastMsg: 0, absentSince: null, presentSince: null,
  leftAt: null, sittingSince: null, lastNudge: 0, lastPosture: 0, badSince: null,
  pausedMusic: false, pausedFocus: false, postureLine: 0, stats: { postureAlerts: 0, breaks: 0 },
});
const cfg = () => ({ ...DEFAULTS, ...(ctxRef.config.presence || {}) });
const name = () => ctxRef.config.userName;

function fmt(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'menos de um minuto';
  if (m < 60) return m === 1 ? '1 minuto' : `${m} minutos`;
  const h = Math.floor(m / 60), r = m % 60;
  return `${h === 1 ? '1 hora' : `${h} horas`}${r ? ` e ${r} minuto${r > 1 ? 's' : ''}` : ''}`;
}

function publish() {
  ctxRef.send('presence', s.active ? {
    active: true, present: s.present, sittingSince: s.sittingSince, leftAt: s.present === false ? s.leftAt : null,
    posture: postureBad() ? 'bad' : 'ok',
  } : { active: false });
}

async function musicPlaying() {
  try { const song = await ctxRef.ytm.nowPlaying({ reauth: false }); return !!song && !song.paused; } catch { return false; }
}

async function left() {
  s.present = false;
  s.leftAt = s.absentSince;
  s.badSince = null;
  if (cfg().autoPause) {
    if (await musicPlaying()) { await ctxRef.runTool('music_control', { action: 'pause' }).catch(() => {}); s.pausedMusic = true; }
    if (ctxRef.focusApi()?.pause()) s.pausedFocus = true;
  }
  ctxRef.toast(`Você saiu da mesa${s.pausedMusic || s.pausedFocus ? ': pausei a música e o foco' : ''}.`);
  publish();
}

async function back() {
  const away = Date.now() - (s.leftAt || Date.now());
  s.present = true;
  const resumed = [];
  if (s.pausedMusic) { await ctxRef.runTool('music_control', { action: 'resume' }).catch(() => {}); resumed.push('a música'); }
  if (s.pausedFocus && ctxRef.focusApi()?.resume()) resumed.push('o foco');
  s.pausedMusic = s.pausedFocus = false;
  if (away >= BREAK_COUNTS) { s.sittingSince = Date.now(); s.stats.breaks++; }
  // saídas rápidas voltam em silêncio
  if (away >= 60000) {
    ctxRef.announce(`Bem-vindo de volta, ${name()}. Você ficou ${fmt(away)} fora.${resumed.length ? ` Retomando ${resumed.join(' e ')}.` : ''}`, { phone: false });
  }
  publish();
}

// Mensagem do celular: { present, posture: 'ok' | 'bad' | null }
async function update(m) {
  // desligado pelo botão no celular: devolve o que tinha pausado
  if (m.off) {
    if (s.pausedMusic || s.pausedFocus) await back();
    s = fresh();
    publish();
    return;
  }
  const now = Date.now();
  s.lastMsg = now;
  if (!s.active) { s.active = true; publish(); }
  if (m.present) {
    s.absentSince = null;
    s.presentSince ??= now;
    if (s.present === null) { s.present = true; s.sittingSince = now; publish(); }
    else if (s.present === false && now - s.presentSince >= BACK_AFTER) await back();
  } else {
    s.presentSince = null;
    s.absentSince ??= now;
    if (s.present !== false && now - s.absentSince >= LEAVE_AFTER) await left();
  }
  // postura: só conta com a pessoa presente
  if (m.present && cfg().posture && m.posture === 'bad') {
    s.badSince ??= now;
    if (now - s.badSince >= POSTURE_AFTER && now - s.lastPosture >= POSTURE_EVERY) {
      s.lastPosture = now;
      s.stats.postureAlerts++;
      ctxRef.announce(POSTURE_LINES[s.postureLine++ % POSTURE_LINES.length].replace('{name}', name()), { phone: false });
    }
  } else if (m.posture === 'ok' || !m.present) s.badSince = null;
  // o HUD só fica sabendo quando o estado mostrado muda
  if (postureBad() !== !!s.postureShown) { s.postureShown = postureBad(); publish(); }
}

// "curvado" só depois de 1 minuto seguido (evita piscar no HUD a cada mexida)
const postureBad = () => !!s.badSince && Date.now() - s.badSince >= POSTURE_AFTER;

// Tempo sentado sem pausa (o pomodoro já cuida das pausas quando está ativo)
function checkSitting() {
  if (!s.active) return;
  if (Date.now() - s.lastMsg > STALE) { s.active = false; s.present = null; publish(); return; }
  if (!s.present || !s.sittingSince) return;
  const focus = ctxRef.focusApi()?.current();
  if (focus && !focus.paused) return;
  const sat = Date.now() - s.sittingSince;
  if (sat >= cfg().breakMinutes * 60000 && Date.now() - s.lastNudge >= NUDGE_EVERY) {
    s.lastNudge = Date.now();
    ctxRef.announce(`${name()}, você está há ${fmt(sat)} direto na cadeira. Que tal levantar, beber uma água e esticar as pernas?`, { phone: false });
  }
}

module.exports = {
  name: 'presence',
  api: { update, checkSitting, state: () => s },
  init(ctx) {
    ctxRef = ctx;
    s = fresh();
    setInterval(checkSitting, 30000);
  },
  tools: [
    {
      name: 'presence_start',
      description: 'Liga a detecção de presença na mesa pela câmera do celular (apoiado olhando para o usuário): pausa música e foco quando ele levanta, dá boas-vindas na volta, avisa da postura e de tempo demais sentado.',
      parameters: { type: 'object', properties: {} },
      async run(_, ctx) {
        if (!ctx.phonecam.connected) return { ok: false, error: 'O celular não está conectado. Abra o app do JARVIS no celular.' };
        ctx.phonecam.send({ t: 'presence-cmd', on: true });
        return { ok: true, how_to_answer: 'Diga em 1 frase para apoiar o celular olhando para ele, sentado direito nos primeiros segundos (é a calibração da postura), e deixar a tela ligada.' };
      },
    },
    {
      name: 'presence_stop',
      description: 'Desliga a detecção de presença na mesa.',
      parameters: { type: 'object', properties: {} },
      async run(_, ctx) {
        ctx.phonecam.send({ t: 'presence-cmd', on: false });
        if (s.pausedMusic || s.pausedFocus) await back();
        s = fresh();
        publish();
        return { ok: true };
      },
    },
    {
      name: 'presence_calibrate',
      description: 'Recalibra a postura ("calibra minha postura", "estou sentado direito agora").',
      parameters: { type: 'object', properties: {} },
      async run(_, ctx) {
        if (!ctx.phonecam.connected) return { ok: false, error: 'O celular não está conectado' };
        ctx.phonecam.send({ t: 'presence-cmd', calibrate: true });
        return { ok: true, how_to_answer: 'Diga para ficar sentado direito por uns 5 segundos.' };
      },
    },
    {
      name: 'presence_status',
      description: 'Há quanto tempo o usuário está sentado sem pausa, se está na mesa, quantos avisos de postura hoje.',
      parameters: { type: 'object', properties: {} },
      async run() {
        if (!s.active) return { active: false, note: 'A detecção de presença está desligada (presence_start liga)' };
        return {
          active: true, at_desk: s.present, sitting_for: s.present && s.sittingSince ? fmt(Date.now() - s.sittingSince) : null,
          away_for: s.present === false ? fmt(Date.now() - s.leftAt) : null, posture_now: postureBad() ? 'curvado' : 'ok',
          posture_alerts: s.stats.postureAlerts, breaks: s.stats.breaks, break_reminder_minutes: cfg().breakMinutes,
        };
      },
    },
    {
      name: 'presence_settings',
      description: 'Ajusta a presença na mesa: minutos sentado antes de sugerir pausa, avisos de postura e pausa automática de música/foco.',
      parameters: {
        type: 'object',
        properties: {
          break_minutes: { type: 'number', description: 'Minutos seguidos sentado antes de sugerir levantar' },
          posture: { type: 'boolean', description: 'Avisos de postura ligados/desligados' },
          auto_pause: { type: 'boolean', description: 'Pausar música e foco ao levantar' },
        },
      },
      async run({ break_minutes, posture, auto_pause }, ctx) {
        const p = { ...cfg() };
        if (break_minutes) p.breakMinutes = Math.max(10, Math.round(break_minutes));
        if (typeof posture === 'boolean') p.posture = posture;
        if (typeof auto_pause === 'boolean') p.autoPause = auto_pause;
        ctx.config.presence = p;
        ctx.saveConfig();
        return { ok: true, ...p };
      },
    },
  ],
};
