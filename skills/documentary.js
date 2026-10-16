// Modo documentário (Live Experience Engine v0): o "diretor" (modelo) escreve um roteiro em JSON Lines,
// um beat por linha, escolhendo entre componentes visuais fixos. Cada beat ganha imagem (Wikipedia) e
// narração própria (com o instante de cada palavra) e vai para o player do HUD assim que fica pronto.

const UA = { 'User-Agent': 'JARVIS/2.0 (assistente pessoal; uso local)' };
const COMPONENTS = ['capitulo', 'ano', 'imagem', 'frase', 'timeline', 'mapa', 'galeria', 'numero', 'manchete', 'comparacao', 'lista', 'quiz'];
const LETTERS = ['A', 'B', 'C'];
const MOODS = ['epico', 'misterioso', 'melancolico', 'tecnologico', 'esperancoso'];
const str = (v, max = 300) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max));
const clamp = (v, lo, hi, def) => (isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : def);

let current = null; // { id, abort }

const MAP_DOC = `- {"tipo":"mapa","lugar":"Chernobyl, Ucrânia","coords":[51.27,30.22],"zoom":9,"pitch":40,"marcadores":[{"rotulo":"Usina Nuclear","coords":[51.389,30.099]}],"raio_km":30,"rotulo_raio":"Zona de exclusão","rota":[{"rotulo":"Pripyat","coords":[51.405,30.057]},{"rotulo":"Kiev","coords":[50.45,30.52]}],"destacar":"Ucrânia"}
  → MAPA VIVO (globo 3D): a câmera voa do enquadramento anterior até "lugar". Use para onde as coisas ficam/aconteceram, rotas, territórios e distâncias.
  coords = [latitude, longitude] (sempre que souber). zoom: 2 continente, 4 país, 6 estado/região, 9 cidade, 12 bairro, 15 prédio. pitch 0 a 60 (inclina a câmera; bom de perto).
  Opcionais: "marcadores" (até 4), "raio_km" + "rotulo_raio" (círculo em volta do primeiro marcador ou do lugar), "rota" (2 a 6 pontos em ordem, desenhada animada), "destacar" (nome de país/estado/cidade para contornar a área).
  Mapas seguidos formam um movimento contínuo de câmera: vá do amplo para o detalhe.`;

function mapPrompt(question, beats) {
  return `Você é o DIRETOR de uma explicação visual no MAPA VIVO do J.A.R.V.I.S. (voz masculina, elegante, português do Brasil).
Pedido do usuário: "${question}"
Tamanho: ${beats} beats.

Responda SOMENTE com JSON Lines: um objeto JSON completo por linha. Nada de markdown, nada de texto fora do JSON.
Linha 1: {"titulo":"nome curto do lugar/tema","subtitulo":"uma linha de contexto","clima":"nenhum"}
Demais linhas, um beat por linha:
{"cena":"nome curto","fala":"1 a 2 frases","visual":{...},"pausa_antes":0,"pausa_depois":0.3,"destaques":["palavra"],"entidades":["lugar ou pessoa citado"]}

Componentes:
${MAP_DOC}
- {"tipo":"imagem","busca":"título exato de artigo da Wikipedia em português","legenda":"..."} → no máximo 1 ou 2, para mostrar como o lugar é.
- {"tipo":"ano","texto":"1986","legenda":"..."} → só se houver uma data marcante (com "escurecer":true e "pausa_antes":0.6).

Direção:
- Responda o pedido de verdade: primeiro ONDE fica (comece amplo, zoom 2 a 4, destacando o país/região), depois aproxime até o lugar e mostre o contexto (raio, rota, lugares próximos, distâncias).
- Quase todos os beats com "mapa". Tom de JARVIS explicando, direto e elegante, não de documentário épico.
- Só fatos e coordenadas que você conhece bem. Nunca invente.`;
}

