// Turbo Pist — Three.js 3D görüntüleyici (oyun mantığı araba_yarisi.html içinde kalır)
import {
  WebGLRenderer, Scene, PerspectiveCamera, Color, Fog, CanvasTexture, SRGBColorSpace, RepeatWrapping,
  MeshBasicMaterial, MeshLambertMaterial, PlaneGeometry, SphereGeometry, BufferGeometry, BufferAttribute,
  Mesh, Group, HemisphereLight, DirectionalLight, ConeGeometry, CylinderGeometry, BoxGeometry,
  InstancedMesh, Object3D, BackSide, DynamicDrawUsage, Float32BufferAttribute
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const LANE = 5.0;          // playerX = 1 -> 5 dünya birimi
const ROAD_HALF = 5.6;     // yol yarı genişliği
const KERB_W = 0.85, SHOULDER_W = 1.0;
const ROWS = 64, Z_NEAR = 18, Z_FAR = -250;
const CAR_SCALE = 1.5;
const MODEL_COLORS = ['yellow', 'red', 'green', 'purple']; // 0: oyuncu, 1-3: rakipler
const FALLBACK_COLORS = [0xc9ff3b, 0xe0553f, 0x3fa85a, 0x8b57c9];

// ---- Yol eğrisi (yalnızca görsel; oyun mantığı eskisi gibi) ----
const lat = s => 14 * Math.sin(s * 0.012) + 6 * Math.sin(s * 0.0271 + 1.0);
const slope = s => 14 * 0.012 * Math.cos(s * 0.012) + 6 * 0.0271 * Math.cos(s * 0.0271 + 1.0);
let D = 0;
const bend = u => lat(D + u) - lat(D) - slope(D) * u;
const bendSlope = u => slope(D + u) - slope(D);

function canvasTex(w, h, draw, repeat = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  if (repeat) { t.wrapS = t.wrapT = RepeatWrapping; }
  return t;
}
function speckle(g, w, h, n, a) {
  for (let i = 0; i < n; i++) {
    g.fillStyle = Math.random() < .5 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`;
    g.fillRect(Math.random() * w, Math.random() * h, 1.5, 1.5);
  }
}

// ---- Yedek (prosedürel) araç: model dosyası yüklenemezse ----
function buildFallbackCar(color) {
  const g = new Group();
  const body = new MeshLambertMaterial({ color }), dark = new MeshLambertMaterial({ color: 0x15191d }),
    glass = new MeshLambertMaterial({ color: 0x1c3545 }), light = new MeshLambertMaterial({ color: 0xf7f2c2 });
  const add = (geo, mat, x, y, z) => { const m = new Mesh(geo, mat); m.position.set(x, y, z); g.add(m); return m; };
  add(new BoxGeometry(1.3, 0.5, 2.7), body, 0, 0.6, 0.05);
  add(new BoxGeometry(1.05, 0.42, 1.3), glass, 0, 1.03, -0.1);
  add(new BoxGeometry(0.4, 0.12, 0.08), light, -0.38, 0.62, 1.4);
  add(new BoxGeometry(0.4, 0.12, 0.08), light, 0.38, 0.62, 1.4);
  const wg = new CylinderGeometry(0.3, 0.3, 0.3, 14); wg.rotateZ(Math.PI / 2);
  [['front-left', .55, .857], ['front-right', -.55, .857], ['back-left', .55, -.657], ['back-right', -.55, -.657]]
    .forEach(([n, x, z]) => { const w = new Group(); w.name = 'wheel-' + n; w.position.set(x, 0.3, z); w.add(new Mesh(wg, dark)); g.add(w); });
  return g;
}

function findWheels(root) {
  const w = {};
  [['fl', 'wheel-front-left'], ['fr', 'wheel-front-right'], ['bl', 'wheel-back-left'], ['br', 'wheel-back-right']]
    .forEach(([k, n]) => { const o = root.getObjectByName(n); if (o) { o.rotation.order = 'YXZ'; w[k] = o; } });
  return w;
}

function lambertize(root) {
  root.traverse(o => {
    if (o.isMesh) {
      const old = o.material;
      o.material = new MeshLambertMaterial({ map: old.map || null, color: old.map ? 0xffffff : old.color });
      o.frustumCulled = true;
    }
  });
}

// ---- Model yükleme: 1) models/*.glb  2) js/models-embedded.js (file:// için)  3) yedek araç ----
let embeddedPromise = null;
function loadEmbedded() {
  if (window.TURBO_MODELS) return Promise.resolve(window.TURBO_MODELS);
  if (!embeddedPromise) embeddedPromise = new Promise(res => {
    const s = document.createElement('script');
    s.src = 'js/models-embedded.js';
    s.onload = () => res(window.TURBO_MODELS || null);
    s.onerror = () => res(null);
    document.head.appendChild(s);
  });
  return embeddedPromise;
}
const parseGlb = (loader, buf) => new Promise((res, rej) => loader.parse(buf, '', res, rej));
async function loadModel(name) {
  const loader = new GLTFLoader();
  try {
    if (location.protocol === 'file:') throw new Error('file://');
    const r = await fetch('models/araba-' + name + '.glb');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return (await parseGlb(loader, await r.arrayBuffer())).scene;
  } catch (e) { /* file:// veya ağ hatası -> gömülü kopya */ }
  try {
    const m = await loadEmbedded();
    if (m && m[name]) {
      const bin = atob(m[name]), u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return (await parseGlb(loader, u8.buffer)).scene;
    }
  } catch (e) { console.warn('Gömülü model okunamadı:', name, e); }
  return null;
}

function create(canvas) {
  const renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
  let pr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(pr);
  renderer.outputColorSpace = SRGBColorSpace;

  let ctxLost = false;
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); ctxLost = true; });
  canvas.addEventListener('webglcontextrestored', () => { ctxLost = false; });

  const scene = new Scene();
  const HORIZON = new Color('#a9d6d3');
  scene.fog = new Fog(HORIZON, 70, 235);
  const camera = new PerspectiveCamera(66, 1, 0.3, 420);

  scene.add(new HemisphereLight(0xffffff, 0x58774a, 1.55));
  const sun = new DirectionalLight(0xfff2d6, 1.9); sun.position.set(-6, 12, 8); scene.add(sun);

  // Gökyüzü kubbesi (kameraya sabit)
  {
    const g = new SphereGeometry(380, 20, 10);
    const p = g.attributes.position, col = new Float32Array(p.count * 3);
    const top = new Color('#16445e'), mid = new Color('#4a97b0'), c = new Color();
    for (let i = 0; i < p.count; i++) {
      const t = Math.max(0, p.getY(i) / 380);
      if (t < 0.35) c.copy(HORIZON).lerp(mid, Math.pow(t / 0.35, 0.8)); else c.copy(mid).lerp(top, (t - 0.35) / 0.65);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new BufferAttribute(col, 3));
    var sky = new Mesh(g, new MeshBasicMaterial({ vertexColors: true, side: BackSide, fog: false, depthWrite: false }));
    sky.renderOrder = -10; sky.frustumCulled = false; scene.add(sky);
  }

  // Doku
  const aniso = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  const roadTex = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#2b3036'; g.fillRect(0, 0, w, h); speckle(g, w, h, 1400, 0.06);
    g.fillStyle = '#e8e7d5';
    [w / 3, 2 * w / 3].forEach(x => g.fillRect(x - 3, 0, 6, h / 2));
    g.fillRect(w * .018, 0, 4, h); g.fillRect(w * .982 - 4, 0, 4, h);
  });
  const kerbTex = canvasTex(32, 128, (g, w, h) => {
    for (let i = 0; i < 4; i++) { g.fillStyle = i % 2 ? '#f1f0e8' : '#e64e55'; g.fillRect(0, i * 32, w, 32); }
  });
  const shoulderTex = canvasTex(64, 64, (g, w, h) => { g.fillStyle = '#626a70'; g.fillRect(0, 0, w, h); speckle(g, w, h, 300, 0.07); });
  const grassTex = canvasTex(64, 128, (g, w, h) => {
    g.fillStyle = '#6a9d52'; g.fillRect(0, 0, w, h / 2); g.fillStyle = '#608f4a'; g.fillRect(0, h / 2, w, h / 2);
    speckle(g, w, h, 500, 0.05);
  });
  [roadTex, kerbTex, shoulderTex].forEach(t => { t.anisotropy = aniso; });
  grassTex.repeat.set(400 / 40, 260 / 24); grassTex.anisotropy = aniso;

  const grass = new Mesh(new PlaneGeometry(400, 260).rotateX(-Math.PI / 2), new MeshBasicMaterial({ map: grassTex }));
  grass.position.set(0, -0.01, -110); grass.frustumCulled = false; scene.add(grass);

  // Yol şeritleri (her karede yeniden hesaplanır)
  const zRows = new Float32Array(ROWS);
  for (let i = 0; i < ROWS; i++) zRows[i] = Z_NEAR + (Z_FAR - Z_NEAR) * Math.pow(i / (ROWS - 1), 1.35);
  const strips = [];
  function addStrip(x0, x1, y, map, tile, offsetPoly = 0) {
    const geo = new BufferGeometry();
    const pos = new Float32Array(ROWS * 2 * 3), uv = new Float32Array(ROWS * 2 * 2), idx = [];
    for (let i = 0; i < ROWS - 1; i++) { const a = i * 2, b = a + 1, c = a + 2, d = a + 3; idx.push(a, b, c, b, d, c); }
    geo.setAttribute('position', new BufferAttribute(pos, 3).setUsage(DynamicDrawUsage));
    geo.setAttribute('uv', new BufferAttribute(uv, 2).setUsage(DynamicDrawUsage));
    geo.setIndex(idx);
    const mat = new MeshBasicMaterial({ map, polygonOffset: true, polygonOffsetFactor: -1 - offsetPoly, polygonOffsetUnits: -1 - offsetPoly });
    const m = new Mesh(geo, mat); m.frustumCulled = false; scene.add(m);
    strips.push({ x0, x1, y, tile, pos, uv, geo });
  }
  addStrip(-ROAD_HALF - KERB_W - SHOULDER_W, -ROAD_HALF - KERB_W, 0.012, shoulderTex, 8, 0);
  addStrip(ROAD_HALF + KERB_W, ROAD_HALF + KERB_W + SHOULDER_W, 0.012, shoulderTex, 8, 0);
  addStrip(-ROAD_HALF, ROAD_HALF, 0.02, roadTex, 8, 1);
  addStrip(-ROAD_HALF - KERB_W, -ROAD_HALF, 0.03, kerbTex, 8, 2);
  addStrip(ROAD_HALF, ROAD_HALF + KERB_W, 0.03, kerbTex, 8, 2);

  function updateRoad() {
    const phase = ((D % 8) + 8) % 8;
    for (let i = 0; i < ROWS; i++) {
      const z = zRows[i], u = -z, bx = bend(u), v = (u + phase) / 8;
      for (const s of strips) {
        const k = i * 2;
        s.pos[k * 3] = s.x0 + bx; s.pos[k * 3 + 1] = s.y; s.pos[k * 3 + 2] = z;
        s.pos[(k + 1) * 3] = s.x1 + bx; s.pos[(k + 1) * 3 + 1] = s.y; s.pos[(k + 1) * 3 + 2] = z;
        s.uv[k * 2] = 0; s.uv[k * 2 + 1] = v; s.uv[(k + 1) * 2] = 1; s.uv[(k + 1) * 2 + 1] = v;
      }
    }
    for (const s of strips) { s.geo.attributes.position.needsUpdate = true; s.geo.attributes.uv.needsUpdate = true; }
    grassTex.offset.y = ((D % 24) + 24) % 24 / 24;
  }

  // Ağaçlar (tek InstancedMesh)
  const TREES_PER_SIDE = 20, TREE_GAP = 12, TREE_SPAN = TREES_PER_SIDE * TREE_GAP;
  const treeData = [];
  {
    const parts = [[new CylinderGeometry(0.25, 0.32, 1.6, 6), 0.8, [0.36, 0.25, 0.16]],
      [new ConeGeometry(1.9, 3.2, 7), 2.9, [0.17, 0.42, 0.26]],
      [new ConeGeometry(1.4, 2.6, 7), 4.4, [0.23, 0.5, 0.31]]];
    const geos = parts.map(([g, y, c]) => {
      g.translate(0, y, 0);
      const n = g.attributes.position.count, arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { arr[i * 3] = c[0]; arr[i * 3 + 1] = c[1]; arr[i * 3 + 2] = c[2]; }
      g.setAttribute('color', new Float32BufferAttribute(arr, 3));
      return g;
    });
    const treeMesh = new InstancedMesh(mergeGeometries(geos), new MeshLambertMaterial({ vertexColors: true }), TREES_PER_SIDE * 2);
    treeMesh.instanceMatrix.setUsage(DynamicDrawUsage); treeMesh.frustumCulled = false; scene.add(treeMesh);
    for (let side = 0; side < 2; side++) for (let k = 0; k < TREES_PER_SIDE; k++)
      treeData.push({ s: k * TREE_GAP + (side ? TREE_GAP / 2 : 0), side: side ? 1 : -1, off: 9.2 + Math.random() * 7, sc: 0.75 + Math.random() * 0.8, ry: Math.random() * 6.28 });
    var treeMeshRef = treeMesh;
  }
  const dummy = new Object3D();
  function updateTrees() {
    for (let i = 0; i < treeData.length; i++) {
      const t = treeData[i];
      const u = ((((t.s - D) % TREE_SPAN) + TREE_SPAN) % TREE_SPAN) - 14;
      dummy.position.set(bend(u) + t.side * t.off, 0, -u);
      dummy.rotation.set(0, t.ry, 0); dummy.scale.setScalar(t.sc);
      dummy.updateMatrix(); treeMeshRef.setMatrixAt(i, dummy.matrix);
    }
    treeMeshRef.instanceMatrix.needsUpdate = true;
  }

  // Uzak dağ silüeti
  {
    const n = 16, im = new InstancedMesh(new ConeGeometry(34, 40, 5),
      new MeshBasicMaterial({ color: new Color('#1b453b').lerp(HORIZON, 0.45), fog: false }), n);
    for (let i = 0; i < n; i++) {
      const sc = 0.7 + Math.random() * 0.9;
      dummy.position.set(-440 + i * 58 + Math.random() * 20, 14 * sc, -240); dummy.rotation.set(0, Math.random() * 3, 0);
      dummy.scale.set(sc * 1.3, sc, sc * 1.3); dummy.updateMatrix(); im.setMatrixAt(i, dummy.matrix);
    }
    im.frustumCulled = false; scene.add(im);
  }

  // Gölge lekesi
  const blobTex = canvasTex(64, 64, (g, w, h) => {
    const r = g.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2);
    r.addColorStop(0, 'rgba(0,0,0,.55)'); r.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = r; g.fillRect(0, 0, w, h);
  }, false);
  const blobGeo = new PlaneGeometry(3.4, 5.6).rotateX(-Math.PI / 2);

  // Araç yuvaları: 0 oyuncu, 1..3 rakip. Yuva önce yedek araçla dolar, model gelince değişir.
  const slots = MODEL_COLORS.map((name, i) => {
    const group = new Group(), pivot = new Group();
    pivot.scale.setScalar(CAR_SCALE); pivot.rotation.y = Math.PI; // model +Z'ye bakar, oyun -Z'ye
    const blob = new Mesh(blobGeo, new MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false }));
    blob.position.y = 0.045; blob.renderOrder = 1;
    group.add(blob, pivot); group.rotation.order = 'YXZ'; scene.add(group);
    const slot = { group, pivot, wheels: {}, spin: 0, usingModel: false };
    const fb = buildFallbackCar(FALLBACK_COLORS[i]); pivot.add(fb); slot.wheels = findWheels(fb);
    return slot;
  });

  let modelsLoaded = 0, modelsFailed = 0, statusCb = null;
  const templates = [];
  slots.forEach((sl, i) => { sl.carIdx = i; });
  function applyCar(slot, idx) {
    slot.pivot.clear();
    const t = templates[idx];
    const obj = t ? t.clone(true) : buildFallbackCar(FALLBACK_COLORS[idx]);
    slot.usingModel = !!t; slot.carIdx = idx; slot.pivot.add(obj); slot.wheels = findWheels(obj);
  }
  let wanted = slots.map((_, i) => i);
  function setCars(arr) {
    wanted = arr.slice(0, slots.length);
    wanted.forEach((idx, i) => { if (slots[i].carIdx !== idx || (!slots[i].usingModel && templates[idx])) applyCar(slots[i], idx); });
  }
  const ready = Promise.all(MODEL_COLORS.map(async (name, i) => {
    const m = await loadModel(name);
    if (m) { lambertize(m); templates[i] = m; modelsLoaded++; } else modelsFailed++;
  })).then(() => {
    slots.forEach((sl, i) => applyCar(sl, wanted[i]));
    const info = { loaded: modelsLoaded, failed: modelsFailed };
    if (statusCb) statusCb(info);
    return info;
  });

  // Kare başına hazırlık
  const sk = { x: 0, y: 0 };
  let ema = 1 / 60, slowFrames = 0;
  function poseCar(slot, x, rel, yawExtra, speedWorld, dt, steerAng) {
    const g = slot.group;
    g.position.set(x, 0, -rel);
    g.rotation.y = -Math.atan(bendSlope(rel)) + yawExtra;
    slot.spin += speedWorld * dt / (0.3 * CAR_SCALE) * 0.5;
    const w = slot.wheels;
    if (w.fl) { w.fl.rotation.x = slot.spin; w.fl.rotation.y = steerAng; }
    if (w.fr) { w.fr.rotation.x = slot.spin; w.fr.rotation.y = steerAng; }
    if (w.bl) w.bl.rotation.x = slot.spin;
    if (w.br) w.br.rotation.x = slot.spin;
  }

  function render(s) {
    if (ctxLost) return;
    if (s.garage) {
      D = 0;
      const gp = slots[0], portrait0 = camera.aspect < 1;
      gp.group.visible = true; gp.group.position.set(0, 0, 0); gp.group.rotation.set(0, s.garage.angle, 0);
      for (let i = 1; i < slots.length; i++) slots[i].group.visible = false;
      updateRoad(); updateTrees();
      camera.fov = portrait0 ? 54 : 42; camera.updateProjectionMatrix();
      camera.position.set(0, 2.3, portrait0 ? 10.5 : 9); camera.lookAt(0, portrait0 ? -0.9 : 0.6, 0);
      sky.position.copy(camera.position);
      renderer.render(scene, camera);
      return;
    }
    D = s.dist;
    const dt = Math.min(s.dt || 0.016, 0.05);
    const sp = s.speed / 230;
    const px = s.playerX * LANE;

    // oyuncu
    const p = slots[0];
    poseCar(p, px, 0, -s.steer * 0.2, s.speed * 0.22, dt, -s.steer * 0.45);
    p.group.rotation.z = -s.steer * 0.045 * (0.4 + sp);
    p.group.rotation.x = -(s.accel || 0) * 0.012;
    p.group.position.y = (s.shake > 0.5 ? (Math.random() - 0.5) * 0.06 : 0) + Math.sin(D * 2.2) * 0.008 * sp;

    // rakipler
    for (let i = 0; i < slots.length - 1; i++) {
      const r = s.rivals[i], slot = slots[i + 1];
      if (!r || r.rel < -16 || r.rel > 240) { slot.group.visible = false; continue; }
      slot.group.visible = true;
      poseCar(slot, bend(r.rel) + r.x * LANE, r.rel, Math.sin((r.ph || 0) * 0.7 + i) * 0.03, r.v || 0, dt, 0);
    }

    updateRoad(); updateTrees();

    // kamera
    const aspect = camera.aspect, portrait = aspect < 1;
    const shakeX = s.shake > 0 ? (Math.random() - 0.5) * s.shake * 0.02 : 0;
    const shakeY = s.shake > 0 ? (Math.random() - 0.5) * s.shake * 0.02 : 0;
    camera.fov = (portrait ? 70 : 52) + sp * 7;
    camera.updateProjectionMatrix();
    camera.position.set(px * 0.72 + shakeX, 3.5 + shakeY, 9.2 - sp * 0.6);
    camera.lookAt(px * 0.45 + bend(30) * 0.1, 1.05, -14);
    sky.position.copy(camera.position);

    renderer.render(scene, camera);

    // Uyarlanabilir çözünürlük (iPhone'da akıcılığı korur)
    if (s.dt > 0 && s.dt < 0.1) {
      ema += (s.dt - ema) * 0.05;
      if (ema > 0.026) { if (++slowFrames > 90 && pr > 1) { pr = Math.max(1, pr - 0.25); renderer.setPixelRatio(pr); renderer.setSize(W, H); slowFrames = 0; ema = 1 / 60; } }
      else slowFrames = Math.max(0, slowFrames - 2);
    }
  }

  let W = 1, H = 1;
  function resize(w, h, dpr) {
    W = w; H = h; pr = Math.min(dpr || 1, pr > 2 ? 2 : Math.max(pr, Math.min(dpr || 1, 2)));
    pr = Math.min(Math.max(1, pr), 2);
    renderer.setPixelRatio(pr); renderer.setSize(w, h);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }

  return { render, resize, ready, setCars, onStatus(cb) { statusCb = cb; if (modelsLoaded + modelsFailed >= MODEL_COLORS.length) cb({ loaded: modelsLoaded, failed: modelsFailed }); } };
}

window.Turbo3D = { create };
