// Dossiês: o usuário "ensina" o JARVIS sobre um assunto (a empresa, um projeto, um cliente...) escrevendo
// ou importando PDF/Word/planilha. Quando o assunto aparece na conversa, o dossiê entra no prompt
// e continua lá por alguns turnos ("e o plano de preços dela?").
// Ficam em data/knowledge/: index.json (título, apelidos, projeto) + <id>.md (o texto).
const fs = require('fs');
const path = require('path');

const FULL_LIMIT = 16000;   // dossiê até este tamanho entra inteiro
const TOTAL_LIMIT = 28000;  // soma de todos os dossiês num turno
const STICKY_TURNS = 4;     // turnos em que o dossiê continua no contexto depois de citado
const CHUNK = 1800;

let ctxRef;
let index = [];
const sticky = new Map(); // id -> turnId até quando fica no contexto
let cache = { turn: -1, block: '' };

const dir = () => path.join(ctxRef.dataDir, 'knowledge');
const indexFile = () => path.join(dir(), 'index.json');
const textFile = (id) => path.join(dir(), `${id}.md`);
const normalize = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const slug = (s) => normalize(s).replace(/ /g, '-').slice(0, 40) || 'dossie';

function saveIndex() {
  fs.mkdirSync(dir(), { recursive: true });
  ctxRef.writeJson(indexFile(), index);
  cache.turn = -1;
  ctxRef.send('knowledge', null);
}

const readText = (id) => { try { return fs.readFileSync(textFile(id), 'utf8'); } catch { return ''; } };

// Nomes pelos quais o assunto pode ser citado (título, apelidos e o projeto ligado)
function namesOf(d) {
  return [d.title, ...(d.aliases || []), d.project].filter(Boolean).map(normalize).filter((n) => n.length >= 3);
}

function find(topic) {
  const t = normalize(topic);
  if (!t) return null;
  let best = null, bestScore = 0;
  for (const d of index) {
    for (const n of namesOf(d)) {
      const score = n === t ? 100 : (` ${t} `.includes(` ${n} `) || ` ${n} `.includes(` ${t} `)) ? 60 : 0;
      if (score > bestScore) { best = d; bestScore = score; }
    }
  }
  return best;
}

// Dossiês citados no texto (palavra inteira: "campex" casa, "campexito" não)
function mentioned(text) {
  const t = ` ${normalize(text)} `;
  return index.filter((d) => namesOf(d).some((n) => t.includes(` ${n} `)));
}

// Dossiê grande: o começo (normalmente o resumo) + os trechos com mais palavras da pergunta
function excerpt(text, query, limit) {
  if (text.length <= limit) return text;
  const chunks = [];
  for (let i = 0; i < text.length; i += CHUNK) chunks.push({ i, t: text.slice(i, i + CHUNK) });
  const words = normalize(query).split(' ').filter((w) => w.length >= 3);
  const scored = chunks.slice(1).map((c) => ({ ...c, s: words.reduce((a, w) => a + (normalize(c.t).split(w).length - 1), 0) }));
  const pick = [chunks[0]];
  let size = chunks[0].t.length;
  for (const c of scored.sort((a, b) => b.s - a.s || a.i - b.i)) {
    if (size + c.t.length > limit) break;
    pick.push(c);
    size += c.t.length;
  }
  return pick.sort((a, b) => a.i - b.i).map((c) => c.t).join('\n[...]\n')
    + `\n\n(Trecho de um dossiê de ${Math.round(text.length / 1000)} mil caracteres. Para outra parte, use knowledge_read com query.)`;
}

