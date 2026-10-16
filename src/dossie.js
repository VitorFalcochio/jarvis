// Dossiês (skills/knowledge.js): lista na tela Memória + editor em janela.
// Usa os globais do renderer.js/screens.js ($, el, J, toast, button, hooks, currentScreen).

let kbEditing = null; // dossiê aberto no editor (null = novo)
let kbDirty = false;

const fmtChars = (n) => (n < 1000 ? `${n} caracteres` : `${(n / 1000).toFixed(n < 10000 ? 1 : 0).replace('.', ',')} mil caracteres`);

async function loadDossiers() {
  const grid = $('kbGrid');
  const list = await J.knowledgeList().catch(() => []);
  grid.innerHTML = '';
  list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).forEach((d, i) => {
    const tile = el('button', 'kb-tile');
    tile.type = 'button';
    tile.style.animationDelay = `${i * 50}ms`;
    tile.append(el('b', '', d.title));
    const sub = [d.project && `⌘ ${d.project}`, d.aliases?.length && `também: ${d.aliases.join(', ')}`].filter(Boolean).join(' · ');
    if (sub) tile.append(el('span', 'kb-tile-sub', sub));
    tile.append(el('small', 'muted', `${fmtChars(d.chars)} · ${new Date(d.updatedAt).toLocaleDateString('pt-BR')}`));
    tile.onclick = () => openDossier(d.id);
    grid.append(tile);
  });
  const add = el('button', 'kb-tile kb-new');
  add.type = 'button';
  add.append(el('span', 'kb-plus', '+'), el('b', '', 'Novo dossiê'), el('small', 'muted', 'Ensine o JARVIS sobre uma empresa, projeto ou assunto'));
  add.onclick = () => openDossier(null);
  grid.append(add);
}

// id: abre um existente; null: novo; { project }: o dossiê ligado ao projeto (ou um novo já ligado)
async function openDossier(target) {
  let d = null;
  if (typeof target === 'string') d = await J.knowledgeGet(target);
  else if (target?.project) {
    const found = (await J.knowledgeList()).find((x) => x.project === target.project);
    d = found ? await J.knowledgeGet(found.id) : { title: target.project.split(/[-_ ]/)[0], aliases: [target.project], project: target.project, text: '' };
  }
  kbEditing = d?.id ? d : null;
  $('kbTitle').value = d?.title || '';
  $('kbAliases').value = (d?.aliases || []).join(', ');
  $('kbText').value = d?.text || '';
  $('kbDelete').hidden = !kbEditing;
  // projetos para ligar (lista simples; o git não é necessário aqui)
  const sel = $('kbProject');
  sel.innerHTML = '<option value="">Nenhum</option>';
  const projects = await J.projectsOverview().catch(() => []);
  projects.forEach((p) => { const o = el('option', '', p.name); o.value = p.name; sel.append(o); });
  if (d?.project && !projects.some((p) => p.name === d.project)) { const o = el('option', '', d.project); o.value = d.project; sel.append(o); }
  sel.value = d?.project || '';
  kbDirty = false;
  kbCount();
  $('kbModal').hidden = false;
  (d?.title ? $('kbText') : $('kbTitle')).focus();
}

function kbCount() {
  const n = $('kbText').value.length;
  // ~4 caracteres por token em português
  $('kbCount').textContent = n ? `${fmtChars(n)} · ~${Math.ceil(n / 4).toLocaleString('pt-BR')} tokens${n > 16000 ? ' · grande: o JARVIS lê as partes relevantes' : ''}` : '';
}

function closeDossier(force) {
  if (!force && kbDirty && !confirm('Fechar sem salvar as alterações?')) return;
  $('kbModal').hidden = true;
  kbEditing = null;
}

async function saveDossier() {
  const r = await J.knowledgeSave({
    id: kbEditing?.id,
    title: $('kbTitle').value.trim(),
    aliases: $('kbAliases').value,
    project: $('kbProject').value || null,
    text: $('kbText').value,
  });
  if (!r.ok) { toast(r.error, 'error'); return; }
  toast(`Dossiê "${r.title}" salvo. Agora é só falar dele.`);
  closeDossier(true);
  loadDossiers();
}

// Importar: o texto do arquivo entra no fim do dossiê, com um título
async function importFiles(files) {
  for (const f of files) {
    $('kbCount').textContent = `Lendo ${f.name}…`;
    const r = await J.fileExtract(f.name, new Uint8Array(await f.arrayBuffer()));
    if (!r.ok) { toast(`${f.name}: ${r.error}`, 'error'); continue; }
    const ta = $('kbText');
    ta.value = `${ta.value.trimEnd()}${ta.value.trim() ? '\n\n' : ''}## Importado de ${f.name}\n\n${r.text.trim()}\n`;
    if (!$('kbTitle').value.trim()) $('kbTitle').value = f.name.replace(/\.[^.]+$/, '');
    kbDirty = true;
    toast(`${f.name} importado (${r.meta}).`);
  }
  kbCount();
  $('kbText').scrollTop = $('kbText').scrollHeight;
}

$('kbText').addEventListener('input', () => { kbDirty = true; kbCount(); });
['kbTitle', 'kbAliases', 'kbProject'].forEach((id) => $(id).addEventListener('input', () => { kbDirty = true; }));
$('kbSave').addEventListener('click', saveDossier);
$('kbCancel').addEventListener('click', () => closeDossier(false));
$('kbDelete').addEventListener('click', async () => {
  if (!kbEditing || !confirm(`Apagar o dossiê "${kbEditing.title}"? O JARVIS esquece tudo que está nele.`)) return;
  await J.knowledgeRemove(kbEditing.id);
  closeDossier(true);
  loadDossiers();
});
$('kbImport').addEventListener('click', () => $('kbFile').click());
$('kbFile').addEventListener('change', (e) => { importFiles([...e.target.files]); e.target.value = ''; });
$('kbModal').addEventListener('mousedown', (e) => { if (e.target === $('kbModal')) closeDossier(false); });
$('kbModal').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.stopPropagation(); closeDossier(false); }
  if (e.key === 's' && e.ctrlKey) { e.preventDefault(); saveDossier(); }
});

let kbDrag = 0;
const kbEd = $('kbEditor');
kbEd.addEventListener('dragenter', (e) => { if (![...e.dataTransfer.types].includes('Files')) return; e.preventDefault(); kbDrag++; $('kbDrop').hidden = false; });
kbEd.addEventListener('dragover', (e) => e.preventDefault());
kbEd.addEventListener('dragleave', () => { if (--kbDrag <= 0) { kbDrag = 0; $('kbDrop').hidden = true; } });
kbEd.addEventListener('drop', (e) => {
  e.preventDefault();
  kbDrag = 0;
  $('kbDrop').hidden = true;
  importFiles([...e.dataTransfer.files]);
});

// A tela Memória mostra os dossiês junto com o resto
const memEnter = hooks.memory?.enter;
hooks.memory = { ...hooks.memory, enter() { memEnter?.(); loadDossiers(); } };
J.onKnowledge(() => { if (currentScreen === 'memory') loadDossiers(); });
