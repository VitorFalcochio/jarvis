// Fábrica de Hologramas: monta um objeto 3D a partir de uma descrição em peças (JSON) e anima a mecânica.
// Cada peça tem nome, grupo, forma(s), posição, direção de "explodir" e um movimento opcional ligado ao
// ângulo do eixo principal θ (girar, deslizar, pistão/biela com a física de biela-manivela, válvulas e
// centelha seguindo o ciclo de 4 tempos). O formato é o mesmo que a IA vai gerar na fase 2.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// tema: champanhe, âmbar, marfim (tokens.css), mais bronze e um azul frio para fluidos
const COLORS = { principal: 0xe9d6b6, destaque: 0xe2a04a, brilho: 0xfbf1e1, bronze: 0x9c8263, frio: 0x9fc3d6 };
const SELECT = 0xe2a04a;
const CLIP = [new THREE.Plane(new THREE.Vector3(0, 0, -1), 1e6)];
const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);
const num = (v, d) => (v !== undefined && v !== null && isFinite(Number(v)) ? Number(v) : d);
const vec = (a, d = [0, 0, 0]) => new THREE.Vector3(...(Array.isArray(a) && a.length === 3 ? a.map((x) => num(x, 0)) : d));
const colorOf = (c) => COLORS[c] ?? (typeof c === 'string' && /^#?[0-9a-f]{6}$/i.test(c) ? parseInt(c.replace('#', ''), 16) : COLORS.principal);
const quatOf = (r) => new THREE.Quaternion().setFromEuler(new THREE.Euler(...(Array.isArray(r) ? r : [0, 0, 0]).map((x) => num(x, 0) * DEG)));
export const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// ---------------------------------------------------------------- formas

function gearShape(r, teeth, depth) {
  const s = new THREE.Shape();
  const n = Math.max(6, Math.min(120, teeth | 0));
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, step = (Math.PI * 2) / n;
    const pts = [[a0, r - depth], [a0 + step * 0.15, r + depth * 0.2], [a0 + step * 0.45, r + depth * 0.2], [a0 + step * 0.6, r - depth]];
    pts.forEach(([a, rr], k) => (i === 0 && k === 0 ? s.moveTo(Math.cos(a) * rr, Math.sin(a) * rr) : s.lineTo(Math.cos(a) * rr, Math.sin(a) * rr)));
  }
  s.closePath();
  return s;
}

function geometry(f) {
  switch (f.tipo) {
    case 'caixa': { const d = Array.isArray(f.dims) ? f.dims : [1, 1, 1]; return new THREE.BoxGeometry(num(d[0], 1), num(d[1], 1), num(d[2], 1)); }
    case 'cilindro': return new THREE.CylinderGeometry(num(f.raio_topo, num(f.raio, 0.5)), num(f.raio, 0.5), num(f.altura, 1), num(f.lados, 16));
    case 'cone': return new THREE.ConeGeometry(num(f.raio, 0.5), num(f.altura, 1), num(f.lados, 16));
    case 'esfera': return new THREE.SphereGeometry(num(f.raio, 0.5), 14, 10);
    case 'toro': return new THREE.TorusGeometry(num(f.raio, 1), num(f.espessura, 0.1), 8, num(f.lados, 48));
    case 'tubo': {
      const ro = num(f.raio, 0.5), ri = num(f.raio_interno, ro * 0.8), h = num(f.altura, 1) / 2;
      return new THREE.LatheGeometry([[ri, -h], [ro, -h], [ro, h], [ri, h], [ri, -h]].map(([x, y]) => new THREE.Vector2(x, y)), num(f.lados, 24));
    }
    case 'torneado': {
      const pts = (Array.isArray(f.pontos) ? f.pontos : []).filter((p) => Array.isArray(p)).map(([r, y]) => new THREE.Vector2(Math.max(0, num(r, 0)), num(y, 0)));
      return pts.length >= 2 ? new THREE.LatheGeometry(pts, num(f.lados, 24)) : new THREE.SphereGeometry(0.2);
    }
    case 'extrusao': {
      const c = (Array.isArray(f.contorno) ? f.contorno : []).filter((p) => Array.isArray(p));
      if (c.length < 3) return new THREE.BoxGeometry(0.2, 0.2, 0.2);
      const s = new THREE.Shape(c.map(([x, y]) => new THREE.Vector2(num(x, 0), num(y, 0))));
      for (const hole of Array.isArray(f.furos) ? f.furos : []) {
        const h = (Array.isArray(hole) ? hole : []).filter((p) => Array.isArray(p));
        if (h.length >= 3) s.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(num(x, 0), num(y, 0)))));
      }
      const d = num(f.espessura, 0.2);
      return new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false }).translate(0, 0, -d / 2);
    }
    case 'engrenagem': {
      const r = num(f.raio, 0.6), d = num(f.espessura, 0.15);
      const s = gearShape(r, num(f.dentes, 20), num(f.dente, r * 0.1));
      if (num(f.furo, 0) > 0) { const h = new THREE.Path(); h.absarc(0, 0, num(f.furo, 0), 0, Math.PI * 2, true); s.holes.push(h); }
      return new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false, curveSegments: 4 }).translate(0, 0, -d / 2);
    }
    case 'mola': {
      const r = num(f.raio, 0.3), h = num(f.altura, 1), turns = num(f.voltas, 6);
      const pts = [];
      for (let i = 0; i <= turns * 24; i++) { const a = (i / 24) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * r, (i / (turns * 24) - 0.5) * h, Math.sin(a) * r)); }
      return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), turns * 24, num(f.fio, 0.03), 6);
    }
    case 'cano': {
      const pts = (Array.isArray(f.pontos) ? f.pontos : []).filter((p) => Array.isArray(p)).map((p) => vec(p));
      if (pts.length < 2) return new THREE.SphereGeometry(0.1);
      return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), pts.length * 16, num(f.raio, 0.08), 10);
    }
  }
  return null;
}

