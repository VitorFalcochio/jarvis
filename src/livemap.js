// Mapa vivo: um único mapa (MapLibre, globo 3D) com estilo próprio no tema do JARVIS, tiles gratuitos do
// OpenFreeMap. O documentário monta o mapa dentro da cena e chama show() a cada beat: a câmera voa do ponto
// atual até o novo foco e as anotações (marcadores, raio, rota, área) aparecem quando ela chega.
const LiveMap = (() => {
  const A = '233,214,182'; // champanhe (tokens.css --accent-rgb)
  const NAME = ['coalesce', ['get', 'name:pt'], ['get', 'name:latin'], ['get', 'name']];
  const STYLE = {
    version: 8,
    projection: { type: 'globe' },
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: { omt: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' } },
    sky: { 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.9, 6, 0.3, 9, 0] },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#0c0b0a' } },
      { id: 'landcover', type: 'fill', source: 'omt', 'source-layer': 'landcover', filter: ['in', ['get', 'class'], ['literal', ['wood', 'forest', 'grass']]], paint: { 'fill-color': `rgba(${A},0.025)` } },
      { id: 'landuse', type: 'fill', source: 'omt', 'source-layer': 'landuse', minzoom: 9, filter: ['in', ['get', 'class'], ['literal', ['residential', 'industrial', 'commercial']]], paint: { 'fill-color': `rgba(${A},0.035)` } },
      { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', paint: { 'fill-color': '#030405', 'fill-outline-color': `rgba(${A},0.28)` } },
      { id: 'waterway', type: 'line', source: 'omt', 'source-layer': 'waterway', minzoom: 7, paint: { 'line-color': 'rgba(120,140,160,0.35)', 'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.4, 14, 2] } },
      { id: 'roads-minor', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 11, filter: ['in', ['get', 'class'], ['literal', ['secondary', 'tertiary', 'minor']]], paint: { 'line-color': `rgba(${A},0.09)`, 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.4, 16, 3] } },
      { id: 'roads-major', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 5, filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary']]], paint: { 'line-color': `rgba(${A},0.2)`, 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.4, 16, 4] } },
      { id: 'rail', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 9, filter: ['==', ['get', 'class'], 'rail'], paint: { 'line-color': `rgba(${A},0.12)`, 'line-width': 0.8, 'line-dasharray': [3, 3] } },
      { id: 'buildings', type: 'fill-extrusion', source: 'omt', 'source-layer': 'building', minzoom: 14, paint: { 'fill-extrusion-color': '#1a1815', 'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8], 'fill-extrusion-opacity': 0.75 } },
      { id: 'boundary-state', type: 'line', source: 'omt', 'source-layer': 'boundary', minzoom: 3, filter: ['all', ['==', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]], paint: { 'line-color': `rgba(${A},0.16)`, 'line-width': 0.7, 'line-dasharray': [2, 2] } },
      { id: 'boundary-country', type: 'line', source: 'omt', 'source-layer': 'boundary', filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]], paint: { 'line-color': `rgba(${A},0.5)`, 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.6, 8, 1.6] } },
      { id: 'water-name', type: 'symbol', source: 'omt', 'source-layer': 'water_name', layout: { 'text-field': NAME, 'text-font': ['Noto Sans Italic'], 'text-size': 12, 'text-letter-spacing': 0.2 }, paint: { 'text-color': 'rgba(150,165,180,0.55)' } },
      { id: 'place-village', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 10, filter: ['in', ['get', 'class'], ['literal', ['village', 'suburb', 'hamlet']]], layout: { 'text-field': NAME, 'text-font': ['Noto Sans Regular'], 'text-size': 11 }, paint: { 'text-color': '#7a7369', 'text-halo-color': '#000', 'text-halo-width': 1.2 } },
      { id: 'place-town', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 7, filter: ['==', ['get', 'class'], 'town'], layout: { 'text-field': NAME, 'text-font': ['Noto Sans Regular'], 'text-size': 12 }, paint: { 'text-color': '#958c80', 'text-halo-color': '#000', 'text-halo-width': 1.2 } },
      { id: 'place-city', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 3.5, filter: ['==', ['get', 'class'], 'city'], layout: { 'text-field': NAME, 'text-font': ['Noto Sans Regular'], 'text-size': ['interpolate', ['linear'], ['zoom'], 4, 11, 10, 15] }, paint: { 'text-color': '#c9bca6', 'text-halo-color': '#000', 'text-halo-width': 1.4 } },
      { id: 'place-country', type: 'symbol', source: 'omt', 'source-layer': 'place', maxzoom: 7, filter: ['==', ['get', 'class'], 'country'], layout: { 'text-field': ['upcase', NAME], 'text-font': ['Noto Sans Regular'], 'text-size': ['interpolate', ['linear'], ['zoom'], 1, 9, 5, 14], 'text-letter-spacing': 0.25 }, paint: { 'text-color': `rgba(${A},0.75)`, 'text-halo-color': '#000', 'text-halo-width': 1.4 } },
    ],
  };
  const EMPTY = { type: 'FeatureCollection', features: [] };

  let map = null;
  let box = null;     // div que contém o mapa (vai de cena em cena)
  let loaded = null;  // promessa do estilo carregado
  let token = 0;      // cada show() invalida as animações do anterior
  let markers = [];
  let routeAnim = null;
  let firstFlight = true;

  function ensure() {
    if (map) return;
    maplibregl.setWorkerUrl('../node_modules/maplibre-gl/dist/maplibre-gl-csp-worker.js');
    box = document.createElement('div');
    box.className = 'lm-map';
    map = new maplibregl.Map({
      container: box, style: STYLE, center: [0, 20], zoom: 1.3,
      attributionControl: { compact: true },
      fadeDuration: 200, maxPitch: 70,
    });
    map.on('error', (e) => console.error('[mapa]', e.error?.message || e));
    loaded = new Promise((r) => map.on('load', r)).then(() => {
      map.addSource('ann-area', { type: 'geojson', data: EMPTY });
      map.addSource('ann-radius', { type: 'geojson', data: EMPTY });
      map.addSource('ann-route', { type: 'geojson', data: EMPTY, lineMetrics: true });
      map.addLayer({ id: 'area-fill', type: 'fill', source: 'ann-area', paint: { 'fill-color': `rgba(${A},0.09)`, 'fill-opacity-transition': { duration: 1200 }, 'fill-opacity': 0 } });
      map.addLayer({ id: 'area-glow', type: 'line', source: 'ann-area', paint: { 'line-color': `rgba(${A},0.35)`, 'line-width': 7, 'line-blur': 6 } });
      map.addLayer({ id: 'area-line', type: 'line', source: 'ann-area', paint: { 'line-color': '#fbf1e1', 'line-width': 1.6 } });
      map.addLayer({ id: 'radius-fill', type: 'fill', source: 'ann-radius', paint: { 'fill-color': 'rgba(226,160,74,0.10)' } });
      map.addLayer({ id: 'radius-line', type: 'line', source: 'ann-radius', paint: { 'line-color': '#e2a04a', 'line-width': 1.8, 'line-dasharray': [3, 2] } });
      map.addLayer({ id: 'route-glow', type: 'line', source: 'ann-route', layout: { 'line-cap': 'round' }, paint: { 'line-color': `rgba(${A},0.4)`, 'line-width': 8, 'line-blur': 6 } });
      map.addLayer({ id: 'route-line', type: 'line', source: 'ann-route', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#fbf1e1', 'line-width': 2.2 } });
    });
  }

  function mount(container) {
    ensure();
    container.appendChild(box);
    requestAnimationFrame(() => map.resize());
  }

  // ---------------------------------------------------------------- geometria

  const rad = (d) => (d * Math.PI) / 180, deg = (r) => (r * 180) / Math.PI;
  function circle([lon, lat], km, n = 96) {
    const R = 6371, d = km / R, la = rad(lat), lo = rad(lon), pts = [];
    for (let i = 0; i <= n; i++) {
      const b = (i / n) * 2 * Math.PI;
      const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
      const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
      pts.push([deg(lo2), deg(la2)]);
    }
    return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [pts] }, properties: {} };
  }
  // arco de grande círculo entre dois pontos (rotas longas ficam curvas como no globo)
  function arc(a, b, n = 64) {
    const [l1, p1] = a.map(rad), [l2, p2] = b.map(rad);
    const d = 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2));
    if (d < 1e-6) return [a, b];
    const out = [];
    for (let i = 0; i <= n; i++) {
      const f = i / n, A1 = Math.sin((1 - f) * d) / Math.sin(d), B1 = Math.sin(f * d) / Math.sin(d);
      const x = A1 * Math.cos(p1) * Math.cos(l1) + B1 * Math.cos(p2) * Math.cos(l2);
      const y = A1 * Math.cos(p1) * Math.sin(l1) + B1 * Math.cos(p2) * Math.sin(l2);
      const z = A1 * Math.sin(p1) + B1 * Math.sin(p2);
      out.push([deg(Math.atan2(y, x)), deg(Math.atan2(z, Math.sqrt(x * x + y * y)))]);
    }
    // evita o "salto" ao cruzar o antimeridiano
    for (let i = 1; i < out.length; i++) while (out[i][0] - out[i - 1][0] > 180) out[i][0] -= 360;
    for (let i = 1; i < out.length; i++) while (out[i][0] - out[i - 1][0] < -180) out[i][0] += 360;
    return out;
  }

  // ---------------------------------------------------------------- anotações

  function clear() {
    markers.forEach((m) => m.remove());
    markers = [];
    if (routeAnim) cancelAnimationFrame(routeAnim);
    routeAnim = null;
    if (!map?.getSource('ann-area')) return;
    map.getSource('ann-area').setData(EMPTY);
    map.getSource('ann-radius').setData(EMPTY);
    map.getSource('ann-route').setData(EMPTY);
    map.setPaintProperty('area-fill', 'fill-opacity', 0);
  }

  function addMarker(coords, label, delay, main) {
    const el = document.createElement('div');
    el.className = `lm-marker${main ? ' main' : ''}`;
    el.innerHTML = '<span class="lm-ping"></span><span class="lm-dot"></span>';
    if (label) { const l = document.createElement('span'); l.className = 'lm-label'; l.textContent = label; el.appendChild(l); }
    el.style.animationDelay = `${delay}s`;
    markers.push(new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(coords).addTo(map));
  }

  function drawRoute(points, t) {
    const line = points.slice(1).flatMap((p, i) => arc(points[i], p).slice(i ? 1 : 0));
    const total = line.length, dur = 2600, t0 = performance.now();
    const step = (now) => {
      if (t !== token) return;
      const k = Math.min(1, (now - t0) / dur);
      const n = Math.max(2, Math.round(total * (1 - Math.pow(1 - k, 2))));
      map.getSource('ann-route').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: line.slice(0, n) }, properties: {} });
      if (k < 1) routeAnim = requestAnimationFrame(step);
    };
    routeAnim = requestAnimationFrame(step);
  }

  function annotate(v, t) {
    if (t !== token) return;
    if (v.area) {
      map.getSource('ann-area').setData(v.area);
      map.setPaintProperty('area-fill', 'fill-opacity', 1);
    }
    if (v.raio) map.getSource('ann-radius').setData(circle(v.raio.centro, v.raio.km));
    if (v.raio?.rotulo) addMarker(v.raio.borda, v.raio.rotulo, 0.4, false);
    if (v.rota?.length >= 2) drawRoute(v.rota.map((p) => p.coords), t);
    (v.rota || []).forEach((p, i) => p.rotulo && addMarker(p.coords, p.rotulo, 0.3 + i * 0.5, false));
    (v.marcadores || []).forEach((m, i) => addMarker(m.coords, m.rotulo, 0.2 + i * 0.35, i === 0));
  }

  // ---------------------------------------------------------------- câmera

  // globo girando no espaço enquanto a explicação é preparada
  async function spin() {
    ensure();
    const t = ++token;
    await loaded;
    if (t !== token) return;
    clear();
    if (firstFlight) map.jumpTo({ center: [-30, 15], zoom: 1.75, pitch: 0, bearing: 0 });
    firstFlight = false;
    let last = performance.now();
    const step = (now) => {
      if (t !== token) return;
      const c = map.getCenter();
      map.jumpTo({ center: [c.lng + (now - last) * 0.004, c.lat] });
      last = now;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  async function show(v) {
    ensure();
    const t = ++token;
    await loaded;
    if (t !== token) return;
    clear();
    const cam = { center: v.centro, zoom: v.zoom ?? 5, pitch: v.pitch ?? 0, bearing: v.bearing ?? 0 };
    if (v.bbox && v.zoom == null) {
      const c = map.cameraForBounds([[v.bbox[0], v.bbox[1]], [v.bbox[2], v.bbox[3]]], { padding: { top: 90, bottom: 170, left: 80, right: 80 } });
      if (c) { cam.center = c.center; cam.zoom = Math.min(c.zoom, 16); }
    }
    if (firstFlight) {
      // primeira vez: começa no espaço, com a Terra girando um pouco antes de mergulhar
      firstFlight = false;
      map.jumpTo({ center: [cam.center[0] - 60, Math.max(-50, Math.min(50, cam.center[1] * 0.4))], zoom: 1.75, pitch: 0, bearing: 0 });
      await new Promise((r) => setTimeout(r, 500));
      if (t !== token) return;
    }
    const far = Math.abs(map.getZoom() - cam.zoom) > 3 || map.getCenter().distanceTo({ lng: cam.center[0], lat: cam.center[1] }) > 800000;
    map.flyTo({ ...cam, duration: far ? 5200 : 2600, curve: 1.5, essential: true });
    map.once('moveend', () => annotate(v, t));
  }

  return { mount, show, spin, clear, get ready() { return !!map; } };
})();