function directorPrompt(topic, beats) {
  return `Você é o DIRETOR de um minidocumentário narrado por J.A.R.V.I.S. (voz masculina, elegante, português do Brasil) sobre: "${topic}".
Tamanho: escreva ${beats} beats (≈ ${Math.round(beats * 9 / 60)} minutos de narração). Conte as linhas: não pare antes de chegar perto de ${beats}.

Responda SOMENTE com JSON Lines: um objeto JSON completo por linha. Nada de markdown, nada de texto fora do JSON, nada de vírgula entre as linhas.
Linha 1: {"titulo":"título curto e forte","subtitulo":"uma linha de contexto","clima":"epico"}
("clima" define a trilha sonora: epico | misterioso | melancolico | tecnologico | esperancoso)
Demais linhas, um beat por linha:
{"cena":"nome do capítulo","fala":"narração do beat (1 a 2 frases)","visual":{...},"pausa_antes":0,"pausa_depois":0.4,"escurecer":false,"destaques":["palavra"],"entidades":["pessoa ou lugar citado"]}

Componentes de "visual" (escolha o que melhor serve àquela fala):
- {"tipo":"capitulo","numero":1,"titulo":"..."} → abre cada capítulo novo. Fala curta ou vazia.
- {"tipo":"ano","texto":"1822","legenda":"Independência"} → data decisiva. Use com "escurecer":true e "pausa_antes":0.8 (silêncio dramático antes do número aparecer).
- {"tipo":"imagem","busca":"Pedro I do Brasil","legenda":"Dom Pedro I"} → pessoas, lugares, pinturas, mapas, objetos. "busca" = título EXATO de um artigo da Wikipedia em português.
- {"tipo":"galeria","buscas":["Pedro I do Brasil","Maria Leopoldina de Áustria","José Bonifácio de Andrada e Silva"],"legenda":"Os protagonistas"} → 2 a 4 fotos de uma vez (pessoas de um mesmo grupo, lugares, obras). "buscas" = títulos EXATOS de artigos da Wikipedia.
- {"tipo":"comparacao","antes":{"busca":"artigo da Wikipedia","rotulo":"1900"},"depois":{"busca":"outro artigo","rotulo":"Hoje"}} → antes/depois ou duas coisas lado a lado.
- {"tipo":"numero","valor":3500000,"prefixo":"","sufixo":"de pessoas","legenda":"escravizados trazidos ao Brasil"} → um número marcante (contador animado). "valor" só com número real e conhecido.
- {"tipo":"manchete","data":"7 de setembro de 1822","texto":"BRASIL PROCLAMA SUA INDEPENDÊNCIA","busca":"artigo da Wikipedia (opcional, vira a foto da página)"} → página de jornal girando, estilo cinema, para um ACONTECIMENTO. Manchete curta (até 8 palavras), resumindo o fato; não cite nome de jornal real.
- {"tipo":"lista","titulo":"Os 3 motivos","itens":["...","...","..."]} → 3 a 5 itens curtos (até 6 palavras cada) que entram um a um enquanto você narra.
- {"tipo":"frase","texto":"Independência ou morte!","autor":"Dom Pedro I"} → citação famosa ou ideia central, curta.
- {"tipo":"timeline","itens":[{"data":"1500","titulo":"Chegada dos portugueses"}],"atual":0} → panorama de 3 a 6 marcos; "atual" = índice em destaque.
${MAP_DOC}

Camadas extras do beat (campos no MESMO nível de "fala", aparecem POR CIMA do visual, junto com a fala):
- "etiqueta":{"nome":"Dom Pedro I","info":"Imperador do Brasil · 1798–1834"} → crédito de telejornal. OBRIGATÓRIA na primeira vez que cada pessoa importante aparece (geralmente num beat de "imagem" dela).
- "curiosidade":"fato curto e surpreendente (até 110 caracteres)" → cartão "VOCÊ SABIA?". OBRIGATÓRIA em exatamente 2 beats do documentário (fatos verdadeiros e pouco conhecidos).
- "carimbo":"Rio de Janeiro · 1822" → local e data no canto. Use em 2 a 3 beats, quando a cena muda de lugar ou de época.
Exemplo de beat com camadas:
{"cena":"O príncipe","fala":"Pedro tinha apenas 23 anos quando desafiou a própria coroa.","visual":{"tipo":"imagem","busca":"Pedro I do Brasil","legenda":"Dom Pedro I"},"etiqueta":{"nome":"Dom Pedro I","info":"Príncipe regente · 1798–1834"},"carimbo":"São Paulo · 1822","curiosidade":"Ele compôs a música do Hino da Independência.","destaques":["23 anos"],"entidades":["Pedro I"]}

Última linha (obrigatória): um quiz sobre o documentário:
{"cena":"Pergunta rápida","fala":"","visual":{"tipo":"quiz","pergunta":"pergunta curta sobre algo que foi contado","opcoes":["opção 1","opção 2","opção 3"],"correta":0,"explicacao":"1 frase explicando a resposta"}}
(3 opções curtas, só UMA certa; "correta" = índice 0, 1 ou 2 da certa; varie a posição da certa.)

Direção:
- Comece com um gancho forte (pode ser um "ano" ou uma "imagem"), depois "capitulo" 1.
- 3 a 5 capítulos. Varie os componentes: imagens são a base, mas use também galeria, numero, lista, comparacao e manchete onde fizerem sentido (pelo menos 3 tipos diferentes desses no total); use "mapa" quando o ONDE importa (rotas, territórios, batalhas, viagens); não repita o mesmo componente mais de 3 vezes seguidas.
- Falas curtas, ritmo de documentário, frases de impacto, tom sério. "destaques": 1 a 2 palavras da própria fala que merecem ênfase.
- Antes do quiz, feche com uma frase memorável ("frase") e um encerramento.
- Só fatos conhecidos e verificáveis. Nunca invente citações, datas, números ou manchetes de jornais reais.`;
}