// Cada forma vira um "vidro" quase transparente + arestas brilhantes (o look de holograma)
function shapeObject(f, part) {
  const geo = geometry(f);
  if (!geo) return null;
  const col = colorOf(f.cor || part.cor);
  const style = f.estilo || part.estilo || (f.tipo === 'esfera' || f.tipo === 'mola' || f.tipo === 'cano' ? 'wire' : 'arestas');
  const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color: col, transparent: true, opacity: style === 'solido' ? 0.14 : 0.035,
    depthWrite: false, side: THREE.DoubleSide, clippingPlanes: CLIP,
  }));
  const lines = new THREE.LineSegments(
    style === 'wire' ? new THREE.WireframeGeometry(geo) : new THREE.EdgesGeometry(geo, f.tipo === 'tubo' || f.tipo === 'torneado' ? 35 : 20),
    new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: style === 'wire' ? 0.22 : 0.6, blending: THREE.AdditiveBlending, depthWrite: false, clippingPlanes: CLIP }),
  );
  const g = new THREE.Group();
  g.add(fill, lines);
  g.position.copy(vec(f.pos));
  g.quaternion.copy(quatOf(f.rot));
  fill.userData.base = { opacity: fill.material.opacity, color: col };
  lines.userData.base = { opacity: lines.material.opacity, color: col };
  return { g, fill, lines };
}

// ---------------------------------------------------------------- repetição

function expand(pecas) {
  const out = [];
  for (const p of Array.isArray(pecas) ? pecas : []) {
    if (!p || typeof p !== 'object') continue;
    const r = p.repetir;
    if (!r) { out.push(p); continue; }
    let copies = [];
    if (Array.isArray(r.lista)) copies = r.lista;
    else if (r.circulo) {
      const n = Math.max(1, Math.min(64, num(r.circulo.n ?? r.n, 6))), rad = num(r.circulo.raio, 1), ax = r.circulo.eixo || 'z', a0 = num(r.circulo.inicio, 0);
      copies = Array.from({ length: n }, (_, i) => {
        const a = a0 + (i * 360) / n, c = Math.cos(a * DEG) * rad, s = Math.sin(a * DEG) * rad;
        return ax === 'y' ? { pos: [c, 0, -s], rot_extra: [0, a, 0] } : ax === 'x' ? { pos: [0, c, s], rot_extra: [a, 0, 0] } : { pos: [c, s, 0], rot_extra: [0, 0, a] };
      });
    } else if (r.linha) {
      const n = Math.max(1, Math.min(64, num(r.linha.n ?? r.n, 3))), step = vec(r.linha.passo, [1, 0, 0]);
      copies = Array.from({ length: n }, (_, i) => ({ pos: step.clone().multiplyScalar(i - (n - 1) / 2).toArray() }));
    }
    copies.forEach((c, i) => {
      const pos = vec(p.pos).add(vec(c.pos));
      let rot = c.rot || p.rot;
      if (c.rot_extra) rot = (p.rot || [0, 0, 0]).map((x, k) => num(x, 0) + c.rot_extra[k]);
      out.push({
        ...p, ...c, repetir: undefined, rot_extra: undefined,
        id: `${p.id || 'peca'}_${i + 1}`, nome: c.nome || `${p.nome || p.id} ${i + 1}`,
        pos: pos.toArray(), rot, movimento: p.movimento || c.movimento ? { ...(p.movimento || {}), ...(c.movimento || {}) } : undefined,
        explodir: c.explodir || p.explodir,
      });
    });
  }
  return out;
}

