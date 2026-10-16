// Pesquisa: pesquisa profunda com fontes, resumo de links, comparador e cards de conhecimento.
// Tudo que é gerado fica salvo em data/research/ e aparece na tela "Pesquisas".
const path = require('path');
const fs = require('fs');
const web = require('../lib/web');

let ctxRef;
const dir = () => path.join(ctxRef.dataDir, 'research');
const indexFile = () => path.join(dir(), 'index.json');
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ---------------------------------------------------------------- armazenamento

function save(item) {
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(path.join(dir(), `${item.id}.json`), JSON.stringify(item, null, 2));
  const index = ctxRef.readJson(indexFile(), []).filter((x) => x.id !== item.id);
  index.unshift({ id: item.id, type: item.type, title: item.title, summary: (item.summary || '').slice(0, 200), at: item.at, sources: item.sources?.length || 0 });
  ctxRef.writeJson(indexFile(), index.slice(0, 300));
  ctxRef.send('research-saved', { id: item.id });
}

const api = {
  list: () => ctxRef.readJson(indexFile(), []),
  get: (id) => ctxRef.readJson(path.join(dir(), `${id}.json`), null),
  remove(id) {
    try { fs.unlinkSync(path.join(dir(), `${id}.json`)); } catch {}
    ctxRef.writeJson(indexFile(), api.list().filter((x) => x.id !== id));
  },
};

// ---------------------------------------------------------------- utilitários

// Remove comentários // e /* */ que ficam FORA de strings (não estraga "https://...")
function stripJsonComments(s) {
  let out = '', inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += s[++i] || ''; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && s[i + 1] === '*') { i = s.indexOf('*/', i + 2); if (i < 0) break; i++; continue; }
    out += c;
  }
  return out;
}

// O modelo às vezes embrulha o JSON em texto, comenta linhas ou deixa vírgulas sobrando
function parseJson(text) {
  const raw = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try { return JSON.parse(raw); } catch {}
  return JSON.parse(stripJsonComments(raw).replace(/,\s*([}\]])/g, '$1').replace(/[“”]/g, '"'));
}

async function completeJson(prompt, maxTokens) {
  let lastErr;
  for (let i = 0; i < 2; i++) {
    try { return parseJson(await ctxRef.complete(prompt + (i ? '\n\nATENÇÃO: responda SOMENTE com JSON válido.' : ''), { maxTokens })); } catch (e) { lastErr = e; }
  }
  throw new Error(`A IA não devolveu um resultado válido (${lastErr.message})`);
}

function userContext() {
  const facts = ctxRef.memory?.list().map((f) => f.text) || [];
  return `Usuário: ${ctxRef.config.userName}, programador${facts.length ? `. O que se sabe sobre ele: ${facts.slice(-15).join('; ')}` : ''}.`;
}

// Mostra o progresso ao vivo na tela de Pesquisas
function progress(id, data) { ctxRef.send('research-progress', { id, ...data }); }

// Busca várias consultas, junta resultados únicos (alternando entre as consultas para variar as fontes) e lê as páginas
async function gather(id, queries, maxPages) {
  progress(id, { phase: 'search', queries });
  const lists = await Promise.all(queries.map((q) => web.search(q, 6).catch(() => [])));
  const seen = new Set(), picked = [];
  for (let round = 0; round < 6 && picked.length < maxPages; round++) {
    for (const list of lists) {
      const r = list[round];
      if (!r || seen.has(r.url) || /\.pdf($|\?)/i.test(r.url) || /(youtube|facebook|instagram|tiktok|twitter|x)\.com/.test(r.host)) continue;
      seen.add(r.url);
      picked.push(r);
      if (picked.length >= maxPages) break;
    }
  }
  const sources = picked.map((r) => ({ ...r, status: 'pending' }));
  progress(id, { phase: 'reading', sources });

  // lê no máximo 4 páginas ao mesmo tempo
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < sources.length) {
      const s = sources[next++];
      s.status = 'reading';
      progress(id, { phase: 'reading', sources });
      try {
        const page = await web.fetchPage(s.url, 3500);
        if (page.text.length < 300) throw new Error('pouco conteúdo');
        Object.assign(s, { status: 'done', title: page.title || s.title, text: page.text });
      } catch (e) {
        s.status = 'failed';
        s.error = e.message;
      }
      progress(id, { phase: 'reading', sources });
    }
  }));
  return sources.filter((s) => s.status === 'done');
}

const sourcesBlock = (sources) => sources.map((s, i) => `[${i + 1}] ${s.title} (${s.host})\n${s.text}`).join('\n\n---\n\n');
const publicSources = (sources) => sources.map((s, i) => ({ n: i + 1, title: s.title, url: s.url, host: s.host }));

// ---------------------------------------------------------------- ferramentas

