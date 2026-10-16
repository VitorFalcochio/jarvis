// Ferramentas de programador: projetos, VS Code, git, GitHub, portas/processos e Docker.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['node_modules', 'build', 'dist', '__pycache__', '.venv', 'venv', 'storage', 'build-tmp', 'target', 'bin', 'obj']);
const MARKERS = ['.git', 'package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'composer.json'];

const normalize = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) { err.message = (stderr || err.message).trim(); return reject(err); }
      resolve(stdout.toString());
    });
  });
}
const git = (cwd, ...args) => run('git', args, { cwd });

// Abre um comando numa janela de terminal nova, visível para o usuário
function openTerminal(cwd, title, command) {
  const line = `"start "${title}" cmd /k "cd /d "${cwd}" && ${command}""`;
  spawn('cmd.exe', ['/d', '/s', '/c', line], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
}

// ---------------------------------------------------------------- projetos

function findProjects(root) {
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const names = new Set(entries.map((e) => e.name));
    if (depth > 0 && MARKERS.some((m) => names.has(m))) {
      const kinds = [];
      if (names.has('.git')) kinds.push('git');
      if (names.has('package.json')) kinds.push('node');
      if (names.has('pyproject.toml') || names.has('requirements.txt')) kinds.push('python');
      if ([...names].some((n) => /^(docker-compose|compose)\.ya?ml$/.test(n))) kinds.push('docker');
      out.push({ name: path.basename(dir), path: dir, kinds });
      return; // não procura subprojetos dentro de um projeto
    }
    if (depth >= 3) return;
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

function resolveProject(name, ctx) {
  const projects = findProjects(ctx.config.projectsDir);
  if (!projects.length) throw new Error(`Nenhum projeto encontrado em ${ctx.config.projectsDir}`);
  const target = normalize(name);
  let pick = null;
  if (target) {
    let best = 0;
    for (const p of projects) {
      const n = normalize(p.name);
      const score = n === target ? 100 : n.startsWith(target) || target.startsWith(n) ? 60 : n.includes(target) || target.includes(n) ? 40
        : target.split(' ').filter((w) => w.length > 2 && n.includes(w)).length * 10;
      if (score > best) { best = score; pick = p; }
    }
    if (!pick) throw new Error(`Projeto "${name}" não encontrado. Projetos: ${projects.map((p) => p.name).join(', ')}`);
  } else {
    pick = projects.find((p) => p.path === ctx.config.currentProject) || (projects.length === 1 ? projects[0] : null);
    if (!pick) throw new Error(`Qual projeto? Opções: ${projects.map((p) => p.name).join(', ')}`);
  }
  if (ctx.config.currentProject !== pick.path) { ctx.config.currentProject = pick.path; ctx.saveConfig(); }
  return pick;
}

function listRunnables(p) {
  const out = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(p.path, 'package.json'), 'utf8'));
    for (const s of Object.keys(pkg.scripts || {})) out.push({ id: s, command: `npm run ${s}` });
  } catch {}
  for (const f of ['start.bat', 'run.bat', 'dev.bat']) {
    if (fs.existsSync(path.join(p.path, f))) out.push({ id: f.replace('.bat', ''), command: f });
  }
  if (fs.existsSync(path.join(p.path, 'manage.py'))) out.push({ id: 'runserver', command: 'python manage.py runserver' });
  return out;
}

// ---------------------------------------------------------------- portas e processos

async function listeningPorts() {
  const out = await run('netstat', ['-ano', '-p', 'tcp']);
  const map = new Map();
  for (const line of out.split('\n')) {
    // "  TCP    0.0.0.0:8000    0.0.0.0:0    LISTENING    1234" (ESCUTANDO em alguns Windows pt-BR)
    const m = line.trim().match(/^TCP\s+(\S+):(\d+)\s+\S+\s+(\S+)\s+(\d+)$/);
    if (!m || !/^(LISTENING|ESCUTANDO)$/i.test(m[3])) continue;
    const port = Number(m[2]);
    if (!map.has(port)) map.set(port, { port, pid: Number(m[4]), address: m[1] });
  }
  return [...map.values()];
}

