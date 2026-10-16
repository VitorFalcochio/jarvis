// Fábrica de Hologramas (fase 1): abre modelos 3D desmontáveis em tela cheia e controla por voz.
// Modelos prontos ficam em holo-models/*.json (formato de peças do forge-engine.js); na fase 2 a IA vai gerar
// novos modelos no mesmo formato e salvá-los em data/holo-models.
const fs = require('fs');
const path = require('path');

const BUILTIN = path.join(__dirname, '..', 'holo-models');
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

function library(ctx) {
  const dirs = [BUILTIN, path.join(ctx.dataDir, 'holo-models')];
  const out = [];
  for (const dir of dirs) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { continue; }
    for (const f of files) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        out.push({ id: f.replace(/\.json$/, ''), nome: m.nome || f, file: path.join(dir, f) });
      } catch {}
    }
  }
  return out;
}

function findModel(ctx, query) {
  const q = norm(query);
  const list = library(ctx);
  return list.find((m) => norm(m.id) === q || norm(m.nome) === q)
    || list.find((m) => q.split(' ').filter((w) => w.length > 1).every((w) => norm(`${m.id} ${m.nome}`).includes(w)))
    || list.find((m) => norm(`${m.id} ${m.nome}`).split(' ').some((w) => w.length > 2 && q.includes(w)));
}

module.exports = {
  name: 'forge',
  tools: [
    {
      name: 'holo3d_show',
      description: 'Abre um MODELO 3D holográfico em tela cheia, desmontável: dá para explodir as peças, arrastar cada uma, isolar, ver em corte e animar a mecânica. Use para "me mostra um motor V8 em 3D", "abre o reator arc", "quero ver o motor por dentro". Modelos disponíveis: chame com o nome; se não existir, a resposta lista os que existem.',
      parameters: { type: 'object', properties: { modelo: { type: 'string', description: 'Ex.: "motor V8", "reator arc"' } }, required: ['modelo'] },
      async run({ modelo }, ctx) {
        const m = findModel(ctx, modelo);
        if (!m) return { ok: false, error: `Ainda não tenho "${modelo}" em 3D.`, disponiveis: library(ctx).map((x) => x.nome), how_to_answer: 'Diga que ainda não sabe montar esse (a geração automática vem na próxima fase) e cite os disponíveis.' };
        const model = JSON.parse(fs.readFileSync(m.file, 'utf8'));
        ctx.send('forge', { type: 'open', model });
        const grupos = [...new Set((model.pecas || []).map((p) => p.grupo).filter(Boolean))];
        return {
          ok: true, modelo: model.nome, grupos, descricao: model.descricao,
          how_to_answer: 'Uma frase curta de apresentação no estilo JARVIS. Pode sugerir: "diga desmonta", "isola os pistões", "corta ao meio".',
        };
      },
    },
    {
      name: 'holo3d_control',
      description: 'Controla o modelo 3D aberto: explodir/desmontar (valor 0 a 1.6), montar, animar, parar, velocidade (valor 0.1 a 4), corte (vista em corte), sem_corte, isolar (alvo = peça ou grupo, ex. "pistões"), mostrar_tudo, selecionar (alvo = peça; mostra o cartão e foca), girar (valor true/false), reset, fechar.',
      parameters: {
        type: 'object',
        properties: {
          acao: { type: 'string', enum: ['explodir', 'montar', 'animar', 'parar', 'velocidade', 'corte', 'sem_corte', 'isolar', 'mostrar_tudo', 'selecionar', 'girar', 'reset', 'fechar'] },
          alvo: { type: 'string' },
          valor: { type: 'number', description: 'explodir 0 a 1.6; velocidade 0.1 a 4; girar 1 liga, 0 desliga' },
        },
        required: ['acao'],
      },
      async run(args, ctx) {
        if (!ctx.forgeState?.active) return { ok: false, error: 'Nenhum modelo 3D aberto.' };
        ctx.send('forge-cmd', args);
        return { ok: true, how_to_answer: 'Confirme em poucas palavras; se for "selecionar", explique a peça em 1 a 2 frases.' };
      },
    },
  ],
};
