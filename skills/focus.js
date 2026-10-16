// Modo foco (Pomodoro): ciclos de foco e pausa com música, contador no HUD e avisos falados.
const { Notification } = require('electron');

let ctxRef;
let session = null; // { phase, endsAt, startedAt, cycle, cycles, focusMin, breakMin, task, timer }

function publish() {
  ctxRef.send('focus', session && {
    phase: session.phase, endsAt: session.endsAt, startedAt: session.startedAt,
    cycle: session.cycle, cycles: session.cycles, task: session.task,
  });
}

function notify(text) {
  new Notification({ title: 'J.A.R.V.I.S. · Modo foco', body: text }).show();
  ctxRef.announce(text);
}

function startPhase(phase) {
  const minutes = phase === 'focus' ? session.focusMin : session.breakMin;
  session.phase = phase;
  session.startedAt = Date.now();
  session.endsAt = Date.now() + minutes * 60000;
  clearTimeout(session.timer);
  session.timer = setTimeout(onPhaseEnd, minutes * 60000);
  publish();
}

// Minutos de foco por dia (data/focus-stats.json), para o gráfico da Agenda
function recordFocus(minutesDone) {
  if (minutesDone < 1) return;
  const file = require('path').join(ctxRef.dataDir, 'focus-stats.json');
  const stats = ctxRef.readJson(file, {});
  const d = new Date();
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  stats[key] = (stats[key] || 0) + Math.round(minutesDone);
  ctxRef.writeJson(file, stats);
}

function onPhaseEnd() {
  const name = ctxRef.config.userName;
  if (session.phase === 'focus') recordFocus(session.focusMin);
  if (session.phase === 'focus') {
    if (session.cycle >= session.cycles) {
      const total = session.cycles * session.focusMin;
      session = null;
      publish();
      notify(`Sessão concluída, ${name}. Foram ${minutes(total)} de foco. Excelente trabalho.`);
      return;
    }
    startPhase('break');
    notify(`Fim do ciclo ${session.cycle}, ${name}. Pausa de ${minutes(session.breakMin)}: levante, beba água e alongue.`);
  } else {
    session.cycle++;
    startPhase('focus');
    notify(`Fim da pausa. Ciclo ${session.cycle} de ${session.cycles}, foco total.`);
  }
}

const minutes = (n) => (n === 1 ? '1 minuto' : `${n} minutos`);
const remaining = () => Math.max(0, Math.round((session.endsAt - Date.now()) / 60000));

module.exports = {
  name: 'focus',
  init(ctx) { ctxRef = ctx; },
  api: {
    current: () => session && { phase: session.phase, endsAt: session.endsAt, startedAt: session.startedAt, cycle: session.cycle, cycles: session.cycles, task: session.task, paused: !!session.paused },
    // Pausa (ex: o usuário levantou da mesa). O anel do HUD fica congelado no tempo que faltava.
    pause() {
      if (!session || session.paused) return false;
      clearTimeout(session.timer);
      session.paused = { left: Math.max(0, session.endsAt - Date.now()), done: Date.now() - session.startedAt };
      session.freeze = setInterval(() => {
        session.endsAt = Date.now() + session.paused.left;
        session.startedAt = Date.now() - session.paused.done;
        publish();
      }, 1000);
      return true;
    },
    resume() {
      if (!session?.paused) return false;
      clearInterval(session.freeze);
      session.endsAt = Date.now() + session.paused.left;
      session.startedAt = Date.now() - session.paused.done;
      session.timer = setTimeout(onPhaseEnd, session.paused.left);
      session.paused = null;
      publish();
      return true;
    },
  },
  tools: [
    {
      name: 'focus_start',
      description: 'Inicia o modo foco (Pomodoro): ciclos de foco + pausa, com música de concentração. Padrão: 25 min de foco, 5 de pausa, 4 ciclos.',
      parameters: {
        type: 'object',
        properties: {
          minutes: { type: 'number', description: 'Minutos de foco por ciclo' },
          break_minutes: { type: 'number' },
          cycles: { type: 'number' },
          task: { type: 'string', description: 'No que o usuário vai focar, se ele disser' },
          music: { type: 'string', description: 'O que tocar ("lofi", nome de playlist do usuário...). "none" para sem música. Padrão: lofi para programar' },
        },
      },
      async run({ minutes = 25, break_minutes = 5, cycles = 4, task, music }, ctx) {
        if (session) { clearTimeout(session.timer); clearInterval(session.freeze); }
        session = {
          cycle: 1, cycles: Math.max(1, Math.round(cycles)),
          focusMin: Math.max(1, minutes), breakMin: Math.max(1, break_minutes), task: task || null,
        };
        startPhase('focus');
        let musicResult = null;
        if (music !== 'none') {
          musicResult = await ctx.runTool('music_play', { query: music || 'lofi para programar', kind: music ? 'any' : 'playlist' });
        }
        return {
          ok: true, focus_minutes: session.focusMin, break_minutes: session.breakMin, cycles: session.cycles,
          music: musicResult?.playing || (music === 'none' ? 'sem música' : musicResult?.error),
        };
      },
    },
    {
      name: 'focus_status',
      description: 'Quanto tempo falta no modo foco e em qual ciclo está.',
      parameters: { type: 'object', properties: {} },
      async run() {
        if (!session) return { active: false };
        return { active: true, phase: session.phase === 'focus' ? 'foco' : 'pausa', minutes_left: remaining(), cycle: session.cycle, cycles: session.cycles, task: session.task };
      },
    },
    {
      name: 'focus_stop',
      description: 'Encerra o modo foco.',
      parameters: { type: 'object', properties: {} },
      async run() {
        if (!session) return { ok: false, error: 'O modo foco não está ativo' };
        const done = session.cycle - (session.phase === 'focus' ? 1 : 0);
        // O ciclo interrompido também conta o tempo que já foi focado
        if (session.phase === 'focus') recordFocus((Date.now() - session.startedAt) / 60000);
        clearTimeout(session.timer);
        clearInterval(session.freeze);
        session = null;
        publish();
        return { ok: true, cycles_completed: done };
      },
    },
  ],
};
