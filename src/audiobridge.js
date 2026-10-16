// Janela invisível do "fone pelo celular" (ver lib/audiobridge.js).
// - Captura o som do Windows (loopbackWithMute: as caixas do PC ficam mudas) e manda ao celular por WebRTC.
// - Recebe o microfone do fone e o converte em PCM 16 bits / 16 kHz, em blocos de 80 ms, para o serviço de voz.
// O celular faz a oferta; esta janela só responde. Os sinais são tratados em fila, um de cada vez.
const FRAME = 1280; // 80 ms a 16 kHz, o bloco que o wake word espera

let pc = null;
let sysTrack = null;
let micCtx = null;
let micEl = null;
let chain = Promise.resolve();

// Opus em estéreo e com taxa alta: é música, não chamada
function tuneOpus(sdp) {
  const pt = (sdp.match(/a=rtpmap:(\d+) opus\/48000/i) || [])[1];
  if (!pt) return sdp;
  return sdp.replace(new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`), (line, params) => {
    const extra = ['stereo=1', 'sprop-stereo=1', 'maxaveragebitrate=192000', 'usedtx=0'].filter((p) => !params.includes(p.split('=')[0]));
    return `a=fmtp:${pt} ${params};${extra.join(';')}`;
  });
}

async function systemAudio() {
  if (sysTrack && sysTrack.readyState === 'live') return sysTrack;
  // o main responde com o monitor + loopbackWithMute; o vídeo é descartado na hora
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  stream.getVideoTracks().forEach((t) => t.stop());
  sysTrack = stream.getAudioTracks()[0];
  if (!sysTrack) throw new Error('o Windows não entregou o áudio do sistema');
  sysTrack.contentHint = 'music';
  return sysTrack;
}

// Microfone do fone → PCM 16 kHz para o main
const WORKLET = `
class Pcm16k extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(${FRAME}); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === ${FRAME}) {
        const out = new Int16Array(${FRAME});
        for (let k = 0; k < ${FRAME}; k++) { const s = Math.max(-1, Math.min(1, this.buf[k])); out[k] = s < 0 ? s * 0x8000 : s * 0x7fff; }
        this.port.postMessage(out.buffer, [out.buffer]);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm16k', Pcm16k);`;

async function attachMic(track) {
  stopMic();
  const stream = new MediaStream([track]);
  // o Chromium só entrega o áudio remoto do WebRTC ao Web Audio se ele também estiver num <audio> (mudo)
  micEl = new Audio();
  micEl.muted = true;
  micEl.srcObject = stream;
  micEl.play().catch(() => {});
  micCtx = new AudioContext({ sampleRate: 16000 }); // o Chromium reamostra de 48 kHz para 16 kHz
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
  await micCtx.audioWorklet.addModule(url);
  const node = new AudioWorkletNode(micCtx, 'pcm16k');
  node.port.onmessage = (e) => bridge.pcm(new Uint8Array(e.data));
  const silent = micCtx.createGain();
  silent.gain.value = 0;
  micCtx.createMediaStreamSource(stream).connect(node).connect(silent).connect(micCtx.destination);
}

function stopMic() {
  if (micCtx) { micCtx.close().catch(() => {}); micCtx = null; }
  if (micEl) { micEl.srcObject = null; micEl = null; }
}

async function onOffer(sdp) {
  if (pc) pc.close();
  pc = new RTCPeerConnection({ iceServers: [] }); // rede local ou Tailscale: conexão direta, sem servidor
  const mine = pc;
  pc.onicecandidate = (e) => { if (e.candidate && pc === mine) bridge.signal({ type: 'ice', candidate: e.candidate.toJSON() }); };
  pc.onconnectionstatechange = () => { if (pc === mine) bridge.state({ state: pc.connectionState }); };
  pc.ontrack = (e) => attachMic(e.track).catch((err) => console.error('[fone] microfone', err));
  await pc.setRemoteDescription({ type: 'offer', sdp });
  const tr = pc.getTransceivers().find((t) => t.receiver.track.kind === 'audio');
  if (!tr) throw new Error('o celular não pediu áudio');
  await tr.sender.replaceTrack(await systemAudio());
  tr.direction = 'sendrecv';
  const params = tr.sender.getParameters();
  if (params.encodings?.length) { params.encodings[0].maxBitrate = 192000; await tr.sender.setParameters(params).catch(() => {}); }
  const answer = await pc.createAnswer();
  await pc.setLocalDescription({ type: 'answer', sdp: tuneOpus(answer.sdp) });
  bridge.signal({ type: 'answer', sdp: pc.localDescription.sdp });
}

bridge.onSignal((m) => {
  chain = chain.then(async () => {
    if (m.type === 'offer') await onOffer(m.sdp);
    else if (m.type === 'ice' && pc && m.candidate) await pc.addIceCandidate(m.candidate).catch(() => {});
  }).catch((e) => {
    console.error('[fone]', e);
    bridge.state({ state: 'error', error: e.message });
  });
});

bridge.ready();
