// Briefing: dólar, notícias de IA, curiosidades, memes, clima e tarefas, exibidos em cards animados no HUD.

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) jarvis/2.0' };
const getJson = async (url) => (await fetch(url, { headers: UA, signal: AbortSignal.timeout(8000) })).json();
const getText = async (url) => (await fetch(url, { headers: UA, signal: AbortSignal.timeout(8000) })).text();
const decode = (s) => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

async function getCurrency() {
  const [now, week] = await Promise.all([
    getJson('https://economia.awesomeapi.com.br/json/last/USD-BRL,EUR-BRL,BTC-BRL'),
    getJson('https://economia.awesomeapi.com.br/json/daily/USD-BRL/7'),
  ]);
  const pick = (x) => ({ value: Number(x.bid), change: Number(x.pctChange) });
  return {
    usd: pick(now.USDBRL), eur: pick(now.EURBRL), btc: pick(now.BTCBRL),
    usdWeek: week.map((d) => Number(d.bid)).reverse(), // do mais antigo para o mais novo
  };
}

async function getAiNews() {
  const xml = await getText('https://news.google.com/rss/search?q=intelig%C3%AAncia+artificial+when:1d&hl=pt-BR&gl=BR&ceid=BR:pt-419');
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 5).map(([, item]) => {
    const full = decode((item.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
    const cut = full.lastIndexOf(' - ');
    return {
      title: cut > 0 ? full.slice(0, cut) : full,
      source: cut > 0 ? full.slice(cut + 3) : '',
      link: decode((item.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || ''),
    };
  });
}

async function getMemes() {
  const subs = [['ProgrammerHumor', 2], ['DiretoDoZapZap', 2]];
  const lists = await Promise.all(subs.map(([sub, n]) => getJson(`https://meme-api.com/gimme/${sub}/${n + 2}`).catch(() => ({ memes: [] }))));
  return lists.flatMap((l, i) => (l.memes || [])
    .filter((m) => !m.nsfw && !m.spoiler && /\.(png|jpe?g|gif|webp)$/i.test(m.url))
    .slice(0, subs[i][1])
    .map((m) => ({ title: m.title, image: m.url, link: m.postLink, sub: m.subreddit })));
}

async function getRawCuriosities() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
  const [facts, history] = await Promise.all([
    Promise.all([1, 2, 3].map(() => getJson('https://uselessfacts.jsph.pl/api/v2/facts/random?language=en').then((f) => f.text).catch(() => null))),
    getJson(`https://api.wikimedia.org/feed/v1/wikipedia/pt/onthisday/selected/${mm}/${dd}`).then((j) => (j.selected || []).slice(0, 12).map((e) => `${e.year}: ${e.text}`)).catch(() => []),
  ]);
  return { facts: facts.filter(Boolean), history };
}

// Usa o modelo para traduzir as curiosidades e escolher um fato histórico leve (nada de tragédias no bom dia)
async function curate(raw, ctx) {
  const prompt = `Você recebe curiosidades em inglês e eventos históricos do dia de hoje.
Responda SOMENTE com JSON válido, sem texto antes ou depois, no formato:
{"curiosities":[{"title":"título curto e divertido","text":"curiosidade traduzida, até 220 caracteres"}],"history":{"year":"1950","text":"evento, até 200 caracteres"}}
Regras: traduza para português do Brasil e escolha as 2 curiosidades mais interessantes que sejam adequadas para qualquer público (nada de sexo, violência, drogas ou nojeiras). Se nenhuma servir, invente o mínimo: use só as que servem, mesmo que seja uma. Para "history" escolha um evento LEVE e curioso (ciência, tecnologia, cultura, esporte), nunca guerras, massacres, mortes ou tragédias.

Curiosidades:
${raw.facts.map((f, i) => `${i + 1}. ${f}`).join('\n')}

Eventos históricos de hoje:
${raw.history.join('\n')}`;
  const text = await ctx.complete(prompt, { maxTokens: 600 });
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(json);
}

async function getWeather(ctx) {
  const geo = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(ctx.config.city)}&count=1&language=pt`);
  const place = geo.results?.[0];
  if (!place) return null;
  const w = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=1`);
  return {
    city: place.name, temp: Math.round(w.current.temperature_2m), code: w.current.weather_code,
    min: Math.round(w.daily.temperature_2m_min[0]), max: Math.round(w.daily.temperature_2m_max[0]), rain: w.daily.precipitation_probability_max[0],
  };
}

const settle = (p) => p.then((v) => v, (e) => { console.error('[briefing]', e.message); return null; });

module.exports = {
  name: 'briefing',
  api: { getCurrency, getAiNews }, // usados também pelo letreiro da Oficina
  tools: [
    {
      name: 'briefing_show',
      description: 'Mostra o briefing do dia na tela com animação: dólar/euro/bitcoin, notícias de IA, curiosidades, hoje na história, memes, clima e tarefas. Use para "bom dia", "briefing", "me atualiza", "novidades do dia".',
      parameters: { type: 'object', properties: {} },
      async run(_, ctx) {
        ctx.send('briefing', { loading: true });
        const [currency, news, memes, raw, weather] = await Promise.all([
          settle(getCurrency()), settle(getAiNews()), settle(getMemes()), settle(getRawCuriosities()), settle(getWeather(ctx)),
        ]);
        const curated = raw ? await settle(curate(raw, ctx)) : null;
        const tasks = ctx.getTasks ? ctx.getTasks().filter((t) => !t.done).slice(0, 5) : [];

        ctx.send('briefing', {
          date: new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }),
          currency, news, memes, weather, tasks,
          curiosities: curated?.curiosities || [],
          history: curated?.history || null,
        });

        // Resumo para o modelo narrar
        return {
          shown_on_screen: true,
          dollar: currency && `R$ ${currency.usd.value.toFixed(2)} (${currency.usd.change >= 0 ? '+' : ''}${currency.usd.change.toFixed(2)}% hoje)`,
          weather: weather && `${weather.temp} graus agora em ${weather.city}, máxima ${weather.max}, chuva ${weather.rain}%`,
          ai_headlines: (news || []).slice(0, 3).map((n) => n.title),
          curiosity: curated?.curiosities?.[0]?.text,
          pending_tasks: tasks.length,
          memes: (memes || []).length,
          how_to_answer: 'Narre em 3 a 4 frases curtas e animadas, no estilo JARVIS: cumprimente pelo período do dia, diga o dólar, destaque UMA manchete de IA, conte a curiosidade, mencione as tarefas pendentes se houver e diga que separou alguns memes na tela. Não leia tudo: o resto está na tela.',
        };
      },
    },
    {
      name: 'briefing_close',
      description: 'Fecha o painel do briefing.',
      parameters: { type: 'object', properties: {} },
      async run(_, ctx) {
        ctx.send('briefing-close');
        return { ok: true };
      },
    },
  ],
};
