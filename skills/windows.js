// Consciência dos monitores: "joga isso ali", "código aqui e documentação lá", "leva o vídeo pro outro monitor".
// Entende as janelas abertas (programa + título), os monitores (número do Windows, esquerda/direita, principal)
// e "aqui" = monitor onde está o mouse (onde o usuário está trabalhando).
const { WinMgr } = require('../lib/winmgr');

let wm = null;

// Programas que não são "janelas de trabalho" (barra/painéis do Seelen UI, sobreposições do próprio JARVIS)
const IGNORE_PROC = /^(seelen-ui|seelen|textinputhost|shellexperiencehost|searchhost|startmenuexperiencehost|lockapp)$/i;
const IGNORE_TITLE = /^(jarvis-overlay|JARVIS mini|Program Manager)$/i;

// Como o usuário chama cada coisa → como ela aparece (processo|título)
const ALIASES = [
  [/\b(celular|iphone|telefone|espelhamento|espelho)\b/i, (w) => /^uxplay$/i.test(w.proc)],
  [/\b(c[óo]digo|vs ?code|vscode|editor|visual studio code)\b/i, (w) => /^(code|cursor|code - insiders)$/i.test(w.proc)],
  [/\b(cursor)\b/i, (w) => /^cursor$/i.test(w.proc)],
  [/\b(m[úu]sica|youtube music|player)\b/i, (w) => /youtube ?music/i.test(w.title) || /youtube ?music|pear/i.test(w.proc)],
  [/\b(v[íi]deo|youtube|filme|aula)\b/i, (w) => (/youtube|netflix|prime video|twitch|vimeo/i.test(w.title) && !/youtube ?music/i.test(w.title)) || /^(vlc|mpv|mpc-hc64|potplayer.*)$/i.test(w.proc)],
  [/\b(documenta[çc][ãa]o|docs?|refer[êe]ncia|mdn|api)\b/i, (w) => isBrowser(w) && /docs?|documenta|reference|refer[êe]ncia|mdn|developer|readthedocs|api|guide|manual|stack ?overflow/i.test(w.title)],
  [/\b(navegador|chrome|browser|edge|firefox|brave|opera|internet|site|p[áa]gina)\b/i, isBrowser],
  [/\b(terminal|console|powershell|prompt|cmd)\b/i, (w) => /^(windowsterminal|powershell|pwsh|cmd|wezterm-gui|alacritty)$/i.test(w.proc)],
  [/\b(jarvis|voc[êe] mesmo|seu painel|sua janela)\b/i, (w) => w.title === 'J.A.R.V.I.S.'],
  [/\b(oficina)\b/i, (w) => /oficina/i.test(w.title) && w.proc === 'electron'],
  [/\b(pasta|explorador|arquivos|explorer)\b/i, (w) => /^explorer$/i.test(w.proc)],
  [/\b(discord)\b/i, (w) => /^discord$/i.test(w.proc)],
  [/\b(whats ?app|zap)\b/i, (w) => /whatsapp/i.test(w.proc + w.title)],
  [/\b(telegram)\b/i, (w) => /telegram/i.test(w.proc)],
  [/\b(spotify)\b/i, (w) => /^spotify$/i.test(w.proc)],
  [/\b(obs)\b/i, (w) => /^obs/i.test(w.proc)],
  [/\b(steam|jogo|game)\b/i, (w) => /^steam/i.test(w.proc)],
];
function isBrowser(w) { return /^(chrome|msedge|firefox|brave|opera|vivaldi|arc)$/i.test(w.proc); }

const THIS = /^(isso|isto|essa|esta|ela|atual|essa janela|esta janela|a janela|janela atual|o que (eu )?(estou|t[ôo]) (usando|vendo))$/i;
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

function workWindows(state) {
  return state.windows.filter((w) => !IGNORE_PROC.test(w.proc) && !IGNORE_TITLE.test(w.title) && w.rect.w > 80 && w.rect.h > 60);
}

// Descobre a janela a partir do jeito que o usuário falou
function findWindow(state, spec, used = new Set()) {
  const list = workWindows(state).filter((w) => !used.has(w.h));
  const s = norm(spec).replace(/^(o|a|os|as|esse|essa|este|esta)\s+/, '');
  if (!s || THIS.test(s)) {
    // "isso": a janela mais recente que não é o próprio JARVIS (ele pode estar na frente porque você digitou nele)
    return list.find((w) => w.title !== 'J.A.R.V.I.S.' && !w.min) || null;
  }
  for (const [re, test] of ALIASES) if (re.test(s)) {
    const hit = list.filter(test);
    if (hit.length) return hit.find((w) => !w.min) || hit[0];
  }
  // a documentação costuma estar numa aba que não está na frente: vale o navegador
  if (/documenta|docs?\b|referencia/.test(s)) {
    const b = list.filter(isBrowser);
    if (b.length) return b.find((w) => !w.min) || b[0];
  }
  // palavras soltas contra título e programa ("figma", "postman", "readme")
  const words = s.split(/\s+/).filter((x) => x.length > 2 && !/^(janela|monitor|tela|programa|aplicativo|app|que|com|para|pro)$/.test(x));
  let best = null, bestScore = 0;
  for (const w of list) {
    const hay = norm(`${w.proc} ${w.title}`);
    const score = words.reduce((n, x) => n + (hay.includes(x) ? x.length : 0), 0) - w.z * 0.01;
    if (score > bestScore) { best = w; bestScore = score; }
  }
  return best;
}

