// Motor de hologramas 3D (Three.js): modelos procedurais em wireframe. Cada createHolo() é uma cena
// independente; usado pelo painel de holograma do HUD e pelo holograma central da Oficina.
import * as THREE from '../node_modules/three/build/three.module.js';

// cores do tema: champanhe (linhas), âmbar (destaques) e marfim (brilhos)
const CYAN = 0xe9d6b6, GOLD = 0xe2a04a, WHITE = 0xfbf1e1;
// Os modelos registram suas animações aqui; o motor aponta para o array da cena que está montando
let animated = [];

const lineMat = (color = CYAN, opacity = 0.85) => new THREE.LineBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
const pointMat = (color = CYAN, size = 0.05, opacity = 0.95) => new THREE.PointsMaterial({ color, size, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });

function circle(radius, segments = 96, color = CYAN, opacity = 0.8) {
  const pts = [];
  for (let i = 0; i <= segments; i++) { const a = (i / segments) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0)); }
  return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat(color, opacity));
}
const wire = (geometry, color = CYAN, opacity = 0.6) => new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 1), lineMat(color, opacity));
const wireframe = (geometry, color = CYAN, opacity = 0.35) => new THREE.LineSegments(new THREE.WireframeGeometry(geometry), lineMat(color, opacity));

// ---------------------------------------------------------------- modelos

function arcReactor() {
  const g = new THREE.Group();
  [1.6, 1.45, 1.05, 0.55].forEach((r, i) => g.add(circle(r, 128, i === 3 ? WHITE : CYAN, 0.9)));
  // 10 bobinas em volta do anel (o reator do Mark I/II)
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const coil = wire(new THREE.BoxGeometry(0.34, 0.2, 0.18), CYAN, 0.9);
    coil.position.set(Math.cos(a) * 1.25, Math.sin(a) * 1.25, 0);
    coil.rotation.z = a;
    g.add(coil);
  }
  // triângulo central do Mark VI
  const tri = [0, 1, 2, 0].map((k) => { const a = Math.PI / 2 + (k * Math.PI * 2) / 3; return new THREE.Vector3(Math.cos(a) * 0.9, Math.sin(a) * 0.9, 0.05); });
  g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(tri), lineMat(WHITE, 1)));
  const torus = wireframe(new THREE.TorusGeometry(1.25, 0.12, 8, 60), CYAN, 0.25);
  g.add(torus);
  const core = new THREE.Points(new THREE.SphereGeometry(0.4, 24, 16), pointMat(WHITE, 0.035));
  g.add(core);
  animated.push((t) => { core.scale.setScalar(1 + Math.sin(t * 3) * 0.08); torus.rotation.z = t * 0.3; });
  return g;
}

function earth() {
  const g = new THREE.Group();
  // pontos distribuídos na esfera (espiral de Fibonacci)
  const n = 2200, pts = [];
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2, r = Math.sqrt(1 - y * y), th = i * Math.PI * (3 - Math.sqrt(5));
    pts.push(new THREE.Vector3(Math.cos(th) * r * 1.6, y * 1.6, Math.sin(th) * r * 1.6));
  }
  g.add(new THREE.Points(new THREE.BufferGeometry().setFromPoints(pts), pointMat(CYAN, 0.025, 0.7)));
  for (let lat = -60; lat <= 60; lat += 30) {
    const c = circle(1.6 * Math.cos((lat * Math.PI) / 180), 96, CYAN, 0.25);
    c.rotation.x = Math.PI / 2; c.position.y = 1.6 * Math.sin((lat * Math.PI) / 180);
    g.add(c);
  }
  for (let lon = 0; lon < 180; lon += 30) { const c = circle(1.6, 96, CYAN, 0.2); c.rotation.y = (lon * Math.PI) / 180; g.add(c); }
  // cidades (lat, lon)
  const cities = [[-23.55, -46.63], [-22.9, -43.2], [40.7, -74], [51.5, -0.12], [35.7, 139.7], [48.85, 2.35], [-33.9, 151.2]];
  cities.forEach(([la, lo], i) => {
    const phi = ((90 - la) * Math.PI) / 180, th = ((lo + 180) * Math.PI) / 180;
    const p = new THREE.Vector3(-1.6 * Math.sin(phi) * Math.cos(th), 1.6 * Math.cos(phi), 1.6 * Math.sin(phi) * Math.sin(th));
    const spike = new THREE.Line(new THREE.BufferGeometry().setFromPoints([p, p.clone().multiplyScalar(i < 2 ? 1.22 : 1.1)]), lineMat(i < 2 ? GOLD : WHITE, 1));
    g.add(spike);
  });
  const ring = circle(2.1, 128, GOLD, 0.35);
  ring.rotation.x = Math.PI / 2.4;
  g.add(ring);
  animated.push((t) => { ring.rotation.z = t * 0.2; });
  return g;
}

