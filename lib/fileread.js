// Lê o texto de arquivos anexados ou importados: PDF, planilhas (xlsx/xls/csv/ods), Word (docx) e texto/código.
// Imagens não passam por aqui (vão para o modelo de visão).
const path = require('path');

const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'env', 'xml', 'html', 'htm', 'css', 'scss', 'log', 'sql',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'py', 'ipynb', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'rb',
  'php', 'swift', 'dart', 'lua', 'r', 'sh', 'bat', 'ps1', 'cmd', 'dockerfile', 'gitignore', 'tf', 'gradle', 'properties',
]);
const SHEET_EXT = new Set(['xlsx', 'xls', 'xlsm', 'ods', 'csv', 'tsv']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']);

const extOf = (name) => {
  const base = path.basename(name || '').toLowerCase();
  if (base === 'dockerfile' || base.startsWith('.')) return base.replace(/^\./, '');
  return path.extname(base).slice(1);
};

function kindOf(name) {
  const ext = extOf(name);
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (SHEET_EXT.has(ext)) return 'sheet';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (TEXT_EXT.has(ext)) return 'text';
  return null;
}

async function readPdf(buf) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = text.map((t, i) => `--- página ${i + 1} ---\n${t.replace(/[ \t]+\n/g, '\n').trim()}`);
  const body = pages.join('\n\n').trim();
  if (body.replace(/--- página \d+ ---/g, '').trim().length < 20) {
    throw new Error('Esse PDF não tem texto selecionável (parece escaneado). Mande como imagem/print que eu leio com a visão.');
  }
  return { text: body, meta: `${totalPages} página${totalPages > 1 ? 's' : ''}` };
}

function readSheet(buf, name) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true, raw: extOf(name) === 'csv' ? false : undefined });
  const parts = [];
  let rows = 0;
  for (const sheetName of wb.SheetNames.slice(0, 8)) {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sheetName], { blankrows: false }).trim();
    if (!csv) continue;
    rows += csv.split('\n').length;
    parts.push(`### Planilha "${sheetName}" (CSV)\n${csv}`);
  }
  if (!parts.length) throw new Error('A planilha está vazia');
  return { text: parts.join('\n\n'), meta: `${wb.SheetNames.length} aba${wb.SheetNames.length > 1 ? 's' : ''}, ${rows} linhas` };
}

async function readDocx(buf) {
  const mammoth = require('mammoth');
  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(buf) });
  return { text: value.replace(/\n{3,}/g, '\n\n').trim(), meta: 'documento Word' };
}

function readText(buf, name) {
  let text = Buffer.from(buf).toString('utf8');
  // Notebook do Jupyter: só as células, sem as saídas pesadas
  if (extOf(name) === 'ipynb') {
    try {
      text = JSON.parse(text).cells.map((c) => `# [${c.cell_type}]\n${[].concat(c.source).join('')}`).join('\n\n');
    } catch {}
  }
  return { text, meta: `${text.split('\n').length} linhas` };
}

// buf: Buffer/Uint8Array. Devolve { kind, text, meta, chars }.
async function extract(buf, name) {
  const kind = kindOf(name);
  if (!kind) throw new Error(`Não sei ler arquivos .${extOf(name) || '?'} ainda`);
  if (kind === 'image') throw new Error('Imagens vão para a visão, não para a extração de texto');
  const out = kind === 'pdf' ? await readPdf(buf) : kind === 'sheet' ? readSheet(buf, name) : kind === 'docx' ? await readDocx(buf) : readText(buf, name);
  return { kind, ...out, chars: out.text.length };
}

module.exports = { extract, kindOf, extOf };
