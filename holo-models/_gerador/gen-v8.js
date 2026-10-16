// Gera holo-models/v8.json: V8 a 90° com virabrequim crossplane
const fs = require('fs');
const r = 0.42, L = 1.45;              // raio da manivela e comprimento da biela
const PINS = [-1.65, -0.55, 0.55, 1.65]; // x de cada moente
const PHASE = [0, 90, 270, 180];       // crossplane
const c45 = Math.SQRT1_2;
const BANKS = [
  { side: 'D', nome: 'direita', D: [0, c45, c45], perpOut: [0, -c45, c45], perpIn: [0, c45, -c45], rot: [45, 0, 0], alpha: 45, dx: 0.17 },
  { side: 'E', nome: 'esquerda', D: [0, c45, -c45], perpOut: [0, -c45, -c45], perpIn: [0, c45, c45], rot: [-45, 0, 0], alpha: -45, dx: -0.17 },
];
const add = (...v) => v.reduce((a, b) => a.map((x, i) => x + b[i]));
const mul = (v, k) => v.map((x) => x * k);
const round = (v) => v.map((x) => Math.round(x * 1000) / 1000);
const along = (bank, x, d, extra = [0, 0, 0]) => round(add([x, 0, 0], mul(bank.D, d), extra));

// ordem de ignição: escolhe o deslocamento do ciclo (0 ou 360) de cada cilindro para as 8 explosões
// ficarem espaçadas de 90° em 720°
const cyl = [];
PINS.forEach((x, k) => BANKS.forEach((b) => cyl.push({ x: x + b.dx, k, b })));
const used = new Set();
cyl.forEach((c) => {
  for (const off of [0, 360]) {
    const fire = (((360 - off - PHASE[c.k] + c.b.alpha) % 720) + 720) % 720;
    if (!used.has(fire)) { used.add(fire); c.ciclo = off; c.fire = fire; break; }
  }
});
console.log('explosões (θ):', cyl.map((c) => c.fire).sort((a, b) => a - b).join(' '));

const crank = (k) => ({ centro: [PINS[k], 0, 0], eixo: [1, 0, 0], ref: [0, 1, 0], raio: r, fase: PHASE[k] });
const pecas = [];

// ---------------- bloco
pecas.push({ id: 'carter_sup', nome: 'Bloco (cárter superior)', grupo: 'Bloco', cor: 'bronze', forma: { tipo: 'caixa', dims: [4.7, 1.3, 2.3] }, pos: [0, 0.1, 0], explodir: [0, 0, 0],
  info: 'A estrutura principal do motor, normalmente de ferro fundido ou alumínio. Sustenta o virabrequim nos mancais e forma os cilindros.' });
BANKS.forEach((b) => pecas.push({ id: `bancada_${b.side}`, nome: `Bancada ${b.nome}`, grupo: 'Bloco', cor: 'bronze', forma: { tipo: 'caixa', dims: [4.7, 1.6, 1.05] },
  pos: along(b, 0, 1.75), rot: b.rot, explodir: round(mul(b.D, 0.5)), info: `Metade ${b.nome} do "V": guarda 4 cilindros inclinados a 45°. As duas bancadas formam o V de 90°.` }));
pecas.push({ id: 'carter', nome: 'Cárter de óleo', grupo: 'Bloco', cor: 'bronze', forma: { tipo: 'caixa', dims: [4.3, 0.75, 2.0] }, pos: [0, -1.15, 0], explodir: [0, -3.2, 0],
  info: 'Reservatório de óleo embaixo do motor. A bomba puxa o óleo daqui para lubrificar mancais, bielas e pistões.' });

// ---------------- virabrequim (uma peça só: gira inteiro)
const formas = [{ tipo: 'cilindro', raio: 0.2, altura: 5.0, rot: [0, 0, 90] }];
PINS.forEach((x, k) => {
  const a = PHASE[k] * Math.PI / 180, dir = [0, Math.cos(a), Math.sin(a)];
  formas.push({ tipo: 'cilindro', raio: 0.16, altura: 0.62, pos: round(add([x, 0, 0], mul(dir, r))), rot: [0, 0, 90], cor: 'brilho' });
  [-0.38, 0.38].forEach((dx) => formas.push({ tipo: 'caixa', dims: [0.13, r + 0.75, 0.62], pos: round(add([x + dx, 0, 0], mul(dir, r / 2 - 0.12))), rot: [PHASE[k], 0, 0] }));
});
pecas.push({ id: 'virabrequim', nome: 'Virabrequim', grupo: 'Virabrequim', cor: 'brilho', formas, pos: [0, 0, 0], movimento: { tipo: 'girar', eixo: [1, 0, 0] }, explodir: [0, -1.7, 0],
  info: 'Transforma o sobe-e-desce dos pistões em rotação. Neste V8 "crossplane" os 4 moentes ficam a 90° entre si, o que deixa as explosões uniformes e dá o ronco característico.' });
