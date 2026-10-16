// Agentes de código: até 3 agentes (FRIDAY, EDITH, KAREN) trabalham em paralelo, cada um numa tarefa
// de programação, numa cópia isolada (git worktree). Nada vai para o projeto real sem aprovação do usuário.
// O progresso de cada um aparece ao vivo na Oficina.
//
// Segurança:
//  - todas as edições acontecem em data/worktrees/<id>, numa branch jarvis/...; a pasta do usuário não é tocada
//  - leitura/escrita só dentro da cópia (caminhos com .. ou absolutos são recusados)
//  - comandos: só verificação (testes, checagem de sintaxe, lint, build). Nada de instalar pacotes ou shell livre
const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const MAX_STEPS = 30;
const JUNK_PATHSPECS = [':(exclude,glob)**/__pycache__/**', ':(exclude,glob)**/*.pyc', ':(exclude,glob)**/.pytest_cache/**', ':(exclude,glob)**/node_modules/**', ':(exclude,glob)**/.mypy_cache/**'];
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', 'storage', '.pytest_cache', '.mypy_cache']);

// A equipe. "spoken" é como o JARVIS fala o nome em voz alta.
const AGENTS = [
  { id: 'friday', name: 'F.R.I.D.A.Y.', short: 'FRIDAY', spoken: 'Friday', color: '#e39a62', role: 'Engenheira de software' },
  { id: 'edith', name: 'E.D.I.T.H.', short: 'EDITH', spoken: 'Edith', color: '#7cc7a6', role: 'Engenheira de software' },
  { id: 'karen', name: 'K.A.R.E.N.', short: 'KAREN', spoken: 'Karen', color: '#a99be6', role: 'Engenheira de software' },
];
const agentOf = (j) => AGENTS.find((a) => a.id === j.agent) || AGENTS[0];

let ctxRef;
let jobs = []; // mais recentes por último

function run(cmd, args, cwd, timeout = 30000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${stdout || ''}${stderr || ''}`, timedOut: !!err?.killed });
    });
  });
}
const git = async (cwd, ...args) => {
  const r = await run('git', args, cwd);
  if (r.code !== 0) throw new Error(r.out.trim().slice(0, 300) || `git ${args[0]} falhou`);
  return r.out;
};

const jobsFile = () => path.join(ctxRef.dataDir, 'agent-jobs.json');
function publicJob(j) {
  if (!j) return null;
  const { messages, ...rest } = j;
  return rest;
}
// Trabalho que ainda "prende" o agente: rodando ou esperando aprovação (protótipo do laboratório não espera aprovação)
const isBusy = (j) => j.status === 'running' || (j.status === 'done' && j.files?.length && !j.lab);
// O laboratório (skills/lab.js) acompanha os trabalhos por aqui
const events = new (require('events'))();
function publish(job) {
  ctxRef.send('agent', publicJob(job));
  events.emit('update', job);
  // guarda as pendentes e as 15 mais recentes
  const keep = jobs.filter((j, i) => isBusy(j) || i >= jobs.length - 15);
  ctxRef.writeJson(jobsFile(), keep.map(publicJob));
}
function step(job, icon, text, extra = {}) {
  job.steps.push({ icon, text, at: Date.now(), ...extra });
  if (job.steps.length > 400) job.steps.splice(0, job.steps.length - 400);
  publish(job);
}

// Caminho dentro da cópia; recusa qualquer coisa que tente sair dela
function safePath(job, rel) {
  const full = path.resolve(job.worktree, rel || '.');
  if (full !== job.worktree && !full.startsWith(job.worktree + path.sep)) throw new Error('caminho fora do projeto');
  if (full.split(path.sep).includes('.git')) throw new Error('a pasta .git não pode ser acessada');
  return full;
}

// Os agentes dividem o limite de requisições da API da NVIDIA: espaça as chamadas
let nextSlot = 0;
async function apiGate() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + 1600;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

// ---------------------------------------------------------------- comandos permitidos

function splitArgs(cmd) {
  const out = [];
  cmd.replace(/"([^"]*)"|'([^']*)'|(\S+)/g, (_, a, b, c) => out.push(a ?? b ?? c));
  return out;
}

function allowed(argv) {
  const [bin, a1, a2] = argv.map((x) => (x || '').toLowerCase());
  if (/[|&;<>`$]/.test(argv.join(' '))) return false; // nada de encadear comandos
  if (['python', 'py', 'python3'].includes(bin)) return a1 === '-m' && ['pytest', 'py_compile', 'compileall', 'unittest', 'mypy', 'ruff', 'flake8'].includes(a2);
  if (['pytest', 'ruff', 'flake8', 'mypy'].includes(bin)) return true;
  if (bin === 'node') return a1 === '--check';
  if (bin === 'npm') return a1 === 'test' || (a1 === 'run' && ['test', 'lint', 'build', 'typecheck', 'check'].includes(a2));
  if (bin === 'npx') return ['tsc', 'eslint', 'vitest', 'jest', 'prettier'].includes(a1) && !argv.includes('--write');
  return false;
}

