// Letras sincronizadas pelo LRCLIB (lrclib.net, gratuito e sem chave).
const UA = { 'User-Agent': 'JARVIS/2.0 (assistente pessoal)' };
const cache = new Map();

async function get(url, tries = 2) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(8000) });
    if (r.status === 503 && i < tries - 1) { await new Promise((res) => setTimeout(res, 1200)); continue; } // servidor ocupado
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`LRCLIB ${r.status}`);
    return r.json();
  }
  return null;
}

// "[01:23.45] texto" → [{ time: 83.45, text }]
function parseLrc(lrc) {
  const lines = [];
  for (const raw of (lrc || '').split('\n')) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const s of stamps) lines.push({ time: Number(s[1]) * 60 + Number(s[2]), text });
  }
  return lines.sort((a, b) => a.time - b.time);
}

// Tira sufixos que atrapalham a busca: "(Ao Vivo)", "- Remastered 2011", "feat. X"
const clean = (s) => (s || '').replace(/\s*[([].*?(ao vivo|live|remaster|version|vers[aã]o|feat|ft\.|official|lyric|video)[^)\]]*[)\]]/gi, '').replace(/\s+-\s+.*remaster.*$/i, '').trim();

async function findLyrics({ title, artist, album, duration }) {
  const key = `${title}|${artist}`.toLowerCase();
  if (cache.has(key)) return cache.get(key);

  const t = clean(title), a = (artist || '').split(/,| e | & | x /i)[0].trim();
  let hit = await get(`https://lrclib.net/api/get?${new URLSearchParams({ track_name: t, artist_name: a, ...(album ? { album_name: album } : {}), ...(duration ? { duration: String(Math.round(duration)) } : {}) })}`).catch(() => null);

  if (!hit?.syncedLyrics) {
    const results = await get(`https://lrclib.net/api/search?q=${encodeURIComponent(`${t} ${a}`)}`).catch(() => []);
    const scored = (results || [])
      .filter((r) => r.syncedLyrics || r.plainLyrics)
      .map((r) => ({ r, score: (r.syncedLyrics ? 10 : 0) - (duration && r.duration ? Math.min(10, Math.abs(r.duration - duration)) : 0) }))
      .sort((x, y) => y.score - x.score);
    hit = scored[0]?.r || hit;
  }

  const result = hit
    ? { synced: !!hit.syncedLyrics, instrumental: !!hit.instrumental, lines: hit.syncedLyrics ? parseLrc(hit.syncedLyrics) : (hit.plainLyrics || '').split('\n').map((text) => ({ time: null, text })) }
    : null;
  cache.set(key, result);
  return result;
}

module.exports = { findLyrics, parseLrc };
