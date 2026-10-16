// Trilha sonora do documentário, gerada na hora com Web Audio (nada de arquivos nem direitos autorais):
// pad de cordas sintéticas seguindo uma progressão por "clima", grave de sustentação, sinos esparsos com eco,
// impacto + "riser" para os anos gigantes, e ducking: abaixa durante a narração e sobe nas pausas.
// Também os efeitos sonoros das animações (whoosh, câmera, contador, máquina de escrever, quiz).
// Usa o audioCtx global do renderer.js.
const DocScore = (() => {
  // progressões em MIDI (graves → agudos); cada acorde dura um "compasso" longo
  const MOODS = {
    epico:       { bar: 8, cutoff: 1100, chords: [[38, 50, 57, 62, 65], [34, 46, 53, 58, 62], [41, 48, 53, 57, 60], [36, 48, 55, 60, 64]] },
    misterioso:  { bar: 10, cutoff: 700, chords: [[33, 45, 52, 57, 60], [29, 41, 48, 53, 57], [26, 38, 50, 53, 57], [28, 40, 47, 52, 56]] },
    melancolico: { bar: 9, cutoff: 850, chords: [[28, 40, 47, 52, 55], [24, 36, 48, 52, 55], [31, 43, 50, 55, 59], [26, 38, 50, 54, 57]] },
    tecnologico: { bar: 7, cutoff: 1500, chords: [[36, 48, 55, 60, 62], [33, 45, 52, 57, 59], [29, 41, 48, 55, 57], [31, 43, 50, 55, 57]] },
    esperancoso: { bar: 8, cutoff: 1300, chords: [[36, 48, 55, 60, 64], [31, 43, 50, 55, 59], [33, 45, 52, 57, 60], [29, 41, 48, 53, 57]] },
  };
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const LEVEL = 0.16;          // volume geral da trilha
  const DUCK = { speak: 0.38, pause: 1, paused: 0.18 };

  let nodes = null;
  let timer = null;

  function reverbBuffer(seconds = 3.2) {
    const len = Math.floor(audioCtx.sampleRate * seconds);
    const b = audioCtx.createBuffer(2, len, audioCtx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
    }
    return b;
  }

  function noiseBuffer(seconds) {
    const len = Math.floor(audioCtx.sampleRate * seconds);
    const b = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  function start(moodName = 'epico') {
    stop(0.1);
    const mood = MOODS[moodName] || MOODS.epico;
    const t = audioCtx.currentTime;

    const master = audioCtx.createGain();
    master.gain.setValueAtTime(0, t);
    master.gain.linearRampToValueAtTime(LEVEL, t + 4);
    const duck = audioCtx.createGain();
    duck.gain.value = DUCK.pause;
    const verb = audioCtx.createConvolver();
    verb.buffer = reverbBuffer();
    const verbGain = audioCtx.createGain(); verbGain.gain.value = 0.55;
    duck.connect(master);
    verb.connect(verbGain).connect(master);
    master.connect(audioCtx.destination);

    // pad: 2 serras desafinadas por nota, filtro passa-baixa "respirando"
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass'; filter.frequency.value = mood.cutoff; filter.Q.value = 0.7;
    const lfo = audioCtx.createOscillator(); lfo.frequency.value = 0.06;
    const lfoAmt = audioCtx.createGain(); lfoAmt.gain.value = mood.cutoff * 0.35;
    lfo.connect(lfoAmt).connect(filter.frequency); lfo.start();
    const pad = audioCtx.createGain(); pad.gain.value = 0.07;
    filter.connect(pad);
    pad.connect(duck); pad.connect(verb);

    const voices = mood.chords[0].slice(1).map((m) => [-7, 7].map((cents) => {
      const o = audioCtx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = hz(m); o.detune.value = cents;
      o.connect(filter); o.start();
      return o;
    }));

    // grave de sustentação (seno), sem passar pelo ducking forte
    const sub = audioCtx.createOscillator(); sub.type = 'sine'; sub.frequency.value = hz(mood.chords[0][0]);
    const subGain = audioCtx.createGain(); subGain.gain.value = 0.22;
    sub.connect(subGain).connect(duck); sub.start();

    // eco para os sinos
    const delay = audioCtx.createDelay(1.5); delay.delayTime.value = 0.55;
    const fb = audioCtx.createGain(); fb.gain.value = 0.38;
    delay.connect(fb).connect(delay);
    delay.connect(verb);

    nodes = { master, duck, verb, filter, lfo, voices, sub, delay, mood, chord: 0, oscs: [lfo, sub, ...voices.flat()] };

    const nextChord = () => {
      if (!nodes) return;
      nodes.chord = (nodes.chord + 1) % mood.chords.length;
      const ch = mood.chords[nodes.chord];
      const now = audioCtx.currentTime;
      nodes.voices.forEach((pair, i) => pair.forEach((o) => o.frequency.setTargetAtTime(hz(ch[i + 1]), now, 0.9)));
      nodes.sub.frequency.setTargetAtTime(hz(ch[0]), now, 0.6);
    };
    let tick = 0;
    timer = setInterval(() => {
      tick++;
      if (tick % mood.bar === 0) nextChord();
      if (Math.random() < 0.28) bell(); // sinos esparsos
    }, 1000);
  }

  function bell() {
    if (!nodes) return;
    const ch = nodes.mood.chords[nodes.chord];
    const m = ch[1 + Math.floor(Math.random() * (ch.length - 1))] + 24;
    const t = audioCtx.currentTime;
    const o = audioCtx.createOscillator(); o.type = 'sine'; o.frequency.value = hz(m);
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.035, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.5);
    o.connect(g); g.connect(nodes.duck); g.connect(nodes.delay);
    o.start(t); o.stop(t + 2.6);
  }

  // subida de ruído antes de um momento-chave (dura o silêncio dramático)
  function riser(seconds) {
    if (!nodes || seconds < 0.3) return;
    const t = audioCtx.currentTime;
    const n = audioCtx.createBufferSource(); n.buffer = noiseBuffer(seconds + 0.1);
    const bp = audioCtx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 3;
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.exponentialRampToValueAtTime(5000, t + seconds);
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + seconds);
    n.connect(bp).connect(g).connect(nodes.master);
    n.start(t); n.stop(t + seconds + 0.05);
  }

  // impacto grave (os anos gigantes): seno descendo + estalo de ruído, com a reverb longa
  function impact() {
    if (!nodes) return;
    const t = audioCtx.currentTime;
    const o = audioCtx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(32, t + 1.2);
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(1.6, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.2);
    o.connect(g); g.connect(nodes.master); g.connect(nodes.verb);
    o.start(t); o.stop(t + 2.3);
    const n = audioCtx.createBufferSource(); n.buffer = noiseBuffer(0.5);
    const lp = audioCtx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1800;
    const ng = audioCtx.createGain();
    ng.gain.setValueAtTime(0.7, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    n.connect(lp).connect(ng); ng.connect(nodes.master); ng.connect(nodes.verb);
    n.start(t);
  }

  // ------------------------------------------------------------ efeitos sonoros (independem da trilha)
  let sfxOut = null;
  let lastSfx = {};
  function sfxBus() {
    if (!sfxOut) { sfxOut = audioCtx.createGain(); sfxOut.gain.value = 0.32; sfxOut.connect(audioCtx.destination); }
    return sfxOut;
  }
  function env(g, t, peak, attack, decay) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }
  function noiseHit(t, { type = 'highpass', freq = 2000, q = 0.7, peak = 0.5, attack = 0.002, decay = 0.05, sweepTo } = {}) {
    const n = audioCtx.createBufferSource(); n.buffer = noiseBuffer(attack + decay + 0.05);
    const f = audioCtx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + attack + decay);
    const g = audioCtx.createGain(); env(g, t, peak, attack, decay);
    n.connect(f).connect(g).connect(sfxBus());
    n.start(t); n.stop(t + attack + decay + 0.05);
  }
  function tone(t, freq, { type = 'sine', peak = 0.2, attack = 0.005, decay = 0.25, to } = {}) {
    const o = audioCtx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + attack + decay);
    const g = audioCtx.createGain(); env(g, t, peak, attack, decay);
    o.connect(g).connect(sfxBus());
    o.start(t); o.stop(t + attack + decay + 0.05);
  }
  const SFX = {
    whoosh: (t) => noiseHit(t, { type: 'bandpass', freq: 350, q: 1.4, peak: 0.35, attack: 0.25, decay: 0.45, sweepTo: 2600 }),
    shutter: (t) => { noiseHit(t, { freq: 3000, peak: 0.6, decay: 0.03 }); noiseHit(t + 0.07, { freq: 1800, peak: 0.45, decay: 0.05 }); },
    tick: (t) => tone(t, 1900, { peak: 0.05, decay: 0.03 }),
    type: (t) => { noiseHit(t, { freq: 2500 + Math.random() * 1500, peak: 0.28, decay: 0.025 }); tone(t, 140, { peak: 0.06, decay: 0.03 }); },
    pop: (t) => tone(t, 520, { peak: 0.16, decay: 0.16, to: 880 }),
    stamp: (t) => { tone(t, 90, { peak: 0.9, decay: 0.5, to: 40 }); noiseHit(t, { type: 'lowpass', freq: 900, peak: 0.5, decay: 0.2 }); },
    correct: (t) => [72, 76, 79, 84].forEach((m, i) => tone(t + i * 0.09, hz(m), { peak: 0.18, decay: 0.7 })),
    wrong: (t) => { tone(t, 233, { type: 'square', peak: 0.08, decay: 0.22 }); tone(t + 0.22, 185, { type: 'square', peak: 0.08, decay: 0.4 }); },
    clock: (t) => tone(t, 1250, { peak: 0.07, decay: 0.05 }),
  };
  // throttle por efeito: dez "tique" no mesmo instante viram um só
  function sfx(name, minGapMs = 25) {
    const now = performance.now();
    if (!SFX[name] || now - (lastSfx[name] || 0) < minGapMs) return;
    lastSfx[name] = now;
    try { SFX[name](audioCtx.currentTime + 0.005); } catch (e) { console.error('[sfx]', e); }
  }

  function setDuck(kind) {
    if (!nodes) return;
    nodes.duck.gain.setTargetAtTime(DUCK[kind] ?? 1, audioCtx.currentTime, kind === 'speak' ? 0.25 : 0.8);
  }

  function stop(fade = 2.5) {
    if (!nodes) return;
    const n = nodes; nodes = null;
    clearInterval(timer); timer = null;
    const t = audioCtx.currentTime;
    n.master.gain.cancelScheduledValues(t);
    n.master.gain.setValueAtTime(n.master.gain.value, t);
    n.master.gain.linearRampToValueAtTime(0, t + fade);
    setTimeout(() => { n.oscs.forEach((o) => { try { o.stop(); } catch {} }); n.master.disconnect(); }, fade * 1000 + 200);
  }

  return { start, stop, setDuck, impact, riser, sfx, get on() { return !!nodes; } };
})();
