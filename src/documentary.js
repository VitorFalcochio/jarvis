// Player do modo documentário: toca o roteiro beat a beat (pausa → visual → narração → pausa),
// sincroniza a legenda com o instante de cada palavra e aceita pausa/continua/volta/pula a qualquer momento.
// Por cima do visual de cada beat entram camadas (crédito de nome, "Você sabia?", local/data); o documentário
// abre com uma vinheta de título, fecha com créditos e pode terminar com um quiz respondido por voz ou clique.
// Usa os globais do renderer.js (audioCtx, voiceFx, voiceFxEnabled, analyser, playing, pending, el, $).
(() => {
  const J = window.jarvis;
  const root = $('doc');
  const stage = $('docStage');
  const black = $('docBlack');
  const sub = $('docSub');
  const statusEl = $('docStatus');

  // camadas que não fazem parte do HTML original: granulação de filme e as sobreposições do beat
  const grain = el('div', 'doc-grain');
  stage.after(grain);
  const ov = el('div', 'doc-ov');
  black.before(ov);

  const QUIZ_TIME = 20000; // tempo para responder o quiz

  let doc = null;      // { id, mode, title, subtitle, mood, beats: [], total, i, phase, offset, paused, auto, opened, quizDeadline }
  let gen = 0;         // muda a cada pausa/salto: o laço antigo para sozinho
  let src = null;      // áudio tocando agora
  let startedAt = 0;   // audioCtx.currentTime em que a narração começou (descontado o offset)
  let shownVisual = null;
  let ovBeat = -1;     // beat cujas camadas estão na tela
  let kbFlip = false;
  const buffers = new Map(); // índice -> AudioBuffer já decodificado

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const alive = (g) => g === gen && doc && !doc.paused;

  // Duração aproximada da narração de um beat (os tempos das palavras vêm do TTS)
  function beatDur(beat) {
    const w = beat?.words;
    return w?.length ? w[w.length - 1].t + 0.6 : Math.min(9, 0.9 + (beat?.fala || '').length * 0.055);
  }

  // setTimeout que respeita a pausa e morre junto com o elemento (camada trocada, salto, encerramento)
  function later(node, ms, fn) {
    let left = ms, last = performance.now();
    const step = () => {
      if (!node.isConnected || node.classList.contains('out')) return;
      const now = performance.now();
      if (!doc?.paused) left -= now - last;
      last = now;
      if (left <= 0) fn(); else setTimeout(step, Math.min(200, left));
    };
    setTimeout(step, Math.min(200, ms));
  }

  // ------------------------------------------------------------ estado para o main (contexto das perguntas)

  function report() {
    if (!doc) { J.docState({ active: false }); return; }
    const b = doc.beats[doc.i];
    const waiting = doc.phase === 'answer' && b?.visual?.tipo === 'quiz' && b.quizChoice === undefined;
    J.docState({
      active: true, paused: !!doc.paused, title: doc.title,
      scene: b?.cena || '', line: b?.fala || '', entities: b?.entidades || [],
      quiz: waiting ? { waiting: true, options: b.visual.opcoes } : null,
    });
    $('docToggle').textContent = doc.paused ? '▶' : '❚❚';
    root.classList.toggle('paused', !!doc.paused);
    const total = doc.total || Math.max(doc.beats.length, 1);
    $('docProgress').style.width = `${Math.min(100, (doc.i / total) * 100)}%`;
    if (b?.cena) $('docScene').textContent = b.cena;
  }

  function setStatus(text) {
    statusEl.textContent = text || '';
    statusEl.classList.toggle('on', !!text);
  }

  // ------------------------------------------------------------ componentes visuais

  function layer(cls, { sfx = true } = {}) {
    const node = el('div', `doc-layer ${cls}`);
    const olds = [...stage.children].filter((o) => !o.classList.contains('out'));
    olds.forEach((old) => {
      old.classList.add('out');
      setTimeout(() => old.remove(), 1400);
    });
    // whoosh só na troca entre cenas (não na primeira nem saindo do "carregando")
    if (sfx && olds.some((o) => !/doc-loading|doc-opening/.test(o.className))) DocScore.sfx('whoosh');
    stage.appendChild(node);
    return node;
  }

  function caption(title, source) {
    const cap = el('div', 'doc-image-cap');
    const src = el('span', 'doc-image-src', source || '');
    cap.append(el('span', 'doc-image-title', title || ''), src);
    return { cap, src };
  }

  const blurBg = (url) => {
    const bg = el('div', 'doc-image-bg');
    bg.style.backgroundImage = `url("${url}")`;
    return bg;
  };

  const COMPONENTS = {
    capitulo(v) {
      const n = layer('doc-chapter');
      n.append(
        el('div', 'doc-chapter-num', `CAPÍTULO ${String(v.numero).padStart(2, '0')}`),
        el('div', 'doc-chapter-line'),
        el('h1', 'doc-chapter-title', v.titulo),
      );
    },
    ano(v) {
      const n = layer('doc-year');
      const big = el('div', 'doc-year-num', v.texto);
      n.append(big, el('div', 'doc-year-cap', v.legenda || ''));
      // ano numérico: os dígitos "rolam" até a data, como um contador de máquina do tempo
      const year = /^\d{3,4}$/.test(v.texto) ? Number(v.texto) : null;
      if (year) {
        const from = year - 40, t0 = performance.now(), dur = 1300;
        (function tick(now) {
          const k = Math.min(1, (now - t0) / dur);
          big.textContent = String(Math.round(from + (year - from) * (1 - Math.pow(1 - k, 4))));
          if (k < 1 && big.isConnected) requestAnimationFrame(tick);
        })(t0);
      }
    },
    // uma foto principal e, se a fala for longa, mais 1 ou 2 fotos do mesmo assunto em sequência
    imagem(v, beat) {
      const n = layer('doc-image');
      const bg = blurBg(v.url);
      const { cap, src } = caption(v.legenda, v.fonte);
      n.append(bg, cap);
      const photos = [{ url: v.url, fonte: v.fonte }, ...(v.extras || [])];
      const total = beatDur(beat) + (beat.pausaDepois || 0);
      const count = Math.max(1, Math.min(photos.length, Math.floor(total / 4.2)));
      const slot = total / count;
      const show = (p, k) => {
        const img = new Image();
        img.src = p.url;
        img.alt = v.legenda || '';
        kbFlip = !kbFlip;
        img.className = `doc-photo ${kbFlip ? 'kb-a' : 'kb-b'}`;
        img.style.setProperty('--kb', `${Math.max(8, slot + 5)}s`);
        img.onerror = () => { if (k === 0) COMPONENTS.frase({ texto: v.legenda || v.busca, autor: '' }); else img.remove(); };
        n.querySelectorAll('.doc-photo').forEach((o) => { o.classList.add('gone'); setTimeout(() => o.remove(), 1400); });
        n.insertBefore(img, cap);
        src.textContent = p.fonte || '';
        if (k > 0) { bg.style.backgroundImage = `url("${p.url}")`; DocScore.sfx('shutter'); }
      };
      show(photos[0], 0);
      for (let k = 1; k < count; k++) later(n, slot * k * 1000, () => show(photos[k], k));
    },
    // 2 a 4 fotos caindo como polaroids sobre a mesa
    galeria(v, beat) {
      const n = layer('doc-gallery');
      n.append(blurBg(v.fotos[0].url));
      const k = v.fotos.length;
      const step = Math.min(1.6, Math.max(0.7, (beatDur(beat) * 0.6) / k));
      const spread = k > 3 ? 21 : k === 3 ? 25 : 22;
      v.fotos.forEach((f, i) => {
        const card = el('figure', 'doc-polaroid');
        card.style.setProperty('--x', `${(i - (k - 1) / 2) * spread}vw`);
        card.style.setProperty('--y', `${(i % 2 ? 2.5 : -2) + (i === 1 ? 1 : 0)}vh`);
        card.style.setProperty('--r', `${(i % 2 ? 1 : -1) * (3 + ((i * 5) % 5))}deg`);
        card.style.setProperty('--w', k > 3 ? '19vw' : k === 3 ? '23vw' : '28vw');
        card.style.zIndex = String(i + 1);
        const delay = 0.25 + i * step;
        card.style.animationDelay = `${delay}s`;
        const img = new Image();
        img.src = f.url;
        img.alt = f.rotulo || '';
        img.onerror = () => card.remove();
        card.append(img, el('figcaption', '', f.rotulo || ''));
        n.append(card);
        later(n, delay * 1000 + 350, () => DocScore.sfx('shutter'));
      });
      if (v.legenda) n.append(caption(v.legenda, '').cap);
    },
    // contador gigante (0 → valor) com tique de máquina
    numero(v) {
      const n = layer('doc-number');
      const val = el('span', 'doc-number-val');
      const line = el('div', 'doc-number-line');
      if (v.prefixo) line.append(el('span', 'doc-number-pre', v.prefixo));
      line.append(val);
      n.append(line);
      if (v.sufixo) n.append(el('div', 'doc-number-suf', v.sufixo));
      if (v.legenda) n.append(el('div', 'doc-number-cap', v.legenda));
      const dec = Number.isInteger(v.valor) ? 0 : Math.min(2, (String(v.valor).split('.')[1] || '').length);
      const fmt = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
      val.textContent = fmt.format(0);
      const t0 = performance.now() + 400, dur = 2300;
      (function tick(now) {
        if (!val.isConnected) return;
        const k = Math.max(0, Math.min(1, (now - t0) / dur));
        const eased = k === 1 ? 1 : 1 - Math.pow(2, -10 * k);
        val.textContent = fmt.format(dec ? v.valor * eased : Math.round(v.valor * eased));
        if (k > 0 && k < 0.92) DocScore.sfx('tick', 60 + k * 160);
        if (k < 1) requestAnimationFrame(tick);
        else { n.classList.add('done'); DocScore.sfx('stamp'); }
      })(performance.now());
    },
    // página de jornal girando até parar na tela
    manchete(v) {
      const n = layer('doc-headline');
      const paper = el('div', 'doc-paper');
      paper.append(el('div', 'doc-paper-mast', 'EDIÇÃO EXTRA'), el('div', 'doc-paper-date', v.data || ''), el('div', 'doc-paper-rule'), el('h1', 'doc-paper-head', v.texto));
      const body = el('div', 'doc-paper-body');
      if (v.url) {
        const img = new Image();
        img.src = v.url; img.alt = '';
        img.onerror = () => img.remove();
        body.appendChild(el('div', 'doc-paper-photo')).appendChild(img);
      }
      // colunas de texto decorativas (barras, não texto inventado)
      for (let c = 0; c < 3; c++) {
        const col = el('div', 'doc-paper-col');
        for (let r = 0; r < 9; r++) { const bar = el('i'); bar.style.width = `${70 + ((c * 7 + r * 13) % 30)}%`; col.appendChild(bar); }
        body.appendChild(col);
      }
      paper.append(body);
      n.append(paper);
      later(n, 1250, () => DocScore.sfx('stamp'));
    },
    // antes/depois: a segunda foto entra como uma cortina e as duas dividem a tela
    comparacao(v) {
      const n = layer('doc-compare');
      const side = (s, cls) => {
        const d = el('div', `doc-cmp-side ${cls}`);
        d.style.backgroundImage = `url("${s.url}")`;
        return d;
      };
      n.append(side(v.antes, 'a'), side(v.depois, 'd'), el('div', 'doc-cmp-line'),
        el('div', 'doc-cmp-lab a', v.antes.rotulo || ''), el('div', 'doc-cmp-lab d', v.depois.rotulo || ''));
      later(n, 1500, () => { n.classList.add('split'); DocScore.sfx('whoosh'); });
    },
    // itens que entram um a um enquanto a narração avança
    lista(v, beat) {
      const n = layer('doc-list');
      if (v.titulo) n.append(el('div', 'doc-list-title', v.titulo));
      const ol = el('ol', 'doc-list-items');
      const gap = Math.max(0.8, (beatDur(beat) * 0.8) / v.itens.length);
      v.itens.forEach((it, i) => {
        const li = el('li');
        li.append(el('span', 'doc-list-num', String(i + 1).padStart(2, '0')), el('span', 'doc-list-txt', it));
        ol.append(li);
        later(n, (0.5 + i * gap) * 1000, () => { li.classList.add('on'); DocScore.sfx('pop'); });
      });
      n.append(ol);
    },
    // citação em máquina de escrever
    frase(v) {
      const n = layer('doc-quote');
      const box = el('div', 'doc-quote-text');
      const chars = [...v.texto].map((c) => { const s = el('span', 'c', c); box.appendChild(s); return s; });
      n.append(el('div', 'doc-quote-mark', '“'), box);
      const author = v.autor ? el('div', 'doc-quote-author', `— ${v.autor}`) : null;
      if (author) n.append(author);
      let i = 0;
      const speed = Math.max(22, Math.min(55, 2600 / Math.max(1, chars.length)));
      const type = () => {
        if (i >= chars.length) { author?.classList.add('on'); return; }
        chars[i].classList.add('on');
        if (chars[i].textContent.trim()) DocScore.sfx('type', 45);
        i++;
        later(n, speed + (chars[i - 1].textContent === ' ' ? 30 : 0), type);
      };
      later(n, 500, type);
    },
    mapa(v, beat, prev) {
      if (prev?.tipo !== 'mapa' || !stage.querySelector('.doc-map:not(.out)')) LiveMap.mount(layer('doc-map'));
      LiveMap.show(v);
    },
    timeline(v) {
      const n = layer('doc-timeline');
      const track = el('div', 'doc-tl-track');
      track.appendChild(el('div', 'doc-tl-line'));
      v.itens.forEach((it, i) => {
        const p = el('div', `doc-tl-item${i === v.atual ? ' now' : ''}`);
        p.style.left = `${v.itens.length === 1 ? 50 : 6 + (i * 88) / (v.itens.length - 1)}%`;
        p.style.animationDelay = `${0.3 + i * 0.22}s`;
        p.append(el('div', 'doc-tl-dot'), el('div', 'doc-tl-date', it.data), el('div', 'doc-tl-title', it.titulo));
        track.appendChild(p);
      });
      n.appendChild(track);
    },
    quiz(v) {
      const n = layer('doc-quiz');
      n.append(el('div', 'doc-quiz-kicker', 'PERGUNTA RÁPIDA'), el('h2', 'doc-quiz-q', v.pergunta));
      const opts = el('div', 'doc-quiz-opts');
      v.opcoes.forEach((o, i) => {
        const b = el('button', 'doc-quiz-opt');
        b.type = 'button';
        b.dataset.quiz = String(i);
        b.style.animationDelay = `${0.6 + i * 0.25}s`;
        b.append(el('span', 'doc-quiz-letter', 'ABC'[i]), el('span', 'doc-quiz-txt', o));
        opts.append(b);
      });
      const timer = el('div', 'doc-quiz-timer');
      timer.style.setProperty('--quiz', `${QUIZ_TIME / 1000}s`);
      n.append(opts, timer, el('div', 'doc-quiz-hint'), el('p', 'doc-quiz-exp', v.explicacao || ''));
    },
  };

  function showVisual(beat) {
    if (!beat.visual || beat.visual === shownVisual) return;
    const prev = shownVisual;
    shownVisual = beat.visual;
    try { COMPONENTS[beat.visual.tipo]?.(beat.visual, beat, prev); } catch (e) { console.error('[doc] visual', e); }
  }

  // ------------------------------------------------------------ camadas por cima do visual

  function clearOverlays() {
    ovBeat = -1;
    [...ov.children].forEach((c) => { c.classList.add('out'); setTimeout(() => c.remove(), 600); });
  }

  function showOverlays(beat, i) {
    if (ovBeat === i) return;
    clearOverlays();
    ovBeat = i;
    if (beat.etiqueta) {
      const t = el('div', 'doc-lower');
      t.append(el('div', 'doc-lower-name', beat.etiqueta.nome), el('div', 'doc-lower-info', beat.etiqueta.info || ''));
      ov.append(t);
      later(t, 300, () => DocScore.sfx('pop'));
      later(t, 6500, () => { t.classList.add('out'); setTimeout(() => t.remove(), 600); });
    }
    if (beat.carimbo) ov.append(el('div', 'doc-stamp', beat.carimbo));
    if (beat.curiosidade) {
      const c = el('div', 'doc-fact');
      c.append(el('div', 'doc-fact-k', 'VOCÊ SABIA?'), el('p', '', beat.curiosidade));
      ov.append(c);
      later(c, 1500, () => { c.classList.add('show'); DocScore.sfx('pop'); });
    }
  }

  // ------------------------------------------------------------ legenda sincronizada

  function buildSubtitle(beat) {
    sub.innerHTML = '';
    const hl = (beat.destaques || []).map((d) => d.toLowerCase());
    const words = beat.words?.length ? beat.words : null;
    // as palavras do TTS ("Em 1822" pode vir junto) viram os spans; sem tempos, mostra o texto inteiro
    (words ? words.map((w) => w.w) : [beat.fala]).forEach((w, i) => {
      const s = el('span', 'w', w + ' ');
      const plain = w.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '');
      if (hl.some((h) => plain && (plain.includes(h) || h.includes(plain)) && plain.length > 2)) s.classList.add('hl');
      if (words) s.dataset.t = words[i].t;
      else s.classList.add('on');
      sub.appendChild(s);
    });
    sub.classList.add('show');
  }

  (function syncLoop() {
    if (src && doc && !doc.paused) {
      const t = audioCtx.currentTime - startedAt;
      for (const s of sub.children) if (s.dataset.t !== undefined && Number(s.dataset.t) <= t + 0.05) s.classList.add('on');
    }
    requestAnimationFrame(syncLoop);
  })();

  // ------------------------------------------------------------ áudio

  const decodeData = (b64) => audioCtx.decodeAudioData(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer).catch(() => null);

  async function decode(i) {
    if (buffers.has(i)) return buffers.get(i);
    const b = doc?.beats[i];
    if (!b?.audio) return null;
    const job = decodeData(b.audio);
    buffers.set(i, job);
    return job;
  }

  function stopAudio() {
    if (!src) return;
    const s = src; src = null;
    s.onended = null;
    try { s.stop(); } catch {}
  }

  function playAudio(buffer, offset, g) {
    return new Promise((resolve) => {
      const s = audioCtx.createBufferSource();
      s.buffer = buffer;
      s.connect(voiceFxEnabled ? voiceFx : analyser);
      src = s;
      startedAt = audioCtx.currentTime - offset;
      s.onended = () => { if (src === s) src = null; resolve(g === gen); };
      s.start(0, offset);
    });
  }

  // a fala normal do JARVIS (resposta a uma pergunta, "Preparei algo especial...") termina antes
  async function waitQuiet(g) {
    for (let k = 0; k < 300 && (playing || pending.size); k++) { await sleep(100); if (g !== gen) return false; }
    return g === gen;
  }

  // ------------------------------------------------------------ abertura, quiz e créditos

  // vinheta de título: "J.A.R.V.I.S. APRESENTA" → título com brilho → subtítulo
  async function opening(g) {
    doc.opened = true;
    const n = layer('doc-opening', { sfx: false });
    n.append(el('div', 'doc-open-pre', 'J.A.R.V.I.S. APRESENTA'), el('h1', 'doc-open-title', doc.title), el('div', 'doc-open-sub', doc.subtitle || ''));
    DocScore.riser(1.8);
    await sleep(1900);
    if (!alive(g)) return false;
    n.classList.add('reveal');
    DocScore.impact();
    await sleep(3200);
    return alive(g);
  }

  function answerQuiz(choice) {
    const beat = doc?.beats[doc.i];
    if (!beat || beat.visual?.tipo !== 'quiz' || beat.quizChoice !== undefined || !['speak', 'answer'].includes(doc.phase)) return;
    if (!(choice >= 0 && choice <= 2)) return;
    console.log('[doc] quiz: resposta', 'ABC'[choice]);
    beat.quizChoice = choice;
    stage.querySelector(`.doc-quiz:not(.out) [data-quiz="${choice}"]`)?.classList.add('picked');
    if (doc.paused) start(); // o laço retoma e revela
  }

  async function waitAnswer(beat, g) {
    if (!doc.quizDeadline) doc.quizDeadline = Date.now() + (doc.quizLeft ?? QUIZ_TIME);
    doc.quizLeft = null;
    const node = stage.querySelector('.doc-quiz:not(.out)');
    if (node) {
      // barra de tempo: recomeça com o tempo que sobrou (depois de uma pausa)
      node.querySelector('.doc-quiz-timer')?.style.setProperty('--quiz', `${(doc.quizDeadline - Date.now()) / 1000}s`);
      node.classList.remove('waiting'); void node.offsetWidth; node.classList.add('waiting');
      node.querySelector('.doc-quiz-hint').textContent = 'Diga “Jarvis, letra A, B ou C” · ou clique na resposta';
    }
    if (!beat.quizAsked) { beat.quizAsked = true; J.startListening(); }
    report();
    let lastSec = -1;
    while (alive(g) && beat.quizChoice === undefined && Date.now() < doc.quizDeadline) {
      const sec = Math.ceil((doc.quizDeadline - Date.now()) / 1000);
      if (sec !== lastSec) { lastSec = sec; if (sec <= 5) DocScore.sfx('clock'); }
      await sleep(120);
    }
    return alive(g);
  }

  async function revealQuiz(beat, g) {
    const q = beat.visual;
    const choice = beat.quizChoice;
    doc.quizDeadline = null;
    doc.quizLeft = null;
    report();
    const node = stage.querySelector('.doc-quiz:not(.out)');
    const ok = choice === q.correta;
    if (node) {
      node.classList.remove('waiting');
      node.classList.add('revealed');
      node.querySelector(`[data-quiz="${q.correta}"]`)?.classList.add('right');
      if (choice !== undefined && !ok) node.querySelector(`[data-quiz="${choice}"]`)?.classList.add('wrong');
      const hint = node.querySelector('.doc-quiz-hint');
      if (hint) hint.textContent = choice === undefined ? 'TEMPO ESGOTADO' : ok ? 'RESPOSTA CERTA' : 'NÃO FOI DESSA VEZ';
    }
    DocScore.sfx(choice === undefined ? 'clock' : ok ? 'correct' : 'wrong');
    const a = q.audios || {};
    const seq = choice === undefined ? [a.resposta] : ok ? [a.certo, a.explicacao] : [a.errado, a.resposta];
    await sleep(500);
    for (const b64 of seq.filter(Boolean)) {
      if (!alive(g)) return false;
      const buf = await decodeData(b64);
      if (!alive(g)) return false;
      if (buf) { DocScore.setDuck('speak'); if (!(await playAudio(buf, 0, g))) return false; }
    }
    await sleep(1500);
    return alive(g);
  }

  function credits() {
    const n = layer('doc-credits', { sfx: false });
    const roll = el('div', 'doc-credits-roll');
    const line = (k, v) => { const d = el('div', 'doc-credits-line'); d.append(el('span', 'k', k), el('span', 'v', v)); return d; };
    const pages = new Set();
    let hasMap = false;
    for (const b of doc.beats) {
      const v = b?.visual;
      if (!v) continue;
      if (v.tipo === 'mapa') hasMap = true;
      [v, ...(v.extras || []), ...(v.fotos || []), v.antes, v.depois].forEach((x) => {
        if (x?.fonte) pages.add(x.fonte.replace(/^(Wikipedia|Wikimedia Commons) · /, ''));
      });
    }
    roll.append(el('div', 'doc-credits-kicker', 'UM DOCUMENTÁRIO J.A.R.V.I.S.'), el('h2', 'doc-credits-title', doc.title),
      line('Narração', 'J.A.R.V.I.S.'), line('Roteiro e direção', 'J.A.R.V.I.S.'), line('Trilha sonora', 'composta ao vivo'));
    if (pages.size) {
      roll.append(line('Imagens', 'Wikipedia · Wikimedia Commons'));
      roll.append(el('div', 'doc-credits-list', [...pages].slice(0, 12).join(' · ')));
    }
    if (hasMap) roll.append(line('Mapas', 'OpenStreetMap · MapLibre'));
    roll.append(el('div', 'doc-credits-end', 'FIM'));
    n.append(roll);
  }

  // ------------------------------------------------------------ laço principal

  async function run(g) {
    if (audioCtx.state === 'suspended') await audioCtx.resume().catch(() => {});
    while (alive(g)) {
      const i = doc.i;
      if (doc.total !== null && i >= doc.total) { finish(); return; }
      const beat = doc.beats[i];
      if (!beat) { setStatus(doc.beats.length ? 'preparando a próxima cena…' : doc.mode === 'mapa' ? 'localizando…' : 'o diretor está montando o roteiro…'); await sleep(250); continue; }
      setStatus('');
      report();
      decode(i + 1); // a próxima narração já vai sendo decodificada

      if (!(await waitQuiet(g))) return;
      if (!DocScore.on && doc.mood && doc.mood !== 'nenhum') DocScore.start(doc.mood);
      if (doc.mode === 'doc' && !doc.opened && i === 0 && doc.phase === 'pre') {
        if (!(await opening(g))) return;
      }

      if (doc.phase === 'pre') {
        DocScore.setDuck('pause');
        const isYear = beat.visual?.tipo === 'ano' && beat.visual !== shownVisual;
        if (beat.escurecer) { black.classList.add('on'); sub.classList.remove('show'); }
        if (isYear) DocScore.riser(Math.max(0.6, beat.pausaAntes));
        if (beat.pausaAntes) { await sleep(beat.pausaAntes * 1000); if (!alive(g)) return; }
        showVisual(beat);
        if (isYear) DocScore.impact();
        black.classList.remove('on');
        doc.phase = 'speak';
        doc.offset = 0;
      } else showVisual(beat); // retomando: garante que o visual certo está na tela

      if (doc.phase === 'speak') {
        showOverlays(beat, i);
        const buffer = await decode(i);
        if (!alive(g)) return;
        DocScore.setDuck('speak');
        if (buffer) {
          beat.dur = buffer.duration;
          buildSubtitle(beat);
          if (!(await playAudio(buffer, doc.offset, g)) || !alive(g)) return;
        } else if (beat.fala) {
          buildSubtitle(beat); // sem áudio: lê na tela no tempo de leitura
          await sleep(Math.min(9000, 900 + beat.fala.length * 55));
          if (!alive(g)) return;
        }
        doc.phase = beat.visual?.tipo === 'quiz' ? 'answer' : 'post';
      }

      if (doc.phase === 'answer') {
        sub.classList.remove('show');
        DocScore.setDuck('pause');
        if (beat.quizChoice === undefined && !(await waitAnswer(beat, g))) return;
        if (!(await revealQuiz(beat, g))) return;
        doc.phase = 'post';
      }
      DocScore.setDuck('pause');

      await sleep(beat.pausaDepois * 1000);
      if (!alive(g)) return;
      sub.classList.remove('show');
      clearOverlays();
      doc.i++;
      doc.phase = 'pre';
      doc.offset = 0;
    }
  }

  function start() {
    if (!doc || doc.ended) return;
    gen++;
    doc.paused = false;
    doc.auto = false;
    hideAside();
    report();
    run(gen);
  }

  function pause(auto = false) {
    if (!doc || doc.paused) { if (doc && !auto) doc.auto = false; return; }
    gen++;
    if (src && doc.phase === 'speak') doc.offset = Math.max(0, audioCtx.currentTime - startedAt - 0.4);
    // quiz: o tempo para responder fica congelado durante a pausa
    if (doc.phase === 'answer' && doc.quizDeadline) { doc.quizLeft = Math.max(5000, doc.quizDeadline - Date.now()); doc.quizDeadline = null; }
    stopAudio();
    doc.paused = true;
    doc.auto = auto;
    DocScore.setDuck('paused');
    setStatus(auto ? 'ouvindo…' : 'PAUSADO');
    report();
  }

  function jump(delta) {
    if (!doc) return;
    gen++;
    stopAudio();
    doc.ended = false;
    doc.i = Math.max(0, Math.min((doc.total ?? doc.beats.length) - 1, doc.i + delta));
    doc.phase = 'pre';
    doc.offset = 0;
    doc.quizDeadline = null;
    doc.quizLeft = null;
    const b = doc.beats[doc.i];
    if (b?.visual?.tipo === 'quiz') { delete b.quizChoice; delete b.quizAsked; }
    shownVisual = null;
    clearOverlays();
    start();
  }

  // "volta naquela imagem": o beat de imagem anterior ao atual (ou o próprio, se for imagem)
  function jumpToImage() {
    if (!doc) return;
    const isImg = (b) => ['imagem', 'galeria', 'comparacao'].includes(b?.visual?.tipo);
    for (let k = doc.i - (isImg(doc.beats[doc.i]) && doc.phase === 'pre' ? 1 : 0); k >= 0; k--) {
      if (isImg(doc.beats[k])) { jump(k - doc.i); return; }
    }
    jump(-1);
  }

  // ------------------------------------------------------------ cartão de resposta (perguntas no meio)

  const aside = el('aside', 'doc-aside');
  root.appendChild(aside);
  function showAside(c) {
    aside.innerHTML = '';
    if (c.url) {
      const img = new Image();
      img.src = c.url; img.alt = c.titulo;
      img.onerror = () => img.remove();
      aside.appendChild(el('div', 'doc-aside-img')).appendChild(img);
    }
    const body = el('div', 'doc-aside-body');
    body.append(el('span', 'doc-aside-kicker', 'J.A.R.V.I.S. · CONSULTA'), el('h3', '', c.titulo));
    if (c.descricao) body.appendChild(el('p', 'doc-aside-desc', c.descricao));
    if (c.pontos?.length) {
      const ul = el('ul');
      c.pontos.forEach((p, i) => { const li = el('li', '', p); li.style.animationDelay = `${0.5 + i * 0.18}s`; ul.appendChild(li); });
      body.appendChild(ul);
    }
    if (c.fonte) body.appendChild(el('span', 'doc-aside-src', c.fonte));
    aside.appendChild(body);
    aside.classList.remove('show'); void aside.offsetWidth; aside.classList.add('show');
    root.classList.add('aside');
    setStatus('');
  }
  function hideAside() {
    aside.classList.remove('show');
    root.classList.remove('aside');
  }

  async function finish() {
    doc.ended = true;
    $('docProgress').style.width = '100%';
    sub.classList.remove('show');
    clearOverlays();
    report();
    if (doc.mode === 'mapa') { DocScore.stop(4); setStatus(''); return; }
    const id = doc.id;
    setStatus('');
    $('docScene').textContent = '';
    credits();
    await sleep(10500);
    if (doc?.id !== id || !doc.ended) return;
    DocScore.stop(3);
    black.classList.add('on');
    await sleep(2500);
    if (doc?.id === id && doc.ended) close('fim');
  }

  function close(reason = '?') {
    console.log('[doc] fechado:', reason);
    gen++;
    stopAudio();
    DocScore.stop();
    hideAside();
    clearOverlays();
    doc = null;
    buffers.clear();
    shownVisual = null;
    root.classList.add('closing');
    setTimeout(() => { root.hidden = true; root.classList.remove('closing'); stage.innerHTML = ''; black.classList.remove('on'); }, 500);
    report();
  }

  // ------------------------------------------------------------ eventos do main

  J.onDoc((m) => {
    if (m.type === 'open') {
      if (doc) { gen++; stopAudio(); }
      doc = { id: m.id, mode: m.mode || 'doc', title: m.topic, subtitle: '', beats: [], total: null, i: 0, phase: 'pre', offset: 0, paused: false, auto: false, opened: false, quizDeadline: null };
      root.querySelector('.doc-kicker').textContent = m.kicker || 'J.A.R.V.I.S. · DOCUMENTÁRIO';
      root.dataset.mode = doc.mode;
      delete root.dataset.mood;
      // nova pergunta com o mapa já aberto: mantém o mapa na tela (a câmera continua de onde está)
      const keepMap = doc.mode === 'mapa' && !root.hidden && stage.querySelector('.doc-map:not(.out)');
      buffers.clear();
      hideAside();
      clearOverlays();
      shownVisual = keepMap ? { tipo: 'mapa' } : null;
      if (!keepMap) stage.innerHTML = '';
      sub.classList.remove('show');
      black.classList.remove('on');
      $('docTitle').textContent = m.topic;
      $('docScene').textContent = '';
      root.hidden = false;
      root.classList.remove('closing');
      setStatus(doc.mode === 'mapa' ? 'localizando…' : 'o diretor está montando o roteiro…');
      if (doc.mode === 'mapa') {
        if (!keepMap) LiveMap.mount(layer('doc-map'));
        shownVisual = { tipo: 'mapa' };
        LiveMap.spin();
      } else if (!keepMap) {
        layer('doc-loading', { sfx: false }).append(el('div', 'doc-loading-ring'), el('div', 'doc-loading-txt', 'ROTEIRO · IMAGENS · NARRAÇÃO'));
      }
      start();
      return;
    }
    if (!doc || m.id !== doc.id) return;
    if (m.type === 'header') {
      doc.title = m.titulo;
      doc.subtitle = m.subtitulo || '';
      doc.mood = m.clima;
      if (doc.mode === 'doc' && m.clima) root.dataset.mood = m.clima;
      $('docTitle').textContent = m.titulo;
    } else if (m.type === 'beat') {
      doc.beats[m.index] = m.beat;
    } else if (m.type === 'complete') {
      doc.total = m.total;
    } else if (m.type === 'error') {
      setStatus(`não consegui montar o documentário: ${m.message || 'erro'}`);
      setTimeout(() => close('erro'), 4000);
    }
  });

  J.onDocCommand(({ action, choice }) => {
    if (!doc) return;
    if (action === 'answer') answerQuiz(choice);
    else if (action === 'pause') pause(false);
    else if (action === 'hold') { if (doc.paused) { doc.auto = false; setStatus('PAUSADO · diga “continua”'); } else pause(false); }
    else if (action === 'resume') { setStatus(''); start(); }
    else if (action === 'back') jump(-1);
    else if (action === 'image') jumpToImage();
    else if (action === 'next') jump(1);
    else if (action === 'stop') close('comando de voz');
  });

  J.onDocAside((c) => {
    if (!doc) return;
    if (!doc.paused) pause(false);
    doc.auto = false;
    showAside(c);
  });

  // "Hey Jarvis" durante a narração: pausa na hora para ouvir; se ninguém falar nada, retoma sozinho.
  // Esperando a resposta do quiz, o microfone abre sem pausar (a resposta chega como comando "answer").
  J.onVoiceStatus(({ state: s }) => {
    if (!doc || doc.ended || doc.phase === 'answer') return;
    if ((s === 'wake' || s === 'listening') && !doc.paused) pause(true);
    else if (s === 'idle' && doc.paused && doc.auto) start();
  });

  root.addEventListener('click', (e) => {
    const q = e.target.closest('[data-quiz]');
    if (q && doc) { answerQuiz(Number(q.dataset.quiz)); return; }
    const b = e.target.closest('[data-doc]');
    if (!b || !doc) return;
    const a = b.dataset.doc;
    if (a === 'toggle') (doc.paused ? start : pause)();
    else if (a === 'back') jump(-1);
    else if (a === 'next') jump(1);
    else if (a === 'stop') close('botão');
  });

  document.addEventListener('keydown', (e) => {
    if (!doc || root.hidden || e.target.closest('input, textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); (doc.paused ? start : pause)(); }
    else if (e.code === 'ArrowLeft') jump(-1);
    else if (e.code === 'ArrowRight') jump(1);
    else if (e.code === 'Escape') close('tecla Esc');
    else if (/^Key[ABC]$/.test(e.code) && doc.phase === 'answer') answerQuiz('ABC'.indexOf(e.code.slice(3)));
  });
})();