function sanitizeVisual(v) {
  if (!v || !COMPONENTS.includes(v.tipo)) return null;
  switch (v.tipo) {
    case 'capitulo': return { tipo: 'capitulo', numero: clamp(v.numero, 1, 20, 1) | 0, titulo: str(v.titulo, 80) };
    case 'ano': return str(v.texto, 12) ? { tipo: 'ano', texto: str(v.texto, 12), legenda: str(v.legenda, 80) } : null;
    case 'imagem': return str(v.busca) ? { tipo: 'imagem', busca: str(v.busca, 120), legenda: str(v.legenda, 120) } : null;
    case 'frase': return str(v.texto) ? { tipo: 'frase', texto: str(v.texto, 220), autor: str(v.autor, 60) } : null;
    case 'mapa': {
      const coords = (c) => (Array.isArray(c) && c.length === 2 && c.every((x) => isFinite(Number(x))) && Math.abs(c[0]) <= 90 && Math.abs(c[1]) <= 180 ? [Number(c[1]), Number(c[0])] : null);
      const point = (p) => (typeof p === 'string' ? { lugar: str(p, 100), rotulo: str(p, 50) } : p && typeof p === 'object' ? { lugar: str(p.lugar || p.rotulo, 100), rotulo: str(p.rotulo, 50), coords: coords(p.coords) } : null);
      const m = {
        tipo: 'mapa', lugar: str(v.lugar, 120), coords: coords(v.coords),
        zoom: v.zoom !== undefined && v.zoom !== null && isFinite(Number(v.zoom)) ? clamp(v.zoom, 1, 17, 5) : null,
        pitch: clamp(v.pitch, 0, 65, 0), bearing: clamp(v.bearing, -180, 180, 0),
        marcadores: (Array.isArray(v.marcadores) ? v.marcadores : []).slice(0, 4).map(point).filter((p) => p && (p.coords || p.lugar)),
        raioKm: isFinite(Number(v.raio_km)) ? clamp(v.raio_km, 0.1, 3000, 0) : 0, rotuloRaio: str(v.rotulo_raio, 50),
        rota: (Array.isArray(v.rota) ? v.rota : []).slice(0, 6).map(point).filter((p) => p && (p.coords || p.lugar)),
        destacar: str(v.destacar, 100),
      };
      return m.lugar || m.coords || m.marcadores.length ? m : null;
    }
    case 'timeline': {
      const itens = (Array.isArray(v.itens) ? v.itens : []).slice(0, 7).map((i) => ({ data: str(i?.data, 16), titulo: str(i?.titulo, 60) })).filter((i) => i.titulo);
      return itens.length >= 2 ? { tipo: 'timeline', itens, atual: clamp(v.atual, 0, itens.length - 1, 0) | 0 } : null;
    }
    case 'galeria': {
      const buscas = (Array.isArray(v.buscas) ? v.buscas : []).map((b) => str(b, 120)).filter(Boolean).slice(0, 4);
      if (buscas.length >= 2) return { tipo: 'galeria', buscas, legenda: str(v.legenda, 120) };
      return buscas.length ? { tipo: 'imagem', busca: buscas[0], legenda: str(v.legenda, 120) } : null;
    }
    case 'comparacao': {
      const side = (s) => (s && str(s.busca) ? { busca: str(s.busca, 120), rotulo: str(s.rotulo, 40) } : null);
      const antes = side(v.antes), depois = side(v.depois);
      return antes && depois ? { tipo: 'comparacao', antes, depois } : null;
    }
    case 'numero': {
      const valor = Number(String(v.valor ?? '').replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
      return isFinite(valor) && String(v.valor ?? '').trim() !== ''
        ? { tipo: 'numero', valor, prefixo: str(v.prefixo, 12), sufixo: str(v.sufixo, 40), legenda: str(v.legenda, 100) } : null;
    }
    case 'manchete':
      return str(v.texto) ? { tipo: 'manchete', texto: str(v.texto, 90), data: str(v.data, 40), busca: str(v.busca, 120) } : null;
    case 'lista': {
      const itens = (Array.isArray(v.itens) ? v.itens : []).map((i) => str(i, 70)).filter(Boolean).slice(0, 5);
      return itens.length >= 2 ? { tipo: 'lista', titulo: str(v.titulo, 70), itens } : null;
    }
    case 'quiz': {
      const opcoes = (Array.isArray(v.opcoes) ? v.opcoes : []).map((o) => str(o, 70)).filter(Boolean).slice(0, 3);
      const correta = Number(v.correta);
      if (!str(v.pergunta) || opcoes.length !== 3 || !(correta >= 0 && correta <= 2)) return null;
      return { tipo: 'quiz', pergunta: str(v.pergunta, 160), opcoes, correta: correta | 0, explicacao: str(v.explicacao, 240) };
    }
  }
  return null;
}

function sanitizeOverlays(b) {
  const out = {};
  if (b.etiqueta && str(b.etiqueta.nome)) out.etiqueta = { nome: str(b.etiqueta.nome, 50), info: str(b.etiqueta.info, 80) };
  if (str(b.curiosidade)) out.curiosidade = str(b.curiosidade, 140);
  if (str(b.carimbo)) out.carimbo = str(b.carimbo, 50);
  return out;
}

function sanitizeBeat(b) {
  if (!b || typeof b !== 'object') return null;
  const beat = {
    cena: str(b.cena, 80),
    fala: str(b.fala, 500),
    visual: sanitizeVisual(b.visual),
    pausaAntes: clamp(b.pausa_antes, 0, 3, 0),
    pausaDepois: clamp(b.pausa_depois, 0, 3, 0.35),
    escurecer: !!b.escurecer,
    destaques: (Array.isArray(b.destaques) ? b.destaques : []).slice(0, 4).map((d) => str(d, 40)).filter(Boolean),
    entidades: (Array.isArray(b.entidades) ? b.entidades : []).slice(0, 6).map((d) => str(d, 60)).filter(Boolean),
    ...sanitizeOverlays(b),
  };
  // o quiz narra a própria pergunta com as opções (o diretor deixa "fala" vazia)
  if (beat.visual?.tipo === 'quiz') {
    const q = beat.visual;
    beat.fala = `Pergunta rápida: ${q.pergunta} ${q.opcoes.map((o, i) => `${i === 2 ? 'Ou ' : ''}${LETTERS[i]}: ${o}.`).join(' ')}`;
    beat.pausaAntes = 0.6;
    beat.cena = beat.cena || 'Pergunta rápida';
  }
  return beat.fala || beat.visual ? beat : null;
}

// Fotos que não servem para um documentário: ícones, bandeiras, brasões, assinaturas, logos
const JUNK_IMAGE = /logo|icon|[íi]cone|flag|bandeira|bras[ãa]o|armas|coat[ _]of[ _]arms|seal|selo|signature|assinatura|symbol|s[íi]mbolo|emblem|commons-|wikipedia|wiktionary|disambig|question|edit-|padlock|cadeado|portal|stub|\.svg|\.gif/i;
// nome do arquivo sem prefixo de miniatura ("1920px-") e sem parâmetros: identifica a mesma foto em tamanhos diferentes
const fileKey = (url) => decodeURIComponent(url.split('?')[0].split('/').pop()).replace(/^\d+px-/, '').toLowerCase();
const words = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !/^(the|and|dos|das|del|von|van)$/.test(w));

