// Esforço no Chat: o bloco "Pensando…" (médio/máximo), o conselho ao vivo e o quadro comparativo (máximo),
// e a sugestão de "pensar no máximo" depois de um pedido grande. O seletor e o envio ficam em chat.js.
// Usa os globais do renderer.js/chat.js ($, el, J, chat, addBubble, sealAiBubble, aiBubble, button, uiSend, lastAsk...).

// ------------------------------------------------------------ raciocínio ("Pensando…")

let thinkBox = null;
J.onAiThinking((text) => {
  if (!thinkBox) {
    const box = addBubble('rich think');
    const det = el('details');
    const sum = el('summary', '', 'Pensando…');
    const body = el('pre', 'think-text');
    det.append(sum, body);
    box.append(det);
    thinkBox = { box, sum, body, t0: performance.now(), done: false };
  }
  if (thinkBox.done) return;
  thinkBox.body.textContent += text;
  scrollChat();
});
const finishThinking = () => {
  if (!thinkBox || thinkBox.done) return;
  thinkBox.done = true;
  thinkBox.box.classList.add('done');
  thinkBox.sum.textContent = `Pensou por ${Math.max(1, Math.round((performance.now() - thinkBox.t0) / 1000))} s`;
};
J.onAiDelta(finishThinking);
J.onAiDone(finishThinking);
J.onUserMessage(() => { thinkBox = null; });

// ------------------------------------------------------------ esforço máximo: o conselho ao vivo

const TIPO_LABEL = { produto: 'Ideia de produto', negocio: 'Ideia de negócio', arquitetura: 'Arquitetura', codigo: 'Código', bug: 'Investigação de bug', pergunta: 'Pergunta difícil', outro: 'Exploração' };
let deep = null;

const deepStage = (text) => { if (deep) deep.stage.textContent = text; };

J.onAiDeep((e) => {
  if (e.stage === 'plan') {
    sealAiBubble();
    aiBubble = null;
    const box = addBubble('rich deep');
    const head = el('div', 'deep-head');
    const clock = el('span', 'deep-clock muted', '0 s');
    head.append(el('span', 'rich-kicker', '🧠 ESFORÇO MÁXIMO · CONSELHO'), clock);
    const stage = el('div', 'deep-stage', 'Entendendo o pedido…');
    const bar = el('div', 'deep-bar');
    const fill = el('i');
    bar.append(fill);
    const chips = el('div', 'deep-chips');
    box.append(head, stage, bar, chips);
    const t0 = performance.now();
    deep = { box, stage, fill, chips, chipById: new Map(), total: 0, done: 0 };
    deep.timer = setInterval(() => { clock.textContent = `${Math.round((performance.now() - t0) / 1000)} s`; }, 500);
    fill.style.width = '8%';
    scrollChat();
    return;
  }
  if (!deep) return;
  if (e.stage === 'plan-done') {
    deep.total = e.angulos.length;
    deepStage(`${TIPO_LABEL[e.tipo] || 'Exploração'} · consultando ${e.angulos.length} especialistas em paralelo…`);
    deep.box.insertBefore(el('div', 'deep-goal', e.objetivo), deep.stage);
    e.angulos.forEach((a, i) => {
      const c = el('span', 'deep-chip', a.nome);
      c.style.animationDelay = `${i * 40}ms`;
      deep.chips.append(c);
      deep.chipById.set(a.id, c);
    });
    deep.fill.style.width = '15%';
  }
  if (e.stage === 'gen') {
    deep.done++;
    const c = deep.chipById.get(e.id);
    if (c) { c.classList.add(e.ok ? 'ok' : 'err'); if (e.titulo) c.title = e.titulo; }
    deepStage(`Consultando especialistas… ${deep.done}/${deep.total}`);
    deep.fill.style.width = `${15 + (deep.done / Math.max(1, deep.total)) * 55}%`;
  }
  if (e.stage === 'eval') {
    deepStage(`${e.count} abordagens na mesa · juntando as parecidas e dando notas…`);
    deep.fill.style.width = '78%';
    deep.box.classList.add('evaluating');
  }
  if (e.stage === 'done') {
    clearInterval(deep.timer);
    renderDeepResult(deep.box, e.result);
    deep = null;
  } else if (e.stage === 'error') {
    clearInterval(deep.timer);
    deep.box.classList.add('failed');
    deepStage(`O conselho não conseguiu terminar (${e.message}). Respondo pensando com esforço médio.`);
    deep = null;
  }
  scrollChat();
});

