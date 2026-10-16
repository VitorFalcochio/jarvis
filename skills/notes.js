// Notas rápidas e lista de tarefas (data/notes.json e data/tasks.json).
const path = require('path');

let notes = [];
let tasks = [];
let ctxRef;
const file = (name) => path.join(ctxRef.dataDir, name);

const normalize = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const fmtDate = (ts) => new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

function saveTasks() {
  ctxRef.writeJson(file('tasks.json'), tasks);
  ctxRef.send('tasks', tasks.filter((t) => !t.done));
}

// Acha uma tarefa pelo id ou pelo texto mais parecido
function findTask(ref, { pendingOnly = true } = {}) {
  const pool = pendingOnly ? tasks.filter((t) => !t.done) : tasks;
  const byId = pool.find((t) => t.id === ref);
  if (byId) return byId;
  const words = normalize(ref).split(' ').filter((w) => w.length > 2);
  let best = null, bestScore = 0;
  for (const t of pool) {
    const n = normalize(t.text);
    const score = words.filter((w) => n.includes(w)).length;
    if (score > bestScore) { best = t; bestScore = score; }
  }
  return best;
}

// Status do kanban: todo → doing → done (o campo done continua existindo para as outras partes)
function setStatus(t, status) {
  t.status = status;
  t.done = status === 'done';
  t.doneAt = t.done ? (t.doneAt || Date.now()) : undefined;
}

// Operações usadas direto pela tela de Agenda (cliques do usuário, sem passar pelo modelo)
const api = {
  list: () => ({
    tasks: tasks.filter((t) => !t.done || Date.now() - (t.doneAt || 0) < 7 * 86400000), // concluídas somem depois de 7 dias
    notes: notes.slice().reverse(),
  }),
  addTask(text, due) {
    const t = { id: newId(), text, due: due || null, project: null, done: false, status: 'todo', at: Date.now() };
    tasks.push(t);
    saveTasks();
    return t;
  },
  updateTask(id, changes) {
    const t = tasks.find((x) => x.id === id);
    if (!t) return null;
    if (changes.status) setStatus(t, changes.status);
    if (typeof changes.text === 'string' && changes.text.trim()) t.text = changes.text.trim();
    if ('due' in changes) t.due = changes.due || null;
    saveTasks();
    return t;
  },
  deleteTask(id) {
    tasks = tasks.filter((x) => x.id !== id);
    saveTasks();
  },
  addNote(text) {
    const n = { id: newId(), text, project: null, at: Date.now() };
    notes.push(n);
    ctxRef.writeJson(file('notes.json'), notes);
    return n;
  },
  deleteNote(id) {
    notes = notes.filter((x) => x.id !== id);
    ctxRef.writeJson(file('notes.json'), notes);
  },
};

module.exports = {
  name: 'notes',
  api,
  init(ctx) {
    ctxRef = ctx;
    notes = ctx.readJson(file('notes.json'), []);
    tasks = ctx.readJson(file('tasks.json'), []);
    tasks.forEach((t) => { if (!t.status) t.status = t.done ? 'done' : 'todo'; });
    ctx.getTasks = () => tasks;
  },
  tools: [
    {
      name: 'note_add',
      description: 'Anota uma ideia/informação para consultar depois ("anota que...", "guarda isso").',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' }, project: { type: 'string', description: 'Projeto relacionado, se houver' } },
        required: ['text'],
      },
      async run({ text, project }, ctx) {
        notes.push({ id: newId(), text, project: project || null, at: Date.now() });
        ctx.writeJson(file('notes.json'), notes);
        return { ok: true, total_notes: notes.length };
      },
    },
    {
      name: 'note_search',
      description: 'Procura nas notas do usuário ("o que eu anotei sobre X?"). Sem query, devolve as mais recentes.',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
      async run({ query }) {
        let found = notes;
        if (query) {
          const words = normalize(query).split(' ').filter((w) => w.length > 2);
          found = notes
            .map((n) => ({ n, score: words.filter((w) => normalize(`${n.text} ${n.project || ''}`).includes(w)).length }))
            .filter((x) => x.score > 0)
            .sort((a, b) => b.score - a.score || b.n.at - a.n.at)
            .map((x) => x.n);
        }
        return { notes: found.slice(-10).reverse().map((n) => ({ text: n.text, project: n.project, date: fmtDate(n.at) })) };
      },
    },
    {
      name: 'task_add',
      description: 'Adiciona uma tarefa à lista de afazeres.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          due: { type: 'string', description: 'Prazo opcional em data ISO local (ex: 2026-10-03)' },
          project: { type: 'string' },
        },
        required: ['text'],
      },
      async run({ text, due, project }) {
        const t = { id: newId(), text, due: due || null, project: project || null, done: false, status: 'todo', at: Date.now() };
        tasks.push(t);
        saveTasks();
        return { ok: true, pending: tasks.filter((x) => !x.done).length };
      },
    },
    {
      name: 'task_list',
      description: 'Lista as tarefas pendentes (ou concluídas).',
      parameters: { type: 'object', properties: { status: { type: 'string', enum: ['pending', 'done'] } } },
      async run({ status = 'pending' }) {
        const list = tasks.filter((t) => (status === 'done' ? t.done : !t.done));
        return { tasks: list.slice(-15).map((t) => ({ id: t.id, text: t.text, due: t.due, project: t.project })) };
      },
    },
    {
      name: 'task_done',
      description: 'Marca uma tarefa como concluída (pelo id ou pelo texto).',
      parameters: { type: 'object', properties: { task: { type: 'string', description: 'id ou parte do texto' } }, required: ['task'] },
      async run({ task }) {
        const t = findTask(task);
        if (!t) return { ok: false, error: 'Tarefa não encontrada' };
        setStatus(t, 'done');
        saveTasks();
        return { ok: true, done: t.text, pending: tasks.filter((x) => !x.done).length };
      },
    },
    {
      name: 'task_start',
      description: 'Move uma tarefa para "fazendo" no kanban ("comecei a tarefa X", "tô fazendo X").',
      parameters: { type: 'object', properties: { task: { type: 'string', description: 'id ou parte do texto' } }, required: ['task'] },
      async run({ task }) {
        const t = findTask(task);
        if (!t) return { ok: false, error: 'Tarefa não encontrada' };
        setStatus(t, 'doing');
        saveTasks();
        return { ok: true, doing: t.text };
      },
    },
    {
      name: 'task_remove',
      description: 'Apaga uma tarefa da lista (pelo id ou pelo texto).',
      parameters: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
      async run({ task }) {
        const t = findTask(task, { pendingOnly: false });
        if (!t) return { ok: false, error: 'Tarefa não encontrada' };
        tasks = tasks.filter((x) => x !== t);
        saveTasks();
        return { ok: true, removed: t.text };
      },
    },
  ],
};
