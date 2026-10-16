// Controle do Windows: programas, sites, volume, mídia, print, bloqueio.
const { shell, screen, desktopCapturer, app } = require('electron');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Desligamento agendado (o JARVIS conta o tempo; dá para cancelar até o último segundo)
let power = null; // { acao, at, timers }
function clearPower() {
  if (power) power.timers.forEach(clearTimeout);
  power = null;
}

const APP_ALIASES = {
  'chrome': 'chrome', 'google chrome': 'chrome', 'navegador': 'chrome',
  'edge': 'msedge', 'firefox': 'firefox',
  'spotify': 'spotify:', 'discord': 'discord:', 'steam': 'steam:',
  'whatsapp': 'whatsapp:', 'vscode': 'code', 'vs code': 'code', 'visual studio code': 'code',
  'bloco de notas': 'notepad', 'notepad': 'notepad', 'calculadora': 'calc',
  'explorador': 'explorer', 'explorador de arquivos': 'explorer', 'arquivos': 'explorer',
  'configurações': 'ms-settings:', 'configuracoes': 'ms-settings:',
  'gerenciador de tarefas': 'taskmgr', 'paint': 'mspaint', 'terminal': 'wt',
  'cmd': 'cmd', 'prompt de comando': 'cmd', 'word': 'winword', 'excel': 'excel',
  'powerpoint': 'powerpnt', 'youtube': 'https://www.youtube.com', 'gmail': 'https://mail.google.com',
  'netflix': 'https://www.netflix.com', 'github': 'https://github.com', 'chatgpt': 'https://chatgpt.com',
};

const normalize = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// Atalhos do Menu Iniciar: é por eles que o usuário conhece os programas ("Discord", "Steam"...)
function listStartMenu() {
  const roots = [
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  ];
  const out = [];
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (/\.(lnk|url)$/i.test(e.name) && !/uninstall|desinstalar/i.test(e.name)) out.push({ name: e.name.replace(/\.(lnk|url)$/i, ''), file: full });
    }
  };
  roots.forEach((r) => walk(r, 0));
  return out;
}

function findShortcut(name) {
  const target = normalize(name);
  let best = null, bestScore = 0;
  for (const s of listStartMenu()) {
    const n = normalize(s.name);
    const score = n === target ? 100 : n.startsWith(target) ? 60 : n.includes(target) ? 40 : 0;
    if (score > bestScore || (score === bestScore && best && n.length < normalize(best.name).length)) { best = s; bestScore = score; }
  }
  return bestScore ? best : null;
}

// O executável existe no PATH ou em "App Paths" do registro?
function commandExists(cmd) {
  return new Promise((resolve) => {
    const appPath = `SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${cmd}.exe`;
    exec(`where "${cmd}" || reg query "HKLM\\${appPath}" /ve || reg query "HKCU\\${appPath}" /ve`,
      { windowsHide: true, timeout: 5000 }, (err) => resolve(!err));
  });
}

function pressKey(code, times = 1) {
  const ps = `$w=New-Object -ComObject WScript.Shell; 1..${times} | % { $w.SendKeys([char]${code}) }`;
  exec(`powershell -NoProfile -WindowStyle Hidden -Command "${ps}"`, { windowsHide: true });
}

