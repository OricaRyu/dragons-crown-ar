/* The Dragon's Crown: a small AR quest built with A-Frame.
 *
 * Stages: 1) tap chests to find the key  2) tap the key  3) slay the dragon (10 hits)
 *         4) tap the crown  5) victory screen with a QR code.
 *
 * The "AR" is the phone's rear camera feed behind a transparent 3D scene, with the
 * 3D camera turned by the phone's gyroscope, so objects stay fixed in the room as
 * the player turns. It works in mobile Safari and Chrome with no app install.
 */

const DRAGON_HP = 10;
const SHARE_URL = location.href.split('#')[0].split('?')[0];

const $ = (id) => document.getElementById(id);
const scene = $('scene');
const world = $('world');
const camEl = $('cam');

const state = { stage: 'intro', hp: DRAGON_HP, chestsOpened: 0, hits: 0, misses: 0, startTime: 0, keyChest: 0 };

/* ---------------------------------------------------------------- components */

// Scales any glTF so its largest side equals `size` (metres), then sits it on y=0
// and centres it. Sketchfab models come in every scale imaginable, so this keeps them usable.
AFRAME.registerComponent('fit-model', {
  schema: { size: { default: 1 }, clip: { default: '' } },
  init() {
    this.el.addEventListener('model-loaded', (e) => {
      const model = this.el.getObject3D('mesh');
      if (!model) return;
      model.position.set(0, 0, 0);
      model.scale.set(1, 1, 1);
      // Measure the model on its own, ignoring parent scale (which may be mid-animation).
      const parent = model.parent;
      parent.remove(model);
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      parent.add(model);
      const size = box.getSize(new THREE.Vector3());
      const s = this.data.size / Math.max(size.x, size.y, size.z, 0.0001);
      model.scale.setScalar(s);
      const center = box.getCenter(new THREE.Vector3());
      model.position.set(-center.x * s, -box.min.y * s, -center.z * s);
      model.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });

      const anims = (e.detail.model && e.detail.model.animations) || [];
      if (anims.length && this.data.clip !== 'none') {
        const clip = this.data.clip || anims[0].name;
        this.el.setAttribute('animation-mixer', { clip, loop: 'repeat' });
      }
    });
    // If a model file is missing, show a simple stand-in so the game still works.
    this.el.addEventListener('model-error', () => {
      const fb = document.createElement('a-box');
      fb.setAttribute('width', this.data.size);
      fb.setAttribute('height', this.data.size * 0.7);
      fb.setAttribute('depth', this.data.size * 0.7);
      fb.setAttribute('position', `0 ${this.data.size * 0.35} 0`);
      fb.setAttribute('color', '#c8962e');
      fb.classList.add('clickable');
      this.el.appendChild(fb);
    });
  }
});

// Gently bobs and spins an entity (for the key and crown).
AFRAME.registerComponent('hover-spin', {
  schema: { speed: { default: 1.2 }, bob: { default: 0.06 } },
  init() { this.baseY = this.el.object3D.position.y; this.t = Math.random() * 10; },
  tick(_, dt) {
    this.t += dt / 1000;
    const o = this.el.object3D;
    o.rotation.y += this.data.speed * dt / 1000;
    o.position.y = this.baseY + Math.sin(this.t * 2.2) * this.data.bob;
  }
});

// Moves the dragon in a swooping arc around the player. It flies out of view at times,
// so the player has to physically turn to follow it.
AFRAME.registerComponent('dragon-ai', {
  schema: { baseYaw: { default: 0 } },
  init() { this.t = 0; this.prev = new THREE.Vector3(); this.dying = false; },
  tick(_, dt) {
    if (this.dying) return;
    const d = Math.min(dt, 50) / 1000;
    const rage = 1 + (DRAGON_HP - state.hp) * 0.09;   // faster as it gets hurt
    this.t += d * rage;
    const t = this.t;
    const yaw = this.data.baseYaw + 1.4 * Math.sin(t * 0.55);
    const r = 3.4 + 0.7 * Math.sin(t * 1.3);
    const y = 1.9 + 0.5 * Math.sin(t * 1.7);
    const o = this.el.object3D;
    this.prev.copy(o.position);
    o.position.set(-Math.sin(yaw) * r, y, -Math.cos(yaw) * r);
    const vx = o.position.x - this.prev.x, vz = o.position.z - this.prev.z;
    if (vx * vx + vz * vz > 1e-8) {
      const target = Math.atan2(vx, vz);
      o.rotation.y += wrap(target - o.rotation.y) * Math.min(1, d * 6);
    }
    o.rotation.z = Math.sin(t * 1.1) * 0.25;            // banking
    updateDragonHint(o.position);
  }
});