function atom() {
  const g = new THREE.Group();
  const nucleus = new THREE.Points(new THREE.IcosahedronGeometry(0.35, 3), pointMat(GOLD, 0.06));
  g.add(nucleus);
  [0, Math.PI / 3, -Math.PI / 3].forEach((rot, i) => {
    const orbit = new THREE.Group();
    const path = circle(1.6, 128, CYAN, 0.55);
    path.scale.y = 0.45;
    orbit.add(path);
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 8), new THREE.MeshBasicMaterial({ color: WHITE }));
    orbit.add(e);
    orbit.rotation.z = rot;
    orbit.rotation.x = 0.4;
    g.add(orbit);
    animated.push((t) => { const a = t * (1.6 + i * 0.4) + i * 2; e.position.set(Math.cos(a) * 1.6, Math.sin(a) * 1.6 * 0.45, 0); });
  });
  animated.push((t) => { nucleus.rotation.y = t; });
  return g;
}

function solarSystem() {
  const g = new THREE.Group();
  g.add(new THREE.Points(new THREE.IcosahedronGeometry(0.35, 3), pointMat(GOLD, 0.05)));
  const planets = [[0.6, 0.04, 4.1], [0.85, 0.06, 1.6], [1.15, 0.065, 1], [1.45, 0.05, 0.53], [1.95, 0.16, 0.084], [2.4, 0.13, 0.034], [2.8, 0.09, 0.012], [3.15, 0.09, 0.006]];
  planets.forEach(([r, size, speed], i) => {
    const orbit = circle(r, 128, CYAN, 0.25);
    orbit.rotation.x = Math.PI / 2;
    g.add(orbit);
    const p = wireframe(new THREE.IcosahedronGeometry(size, 1), i === 2 ? CYAN : WHITE, 0.9);
    g.add(p);
    const offset = i * 1.3;
    animated.push((t) => { const a = t * speed * 2 + offset; p.position.set(Math.cos(a) * r, 0, Math.sin(a) * r); p.rotation.y = t; });
    if (i === 5) { const ring = circle(size * 1.8, 48, GOLD, 0.6); ring.rotation.x = Math.PI / 2.3; p.add(ring); }
  });
  return g;
}

function dna() {
  const g = new THREE.Group();
  const a = [], b = [], rungs = [];
  for (let i = 0; i <= 160; i++) {
    const t = i / 160, y = (t - 0.5) * 4, ang = t * Math.PI * 6;
    const pa = new THREE.Vector3(Math.cos(ang) * 0.8, y, Math.sin(ang) * 0.8);
    const pb = new THREE.Vector3(Math.cos(ang + Math.PI) * 0.8, y, Math.sin(ang + Math.PI) * 0.8);
    a.push(pa); b.push(pb);
    if (i % 6 === 0) rungs.push(pa, pb);
  }
  g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(a), lineMat(CYAN, 0.95)));
  g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(b), lineMat(GOLD, 0.95)));
  g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(rungs), lineMat(WHITE, 0.4)));
  return g;
}