// ---------------------------------------------------------------- mecânica

// manivela: centro C, eixo A, referência U (direção do moente em θ=0), raio r. Ângulo do moente ψ = θ + fase.
function crank(m, theta) {
  const C = vec(m.centro), A = vec(m.eixo, [1, 0, 0]).normalize(), U = vec(m.ref, [0, 1, 0]).normalize();
  const W = new THREE.Vector3().crossVectors(A, U);
  const psi = theta + num(m.fase, 0) * DEG;
  const pin = C.clone().addScaledVector(U, Math.cos(psi) * num(m.raio, 0.4)).addScaledVector(W, Math.sin(psi) * num(m.raio, 0.4));
  return { C, pin, psi };
}
// Biela-manivela: o pino do pistão anda só ao longo do cilindro D; a biela liga os dois pinos
function sliderCrank(mv, theta) {
  const { C, pin, psi } = crank(mv, theta);
  const D = vec(mv.dir, [0, 1, 0]).normalize();
  const rel = pin.clone().sub(C);
  const p = rel.dot(D), q = rel.clone().addScaledVector(D, -p).length();
  const L = num(mv.biela, 1.4);
  const s = p + Math.sqrt(Math.max(0, L * L - q * q));
  return { C, D, pin, psi, pistonPin: C.clone().addScaledVector(D, s) };
}
// posição no ciclo de 4 tempos (0–720°): 0 admissão, 180 compressão, 360 explosão, 540 escape
function cycle(mv, theta) {
  const { psi } = crank(mv, theta);
  const D = vec(mv.dir, [0, 1, 0]).normalize(), U = vec(mv.ref, [0, 1, 0]).normalize(), A = vec(mv.eixo, [1, 0, 0]).normalize();
  const alpha = Math.atan2(D.dot(new THREE.Vector3().crossVectors(A, U)), D.dot(U)); // ângulo do cilindro
  const deg = ((psi - alpha) / DEG + num(mv.ciclo, 0)) % 720;
  return { beta: (deg + 720) % 720, D };
}
export const STROKES = ['admissão', 'compressão', 'explosão', 'escape'];

function animate(part, theta, t) {
  const mv = part.def.movimento;
  const pos = part.basePos.clone(), quat = part.baseQuat.clone();
  let scale = 1, glow = null;
  if (mv) switch (mv.tipo) {
    case 'girar': quat.multiply(new THREE.Quaternion().setFromAxisAngle(vec(mv.eixo, [0, 1, 0]).normalize(), theta * num(mv.razao, 1) + num(mv.fase, 0) * DEG)); break;
    case 'girar_sempre': quat.multiply(new THREE.Quaternion().setFromAxisAngle(vec(mv.eixo, [0, 1, 0]).normalize(), t * num(mv.velocidade, 0.5))); break;
    case 'deslizar': { const k = Math.sin(theta * num(mv.razao, 1) + num(mv.fase, 0) * DEG); pos.addScaledVector(vec(mv.dir, [0, 1, 0]).normalize(), num(mv.amplitude, 0.2) * (mv.came ? Math.max(0, k) : k)); break; }
    case 'pulsar': scale = 1 + num(mv.amplitude, 0.08) * Math.sin(t * num(mv.velocidade, 3)); break;
    case 'pistao': { const sc = sliderCrank(mv, theta); pos.copy(sc.pistonPin).addScaledVector(sc.D, num(mv.offset, 0)); quat.setFromUnitVectors(UP, sc.D); break; }
    case 'biela': {
      const sc = sliderCrank(mv, theta);
      const dir = sc.pistonPin.clone().sub(sc.pin);
      pos.copy(sc.pin).add(sc.pistonPin).multiplyScalar(0.5);
      quat.setFromUnitVectors(UP, dir.normalize());
      break;
    }
    case 'valvula': {
      const { beta, D } = cycle(mv, theta);
      const [a, b] = mv.valvula === 'escape' ? [540, 720] : [0, 180];
      const k = beta >= a && beta < b ? Math.sin(((beta - a) / 180) * Math.PI) : 0;
      pos.addScaledVector(D, -num(mv.abertura, 0.12) * k);
      break;
    }
    case 'centelha': {
      const { beta } = cycle(mv, theta);
      const k = beta >= 355 && beta < 420 ? 1 - (beta - 355) / 65 : 0;
      glow = k; scale = 0.4 + k * 1.2;
      break;
    }
  }
  return { pos, quat, scale, glow };
}