/* ---------------------------------------------------------------- helpers */

function wrap(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }

function cameraYaw() {
  const v = new THREE.Vector3();
  camEl.getObject3D('camera').getWorldDirection(v);
  return Math.atan2(-v.x, -v.z);
}

// Position `dist` metres away at yaw offset `off` from where the player is looking now.
function inFront(dist, y, off = 0, yaw = cameraYaw()) {
  const a = yaw + off;
  return { x: -Math.sin(a) * dist, y, z: -Math.cos(a) * dist, yaw: a };
}

function el(tag, attrs = {}, parent = world) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, typeof v === 'object' ? AFRAME.utils.styleParser.stringify(v) : v);
  parent.appendChild(e);
  return e;
}

// Invisible but tappable sphere: big targets are much easier to hit on a phone.
function hitbox(parent, radius, y) {
  return el('a-sphere', {
    class: 'clickable', radius, position: `0 ${y} 0`,
    material: 'opacity: 0; transparent: true; depthWrite: false; shader: flat'
  }, parent);
}

function say(text) {
  const m = $('message');
  m.textContent = text;
  m.classList.remove('pop'); void m.offsetWidth; m.classList.add('pop');
}

function flash(color = 'white') {
  const f = $('flash');
  f.classList.toggle('red', color === 'red');
  f.classList.add('on');
  requestAnimationFrame(() => requestAnimationFrame(() => f.classList.remove('on')));
}

function vibrate(ms) { if (navigator.vibrate) navigator.vibrate(ms); }

function burst(pos, color = '#ffd35a') {
  const s = el('a-sphere', {
    position: `${pos.x} ${pos.y} ${pos.z}`, radius: 0.08,
    material: `color: ${color}; shader: flat; transparent: true; opacity: 0.9`,
    animation__s: 'property: scale; to: 6 6 6; dur: 380; easing: easeOutQuad',
    animation__o: 'property: material.opacity; to: 0; dur: 380; easing: easeOutQuad'
  }, scene);
  setTimeout(() => s.remove(), 420);
}

/* ---------------------------------------------------------------- sound (no files needed) */

let ctx;
function tone(freq, dur, type = 'sine', vol = 0.2, slide = 0, delay = 0) {
  if (!ctx) return;
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + dur + 0.05);
}
function noise(dur, vol = 0.3, freq = 800) {
  if (!ctx) return;
  const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  f.type = 'lowpass'; f.frequency.value = freq; g.gain.value = vol;
  src.buffer = buf; src.connect(f).connect(g).connect(ctx.destination); src.start();
}
const sfx = {
  open:  () => { tone(330, 0.15, 'triangle', 0.2, 200); tone(660, 0.3, 'triangle', 0.15, 0, 0.12); },
  empty: () => tone(180, 0.35, 'sawtooth', 0.12, -80),
  key:   () => [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.25, 'triangle', 0.15, 0, i * 0.08)),
  roar:  () => { noise(1.3, 0.5, 500); tone(90, 1.2, 'sawtooth', 0.25, -40); },
  hit:   () => { noise(0.15, 0.4, 2500); tone(220, 0.12, 'square', 0.1, -100); },
  fire:  () => noise(0.7, 0.35, 1200),
  win:   () => [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, 0.35, 'triangle', 0.18, 0, i * 0.14))
};

/* ---------------------------------------------------------------- camera / AR */

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    const v = $('camera');
    v.srcObject = stream;
    await v.play();
    return true;
  } catch (e) {
    // No camera (or permission denied): fall back to a moody backdrop so the game still runs.
    document.body.style.background = 'radial-gradient(ellipse at 50% 30%, #4a3a5c, #120c07)';
    $('camera').style.display = 'none';
    return false;
  }
}