// ---------------------------------------------------------------- ferramentas do agente

const AGENT_TOOLS = [
  { name: 'list_dir', description: 'Lista arquivos e pastas (ignora .git, node_modules, venv...).', parameters: { type: 'object', properties: { path: { type: 'string' }, depth: { type: 'number' } } } },
  { name: 'read_file', description: 'Lê um arquivo (com números de linha). Arquivos grandes: use start_line/end_line.', parameters: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'number' }, end_line: { type: 'number' } }, required: ['path'] } },
  { name: 'search_code', description: 'Procura um texto/regex no código (git grep). Retorna arquivo:linha:conteúdo.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
  { name: 'edit_file', description: 'Substitui um trecho EXATO de um arquivo (old_text precisa aparecer uma única vez). Prefira isto a reescrever o arquivo inteiro.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] } },
  { name: 'write_file', description: 'Cria um arquivo novo (ou reescreve um inteiro).', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'run_command', description: 'Roda um comando de VERIFICAÇÃO: python -m pytest / py_compile / compileall / unittest, pytest, ruff, flake8, mypy, node --check, npm test, npm run test|lint|build|typecheck, npx tsc|eslint|vitest|jest.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'finish', description: 'Termina a tarefa. Resuma em português o que foi feito, arquivos alterados e como testar.', parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } },
].map((t) => ({ type: 'function', function: t }));

// Fase mostrada na Oficina, conforme a ferramenta usada
const PHASE = { list_dir: 'analisando', read_file: 'analisando', search_code: 'analisando', edit_file: 'escrevendo', write_file: 'escrevendo', run_command: 'testando' };

async function execTool(job, name, args) {
  const rel = (p) => path.relative(job.worktree, p).replace(/\\/g, '/') || '.';
  if (PHASE[name]) job.phase = PHASE[name];
  switch (name) {
    case 'list_dir': {
      const base = safePath(job, args.path);
      const maxDepth = Math.min(4, Math.max(1, args.depth || 2));
      const lines = [];
      const walk = (dir, depth, prefix) => {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
        for (const e of entries) {
          if (lines.length > 300) return;
          if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name) || e.name.startsWith('.vercel')) continue;
            lines.push(`${prefix}${e.name}/`);
            if (depth < maxDepth) walk(path.join(dir, e.name), depth + 1, prefix + '  ');
          } else lines.push(`${prefix}${e.name}`);
        }
      };
      walk(base, 1, '');
      step(job, '📂', `Listou ${rel(base)}`);
      return lines.join('\n') || '(vazio)';
    }
    case 'read_file': {
      const file = safePath(job, args.path);
      const content = fs.readFileSync(file, 'utf8');
      const all = content.split(/\r?\n/);
      const start = Math.max(1, args.start_line || 1);
      const end = Math.min(all.length, args.end_line || start + 399);
      step(job, '📄', `Leu ${rel(file)}${all.length > 400 ? ` (linhas ${start}-${end})` : ''}`);
      const body = all.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(4)}| ${l}`).join('\n');
      return `${rel(file)} (${all.length} linhas)\n${body}${end < all.length ? `\n... (mais ${all.length - end} linhas)` : ''}`;
    }
    case 'search_code': {
      const r = await run('git', ['grep', '-n', '-I', '-E', '--', args.pattern, ...(args.path ? [args.path] : [])], job.worktree);
      step(job, '🔎', `Buscou "${args.pattern}"`);
      const lines = r.out.split('\n').filter(Boolean);
      return lines.slice(0, 80).join('\n') + (lines.length > 80 ? `\n... (+${lines.length - 80} resultados)` : '') || 'nenhum resultado';
    }
    case 'edit_file': {
      const file = safePath(job, args.path);
      const content = fs.readFileSync(file, 'utf8');
      // No Windows o git costuma converter os arquivos para CRLF; o modelo escreve com LF
      if (content.includes('\r\n')) {
        args.old_text = args.old_text.replace(/\r?\n/g, '\r\n');
        args.new_text = args.new_text.replace(/\r?\n/g, '\r\n');
      }
      const count = content.split(args.old_text).length - 1;
      if (count === 0) return 'ERRO: old_text não encontrado. Leia o arquivo de novo e copie o trecho exato.';
      if (count > 1) return `ERRO: old_text aparece ${count} vezes. Inclua mais contexto para ficar único.`;
      fs.writeFileSync(file, content.replace(args.old_text, () => args.new_text));
      const delta = args.new_text.split('\n').length - args.old_text.split('\n').length;
      step(job, '✏', `Editou ${rel(file)}`, { delta, file: rel(file) });
      return 'ok';
    }
    case 'write_file': {
      const file = safePath(job, args.path);
      const existed = fs.existsSync(file);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, args.content);
      step(job, '📝', `${existed ? 'Reescreveu' : 'Criou'} ${rel(file)}`, { file: rel(file), lines: String(args.content).split('\n').length });
      return 'ok';
    }
    case 'run_command': {
      const argv = splitArgs(args.command || '');
      if (!argv.length || !allowed(argv)) {
        step(job, '⛔', `Comando recusado: ${args.command}`);
        return 'ERRO: comando não permitido. Use só comandos de verificação (testes, checagem de sintaxe, lint, build).';
      }
      step(job, '▶', `Rodando ${args.command}`, { running: true });
      const exe = process.platform === 'win32' && ['npm', 'npx'].includes(argv[0]) ? `${argv[0]}.cmd` : argv[0];
      const r = await new Promise((resolve) => {
        // PYTHONDONTWRITEBYTECODE: rodar os testes não deve sujar o projeto com __pycache__/*.pyc
        const p = spawn(exe, argv.slice(1), { cwd: job.worktree, windowsHide: true, shell: exe.endsWith('.cmd'), env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
        let out = '';
        const timer = setTimeout(() => { p.kill(); out += '\n[tempo esgotado: 3 min]'; }, 180000);
        p.stdout.on('data', (d) => { out += d; });
        p.stderr.on('data', (d) => { out += d; });
        p.on('error', (e) => { clearTimeout(timer); resolve({ code: 127, out: e.message }); });
        p.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
      });
      const last = [...job.steps].reverse().find((s) => s.running);
      if (last) Object.assign(last, { running: false, ok: r.code === 0, text: `${r.code === 0 ? 'Passou' : 'Falhou'}: ${args.command}` });
      publish(job);
      return `código de saída ${r.code}\n${r.out.slice(-3500)}`;
    }
    default:
      return `ERRO: ferramenta desconhecida ${name}`;
  }
}

// ---------------------------------------------------------------- execução

async function initialMessages(job) {
  const overview = await execTool(job, 'list_dir', { path: '.', depth: 2 });
  job.steps.pop(); // a listagem inicial não precisa aparecer como passo
  const log = await git(job.worktree, 'log', '-5', '--pretty=%h %s').catch(() => '');
  const facts = ctxRef.memory?.list().map((f) => f.text).slice(-10).join('; ');
  const a = agentOf(job);
  if (job.lab) {
    return [
      {
        role: 'system',
        content: `Você é ${a.name} (${a.short}), uma das agentes de código do JARVIS, no LABORATÓRIO: transformar uma ideia num protótipo (MVP) funcionando, rápido.
O usuário está olhando o protótipo no navegador AO VIVO: a página recarrega sozinha a cada arquivo que você salva.
Regras do laboratório:
1. Só HTML, CSS e JavaScript puros, abrindo direto pelo index.html na raiz. Sem npm, sem build, sem servidor próprio.
   Bibliotecas só por CDN (<script src="https://cdn.jsdelivr.net/npm/...">, unpkg ou cdnjs), versão fixa. Dados de exemplo realistas em português (nada de lorem ipsum).
   Dados que o usuário cria podem ficar no localStorage.
2. Escreva primeiro o index.html já com uma estrutura visível (ele está olhando), depois o CSS, depois o JS. Poucos arquivos: index.html, style.css, app.js (mais só se precisar).
3. Visual caprichado e moderno, responsivo, com um tema que combine com a ideia. Tudo clicável deve funcionar de verdade no protótipo.
4. Para mudanças pedidas depois, edite o que existe com edit_file (rápido) em vez de reescrever tudo.
5. Termine SEMPRE chamando finish. O summary começa com 1 ou 2 frases curtas para o JARVIS FALAR em voz alta apresentando o protótipo (o que dá para fazer nele), sem markdown; depois uma linha em branco e os detalhes.
Não peça confirmação: decida o mais razoável.${facts ? `\nSobre o usuário: ${facts}` : ''}`,
      },
      { role: 'user', content: `IDEIA: ${job.task}\n\nPasta do protótipo:\n${overview}` },
    ];
  }
  return [
    {
      role: 'system',
      content: `Você é ${a.name} (${a.short}), uma das agentes de código do JARVIS: uma engenheira de software sênior trabalhando no projeto "${job.project}".
Outras agentes podem estar trabalhando em outros projetos ao mesmo tempo; foque só na sua tarefa.
Você está numa cópia isolada do repositório (branch ${job.branch}); suas mudanças só vão para o projeto real se o usuário aprovar.
Como trabalhar:
1. Entenda antes de mexer: liste pastas, busque e leia os arquivos relevantes.
2. Faça mudanças pequenas, focadas e no estilo do código existente (nomes, formatação, idioma dos comentários).
3. Prefira edit_file a reescrever arquivos inteiros. Não mexa no que a tarefa não pede.
4. Verifique: rode testes ou checagem de sintaxe que existam no projeto (python -m py_compile arquivo.py, python -m pytest, node --check, npm test...). Se falhar por causa da sua mudança, corrija.
5. Termine SEMPRE chamando finish com um resumo em português: o que mudou, arquivos, e como testar.
Não peça confirmação ao usuário: ele não está acompanhando em tempo real. Se a tarefa for ambígua, tome a decisão mais razoável e explique no resumo.${job.newProject ? `
Este é um PROJETO NOVO (a pasta está vazia, só com README e .gitignore). Crie a estrutura completa com write_file (pastas são criadas automaticamente).
Você NÃO pode instalar dependências: escreva o package.json/requirements.txt corretamente e diga no resumo os comandos para instalar e rodar (ex: npm install && npm run dev).
Priorize um resultado que funcione de ponta a ponta; atualize o README com como rodar.` : ''}${facts ? `\nSobre o usuário: ${facts}` : ''}`,
    },
    { role: 'user', content: `TAREFA: ${job.task}\n\nEstrutura do projeto:\n${overview}\n\nÚltimos commits:\n${log}` },
  ];
}

async function agentLoop(job) {
  const maxSteps = job.newProject && !job.adjustments ? 80 : MAX_STEPS; // projeto novo tem muitos arquivos para criar
  for (let i = 0; i < maxSteps; i++) {
    if (job.status !== 'running') return;
    job.iter = (job.iter || 0) + 1;
    // Falha passageira do servidor da NVIDIA no meio da tarefa: espera e tenta de novo antes de desistir
    let r;
    for (let attempt = 0; ; attempt++) {
      await apiGate();
      try { r = await ctxRef.chatWithTools(job.messages, AGENT_TOOLS); break; } catch (e) {
        if (attempt >= 4 || !/API NVIDIA (429|5\d\d)/.test(e.message) || job.status !== 'running') throw e;
        step(job, '⏳', `Servidor da IA ocupado, tentando de novo em ${10 * (attempt + 1)} s...`);
        await new Promise((res) => setTimeout(res, 10000 * (attempt + 1)));
      }
    }
    if (job.status !== 'running') return;
    if (r.content.trim()) step(job, '💭', r.content.trim().slice(0, 300));
    if (!r.tool_calls.length) {
      job.messages.push({ role: 'assistant', content: r.content || '' });
      job.messages.push({ role: 'user', content: 'Continue a tarefa usando as ferramentas. Quando terminar, chame finish.' });
      continue;
    }
    job.messages.push({ role: 'assistant', content: r.content || null, tool_calls: r.tool_calls });
    for (const call of r.tool_calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch {}
      if (call.function.name === 'finish') {
        job.summary = args.summary || 'Tarefa concluída.';
        // deixa a conversa pronta caso o usuário peça um ajuste depois
        job.messages.push({ role: 'tool', tool_call_id: call.id, content: 'ok' });
        return;
      }
      let result;
      try { result = await execTool(job, call.function.name, args); } catch (e) { result = `ERRO: ${e.message}`; step(job, '⚠', e.message); }
      job.messages.push({ role: 'tool', tool_call_id: call.id, content: String(result).slice(0, 12000) });
    }
  }
  job.summary = `Parei depois de ${maxSteps} passos sem concluir totalmente. Veja o diff do que foi feito.`;
}

// Roda (ou retoma, num ajuste) o trabalho e prepara o diff para revisão
async function work(job) {
  const a = agentOf(job);
  try {
    if (!job.messages) job.messages = await initialMessages(job);
    await agentLoop(job);
    if (job.status !== 'running') return;
    job.phase = 'revisando';
    // Artefatos de build/cache nunca entram no commit, mesmo sem .gitignore no projeto
    await git(job.worktree, 'add', '-A', '--', '.', ...JUNK_PATHSPECS);
    const staged = (await git(job.worktree, 'diff', '--cached', '--name-only')).trim();
    if (staged) await git(job.worktree, '-c', 'user.name=JARVIS', '-c', `user.email=${a.id}@jarvis.local`, 'commit', '-m', `${a.short}: ${job.task.slice(0, 60)}`);
    // o diff é sempre contra o ponto de partida (inclui os ajustes)
    job.diffStat = (await git(job.worktree, 'diff', '--stat', job.base, 'HEAD')).trim();
    const diff = await git(job.worktree, 'diff', job.base, 'HEAD');
    job.diff = diff.length > 80000 ? diff.slice(0, 80000) + '\n... (diff cortado)' : diff;
    job.files = (await git(job.worktree, 'diff', '--name-status', job.base, 'HEAD')).trim().split('\n').filter(Boolean);
    job.status = 'done';
    job.phase = 'pronto';
    job.finishedAt = Date.now();
    // o laboratório (skills/lab.js) apresenta o protótipo por conta própria
    if (job.lab) { step(job, '✔', 'Protótipo pronto'); return; }
    if (!job.files.length) job.summary = `${job.summary}\n\n(Nenhum arquivo foi alterado.)`;
    step(job, '✔', job.files.length ? 'Pronto para revisão' : 'Concluído sem alterar arquivos');
    ctxRef.projectMemory?.log(job.project, `${a.short}: ${job.summary.split('\n')[0].slice(0, 250)} (${job.files.length} arquivos, aguardando aprovação)`, 'agente');
    const what = job.newProject && !job.adjustments ? `terminou de criar o ${job.project}` : `terminou a tarefa no ${job.project}`;
    const msg = job.files.length
      ? `${a.spoken} ${what}: ${job.files.length} arquivo${job.files.length > 1 ? 's' : ''}. Está esperando sua aprovação na Oficina.`
      : `${a.spoken} ${what}, mas não precisou alterar arquivos. O resumo está na Oficina.`;
    ctxRef.announce(`${ctxRef.config.userName}, ${msg}`, { phone: true });
    // No Telegram, aprovar ou descartar direto pelos botões
    ctxRef.notifyRemote(`🛠 <b>${a.short}</b> · ${msg}\n\n${job.summary.slice(0, 1500)}${job.diffStat ? `\n\n${job.diffStat.slice(-600)}` : ''}`, {
      phone: false,
      buttons: job.files.length ? [
        [{ text: '✅ Aplicar', data: `agent:accept:${job.id}` }, { text: '🗑 Descartar', data: `agent:discard:${job.id}` }],
        [{ text: '📄 Ver diff', data: `agent:diff:${job.id}` }],
      ] : undefined,
    });
  } catch (e) {
    if (job.status !== 'running') return;
    job.status = 'failed';
    job.phase = 'falhou';
    job.error = e.message;
    job.finishedAt = Date.now();
    step(job, '✗', `Falhou: ${e.message}`);
    ctxRef.announce(`${ctxRef.config.userName}, ${a.spoken} falhou ${job.lab ? 'no protótipo' : `na tarefa do ${job.project}`}: ${e.message.slice(0, 120)}`);
  }
  publish(job);
}

// Projeto novo: pasta em projectsDir com um repositório git e um commit inicial
// (o agente trabalha numa branch a partir dele, e o "Aplicar" faz o merge como nos outros projetos)
async function createProject(name, ctx) {
  const slug = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  if (!slug) throw new Error('Nome de projeto inválido');
  const dir = path.join(ctx.config.projectsDir, slug);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`Já existe uma pasta "${slug}" em ${ctx.config.projectsDir}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n\nProjeto criado pelo JARVIS.\n`);
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\ndist/\nbuild/\n.venv/\nvenv/\n__pycache__/\n*.pyc\n.env\n');
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'add', '-A');
  await git(dir, '-c', 'user.name=JARVIS', '-c', 'user.email=jarvis@local', 'commit', '-m', 'Projeto criado pelo JARVIS');
  return { name: slug, path: dir, kinds: ['git'] };
}

// Sessão temporária do laboratório: um repositório descartável em data/lab/<id>
async function createLabRepo(idea) {
  const id = Date.now().toString(36);
  const dir = path.join(ctxRef.dataDir, 'lab', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), `# Protótipo do laboratório do JARVIS\n\nIdeia: ${idea}\n`);
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'add', '-A');
  await git(dir, '-c', 'user.name=JARVIS', '-c', 'user.email=jarvis@local', 'commit', '-m', 'Laboratório');
  return { name: 'laboratório', path: dir, kinds: ['git'] };
}