// Consultas à Wikipedia. O roteiro chega em rajada e cada cena dispara várias buscas; a API responde 429
// ("muitas requisições") nessas rajadas. Então: no máximo 2 ao mesmo tempo, 250 ms entre o início de cada
// uma e, ao receber 429, TODAS esperam juntas o tempo que a Wikipedia pedir (Retry-After) antes de tentar de novo.
let wikiActive = 0;
let wikiNextAt = 0;     // horário mínimo para a próxima consulta começar
let wikiCooldown = 0;   // ninguém consulta antes disso (depois de um 429)
const wikiWaiting = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function wikiJson(url, timeout = 8000) {
  if (wikiActive >= 2) await new Promise((r) => wikiWaiting.push(r));
  wikiActive++;
  try {
    for (let attempt = 0; ; attempt++) {
      const start = Math.max(Date.now(), wikiNextAt, wikiCooldown);
      wikiNextAt = start + 250;
      if (start > Date.now()) await wait(start - Date.now());
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeout) });
      if (res.status === 429 && attempt < 4) {
        const after = Number(res.headers.get('retry-after'));
        wikiCooldown = Math.max(wikiCooldown, Date.now() + (after > 0 ? Math.min(after, 20) * 1000 : 2500 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`Wikipedia respondeu ${res.status}`);
      return await res.json();
    }
  } finally {
    wikiActive--;
    wikiWaiting.shift()?.();
  }
}

// Várias fotos de um assunto: a principal do artigo + as do Wikimedia Commons usadas nele (pt, depois en).
// Cache vale entre documentários (por 6 h); buscas que falharam não ficam guardadas.
const IMAGE_CACHE = new Map(); // assunto -> { at, job }
async function wikiImages(query) {
  const key = query.toLowerCase();
  const hit = IMAGE_CACHE.get(key);
  if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.job;
  const job = (async () => {
    for (const lang of ['pt', 'en']) {
      const api = `https://${lang}.wikipedia.org/w/api.php?format=json&action=query&redirects=1`;
      let page = null;
      for (const url of [
        `${api}&prop=pageimages&piprop=thumbnail&pithumbsize=1600&titles=${encodeURIComponent(query)}`,
        `${api}&prop=pageimages&piprop=thumbnail&pithumbsize=1600&generator=search&gsrlimit=1&gsrsearch=${encodeURIComponent(query)}`,
      ]) {
        try {
          const data = await wikiJson(url, 7000);
          page = Object.values(data?.query?.pages || {}).find((p) => p.pageid && !('missing' in p));
          if (page) break;
        } catch (e) { console.error('[doc] wikipedia:', e.message); }
      }
      if (!page) continue;
      const list = [];
      if (page.thumbnail?.source) list.push({ url: page.thumbnail.source, fonte: `Wikipedia · ${page.title}` });
      try {
        const url = `${api}&generator=images&gimlimit=40&prop=imageinfo&iiprop=url|mime|size&iiurlwidth=1600&titles=${encodeURIComponent(page.title)}`;
        const data = await wikiJson(url);
        // relevância: arquivos com palavras do título do artigo no nome primeiro (as caixas de navegação
        // do artigo trazem fotos de outros assuntos); depois, as maiores
        const topic = words(page.title);
        const files = Object.values(data?.query?.pages || {})
          .map((p) => ({ title: p.title || '', info: p.imageinfo?.[0] }))
          .filter(({ title, info }) => info && /image\/(jpeg|png|webp)/.test(info.mime) && info.width >= 600 && info.height >= 380 && !JUNK_IMAGE.test(title))
          .map((f) => ({ ...f, score: words(f.title).filter((w) => topic.includes(w)).length }))
          .sort((a, b) => b.score - a.score || b.info.width * b.info.height - a.info.width * a.info.height);
        const related = files.filter((f) => f.score > 0);
        for (const { info } of (related.length >= 2 ? related : files).slice(0, 6)) {
          const src = info.thumburl || info.url;
          // a principal costuma aparecer de novo na lista, em outra resolução
          if (!list.some((l) => fileKey(l.url) === fileKey(src))) list.push({ url: src, fonte: `Wikimedia Commons · ${page.title}` });
        }
      } catch (e) { console.error('[doc] commons:', e.message); }
      if (list.length) return list;
    }
    return [];
  })();
  IMAGE_CACHE.set(key, { at: Date.now(), job });
  job.then((list) => { if (!list.length) IMAGE_CACHE.delete(key); });
  if (IMAGE_CACHE.size > 400) IMAGE_CACHE.delete(IMAGE_CACHE.keys().next().value);
  return job;
}