async function requestMotion() {
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      await DeviceOrientationEvent.requestPermission();      // iOS 13+
    }
  } catch (e) { /* denied: handled by the fallback below */ }
  // If no gyroscope data arrives, let the player drag to look around instead.
  let got = false;
  const on = (e) => { if (e.alpha !== null || e.beta !== null) got = true; };
  window.addEventListener('deviceorientation', on);
  setTimeout(() => {
    window.removeEventListener('deviceorientation', on);
    if (!got) camEl.setAttribute('look-controls', 'touchEnabled', true);
  }, 1500);
}

/* ---------------------------------------------------------------- stage 1: chests */

function spawnChests() {
  state.stage = 'chests';
  state.keyChest = Math.floor(Math.random() * 3);
  const yaw = cameraYaw();
  [-0.33, 0, 0.33].forEach((off, i) => {
    const p = inFront(2.4, 0.55, off, yaw);
    const c = el('a-entity', { position: `${p.x} ${p.y} ${p.z}`, rotation: `0 ${THREE.MathUtils.radToDeg(p.yaw)} 0`, class: 'chest' });
    c.setAttribute('scale', '0.01 0.01 0.01');
    c.setAttribute('animation__in', `property: scale; to: 1 1 1; dur: 600; delay: ${i * 180}; easing: easeOutBack`);
    el('a-entity', { 'gltf-model': '#chest-model', 'fit-model': 'size: 0.65; clip: none', class: 'clickable' }, c);
    hitbox(c, 0.42, 0.25);
    c.dataset.index = i;
    c.addEventListener('click', () => openChest(c));
  });
  say('Three chests... one hides the golden key. Tap a chest!');
}

function openChest(c) {
  if (state.stage !== 'chests' || c.dataset.opened) return;
  c.dataset.opened = '1';
  state.chestsOpened++;
  const model = c.querySelector('[gltf-model]');
  if (model.getObject3D('mesh') && model.components['fit-model']) {
    const anims = model.getObject3D('mesh').animations || [];
    if (anims.length) model.setAttribute('animation-mixer', { clip: anims[0].name, loop: 'once', clampWhenFinished: true });
  }
  c.setAttribute('animation__pop', 'property: scale; from: 1.25 0.8 1.25; to: 1 1 1; dur: 400; easing: easeOutElastic');
  const wp = c.object3D.getWorldPosition(new THREE.Vector3());

  if (+c.dataset.index === state.keyChest) {
    sfx.open(); sfx.key(); vibrate(60);
    burst({ x: wp.x, y: wp.y + 0.4, z: wp.z });
    spawnKey(c);
  } else {
    sfx.empty(); vibrate(30);
    burst({ x: wp.x, y: wp.y + 0.3, z: wp.z }, '#8a8a8a');
    say(['Empty... only cobwebs. Try another!', 'Just an old boot. Keep searching!'][state.chestsOpened % 2]);
    c.setAttribute('animation__out', 'property: scale; to: 0.01 0.01 0.01; dur: 500; delay: 700; easing: easeInBack');
    setTimeout(() => c.remove(), 1300);
  }
}

/* ---------------------------------------------------------------- stage 2: key */

function spawnKey(chest) {
  state.stage = 'key';
  const p = chest.getAttribute('position');
  const k = el('a-entity', { position: `${p.x} ${p.y + 0.5} ${p.z}` });
  const inner = el('a-entity', { 'hover-spin': 'speed: 2; bob: 0.05' }, k);
  el('a-entity', { 'gltf-model': '#key-model', 'fit-model': 'size: 0.4', class: 'clickable', position: '0 -0.2 0' }, inner);
  el('a-entity', { light: 'type: point; color: #ffcc55; intensity: 2; distance: 1.5' }, k);
  hitbox(k, 0.3, 0);
  k.setAttribute('animation__rise', `property: position; to: ${p.x} ${p.y + 0.85} ${p.z}; dur: 900; easing: easeOutQuad`);
  say('You found the golden key! Tap it to take it.');
  k.addEventListener('click', () => {
    if (state.stage !== 'key') return;
    state.stage = 'transition';
    sfx.key(); flash(); vibrate(80);
    k.setAttribute('animation__take', 'property: scale; to: 0.01 0.01 0.01; dur: 400; easing: easeInBack');
    setTimeout(() => k.remove(), 450);
    document.querySelectorAll('.chest').forEach((c) => {
      c.setAttribute('animation__out', 'property: scale; to: 0.01 0.01 0.01; dur: 500; easing: easeInBack');
      setTimeout(() => c.remove(), 550);
    });
    say('The key glows red-hot... the ground shakes...');
    setTimeout(spawnDragon, 1800);
  });
}