pecas.push({ id: 'polia', nome: 'Polia do virabrequim', grupo: 'Virabrequim', forma: { tipo: 'cilindro', raio: 0.55, altura: 0.25, lados: 24 }, pos: [2.75, 0, 0], rot: [0, 0, 90],
  movimento: { tipo: 'girar', eixo: [0, 1, 0] }, explodir: [1.8, -1.7, 0], info: 'Na frente do motor: a correia passa por aqui para acionar alternador, bomba d\'água e ar-condicionado. Também amortece vibrações.' });
pecas.push({ id: 'volante', nome: 'Volante do motor', grupo: 'Virabrequim', forma: { tipo: 'engrenagem', raio: 1.2, dentes: 60, espessura: 0.14, furo: 0.22 }, pos: [-2.75, 0, 0], rot: [0, 90, 0],
  movimento: { tipo: 'girar', eixo: [0, 0, 1], razao: -1 }, explodir: [-1.9, -1.7, 0], info: 'Disco pesado que guarda energia entre as explosões e deixa a rotação suave. Os dentes são para o motor de partida engatar.' });

// ---------------- cilindros, pistões, bielas, cabeçote
cyl.forEach((c, i) => {
  const b = c.b, n = `${b.side}${c.k + 1}`, mv = { ...crank(c.k), dir: b.D, biela: L };
  pecas.push({ id: `cilindro_${n}`, nome: `Cilindro ${n}`, grupo: 'Cilindros', forma: { tipo: 'tubo', raio: 0.45, raio_interno: 0.42, altura: 1.5 }, pos: along(b, c.x, 1.75), rot: b.rot,
    explodir: round(mul(b.D, 1.9)), info: 'A camisa onde o pistão corre. A mistura de ar e combustível é comprimida e queima aqui dentro.' });
  pecas.push({ id: `pistao_${n}`, nome: `Pistão ${n}`, grupo: 'Pistões', cor: 'principal',
    forma: { tipo: 'torneado', pontos: [[0, -0.27], [0.4, -0.27], [0.4, 0.2], [0.41, 0.22], [0.41, 0.27], [0, 0.27]] },
    pos: along(b, c.x, r + L), movimento: { tipo: 'pistao', ...mv, offset: 0.12 }, explodir: round(mul(b.D, 2.7)),
    info: 'Recebe a força da explosão e empurra a biela. Os anéis no topo vedam a câmara para a pressão não escapar.' });
  pecas.push({ id: `biela_${n}`, nome: `Biela ${n}`, grupo: 'Bielas', forma: { tipo: 'caixa', dims: [0.14, L, 0.2] },
    pos: along(b, c.x, L / 2), movimento: { tipo: 'biela', ...mv }, explodir: round(mul(b.D, 1.6)),
    info: 'Liga o pistão ao virabrequim. No V8, as bielas das duas bancadas dividem o mesmo moente, lado a lado.' });
  ['admissao', 'escape'].forEach((tipo, j) => pecas.push({
    id: `valvula_${tipo}_${n}`, nome: `Válvula de ${tipo === 'admissao' ? 'admissão' : 'escape'} ${n}`, grupo: 'Válvulas', cor: tipo === 'escape' ? 'destaque' : 'frio',
    forma: { tipo: 'torneado', pontos: [[0, 0], [0.15, 0], [0.15, 0.03], [0.035, 0.09], [0.035, 0.6], [0, 0.6]] },
    pos: along(b, c.x + (j ? 0.15 : -0.15), 2.5), rot: b.rot,
    movimento: { tipo: 'valvula', ...mv, ciclo: c.ciclo, valvula: tipo, abertura: 0.13 }, explodir: round(mul(b.D, 4.1)),
    info: tipo === 'admissao' ? 'Abre no tempo de admissão para a mistura de ar e combustível entrar no cilindro.' : 'Abre no tempo de escape para os gases queimados saírem para o coletor.',
  }));
  pecas.push({ id: `vela_${n}`, nome: `Vela de ignição ${n}`, grupo: 'Ignição', cor: 'brilho', forma: { tipo: 'cilindro', raio: 0.05, altura: 0.55, lados: 8 },
    pos: along(b, c.x, 3.05), rot: b.rot, explodir: round(mul(b.D, 4.6)), info: 'Solta a faísca que inflama a mistura comprimida no início do tempo de explosão.' });
  pecas.push({ id: `explosao_${n}`, nome: `Combustão ${n}`, grupo: 'Ignição', cor: 'destaque', forma: { tipo: 'esfera', raio: 0.3 },
    pos: along(b, c.x, 2.33), movimento: { tipo: 'centelha', ...mv, ciclo: c.ciclo }, explodir: [0, 0, 0],
    info: 'A queima da mistura: a pressão dos gases empurra o pistão para baixo. É o único dos 4 tempos que gera força.' });
});
BANKS.forEach((b) => {
  pecas.push({ id: `cabecote_${b.side}`, nome: `Cabeçote ${b.nome}`, grupo: 'Cabeçotes', forma: { tipo: 'caixa', dims: [4.5, 0.55, 1.2] }, pos: along(b, 0, 2.78), rot: b.rot,
    explodir: round(mul(b.D, 3.3)), info: 'Fecha o topo dos cilindros. Abriga as válvulas, os dutos de admissão e escape e as velas.' });
  pecas.push({ id: `tampa_${b.side}`, nome: `Tampa de válvulas ${b.nome}`, grupo: 'Cabeçotes', cor: 'bronze', forma: { tipo: 'caixa', dims: [4.3, 0.3, 0.95] }, pos: along(b, 0, 3.25), rot: b.rot,
    explodir: round(mul(b.D, 5.2)), info: 'Tampa de proteção por cima do cabeçote; segura o óleo que lubrifica o comando das válvulas.' });
  // coletor de escape: um tubo por cilindro até o tubo coletor do lado de fora
  const ports = PINS.map((x) => along(b, x + b.dx, 2.55, mul(b.perpOut, 0.62)));
  const runner = (p) => ({ tipo: 'cano', raio: 0.09, pontos: [p, round(add(p, mul(b.perpOut, 0.35))), round(add(p, mul(b.perpOut, 0.6), [0, -0.35, 0]))] });
  const collector = ports.map((p) => round(add(p, mul(b.perpOut, 0.6), [0, -0.35, 0]))).reverse();
  collector.push(round(add(collector[collector.length - 1], [-0.7, -0.6, 0])));
  pecas.push({ id: `escape_${b.side}`, nome: `Coletor de escape ${b.nome}`, grupo: 'Escape', cor: 'destaque', formas: [...ports.map(runner), { tipo: 'cano', raio: 0.13, pontos: collector }],
    pos: [0, 0, 0], explodir: round(mul(b.perpOut, 2.6)), info: 'Recolhe os gases quentes dos 4 cilindros da bancada e manda para o escapamento.' });
});

