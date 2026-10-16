// Codex (OpenAI) a serviço do JARVIS: abre o projeto no VS Code e manda o Codex fazer o pedido.
// O Codex roda pelo próprio executável que vem na extensão do VS Code (mesma conta e mesmo config.toml), em modo
// não interativo (codex exec --json). O JARVIS acompanha os eventos ao vivo (o que o Codex diz, arquivos que cria,
// comandos que roda), avisa por voz quando termina e guarda a conversa para pedidos de ajuste ("agora deixa azul").
// As conversas também aparecem no histórico de Chats do Codex no VS Code (thread-source vscode).
//
// Não usamos o painel do Codex por automação de teclado: o campo de texto da extensão nem sempre recebe o foco
// (tutorial de boas-vindas, barra de menus ativada pelo ALT, janela em outro monitor), e o deep link não aceita prompt.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_EVENTS = 40;
const WORK_TIMEOUT = 60 * 60 * 1000; // um pedido não roda mais que 1 h

const jobs = [];             // { id, project, path, prompt, state, startedAt, endedAt, threadId, files, events, summary, error, proc }
const threads = new Map();   // pasta do projeto (minúsculas) -> threadId da última conversa com o Codex

// Sem as variáveis do VS Code/Electron: quando o JARVIS é iniciado pelo terminal do VS Code (npm start), elas
// vazam para os filhos (o "code" passa a falar com a instância errada e não abre a janela).
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(VSCODE_|ELECTRON_|CHROME_CRASHPAD)/i.test(k)) delete env[k];
  return env;
}

// O codex.exe da extensão mais recente do VS Code (ela se atualiza sozinha); senão, um "codex" no PATH
function findCodex() {
  const dir = path.join(os.homedir(), '.vscode', 'extensions');
  let candidates = [];
  try {
    candidates = fs.readdirSync(dir)
      .filter((n) => /^openai\.chatgpt-.*win32-x64$/i.test(n))
      .map((n) => path.join(dir, n, 'bin', 'windows-x86_64', 'codex.exe'))
      .filter((p) => fs.existsSync(p))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  } catch {}
  return candidates[0] || 'codex';
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 30000, ...opts }, (err, stdout, stderr) => {
      if (err) { err.message = (stderr || err.message).toString().trim(); return reject(err); }
      resolve(stdout.toString());
    });
  });
}

async function createProject(name, ctx) {
  const slug = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  if (!slug) throw new Error('Nome de projeto inválido');
  const dir = path.join(ctx.config.projectsDir, slug);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`Já existe uma pasta "${slug}" em ${ctx.config.projectsDir}`);
  fs.mkdirSync(dir, { recursive: true });
  // o Codex trabalha dentro de um repositório git (e assim dá para ver/desfazer o que ele mudou)
  await run('git', ['init', '-b', 'main'], { cwd: dir }).catch(() => {});
  ctx.config.currentProject = dir;
  ctx.saveConfig();
  return { name: slug, path: dir };
}

function openVsCode(dir) {
  spawn('cmd.exe', ['/d', '/s', '/c', `"code "${dir}""`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true, env: cleanEnv() }).unref();
}

const rel = (job, p) => path.relative(job.path, p).replace(/\\/g, '/') || p;