/* ---------------------------------------------------------------- stage 3: dragon */

let dragonEl;
function spawnDragon() {
  state.stage = 'dragon';
  state.hp = DRAGON_HP;
  sfx.roar(); flash('red'); vibrate([100, 50, 200]);
  dragonEl = el('a-entity', { 'dragon-ai': `baseYaw: ${cameraYaw()}` });
  el('a-entity', { 'gltf-model': '#dragon-model', 'fit-model': 'size: 1.9', class: 'clickable', position: '0 -0.5 0' }, dragonEl);
  hitbox(dragonEl, 1.0, 0.2);
  dragonEl.setAttribute('scale', '0.01 0.01 0.01');
  dragonEl.setAttribute('animation__in', 'property: scale; to: 1 1 1; dur: 900; easing: easeOutBack');
  dragonEl.addEventListener('click', hitDragon);
  $('boss').classList.remove('hidden');
  $('boss-hp').style.width = '100%';
  say('THE DRAGON AWAKENS! Tap it to strike with your sword!');
}

function hitDragon(e) {
  if (state.stage !== 'dragon') return;
  state.hp--; state.hits++;
  sfx.hit(); vibrate(40);
  const pt = (e.detail && e.detail.intersection && e.detail.intersection.point) || dragonEl.object3D.position;
  burst(pt, '#fff1a8');
  $('boss-hp').style.width = `${(state.hp / DRAGON_HP) * 100}%`;
  dragonEl.setAttribute('animation__hit', 'property: scale; from: 0.85 0.85 0.85; to: 1 1 1; dur: 250; easing: easeOutQuad');

  if (state.hp <= 0) return killDragon();
  if (state.hp % 3 === 0) {
    setTimeout(() => { if (state.stage === 'dragon') { sfx.fire(); flash('red'); vibrate(150); say('It breathes fire! Hold your shield... and strike again!'); } }, 300);
  } else {
    const lines = ['A mighty blow!', 'The dragon shrieks!', 'Strike again!', 'Your blade finds its mark!', 'It is weakening!'];
    say(`${lines[state.hits % lines.length]} (${state.hp} more hits)`);
  }
}

function killDragon() {
  state.stage = 'transition';
  sfx.roar(); flash(); vibrate([200, 80, 300]);
  $('hint').classList.add('hidden');
  const ai = dragonEl.components['dragon-ai']; ai.dying = true;
  const p = dragonEl.object3D.position;
  dragonEl.setAttribute('animation__fall', `property: position; to: ${p.x} 0.2 ${p.z}; dur: 1400; easing: easeInQuad`);
  dragonEl.setAttribute('animation__spin', 'property: rotation; to: 0 540 80; dur: 1400; easing: easeInQuad');
  dragonEl.setAttribute('animation__shrink', 'property: scale; to: 0.01 0.01 0.01; dur: 500; delay: 1300; easing: easeInBack');
  say('The dragon falls! Its hoard is yours...');
  setTimeout(() => { dragonEl.remove(); $('boss').classList.add('hidden'); spawnCrown(); }, 1900);
}

function updateDragonHint(pos) {
  const cam = camEl.object3D.getWorldPosition(new THREE.Vector3());
  const yawTo = Math.atan2(-(pos.x - cam.x), -(pos.z - cam.z));
  const rel = wrap(yawTo - cameraYaw());
  const h = $('hint');
  if (Math.abs(rel) > 0.75) {
    h.innerHTML = rel > 0 ? '&#10229; The dragon is to your LEFT' : 'The dragon is to your RIGHT &#10230;';
    h.classList.remove('hidden');
  } else h.classList.add('hidden');
}