// ---------------- admissão
const runners = [];
BANKS.forEach((b) => PINS.forEach((x) => {
  const port = along(b, x + b.dx, 2.55, mul(b.perpIn, 0.62));
  runners.push({ tipo: 'cano', raio: 0.09, pontos: [[x + b.dx, 2.75, 0], [x + b.dx, 2.75, port[2] * 0.5], port] });
}));
pecas.push({ id: 'coletor_admissao', nome: 'Coletor de admissão', grupo: 'Admissão', cor: 'frio', formas: [{ tipo: 'caixa', dims: [3.9, 0.45, 0.8], pos: [0, 2.85, 0] }, ...runners],
  pos: [0, 0, 0], explodir: [0, 3.6, 0], info: 'Distribui o ar para os 8 cilindros. Fica no "vale" entre as bancadas, como na maioria dos V8.' });
pecas.push({ id: 'borboleta', nome: 'Corpo de borboleta', grupo: 'Admissão', cor: 'frio', forma: { tipo: 'cilindro', raio: 0.32, altura: 0.5, lados: 20 }, pos: [2.3, 2.85, 0], rot: [0, 0, 90],
  explodir: [1.6, 3.6, 0], info: 'A "torneira" de ar do motor: quando você pisa no acelerador, a borboleta abre e entra mais ar.' });

const model = {
  nome: 'Motor V8', subtitulo: 'V8 a 90° · virabrequim crossplane · ciclo de 4 tempos', rpm: 24, animar: true,
  descricao: 'Motor de 8 cilindros em V a 90°. Quatro tempos: admissão, compressão, explosão e escape. Ordem de ignição com explosões a cada 90° de giro.',
  ciclo_referencia: 'explosao_D1',
  pecas,
};
fs.mkdirSync('E:/jarvis/holo-models', { recursive: true });
fs.writeFileSync('E:/jarvis/holo-models/v8.json', JSON.stringify(model));
console.log('peças-base:', pecas.length, 'bytes:', JSON.stringify(model).length);