const MODELS = {
  arc_reactor: ['REATOR ARC', arcReactor],
  earth: ['PLANETA TERRA', earth],
  atom: ['ÁTOMO', atom],
  solar_system: ['SISTEMA SOLAR', solarSystem],
  dna: ['DNA', dna],
};


export function createHolo(canvas, { mouse = true, zoomBase = 6 } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(devicePixelRatio);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 0.6, zoomBase);
  camera.lookAt(0, 0, 0);
  const root = new THREE.Group();
  scene.add(root);
  // "projetor" no chão: anéis concêntricos e linhas radiais
  const floor = new THREE.Group();
  [0.8, 1.6, 2.4, 3.2].forEach((r) => floor.add(circle(r, 96, CYAN, 0.18)));
  const spokes = [];
  for (let i = 0; i < 24; i++) { const ang = (i / 24) * Math.PI * 2; spokes.push(new THREE.Vector3(Math.cos(ang) * 0.8, Math.sin(ang) * 0.8, 0), new THREE.Vector3(Math.cos(ang) * 3.2, Math.sin(ang) * 3.2, 0)); }
  floor.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(spokes), lineMat(CYAN, 0.08)));
  floor.rotation.x = Math.PI / 2;
  floor.position.y = -2.3;
  scene.add(floor);
  const clock = new THREE.Clock();
  const anim = [];
  let model = null, raf = 0, targetRot = { x: 0.25, y: 0 }, targetZoom = zoomBase, lastInput = 0;

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(canvas);

  function loop() {
    const t = clock.getElapsedTime();
    if (performance.now() - lastInput > 2500) targetRot.y += 0.004;
    root.rotation.x += (targetRot.x - root.rotation.x) * 0.12;
    root.rotation.y += (targetRot.y - root.rotation.y) * 0.12;
    camera.position.z += (targetZoom - camera.position.z) * 0.12;
    anim.forEach((fn) => fn(t));
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  }

  function setModel(name) {
    const entry = MODELS[name] || MODELS.arc_reactor;
    if (model) root.remove(model);
    anim.length = 0;
    animated = anim; // os construtores dos modelos registram as animações nesta cena
    // anel de varredura que sobe pelo holograma
    scene.children.filter((c) => c.userData.scan).forEach((c) => scene.remove(c));
    const scan = circle(2.2, 96, CYAN, 0.35);
    scan.rotation.x = Math.PI / 2;
    scan.userData.scan = true;
    scene.add(scan);
    anim.push((t) => { const k = (t * 0.8) % 4.4; scan.position.y = -2.2 + k; scan.material.opacity = 0.35 * (1 - k / 4.4); });
    model = entry[1]();
    root.add(model);
    targetRot = { x: 0.25, y: 0 };
    targetZoom = zoomBase;
    resize();
    return entry[0];
  }

  const rotate = (dx, dy) => { lastInput = performance.now(); targetRot.y += dx; targetRot.x = Math.max(-1.3, Math.min(1.3, targetRot.x + dy)); };
  const zoom = (f) => { lastInput = performance.now(); targetZoom = Math.max(2.5, Math.min(12, targetZoom * f)); };

  if (mouse) {
    let drag = null;
    canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', (e) => { if (!drag) return; rotate((e.clientX - drag.x) * 0.008, (e.clientY - drag.y) * 0.008); drag = { x: e.clientX, y: e.clientY }; });
    canvas.addEventListener('pointerup', () => { drag = null; });
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoom(e.deltaY > 0 ? 1.1 : 0.9); }, { passive: false });
  }

  return {
    setModel, rotate, zoom,
    start() { cancelAnimationFrame(raf); resize(); raf = requestAnimationFrame(loop); },
    stop() { cancelAnimationFrame(raf); raf = 0; },
    get running() { return !!raf; },
  };
}

export const HOLO_MODELS = Object.fromEntries(Object.entries(MODELS).map(([k, v]) => [k, v[0]]));