// Escolhe até n fotos que ainda não apareceram no documentário (se todas já foram usadas, repete a principal).
// main=true: a foto principal do artigo sempre vem primeiro (galeria, comparação e jornal precisam da foto
// mais representativa, mesmo que ela já tenha aparecido antes)
function pickImages(list, n, used, main = false) {
  if (main && list.length) { used.add(fileKey(list[0].url)); return [list[0]]; }
  const fresh = list.filter((i) => !used.has(fileKey(i.url))).slice(0, n);
  const out = fresh.length ? fresh : list.slice(0, 1);
  out.forEach((i) => used.add(fileKey(i.url)));
  return out;
}

// Resumo de um artigo (foto, descrição curta, primeiro parágrafo) para os cartões de resposta
async function wikiSummary(query) {
  for (const lang of ['pt', 'en']) {
    try {
      const search = await wikiJson(`https://${lang}.wikipedia.org/w/api.php?action=query&format=json&list=search&srlimit=1&srsearch=${encodeURIComponent(query)}`, 7000);
      const title = search?.query?.search?.[0]?.title;
      if (!title) continue;
      const s = await wikiJson(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`, 7000);
      if (!s?.title) continue;
      return {
        titulo: s.title, descricao: str(s.description, 120), resumo: str(s.extract, 420),
        url: s.originalimage?.source || s.thumbnail?.source || '', fonte: `Wikipedia · ${s.title}`,
      };
    } catch {}
  }
  return null;
}

// Quantas chaves/colchetes ficaram abertos (fora de strings); negativo = fechou demais
function unclosed(text) {
  let depth = 0, inStr = false, esc = false;
  for (const c of text) {
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') inStr = !inStr;
    else if (!inStr && (c === '{' || c === '[')) depth++;
    else if (!inStr && (c === '}' || c === ']')) depth--;
  }
  return depth;
}

// JSON "do jeito que o modelo escreve": vírgulas sobrando, vários objetos na mesma linha,
// chaves faltando ou sobrando no fim. Devolve a lista de objetos, ou null se não deu para salvar.
function parseLoose(text, force = false) {
  const tryParse = (t) => { try { return JSON.parse(t); } catch { return undefined; } };
  let t = text.trim().replace(/,\s*$/, '').replace(/,\s*([}\]])/g, '$1');
  let v = tryParse(t);
  if (v !== undefined) return [v];
  // vários objetos colados: {...}{...} ou {...} {...}
  const parts = t.split(/}\s*,?\s*(?={")/).map((p, i, a) => (i < a.length - 1 ? p + '}' : p));
  if (parts.length > 1) {
    const objs = parts.map((p) => parseLoose(p, force));
    if (objs.every(Boolean)) return objs.flat();
  }
  // fecha o que ficou aberto (na ordem certa) ou corta o que sobrou
  const d = unclosed(t);
  if (d > 0 && force !== 'never') {
    const stack = [];
    let inStr = false, esc = false;
    for (const c of t) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = !inStr;
      else if (!inStr && (c === '{' || c === '[')) stack.push(c === '{' ? '}' : ']');
      else if (!inStr && (c === '}' || c === ']')) stack.pop();
    }
    if (inStr) t += '"';
    v = tryParse(t.replace(/,\s*$/, '') + stack.reverse().join(''));
    if (v !== undefined && (force || /"fala"\s*:/.test(t))) return [v];
  } else if (d < 0) {
    for (let k = 0; k < -d; k++) t = t.replace(/[}\]]\s*$/, '');
    v = tryParse(t);
    if (v !== undefined) return [v];
  }
  const rescued = salvage(text);
  return rescued ? [rescued] : null;
}

// Último recurso para um beat com erro de sintaxe no meio ("destaques"]["x"]): pega campo a campo
function salvage(text) {
  const strField = (k) => {
    const m = text.match(new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    return m ? JSON.parse(`"${m[1]}"`) : undefined;
  };
  const numField = (k) => { const m = text.match(new RegExp(`"${k}"\\s*:\\s*(-?[\\d.]+)`)); return m ? Number(m[1]) : undefined; };
  const fala = strField('fala');
  if (fala === undefined) return null;
  let visual;
  const vi = text.search(/"visual"\s*:\s*\{/);
  if (vi >= 0) {
    const start = text.indexOf('{', vi);
    let depth = 0, inStr = false, esc = false;
    for (let k = start; k < text.length; k++) {
      const c = text[k];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = !inStr;
      else if (!inStr && c === '{') depth++;
      else if (!inStr && c === '}' && --depth === 0) {
        try { visual = JSON.parse(text.slice(start, k + 1)); } catch {}
        break;
      }
    }
  }
  const list = (k) => {
    const m = text.match(new RegExp(`"${k}"\\W*\\[([^\\]]*)\\]`));
    return m ? [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]) : [];
  };
  return {
    cena: strField('cena'), fala, visual,
    pausa_antes: numField('pausa_antes'), pausa_depois: numField('pausa_depois'),
    escurecer: /"escurecer"\s*:\s*true/.test(text),
    destaques: list('destaques'), entidades: list('entidades'),
  };
}

// ------------------------------------------------------------ geocodificação (Nominatim / OpenStreetMap)
// Política do Nominatim: no máximo 1 consulta por segundo e User-Agent identificado. Resultados ficam em cache.
const geoCache = new Map();
let geoQueue = Promise.resolve();
function nominatim(query, { polygon = false } = {}) {
  const key = (polygon ? 'P:' : '') + query.toLowerCase();
  if (geoCache.has(key)) return geoCache.get(key);
  const job = geoQueue.then(async () => {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}${polygon ? '&polygon_geojson=1&polygon_threshold=0.008' : ''}`;
    try {
      const r = await (await fetch(url, { headers: { ...UA, 'Accept-Language': 'pt-BR,pt,en' }, signal: AbortSignal.timeout(9000) })).json();
      const hit = r?.[0];
      if (!hit) return null;
      const b = hit.boundingbox.map(Number); // [sul, norte, oeste, leste]
      return { coords: [Number(hit.lon), Number(hit.lat)], bbox: [b[2], b[0], b[3], b[1]], geojson: hit.geojson, rank: hit.place_rank };
    } catch { return null; }
  });
  geoQueue = job.then(() => new Promise((r) => setTimeout(r, 1100)));
  geoCache.set(key, job);
  return job;
}