async function takeScreenshot() {
  const display = screen.getPrimaryDisplay();
  const sf = display.scaleFactor;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(display.size.width * sf), height: Math.round(display.size.height * sf) },
  });
  const dir = path.join(app.getPath('pictures'), 'JARVIS');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `print-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
  fs.writeFileSync(file, sources[0].thumbnail.toPNG());
  return file;
}

module.exports = {
  name: 'system',
  tools: [
    {
      name: 'open_app',
      description: 'Abre um programa no Windows (chrome, discord, steam, vscode, bloco de notas, calculadora, explorador, configurações, gerenciador de tarefas, terminal, word, excel...). Para música use music_play, não abra o YouTube Music.',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      async run({ name }, ctx) {
        const key = name.toLowerCase().trim();

        // O YouTube Music precisa abrir com a porta de depuração: quem cuida disso é o cliente da música
        if (/youtube ?music|yt ?music/.test(key)) { await ctx.ytm.ensure(); return { ok: true }; }

        // 1) Atalho do Menu Iniciar (é o nome que o usuário conhece)
        const shortcut = findShortcut(key);
        if (shortcut) {
          const err = await shell.openPath(shortcut.file);
          return err ? { ok: false, error: err } : { ok: true, opened: shortcut.name };
        }
        // 2) Apelidos: protocolos, sites e executáveis do Windows
        const target = APP_ALIASES[key] || key;
        if (/^[a-z-]+:/.test(target)) { await shell.openExternal(target); return { ok: true }; }
        if (!/^[\w .\-]+$/i.test(target)) return { ok: false, error: 'nome de programa inválido' };
        // 3) Executável no PATH; checa antes, senão o Windows mostra um diálogo de erro e fica esperando
        if (!(await commandExists(target))) return { ok: false, error: `Programa "${name}" não encontrado` };
        // spawn desacoplado: com exec, o Node esperaria o programa aberto fechar
        return new Promise((resolve) => {
          const child = spawn('cmd.exe', ['/d', '/s', '/c', `"start "" "${target}""`], {
            detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true,
          });
          child.on('error', (e) => resolve({ ok: false, error: e.message }));
          child.on('exit', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: `Programa "${name}" não encontrado` }));
        });
      },
    },
    {
      name: 'open_url',
      description: 'Abre um site no navegador.',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      async run({ url }) {
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
        await shell.openExternal(url);
        return { ok: true };
      },
    },
    {
      name: 'open_search',
      description: 'Abre uma pesquisa no navegador para o usuário VER (Google ou vídeos do YouTube). Para você mesmo saber uma informação, use web_search.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' }, site: { type: 'string', enum: ['google', 'youtube'] } },
        required: ['query'],
      },
      async run({ query, site = 'google' }) {
        const url = site === 'youtube'
          ? `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`
          : `https://www.google.com/search?q=${encodeURIComponent(query)}`;
        await shell.openExternal(url);
        return { ok: true };
      },
    },
    {
      name: 'system_volume',
      description: 'Volume geral do Windows: aumentar, diminuir ou mutar/desmutar.',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['up', 'down', 'mute'] } }, required: ['action'] },
      async run({ action }) {
        if (action === 'up') pressKey(175, 5);
        else if (action === 'down') pressKey(174, 5);
        else pressKey(173);
        return { ok: true };
      },
    },
    {
      name: 'media_key',
      description: 'Tecla de mídia global do Windows (para players que não sejam o YouTube Music, ex: vídeo no navegador).',
      parameters: { type: 'object', properties: { key: { type: 'string', enum: ['play_pause', 'next', 'previous'] } }, required: ['key'] },
      async run({ key }) {
        pressKey({ play_pause: 179, next: 176, previous: 177 }[key]);
        return { ok: true };
      },
    },
    {
      name: 'screenshot',
      description: 'Tira um print da tela. Pelo PC, salva em Imagens/JARVIS; pelo Telegram, manda as imagens de todos os monitores na conversa.',
      parameters: { type: 'object', properties: {} },
      async run(_, ctx) {
        if (ctx.channel === 'telegram' && ctx.sendScreensToTelegram) {
          await ctx.sendScreensToTelegram();
          return { ok: true, sent_to_telegram: true, how_to_answer: 'Diga só que o print foi enviado (uma frase curta).' };
        }
        const file = await takeScreenshot();
        ctx.toast(`Print salvo em ${file}`);
        return { ok: true, file };
      },
    },
    {
      name: 'pc_power',
      description: 'Desliga, reinicia ou suspende (modo de espera) o computador, com contagem regressiva que pode ser cancelada. Use para "desliga o PC", "reinicia o computador", "desliga daqui a 30 minutos", "coloca o PC pra dormir". Funciona pelo PC e pelo Telegram.',
      parameters: {
        type: 'object',
        properties: {
          acao: { type: 'string', enum: ['desligar', 'reiniciar', 'suspender'] },
          minutos: { type: 'number', description: 'Daqui a quantos minutos (padrão 1; até 720)' },
        },
        required: ['acao'],
      },
      async confirm({ acao, minutos }) {
        const m = Math.max(0, Math.min(720, Number(minutos) || 1));
        const quando = m < 1 ? 'em 15 segundos' : m === 1 ? 'em 1 minuto' : `em ${m} minutos`;
        return `${acao === 'desligar' ? 'Desligar' : acao === 'reiniciar' ? 'Reiniciar' : 'Suspender'} o computador ${quando}. Programas com trabalho não salvo vão perguntar antes de fechar.`;
      },
      async run({ acao, minutos }, ctx) {
        const m = Math.max(0, Math.min(720, Number(minutos) || 1));
        const ms = Math.max(15000, Math.round(m * 60000));
        clearPower();
        const verbo = { desligar: 'Desligando', reiniciar: 'Reiniciando', suspender: 'Suspendendo' }[acao] || 'Desligando';
        const at = Date.now() + ms;
        power = { acao, at, timers: [] };
        const fmt = new Date(at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        // avisos antes da hora: 5 min, 1 min (para agendamentos longos) e 10 s
        for (const [before, text] of [[300000, `${verbo} o computador em 5 minutos, senhor.`], [60000, `${verbo} em 1 minuto. Diga "cancela" se precisar de mais tempo.`], [10000, `${verbo} em 10 segundos.`]]) {
          if (ms > before + 5000) power.timers.push(setTimeout(() => ctx.announce(text), ms - before));
        }
        power.timers.push(setTimeout(() => {
          ctx.announce(acao === 'reiniciar' ? 'Reiniciando. Volto em instantes, senhor.' : acao === 'suspender' ? 'Entrando em modo de espera.' : 'Desligando. Até logo, senhor.');
          ctx.notifyRemote?.(`${verbo} o PC agora.`, { phone: false });
          power.timers.push(setTimeout(() => {
            power = null;
            if (acao === 'suspender') {
              exec('powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState(\'Suspend\', $false, $false)"');
            } else exec(`shutdown ${acao === 'reiniciar' ? '/r' : '/s'} /t 0`); // sem /f: o Windows pergunta se houver algo não salvo
          }, 3500));
        }, ms));
        ctx.toast(`${verbo} às ${fmt}. Diga "cancela o desligamento" para abortar.`);
        return {
          ok: true, acao, horario: fmt, em_segundos: Math.round(ms / 1000),
          how_to_answer: `Confirme em uma frase com o horário (${fmt}) e diga que dá para cancelar dizendo "cancela o desligamento".`,
        };
      },
    },
    {
      name: 'pc_power_cancel',
      description: 'Cancela um desligamento, reinício ou suspensão agendado ("cancela", "não desliga", "aborta o desligamento").',
      parameters: { type: 'object', properties: {} },
      async run(_, ctx) {
        const had = !!power;
        clearPower();
        exec('shutdown /a'); // também cancela um desligamento agendado fora do JARVIS
        if (had) ctx.toast('Desligamento cancelado.');
        return { ok: true, cancelado: had, how_to_answer: had ? 'Confirme em poucas palavras que cancelou.' : 'Diga que não havia nada agendado.' };
      },
    },
    {
      name: 'lock_pc',
      description: 'Bloqueia o computador. NÃO existe desbloquear: por segurança o Windows só desbloqueia com a senha/PIN digitada no próprio PC. Se pedirem para desbloquear, explique isso e não chame esta ferramenta.',
      parameters: { type: 'object', properties: {} },
      async run() {
        exec('rundll32.exe user32.dll,LockWorkStation');
        return { ok: true };
      },
    },
  ],
};