// Escolhe a agente: a pedida (se estiver livre) ou a primeira livre
const reserved = new Set(); // escolhidas, mas com o trabalho ainda sendo preparado (criando pasta/worktree)
function pickAgent(wanted) {
  const busy = new Set([...jobs.filter(isBusy).map((j) => j.agent), ...reserved]);
  if (wanted) {
    const a = AGENTS.find((x) => x.id === wanted.toLowerCase().replace(/[^a-z]/g, ''));
    if (!a) throw new Error(`Não conheço a agente "${wanted}". A equipe: ${AGENTS.map((x) => x.short).join(', ')}`);
    if (busy.has(a.id)) {
      const j = jobs.find((x) => x.agent === a.id && isBusy(x));
      throw new Error(`${a.short} está ocupada com "${j.task.slice(0, 60)}" (${j.status === 'running' ? 'trabalhando' : 'esperando aprovação'})`);
    }
    return a;
  }
  const free = AGENTS.find((a) => !busy.has(a.id));
  if (!free) throw new Error('As 3 agentes estão ocupadas (trabalhando ou esperando aprovação). Aprove ou descarte algum trabalho na Oficina primeiro.');
  return free;
}

async function startJob(project, task, origin, { newProject = false, agent, lab = false }) {
  const a = AGENTS.find((x) => x.id === agent);
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
  const slug = task.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').slice(0, 30).replace(/^-|-$/g, '');
  const worktree = path.join(ctxRef.dataDir, 'worktrees', id);
  const job = {
    id, agent: a.id, origin, newProject, lab, project: project.name, projectPath: project.path, task, branch: `jarvis/${a.id}-${slug}-${id.slice(-4)}`, worktree,
    status: 'running', phase: 'preparando', iter: 0, expected: lab ? 12 : newProject ? 45 : 16, adjustments: 0,
    steps: [], startedAt: Date.now(), summary: '', diffStat: '', diff: '', files: [],
  };
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  await git(project.path, 'worktree', 'add', '-b', job.branch, worktree, 'HEAD');
  job.base = (await git(worktree, 'rev-parse', 'HEAD')).trim();
  jobs.push(job);
  step(job, '⎇', `Cópia isolada criada na branch ${job.branch}`);
  work(job).catch((e) => console.error('[agente]', e));
  return job;
}

