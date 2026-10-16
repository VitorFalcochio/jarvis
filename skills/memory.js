// Memória de longo prazo: fatos e preferências do usuário que o JARVIS lembra entre conversas.
// Ficam em data/memory.json e entram no prompt de sistema.
const path = require('path');

let facts = [];
let ctxRef;
const file = () => path.join(ctxRef.dataDir, 'memory.json');
const save = () => { ctxRef.writeJson(file(), facts); ctxRef.send('memory', facts); };
const normalize = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

const api = {
  list: () => facts,
  add(text, source = 'manual') {
    const t = text.trim();
    if (!t) return null;
    // Não duplica o mesmo fato
    if (facts.some((f) => normalize(f.text) === normalize(t))) return null;
    const f = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), text: t, source, at: Date.now() };
    facts.push(f);
    save();
    return f;
  },
  remove(id) {
    facts = facts.filter((f) => f.id !== id);
    save();
  },
  // Texto que vai para o prompt de sistema
  promptBlock() {
    if (!facts.length) return '';
    return `\nO que você sabe sobre o usuário (memória de longo prazo):\n${facts.slice(-40).map((f) => `- ${f.text}`).join('\n')}\n`;
  },
};

module.exports = {
  name: 'memory',
  api,
  init(ctx) {
    ctxRef = ctx;
    facts = ctx.readJson(file(), []);
    ctx.memory = api;
  },
  tools: [
    {
      name: 'memory_remember',
      description: 'Guarda um fato duradouro sobre o usuário para lembrar em conversas futuras: preferências, gostos, rotina, pessoas, datas, projetos, tecnologias que usa. Use quando ele contar algo pessoal relevante ou pedir "lembra que...". Escreva o fato em 3ª pessoa, curto (ex: "Prefere TypeScript a JavaScript").',
      parameters: { type: 'object', properties: { fact: { type: 'string' } }, required: ['fact'] },
      async run({ fact }) {
        const f = api.add(fact, 'conversa');
        return f ? { ok: true, remembered: f.text } : { ok: true, already_known: true };
      },
    },
    {
      name: 'memory_forget',
      description: 'Esquece um fato da memória de longo prazo ("esquece que...").',
      parameters: { type: 'object', properties: { fact: { type: 'string', description: 'O fato ou parte dele' } }, required: ['fact'] },
      async run({ fact }) {
        const words = normalize(fact).split(' ').filter((w) => w.length > 2);
        let best = null, bestScore = 0;
        for (const f of facts) {
          const n = normalize(f.text);
          const score = words.filter((w) => n.includes(w)).length;
          if (score > bestScore) { best = f; bestScore = score; }
        }
        if (!best) return { ok: false, error: 'Não encontrei esse fato na memória' };
        api.remove(best.id);
        return { ok: true, forgot: best.text };
      },
    },
  ],
};
