// Informações da internet: clima, notícias, pesquisa.

const WEATHER_CODES = {
  0: 'céu limpo', 1: 'predominantemente limpo', 2: 'parcialmente nublado', 3: 'nublado',
  45: 'neblina', 48: 'neblina', 51: 'garoa fraca', 53: 'garoa', 55: 'garoa forte',
  61: 'chuva fraca', 63: 'chuva', 65: 'chuva forte', 80: 'pancadas de chuva fracas',
  81: 'pancadas de chuva', 82: 'pancadas de chuva fortes', 95: 'trovoadas', 96: 'trovoadas com granizo', 99: 'trovoadas com granizo',
};
const desc = (code) => WEATHER_CODES[code] || 'condição variável';

async function getWeather(city, ctx) {
  const geo = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=pt`)).json();
  const place = geo.results?.[0];
  if (!place) return { error: `Cidade "${city}" não encontrada` };
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
    '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m' +
    '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=auto&forecast_days=3';
  const w = await (await fetch(url)).json();
  const c = w.current, d = w.daily;
  ctx.send('weather', { city: place.name, temp: Math.round(c.temperature_2m), desc: desc(c.weather_code) });
  return {
    city: `${place.name}, ${place.admin1 || place.country}`,
    now: { temp: Math.round(c.temperature_2m), feels_like: Math.round(c.apparent_temperature), condition: desc(c.weather_code), humidity: c.relative_humidity_2m, wind_kmh: Math.round(c.wind_speed_10m) },
    forecast: d.time.map((t, i) => ({
      day: i === 0 ? 'hoje' : i === 1 ? 'amanhã' : t,
      min: Math.round(d.temperature_2m_min[i]), max: Math.round(d.temperature_2m_max[i]),
      condition: desc(d.weather_code[i]), rain_chance: d.precipitation_probability_max[i],
    })),
  };
}

async function getNews() {
  const xml = await (await fetch('https://g1.globo.com/rss/g1/')).text();
  const titles = [...xml.matchAll(/<item>[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/g)]
    .map((m) => m[1].trim()).slice(0, 8);
  return { source: 'G1', headlines: titles };
}

async function webSearch(query) {
  const html = await (await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=br-pt`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  })).text();
  const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").trim();
  const titles = [...html.matchAll(/class="result__a"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => strip(m[1]));
  const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => strip(m[1]));
  return { query, results: snippets.slice(0, 6).map((s, i) => ({ title: titles[i] || '', snippet: s })) };
}

module.exports = {
  name: 'info',
  tools: [
    {
      name: 'get_weather',
      description: 'Clima atual e previsão de 3 dias de uma cidade.',
      parameters: { type: 'object', properties: { city: { type: 'string', description: 'Cidade; omita para a cidade do usuário' } } },
      run: ({ city }, ctx) => getWeather(city || ctx.config.city, ctx),
    },
    {
      name: 'get_news',
      description: 'Principais manchetes do Brasil agora (G1).',
      parameters: { type: 'object', properties: {} },
      run: () => getNews(),
    },
    {
      name: 'web_search',
      description: 'Pesquisa na internet para você obter informação atual (resultados de jogos, cotações, fatos recentes, documentação). Nunca invente: pesquise.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      run: ({ query }) => webSearch(query),
    },
  ],
};
