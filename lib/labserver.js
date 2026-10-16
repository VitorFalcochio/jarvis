// Servidor do Laboratório: serve o protótipo que a agente está escrevendo e recarrega o navegador
// a cada arquivo salvo (Server-Sent Events). Só escuta em 127.0.0.1.
//   /lab/<sessão>/...         arquivos da cópia de trabalho da agente
//   /__lab/events/<sessão>    eventos: { type: 'reload' } e { type: 'status', text, state }
const http = require('http');
const path = require('path');
const fs = require('fs');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg',
};

// Injetado em toda página HTML: recarga ao vivo e o selo do laboratório (canto inferior direito)
const clientScript = (session) => `
<script>
(() => {
  const pill = document.createElement('div');
  pill.id = '__jarvis_lab';
  pill.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483647;font:600 12.5px/1.2 system-ui,Segoe UI,sans-serif;' +
    'color:#fbf1e1;background:rgba(10,9,8,.86);border:1px solid rgba(233,214,182,.35);border-radius:999px;padding:7px 13px;' +
    'box-shadow:0 4px 18px rgba(0,0,0,.35);backdrop-filter:blur(6px);display:flex;gap:7px;align-items:center;transition:opacity .4s;pointer-events:none;max-width:60vw';
  const dot = '<i style="width:7px;height:7px;border-radius:50%;background:#e9d6b6;flex:none"></i>';
  const show = (text, state) => {
    pill.innerHTML = dot + '<span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">🧪 ' + text + '</span>';
    pill.firstChild.style.background = state === 'running' ? '#e2a04a' : state === 'failed' ? '#e0625a' : '#86c79a';
    pill.style.opacity = '1';
    clearTimeout(pill._t);
    if (state !== 'running') pill._t = setTimeout(() => { pill.style.opacity = '.0'; }, 5000);
  };
  const mount = () => document.body && !document.getElementById('__jarvis_lab') && document.body.appendChild(pill);
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', mount) : mount();
  try { const last = sessionStorage.getItem('__jarvis_lab'); if (last) { const s = JSON.parse(last); show(s.text, s.state); } } catch {}
  const es = new EventSource('/__lab/events/${session}');
  es.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'reload') { try { sessionStorage.setItem('__jarvis_lab', JSON.stringify(m.status || {})); } catch {} location.reload(); }
    if (m.type === 'status') show(m.text, m.state);
  };
})();
</script>`;

class LabServer {
  constructor({ port = 5180, resolve }) {
    this.port = port;
    this.resolve = resolve; // sessão → pasta da cópia de trabalho (ou null)
    this.clients = new Map(); // sessão → Set<res>
    this.status = new Map(); // sessão → último status
    this.timers = new Map();
    this.server = null;
  }

  url(session) { return `http://127.0.0.1:${this.port}/lab/${session}/`; }

  start() {
    if (this.server) return Promise.resolve();
    this.server = http.createServer((req, res) => this.handle(req, res));
    return new Promise((ok, fail) => {
      this.server.once('error', fail);
      this.server.listen(this.port, '127.0.0.1', ok);
    });
  }

  handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const ev = url.pathname.match(/^\/__lab\/events\/([\w-]+)$/);
    if (ev) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 1500\n\n');
      const set = this.clients.get(ev[1]) || new Set();
      set.add(res);
      this.clients.set(ev[1], set);
      const st = this.status.get(ev[1]);
      if (st) res.write(`data: ${JSON.stringify({ type: 'status', ...st })}\n\n`);
      req.on('close', () => set.delete(res));
      return;
    }
    const m = url.pathname.match(/^\/lab\/([\w-]+)(\/.*)?$/);
    const root = m && this.resolve(m[1]);
    if (!root) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Sessão do laboratório não encontrada.'); return; }
    if (!m[2]) { res.writeHead(302, { Location: `/lab/${m[1]}/` }); res.end(); return; }
    let rel = decodeURIComponent(m[2]);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, '.' + rel);
    if (!file.startsWith(root + path.sep) || file.split(path.sep).includes('.git')) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) {
        // a agente ainda não escreveu a página: mostra uma tela de espera que recarrega sozinha
        if (rel.endsWith('index.html')) return this.send(res, m[1], 'text/html; charset=utf-8',
          '<!doctype html><meta charset="utf-8"><title>Laboratório</title><body style="margin:0;height:100vh;display:grid;place-items:center;background:#050505;color:#e9d6b6;font:500 18px system-ui">Montando o protótipo...</body>');
        res.writeHead(404); res.end(); return;
      }
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      this.send(res, m[1], type, data);
    });
  }

  send(res, session, type, data) {
    if (type.startsWith('text/html')) {
      let html = data.toString('utf8');
      const tag = clientScript(session);
      html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${tag}</body>`) : html + tag;
      data = html;
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  }

  emit(session, msg) {
    for (const res of this.clients.get(session) || []) res.write(`data: ${JSON.stringify(msg)}\n\n`);
  }

  // Muitos arquivos salvos em sequência viram uma recarga só
  reload(session) {
    clearTimeout(this.timers.get(session));
    this.timers.set(session, setTimeout(() => this.emit(session, { type: 'reload', status: this.status.get(session) }), 700));
  }

  setStatus(session, text, state) {
    const st = { text, state };
    this.status.set(session, st);
    this.emit(session, { type: 'status', ...st });
  }

  forget(session) {
    for (const res of this.clients.get(session) || []) res.end();
    this.clients.delete(session);
    this.status.delete(session);
  }
}

module.exports = { LabServer };
