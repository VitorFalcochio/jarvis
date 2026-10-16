// Laboratório de software: "Jarvis, tenho uma ideia." → sessão temporária, uma agente monta um MVP
// (HTML/CSS/JS, sem npm), o navegador abre e recarrega a cada arquivo salvo, e o JARVIS apresenta o protótipo.
// Mudanças pedidas depois são feitas na mesma sessão, ao vivo. "Salva como projeto" copia para projectsDir.
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { shell } = require('electron');
const agent = require('./codeagent');
const { LabServer } = require('../lib/labserver');

let ctxRef;
let server = null;
// sessão ativa: { jobId, idea, opened, pending: [], lastStatus }
let session = null;

const job = () => (session ? agent.api.get(session.jobId) : null);
const agentName = (j) => (agent.api.agents().find((a) => a.id === j?.agent) || {}).spoken || 'a agente';
const spokenPart = (summary) => String(summary || '').split(/\n\s*\n/)[0].replace(/[*_`#>]/g, '').trim().slice(0, 400);

async function ensureServer() {
  if (server) return server;
  server = new LabServer({
    port: 5180,
    // só a sessão ativa é servida
    resolve: (id) => (session && id === session.jobId ? job()?.worktree || null : null),
  });
  await server.start();
  return server;
}

function openBrowser() {
  if (!session) return;
  session.opened = true;
  shell.openExternal(server.url(session.jobId));
}

// Acompanha o trabalho da agente: recarrega o navegador, mostra o status no selo e apresenta no fim
function onUpdate(j) {
  if (!session || j.id !== session.jobId) return;
  const last = j.steps[j.steps.length - 1];
  const who = (agent.api.agents().find((a) => a.id === j.agent) || {}).short || 'Agente';
  if (j.status === 'running') {
    const text = last?.file ? `${who} ${/^Criou/.test(last.text) ? 'criou' : 'editou'} ${last.file}` : `${who} está ${j.phase || 'trabalhando'}...`;
    server.setStatus(j.id, text, 'running');
    if (last?.file) {
      server.reload(j.id);
      // abre o navegador assim que a página existe: dá para ver o protótipo se montando
      if (!session.opened && last.file === 'index.html') openBrowser();
    }
  }
  if (j.status !== session.lastStatus) {
    const prev = session.lastStatus;
    session.lastStatus = j.status;
    if (prev === 'running' && j.status === 'done') presented(j);
    if (prev === 'running' && j.status === 'failed') server.setStatus(j.id, `Falhou: ${(j.error || '').slice(0, 80)}`, 'failed');
  }
}

function presented(j) {
  server.reload(j.id);
  server.setStatus(j.id, `Pronto · fale com o JARVIS para mudar`, 'done');
  if (!session.opened) openBrowser();
  // pedidos de mudança feitos enquanto ela construía
  if (session.pending.length) {
    const req = session.pending.splice(0).join('; e também: ');
    ctxRef.announce(`Primeira versão pronta. Já estou aplicando o que você pediu.`, { phone: false });
    agent.api.adjust(j.id, req).catch((e) => console.error('[lab]', e));
    return;
  }
  const first = !j.adjustments;
  const speech = spokenPart(j.summary) || (first ? 'O protótipo está pronto no navegador.' : 'Mudança feita.');
  ctxRef.announce(first ? `${ctxRef.config.userName}, o protótipo está no navegador. ${speech}` : speech, { phone: false });
}

function copyDir(src, dst) {
  fs.cpSync(src, dst, { recursive: true, filter: (p) => !p.split(path.sep).includes('.git') });
}
const git = (cwd, ...args) => new Promise((ok, fail) => execFile('git', args, { cwd, windowsHide: true }, (e, out, err) => (e ? fail(new Error(err || e.message)) : ok(out))));

const api = {
  current: () => (session ? { ...session, url: server?.url(session.jobId), job: job() } : null),
  async start(idea, wanted, origin = 'pc') {
    if (!idea?.trim()) throw new Error('Qual é a ideia?');
    if (session && job()?.status === 'running') throw new Error('Já tem um protótipo sendo construído no laboratório. Encerre ou espere terminar.');
    if (session) await api.close().catch(() => {});
    await ensureServer();
    const { job: j } = await agent.api.start({ task: idea.trim(), agent: wanted, origin, lab: true });
    session = { jobId: j.id, idea: idea.trim(), opened: false, pending: [], lastStatus: 'running' };
    server.setStatus(j.id, `${agentName(j)} começou a montar o protótipo...`, 'running');
    return { url: server.url(j.id), agent: (agent.api.agents().find((a) => a.id === j.agent) || {}).short };
  },
  async change(request) {
    const j = job();
    if (!j) throw new Error('Não há laboratório aberto. Diga "tenho uma ideia" para começar.');
    if (j.status === 'running') {
      session.pending.push(request.trim());
      return { queued: true };
    }
    await agent.api.adjust(j.id, request);
    server.setStatus(j.id, `${agentName(j)} está mudando: ${request.slice(0, 60)}`, 'running');
    return { queued: false };
  },
  open() {
    if (!session) throw new Error('Não há laboratório aberto');
    openBrowser();
    return { url: server.url(session.jobId) };
  },
  // Guarda o protótipo como projeto de verdade em projectsDir (com git e um commit)
  async keep(name) {
    const j = job();
    if (!j) throw new Error('Não há laboratório aberto');
    if (j.status === 'running') throw new Error('Espere a agente terminar a versão atual');
    const slug = String(name || session.idea).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'prototipo';
    const dst = path.join(ctxRef.config.projectsDir, slug);
    if (fs.existsSync(dst) && fs.readdirSync(dst).length) throw new Error(`Já existe uma pasta "${slug}" em ${ctxRef.config.projectsDir}`);
    copyDir(j.worktree, dst);
    const readme = path.join(dst, 'README.md');
    fs.writeFileSync(readme, `# ${name || slug}\n\nProtótipo criado no laboratório do JARVIS.\n\nIdeia: ${session.idea}\n\nPara abrir: dê dois cliques no index.html (ou use a extensão Live Server do VS Code).\n`);
    await git(dst, 'init', '-b', 'main');
    await git(dst, 'add', '-A');
    await git(dst, '-c', 'user.name=JARVIS', '-c', 'user.email=jarvis@local', 'commit', '-m', 'Protótipo do laboratório do JARVIS');
    return { path: dst, name: slug };
  },
  async close() {
    if (!session) return { ok: true, nothing: true };
    const id = session.jobId;
    session = null;
    server?.forget(id);
    await agent.api.discard(id).catch(() => {});
    return { ok: true };
  },
};