// ---------------------------------------------------------------- motor de renderização

export function createForge(canvas, { onSelect, onHover } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setClearColor(0x030303, 1);
  renderer.localClippingEnabled = true;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 400);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.6;
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.42, 0.3, 0.15);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const root = new THREE.Group();   // o objeto (centralizado na origem)
  const deco = new THREE.Group();   // projetor no chão + anel de varredura
  scene.add(root, deco);

  let parts = [], model = null, radius = 3;
  let theta = 0, playing = true, speed = 1, rpm = 24;
  let explode = 0, explodeTarget = 0, cutAmount = 0, cutTarget = 0;
  let selected = null, isolated = null, raf = 0, last = performance.now();
  const clock = new THREE.Timer();
  let camAnim = null;

  function lineMat(color, opacity) { return new THREE.LineBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }); }
  function ring(r, color, opacity) {
    const pts = [];
    for (let i = 0; i <= 128; i++) { const a = (i / 128) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r)); }
    return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat(color, opacity));
  }
  function buildDeco(r, floorY) {
    deco.clear();
    [0.5, 1, 1.5, 2].forEach((k) => { const c = ring(r * k * 0.75, COLORS.principal, 0.14); c.position.y = floorY; deco.add(c); });
    const spokes = [];
    for (let i = 0; i < 36; i++) { const a = (i / 36) * Math.PI * 2; spokes.push(new THREE.Vector3(Math.cos(a) * r * 0.37, floorY, Math.sin(a) * r * 0.37), new THREE.Vector3(Math.cos(a) * r * 1.5, floorY, Math.sin(a) * r * 1.5)); }
    deco.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(spokes), lineMat(COLORS.principal, 0.06)));
    const scan = ring(r * 1.05, COLORS.principal, 0.3);
    scan.userData.scan = { y0: floorY, h: -floorY * 2 };
    deco.add(scan);
  }

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    bloom.resolution.set(w / 2, h / 2);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(canvas);

  // ------------------------------------------------------------ montar o modelo

  function load(m) {
    root.clear();
    root.position.set(0, 0, 0);
    parts = []; selected = null; isolated = null;
    model = m;
    for (const def of expand(m.pecas)) {
      const obj = new THREE.Group();
      const shapes = (Array.isArray(def.formas) ? def.formas : def.forma ? [def.forma] : []).slice(0, 40);
      const part = { def, obj, id: def.id, nome: def.nome || def.id, grupo: def.grupo || '', info: def.info || '', fills: [], lines: [], drag: new THREE.Vector3(), hidden: false };
      for (const f of shapes) {
        const s = shapeObject(f, def);
        if (!s) continue;
        obj.add(s.g);
        s.fill.userData.part = part;
        part.fills.push(s.fill); part.lines.push(s.lines);
      }
      if (!obj.children.length) continue;
      part.basePos = vec(def.pos);
      part.baseQuat = quatOf(def.rot);
      root.add(obj);
      parts.push(part);
    }
    // centraliza e define a direção de explodir que faltar (do centro para fora)
    parts.forEach((p) => { const a = animate(p, 0, 0); p.obj.position.copy(a.pos); p.obj.quaternion.copy(a.quat); });
    const box = new THREE.Box3().setFromObject(root);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    radius = Math.max(size.x, size.y, size.z) * 0.6 || 3;
    root.position.copy(center).multiplyScalar(-1);
    parts.forEach((p) => {
      if (Array.isArray(p.def.explodir)) p.explodeVec = vec(p.def.explodir);
      else {
        const c = new THREE.Box3().setFromObject(p.obj).getCenter(new THREE.Vector3()).sub(center);
        p.explodeVec = c.lengthSq() < 1e-6 ? new THREE.Vector3(0, radius * 0.6, 0) : c.normalize().multiplyScalar(radius * 0.7);
      }
    });
    buildDeco(radius, -size.y / 2 - radius * 0.25);
    rpm = num(m.rpm, 24);
    theta = 0; playing = m.animar !== false;
    const dist = num(m.camera?.distancia, radius * 3.1);
    camera.position.set(dist * 0.62, dist * 0.32, dist * 0.72);
    controls.target.set(0, 0, 0);
    controls.minDistance = radius * 0.6;
    controls.maxDistance = radius * 8;
    // entrada: as peças chegam voando e se encaixam
    explode = 1.6; explodeTarget = 0; cutAmount = cutTarget = 0;
    applyStyles();
    resize();
    return { nome: m.nome, pecas: parts.length };
  }

  // ------------------------------------------------------------ aparência (seleção / isolamento)

  function applyStyles() {
    for (const p of parts) {
      const dim = isolated && !isolated.has(p);
      const sel = p === selected;
      p.obj.visible = !p.hidden;
      p.fills.forEach((m) => {
        m.material.opacity = m.userData.base.opacity * (dim ? 0.15 : sel ? 4 : 1);
        m.material.color.setHex(sel ? SELECT : m.userData.base.color);
      });
      p.lines.forEach((m) => {
        m.material.opacity = Math.min(1, m.userData.base.opacity * (dim ? 0.1 : sel ? 1.6 : 1));
        m.material.color.setHex(sel ? SELECT : m.userData.base.color);
      });
    }
  }

  function find(query) {
    const q = norm(query);
    if (!q) return [];
    const exact = parts.filter((p) => norm(p.id) === q || norm(p.nome) === q);
    if (exact.length) return exact;
    const words = q.split(/\s+/).filter((w) => w.length > 2).map((w) => w.replace(/(oes|aes|es|s)$/, ''));
    return parts.filter((p) => {
      const hay = norm(`${p.id} ${p.nome} ${p.grupo}`);
      return words.length && words.every((w) => hay.includes(w));
    });
  }

  function select(part) {
    selected = part || null;
    applyStyles();
    onSelect?.(selected && { id: selected.id, nome: selected.nome, grupo: selected.grupo, info: selected.info });
  }

  function focusOn(list) {
    if (!list?.length) { camAnim = { target: new THREE.Vector3(), dist: radius * 3.1, t0: performance.now() }; return; }
    const box = new THREE.Box3();
    list.forEach((p) => box.expandByObject(p.obj));
    const c = box.getCenter(new THREE.Vector3()), r = box.getSize(new THREE.Vector3()).length() * 0.5;
    camAnim = { target: c, dist: Math.max(radius * 0.9, r * 3.2), t0: performance.now() };
  }

  // ------------------------------------------------------------ mouse: arrastar peças, selecionar, passar por cima

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let drag = null;
  const pick = (e) => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects(parts.filter((p) => p.obj.visible && !(isolated && !isolated.has(p))).flatMap((p) => p.fills), false);
    return hits[0] ? { part: hits[0].object.userData.part, point: hits[0].point } : null;
  };
  canvas.addEventListener('pointerdown', (e) => {
    controls.autoRotate = false;
    if (e.button !== 0) return;
    const hit = pick(e);
    if (!hit) return;
    controls.enabled = false;
    const n = camera.getWorldDirection(new THREE.Vector3());
    drag = { part: hit.part, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(n, hit.point), last: hit.point.clone(), x: e.clientX, y: e.clientY, moved: false };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (drag) {
      const r = canvas.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const p = ray.ray.intersectPlane(drag.plane, new THREE.Vector3());
      if (p) { drag.part.drag.add(p.clone().sub(drag.last)); drag.last.copy(p); }
      if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 4) drag.moved = true;
      return;
    }
    const hit = pick(e);
    canvas.style.cursor = hit ? 'grab' : '';
    onHover?.(hit ? { nome: hit.part.nome, x: e.clientX, y: e.clientY } : null);
  });
  canvas.addEventListener('pointerup', () => {
    if (!drag) return;
    if (!drag.moved) select(drag.part === selected ? null : drag.part);
    drag = null;
    controls.enabled = true;
  });
  canvas.addEventListener('dblclick', (e) => {
    const hit = pick(e);
    if (hit) { isolated = new Set([hit.part]); select(hit.part); focusOn([hit.part]); }
  });

  // ------------------------------------------------------------ laço

  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    clock.update(now);
    const t = clock.getElapsed();
    if (playing) theta += dt * (rpm / 60) * Math.PI * 2 * speed;
    explode += (explodeTarget - explode) * Math.min(1, dt * 2.6);
    cutAmount += (cutTarget - cutAmount) * Math.min(1, dt * 2.2);
    for (const p of parts) {
      const a = animate(p, theta, t);
      p.obj.position.copy(a.pos).addScaledVector(p.explodeVec, explode).add(p.drag);
      p.obj.quaternion.copy(a.quat);
      p.obj.scale.setScalar(a.scale);
      if (a.glow !== null) {
        p.fills.forEach((m) => { m.material.opacity = a.glow * 0.5; });
        p.lines.forEach((m) => { m.material.opacity = a.glow * 0.9; });
      }
    }
    // corte: um plano que avança da frente até o meio do objeto
    CLIP[0].constant = cutAmount > 0.005 ? THREE.MathUtils.lerp(radius * 3, 0, cutAmount) : 1e6;
    deco.children.forEach((c) => {
      if (!c.userData.scan) return;
      const k = (t * 0.25) % 1;
      c.position.y = c.userData.scan.y0 + k * c.userData.scan.h;
      c.material.opacity = 0.3 * (1 - k);
    });
    if (camAnim) {
      const k = Math.min(1, (now - camAnim.t0) / 900), e = 1 - Math.pow(1 - k, 3);
      controls.target.lerp(camAnim.target, e * 0.25);
      const dir = camera.position.clone().sub(controls.target).normalize();
      camera.position.lerp(controls.target.clone().addScaledVector(dir, camAnim.dist), e * 0.2);
      if (k >= 1) camAnim = null;
    }
    controls.update();
    composer.render();
    raf = requestAnimationFrame(loop);
  }

  return {
    load,
    start() { cancelAnimationFrame(raf); resize(); last = performance.now(); raf = requestAnimationFrame(loop); },
    stop() { cancelAnimationFrame(raf); raf = 0; },
    setExplode(v) { explodeTarget = Math.max(0, Math.min(2, v)); },
    get explode() { return explodeTarget; },
    play(on = !playing) { playing = on; return playing; },
    get playing() { return playing; },
    setSpeed(v) { speed = Math.max(0.05, Math.min(6, v)); },
    get speed() { return speed; },
    cut(on = cutTarget < 0.5) { cutTarget = on ? 1 : 0; return on; },
    find,
    select(query) { const p = typeof query === 'string' ? find(query)[0] : query; select(p); if (p) focusOn([p]); return p; },
    isolate(query) {
      if (!query) { isolated = null; applyStyles(); focusOn(null); return []; }
      const list = find(query);
      if (list.length) { isolated = new Set(list); applyStyles(); focusOn(list); }
      return list;
    },
    focus(query) { const list = query ? find(query) : null; focusOn(list); return list || []; },
    resetParts() { parts.forEach((p) => p.drag.set(0, 0, 0)); },
    reset() { parts.forEach((p) => { p.drag.set(0, 0, 0); p.hidden = false; }); isolated = null; selected = null; explodeTarget = 0; cutTarget = 0; applyStyles(); focusOn(null); controls.autoRotate = true; },
    autoRotate(on) { controls.autoRotate = on; },
    // estado do ciclo de 4 tempos do primeiro cilindro com válvula/centelha (para a legenda)
    strokeOf(id) { const p = parts.find((x) => x.id === id); return p?.def.movimento ? STROKES[Math.floor(cycle(p.def.movimento, theta).beta / 180)] : null; },
    get parts() { return parts.map((p) => ({ id: p.id, nome: p.nome, grupo: p.grupo, info: p.info })); },
    get model() { return model; },
    get selected() { return selected && { id: selected.id, nome: selected.nome, grupo: selected.grupo, info: selected.info }; },
  };
}
