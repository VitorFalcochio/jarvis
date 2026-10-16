// Esforço máximo: em vez da primeira ideia, o JARVIS abre o leque, filtra e escolhe.
//  1. planejar (modelo grande): entende o pedido, escolhe critérios e de 3 a 16 "ângulos" bem diferentes
//  2. gerar (modelo rápido, em paralelo): uma abordagem por ângulo
//  3. avaliar (modelo grande): junta as repetidas, dá notas por critério e recomenda
// Quem chama injeta `call(kind, prompt, opts)` (kind: 'fast' = gerar em massa, 'judge' = avaliar) e `emit(evento)` para o progresso na tela.

const ANGLES = { produto: 16, negocio: 16, arquitetura: 8, codigo: 8, bug: 8, pergunta: 3, outro: 10 };
const CONCURRENCY = 10;
const IDEA_TIMEOUT_MS = 40000;
const GRACE_MS = 7000;

// O modelo às vezes embrulha o JSON em ```json ou escreve algo antes: pega o primeiro objeto inteiro
function parseJson(text) {
  const t = String(text || '').replace(/```(?:json)?/gi, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('resposta sem JSON');
  const body = t.slice(start, end + 1);
  try { return JSON.parse(body); } catch {}
  // conserto dos deslizes comuns: aspas simples nas strings e vírgula sobrando
  const fixed = body
    .replace(/'((?:[^'\\]|\\.)*)'(?=\s*[:,}\]])/g, (_, s) => JSON.stringify(s))
    .replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(fixed);
}

// Chama o modelo e lê o JSON; se vier quebrado, pede de novo uma vez
async function callJson(call, kind, prompt, opts) {
  try {
    return parseJson(await call(kind, prompt, opts));
  } catch (e) {
    if (opts?.signal?.aborted) throw e;
    return parseJson(await call(kind, `${prompt}

ATENÇÃO: a resposta anterior não era JSON válido. Use SÓ aspas duplas, sem comentários e sem texto fora do JSON.`, opts));
  }
}

const str = (v, max = 400) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max));
const list = (v, n = 6, max = 220) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => str(x, max)).filter(Boolean).slice(0, n);

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

async function plan({ request, context, call, signal }) {
  const p = await callJson(call, 'fast', `Você é o planejador de um "conselho" de especialistas. O usuário pediu:
"""${request}"""
${context ? `\nContexto que você conhece sobre ele e seus projetos:\n${context}\n` : ''}
Classifique o pedido e prepare a exploração. Responda SOMENTE com JSON válido:
{"tipo":"produto|negocio|arquitetura|codigo|bug|pergunta|outro",
 "objetivo":"o pedido reescrito em 1 frase clara",
 "criterios":[{"nome":"Custo","peso":2}],
 "angulos":[{"nome":"Mais barata","instrucao":"o que esse ângulo deve priorizar"}]}

Regras:
- tipo: produto/negocio = ideias de produto, negócio, monetização, marketing; arquitetura/codigo = como construir; bug = algo quebrado ou lento; pergunta = dúvida com uma resposta certa; outro = o resto.
- criterios: de 3 a 5, os que importam PARA ESTE pedido e para este usuário (ex.: custo, tempo até lançar, potencial, risco, dificuldade, escalabilidade, manutenção). peso de 1 a 3. Para bug use: Probabilidade, Facilidade de testar, Impacto. Para pergunta use: Confiança.
- angulos: exatamente ${Object.entries(ANGLES).map(([k, n]) => `${n} para ${k}`).join(', ')}. Cada ângulo precisa levar a uma solução REALMENTE diferente das outras (não variações da mesma). Ex. para produto: mais barata, mais rápida de lançar, mais ousada, mais escalável, sem código, receita recorrente, via parceria, freemium, nicho específico, a que um concorrente grande faria, a que dá dinheiro primeiro, B2B vs B2C... Para bug: uma área suspeita por ângulo (frontend, rede, banco, concorrência, memória, configuração, dependência, dados). Para pergunta: 3 métodos independentes de chegar à resposta.
- Escreva em português do Brasil.`, { maxTokens: 2000, temperature: 0.7, signal });
  const tipo = Object.keys(ANGLES).includes(p.tipo) ? p.tipo : 'outro';
  const criterios = (Array.isArray(p.criterios) ? p.criterios : []).map((c) => ({ nome: str(c.nome, 30), peso: Math.max(1, Math.min(3, Number(c.peso) || 1)) })).filter((c) => c.nome).slice(0, 5);
  const angulos = (Array.isArray(p.angulos) ? p.angulos : []).map((a, i) => ({ id: `a${i + 1}`, nome: str(a.nome, 50), instrucao: str(a.instrucao, 300) })).filter((a) => a.nome).slice(0, 16);
  if (angulos.length < 2) throw new Error('o planejamento não trouxe ângulos');
  return { tipo, objetivo: str(p.objetivo, 300) || request, criterios: criterios.length ? criterios : [{ nome: 'Qualidade', peso: 1 }], angulos };
}

const SHAPE = {
  bug: '{"titulo":"a hipótese em poucas palavras","resumo":"por que isso pode ser a causa","como":["passo para testar/confirmar"],"pros":["sinal a favor"],"contras":["sinal contra"]}',
  pergunta: '{"titulo":"a resposta em uma frase","resumo":"o raciocínio","como":["passo do raciocínio"],"pros":["o que sustenta"],"contras":["o que pode estar errado"]}',
  default: '{"titulo":"nome curto e marcante da abordagem","resumo":"a ideia em 2 frases","como":["passo concreto"],"pros":["vantagem"],"contras":["desvantagem"]}',
};

async function generate({ request, context, planned, call, emit, signal }) {
  const shape = SHAPE[planned.tipo] || SHAPE.default;
  // Uma chamada lenta não pode segurar o conselho inteiro: com 75% das ideias prontas, as atrasadas
  // ganham mais GRACE_MS; e nenhuma passa de IDEA_TIMEOUT_MS
  const cut = new AbortController();
  const quorum = Math.ceil(planned.angulos.length * 0.75);
  let finished = 0;
  let graceTimer = null;
  const settle = () => {
    if (++finished >= quorum && !graceTimer) graceTimer = setTimeout(() => cut.abort(), GRACE_MS);
  };
  const ideas = await pool(planned.angulos, CONCURRENCY, async (a) => {
    if (cut.signal.aborted) { emit({ stage: 'gen', id: a.id, ok: false }); return null; }
    const own = AbortSignal.any([cut.signal, AbortSignal.timeout(IDEA_TIMEOUT_MS), ...(signal ? [signal] : [])]);
    try {
      const j = await callJson(call, 'fast', `Pedido do usuário: """${request}"""
Objetivo: ${planned.objetivo}
${context ? `Contexto: ${context.slice(0, 2500)}\n` : ''}
Você é o especialista do ângulo "${a.nome}": ${a.instrucao}
Proponha UMA abordagem fiel a esse ângulo, concreta e realista (nada genérico). De 3 a 5 itens em "como".
Responda SOMENTE com JSON válido, em português: ${shape}`, { maxTokens: 700, temperature: 0.95, signal: own });
      const idea = { id: a.id, angulo: a.nome, titulo: str(j.titulo, 100), resumo: str(j.resumo, 500), como: list(j.como, 5), pros: list(j.pros, 4), contras: list(j.contras, 4) };
      if (!idea.titulo) throw new Error('sem título');
      emit({ stage: 'gen', id: a.id, ok: true, titulo: idea.titulo });
      return idea;
    } catch (e) {
      if (signal?.aborted) throw e;
      emit({ stage: 'gen', id: a.id, ok: false });
      return null;
    } finally {
      settle();
    }
  });
  clearTimeout(graceTimer);
  return ideas.filter(Boolean);
}

async function evaluate({ request, context, planned, ideas, call, signal }) {
  const many = !['pergunta'].includes(planned.tipo);
  const j = await callJson(call, 'judge', `Pedido do usuário: """${request}"""
Objetivo: ${planned.objetivo}
${context ? `Contexto do usuário: ${context.slice(0, 3000)}\n` : ''}
Seu conselho de especialistas gerou ${ideas.length} abordagens (tipo do pedido: ${planned.tipo}):
${ideas.map((i) => `[${i.id}] (${i.angulo}) ${i.titulo}: ${i.resumo} | como: ${i.como.join('; ')} | prós: ${i.pros.join('; ')} | contras: ${i.contras.join('; ')}`).join('\n')}

Agora seja o avaliador exigente:
1. Junte as abordagens que são a mesma ideia com outra roupa (pode combinar as melhores partes).
2. ${many ? 'Fique com de 4 a 7 opções REALMENTE diferentes.' : 'Fique com as respostas distintas (1 se todas concordam, até 3 se discordam).'}
3. Dê nota de 0 a 10 em cada critério: ${planned.criterios.map((c) => `${c.nome} (peso ${c.peso})`).join(', ')}. Nota alta = melhor para o usuário (em Custo, 10 = mais barato; em Risco, 10 = menos arriscado).
4. Escolha a recomendada pensando no contexto real dele, não na média.
Responda SOMENTE com JSON válido, em português:
{"titulo":"título curto da análise",
 "opcoes":[{"titulo":"...","resumo":"2 a 3 frases","origem":["a1","a4"],"passos":["primeiros passos"],"notas":{${planned.criterios.map((c) => `"${c.nome}":7`).join(',')}},"prazo":"estimativa (ex: 2 semanas)","risco":"o principal risco em 1 frase"}],
 "recomendada":0,
 "porque":"por que a recomendada, em 2 frases (cite as opções pelo NOME, nunca por número)",
 "consenso":"alto|medio|baixo"}
Seja conciso: resumo com no máximo 2 frases, no máximo 3 passos por opção.`, { maxTokens: 3000, temperature: 0.3, signal });
  const opcoes = (Array.isArray(j.opcoes) ? j.opcoes : []).map((o) => {
    const notas = {};
    for (const c of planned.criterios) notas[c.nome] = Math.max(0, Math.min(10, Number(o.notas?.[c.nome]) || 0));
    const pesoTotal = planned.criterios.reduce((a, c) => a + c.peso, 0);
    const total = planned.criterios.reduce((a, c) => a + notas[c.nome] * c.peso, 0) / pesoTotal;
    return { titulo: str(o.titulo, 100), resumo: str(o.resumo, 600), origem: list(o.origem, 8, 6), passos: list(o.passos, 5), notas, total: Math.round(total * 10) / 10, prazo: str(o.prazo, 60), risco: str(o.risco, 200) };
  }).filter((o) => o.titulo).slice(0, 7);
  if (!opcoes.length) throw new Error('a avaliação não trouxe opções');
  const rec = opcoes[Math.max(0, Math.min(opcoes.length - 1, Number(j.recomendada) || 0))];
  rec.recomendada = true;
  opcoes.sort((a, b) => (b.recomendada - a.recomendada) || (b.total - a.total));
  return { titulo: str(j.titulo, 100) || planned.objetivo, opcoes, porque: str(j.porque, 500), consenso: ['alto', 'medio', 'baixo'].includes(j.consenso) ? j.consenso : null };
}

async function deepThink({ request, context = '', call, emit = () => {}, signal }) {
  const t0 = Date.now();
  emit({ stage: 'plan' });
  const planned = await plan({ request, context, call, signal });
  emit({ stage: 'plan-done', tipo: planned.tipo, objetivo: planned.objetivo, criterios: planned.criterios, angulos: planned.angulos.map((a) => ({ id: a.id, nome: a.nome })) });
  const ideas = await generate({ request, context, planned, call, emit, signal });
  if (ideas.length < Math.min(2, planned.angulos.length)) throw new Error('poucas abordagens geradas (a API pode estar instável)');
  emit({ stage: 'eval', count: ideas.length });
  const evaluated = await evaluate({ request, context, planned, ideas, call, signal });
  const result = { ...evaluated, tipo: planned.tipo, objetivo: planned.objetivo, criterios: planned.criterios, geradas: ideas.length, angulos: planned.angulos.length, segundos: Math.round((Date.now() - t0) / 1000) };
  emit({ stage: 'done', result });
  return result;
}

// Versão compacta para o modelo (e para o histórico): "1) Título (nota 8.2) — resumo"
function summarize(result) {
  return `[Análise profunda: ${result.titulo} · ${result.geradas} abordagens → ${result.opcoes.length} opções]\n`
    + result.opcoes.map((o, i) => `${i + 1}) ${o.titulo}${o.recomendada ? ' ★ RECOMENDADA' : ''} (nota ${o.total}; ${Object.entries(o.notas).map(([k, v]) => `${k} ${v}`).join(', ')}${o.prazo ? `; prazo ${o.prazo}` : ''}) — ${o.resumo}${o.passos.length ? ` Passos: ${o.passos.join('; ')}.` : ''}${o.risco ? ` Risco: ${o.risco}` : ''}`).join('\n')
    + (result.porque ? `\nPor que a recomendada: ${result.porque}` : '')
    + (result.consenso ? `\nConsenso entre os caminhos: ${result.consenso}` : '');
}

module.exports = { deepThink, summarize, parseJson };