// Monitores em ordem da esquerda para a direita
function monitorsLtr(state) { return [...state.monitors].sort((a, b) => a.rect.x - b.rect.x || a.rect.y - b.rect.y); }

function findMonitor(state, spec, win) {
  const s = norm(spec);
  const ltr = monitorsLtr(state);
  const byI = (i) => state.monitors.find((m) => m.i === i);
  const current = win ? byI(win.mon) : null;
  const here = byI(state.cursor) || state.monitors.find((m) => m.primary);
  const num = s.match(/\d+/);
  if (num) return state.monitors.find((m) => m.number === Number(num[0])) || ltr[Number(num[0]) - 1] || null;
  if (/\b(primeir\w*|um)\b/.test(s)) return ltr[0];
  if (/\b(segund\w*|dois)\b/.test(s)) return ltr[1] || null;
  if (/\b(terceir\w*|tres)\b/.test(s)) return ltr[2] || null;
  if (/esquerd/.test(s)) return ltr[0];
  if (/direit/.test(s)) return ltr[ltr.length - 1];
  if (/principal|prim[aá]rio/.test(s)) return state.monitors.find((m) => m.primary);
  if (/secund/.test(s)) return state.monitors.find((m) => !m.primary) || null;
  if (/^(aqui|este|esse|nesse|neste|atual|meu|daqui|pra ca|para ca|ca)\b/.test(s)) return here;
  // "ali", "lá", "outro": o monitor em que a janela NÃO está (com 2 monitores, é o outro)
  if (/\b(ali|la|outro|outra|do lado|oposto)\b/.test(s) || !s) {
    const from = current || here;
    return state.monitors.find((m) => m.i !== from.i) || from;
  }
  return null;
}

// Onde a janela fica dentro do monitor (área útil, sem a barra de tarefas)
function placement(mon, pos, win) {
  const a = mon.work;
  const p = norm(pos);
  const half = (k) => Math.round(k / 2);
  if (/esquerd/.test(p)) return { rect: { x: a.x, y: a.y, w: half(a.w), h: a.h } };
  if (/direit/.test(p)) return { rect: { x: a.x + half(a.w), y: a.y, w: a.w - half(a.w), h: a.h } };
  if (/cima|topo|superior/.test(p)) return { rect: { x: a.x, y: a.y, w: a.w, h: half(a.h) } };
  if (/baixo|inferior/.test(p)) return { rect: { x: a.x, y: a.y + half(a.h), w: a.w, h: a.h - half(a.h) } };
  if (/centr|meio/.test(p)) return { rect: { x: a.x + Math.round(a.w * 0.12), y: a.y + Math.round(a.h * 0.1), w: Math.round(a.w * 0.76), h: Math.round(a.h * 0.8) } };
  if (/maxim|cheia|inteir|toda|grande/.test(p) || !win || win.max) return { rect: { ...a }, maximize: true };
  // "manter": mesma posição e tamanho relativos no outro monitor
  const from = win.monRect || a;
  const rx = (win.rect.x - from.x) / from.w, ry = (win.rect.y - from.y) / from.h;
  const w = Math.min(a.w, win.rect.w), h = Math.min(a.h, win.rect.h);
  return { rect: { x: Math.round(a.x + Math.max(0, Math.min(a.w - w, rx * a.w))), y: Math.round(a.y + Math.max(0, Math.min(a.h - h, ry * a.h))), w, h } };
}

const monName = (state, m) => {
  const ltr = monitorsLtr(state);
  const side = ltr.length === 2 ? (ltr[0].i === m.i ? 'esquerda' : 'direita') : '';
  return `Monitor ${m.number}${side ? ` (${side})` : ''}${m.primary ? ' · principal' : ''}`;
};
const winName = (w) => `${w.proc === 'Code' ? 'VS Code' : w.proc}: "${w.title.slice(0, 70)}"`;

function summary(state) {
  return {
    monitores: monitorsLtr(state).map((m) => `${monName(state, m)}${m.i === state.cursor ? ' ← mouse aqui' : ''}`),
    janelas: workWindows(state).slice(0, 15).map((w) => `${winName(w)} → Monitor ${state.monitors[w.mon]?.number ?? '?'}${w.min ? ' (minimizada)' : w.max ? ' (maximizada)' : ''}`),
  };
}