const api = {
  list: () => index.map((d) => ({ ...d, chars: readText(d.id).length })),
  get(id) {
    const d = index.find((x) => x.id === id);
    return d ? { ...d, text: readText(id) } : null;
  },
  save({ id, title, aliases, project, text }) {
    title = String(title || '').trim();
    if (!title) throw new Error('Dê um nome ao dossiê');
    let d = id && index.find((x) => x.id === id);
    if (!d) {
      let nid = slug(title);
      while (index.some((x) => x.id === nid)) nid += '-2';
      d = { id: nid, createdAt: Date.now() };
      index.push(d);
    }
    Object.assign(d, {
      title,
      aliases: (Array.isArray(aliases) ? aliases : String(aliases || '').split(',')).map((a) => a.trim()).filter(Boolean),
      project: project || null,
      updatedAt: Date.now(),
    });
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(textFile(d.id), String(text || ''), 'utf8');
    saveIndex();
    return { ...d, chars: String(text || '').length };
  },
  append(id, text) {
    const d = index.find((x) => x.id === id);
    if (!d) throw new Error('Dossiê não encontrado');
    const cur = readText(id);
    fs.writeFileSync(textFile(id), `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}\n${text.trim()}\n`, 'utf8');
    d.updatedAt = Date.now();
    saveIndex();
  },
  remove(id) {
    index = index.filter((x) => x.id !== id);
    try { fs.unlinkSync(textFile(id)); } catch {}
    saveIndex();
  },
  find,

  // Bloco do prompt de sistema para o turno atual (calculado uma vez por turno)
  promptBlock(userText, turnId) {
    if (!index.length) return '';
    if (cache.turn === turnId) return cache.block;
    for (const d of mentioned(userText || '')) sticky.set(d.id, turnId + STICKY_TURNS);
    // falar do projeto atual ("vamos continuar o projeto") também puxa o dossiê ligado a ele
    const cur = ctxRef.config.currentProject && path.basename(ctxRef.config.currentProject);
    if (cur && /\b(projeto|continuar|continua|retomar|retoma|onde (eu )?parei)\b/i.test(userText || '')) {
      for (const d of index.filter((x) => x.project && normalize(x.project) === normalize(cur))) sticky.set(d.id, turnId + STICKY_TURNS);
    }
    const active = index.filter((d) => (sticky.get(d.id) || -1) >= turnId);
    let budget = TOTAL_LIMIT;
    const parts = [];
    for (const d of active) {
      const text = readText(d.id).trim();
      if (!text || budget < 1500) continue;
      const body = excerpt(text, userText, Math.min(FULL_LIMIT, budget));
      budget -= body.length;
      parts.push(`### Dossiê: ${d.title}${d.aliases?.length ? ` (também chamado: ${d.aliases.join(', ')})` : ''}\n${body}`);
    }
    const others = index.filter((d) => !active.includes(d)).map((d) => d.title);
    let block = '';
    if (parts.length) {
      block += `\nCONHECIMENTO que o usuário te ensinou (use como fonte principal sobre esses assuntos, com naturalidade, sem dizer "segundo o dossiê"; se algo não estiver aqui, diga que não sabe ou pergunte):\n${parts.join('\n\n')}\n`;
    }
    if (others.length) block += `\nOutros dossiês disponíveis (leia com knowledge_read quando o assunto surgir): ${others.join(', ')}.\n`;
    cache = { turn: turnId, block };
    return block;
  },
};

module.exports = {
  name: 'knowledge',
  api,
  init(ctx) {
    ctxRef = ctx;
    index = ctx.readJson(indexFile(), []);
    ctx.knowledge = api;
  },
  tools: [
    {
      name: 'knowledge_read',
      description: 'Lê um dossiê que o usuário te ensinou (empresa, projeto, cliente, assunto). Use quando o assunto surgir e o dossiê não estiver no contexto, ou para buscar uma parte específica de um dossiê grande (query).',
      parameters: { type: 'object', properties: { topic: { type: 'string' }, query: { type: 'string', description: 'O que procurar dentro dele (opcional)' } }, required: ['topic'] },
      async run({ topic, query }, ctx) {
        const d = find(topic);
        if (!d) return { ok: false, error: `Não tenho dossiê sobre "${topic}". Dossiês: ${index.map((x) => x.title).join(', ') || 'nenhum'}` };
        sticky.set(d.id, ctx.turnId + STICKY_TURNS);
        return { ok: true, title: d.title, content: excerpt(readText(d.id), query || ctx.lastUserText || '', FULL_LIMIT) };
      },
    },
    {
      name: 'knowledge_teach',
      description: 'Ensina algo novo sobre um assunto, acrescentando ao dossiê dele (cria o dossiê se não existir): "aprende isso sobre a CAMPEX: ...", "anota no dossiê do cliente X que...", "guarda isso como contexto da empresa". Escreva o conteúdo completo e organizado (pode usar markdown).',
      parameters: {
        type: 'object',
        properties: { topic: { type: 'string', description: 'Nome do assunto (ex: CAMPEX)' }, text: { type: 'string' } },
        required: ['topic', 'text'],
      },
      async run({ topic, text }, ctx) {
        const d = find(topic);
        if (d) { api.append(d.id, text); sticky.set(d.id, ctx.turnId + STICKY_TURNS); return { ok: true, added_to: d.title }; }
        const created = api.save({ title: topic, text });
        sticky.set(created.id, ctx.turnId + STICKY_TURNS);
        return { ok: true, created: created.title, tip: 'Dossiê novo. O usuário pode completar na tela Memória → Dossiês (dá para importar PDF).' };
      },
    },
  ],
};