async function cleanup(job) {
  await git(job.projectPath, 'worktree', 'remove', '--force', job.worktree).catch(() => {});
  await git(job.projectPath, 'branch', '-D', job.branch).catch(() => {});
  await git(job.projectPath, 'worktree', 'prune').catch(() => {});
}

// Acha o trabalho por id, nome da agente ou projeto; sem referência, o único que combina com o filtro
function findJob(ref, filter = isBusy) {
  if (ref) {
    const r = String(ref).toLowerCase().replace(/[^a-z0-9-]/g, '');
    const byId = jobs.find((j) => j.id === ref);
    if (byId) return byId;
    const cands = jobs.filter((j) => j.agent === r || j.project.toLowerCase() === r);
    const j = cands.filter(filter).pop() || cands.pop();
    if (!j) throw new Error(`Não achei trabalho de "${ref}"`);
    return j;
  }
  const list = jobs.filter(filter);
  if (list.length === 1) return list[0];
  if (!list.length) throw new Error('Não há trabalho nessa situação');
  throw new Error(`Qual delas? ${list.map((j) => `${agentOf(j).short} (${j.project})`).join(', ')}`);
}
const awaiting = (j) => j.status === 'done' && j.files?.length && !j.lab;

// ---------------------------------------------------------------- API (interface, Telegram)

