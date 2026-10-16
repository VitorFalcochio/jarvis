// Espelhamento do iPhone por AirPlay (UxPlay): o PC aparece como "JARVIS" no "Espelhar Tela" do iPhone
// e a tela do celular abre numa janela própria (dá para mover com window_move: "joga o iPhone ali").
// Só visualização: a Apple não permite controlar o iPhone a partir do Windows.
// O uxplay.exe é compilado como app GUI (-mwindows): não abre console e a saída chega por pipe.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

// IP da rede de casa (Wi-Fi/cabo). O UxPlay, sozinho, anunciava pela Radmin VPN (primeira placa com gateway)
// e o iPhone nunca via o "JARVIS". VPNs (Radmin 26.x, Tailscale 100.x) e 169.254 ficam de fora.
function lanIp() {
  if (ctxRef.config.mirrorIp) return ctxRef.config.mirrorIp;
  const isPrivate = (ip) => /^192\.168\./.test(ip) || /^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  const cands = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && isPrivate(a.address)) cands.push({ name, ip: a.address });
    }
  }
  cands.sort((a, b) => Number(/wi-?fi|wlan|ethernet/i.test(b.name)) - Number(/wi-?fi|wlan|ethernet/i.test(a.name)));
  return cands[0]?.ip || null;
}

const EXE = 'E:\\tools\\UxPlay\\build-gui\\uxplay.exe';
const GST_BIN = 'E:\\msys64\\ucrt64\\bin'; // DLLs do GStreamer/MSYS2

let ctxRef;
let proc = null;
let wantRunning = false;
let restarts = 0;
let state = { running: false, connected: false, device: null, since: null };
const recent = []; // últimas linhas do UxPlay (diagnóstico)

function push() { ctxRef.send('mirror', state); }

function setConnected(connected, device) {
  if (state.connected === connected) return;
  state = { ...state, connected, device: connected ? device : null, since: connected ? Date.now() : null };
  push();
  if (connected) ctxRef.toast(`📱 ${device || 'iPhone'} espelhando no JARVIS`);
  else ctxRef.toast('📱 Espelhamento encerrado');
}

// Log em data/uxplay.log (sem as mensagens repetitivas do GStreamer) para diagnosticar quedas
function logLine(line) {
  if (/GStreamer h26\d bus message|bus message .* state-changed|stream-status/.test(line)) return;
  try { fs.appendFileSync(logFile, `${new Date().toLocaleTimeString('pt-BR')} ${line}\n`); } catch {}
}
let logFile;

function handleLine(line) {
  if (!line.trim()) return;
  logLine(line);
  recent.push(line);
  if (recent.length > 80) recent.shift();
  const req = line.match(/connection request from (.+?) \((.+?)\)/);
  if (req) { clearTimeout(closeTimer); setConnected(true, req[1]); restarts = 0; return; }
  // o iPhone abre e fecha conexões auxiliares: só considera encerrado se não reconectar logo
  if (/Connection closed on socket|lost connection with client/i.test(line)) {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => setConnected(false), 4000);
  }
}
let closeTimer = null;

function start() {
  if (proc) return;
  if (!fs.existsSync(EXE)) throw new Error('O UxPlay não está instalado (esperado em E:\\tools\\UxPlay\\build-gui).');
  wantRunning = true;
  const name = ctxRef.config.mirrorName || 'JARVIS';
  const ip = lanIp();
  console.log(`[espelho] anunciando "${name}" em ${ip || '(placa automática)'}`);
  logLine(`*** iniciando uxplay: "${name}" em ${ip || '(placa automática)'}`);
  // sem -d: no modo debug o UxPlay 1.74 aborta (assert em utils.c) ao registrar certos pacotes de vídeo
  proc = spawn(EXE, ['-n', name, '-nh', '-vs', 'd3d11videosink', '-p', '-nohold', '-fps', '30'], {
    env: { ...process.env, PATH: `${GST_BIN};${process.env.PATH}`, ...(ip ? { UXPLAY_MDNS_IP: ip } : {}) },
  });
  state = { running: true, connected: false, device: null, since: null };
  push();
  let partial = '';
  const onData = (buf) => {
    const lines = (partial + buf.toString()).split(/\r?\n/);
    partial = lines.pop();
    lines.forEach(handleLine);
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('error', (e) => console.error('[espelho]', e.message));
  proc.on('exit', (code, signal) => {
    logLine(`*** uxplay saiu: code=${code} signal=${signal}`);
    proc = null;
    state = { running: false, connected: false, device: null, since: null };
    push();
    // caiu sozinho: tenta subir de novo algumas vezes
    if (wantRunning && restarts++ < 5) {
      console.log(`[espelho] UxPlay saiu (${code}), reiniciando`);
      setTimeout(() => { try { start(); } catch (e) { console.error('[espelho]', e.message); } }, 3000);
    }
  });
}

function stop() {
  wantRunning = false;
  if (proc) { proc.kill(); proc = null; }
  state = { running: false, connected: false, device: null, since: null };
}

const HOW_TO = 'No iPhone: abra a Central de Controle (deslize do canto superior direito), toque em "Espelhar Tela" e escolha "JARVIS". O iPhone precisa estar no mesmo Wi-Fi do PC.';

module.exports = {
  name: 'espelho',
  api: { start, stop, state: () => state },
  init(ctx) {
    ctxRef = ctx;
    logFile = require('path').join(ctx.dataDir, 'uxplay.log');
    try { fs.writeFileSync(logFile, ''); } catch {}
    process.on('exit', stop); // não deixa o uxplay.exe órfão quando o JARVIS fecha
    if (ctx.config.mirrorAutoStart !== false && fs.existsSync(EXE)) {
      setTimeout(() => { try { start(); } catch (e) { console.error('[espelho]', e.message); } }, 5000);
    }
  },
  stop,
  tools: [
    {
      name: 'phone_mirror',
      description: 'Espelhamento da tela do iPhone no PC por AirPlay (só visualização; a Apple não permite controlar o iPhone pelo Windows). action: "start" liga o receptor e explica como conectar ("quero ver a tela do celular", "espelha meu iPhone"), "stop" desliga, "status" diz se está conectado. Para mover a janela do iPhone use window_move com janela "iphone".',
      parameters: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['start', 'stop', 'status'] } },
        required: ['action'],
      },
      async run({ action }) {
        if (action === 'stop') {
          stop();
          return { ok: true, stopped: true };
        }
        if (action === 'start') {
          start();
          return {
            ok: true,
            receiver_on: true,
            connected: state.connected,
            device: state.device,
            how_to_connect: state.connected ? null : HOW_TO,
            how_to_answer: state.connected ? 'Diga que o iPhone já está espelhando.' : 'Explique em 1 ou 2 frases como conectar (Central de Controle → Espelhar Tela → JARVIS).',
          };
        }
        return {
          receiver_on: state.running,
          connected: state.connected,
          device: state.device,
          connected_for_minutes: state.since ? Math.round((Date.now() - state.since) / 60000) : null,
          last_log: recent.slice(-5),
        };
      },
    },
  ],
};
