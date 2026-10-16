// Respostas visuais: o modelo monta cards (gráficos, tabelas, números, listas) que aparecem no painel holográfico.

const TYPES = ['stat', 'chart', 'table', 'list', 'text', 'image', 'timeline'];
const MAX_SERIES = 6; // a paleta validada tem 6 cores; mais que isso vira "Outros"

const str = (v, max = 400) => (v === undefined || v === null ? '' : String(v).slice(0, max));
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : Number(String(v).replace(',', '.')));

// Limpa e valida o que o modelo mandou (nunca confiar no formato)
function sanitizeCard(c) {
  if (!c || !TYPES.includes(c.type)) return null;
  const base = { type: c.type, title: str(c.title, 80), size: ['small', 'medium', 'large'].includes(c.size) ? c.size : undefined };
  switch (c.type) {
    case 'stat':
      return { ...base, value: str(c.value, 40), change: isFinite(num(c.change)) ? num(c.change) : null, caption: str(c.caption, 120) };
    case 'chart': {
      const labels = (c.labels || []).slice(0, 60).map((l) => str(l, 24));
      let series = (c.series || []).filter((s) => Array.isArray(s.values)).map((s) => ({
        name: str(s.name, 40), values: labels.map((_, i) => (isFinite(num(s.values[i])) ? num(s.values[i]) : null)),
      }));
      if (!labels.length || !series.length) return null;
      if (series.length > MAX_SERIES) {
        const rest = series.slice(MAX_SERIES - 1);
        series = series.slice(0, MAX_SERIES - 1).concat({ name: 'Outros', values: labels.map((_, i) => rest.reduce((a, s) => a + (s.values[i] || 0), 0)) });
      }
      return { ...base, kind: c.kind === 'bar' ? 'bar' : 'line', labels, series, unit: str(c.unit, 12) };
    }
    case 'table': {
      const columns = (c.columns || []).slice(0, 8).map((x) => str(x, 40));
      const rows = (c.rows || []).slice(0, 30).map((r) => (Array.isArray(r) ? r : []).slice(0, columns.length).map((x) => str(x, 120)));
      return columns.length ? { ...base, columns, rows } : null;
    }
    case 'list':
      return { ...base, items: (c.items || []).slice(0, 12).map((i) => (typeof i === 'string' ? { title: str(i, 200) } : { title: str(i.title, 200), subtitle: str(i.subtitle, 200), link: /^https:\/\//.test(i.link || '') ? i.link : undefined })) };
    case 'text':
      return { ...base, text: str(c.text, 1500) };
    case 'image':
      return /^https:\/\//.test(c.url || '') ? { ...base, url: c.url, caption: str(c.caption, 200) } : null;
    case 'timeline': {
      const items = (c.items || []).slice(0, 14).map((i) => ({ date: str(i.date, 30), title: str(i.title, 120), text: str(i.text, 300) })).filter((i) => i.title);
      return items.length ? { ...base, items } : null;
    }
  }
  return null;
}

const CARD_DOC = `Lista de cards. Cada card tem "type" e "title", e opcionalmente "size" (small|medium|large). Tipos:
- stat: {"value":"R$ 5,22","change":-0.4,"caption":"texto curto"} → número em destaque
- chart: {"kind":"line"|"bar","labels":["jan","fev"],"series":[{"name":"Série","values":[1,2]}],"unit":"%"} → line para evolução no tempo, bar para comparar categorias; no máximo 6 séries, uma única escala
- table: {"columns":["A","B"],"rows":[["1","2"]]} → comparações com vários atributos
- list: {"items":[{"title":"...","subtitle":"...","link":"https://..."}]}
- text: {"text":"..."}
- image: {"url":"https://...","caption":"..."}
- timeline: {"items":[{"date":"1995","title":"...","text":"..."}]} → linha do tempo (história, etapas, passo a passo, roteiro)`;

async function currencyHistory(code, days) {
  const pair = `${code.toUpperCase()}-BRL`;
  const data = await (await fetch(`https://economia.awesomeapi.com.br/json/daily/${pair}/${days}`, { signal: AbortSignal.timeout(8000) })).json();
  if (!Array.isArray(data) || !data.length) throw new Error(`Moeda ${code} não encontrada`);
  return data.reverse().map((d) => ({ date: new Date(Number(d.timestamp) * 1000), value: Number(d.bid) }));
}

module.exports = {
  name: 'visual',
  sanitizeCard,
  init(ctx) { ctx.sanitizeCard = sanitizeCard; },
  tools: [
    {
      name: 'show_visual',
      description: `Mostra uma resposta VISUAL no painel holográfico do HUD, ou dentro da conversa quando a tela de Chat está aberta (gráficos, tabelas, comparações, números, listas). Use quando a resposta fica melhor vista do que ouvida: comparações, dados numéricos, rankings, passo a passo, "me mostra". Depois FALE só 1 ou 2 frases com o principal. ${CARD_DOC}`,
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Título do painel' },
          subtitle: { type: 'string' },
          cards: { type: 'array', items: { type: 'object' }, description: CARD_DOC },
        },
        required: ['title', 'cards'],
      },
      async run({ title, subtitle, cards }, ctx) {
        const clean = (Array.isArray(cards) ? cards : []).map(sanitizeCard).filter(Boolean).slice(0, 10);
        if (!clean.length) return { ok: false, error: 'Nenhum card válido. Confira o formato.' };
        ctx.send('visual', { kicker: 'J.A.R.V.I.S. · ANÁLISE', title: str(title, 80), subtitle: str(subtitle, 120), cards: clean });
        return {
          ok: true, cards_shown: clean.length,
          how_to_answer: 'O detalhe já está na tela. FALE no máximo 2 frases curtas com a conclusão principal; não leia a tabela nem liste os números.',
        };
      },
    },
    {
      name: 'currency_chart',
      description: 'Mostra no painel o gráfico da cotação de uma moeda em reais (USD, EUR, BTC, GBP, JPY...) nos últimos N dias, com máxima, mínima e variação.',
      parameters: {
        type: 'object',
        properties: { code: { type: 'string', description: 'Código da moeda, ex: USD' }, days: { type: 'number', description: 'Dias (padrão 30, máx 360)' } },
        required: ['code'],
      },
      async run({ code, days = 30 }, ctx) {
        days = Math.max(5, Math.min(360, Math.round(days)));
        const hist = await currencyHistory(code, days);
        const values = hist.map((h) => h.value);
        const first = values[0], last = values[values.length - 1];
        const change = ((last - first) / first) * 100;
        const fmt = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: v < 10 ? 4 : 2, maximumFractionDigits: v < 10 ? 4 : 2 });
        const max = Math.max(...values), min = Math.min(...values);
        const label = (d) => d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
        const C = code.toUpperCase();
        ctx.send('visual', {
          kicker: 'J.A.R.V.I.S. · CÂMBIO',
          title: `${C} em reais · ${days} dias`,
          cards: [
            { type: 'stat', title: 'AGORA', value: fmt(last), change, caption: `variação em ${days} dias` },
            { type: 'stat', title: 'MÁXIMA', value: fmt(max), caption: label(hist[values.indexOf(max)].date) },
            { type: 'stat', title: 'MÍNIMA', value: fmt(min), caption: label(hist[values.indexOf(min)].date) },
            { type: 'chart', kind: 'line', title: `${C}/BRL`, size: 'large', labels: hist.map((h) => label(h.date)), series: [{ name: C, values }], unit: 'R$' },
          ],
        });
        return { ok: true, shown_on_screen: true, now: last, change_percent: Number(change.toFixed(2)), max, min, how_to_answer: 'Fale 1 a 2 frases com a tendência e o valor atual.' };
      },
    },
  ],
};