async function processName(pid) {
  try {
    const out = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    return (out.match(/^"([^"]+)"/) || [])[1] || 'desconhecido';
  } catch { return 'desconhecido'; }
}

// ---------------------------------------------------------------- GitHub

function githubRepo(remoteUrl) {
  const m = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.\s]+)/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

async function gh(ctx, pathname) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'jarvis' };
  if (ctx.config.githubToken) headers.Authorization = `Bearer ${ctx.config.githubToken}`;
  const r = await fetch(`https://api.github.com${pathname}`, { headers, signal: AbortSignal.timeout(10000) });
  if (r.status === 404) throw new Error('Repositório não encontrado no GitHub (se for privado, configure um token)');
  if (r.status === 403) throw new Error('Limite da API do GitHub atingido (configure um token)');
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  return r.json();
}

const ago = (iso) => {
  const h = Math.round((Date.now() - Date.parse(iso)) / 3600000);
  return h < 1 ? 'agora há pouco' : h < 24 ? `há ${h}h` : `há ${Math.round(h / 24)} dias`;
};

// ---------------------------------------------------------------- Docker

async function docker(...args) {
  try { return await run('docker', args); } catch (e) {
    if (/daemon|pipe|cannot connect|is the docker daemon running/i.test(e.message)) throw new Error('O Docker Desktop não está rodando');
    throw e;
  }
}

// ---------------------------------------------------------------- ferramentas

const projectParam = { project: { type: 'string', description: 'Nome do projeto; omita para usar o projeto atual' } };