// ponto a "km" quilômetros a leste (onde fica o rótulo do raio)
function eastOf([lon, lat], km) {
  return [lon + km / (111.32 * Math.cos((lat * Math.PI) / 180)), lat];
}

async function prepareMap(v) {
  const out = { tipo: 'mapa', lugar: v.lugar, zoom: v.zoom, pitch: v.pitch, bearing: v.bearing, centro: v.coords, marcadores: [], rota: [] };
  const jobs = [];
  if (v.lugar && (!v.coords || v.zoom === null)) {
    jobs.push(nominatim(v.lugar).then((g) => {
      if (!g) return;
      if (!out.centro) out.centro = g.coords;
      // lugar grande (país, estado) sem zoom definido: enquadra a área inteira
      if (v.zoom === null && g.rank <= 16) out.bbox = g.bbox;
      else if (v.zoom === null) out.zoom = 11;
    }));
  }
  if (v.destacar) {
    jobs.push(nominatim(v.destacar, { polygon: true }).then((g) => {
      if (g?.geojson && /Polygon/.test(g.geojson.type)) out.area = { type: 'Feature', geometry: g.geojson, properties: {} };
    }));
  }
  const resolve = (p) => (p.coords ? Promise.resolve(p) : nominatim(p.lugar).then((g) => (g ? { ...p, coords: g.coords } : null)));
  jobs.push(Promise.all(v.marcadores.map(resolve)).then((list) => { out.marcadores = list.filter(Boolean).map((p) => ({ coords: p.coords, rotulo: p.rotulo })); }));
  jobs.push(Promise.all(v.rota.map(resolve)).then((list) => { out.rota = list.filter(Boolean).map((p) => ({ coords: p.coords, rotulo: p.rotulo })); }));
  await Promise.all(jobs);
  if (!out.centro) out.centro = out.marcadores[0]?.coords || out.rota[0]?.coords || null;
  if (!out.centro) return null;
  if (v.raioKm) {
    const c = out.marcadores[0]?.coords || out.centro;
    out.raio = { centro: c, km: v.raioKm, rotulo: v.rotuloRaio, borda: eastOf(c, v.raioKm) };
  }
  if (out.zoom === null && !out.bbox) out.zoom = 6;
  return out;
}

// Fotos de cada componente. Sem foto boa, o visual vira um cartão tipográfico em vez de uma foto errada.
async function prepareImages(beat, used) {
  const v = beat.visual;
  const card = (texto) => ({ tipo: 'frase', texto, autor: '' });
  if (v.tipo === 'imagem') {
    const imgs = pickImages(await wikiImages(v.busca), 3, used);
    beat.visual = imgs.length ? { ...v, url: imgs[0].url, fonte: imgs[0].fonte, extras: imgs.slice(1) } : card(v.legenda || v.busca);
  } else if (v.tipo === 'galeria') {
    const lists = await Promise.all(v.buscas.map((b) => wikiImages(b)));
    const fotos = lists.map((l, i) => {
      const [img] = pickImages(l, 1, used, true);
      return img ? { ...img, rotulo: v.buscas[i] } : null;
    }).filter(Boolean);
    beat.visual = fotos.length >= 2 ? { tipo: 'galeria', fotos, legenda: v.legenda }
      : fotos.length ? { tipo: 'imagem', url: fotos[0].url, fonte: fotos[0].fonte, legenda: v.legenda, extras: [] } : card(v.legenda || v.buscas.join(', '));
  } else if (v.tipo === 'comparacao') {
    const [a, d] = await Promise.all([v.antes, v.depois].map(async (s) => pickImages(await wikiImages(s.busca), 1, used, true)[0]));
    if (a && d) beat.visual = { tipo: 'comparacao', antes: { ...v.antes, ...a }, depois: { ...v.depois, ...d } };
    else beat.visual = card([v.antes.rotulo, v.depois.rotulo].filter(Boolean).join(' × ') || v.antes.busca);
  } else if (v.tipo === 'manchete' && v.busca) {
    const [img] = pickImages(await wikiImages(v.busca), 1, used, true);
    if (img) Object.assign(v, { url: img.url, fonte: img.fonte });
  }
}