async function moveOne(state, item, used, ctx) {
  const win = findWindow(state, item.janela, used);
  if (!win) return { ok: false, janela: item.janela, error: 'janela não encontrada' };
  used.add(win.h);
  win.monRect = state.monitors.find((m) => m.i === win.mon)?.rect;
  const mon = findMonitor(state, item.monitor || 'outro', win);
  if (!mon) return { ok: false, janela: winName(win), error: `monitor "${item.monitor}" não existe (há ${state.monitors.length})` };
  const { rect, maximize } = placement(mon, item.posicao, win);
  await wm.move(win.h, rect, maximize);
  ctx.monitorOverlay?.({ kind: 'highlight', rect, label: win.proc === 'Code' ? 'VS CODE' : win.proc.toUpperCase() });
  return { ok: true, janela: winName(win), foi_para: monName(state, mon), posicao: maximize ? 'maximizada' : (item.posicao || 'mesma posição') };
}

module.exports = {
  name: 'windows',
  init(ctx) { wm = new WinMgr(ctx.dataDir); },
  tools: [
    {
      name: 'window_move',
      description: 'Move janelas entre os monitores e organiza a tela. Use para "joga isso ali", "leva o vídeo pro outro monitor", "deixa o código aqui e a documentação lá", "coloca o Chrome na metade direita do monitor 2", "traz o terminal pra cá". Pode mover várias janelas de uma vez.',
      parameters: {
        type: 'object',
        properties: {
          itens: {
            type: 'array',
            description: 'Uma entrada por janela a mover',
            items: {
              type: 'object',
              properties: {
                janela: { type: 'string', description: 'Como o usuário chamou: "isso" (janela atual), "código", "vídeo", "documentação", "navegador", "terminal", "música", "jarvis", ou nome/título ("figma", "postman")' },
                monitor: { type: 'string', description: '"aqui" (onde o mouse está), "outro"/"ali"/"lá" (o outro monitor), "1", "2", "esquerda", "direita", "principal"' },
                posicao: { type: 'string', description: '"manter" (padrão), "maximizada", "esquerda", "direita", "cima", "baixo", "centro" (metade/região do monitor)' },
              },
              required: ['janela'],
            },
          },
        },
        required: ['itens'],
      },
      async run({ itens }, ctx) {
        const list = (Array.isArray(itens) ? itens : [itens]).filter(Boolean).slice(0, 6);
        if (!list.length) return { ok: false, error: 'Nada para mover.' };
        const state = await wm.list();
        const used = new Set();
        const results = [];
        for (const item of list) results.push(await moveOne(state, item, used, ctx).catch((e) => ({ ok: false, janela: item.janela, error: e.message })));
        const failed = results.filter((r) => !r.ok);
        return {
          resultados: results,
          ...(failed.length ? { janelas_abertas: summary(state).janelas, dica: 'Se não encontrou, escolha pelo nome exato de uma das janelas abertas e chame de novo.' } : {}),
          how_to_answer: 'Confirme em uma frase curta (ex.: "Código no monitor 1, documentação no 2.").',
        };
      },
    },
    {
      name: 'window_action',
      description: 'Minimiza, maximiza, restaura ou traz para frente uma janela ("minimiza o Discord", "maximiza isso", "abre o VS Code que está minimizado", "foca no terminal").',
      parameters: {
        type: 'object',
        properties: {
          janela: { type: 'string', description: 'Como em window_move ("isso", "código", "discord"...)' },
          acao: { type: 'string', enum: ['minimizar', 'maximizar', 'restaurar', 'focar'] },
        },
        required: ['janela', 'acao'],
      },
      async run({ janela, acao }) {
        const state = await wm.list();
        const win = findWindow(state, janela);
        if (!win) return { ok: false, error: 'janela não encontrada', janelas_abertas: summary(state).janelas };
        if (acao === 'minimizar') await wm.minimize(win.h);
        else if (acao === 'maximizar') await wm.maximize(win.h);
        else await wm.restore(win.h);
        return { ok: true, janela: winName(win), acao, how_to_answer: 'Confirme em 2 a 4 palavras.' };
      },
    },
    {
      name: 'monitors_info',
      description: 'Mostra quais são os monitores e o que está aberto em cada um. Com identificar=true, mostra um número gigante em cada tela (como o Windows faz) para o usuário saber qual é o Monitor 1 e o 2. Use para "quais janelas estão abertas", "o que tem no monitor 2", "identifica os monitores", "qual é o monitor 1?".',
      parameters: { type: 'object', properties: { identificar: { type: 'boolean' } } },
      async run({ identificar }, ctx) {
        const state = await wm.list();
        if (identificar) {
          ctx.monitorOverlay?.({
            kind: 'identify',
            monitors: state.monitors.map((m) => ({ rect: m.rect, number: m.number, label: monName(state, m).replace(/^Monitor \d+ ?/, '').replace(/[()]/g, ''), here: m.i === state.cursor })),
          });
        }
        return { ...summary(state), how_to_answer: identificar ? 'Diga em uma frase qual é qual (ex.: "O 1 é o da esquerda, principal; o 2 é o da direita.").' : 'Resuma em 1 a 2 frases o que está em cada monitor.' };
      },
    },
  ],
  // usado nos testes e no main
  _internal: { findWindow, findMonitor, placement, summary, get wm() { return wm; } },
};