module.exports = {
  name: 'lab',
  api,
  init(ctx) {
    ctxRef = ctx;
    agent.events.on('update', onUpdate);
    // o prompt do JARVIS sabe quando há um laboratório aberto
    ctx.labPrompt = () => {
      const j = job();
      if (!j) return '';
      return `\n- LABORATÓRIO ABERTO agora (ideia: "${session.idea}", ${j.status === 'running' ? 'a agente está construindo' : 'protótipo pronto no navegador'}). Pedidos de mudança no protótipo ("muda a cor", "adiciona um carrinho", "tira isso") → lab_change. "Gostei, salva" → lab_keep. "Encerra o laboratório" → lab_close.`;
    };
  },
  tools: [
    {
      name: 'lab_start',
      description: 'LABORATÓRIO: transforma uma ideia num protótipo funcionando, na hora ("Jarvis, tenho uma ideia...", "prototipa um app de...", "faz um MVP de..."). Cria uma sessão temporária, uma agente monta o MVP em HTML/CSS/JS e o navegador abre mostrando ele sendo construído ao vivo. Para projetos de verdade no disco, use code_task.',
      parameters: {
        type: 'object',
        properties: {
          idea: { type: 'string', description: 'A ideia em detalhes, como o usuário descreveu (o que o app faz, para quem, telas)' },
          agent: { type: 'string', enum: ['FRIDAY', 'EDITH', 'KAREN'], description: 'Agente específica (opcional)' },
        },
        required: ['idea'],
      },
      async run({ idea, agent: wanted }, ctx) {
        const r = await api.start(idea, wanted, ctx.channel);
        if (!ctx.oficinaWindowOpen?.()) ctx.send('navigate', 'oficina');
        return {
          ok: true, agent: r.agent, url: r.url,
          how_to_answer: `Diga em 1 frase curta e animada que ${r.agent} já está montando o protótipo e que o navegador vai abrir mostrando ele sendo construído ao vivo. Não descreva o que vai ser feito.`,
        };
      },
    },
    {
      name: 'lab_change',
      description: 'Muda o protótipo aberto no laboratório, ao vivo ("muda a cor para azul", "adiciona um carrinho", "deixa o botão maior", "tira a seção X").',
      parameters: { type: 'object', properties: { request: { type: 'string', description: 'A mudança, como o usuário pediu' } }, required: ['request'] },
      async run({ request }) {
        const r = await api.change(request);
        return {
          ok: true, ...r,
          how_to_answer: r.queued ? 'Diga em 1 frase que anotou e aplica assim que a primeira versão ficar pronta.' : 'Diga em poucas palavras que já está mudando (ex: "Mudando agora."). O navegador atualiza sozinho.',
        };
      },
    },
    {
      name: 'lab_open',
      description: 'Abre de novo no navegador o protótipo do laboratório.',
      parameters: { type: 'object', properties: {} },
      async run() { return api.open(); },
    },
    {
      name: 'lab_keep',
      description: 'Salva o protótipo do laboratório como projeto de verdade na pasta de projetos ("gostei, salva", "transforma em projeto").',
      parameters: { type: 'object', properties: { name: { type: 'string', description: 'Nome curto da pasta (ex: "app-receitas")' } } },
      async run({ name }) {
        const r = await api.keep(name);
        return { ok: true, ...r, how_to_answer: `Diga que salvou em ${r.path}. Ofereça abrir no VS Code (project_open) ou pedir a uma agente para evoluir com code_task.` };
      },
    },
    {
      name: 'lab_close',
      description: 'Encerra o laboratório e apaga a sessão temporária.',
      parameters: { type: 'object', properties: {} },
      async run() { return api.close(); },
    },
  ],
};