// O quiz já leva as falas da resposta prontas: a reação é imediata, sem esperar o modelo
async function prepareQuiz(q, ctx) {
  const say = (t) => (t ? ctx.synthesize(t, { rate: '-2%' }).then((r) => r.data).catch(() => null) : Promise.resolve(null));
  const certa = `${LETTERS[q.correta]}: ${q.opcoes[q.correta]}`;
  const [certo, errado, resposta, explicacao] = await Promise.all([
    say('Exato, senhor!'),
    say('Não desta vez.'),
    say(`A resposta certa é a letra ${certa}. ${q.explicacao}`),
    say(q.explicacao),
  ]);
  q.audios = { certo, errado, resposta, explicacao };
}

async function prepareBeat(beat, ctx, used) {
  const tasks = [];
  if (beat.visual?.tipo === 'mapa') {
    tasks.push(prepareMap(beat.visual).then((m) => {
      beat.visual = m || { tipo: 'frase', texto: beat.visual.lugar || '', autor: '' };
    }).catch((e) => { console.error('[doc] mapa', e); beat.visual = null; }));
  }
  if (['imagem', 'galeria', 'comparacao', 'manchete'].includes(beat.visual?.tipo)) {
    tasks.push(prepareImages(beat, used).catch((e) => { console.error('[doc] imagens', e); }));
  }
  if (beat.visual?.tipo === 'quiz') tasks.push(prepareQuiz(beat.visual, ctx));
  if (beat.fala) {
    tasks.push(ctx.synthesize(beat.fala, { rate: '-2%' })
      .then(({ data, words }) => { beat.audio = data; beat.words = words; })
      .catch((e) => { console.error('[doc] tts', e.message); }));
  }
  await Promise.all(tasks);
  return beat;
}

async function produce(topic, beats, ctx, mode = 'doc') {
  if (current) current.abort.abort();
  const id = Date.now();
  const abort = new AbortController();
  current = { id, abort };
  const alive = () => current?.id === id && !abort.signal.aborted;
  ctx.send('doc', { type: 'open', id, topic, mode, kicker: mode === 'mapa' ? 'J.A.R.V.I.S. · MAPA VIVO' : 'J.A.R.V.I.S. · DOCUMENTÁRIO' });

  const used = new Set(); // fotos já usadas neste documentário
  const jobs = [];
  let buffer = '';
  let header = null;
  let index = 0;

  let carry = ''; // objeto quebrado em várias linhas: junta até fechar
  const onLine = (line) => {
    let l = line.trim().replace(/^```(json)?/, '').replace(/```$/, '').trim();
    if (carry) { l = carry + ' ' + l; carry = ''; }
    if (!l.startsWith('{')) return;
    const objs = parseLoose(l);
    if (!objs) {
      if (unclosed(l) > 0 && l.length < 3000) { carry = l; return; }
      console.log('[doc] linha inválida:', l);
      return;
    }
    objs.forEach(onObject);
  };
  const onObject = (obj) => {
    if (!header && obj.titulo && !obj.fala && !obj.visual) {
      header = { titulo: str(obj.titulo, 80), subtitulo: str(obj.subtitulo, 140), clima: mode === 'mapa' ? 'nenhum' : MOODS.includes(obj.clima) ? obj.clima : 'epico' };
      ctx.send('doc', { type: 'header', id, ...header });
      return;
    }
    const beat = sanitizeBeat(obj);
    if (!beat) return;
    const i = index++;
    // o quiz só existe no documentário (no mapa vivo, ignora)
    if (beat.visual?.tipo === 'quiz' && mode === 'mapa') return;
    jobs.push(prepareBeat(beat, ctx, used).then((b) => { if (alive()) ctx.send('doc', { type: 'beat', id, index: i, beat: b }); }));
  };

  try {
    await ctx.streamText(mode === 'mapa' ? mapPrompt(topic, beats) : directorPrompt(topic, beats), (d) => {
      buffer += d;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      lines.forEach(onLine);
    }, abort.signal, { maxTokens: 8000 });
    onLine(buffer);
    if (carry) { const objs = parseLoose(carry, true); if (objs) objs.forEach(onObject); else console.log('[doc] sobra inválida:', carry); }
    await Promise.all(jobs);
    if (alive()) ctx.send('doc', { type: 'complete', id, total: index });
    if (!index && alive()) ctx.send('doc', { type: 'error', id, message: 'O diretor não entregou o roteiro.' });
  } catch (e) {
    if (!alive()) return;
    console.error('[doc]', e);
    ctx.send('doc', { type: index ? 'complete' : 'error', id, total: index, message: e.message });
  }
}