function spokenSummary(text, max = 220) {
  const plain = String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > 60 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, '')}...`;
}

function log(job, text) {
  job.events.push({ at: Date.now(), text });
  if (job.events.length > MAX_EVENTS) job.events.shift();
}

// Um evento JSONL do "codex exec --json"
function onEvent(job, ev, ctx) {
  if (ev.type === 'thread.started') {
    job.threadId = ev.thread_id;
    threads.set(job.path.toLowerCase(), ev.thread_id);
    return;
  }
  if (ev.type === 'turn.completed') { job.completed = true; return; }
  if (ev.type === 'turn.failed' || ev.type === 'error') { job.error = ev.error?.message || ev.message || 'erro no Codex'; return; }
  const item = ev.item;
  if (!item || ev.type !== 'item.completed') return;
  if (item.type === 'agent_message') {
    job.summary = item.text;
    log(job, `💬 ${spokenSummary(item.text, 140)}`);
  } else if (item.type === 'file_change') {
    for (const c of item.changes || []) {
      const f = rel(job, c.path);
      if (!job.files.includes(f)) job.files.push(f);
      const verb = c.kind === 'add' ? 'criou' : c.kind === 'delete' ? 'apagou' : 'editou';
      log(job, `📄 ${verb} ${f}`);
      ctx.toast(`Codex ${verb} ${f}`);
    }
  } else if (item.type === 'command_execution') {
    log(job, `⚙ ${String(item.command || '').slice(0, 120)}`);
  }
}

function startJob(proj, prompt, ctx, resumeThread) {
  const job = {
    id: jobs.length + 1, project: path.basename(proj.path), path: proj.path, prompt, state: 'trabalhando',
    startedAt: Date.now(), threadId: resumeThread || null, files: [], events: [], summary: '', error: '', completed: false,
  };
  jobs.push(job);

  // sandbox: o Codex só escreve dentro da pasta do projeto; rede liberada para npm/pip install
  const config = ['-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.network_access=true'];
  const args = resumeThread
    ? ['exec', 'resume', '--json', '--skip-git-repo-check', '--thread-source', 'vscode', ...config, resumeThread, '-']
    : ['exec', '--json', '--skip-git-repo-check', '--thread-source', 'vscode', ...config, '-C', proj.path, '-'];
  const proc = spawn(findCodex(), args, { cwd: proj.path, windowsHide: true, env: cleanEnv() });
  job.proc = proc;
  proc.stdin.end(prompt);

  let buf = '';
  let stderr = '';
  proc.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('{')) continue;
      try { onEvent(job, JSON.parse(line), ctx); } catch (e) { console.error('[codex] evento inválido:', e.message); }
    }
  });
  proc.stderr.on('data', (d) => { stderr = (stderr + d.toString('utf8')).slice(-2000); });
  const timer = setTimeout(() => { job.error = 'passou de 1 hora'; kill(job); }, WORK_TIMEOUT);

  proc.on('error', (e) => { job.error = e.code === 'ENOENT' ? 'não achei o Codex (instale a extensão do Codex no VS Code)' : e.message; });
  proc.on('close', (code) => {
    clearTimeout(timer);
    job.proc = null;
    job.endedAt = Date.now();
    if (job.state === 'cancelado') return;
    if (job.completed && !job.error) {
      job.state = 'concluido';
      const resumo = spokenSummary(job.summary);
      ctx.announce(`O Codex terminou no ${job.project}.${resumo ? ` ${resumo}` : ''}`);
      ctx.projectMemory?.log(job.project, `Codex: ${spokenSummary(job.summary, 300) || job.prompt}${job.files.length ? ` (${job.files.length} arquivos)` : ''}`, 'codex');
      const files = job.files.length ? `\n\nArquivos: ${job.files.slice(0, 15).join(', ')}` : '';
      const text = String(job.summary).replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').slice(0, 1200);
      ctx.notifyRemote(`✅ Codex terminou no ${job.project}\n\n${text}${files}`, { phone: false });
    } else {
      job.state = 'falhou';
      job.error = job.error || stderr.trim().split('\n').pop() || `o Codex saiu com código ${code}`;
      console.error(`[codex] falhou no ${job.project}:`, job.error);
      ctx.announce(`O Codex não conseguiu terminar no ${job.project}: ${spokenSummary(job.error, 160)}`);
    }
  });
  return job;
}

function kill(job) {
  if (!job.proc) return;
  // /T: derruba também os comandos que o Codex abriu (npm, python...)
  execFile('taskkill', ['/PID', String(job.proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
}

const running = () => jobs.filter((j) => j.state === 'trabalhando');

function findJob(project) {
  const want = String(project || '').toLowerCase();
  const list = running();
  return (want ? list.find((j) => j.project.toLowerCase().includes(want)) : null) || list[list.length - 1];
}

function describe(j) {
  const secs = Math.round(((j.endedAt || Date.now()) - j.startedAt) / 1000);
  return {
    projeto: j.project,
    pedido: j.prompt.slice(0, 160),
    estado: j.state,
    tempo: secs < 60 ? `${secs}s` : `${Math.round(secs / 60)} min`,
    arquivos: j.files.slice(0, 20),
    ultimos_passos: j.events.slice(-6).map((e) => e.text),
    resumo: j.state === 'concluido' ? spokenSummary(j.summary, 500) : undefined,
    erro: j.error || undefined,
  };
}

module.exports = {
  name: 'codex',
  tools: [
    {
      name: 'codex_task',
      description: 'Manda o CODEX (agente de programação da OpenAI) criar ou mudar algo: o JARVIS abre o projeto no VS Code e o Codex trabalha nele sozinho (cria arquivos, roda comandos); o JARVIS avisa por voz quando ele terminar. Use quando o usuário falar em Codex ("pede pro Codex...", "abre o Codex e cria..."). Projeto novo: passe new_project com o nome da pasta. Ajuste no que o Codex acabou de fazer ("agora deixa o botão azul"): follow_up=true para continuar a mesma conversa. Escreva "task" como um pedido completo e claro, em português, com todos os detalhes que o usuário deu. (Sem menção ao Codex, use code_task.)',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'O pedido para o Codex, completo e detalhado' },
          project: { type: 'string', description: 'Nome de um projeto existente (vazio = projeto atual)' },
          new_project: { type: 'string', description: 'Nome da pasta de um projeto NOVO a criar (ex: "site-petshop")' },
          follow_up: { type: 'boolean', description: 'true = continua a última conversa do Codex nesse projeto (ajustes/correções)' },
        },
        required: ['task'],
      },
      async run({ task, project, new_project, follow_up }, ctx) {
        if (!task || !task.trim()) throw new Error('Qual é o pedido para o Codex?');
        const proj = new_project ? await createProject(new_project, ctx) : ctx.resolveProject(project);
        const name = path.basename(proj.path);
        if (running().some((j) => j.path.toLowerCase() === proj.path.toLowerCase())) {
          throw new Error(`O Codex ainda está trabalhando no ${name}. Espere ele terminar ou cancele antes de mandar outro pedido.`);
        }
        const thread = follow_up ? threads.get(proj.path.toLowerCase()) : null;
        openVsCode(proj.path);
        startJob(proj, task.trim(), ctx, thread);
        ctx.toast(`Codex trabalhando no ${name}...`);
        return {
          ok: true,
          project: name,
          path: proj.path,
          new_project: !!new_project,
          continuing: !!thread,
          message: `VS Code aberto em ${name} e o Codex já está trabalhando${thread ? ' (continuando a conversa anterior)' : ''}. Vou avisar quando ele terminar.`,
        };
      },
    },
    {
      name: 'codex_status',
      description: 'Diz o que o Codex está fazendo ou fez: projeto, tempo, arquivos criados/editados, últimos passos e o resumo final.',
      parameters: { type: 'object', properties: {} },
      run() {
        if (!jobs.length) return { jobs: [], message: 'Nenhum pedido enviado ao Codex nesta sessão.' };
        return { jobs: jobs.slice(-5).map(describe) };
      },
    },
    {
      name: 'codex_cancel',
      description: 'Para o Codex no meio do trabalho (o que ele já mudou nos arquivos continua lá).',
      parameters: { type: 'object', properties: { project: { type: 'string', description: 'Projeto (vazio = o mais recente)' } } },
      run({ project }) {
        const job = findJob(project);
        if (!job) return { ok: false, error: 'O Codex não está trabalhando em nada agora.' };
        job.state = 'cancelado';
        job.endedAt = Date.now();
        kill(job);
        return { ok: true, project: job.project, files_changed: job.files };
      },
    },
  ],
};
