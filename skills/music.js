// YouTube Music: tocar, controlar e consultar o que está tocando.

const normalize = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w ]+/g, ' ').trim();

// Escolhe a playlist da biblioteca cujo nome mais se parece com o pedido
function matchPlaylist(playlists, name) {
  const target = normalize(name);
  if (!target) return null;
  const words = target.split(/\s+/);
  let best = null, bestScore = 0;
  for (const p of playlists) {
    const title = normalize(p.title);
    let score = title === target ? 100 : title.includes(target) || target.includes(title) ? 50 : 0;
    score += words.filter((w) => w.length > 1 && title.includes(w)).length * 10;
    if (score > bestScore) { best = p; bestScore = score; }
  }
  return bestScore >= 10 ? best : null;
}

function endpointFor(item) {
  if (item.kind === 'song' || item.kind === 'video') {
    return { watchEndpoint: { videoId: item.videoId, playlistId: `RDAMVM${item.videoId}` } };
  }
  if (item.playlistId) return { watchEndpoint: { playlistId: item.playlistId } };
  if (item.videoId) return { watchEndpoint: { videoId: item.videoId } };
  return null;
}

function describe(item) {
  return item.subtitle ? `${item.title} (${item.subtitle})` : item.title;
}

module.exports = {
  name: 'music',
  tools: [
    {
      name: 'music_play',
      description: 'Toca música no YouTube Music do usuário. Use para qualquer pedido de tocar/ouvir/colocar música, artista, álbum, playlist, gênero ou clima ("algo pra programar", "lofi", "rock anos 2000").',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'O que tocar: nome da música, artista, álbum, playlist, gênero ou clima. Vazio para "minhas curtidas".' },
          kind: {
            type: 'string',
            enum: ['song', 'artist', 'album', 'playlist', 'my_playlist', 'liked', 'any'],
            description: 'song=música específica; artist=rádio do artista; album; playlist=playlist pública (gênero/clima); my_playlist=playlist da biblioteca do usuário; liked=músicas curtidas; any=não sei',
          },
        },
        required: ['kind'],
      },
      async run({ query = '', kind = 'any' }, ctx) {
        const ytm = ctx.ytm;
        await ytm.ensure();

        // Link do YouTube / YouTube Music: toca direto (música, playlist ou os dois)
        const link = query.match(/(?:youtube\.com|youtu\.be)\/\S+/i);
        if (link) {
          const url = new URL(/^https?:/.test(query.trim()) ? query.trim() : `https://${link[0]}`);
          const videoId = url.searchParams.get('v') || (url.hostname === 'youtu.be' ? url.pathname.slice(1) : null);
          const playlistId = url.searchParams.get('list');
          if (!videoId && !playlistId) return { ok: false, error: 'Não reconheci esse link do YouTube' };
          await ytm.playEndpoint({ watchEndpoint: { ...(videoId ? { videoId } : {}), playlistId: playlistId || `RDAMVM${videoId}` } });
          await new Promise((r) => setTimeout(r, 1500));
          const now = await ytm.nowPlaying().catch(() => null);
          return { ok: true, playing: now ? `${now.title} - ${now.artist}` : 'link do YouTube Music' };
        }

        if (kind === 'liked') {
          await ytm.playEndpoint({ watchEndpoint: { playlistId: 'LM' } });
          return { ok: true, playing: 'Músicas que você curtiu' };
        }

        if (kind === 'my_playlist') {
          const playlists = await ytm.libraryPlaylists();
          const p = matchPlaylist(playlists, query);
          if (!p) return { ok: false, error: `Playlist "${query}" não encontrada na biblioteca`, playlists: playlists.map((x) => x.title) };
          await ytm.playEndpoint({ watchEndpoint: { playlistId: p.id } });
          return { ok: true, playing: `playlist ${p.title}` };
        }

        const searchQuery = kind === 'playlist' && !/playlist/i.test(query) ? `${query} playlist` : query;
        const results = await ytm.search(searchQuery);
        const wanted = { song: ['song', 'video'], artist: ['artist'], album: ['album'], playlist: ['playlist'] }[kind];
        let pick = wanted ? results.find((r) => wanted.includes(r.kind) && endpointFor(r)) : null;
        // "any": o primeiro resultado (o destaque costuma ser o melhor palpite)
        if (!pick) pick = results.find((r) => ['song', 'video', 'artist', 'album', 'playlist'].includes(r.kind) && endpointFor(r));
        if (!pick) return { ok: false, error: `Nada encontrado para "${query}"` };

        await ytm.playEndpoint(endpointFor(pick));
        const label = { song: 'música', video: 'vídeo', artist: 'rádio do artista', album: 'álbum', playlist: 'playlist' }[pick.kind];
        return { ok: true, playing: `${label}: ${describe(pick)}` };
      },
    },
    {
      name: 'music_control',
      description: 'Controla a reprodução do YouTube Music: pausar, continuar, próxima, anterior, curtir, descurtir, aleatório, repetir.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['pause', 'resume', 'toggle', 'next', 'previous', 'like', 'dislike', 'shuffle', 'repeat'] },
        },
        required: ['action'],
      },
      async run({ action }, ctx) {
        const ytm = ctx.ytm;
        await ytm.ensure();
        const routes = {
          pause: '/pause', resume: '/play', toggle: '/toggle-play', next: '/next', previous: '/previous',
          like: '/like', dislike: '/dislike', shuffle: '/shuffle',
        };
        // Restaura o volume antes de pausar, para a música não voltar baixinha depois
        if (action === 'pause') await ytm.unduck();
        if (action === 'repeat') await ytm.api('POST', '/switch-repeat', { iteration: 1 });
        else await ytm.api('POST', routes[action]);
        if (action === 'next' || action === 'previous') {
          await new Promise((r) => setTimeout(r, 1200));
          const s = await ytm.nowPlaying();
          return { ok: true, now_playing: s && `${s.title} - ${s.artist}` };
        }
        return { ok: true };
      },
    },
    {
      name: 'music_now_playing',
      description: 'Diz qual música está tocando agora no YouTube Music.',
      parameters: { type: 'object', properties: {} },
      async run(_, ctx) {
        await ctx.ytm.ensure();
        const s = await ctx.ytm.nowPlaying();
        if (!s) return { playing: false };
        return { title: s.title, artist: s.artist, album: s.album, paused: s.paused };
      },
    },
    {
      name: 'music_volume',
      description: 'Ajusta o volume do YouTube Music (não o volume do Windows).',
      parameters: {
        type: 'object',
        properties: {
          level: { type: 'number', description: 'Volume absoluto 0-100' },
          change: { type: 'string', enum: ['up', 'down'], description: 'Aumentar/diminuir um pouco' },
        },
      },
      async run({ level, change }, ctx) {
        const ytm = ctx.ytm;
        await ytm.ensure();
        const base = ytm.duckedFrom ?? (await ytm.getVolume());
        ytm.forgetDuck();
        const target = typeof level === 'number' ? level : base + (change === 'down' ? -15 : 15);
        await ytm.setVolume(target);
        return { ok: true, volume: Math.max(0, Math.min(100, Math.round(target))) };
      },
    },
    {
      name: 'music_queue_add',
      description: 'Adiciona uma música para tocar em seguida, sem interromper a atual.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Música a adicionar' } },
        required: ['query'],
      },
      async run({ query }, ctx) {
        const ytm = ctx.ytm;
        await ytm.ensure();
        const pick = (await ytm.search(query)).find((r) => (r.kind === 'song' || r.kind === 'video') && r.videoId);
        if (!pick) return { ok: false, error: 'Música não encontrada' };
        await ytm.api('POST', '/queue', { videoId: pick.videoId, insertPosition: 'INSERT_AFTER_CURRENT_VIDEO' });
        return { ok: true, queued: describe(pick) };
      },
    },
    {
      name: 'music_list_playlists',
      description: 'Lista as playlists da biblioteca do usuário no YouTube Music.',
      parameters: { type: 'object', properties: {} },
      async run(_, ctx) {
        await ctx.ytm.ensure();
        const list = await ctx.ytm.libraryPlaylists();
        return { playlists: list.map((p) => p.title) };
      },
    },
  ],
};