module.exports = {
  name: 'documentary',
  stop() { if (current) { current.abort.abort(); current = null; } },
  tools: [
    {
      name: 'documentary_start',
      description: 'Apresenta um MINIDOCUMENTÁRIO audiovisual em tela cheia: narração com imagens históricas, anos gigantes, citações, linhas do tempo e pausas dramáticas. Use para "conte a história de X", "faz um documentário sobre X", "me apresenta X como um documentário", "quero entender a história de X". O usuário controla por voz (pausa, continua, volta, pula, encerra) e pode fazer perguntas no meio.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Tema do documentário, bem específico (ex: "História do Brasil, do descobrimento à República")' },
          minutes: { type: 'number', description: 'Duração aproximada em minutos (padrão 3, de 1 a 8)' },
        },
        required: ['topic'],
      },
      async run({ topic, minutes = 3 }, ctx) {
        const beats = Math.round(clamp(minutes, 1, 8, 3) * 60 / 9);
        produce(str(topic, 200), beats, ctx); // roda em segundo plano; o player começa no primeiro beat pronto
        return {
          ok: true, starting: true,
          how_to_answer: 'Fale UMA frase curta de abertura no estilo JARVIS (ex.: "Preparei algo especial, senhor. Recomendo diminuir as luzes."). NÃO conte a história: o documentário narra sozinho.',
        };
      },
    },
    {
      name: 'map_show',
      description: 'MAPA VIVO em tela cheia: globo 3D que voa até o lugar, marca pontos, desenha raios, rotas e contornos de países/estados enquanto a explicação é narrada em sincronia. Use para "onde fica X?", "me mostra X no mapa", "qual a rota de...", "qual a distância entre...", "onde aconteceu...". Depois dá para perguntar mais ("e Pripyat?"): chame de novo e a câmera continua de onde está.',
      parameters: {
        type: 'object',
        properties: {
          pedido: { type: 'string', description: 'O pedido do usuário, completo (ex: "onde fica Chernobyl e o tamanho da zona de exclusão")' },
          detalhado: { type: 'boolean', description: 'true se ele quer uma explicação longa' },
        },
        required: ['pedido'],
      },
      async run({ pedido, detalhado }, ctx) {
        produce(str(pedido, 300), detalhado ? 9 : 5, ctx, 'mapa');
        return { ok: true, starting: true, how_to_answer: 'Fale só uma frase MUITO curta (ex.: "Projetando o mapa, senhor."). A explicação é narrada no próprio mapa; não explique você.' };
      },
    },
    {
      name: 'documentary_aside',
      description: 'Durante um documentário pausado: mostra um CARTÃO na tela (foto, descrição e pontos-chave) sobre a pessoa, lugar ou conceito da pergunta do usuário ("quem é essa pessoa?", "onde fica isso?", "explica melhor"). Chame junto com a resposta falada.',
      parameters: {
        type: 'object',
        properties: {
          busca: { type: 'string', description: 'Título do artigo da Wikipedia sobre o assunto (ex: "Pedro I do Brasil"). Omita se for uma explicação sem um assunto específico.' },
          titulo: { type: 'string', description: 'Título do cartão (ex: "Dom Pedro I")' },
          pontos: { type: 'array', items: { type: 'string' }, description: '2 a 4 fatos curtos (máx. 90 caracteres cada), verificáveis' },
        },
        required: ['titulo'],
      },
      async run({ busca, titulo, pontos }, ctx) {
        if (!ctx.docState?.active) return { ok: false, error: 'Nenhum documentário em exibição.' };
        const wiki = busca ? await wikiSummary(str(busca, 120)) : null;
        const points = (Array.isArray(pontos) ? pontos : []).slice(0, 4).map((p) => str(p, 110)).filter(Boolean);
        ctx.send('doc-aside', {
          titulo: str(titulo, 60) || wiki?.titulo || '',
          descricao: wiki?.descricao || '',
          url: wiki?.url || '',
          fonte: wiki?.fonte || '',
          pontos: points.length ? points : (wiki?.resumo ? [wiki.resumo] : []),
        });
        return {
          ok: true, card_shown: true, wikipedia: wiki?.resumo || null,
          how_to_answer: 'Responda falando em 2 a 3 frases (o cartão complementa, não leia os pontos). Termine lembrando que ele pode dizer "continua".',
        };
      },
    },
    {
      name: 'documentary_control',
      description: 'Controla o documentário em exibição: pause, resume (continua), back (volta um trecho), image (volta para a última imagem), next (pula), stop (encerra), answer (resposta do quiz final: choice 0=A, 1=B, 2=C).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['pause', 'resume', 'back', 'image', 'next', 'stop', 'answer'] },
          choice: { type: 'number', description: 'Só para answer: 0, 1 ou 2' },
        },
        required: ['action'],
      },
      async run({ action, choice }, ctx) {
        if (!ctx.docState?.active) return { ok: false, error: 'Nenhum documentário em exibição.' };
        if (action === 'stop' && current) { current.abort.abort(); current = null; }
        if (action === 'answer') {
          if (!ctx.docState.quiz?.waiting) return { ok: false, error: 'O quiz não está esperando resposta.' };
          ctx.send('doc-command', { action, choice: clamp(choice, 0, 2, 0) | 0 });
          return { ok: true, how_to_answer: 'Não fale nada: o documentário revela a resposta sozinho.' };
        }
        ctx.send('doc-command', { action });
        return { ok: true, how_to_answer: action === 'resume' ? 'Não fale nada (responda só "Continuando.").' : 'Confirme em 2 ou 3 palavras.' };
      },
    },
  ],
};