function renderDeepResult(box, r) {
  box.innerHTML = '';
  box.classList.remove('evaluating');
  box.classList.add('result');
  const head = el('div', 'deep-head');
  head.append(
    el('span', 'rich-kicker', `🧠 ESFORÇO MÁXIMO · ${(TIPO_LABEL[r.tipo] || 'Análise').toUpperCase()}`),
    el('span', 'deep-clock muted', `${r.angulos} ângulos → ${r.geradas} abordagens → ${r.opcoes.length} ${r.opcoes.length > 1 ? 'opções' : 'opção'} · ${r.segundos} s`),
  );
  box.append(head, el('h3', 'deep-title', r.titulo));

  const crit = el('div', 'deep-crit');
  r.criterios.forEach((c) => crit.append(el('span', '', `${c.nome}${c.peso > 1 ? ` ×${c.peso}` : ''}`)));
  if (r.consenso) crit.append(el('span', `deep-cons ${r.consenso}`, `consenso ${r.consenso === 'medio' ? 'médio' : r.consenso}`));
  box.append(crit);

  const list = el('ol', 'deep-opts');
  r.opcoes.forEach((o, i) => {
    const li = el('li', `deep-opt${o.recomendada ? ' rec' : ''}`);
    li.style.animationDelay = `${i * 90}ms`;
    const top = el('div', 'deep-opt-top');
    const name = el('div', 'deep-opt-name');
    name.append(el('span', 'deep-rank', String(i + 1)), el('b', '', o.titulo));
    if (o.recomendada) name.append(el('span', 'deep-badge', '★ Recomendada'));
    const score = el('div', 'deep-score');
    score.append(el('b', '', o.total.toFixed(1).replace('.', ',')), el('small', '', '/10'));
    top.append(name, score);
    li.append(top, el('p', 'deep-sum', o.resumo));

    const bars = el('div', 'deep-bars');
    Object.entries(o.notas).forEach(([k, v]) => {
      const row = el('div', 'deep-barrow');
      const track = el('div', 'deep-track');
      const fill = el('i');
      fill.style.width = '0%';
      setTimeout(() => { fill.style.width = `${v * 10}%`; }, 200 + i * 90);
      track.append(fill);
      row.append(el('span', '', k), track, el('small', '', String(v)));
      bars.append(row);
    });
    li.append(bars);

    const meta = el('div', 'deep-meta');
    if (o.prazo) meta.append(el('span', '', `⏱ ${o.prazo}`));
    if (o.risco) meta.append(el('span', 'risk', `⚠ ${o.risco}`));
    if (meta.children.length) li.append(meta);

    const foot = el('div', 'deep-foot');
    if (o.passos.length) {
      const det = el('details', 'deep-steps');
      det.append(el('summary', '', `Primeiros passos (${o.passos.length})`));
      const ol = el('ol');
      o.passos.forEach((p) => ol.append(el('li', '', p)));
      det.append(ol);
      foot.append(det);
    }
    foot.append(button('Aprofundar →', 'mini', () => uiSend(`Aprofunda a opção "${o.titulo}": plano detalhado, riscos e como começar hoje.`, undefined, { effort: 'mid' })));
    li.append(foot);
    list.append(li);
  });
  box.append(list);
  if (r.porque) {
    const why = el('div', 'deep-why');
    why.append(el('b', '', 'Por que a recomendada'), el('p', '', r.porque));
    box.append(why);
  }
}

// ------------------------------------------------------------ sugestão de pensar mais

// Pedido "grande" respondido no Mínimo/Médio: oferece refazer com o conselho (quem decide é o usuário)
const BIG_ASK = /\b(quero (criar|montar|lan[cç]ar|fazer um|come[cç]ar)|ideias? de|modelo de neg[oó]cio|como (posso )?(ganhar|monetizar|vender|escalar)|arquitetura|estrat[eé]gia|qual (a )?melhor (forma|maneira|jeito)|n[aã]o sei (o que|como) fazer|bug (estranho|dif[ií]cil)|por que (n[aã]o )?funciona)/i;
J.onAiDone(() => {
  if (currentScreen !== 'chat' || !lastAsk || lastAsk.effort === 'max' || !BIG_ASK.test(lastAsk.text)) return;
  const ask = lastAsk;
  lastAsk = null;
  const box = addBubble('upgrade');
  box.append(button('🧠 Pensar no máximo nisso', 'mini', () => { box.remove(); uiSend(ask.text, undefined, { effort: 'max' }); }, 'Um conselho explora várias abordagens e compara com notas (30 a 90 s)'));
  scrollChat();
});