module.exports = {
  name: 'research',
  api,
  init(ctx) { ctxRef = ctx; },
  tools: [
    {
      name: 'research_deep',
      description: 'Pesquisa PROFUNDA na internet: divide o assunto em perguntas, lê várias páginas e monta um relatório com fontes na tela "Pesquisas". Use para "pesquisa a fundo", "faz uma pesquisa sobre", "quero entender bem X", assuntos amplos ou atuais. Para uma informação rápida, use web_search.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'O assunto, com o objetivo do usuário se ele disser' },
          depth: { type: 'string', enum: ['normal', 'deep'], description: 'normal ≈ 8 fontes; deep ≈ 14 fontes (mais lento)' },
        },
        required: ['topic'],
      },
      async run({ topic, depth = 'normal' }, ctx) {
        const id = newId();
        ctx.send('navigate', 'research');
        progress(id, { phase: 'plan', topic });
        const n = depth === 'deep' ? 6 : 4;
        const plan = await completeJson(
          `Você vai planejar uma pesquisa na internet sobre: "${topic}".\nData de hoje: ${new Date().toLocaleDateString('pt-BR')}.\n` +
          `Crie ${n} consultas de busca curtas e DIFERENTES entre si (ângulos diferentes: panorama, números/dados, notícias recentes, prós e contras, exemplos...). ` +
          'Use português, e inglês só se o assunto for melhor coberto em inglês.\nResponda SOMENTE JSON: {"queries": ["...", "..."]}', 400);
        const queries = (plan.queries || []).slice(0, n).filter(Boolean);
        if (!queries.length) queries.push(topic);

        const sources = await gather(id, queries, depth === 'deep' ? 14 : 8);
        if (!sources.length) { progress(id, { phase: 'error', message: 'Não consegui ler nenhuma fonte.' }); return { ok: false, error: 'Nenhuma fonte pôde ser lida' }; }

        progress(id, { phase: 'writing', sources: sources.map(({ text, ...s }) => s) });
        const report = await completeJson(
          `Escreva um relatório de pesquisa em português do Brasil sobre: "${topic}".\n${userContext()}\n` +
          `Use APENAS as fontes abaixo. Cite as fontes no texto com [n] (ex: "o mercado cresceu 12% [2]"). Se as fontes discordarem, diga. Se faltar informação, diga o que não foi encontrado.\n` +
          'Responda SOMENTE JSON no formato:\n' +
          '{"title": "título curto", "summary": "resumo de 2 a 3 frases", "key_points": ["5 a 7 pontos-chave curtos, com [n]"], ' +
          '"sections": [{"heading": "título da seção", "text": "2 a 4 parágrafos com citações [n]"}], "gaps": "o que não foi possível confirmar (opcional)"}\n' +
          'Use de 3 a 5 seções.\n\nFONTES:\n' + sourcesBlock(sources), 6000);

        const item = {
          id, type: 'research', at: Date.now(), topic, depth,
          title: report.title || topic, summary: report.summary || '', keyPoints: report.key_points || [],
          sections: report.sections || [], gaps: report.gaps || '', queries, sources: publicSources(sources),
        };
        save(item);
        progress(id, { phase: 'done', item });
        return {
          ok: true, shown_on_screen: true, title: item.title, summary: item.summary, key_points: item.keyPoints.slice(0, 5), sources_read: sources.length,
          how_to_answer: ctx.channel === 'telegram'
            ? 'Mande o resumo e os pontos-chave, e diga que o relatório completo com fontes está na tela Pesquisas do JARVIS.'
            : 'Fale em 2 frases o principal achado e diga que o relatório completo, com as fontes, está na tela.',
        };
      },
    },
    {
      name: 'read_link',
      description: 'Lê e resume uma página da internet (notícia, artigo, documentação). Sem URL, usa o link que o usuário copiou. Use para "resume esse link", "lê esse artigo", "do que fala essa página".',
      parameters: { type: 'object', properties: { url: { type: 'string' }, question: { type: 'string', description: 'Pergunta específica sobre a página, se houver' } } },
      async run({ url, question }, ctx) {
        if (!url) {
          const clip = String((await ctx.readClipboard()) || '').trim();
          url = (clip.match(/https?:\/\/\S+/) || [])[0];
          if (!url) return { ok: false, error: 'Não há link na área de transferência. Copie o link ou diga qual é.' };
        }
        if (!/^https?:\/\//.test(url)) url = `https://${url}`;
        const id = newId();
        ctx.send('navigate', 'research');
        progress(id, { phase: 'reading', sources: [{ url, host: web.hostOf(url), title: url, status: 'reading' }] });
        const page = await web.fetchPage(url, 14000);
        progress(id, { phase: 'writing', sources: [{ url, host: page.host, title: page.title, status: 'done' }] });
        const r = await completeJson(
          `Resuma esta página em português do Brasil.${question ? ` O usuário quer saber especificamente: "${question}".` : ''}\n${userContext()}\n` +
          'Responda SOMENTE JSON: {"title": "título", "tldr": "1 frase", "summary": "1 parágrafo", "key_points": ["4 a 7 pontos"], "answer": "resposta à pergunta do usuário, se houver"}\n\n' +
          `PÁGINA: ${page.title} (${page.host})\n${page.text}`, 2500);
        const item = {
          id, type: 'link', at: Date.now(), title: r.title || page.title, summary: r.summary || '', tldr: r.tldr || '', answer: r.answer || '',
          keyPoints: r.key_points || [], image: page.image || null, sources: [{ n: 1, title: page.title, url: page.url, host: page.host }], sections: [],
        };
        save(item);
        progress(id, { phase: 'done', item });
        return { ok: true, shown_on_screen: true, tldr: item.tldr, answer: item.answer || undefined, key_points: item.keyPoints.slice(0, 4), how_to_answer: 'Fale o resumo em 1 a 2 frases (ou a resposta à pergunta). O resumo completo está na tela.' };
      },
    },
    {
      name: 'compare',
      description: 'Compara 2 a 4 opções (produtos, tecnologias, bibliotecas, serviços, lugares...) pesquisando na internet e mostra na tela: tabela, notas por critério, prós e contras e um veredito personalizado. Para bibliotecas de programação use kind=npm ou pypi (traz downloads e estrelas no GitHub de verdade).',
      parameters: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { type: 'string' }, description: 'As opções a comparar (2 a 4)' },
          kind: { type: 'string', enum: ['general', 'npm', 'pypi'], description: 'npm = pacotes JavaScript; pypi = pacotes Python; general = qualquer outra coisa' },
          context: { type: 'string', description: 'Para que o usuário quer (ex: "para um projeto de visão computacional", "até R$ 3 mil")' },
          criteria: { type: 'array', items: { type: 'string' }, description: 'Critérios específicos, se o usuário pediu' },
        },
        required: ['items'],
      },
      async run({ items, kind = 'general', context = '', criteria = [] }, ctx) {
        items = (items || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 4);
        if (items.length < 2) return { ok: false, error: 'Diga pelo menos duas opções para comparar' };
        const id = newId();
        ctx.send('navigate', 'research');
        progress(id, { phase: 'plan', topic: items.join(' vs ') });

        // Dados reais dos pacotes (downloads, versão, GitHub)
        let packages = [];
        if (kind === 'npm' || kind === 'pypi') {
          const fetcher = kind === 'npm' ? web.npmPackage : web.pypiPackage;
          packages = await Promise.all(items.map((it) => fetcher(it, ctx.config.githubToken).catch(() => null)));
        }

        const vs = items.join(' vs ');
        const queries = [`${vs} comparação`, `${vs} qual escolher ${new Date().getFullYear()}`, ...items.map((it) => `${it} ${kind === 'general' ? 'review prós e contras' : 'vantagens desvantagens'}`)].slice(0, 5);
        const sources = await gather(id, queries, 8);
        progress(id, { phase: 'writing', sources: sources.map(({ text, ...s }) => s) });

        const pkgText = packages.some(Boolean)
          ? '\nDADOS REAIS DOS PACOTES:\n' + packages.map((p, i) => (p ? `${items[i]}: versão ${p.version}, último lançamento ${p.lastPublish?.slice(0, 10)}, downloads/semana ${p.weeklyDownloads ?? 'n/d'}, estrelas GitHub ${p.github?.stars ?? 'n/d'}, issues abertas ${p.github?.openIssues ?? 'n/d'}, licença ${p.license || 'n/d'}` : `${items[i]}: pacote não encontrado`)).join('\n')
          : '';
        const r = await completeJson(
          `Compare: ${items.map((it) => `"${it}"`).join(', ')}.${context ? ` Objetivo do usuário: ${context}.` : ''}\n${userContext()}\n` +
          `${criteria.length ? `Critérios pedidos: ${criteria.join(', ')}.` : 'Escolha de 4 a 6 critérios relevantes.'}\n` +
          'Baseie-se nas fontes e nos dados reais. Seja justo e concreto. O veredito deve considerar o perfil e o objetivo do usuário.\n' +
          `Responda SOMENTE JSON válido (sem comentários) com as opções SEMPRE nesta ordem: ${JSON.stringify(items)}:\n` +
          '{"title": "título curto", "summary": "1 a 2 frases", "criteria": ["critério"], "scores": [[nota 0-10 de cada opção, na ordem] para cada critério], ' +
          '"table": {"rows": [["atributo", "valor da opção 1", "valor da opção 2"]]}, "pros": [["prós da opção 1"], ["prós da opção 2"]], "cons": [["contras da opção 1"], ["contras da opção 2"]], ' +
          '"best_for": ["quando escolher a opção 1", "quando escolher a opção 2"], "verdict": "veredito de 2 a 3 frases, personalizado"}\n' +
          `A tabela deve ter de 5 a 8 linhas de características concretas (preço, desempenho, tamanho, etc.).${pkgText}\n\nFONTES:\n${sourcesBlock(sources) || '(nenhuma fonte lida: use seu conhecimento e avise)'}`, 4000);

        // Monta os cards do painel
        const cards = [];
        packages.forEach((p, i) => {
          if (!p) return;
          const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace('.', ',')} mi` : n >= 1e3 ? `${Math.round(n / 1e3)} mil` : String(n ?? '—'));
          cards.push({ type: 'stat', title: items[i].toUpperCase(), value: p.weeklyDownloads != null ? `${k(p.weeklyDownloads)}/sem` : `v${p.version}`, caption: `v${p.version} · ★ ${p.github ? k(p.github.stars) : '—'} · atualizado ${p.lastPublish ? new Date(p.lastPublish).toLocaleDateString('pt-BR') : '—'}` });
        });
        const months = packages.find((p) => p?.monthly?.length)?.monthly.map(([m]) => m) || [];
        if (months.length) {
          cards.push({
            type: 'chart', kind: 'line', title: 'DOWNLOADS POR MÊS (NPM)', size: 'large',
            labels: months.map((m) => new Date(m + '-15').toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' })),
            series: packages.map((p, i) => ({ name: items[i], values: months.map((m) => p?.monthly?.find(([x]) => x === m)?.[1] ?? null) })),
          });
        }
        // As notas devem vir uma linha por critério; se vierem uma linha por opção, transpõe
        if (r.criteria?.length && r.scores?.length && r.criteria.length !== items.length &&
            r.scores.length === items.length && r.scores.every((row) => Array.isArray(row) && row.length === r.criteria.length)) {
          r.scores = r.criteria.map((_, ci) => items.map((_, ii) => r.scores[ii][ci]));
        }
        if (r.criteria?.length && r.scores?.length) {
          cards.push({ type: 'chart', kind: 'bar', title: 'NOTAS POR CRITÉRIO (0 A 10)', size: 'large', labels: r.criteria, series: items.map((it, i) => ({ name: it, values: r.scores.map((row) => Number(row?.[i]) || 0) })) });
        }
        if (r.table?.rows?.length) cards.push({ type: 'table', title: 'LADO A LADO', columns: ['', ...items], rows: r.table.rows });
        items.forEach((it, i) => cards.push({
          type: 'list', title: it.toUpperCase(), size: 'medium',
          items: [...(r.pros?.[i] || []).map((t) => ({ title: `✓ ${t}` })), ...(r.cons?.[i] || []).map((t) => ({ title: `✗ ${t}` })), ...(r.best_for?.[i] ? [{ title: `→ Escolha se: ${r.best_for[i]}` }] : [])],
        }));
        if (r.verdict) cards.push({ type: 'text', title: 'VEREDITO DO JARVIS', size: 'large', text: r.verdict });

        const clean = cards.map((c) => (c.type === 'heatmap' ? c : ctx.sanitizeCard(c))).filter(Boolean);
        const item = { id, type: 'compare', at: Date.now(), title: r.title || vs, summary: r.summary || '', verdict: r.verdict || '', items, cards: clean, sources: publicSources(sources), sections: [], keyPoints: [] };
        save(item);
        progress(id, { phase: 'done', item });
        return { ok: true, shown_on_screen: true, summary: r.summary, verdict: r.verdict, how_to_answer: 'Fale o veredito em 1 a 2 frases. Tabela, notas e prós e contras estão na tela.' };
      },
    },
    {
      name: 'knowledge_card',
      description: 'Mostra um card visual (foto, resumo, link) sobre uma pessoa, lugar, empresa, conceito ou coisa, usando a Wikipédia. Use para "quem é", "o que é", "me fala sobre" quando a resposta fica melhor com imagem.',
      parameters: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] },
      async run({ topic }, ctx) {
        const w = await web.wikipedia(topic);
        if (!w) return { ok: false, error: 'Não encontrei na Wikipédia; responda com seu conhecimento ou use web_search' };
        ctx.send('visual', { kicker: 'J.A.R.V.I.S. · CONHECIMENTO', title: w.title, cards: [{ type: 'profile', size: 'large', title: w.title, description: w.description, text: w.extract, image: w.image, url: w.url }] });
        return { ok: true, shown_on_screen: true, title: w.title, description: w.description, extract: w.extract, how_to_answer: 'Fale 1 a 2 frases interessantes sobre o assunto; o card está na tela.' };
      },
    },
  ],
};
