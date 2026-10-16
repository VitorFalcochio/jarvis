// Câmera do celular como câmera do JARVIS, sem instalar nada.
// O JARVIS sobe um servidor HTTPS na rede local (o navegador do celular só libera a câmera em HTTPS),
// o celular abre a página pelo QR code e envia quadros JPEG por WebSocket.
// Segurança: escuta só no IP do Wi-Fi e exige um token aleatório (que vai dentro do QR code).
const https = require('https');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const WebSocket = require('ws');

const PORT = 8443;

// IP da rede local (ignora VPNs como Radmin/Hamachi e adaptadores virtuais)
function lanAddress() {
  const candidates = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (/vpn|radmin|hamachi|virtual|vethernet|vmware|loopback|wsl|docker/i.test(name)) continue;
    for (const a of addrs) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const priv = /^192\.168\./.test(a.address) ? 3 : /^10\./.test(a.address) ? 2 : /^172\.(1[6-9]|2\d|3[01])\./.test(a.address) ? 1 : 0;
      if (priv) candidates.push({ address: a.address, score: priv + (/wi-?fi|wlan|wireless/i.test(name) ? 1 : 0) });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.address || null;
}

// IP do Tailscale (100.64.0.0/10): com ele o celular alcança o PC de qualquer lugar (ex: no carro)
function tailscaleAddress() {
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const m = a.address.match(/^100\.(\d+)\./);
      if (m && +m[1] >= 64 && +m[1] <= 127) return a.address;
      if (/tailscale/i.test(name)) return a.address;
    }
  }
  return null;
}

// Certificado autoassinado, gerado uma vez por IP e guardado em data/
async function certificate(dataDir, ip, fileName = 'phonecam-cert.json') {
  const file = path.join(dataDir, fileName);
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.ip === ip) return saved;
  } catch {}
  const selfsigned = require('selfsigned');
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'JARVIS' }], {
    days: 825, keySize: 2048, algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip }] }],
  });
  const cert = { ip, key: pems.private, cert: pems.cert };
  fs.writeFileSync(file, JSON.stringify(cert));
  return cert;
}

// Arquivos do app do celular (lib/phone/)
const PHONE_DIR = path.join(__dirname, 'phone');
const STATIC = {
  '/phone.css': ['phone.css', 'text/css; charset=utf-8'],
  '/phone.js': ['phone.js', 'text/javascript; charset=utf-8'],
};

class PhoneCam extends EventEmitter {
  // token: fixo entre reinícios (fica salvo na config), assim o link/favorito do celular continua valendo
  constructor(dataDir, token) {
    super();
    this.dataDir = dataDir;
    this.server = null;
    this.client = null;
    this.latest = null; // último quadro da câmera (Buffer JPEG)
    this.latestAt = 0;
    this.token = token || crypto.randomBytes(12).toString('hex');
  }

  get connected() { return !!this.client && this.client.readyState === WebSocket.OPEN; }
  get running() { return !!this.server; }

  async start() {
    if (this.server) return this.info();
    const ip = lanAddress();
    if (!ip) throw new Error('Não encontrei uma rede Wi-Fi/local neste PC');
    const { key, cert } = await certificate(this.dataDir, ip);
    this.ip = ip;

    this.handler = (req, res) => {
      const url = new URL(req.url, 'https://jarvis');
      if (url.pathname === '/' && url.searchParams.get('t') === this.token) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(fs.readFileSync(path.join(PHONE_DIR, 'index.html')));
      } else if (STATIC[url.pathname]) {
        // CSS/JS não têm nada secreto; o que exige o token é a página e o WebSocket
        const [file, type] = STATIC[url.pathname];
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        res.end(fs.readFileSync(path.join(PHONE_DIR, file)));
      } else {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Acesso negado. Escaneie o QR code mostrado no JARVIS.');
      }
    };
    this.wss = new WebSocket.Server({ noServer: true, maxPayload: 8 * 1024 * 1024 });
    this.server = await this.listen(ip, key, cert);
    await this.startRemote().catch((e) => console.error('[celular] tailscale:', e.message));
    // o Tailscale pode conectar depois do JARVIS: confere de tempos em tempos
    this.remoteTimer = setInterval(() => this.startRemote().catch(() => {}), 60000);
    return this.info();
  }

  // Um servidor HTTPS por endereço (rede local e Tailscale), com o mesmo app e o mesmo token
  async listen(ip, key, cert) {
    const server = https.createServer({ key, cert }, this.handler);
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, 'https://jarvis');
      if (url.pathname !== '/ws' || url.searchParams.get('t') !== this.token) { socket.destroy(); return; }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws, req.socket.remoteAddress));
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(PORT, ip, resolve);
    });
    return server;
  }

  async startRemote() {
    const ip = tailscaleAddress();
    if (ip === this.remoteIp) return;
    if (this.remoteServer) { this.remoteServer.close(); this.remoteServer = null; this.remoteIp = null; }
    if (!ip) return;
    const { key, cert } = await certificate(this.dataDir, ip, 'phonecam-cert-tailscale.json');
    this.remoteServer = await this.listen(ip, key, cert);
    this.remoteIp = ip;
    this.emit('remote', this.info());
  }

  attach(ws, address) {
    if (this.client) this.client.close(); // um celular por vez
    this.client = ws;
    this.emit('connected', { address });
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // binário = quadro da câmera
        this.latest = Buffer.from(data);
        this.latestAt = Date.now();
        this.emit('frame', this.latest);
        return;
      }
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      this.emit('message', msg);
    });
    ws.on('close', () => {
      if (this.client === ws) { this.client = null; this.latest = null; this.emit('disconnected'); }
    });
  }

  // Envia uma mensagem JSON para o celular (se estiver conectado)
  send(msg) {
    if (this.connected) this.client.send(JSON.stringify(msg));
  }

  info() {
    return {
      url: `https://${this.ip}:${PORT}/?t=${this.token}`, ip: this.ip, port: PORT, connected: this.connected,
      // pelo Tailscale: funciona de qualquer lugar; &drive=1 já abre no modo carro
      remoteUrl: this.remoteIp ? `https://${this.remoteIp}:${PORT}/?t=${this.token}` : null,
      driveUrl: this.remoteIp ? `https://${this.remoteIp}:${PORT}/?t=${this.token}&drive=1` : null,
    };
  }

  stop() {
    if (this.client) this.client.close();
    this.client = null;
    clearInterval(this.remoteTimer);
    if (this.remoteServer) this.remoteServer.close();
    this.remoteServer = null;
    this.remoteIp = null;
    if (this.server) this.server.close();
    this.server = null;
    this.latest = null;
  }
}

module.exports = { PhoneCam, lanAddress, tailscaleAddress };
