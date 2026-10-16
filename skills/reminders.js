// Lembretes com hora marcada; sobrevivem a reinícios (data/reminders.json).
const { Notification } = require('electron');
const path = require('path');

let reminders = [];
let file;
const timers = new Map();
let ctxRef;

function save() {
  ctxRef.writeJson(file, reminders);
  ctxRef.send('reminders', reminders);
}

function schedule(r) {
  const delay = Math.max(0, r.at - Date.now());
  timers.set(r.id, setTimeout(() => fire(r), Math.min(delay, 2 ** 31 - 1)));
}

function fire(r) {
  reminders = reminders.filter((x) => x.id !== r.id);
  timers.delete(r.id);
  save();
  new Notification({ title: 'J.A.R.V.I.S.', body: r.text }).show();
  ctxRef.toast(`Lembrete: ${r.text}`);
  ctxRef.announce(`${ctxRef.config.userName}, lembrete: ${r.text}.`);
  if (ctxRef.notifyRemote && ctxRef.config.telegramAlerts !== false) ctxRef.notifyRemote(`Lembrete: ${r.text}`, { phone: false }); // o celular já recebe pelo announce
}

const fmt = (ts) => new Date(ts).toLocaleString('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });

module.exports = {
  name: 'reminders',
  init(ctx) {
    ctxRef = ctx;
    file = path.join(ctx.dataDir, 'reminders.json');
    reminders = ctx.readJson(file, []);
    reminders.forEach(schedule);
  },
  getAll: () => reminders,
  tools: [
    {
      name: 'reminder_create',
      description: 'Cria um lembrete/timer. Informe "minutes" (daqui a N minutos) OU "at" (data/hora ISO local, ex: 2026-10-03T15:00).',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Do que lembrar' },
          minutes: { type: 'number' },
          at: { type: 'string', description: 'Data/hora local ISO 8601' },
        },
        required: ['text'],
      },
      async run({ text, minutes, at }) {
        let when = typeof minutes === 'number' ? Date.now() + minutes * 60000 : Date.parse(at);
        if (!isFinite(when)) return { ok: false, error: 'Informe minutes ou at' };
        if (when < Date.now()) return { ok: false, error: 'Horário já passou' };
        const r = { id: String(Date.now()), at: when, text };
        reminders.push(r);
        schedule(r);
        save();
        return { ok: true, when: fmt(when) };
      },
    },
    {
      name: 'reminder_list',
      description: 'Lista os lembretes pendentes.',
      parameters: { type: 'object', properties: {} },
      async run() {
        return { reminders: reminders.slice().sort((a, b) => a.at - b.at).map((r) => ({ id: r.id, text: r.text, when: fmt(r.at) })) };
      },
    },
    {
      name: 'reminder_cancel',
      description: 'Cancela um lembrete pelo id (use reminder_list antes para descobrir o id).',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      async run({ id }) {
        const r = reminders.find((x) => x.id === id);
        if (!r) return { ok: false, error: 'Lembrete não encontrado' };
        clearTimeout(timers.get(id));
        timers.delete(id);
        reminders = reminders.filter((x) => x.id !== id);
        save();
        return { ok: true, cancelled: r.text };
      },
    },
  ],
};