// Dados para a tela de Projetos (chamados direto pela interface)
const api = {
  async overview(ctx) {
    const projects = findProjects(ctx.config.projectsDir);
    return Promise.all(projects.map(async (p) => {
      const info = { name: p.name, path: p.path, kinds: p.kinds, current: p.path === ctx.config.currentProject, scripts: listRunnables(p).map((r) => r.id) };
      if (!p.kinds.includes('git')) return info;
      try {
        const status = await git(p.path, 'status', '--porcelain=v1', '-b');
        const [head, ...files] = status.trim().split('\n');
        info.branch = head.replace(/^## /, '').split('...')[0];
        info.ahead = Number((head.match(/ahead (\d+)/) || [])[1] || 0);
        info.behind = Number((head.match(/behind (\d+)/) || [])[1] || 0);
        info.changed = files.filter(Boolean).length;
        const [msg, when] = (await git(p.path, 'log', '-1', '--pretty=%s|%ar')).trim().split('|');
        info.lastCommit = { msg, when };
        info.commits7d = Number((await git(p.path, 'rev-list', '--count', '--since=7.days', 'HEAD')).trim());
        const remote = githubRepo((await git(p.path, 'remote', 'get-url', 'origin').catch(() => '')).trim());
        if (remote) info.github = `https://github.com/${remote.owner}/${remote.repo}`;
      } catch (e) { info.error = e.message.slice(0, 120); }
      return info;
    }));
  },
  async ports() {
    const ports = (await listeningPorts()).filter((p) => p.port >= 1024 && p.port < 10000);
    return Promise.all(ports.slice(0, 30).map(async (p) => ({ port: p.port, pid: p.pid, process: await processName(p.pid) })));
  },
  async containers() {
    try {
      const out = await docker('ps', '-a', '--format', '{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}');
      return { running: true, list: out.trim().split('\n').filter(Boolean).map((l) => { const [name, image, status, ports] = l.split('|'); return { name, image, status, ports }; }) };
    } catch (e) {
      return { running: false, error: e.message };
    }
  },
};

module.exports = {
  name: 'dev',
  api,
  init(ctx) { ctx.resolveProject = (name) => resolveProject(name, ctx); },
  tools: [
    {
      name: 'project_list',
      description: 'Lista os projetos de código do usuário.',
      parameters: { type: 'object', properties: {} },
      async run(_, ctx) {
        const projects = findProjects(ctx.config.projectsDir);
        return { current: ctx.config.currentProject && path.basename(ctx.config.currentProject), projects: projects.map((p) => ({ name: p.name, kinds: p.kinds })) };
      },
    },
    {
      name: 'project_open',
      description: 'Abre um projeto no VS Code e o define como projeto atual.',
      parameters: { type: 'object', properties: projectParam },
      async run({ project }, ctx) {
        const p = resolveProject(project, ctx);
        spawn('cmd.exe', ['/d', '/s', '/c', `"code "${p.path}""`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
        return { ok: true, opened: p.name };
      },
    },
    {
      name: 'project_run',
      description: 'Roda um script do projeto (npm run dev, start.bat...) numa janela de terminal nova. Sem "script", lista as opções.',
      parameters: { type: 'object', properties: { ...projectParam, script: { type: 'string', description: 'Ex: dev, start, test, build' } } },
      async run({ project, script }, ctx) {
        const p = resolveProject(project, ctx);
        const options = listRunnables(p);
        if (!options.length) return { ok: false, error: 'Nenhum script encontrado no projeto' };
        const pick = script && (options.find((o) => o.id === script) || options.find((o) => o.id.includes(script)));
        if (!pick) return { needs_choice: true, project: p.name, scripts: options.map((o) => o.id) };
        openTerminal(p.path, `JARVIS: ${p.name} ${pick.id}`, pick.command);
        return { ok: true, running: pick.command, project: p.name };
      },
    },
    {
      name: 'git_status',
      description: 'Estado do repositório git: branch, arquivos alterados, commits à frente/atrás e últimos commits.',
      parameters: { type: 'object', properties: projectParam },
      async run({ project }, ctx) {
        const p = resolveProject(project, ctx);
        await git(p.path, 'fetch', '--quiet').catch(() => {});
        const status = await git(p.path, 'status', '--porcelain=v1', '-b');
        const [head, ...files] = status.trim().split('\n').filter(Boolean);
        const ahead = (head.match(/ahead (\d+)/) || [])[1] || 0;
        const behind = (head.match(/behind (\d+)/) || [])[1] || 0;
        const log = await git(p.path, 'log', '-3', '--pretty=%h %s (%ar)');
        return {
          project: p.name,
          branch: head.replace(/^## /, '').split('...')[0],
          ahead_of_remote: Number(ahead), behind_remote: Number(behind),
          changed_files: files.length, files: files.slice(0, 20).map((f) => f.trim()),
          last_commits: log.trim().split('\n'),
        };
      },
    },
    {
      name: 'git_changes',
      description: 'Mostra o que mudou para você resumir: alterações ainda não commitadas (uncommitted) ou commits de hoje (today). Use antes de escrever uma mensagem de commit.',
      parameters: { type: 'object', properties: { ...projectParam, scope: { type: 'string', enum: ['uncommitted', 'today'] } } },
      async run({ project, scope = 'uncommitted' }, ctx) {
        const p = resolveProject(project, ctx);
        if (scope === 'today') {
          const log = await git(p.path, 'log', '--since=midnight', '--pretty=%h %s', '--stat');
          return { project: p.name, commits_today: log.trim() || 'nenhum commit hoje' };
        }
        const stat = await git(p.path, 'diff', 'HEAD', '--stat');
        const diff = await git(p.path, 'diff', 'HEAD');
        const untracked = await git(p.path, 'ls-files', '--others', '--exclude-standard');
        return {
          project: p.name,
          stat: stat.trim() || 'sem alterações em arquivos versionados',
          untracked: untracked.trim().split('\n').filter(Boolean).slice(0, 20),
          diff: diff.length > 6000 ? diff.slice(0, 6000) + '\n…(cortado)' : diff,
          recent_commit_style: (await git(p.path, 'log', '-5', '--pretty=%s')).trim().split('\n'),
        };
      },
    },
    {
      name: 'git_commit',
      description: 'Faz commit de TODAS as alterações (git add -A). Se o usuário não ditou a mensagem, chame git_changes antes e escreva uma mensagem curta no estilo dos commits recentes.',
      parameters: { type: 'object', properties: { ...projectParam, message: { type: 'string' } }, required: ['message'] },
      async confirm({ project, message }, ctx) {
        const p = resolveProject(project, ctx);
        const files = (await git(p.path, 'status', '--porcelain')).trim().split('\n').filter(Boolean);
        if (!files.length) return { error: 'Não há nada para commitar' };
        return `Commit de ${files.length} arquivo(s) no ${p.name} com a mensagem "${message}". Arquivos: ${files.slice(0, 10).map((f) => f.slice(3)).join(', ')}`;
      },
      async run({ project, message }, ctx) {
        const p = resolveProject(project, ctx);
        await git(p.path, 'add', '-A');
        await git(p.path, 'commit', '-m', message);
        const hash = (await git(p.path, 'rev-parse', '--short', 'HEAD')).trim();
        return { ok: true, commit: hash };
      },
    },
    {
      name: 'git_push',
      description: 'Envia os commits locais para o GitHub (git push).',
      parameters: { type: 'object', properties: projectParam },
      async confirm({ project }, ctx) {
        const p = resolveProject(project, ctx);
        const branch = (await git(p.path, 'branch', '--show-current')).trim();
        const pending = (await git(p.path, 'log', '@{u}..HEAD', '--oneline').catch(() => '')).trim();
        if (!pending) return { error: 'Não há commits para enviar' };
        return `Push de ${pending.split('\n').length} commit(s) do ${p.name} para origin/${branch}`;
      },
      async run({ project }, ctx) {
        const p = resolveProject(project, ctx);
        await git(p.path, 'push');
        return { ok: true };
      },
    },
    {
      name: 'git_pull',
      description: 'Atualiza o projeto com as mudanças do GitHub (git pull).',
      parameters: { type: 'object', properties: projectParam },
      async run({ project }, ctx) {
        const p = resolveProject(project, ctx);
        const out = await git(p.path, 'pull', '--ff-only');
        return { ok: true, result: out.trim().split('\n').slice(-3).join(' ') };
      },
    },
    {
      name: 'github_activity',
      description: 'Pull requests e issues abertas no GitHub e o status das últimas execuções de CI do projeto.',
      parameters: { type: 'object', properties: projectParam },
      async run({ project }, ctx) {
        const p = resolveProject(project, ctx);
        const remote = (await git(p.path, 'remote', 'get-url', 'origin').catch(() => '')).trim();
        const repo = githubRepo(remote);
        if (!repo) return { ok: false, error: 'O projeto não tem um remoto no GitHub' };
        const base = `/repos/${repo.owner}/${repo.repo}`;
        const [pulls, issues, runs] = await Promise.all([
          gh(ctx, `${base}/pulls?state=open&per_page=10`),
          gh(ctx, `${base}/issues?state=open&per_page=10`),
          gh(ctx, `${base}/actions/runs?per_page=3`).catch(() => ({ workflow_runs: [] })),
        ]);
        return {
          repo: `${repo.owner}/${repo.repo}`,
          open_pull_requests: pulls.map((x) => ({ number: x.number, title: x.title, author: x.user.login, draft: x.draft, updated: ago(x.updated_at) })),
          open_issues: issues.filter((x) => !x.pull_request).map((x) => ({ number: x.number, title: x.title, updated: ago(x.updated_at) })),
          ci: runs.workflow_runs.map((r) => ({ name: r.name, branch: r.head_branch, status: r.status, result: r.conclusion, when: ago(r.created_at) })),
        };
      },
    },
    {
      name: 'project_dashboard',
      description: 'Mostra o painel visual do projeto: mapa de commits das últimas semanas (estilo GitHub), commits recentes, branch, PRs e CI.',
      parameters: { type: 'object', properties: projectParam },
      async run({ project }, ctx) {
        const p = resolveProject(project, ctx);
        const WEEKS = 20;
        const since = new Date(Date.now() - WEEKS * 7 * 86400000);
        const dates = (await git(p.path, 'log', '--all', `--since=${since.toISOString().slice(0, 10)}`, '--pretty=%ad', '--date=short')).trim().split('\n').filter(Boolean);
        const perDay = {};
        dates.forEach((d) => { perDay[d] = (perDay[d] || 0) + 1; });

        // Grade de semanas (colunas) × dias (linhas, domingo no topo), terminando hoje
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const start = new Date(today); start.setDate(start.getDate() - start.getDay() - (WEEKS - 1) * 7);
        const days = [];
        for (const d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          days.push({ date: key, count: perDay[key] || 0 });
        }
        const last30 = dates.filter((d) => Date.parse(d) >= Date.now() - 30 * 86400000).length;
        const activeDays = Object.keys(perDay).length;
        const branch = (await git(p.path, 'branch', '--show-current')).trim();
        const recent = (await git(p.path, 'log', '-6', '--pretty=%s|%ar|%an')).trim().split('\n').filter(Boolean).map((l) => {
          const [title, when, author] = l.split('|');
          return { title, subtitle: `${when} · ${author}` };
        });
        const changed = (await git(p.path, 'status', '--porcelain')).trim().split('\n').filter(Boolean).length;

        let prs = null, ci = null;
        const repo = githubRepo((await git(p.path, 'remote', 'get-url', 'origin').catch(() => '')).trim());
        if (repo) {
          const base = `/repos/${repo.owner}/${repo.repo}`;
          prs = await gh(ctx, `${base}/pulls?state=open&per_page=10`).catch(() => null);
          ci = await gh(ctx, `${base}/actions/runs?per_page=1`).then((r) => r.workflow_runs[0]).catch(() => null);
        }

        const cards = [
          { type: 'stat', title: 'COMMITS · 30 DIAS', value: String(last30), caption: `${activeDays} dias ativos em ${WEEKS} semanas` },
          { type: 'stat', title: 'BRANCH', value: branch || '—', caption: changed ? `${changed} arquivo(s) alterado(s)` : 'tudo commitado' },
          { type: 'stat', title: 'PULL REQUESTS', value: prs ? String(prs.length) : '—', caption: prs ? (prs[0] ? `#${prs[0].number} ${prs[0].title}` : 'nenhum aberto') : 'sem GitHub' },
          { type: 'stat', title: 'CI', value: ci ? (ci.conclusion === 'success' ? 'OK' : ci.conclusion || ci.status) : '—', caption: ci ? `${ci.name} · ${ago(ci.created_at)}` : 'sem execuções' },
          { type: 'heatmap', title: `ATIVIDADE · ${WEEKS} SEMANAS`, size: 'large', days },
          { type: 'list', title: 'COMMITS RECENTES', size: 'large', items: recent },
        ];
        ctx.send('visual', { kicker: 'J.A.R.V.I.S. · PROJETO', title: p.name, subtitle: p.path, cards });
        return { ok: true, shown_on_screen: true, commits_30d: last30, branch, open_prs: prs?.length, how_to_answer: 'Fale 1 a 2 frases com o destaque (ritmo de commits, PRs, CI).' };
      },
    },
    {
      name: 'explain_clipboard',
      description: 'Lê o texto copiado (área de transferência) para você explicar um erro, stack trace ou trecho de código. Fale um resumo curto e mande a explicação detalhada com show_in_chat.',
      parameters: { type: 'object', properties: {} },
      async run(_, ctx) {
        const text = String((await ctx.readClipboard()) || '');
        if (!text.trim()) return { ok: false, error: 'A área de transferência está vazia (copie o erro primeiro)' };
        return {
          clipboard: text.length > 8000 ? text.slice(0, 8000) + '\n…(cortado)' : text,
          how_to_answer: 'Chame show_in_chat com a explicação completa (causa, onde ocorre, como corrigir, comandos/código). Depois FALE no máximo 2 frases curtas com a causa e a correção principal. Sem perguntas no final.',
        };
      },
    },
    {
      name: 'look_at_screen',
      description: 'Tira um print da tela e analisa com visão computacional. Use para "olha esse erro", "o que tem na minha tela", "explica isso aqui".',
      parameters: { type: 'object', properties: { question: { type: 'string', description: 'O que perguntar sobre a tela' } }, required: ['question'] },
      async run({ question }, ctx) {
        const answer = await ctx.lookAtScreen(question);
        return { analysis: answer, how_to_answer: 'Se a resposta for longa ou tiver código, mande o detalhe com show_in_chat e fale no máximo 2 frases.' };
      },
    },
    {
      name: 'port_info',
      description: 'Mostra qual processo está usando uma porta (ex: 3000, 8000). Sem porta, lista as portas de desenvolvimento em uso.',
      parameters: { type: 'object', properties: { port: { type: 'number' } } },
      async run({ port }) {
        const ports = await listeningPorts();
        const list = port ? ports.filter((p) => p.port === port) : ports.filter((p) => p.port >= 1024 && p.port < 10000);
        if (port && !list.length) return { port, in_use: false };
        const withNames = await Promise.all(list.slice(0, 25).map(async (p) => ({ port: p.port, pid: p.pid, process: await processName(p.pid) })));
        return { ports: withNames };
      },
    },
    {
      name: 'process_kill',
      description: 'Encerra um processo pelo PID ou pela porta que ele está usando.',
      parameters: { type: 'object', properties: { pid: { type: 'number' }, port: { type: 'number' } } },
      async confirm({ pid, port }) {
        if (!pid && port) pid = (await listeningPorts()).find((p) => p.port === port)?.pid;
        if (!pid) return { error: port ? `Nada usando a porta ${port}` : 'Informe pid ou port' };
        return `Encerrar o processo ${await processName(pid)} (PID ${pid})${port ? ` que está na porta ${port}` : ''}`;
      },
      async run({ pid, port }) {
        if (!pid && port) pid = (await listeningPorts()).find((p) => p.port === port)?.pid;
        if (!pid) return { ok: false, error: 'Processo não encontrado' };
        await run('taskkill', ['/PID', String(pid), '/T', '/F']);
        return { ok: true, killed: pid };
      },
    },
    {
      name: 'docker_status',
      description: 'Lista os containers Docker e o estado de cada um.',
      parameters: { type: 'object', properties: {} },
      async run() {
        const out = await docker('ps', '-a', '--format', '{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}');
        const containers = out.trim().split('\n').filter(Boolean).map((l) => {
          const [name, image, status, ports] = l.split('|');
          return { name, image, status, ports };
        });
        return { containers };
      },
    },
    {
      name: 'docker_container',
      description: 'Inicia, para, reinicia ou mostra os logs de um container.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' }, action: { type: 'string', enum: ['start', 'stop', 'restart', 'logs'] } },
        required: ['name', 'action'],
      },
      async run({ name, action }) {
        if (action === 'logs') {
          const logs = await docker('logs', '--tail', '40', name);
          return { logs: logs.slice(-5000) };
        }
        await docker(action, name);
        return { ok: true };
      },
    },
    {
      name: 'docker_compose',
      description: 'Sobe (up) ou derruba (down) os containers do docker compose do projeto.',
      parameters: { type: 'object', properties: { ...projectParam, action: { type: 'string', enum: ['up', 'down'] } }, required: ['action'] },
      async run({ project, action }, ctx) {
        const p = resolveProject(project, ctx);
        const args = action === 'up' ? ['compose', 'up', '-d'] : ['compose', 'down'];
        const out = await run('docker', args, { cwd: p.path, timeout: 180000 }).catch((e) => { throw new Error(e.message.slice(-400)); });
        return { ok: true, output: out.trim().slice(-600) };
      },
    },
    {
      name: 'show_in_chat',
      description: 'Mostra um texto detalhado no chat SEM falar (código, passo a passo, explicação longa, lista). Fale só um resumo curto.',
      parameters: { type: 'object', properties: { text: { type: 'string', description: 'Texto em markdown simples' } }, required: ['text'] },
      async run({ text }, ctx) {
        ctx.send('ai-note', text);
        return { ok: true, shown: true };
      },
    },
  ],
};
