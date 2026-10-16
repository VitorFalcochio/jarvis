// Fone pelo celular: o som do PC vai ao vivo para o app do celular (que toca no fone Bluetooth conectado nele)
// e, se o usuário ligar, o microfone do fone volta para o PC como se fosse o microfone do JARVIS.
//
// Uma janela invisível (src/audiobridge.html) captura o som do Windows com "loopbackWithMute" (as caixas do PC
// ficam mudas enquanto transmite) e fala WebRTC com o celular. Este módulo só repassa a sinalização
// (oferta/resposta/candidatos) entre o celular (WebSocket do phonecam) e essa janela, e entrega o áudio do
// microfone ao serviço de voz.
const path = require('path');
const { EventEmitter } = require('events');
const { BrowserWindow, ipcMain } = require('electron');

class AudioBridge extends EventEmitter {
  // phone: { send(msg) } · voicePcm(buffer): entrega PCM 16 kHz ao serviço de voz
  constructor({ phone, voicePcm }) {
    super();
    this.phone = phone;
    this.voicePcm = voicePcm;
    this.win = null;
    this.ready = false;
    this.queue = [];      // sinais do celular que chegaram antes da janela ficar pronta
    this.micOn = false;
    this.state = 'off';   // off | starting | connected

    const fromBridge = (e) => this.win && !this.win.isDestroyed() && e.sender === this.win.webContents;
    ipcMain.on('bridge-ready', (e) => {
      if (!fromBridge(e)) return;
      this.ready = true;
      this.queue.splice(0).forEach((m) => this.win.webContents.send('bridge-signal', m));
    });
    ipcMain.on('bridge-signal', (e, m) => { if (fromBridge(e)) this.phone.send({ t: 'rtc', ...m }); });
    ipcMain.on('bridge-pcm', (e, data) => {
      if (fromBridge(e) && this.micOn) this.voicePcm(Buffer.from(data.buffer ? data.buffer : data));
    });
    ipcMain.on('bridge-state', (e, s) => { if (fromBridge(e)) this.onBridgeState(s); });
  }

  // A captura do som do sistema é pedida por esta janela: o main usa isso para responder com loopbackWithMute
  isBridgeFrame(frame) {
    if (!frame || !this.win || this.win.isDestroyed()) return false;
    const main = this.win.webContents.mainFrame;
    return frame.processId === main.processId && frame.routingId === main.routingId;
  }

  start() {
    if (this.win && !this.win.isDestroyed()) this.stopWindow(); // novo pedido do celular: recomeça do zero
    this.ready = false;
    this.queue = [];
    this.state = 'starting';
    this.win = new BrowserWindow({
      show: false, width: 300, height: 200, skipTaskbar: true, title: 'jarvis-audiobridge',
      webPreferences: {
        preload: path.join(__dirname, '..', 'src', 'audiobridge-preload.js'),
        contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
      },
    });
    this.win.loadFile(path.join(__dirname, '..', 'src', 'audiobridge.html'));
    this.win.on('closed', () => { this.win = null; this.ready = false; });
  }

  stopWindow() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy(); // fecha a captura: as caixas do PC voltam a tocar
    this.win = null;
    this.ready = false;
  }

  stop(reason = '') {
    const was = this.state;
    this.stopWindow();
    this.micOn = false;
    this.state = 'off';
    if (was !== 'off') {
      console.log('[fone] desligado', reason);
      this.emit('state', { state: 'off', reason });
    }
  }

  onBridgeState(s) {
    if (s.state === 'connected' && this.state !== 'connected') {
      this.state = 'connected';
      console.log('[fone] som do PC indo para o celular');
      this.emit('state', { state: 'connected' });
    } else if (s.state === 'failed' || s.state === 'error') {
      console.error('[fone] falhou:', s.error || s.state);
      this.phone.send({ t: 'ear-state', state: 'error', error: s.error || 'a conexão de áudio falhou' });
      this.stop('falha');
      return;
    }
    this.phone.send({ t: 'ear-state', state: s.state, error: s.error });
  }

  // Mensagens do app do celular: { t: 'ear', action: 'start'|'stop'|'mic', on } e { t: 'rtc', type, sdp|candidate }
  onPhone(m) {
    if (m.t === 'ear') {
      if (m.action === 'start') this.start();
      else if (m.action === 'stop') this.stop('pelo celular');
      else if (m.action === 'mic') {
        this.micOn = !!m.on && this.state !== 'off';
        console.log('[fone] microfone do fone', this.micOn ? 'ligado' : 'desligado');
        this.emit('mic', this.micOn);
      }
      return;
    }
    if (m.t === 'rtc') {
      if (!this.win) return;
      const { t, ...signal } = m;
      if (this.ready) this.win.webContents.send('bridge-signal', signal);
      else this.queue.push(signal);
    }
  }
}

module.exports = { AudioBridge };