const api = {
  agents: () => AGENTS,
  list: () => jobs.map(publicJob),
  get: (id) => publicJob(jobs.find((j) => j.id === id)),
  async start({ project, newProject, task, agent, origin = 'pc', lab = false }) {
    if (!task?.trim()) throw new Error('Descreva a tarefa');
    const a = pickAgent(agent); // falha antes de criar pasta se não houver agente livre
    reserved.add(a.id);
    try {
      const p = lab ? await createLabRepo(task) : newProject ? await createProject(newProject, ctxRef) : ctxRef.resolveProject(project);
      if (!p.kinds.includes('git')) throw new Error('O projeto precisa ser um repositório git');
      const job = await startJob(p, task.trim(), origin, { newProject: !!newProject, agent: a.id, lab });
      return { job: publicJob(job), project: p };
    } finally { reserved.delete(a.id); }
  },
  async accept(ref) {
    const job = findJob(ref, awaiting);
    if (!awaiting(job)) throw new Error('Esse trabalho não está esperando aprovação');
    const r = await run('git', ['merge', '--no-ff', '-m', `Merge ${job.branch}: ${job.task.slice(0, 60)}`, job.branch], job.projectPath, 60000);
    if (r.code !== 0) {
      await run('git', ['merge', '--abort'], job.projectPath);
      throw new Error(`Não consegui aplicar (talvez você tenha mudanças não commitadas nos mesmos arquivos): ${r.out.trim().slice(0, 200)}`);
    }
    await cleanup(job);
    job.status = 'accepted';
    job.phase = 'aplicado';
    job.messages = null;
    step(job, '✅', 'Mudanças aplicadas no projeto');
    ctxRef.projectMemory?.log(job.project, `Aplicado o trabalho da ${agentOf(job).short}: ${job.task.slice(0, 160)}`, 'agente');
    return { ok: true, files: job.files.length, agent: agentOf(job).short, project: job.project };
  },
  async discard(ref) {
    const job = findJob(ref, (j) => ['done', 'failed', 'running'].includes(j.status));
    if (!['done', 'failed', 'running'].includes(job.status)) throw new Error('Não há tarefa para descartar');
    job.status = 'discarded';
    job.phase = 'descartado';
    job.messages = null;
    await cleanup(job);
    // a sessão do laboratório é temporária (o git às vezes ainda segura arquivos por um instante: tenta de novo)
    if (job.lab) try { fs.rmSync(job.projectPath, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 }); } catch (e) { console.error('[lab] limpeza', e.message); }
    step(job, '🗑', job.lab ? 'Laboratório encerrado' : 'Tarefa descartada');
    return { ok: true, agent: agentOf(job).short, project: job.project };
  },
  // Pedido de ajuste: a mesma agente continua no mesmo código, com a conversa anterior
  async adjust(ref, request) {
    if (!request?.trim()) throw new Error('Diga o que ajustar');
    const job = findJob(ref, (j) => j.status === 'done' || j.status === 'failed');
    if (!['done', 'failed'].includes(job.status)) throw new Error('Só dá para ajustar um trabalho que terminou');
    if (!fs.existsSync(job.worktree)) throw new Error('A cópia de trabalho não existe mais');
    if (!job.messages) {
      // o JARVIS reiniciou e a conversa se perdeu: recomeça com o contexto do que já foi feito
      job.messages = await initialMessages(job);
      job.messages[1].content += `\n\nVocê JÁ trabalhou nesta tarefa antes. Resumo do que fez: ${job.summary || '(sem resumo)'}`;
    }
    job.messages.push({ role: 'user', content: `AJUSTE pedido pelo usuário: ${request.trim()}\nFaça o ajuste no mesmo código e chame finish com um resumo do que mudou${job.lab ? ' (começando com 1 frase curta para o JARVIS falar, sem markdown)' : ''}.` });
    job.adjustments = (job.adjustments || 0) + 1;
    Object.assign(job, { status: 'running', phase: 'analisando', error: undefined, iter: 0, expected: 10 });
    step(job, '↻', `Ajuste: ${request.trim().slice(0, 200)}`, { adjust: true });
    work(job).catch((e) => console.error('[agente]', e));
    return { ok: true, agent: agentOf(job).short, project: job.project };
  },
  openInCode(ref) {
    const job = ref ? findJob(ref, () => true) : jobs[jobs.length - 1];
    if (!job || !fs.existsSync(job.worktree)) throw new Error('A cópia de trabalho não existe mais');
    spawn('cmd.exe', ['/d', '/s', '/c', `"code "${job.worktree}""`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
  },
  // Some com trabalhos já resolvidos da lista (o histórico continua no arquivo até sair dos 15)
  clear(id) {
    const i = jobs.findIndex((j) => j.id === id && !isBusy(j));
    if (i >= 0) { jobs[i].hidden = true; publish(jobs[i]); }
  },
};

const AGENT_PARAM = { type: 'string', enum: AGENTS.map((a) => a.short), description: 'Agente específica (opcional)' };

module.exports = {
  name: 'codeagent',
  api,
  events,
  init(ctx) {
    ctxRef = ctx;
    const saved = ctx.readJson(jobsFile(), []);
    // formato antigo: um único trabalho
    jobs = (Array.isArray(saved) ? saved : saved ? [saved] : []).filter(Boolean);
    for (const j of jobs) {
      if (!j.agent) j.agent = 'friday';
      // Se o JARVIS fechou no meio de uma tarefa, ela não continua sozinha
      if (j.status === 'running') { j.status = 'failed'; j.phase = 'falhou'; j.error = 'O JARVIS foi fechado durante a tarefa (peça um ajuste para continuar)'; }
      // sessões do laboratório não sobrevivem a um reinício
      if (j.lab && j.status !== 'discarded') {
        Object.assign(j, { status: 'discarded', phase: 'descartado', hidden: true });
        cleanup(j).then(() => fs.rmSync(j.projectPath, { recursive: true, force: true })).catch(() => {});
      }
    }
    // sobras de sessões do laboratório que não foram apagadas
    const labDir = path.join(ctx.dataDir, 'lab');
    try { for (const d of fs.readdirSync(labDir)) fs.rmSync(path.join(labDir, d), { recursive: true, force: true, maxRetries: 3 }); } catch {}
  },
  tools: [
    {
      name: 'code_task',
      description: `Equipe de agentes de código (${AGENTS.map((a) => a.short).join(', ')}): cada uma executa uma tarefa de programação em paralelo (criar endpoint, corrigir bug, refatorar, testes...) num projeto existente OU cria um PROJETO NOVO (new_project com o nome da pasta, ex: "petshop"). Para DOIS OU MAIS projetos/tarefas, chame esta ferramenta uma vez para cada (uma agente por projeto, trabalham ao mesmo tempo). Trabalham em segundo plano em cópias isoladas, o progresso aparece na Oficina; nada é aplicado sem aprovação.`,
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Nome de um projeto existente; omita para o projeto atual' },
          new_project: { type: 'string', description: 'Para criar um projeto NOVO: nome curto da pasta (ex: "petshop"). Não use project junto.' },
          task: { type: 'string', description: 'A tarefa em detalhes, como o usuário pediu' },
          agent: AGENT_PARAM,
        },
        required: ['task'],
      },
      async run({ project, new_project: newProject, task, agent }, ctx) {
        let res;
        try { res = await api.start({ project, newProject, task, agent, origin: ctx.channel }); } catch (e) { return { ok: false, error: e.message }; }
        const a = agentOf(res.job);
        // mostra a Oficina (se ela já está aberta no outro monitor, não mexe na tela principal)
        if (!ctx.oficinaWindowOpen?.()) ctx.send('navigate', 'oficina');
        const changed = newProject ? 0 : (await run('git', ['status', '--porcelain'], res.project.path)).out.trim().split('\n').filter(Boolean).length;
        return {
          ok: true, started: true, agent: a.short, project: res.project.name, created_project: newProject ? res.project.path : undefined,
          working_tree_has_uncommitted_changes: changed > 0 || undefined,
          how_to_answer: `Diga em 1 frase que ${a.spoken} assumiu ${newProject ? `o projeto novo ${res.project.name}` : `a tarefa no ${res.project.name}`}, que dá para acompanhar na Oficina e que você avisa quando terminar.${changed ? ' Avise que a cópia parte do último commit (há mudanças não commitadas).' : ''} Se houver mais de uma tarefa, junte tudo numa resposta só.`,
        };
      },
    },
    {
      name: 'code_task_status',
      description: 'Diz o que cada agente de código está fazendo (progresso, o que terminou, o que espera aprovação).',
      parameters: { type: 'object', properties: {} },
      async run() {
        const list = jobs.filter((j) => !j.hidden && (isBusy(j) || ['failed'].includes(j.status) || Date.now() - (j.finishedAt || j.startedAt) < 3600000));
        if (!list.length) return { active: false, team: AGENTS.map((a) => a.short), note: 'Todas livres' };
        return {
          agents: list.map((j) => ({
            agent: agentOf(j).short, project: j.project, task: j.task, status: j.status, phase: j.phase,
            last_steps: j.steps.slice(-3).map((s) => s.text), summary: j.summary?.slice(0, 400) || undefined, files: j.files?.length || 0,
          })),
          free: AGENTS.filter((a) => !jobs.some((j) => j.agent === a.id && isBusy(j))).map((a) => a.short),
        };
      },
    },
    {
      name: 'code_task_accept',
      description: 'Aplica no projeto as mudanças feitas por uma agente de código (merge da branch).',
      parameters: { type: 'object', properties: { agent: AGENT_PARAM, project: { type: 'string' } } },
      async confirm({ agent, project }) {
        try {
          const j = findJob(agent || project, awaiting);
          if (!awaiting(j)) return { error: 'Esse trabalho não está esperando aprovação' };
          return `Aplicar ${j.files.length} arquivo(s) da ${agentOf(j).short} no ${j.project} (merge da branch ${j.branch})`;
        } catch (e) { return { error: e.message }; }
      },
      async run({ agent, project }) { return api.accept(agent || project); },
    },
    {
      name: 'code_task_discard',
      description: 'Descarta (ou cancela, se ainda estiver rodando) o trabalho de uma agente de código.',
      parameters: { type: 'object', properties: { agent: AGENT_PARAM, project: { type: 'string' } } },
      async run({ agent, project }) { return api.discard(agent || project); },
    },
    {
      name: 'code_task_adjust',
      description: 'Pede um ajuste num trabalho que uma agente terminou (ex: "deixa o tema azul", "adiciona página de contato"). A mesma agente continua no mesmo código.',
      parameters: { type: 'object', properties: { agent: AGENT_PARAM, project: { type: 'string' }, request: { type: 'string', description: 'O ajuste pedido' } }, required: ['request'] },
      async run({ agent, project, request }) { return api.adjust(agent || project, request); },
    },
  ],
};