/* ---------------------------------------------------------------- stage 4: crown */

function spawnCrown() {
  state.stage = 'crown';
  const p = inFront(1.8, 1.25);
  const c = el('a-entity', { position: `${p.x} ${p.y} ${p.z}` });
  const inner = el('a-entity', { 'hover-spin': 'speed: 1; bob: 0.07' }, c);
  el('a-entity', { 'gltf-model': '#crown-model', 'fit-model': 'size: 0.45', class: 'clickable', position: '0 -0.15 0' }, inner);
  el('a-torus', { radius: 0.38, 'radius-tubular': 0.012, rotation: '90 0 0', position: '0 -0.25 0',
    material: 'color: #ffd35a; shader: flat; transparent: true; opacity: 0.8',
    animation: 'property: scale; from: 0.9 0.9 0.9; to: 1.15 1.15 1.15; dir: alternate; loop: true; dur: 800' }, c);
  el('a-entity', { light: 'type: point; color: #ffd35a; intensity: 2.5; distance: 2' }, c);
  hitbox(c, 0.4, 0);
  c.setAttribute('scale', '0.01 0.01 0.01');
  c.setAttribute('animation__in', 'property: scale; to: 1 1 1; dur: 700; easing: easeOutBack');
  sfx.key();
  say("The King's Crown! Tap it to claim victory!");
  c.addEventListener('click', () => {
    if (state.stage !== 'crown') return;
    state.stage = 'won';
    sfx.win(); flash(); vibrate([80, 60, 80, 60, 200]);
    c.setAttribute('animation__take', 'property: scale; to: 0.01 0.01 0.01; dur: 500; easing: easeInBack');
    setTimeout(() => { c.remove(); showVictory(); }, 700);
  });
}

/* ---------------------------------------------------------------- stage 5: victory + QR */

let qrMade = false;
function showVictory() {
  const secs = Math.round((Date.now() - state.startTime) / 1000);
  $('stats').innerHTML = `Quest time: <b>${Math.floor(secs / 60)}m ${secs % 60}s</b><br>Chests opened: <b>${state.chestsOpened}</b> &middot; Sword strikes: <b>${state.hits}</b>`;
  if (!qrMade && window.QRCode) {
    new QRCode($('qr'), { text: SHARE_URL, width: 180, height: 180, colorDark: '#2b1b0e', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
    qrMade = true;
  }
  $('hud').classList.add('hidden');
  $('victory').classList.remove('hidden');
}

function resetGame() {
  while (world.firstChild) world.removeChild(world.firstChild);
  Object.assign(state, { hp: DRAGON_HP, chestsOpened: 0, hits: 0, startTime: Date.now() });
  $('victory').classList.add('hidden');
  $('hud').classList.remove('hidden');
  $('boss').classList.add('hidden');
  spawnChests();
}

/* ---------------------------------------------------------------- boot */

function setLoading(ready) {
  const b = $('start-btn');
  b.disabled = !ready;
  b.textContent = ready ? 'Begin the Quest' : 'Loading the realm...';
}
setLoading(false);
if (scene.hasLoaded) setLoading(true); else scene.addEventListener('loaded', () => setLoading(true));

$('start-btn').addEventListener('click', async () => {
  try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
  await Promise.all([requestMotion(), startCamera()]);
  $('start').classList.add('hidden');
  $('hud').classList.remove('hidden');
  state.startTime = Date.now();
  say('Look around... the quest begins!');
  setTimeout(spawnChests, 1200);     // give the gyroscope a moment so chests appear in front of you
});
$('again-btn').addEventListener('click', resetGame);
$('credits-btn').addEventListener('click', () => { $('victory').classList.add('hidden'); $('credits').classList.remove('hidden'); });
$('back-btn').addEventListener('click', () => { $('credits').classList.add('hidden'); $('victory').classList.remove('hidden'); });
