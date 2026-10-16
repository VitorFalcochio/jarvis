// Ferramentas de web: busca (DuckDuckGo), leitura de páginas (texto principal), Wikipédia e dados de pacotes.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const SKIP_HOSTS = /(youtube\.com|youtu\.be|facebook\.com|instagram\.com|tiktok\.com|twitter\.com|x\.com|linkedin\.com|pinterest\.)/i;

const decodeEntities = (s) => s
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
const stripTags = (s) => decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };

// Busca no DuckDuckGo (versão HTML, sem chave). Devolve URLs reais (desembrulha o redirecionamento /l/?uddg=)
async function search(query, limit = 6) {
  const html = await (await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=br-pt`, {
    headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000),
  })).text();
  const results = [];
  const blocks = html.split('class="result results_links').slice(1);
  for (const b of blocks) {
    const a = b.match(/class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    let url = decodeEntities(a[1]);
    const wrapped = url.match(/[?&]uddg=([^&]+)/);
    if (wrapped) url = decodeURIComponent(wrapped[1]);
    if (url.startsWith('//')) url = 'https:' + url;
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue; // anúncios
    const snippet = (b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/) || [])[1] || '';
    results.push({ title: stripTags(a[2]), url, host: hostOf(url), snippet: stripTags(snippet) });
    if (results.length >= limit) break;
  }
  return results;
}

// Baixa uma página e extrai o texto principal (sem menus, rodapés, scripts)
async function fetchPage(url, maxChars = 6000) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' },
    redirect: 'follow', signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (!/html|text\/plain/.test(type)) throw new Error(`não é uma página (${type.split(';')[0]})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 4 * 1024 * 1024) throw new Error('página grande demais');
  // Respeita o charset (alguns sites brasileiros ainda usam ISO-8859-1)
  let charset = (type.match(/charset=([\w-]+)/i) || [])[1];
  let html = buf.toString('latin1');
  if (!charset) charset = (html.match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1] || 'utf-8';
  try { html = new TextDecoder(charset.toLowerCase()).decode(buf); } catch { html = buf.toString('utf8'); }

  const meta = (name) => decodeEntities((html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']*)`, 'i')) || [])[1] || '');
  const title = meta('og:title') || stripTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '') || hostOf(url);

  let body = html
    .replace(/<(script|style|noscript|svg|nav|footer|header|aside|form|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  // Prefere o conteúdo de <article>/<main> quando existir
  const main = body.match(/<article[\s\S]*?<\/article>/i) || body.match(/<main[\s\S]*?<\/main>/i);
  if (main && stripTags(main[0]).length > 400) body = main[0];
  const text = decodeEntities(body
    .replace(/<\/(p|div|h[1-6]|li|tr|br|section)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l.length > 40) // descarta migalhas de menu
    .join('\n');

  return {
    url: res.url || url, host: hostOf(res.url || url), title,
    description: meta('og:description') || meta('description'),
    image: meta('og:image'),
    text: text.slice(0, maxChars),
    chars: text.length,
  };
}

// Wikipédia em português: resumo + foto (para os cards de "quem é / o que é")
async function wikipedia(topic) {
  const headers = { 'User-Agent': 'JARVIS/2.0 (assistente pessoal)' };
  const found = await (await fetch(`https://pt.wikipedia.org/w/rest.php/v1/search/title?q=${encodeURIComponent(topic)}&limit=1`, { headers, signal: AbortSignal.timeout(8000) })).json();
  const key = found.pages?.[0]?.key;
  if (!key) return null;
  const s = await (await fetch(`https://pt.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(key)}`, { headers, signal: AbortSignal.timeout(8000) })).json();
  if (!s.extract) return null;
  return {
    title: s.title, description: s.description || '', extract: s.extract,
    image: s.originalimage?.source || s.thumbnail?.source || null,
    url: s.content_urls?.desktop?.page || `https://pt.wikipedia.org/wiki/${key}`,
  };
}

// ---------------------------------------------------------------- pacotes (npm / PyPI) e GitHub

async function github(repoUrl, token) {
  const m = (repoUrl || '').match(/github\.com[/:]([^/]+)\/([^/#?.]+)/);
  if (!m) return null;
  const headers = { 'User-Agent': 'jarvis', Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}`, { headers, signal: AbortSignal.timeout(8000) });
  if (!r.ok) return null;
  const g = await r.json();
  return { repo: g.full_name, stars: g.stargazers_count, forks: g.forks_count, openIssues: g.open_issues_count, pushedAt: g.pushed_at, license: g.license?.spdx_id, url: g.html_url };
}

async function npmPackage(name, token) {
  const id = name.trim().toLowerCase().replace(/\s+/g, '-');
  const r = await fetch(`https://registry.npmjs.org/${encodeURIComponent(id).replace('%40', '@')}`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) return null;
  const p = await r.json();
  const latest = p['dist-tags']?.latest;
  const [week, range] = await Promise.all([
    fetch(`https://api.npmjs.org/downloads/point/last-week/${id}`).then((x) => x.json()).catch(() => ({})),
    fetch(`https://api.npmjs.org/downloads/range/last-year/${id}`).then((x) => x.json()).catch(() => ({})),
  ]);
  // downloads por mês (últimos 12 meses)
  const monthly = {};
  for (const d of range.downloads || []) { const k = d.day.slice(0, 7); monthly[k] = (monthly[k] || 0) + d.downloads; }
  const repoUrl = typeof p.repository === 'string' ? p.repository : p.repository?.url;
  return {
    ecosystem: 'npm', name: p.name, version: latest, description: p.description, license: p.license,
    lastPublish: p.time?.[latest], created: p.time?.created, weeklyDownloads: week.downloads ?? null,
    monthly: Object.entries(monthly).sort().slice(-12),
    github: await github(repoUrl, token).catch(() => null),
    url: `https://www.npmjs.com/package/${p.name}`,
  };
}

async function pypiPackage(name, token) {
  const id = name.trim().toLowerCase().replace(/\s+/g, '-');
  const r = await fetch(`https://pypi.org/pypi/${encodeURIComponent(id)}/json`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) return null;
  const p = await r.json();
  const urls = Object.values(p.info.project_urls || {}).concat(p.info.home_page || []);
  const repoUrl = urls.find((u) => /github\.com/.test(u || ''));
  const files = p.urls || [];
  const stats = await fetch(`https://pypistats.org/api/packages/${id}/recent`).then((x) => (x.ok ? x.json() : null)).catch(() => null);
  return {
    ecosystem: 'pypi', name: p.info.name, version: p.info.version, description: p.info.summary, license: p.info.license?.slice(0, 40),
    lastPublish: files[0]?.upload_time_iso_8601 || null, weeklyDownloads: stats?.data?.last_week ?? null, monthly: [],
    github: await github(repoUrl, token).catch(() => null),
    url: `https://pypi.org/project/${p.info.name}/`,
  };
}

module.exports = { search, fetchPage, wikipedia, npmPackage, pypiPackage, github, hostOf };
