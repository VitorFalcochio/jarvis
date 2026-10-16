// Cliente do YouTube Music Desktop (Pear Desktop, github.com/pear-devs/pear-desktop).
//  - API REST do plugin "api-server" (127.0.0.1:26538): controles, música atual, volume, fila, busca
//  - Chrome DevTools Protocol (127.0.0.1:9229): navegar dentro da página para tocar playlists,
//    álbuns, rádios e ler a biblioteca do usuário (a API REST não tem isso)
const { spawn } = require('child_process');
const fs = require('fs');
const WebSocket = require('ws');

const API = 'http://127.0.0.1:26538';
const CDP_PORT = 9229;
const DEFAULT_EXE = 'E:\\Apps\\YouTubeMusic\\YouTube Music.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class YTMusic {
  constructor({ getToken, setToken, exePath }) {
    this.getToken = getToken;
    this.setToken = setToken;
    this.exePath = exePath || DEFAULT_EXE;
    this.duckedFrom = null;
  }

  // ---------------------------------------------------------------- processo

  async isApiUp() {
    try {
      const r = await fetch(`${API}/api/v1/song`, { signal: AbortSignal.timeout(1500) });
      return r.status !== 0;
    } catch { return false; }
  }

  async isCdpUp() {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
      return r.ok;
    } catch { return false; }
  }

  launch() {
    if (!fs.existsSync(this.exePath)) throw new Error(`YouTube Music não encontrado em ${this.exePath}`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    spawn(this.exePath, [`--remote-debugging-port=${CDP_PORT}`, '--remote-debugging-address=127.0.0.1'], {
      detached: true, stdio: 'ignore', env,
    }).unref();
  }

  // Garante que o app está aberto, com a página carregada e autorizado
  async ensure() {
    if (!(await this.isApiUp())) {
      this.launch();
      for (let i = 0; i < 40 && !(await this.isApiUp()); i++) await sleep(500);
      if (!(await this.isApiUp())) throw new Error('O YouTube Music não respondeu ao abrir');
      await this.waitPageReady();
    }
    if (!this.getToken()) await this.authorize();
  }

  async waitPageReady() {
    for (let i = 0; i < 30; i++) {
      try {
        if (await this.cdpEval(`!!document.querySelector('ytmusic-app')?.networkManager && !!document.querySelector('ytmusic-search-box')`)) return;
      } catch {}
      await sleep(500);
    }
  }

  // Abre um diálogo no YouTube Music pedindo para o usuário permitir o JARVIS
  async authorize() {
    const r = await fetch(`${API}/auth/jarvis`, { method: 'POST', signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error('Acesso ao YouTube Music negado');
    const { accessToken } = await r.json();
    this.setToken(accessToken);
  }

  // ---------------------------------------------------------------- API REST

  // reauth=false para chamadas em segundo plano: nunca abrir o diálogo de autorização sem o usuário pedir
  async api(method, path, body, { reauth = true } = {}) {
    const call = () => fetch(`${API}/api/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.getToken()}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    let r = await call();
    if (r.status === 401 && reauth) { await this.authorize(); r = await call(); }
    if (!r.ok) throw new Error(`YouTube Music API ${r.status}`);
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  }

  async nowPlaying(opts) {
    const s = await this.api('GET', '/song', null, opts);
    if (!s || !s.title) return null;
    return {
      title: s.title, artist: s.artist, album: s.album, paused: s.isPaused,
      elapsed: s.elapsedSeconds, duration: s.songDuration, videoId: s.videoId, cover: s.imageSrc,
    };
  }

  // Fila atual, já simplificada para a tela de Música
  async getQueue() {
    const q = await this.api('GET', '/queue', null, { reauth: false });
    return (q?.items || []).map((item, index) => {
      const r = item.playlistPanelVideoRenderer || item.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer;
      if (!r) return null;
      return {
        index,
        title: r.title?.runs?.map((x) => x.text).join('') || '',
        artist: r.shortBylineText?.runs?.map((x) => x.text).join('') || '',
        length: r.lengthText?.runs?.[0]?.text || '',
        thumb: (r.thumbnail?.thumbnails || []).slice(-1)[0]?.url || '',
        selected: !!r.selected,
      };
    }).filter(Boolean);
  }

  async getVolume(opts) { return (await this.api('GET', '/volume', null, opts))?.state ?? 100; }
  async setVolume(v, opts) {
    const volume = Math.max(0, Math.min(100, Math.round(v)));
    // O POST /volume da API responde OK mas não muda nada (v3.12.0); pelo player funciona
    if (await this.isCdpUp()) {
      return this.cdpEval(`(() => { const p = document.querySelector('#movie_player'); p.setVolume(${volume}); if (${volume} > 0) p.unMute(); })()`);
    }
    return this.api('POST', '/volume', { volume }, opts);
  }

  // Abaixa a música enquanto o JARVIS ouve/fala
  async duck() {
    if (this.duckedFrom !== null) return;
    try {
      const bg = { reauth: false };
      const s = await this.api('GET', '/song', null, bg);
      if (!s || s.isPaused) return;
      const vol = await this.getVolume(bg);
      this.duckedFrom = vol;
      await this.setVolume(Math.min(vol, Math.max(8, vol * 0.2)), bg);
    } catch { this.duckedFrom = null; }
  }

  async unduck() {
    if (this.duckedFrom === null) return;
    const vol = this.duckedFrom;
    this.duckedFrom = null;
    try { await this.setVolume(vol, { reauth: false }); } catch {}
  }

  // Quando o usuário mexe no volume/pausa por voz, não restauramos o volume antigo
  forgetDuck() { this.duckedFrom = null; }

  // ---------------------------------------------------------------- CDP

  async cdpEval(expression) {
    const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
    const page = targets.find((t) => t.type === 'page' && t.url.includes('music.youtube.com'));
    if (!page) throw new Error('Página do YouTube Music não encontrada');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    try {
      await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
      const reply = await new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error('CDP timeout')), 15000);
        ws.on('message', (m) => {
          const d = JSON.parse(m);
          if (d.id === 1) { clearTimeout(timer); res(d); }
        });
        ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
      });
      if (reply.result?.exceptionDetails) throw new Error(reply.result.exceptionDetails.exception?.description || 'erro no YouTube Music');
      return reply.result?.result?.value;
    } finally {
      ws.close();
    }
  }

  // Navega dentro do app (sem recarregar) para um endpoint do YouTube Music
  async playEndpoint(endpoint) {
    if (await this.isCdpUp()) {
      await this.cdpEval(`(() => {
        document.querySelector('ytmusic-app').dispatchEvent(new CustomEvent('yt-navigate', {
          bubbles: true, composed: true, detail: { endpoint: ${JSON.stringify(endpoint)} } }));
      })()`);
      return true;
    }
    // Sem CDP (app aberto manualmente sem a flag): só dá para tocar músicas soltas via fila
    const videoId = endpoint.watchEndpoint?.videoId;
    if (!videoId) throw new Error('Para tocar playlists, o YouTube Music precisa ser aberto pelo JARVIS');
    await this.api('POST', '/queue', { videoId, insertPosition: 'INSERT_AFTER_CURRENT_VIDEO' });
    await sleep(700);
    const q = await this.api('GET', '/queue');
    const idx = (q.items || []).findIndex((it) => JSON.stringify(it).includes(`"videoId":"${videoId}"`));
    if (idx >= 0) await this.api('PATCH', '/queue', { index: idx });
    await this.api('POST', '/play');
    return true;
  }

  // ---------------------------------------------------------------- busca e biblioteca

  async search(query) {
    const raw = await this.api('POST', '/search', { query });
    return parseSearch(raw);
  }

  async libraryPlaylists() {
    return this.cdpEval(`(async () => {
      const app = document.querySelector('ytmusic-app');
      const r = await app.networkManager.fetch('/browse', { browseId: 'FEmusic_liked_playlists' });
      const out = [];
      (function walk(o) {
        if (!o || typeof o !== 'object') return;
        for (const k in o) {
          if (k === 'musicTwoRowItemRenderer') {
            const c = o[k];
            const browseId = c.navigationEndpoint?.browseEndpoint?.browseId || '';
            const id = browseId.startsWith('VL') ? browseId.slice(2) : (JSON.stringify(c).match(/"playlistId":"([^"]+)/) || [])[1];
            const title = (c.title?.runs || []).map((x) => x.text).join('');
            if (id) out.push({ title, id });
          }
          walk(o[k]);
        }
      })(r);
      return out;
    })()`);
  }
}

// Converte a resposta crua da busca do YouTube Music em uma lista simples
function parseSearch(raw) {
  const text = (r) => (r?.runs || []).map((x) => x.text).join('');
  const kindOf = (label) => {
    const l = (label || '').toLowerCase();
    if (/^(música|song)/.test(l)) return 'song';
    if (/^(vídeo|video)/.test(l)) return 'video';
    if (/^(artista|artist)/.test(l)) return 'artist';
    if (/^(álbum|album|single|ep)/.test(l)) return 'album';
    if (/^playlist/.test(l)) return 'playlist';
    if (/^(podcast|episódio|episode)/.test(l)) return 'podcast';
    return 'other';
  };
  const results = [];
  const seen = new Set();
  const push = (item) => {
    const key = item.videoId || item.playlistId || item.title;
    if (!key || seen.has(key)) return;
    seen.add(key);
    results.push(item);
  };

  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    for (const k in o) {
      const c = o[k];
      if (k === 'musicCardShelfRenderer') {
        const json = JSON.stringify(c.title);
        const sub = text(c.subtitle);
        const [label, ...rest] = sub.split(' • ');
        push({
          kind: kindOf(label), top: true, title: text(c.title), subtitle: rest.join(' • '),
          videoId: (json.match(/"videoId":"([^"]+)/) || [])[1],
          playlistId: (JSON.stringify(c.buttons || c).match(/"playlistId":"([^"]+)/) || [])[1],
          browseId: (json.match(/"browseId":"([^"]+)/) || [])[1],
        });
      }
      if (k === 'musicResponsiveListItemRenderer') {
        const cols = (c.flexColumns || []).map((f) => text(f.musicResponsiveListItemFlexColumnRenderer?.text));
        const json = JSON.stringify(c);
        const [label, ...rest] = (cols[1] || '').split(' • ');
        let kind = kindOf(label);
        if (kind === 'other' && c.playlistItemData?.videoId) kind = 'song';
        push({
          kind, title: cols[0], subtitle: kind === 'other' ? cols[1] : rest.join(' • '),
          videoId: c.playlistItemData?.videoId || (json.match(/"videoId":"([^"]+)/) || [])[1],
          playlistId: (json.match(/"playlistId":"([^"]+)/) || [])[1],
          browseId: c.navigationEndpoint?.browseEndpoint?.browseId,
        });
      }
      walk(c);
    }
  })(raw);
  return results;
}

module.exports = { YTMusic, parseSearch };
