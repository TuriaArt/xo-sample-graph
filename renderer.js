const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const status = document.getElementById('statusbar');
const tooltip = document.getElementById('tooltip');

// Fallback для Electron preload: если fs не определён, подменяем на no-op
const fs = (() => {
  try {
    if (typeof require !== 'function') return { unlink: () => {} };
    const mod = require('fs');
    return { unlink: (p, cb) => { try { mod.unlink(p, cb); } catch { cb && cb(); } } };
  } catch {
    return { unlink: () => {} };
  }
})();
const palette = {
  kick: '#ff3d00',
  snare: '#00e5ff',
  hat: '#ffd600',
  clap: '#ff4081',
  perc: '#00e676',
  fx: '#d500f9',
  vox: '#18ffff',
  bass: '#ff9100',
  other: '#b0bec5',
};
const palettePool = [
  '#ff3d00','#00e5ff','#ffd600','#ff4081','#00e676',
  '#d500f9','#18ffff','#ff9100','#76ff03','#ff6e40',
  '#40c4ff','#ffab40','#69f0ae','#ff80ab','#40c4ff',
  '#ffd740','#7c4dff','#18ffff','#ff3d00','#64ffda',
];
let paletteIdx = palettePool.length;
function categoryColor(cat) {
  if (palette[cat]) return palette[cat];
  let h = 0;
  for (let i = 0; i < cat.length; i++) h = (h * 31 + cat.charCodeAt(i)) >>> 0;
  return palettePool[h % palettePool.length];
}
let samples = [];
let nodes = [];
let links = [];
let shortlist = new Set();
let searchTerm = '';
let selectedId = null;
let lastSample = null;
function getSelectedNode() {
  return nodes.find((n) => n.id === selectedId) || null;
}
let width, height;
let currentAudio = null;
let activeAudios = [];
let fadeMode = false;

let audioCtx = null;
let masterGain = null;
let masterCompressor = null;
function ensureAudioContext() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 1.0;
    masterCompressor = audioCtx.createDynamicsCompressor();
    masterCompressor.threshold.value = -8;
    masterCompressor.knee.value = 10;
    masterCompressor.ratio.value = 8;
    masterCompressor.attack.value = 0.005;
    masterCompressor.release.value = 0.15;
    masterGain.connect(masterCompressor);
    masterCompressor.connect(audioCtx.destination);
  } catch {}
}

// ---- audio fingerprint-ish descriptors (computed lazily via WebAudio decode) ----
const descriptorCache = new Map(); // sample path -> descriptor
let computingSet = new Set();      // paths currently being computed

async function ensureDescriptor(sample) {
  if (!sample) return null;
  const cached = descriptorCache.get(sample.path);
  if (cached) return cached;
  if (computingSet.has(sample.path)) return null;
  computingSet.add(sample.path);
  try {
    ensureAudioContext();
    if (!audioCtx) return null;
    const preview = await window.electron.previewSampleUrl(sample.path);
    if (!preview || !preview.url) return null;
    const res = await fetch(preview.url);
    const buf = await res.arrayBuffer();
    let audio;
    try {
      audio = await audioCtx.decodeAudioData(buf);
    } catch {
      cleanupPreview(preview.url);
      return null;
    }
    cleanupPreview(preview.url);
    const desc = computeDescriptor(audio);
    descriptorCache.set(sample.path, desc);
    sample.duration = desc.duration;
    return desc;
  } catch {
    return null;
  } finally {
    computingSet.delete(sample.path);
  }
}

function computeDescriptor(audioBuffer) {
  const ch = audioBuffer.getChannelData(0);
  const sr = audioBuffer.sampleRate;
  const n = ch.length;
  if (!n) return null;
  // RMS energy
  let sum2 = 0;
  for (let i = 0; i < n; i++) sum2 += ch[i] * ch[i];
  const rms = Math.sqrt(sum2 / n);
  // zero crossing rate
  let zc = 0;
  for (let i = 1; i < n; i++) if ((ch[i - 1] < 0) !== (ch[i] < 0)) zc++;
  const zcr = zc / n;
  // spectral centroid via FFT of a windowed slice (up to ~4s at 22kHz)
  const sliceRate = Math.min(sr, 22050);
  const step = Math.max(1, Math.round(sr / sliceRate));
  const maxLen = Math.min(n, Math.floor(sliceRate * 4));
  const win = [];
  for (let i = 0; i < maxLen; i += step) win.push(ch[i]);
  const spec = spectrumStats(win, sliceRate);
  // attack time: first index where running peak > 60% of overall peak
  let peak = 0;
  for (let i = 0; i < n; i += 64) { const a = Math.abs(ch[i]); if (a > peak) peak = a; }
  let attackSec = 0;
  const thresh = peak * 0.6;
  for (let i = 0; i < n; i += 32) { if (Math.abs(ch[i]) >= thresh) { attackSec = i / sr; break; } }
  return {
    duration: audioBuffer.duration,
    rms,
    zcr,
    centroid: spec.centroid,
    bassFrac: spec.bassFrac,     // energy below 250 Hz
    midFrac: spec.midFrac,       // 250-2000 Hz
    highFrac: spec.highFrac,     // above 2 kHz
    attackSec,
    logDur: Math.log2(Math.max(0.01, audioBuffer.duration)),
  };
}

function spectrumStats(samples, sr) {
  // simple real DFT on downsampled signal, limited bins
  const N = 1 << 13; // 8192 — always a power of two for the radix-2 FFT
  const len = N;
  const re = new Float64Array(len);
  const im = new Float64Array(len);
  const slen = Math.min(samples.length, N);
  for (let i = 0; i < slen; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (slen - 1 || 1));
    re[i] = samples[i] * w;
  }
  fftInPlace(re, im);
  const half = len >> 1;
  const binHz = sr / len;
  let totalE = 0, weightedE = 0, bass = 0, mid = 0, high = 0;
  for (let k = 1; k < half; k++) {
    const e = re[k] * re[k] + im[k] * im[k];
    const f = k * binHz;
    totalE += e;
    weightedE += e * f;
    if (f < 250) bass += e;
    else if (f < 2000) mid += e;
    else high += e;
  }
  if (!totalE) return { centroid: 0, bassFrac: 0, midFrac: 0, highFrac: 0 };
  return {
    centroid: weightedE / totalE,
    bassFrac: bass / totalE,
    midFrac: mid / totalE,
    highFrac: high / totalE,
  };
}

// iterative radix-2 FFT (in place), length must be power of two
function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

function descriptorDistance(a, b) {
  if (!a || !b) return Infinity;
  const normCentroid = (d) => Math.log2(Math.max(30, d.centroid));
  const scale = (v, lo, hi) => (v - lo) / (hi - lo || 1);
  const parts = [
    (a.logDur - b.logDur) * 1.2,
    (scale(a.rms, 0, 0.5) - scale(b.rms, 0, 0.5)) * 1.0,
    (a.zcr - b.zcr) * 8,
    (normCentroid(a) - normCentroid(b)) * 1.0,
    (a.bassFrac - b.bassFrac) * 2.5,
    (a.midFrac - b.midFrac) * 1.5,
    (a.highFrac - b.highFrac) * 1.5,
    (Math.log2(Math.max(0.001, a.attackSec)) - Math.log2(Math.max(0.001, b.attackSec))) * 0.6,
  ];
  let s = 0;
  for (const p of parts) s += p * p;
  return Math.sqrt(s);
}

async function findSimilar(node, limit = 6) {
  const self = node.sample;
  const myDesc = await ensureDescriptor(self);
  if (!myDesc) return [];
  const candidates = nodes.filter((n) => n.id !== node.id && n.group === node.group);
  const scored = [];
  for (const cand of candidates) {
    const d = descriptorCache.get(cand.sample.path);
    if (d) scored.push({ node: cand, dist: descriptorDistance(myDesc, d) });
  }
  // background-compute the rest without blocking the UI
  (async () => {
    let budget = 12; // per selection, keep CPU bounded
    for (const cand of candidates) {
      if (budget <= 0) break;
      if (descriptorCache.has(cand.sample.path)) continue;
      await ensureDescriptor(cand.sample.path);
      budget--;
    }
    // refresh panel if still showing same node
    if (detailNodeId === node.id) renderDetailPanel(node);
 })();
  scored.sort((x, y) => x.dist - y.dist);
  return scored.slice(0, limit);
}

function buildLinks() {
  links = [];
  if (!showLinks) return;
  const byGroup = {};
  for (const n of nodes) {
    if (!descriptorCache.has(n.sample.path)) continue;
    (byGroup[n.group] = byGroup[n.group] || []).push(n);
  }
  for (const groupNodes of Object.values(byGroup)) {
    const arr = groupNodes.map((n) => ({ n, d: descriptorCache.get(n.sample.path) }));
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const dist = descriptorDistance(arr[i].d, arr[j].d);
        if (dist < 0.85) {
          links.push({ source: arr[i].n, target: arr[j].n, dist });
        }
      }
    }
  }
}

let cam = { x: 0, y: 0, zoom: 1 };
let isPanning = false;
let panStart = { x: 0, y: 0 };
let camStart = { x: 0, y: 0 };
let showLinks = false;
let activeFilter = 'all';
let loopFilter = null; // 'loop' | 'oneshot' | null

let centroids = {};
let lang = localStorage.getItem('lang') || 'ru';
const i18n = {
  ru: {
    empty: 'Нажми «Выбрать папку» и выбери папку с сэмплами',
    playing: (name) => `Воспроизведение: ${name}`,
    previewFailed: 'Превью не доступно',
    dumped: (n) => `Выгружено: ${n}`,
    shortlistEmpty: 'ShortList пуст',
    noFolder: 'Нет папки',
    indexing: (folder) => `Индексация: ${folder}`,
    loaded: (n) => `Загружено: ${n} сэмплов`,
    links: 'Связи',
    linksOn: 'Связи: вкл',
    play: 'Играть',
    addShortlist: 'В ShortList (S)',
    removeShortlist: 'Убрать (S)',
    reveal: 'В папке',
    similar: 'Похожие',
    shortlist: 'ShortList',
    clear: 'Очистить',
    searchPlaceholder: 'Поиск по названию… (/)',
    noSimilar: 'Нет похожих',
    exported: (n) => `Экспортировано: ${n}`,
    matchCount: (n) => `${n} совпадений`,
    analyzing: 'Анализ…',
    duration: 'Длительность',
    size: 'Размер',
    folderLabel: 'Папка',
  },
  en: {
    empty: 'Click “Choose folder” and select a samples folder',
    playing: (name) => `Playing: ${name}`,
    previewFailed: 'Preview unavailable',
    dumped: (n) => `Dumped: ${n}`,
    shortlistEmpty: 'ShortList is empty',
    noFolder: 'No folder',
    indexing: (folder) => `Indexing: ${folder}`,
    loaded: (n) => `Loaded ${n} samples`,
    links: 'Links',
    linksOn: 'Links: on',
    play: 'Play',
    addShortlist: 'Add to ShortList (S)',
    removeShortlist: 'Remove (S)',
    reveal: 'Reveal',
    similar: 'Similar',
    shortlist: 'ShortList',
    clear: 'Clear',
    searchPlaceholder: 'Search by name… (/)',
    noSimilar: 'No similar found',
    exported: (n) => `Exported: ${n}`,
    matchCount: (n) => `${n} matches`,
    analyzing: 'Analyzing…',
    duration: 'Duration',
    size: 'Size',
    folderLabel: 'Folder',
  },
};
function t(key, ...args) {
  const msg = (i18n[lang] && i18n[lang][key]) || i18n.en[key] || key;
  return typeof msg === 'function' ? msg(...args) : msg;
}
function updateFadeButton() {
  const noFade = document.getElementById('noFade');
  if (!noFade) return;
  if (lang === 'ru') {
    noFade.textContent = fadeMode ? 'Затухание' : 'Затухания нет';
  } else {
    noFade.textContent = fadeMode ? 'Fade' : 'NoFade';
  }
  noFade.classList.toggle('fade-on', fadeMode);
  noFade.classList.toggle('fade-off', !fadeMode);
}

function resize() {
  width = canvas.clientWidth || (window.innerWidth || 800);
  height = canvas.clientHeight || Math.max(400, (window.innerHeight || 600) - 120);
  canvas.width = width * devicePixelRatio;
  canvas.height = height * devicePixelRatio;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}
window.addEventListener('resize', () => { resize(); draw(); });
resize();

document.getElementById('choose').addEventListener('click', chooseFolder);

document.getElementById('zoom-ui-100').addEventListener('click', () => setInterfaceZoom(0));
document.getElementById('zoom-ui-150').addEventListener('click', () => setInterfaceZoom(0.5));
document.getElementById('zoom-ui-200').addEventListener('click', () => setInterfaceZoom(1));
function setInterfaceZoom(level) {
  try {
    window.electron.setInterfaceZoom(level);
  } catch {}
}

document.getElementById('stop').addEventListener('click', () => {
  stopCurrent(fadeMode);
});

const searchInput = document.getElementById('search');
const searchCount = document.getElementById('search-count');
if (searchInput) {
  searchInput.placeholder = t('searchPlaceholder');
  let searchTimer = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTerm = searchInput.value.trim().toLowerCase();
      updateSearchCount();
      draw();
    }, 120);
  });
}
function nodeVisible(n) {
  if (activeFilter !== 'all' && n.group !== activeFilter) return false;
  if (loopFilter === 'loop' && !n.sample.loop) return false;
  if (loopFilter === 'oneshot' && n.sample.loop) return false;
  if (searchTerm && !(n.sample.name.toLowerCase().includes(searchTerm) || (n.sample.folder || '').toLowerCase().includes(searchTerm))) return false;
  return true;
}
function updateSearchCount() {
  if (!searchCount) return;
  if (!searchTerm) { searchCount.textContent = ''; return; }
  const c = nodes.filter(nodeVisible).length;
  searchCount.textContent = t('matchCount', c);
}

const linksBtn = document.getElementById('links-toggle');
if (linksBtn) {
  linksBtn.addEventListener('click', async () => {
    showLinks = !showLinks;
    linksBtn.classList.toggle('fade-on', showLinks);
    linksBtn.textContent = showLinks ? t('linksOn') : t('links');
    if (showLinks) await computeDescriptorsForVisible(60);
    buildLinks();
    draw();
  });
}

async function computeDescriptorsForVisible(limit) {
  // compute descriptors for visible nodes not yet analyzed, bounded by limit
  const todo = nodes.filter((n) => nodeVisible(n) && !descriptorCache.has(n.sample.path));
  let budget = Math.min(limit, todo.length);
  for (let i = 0; i < budget; i++) {
    await ensureDescriptor(todo[i].sample);
    if (i % 10 === 9) await new Promise((r) => setTimeout(r, 0)); // yield to UI
  }
}
document.getElementById('noFade').addEventListener('click', () => {
  fadeMode = !fadeMode;
  updateFadeButton();
});
updateFadeButton();

const zoomInput = document.getElementById('zoom');
if (zoomInput) {
  const zoomTo = (newZoom, pivotX, pivotY) => {
    newZoom = Math.max(0.2, Math.min(3, +newZoom.toFixed(2)));
    if (pivotX == null) pivotX = width / 2;
    if (pivotY == null) pivotY = height / 2;
    const factor = newZoom / cam.zoom;
    cam.x = pivotX - (pivotX - cam.x) * factor;
    cam.y = pivotY - (pivotY - cam.y) * factor;
    cam.zoom = newZoom;
    zoomInput.value = String(newZoom);
    draw();
  };
  zoomInput.addEventListener('input', () => {
    zoomTo(parseFloat(zoomInput.value) || 1);
  });
  window.zoomIn = () => zoomTo(cam.zoom + 0.2);
  window.zoomOut = () => zoomTo(cam.zoom - 0.2);
  window.zoomReset = () => zoomTo(1);
}

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') {
    if (e.key === 'Escape') { e.target.blur(); }
    return;
  }
  if (e.key === '/') {
    e.preventDefault();
    const si = document.getElementById('search');
    if (si) si.focus();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyF') {
    e.preventDefault();
    const si = document.getElementById('search');
    if (si) si.focus();
    return;
  }
  if (e.key === 'Escape') {
    closeDetailPanel();
    return;
  }
  if (e.code === 'Space') {
    e.preventDefault();
    stopCurrent(fadeMode);
  } else if (e.code === 'KeyF') {
    fadeMode = !fadeMode;
    const noFade = document.getElementById('noFade');
    if (noFade) noFade.textContent = lang === 'ru' ? 'Без затухания' : 'NoFade';
  } else if (e.code === 'KeyS') {
    const selected = getSelectedNode();
    if (!selected) return;
    if (shortlist.has(selected.id)) {
      shortlist.delete(selected.id);
      updateShortlistState();
    } else {
      shortlist.add(selected.id);
      updateShortlistState();
    }
  } else if (e.code === 'Enter') {
    const selected = getSelectedNode();
    if (!selected) return;
    status.textContent = `${selected.sample.name} | ${selected.sample.category} | ${selected.sample.path}`;
    (async () => {
      const preview = await window.electron.previewSampleUrl(selected.sample.path);
      if (preview?.url) playPreview(preview, selected.sample.name, selected.sample.path);
      openDetailPanel(selected);
    })();
  }
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const worldBefore = toWorld(mx, my);
  const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
  const newZoom = Math.max(0.2, Math.min(4, cam.zoom * factor));
  cam.zoom = newZoom;
  cam.x = mx - worldBefore.x * newZoom;
  cam.y = my - worldBefore.y * newZoom;
  draw();
}, { passive: false });

canvas.addEventListener('mousedown', (e) => {
  if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
    isPanning = true;
    panStart = { x: e.clientX, y: e.clientY };
    camStart = { x: cam.x, y: cam.y };
    canvas.style.cursor = 'grabbing';
  }
});
window.addEventListener('mousemove', (e) => {
  if (isPanning) {
    cam.x = camStart.x + (e.clientX - panStart.x);
    cam.y = camStart.y + (e.clientY - panStart.y);
    draw();
  }
});
window.addEventListener('mouseup', () => {
  isPanning = false;
  canvas.style.cursor = 'crosshair';
});

function setZoom(z) {
  cam.zoom = Math.max(0.2, Math.min(4, z));
  draw();
}

function toScreen(x, y) {
  return { x: x * cam.zoom + cam.x, y: y * cam.zoom + cam.y };
}
function toWorld(x, y) {
  return { x: (x - cam.x) / cam.zoom, y: (y - cam.y) / cam.zoom };
}

function renderCategoryChips(categories) {
  const box = document.getElementById('filters');
  box.innerHTML = '';
  const allBtn = document.createElement('button');
  allBtn.className = 'chip active';
  allBtn.dataset.cat = 'all';
  allBtn.textContent = lang === 'ru' ? 'Все' : 'All';
  allBtn.addEventListener('click', () => {
    activeFilter = 'all';
    loopFilter = null;
    cam.x = 0; cam.y = 0; cam.zoom = 1;
    draw();
    renderCategoryChips(categories);
  });
  box.appendChild(allBtn);
  const unique = [...new Set(categories.filter((c) => c && c !== 'all'))];
  for (const cat of unique) {
    const btn = document.createElement('button');
    btn.className = 'chip';
    btn.dataset.cat = cat;
    btn.textContent = cat;
    const color = categoryColor(cat);
    btn.style.color = color;
    btn.style.borderColor = color;
    if (activeFilter === cat) {
      btn.style.backgroundColor = color + '22';
      btn.style.boxShadow = `inset 0 0 0 1px ${color}55`;
    }
    btn.addEventListener('click', () => {
      activeFilter = cat;
      renderCategoryChips(categories);
      focusCategory(cat);
    });
    box.appendChild(btn);
  }
  for (const loopType of ['loop','oneshot']) {
    const btn = document.createElement('button');
    btn.className = 'chip';
    btn.dataset.loop = loopType;
    btn.textContent = loopType === 'loop' ? (lang === 'ru' ? 'LOOP' : 'LOOP') : (lang === 'ru' ? 'ONE SHOT' : 'ONE SHOT');
    if (loopFilter === loopType) {
      btn.classList.add('active');
      btn.style.backgroundColor = '#2f2f40';
      btn.style.borderColor = '#6c6cff';
      btn.style.boxShadow = 'inset 0 0 0 1px #6c6cff55';
    }
    btn.addEventListener('click', () => {
      loopFilter = loopFilter === loopType ? null : loopType;
      draw();
      renderCategoryChips(categories);
    });
    box.appendChild(btn);
  }
  for (const b of box.querySelectorAll('.chip')) {
    if (b.dataset.cat && b.dataset.cat === activeFilter) b.classList.add('active');
    if (b.dataset.loop && b.dataset.loop === loopFilter) b.classList.add('active');
  }
}

async function openFolder(folder) {
  if (!folder) return;
  localStorage.setItem('lastFolder', folder);
  status.textContent = t('indexing', folder);
  const result = await window.electron.indexFolder(folder);
  const raw = result.files || result;
  const seen = new Map();
  samples = [];
  for (const s of raw) {
    if (!s || !s.name) continue;
    if (!seen.has(s.name)) {
      seen.set(s.name, true);
      samples.push(s);
    }
  }
  status.textContent = t('loaded', samples.length);
  const cats = result.categories || (() => {
    const set = new Set((samples || []).map((s) => s.category).filter(Boolean));
    return Array.from(set).sort();
  })();
  renderCategoryChips(['all', ...(cats || [])]);
  activeFilter = 'all';
  loopFilter = null;
  buildGraph();
  restoreShortlist();
}

async function chooseFolder() {
  const folder = await window.electron.selectFolder();
  await openFolder(folder);
}

(async () => {
  try {
    await openFolder(localStorage.getItem('lastFolder'));
  } catch {
    // start without previous folder
  }
})();

window.electron && window.electron.onIndexProgress && window.electron.onIndexProgress((data) => {
  if (data && data.scanned && data.last === 'DONE') {
    status.textContent = `Индексация завершена: ${data.scanned} файлов`;
  } else if (data && data.scanned) {
    status.textContent = `Индексация: ${data.scanned} файлов...`;
  }
});

window.electron && window.electron.onIndexError && window.electron.onIndexError((_event, data) => {
  status.textContent = 'Ошибка индексации: ' + data.error;
});

// Menu events
window.electron && window.electron.onZoomIn && window.electron.onZoomIn(() => { zoomTo(cam.zoom + 0.2); });
window.electron && window.electron.onZoomOut && window.electron.onZoomOut(() => { zoomTo(cam.zoom - 0.2); });
window.electron && window.electron.onZoomReset && window.electron.onZoomReset(() => { zoomTo(1); });
window.electron && window.electron.onToggleFade && window.electron.onToggleFade(() => { fadeMode = !fadeMode; updateFadeButton(); });
window.electron && window.electron.onToggleLoop && window.electron.onToggleLoop(() => {
  const btn = document.querySelector('[data-loop="loop"]') || document.querySelector('[data-loop="oneshot"]');
  if (btn) btn.click();
});
window.electron && window.electron.onIndexProgress && window.electron.onIndexProgress(() => {});
window.electron && window.electron.onIndexError && window.electron.onIndexError(() => {});

window.addEventListener('menu-choose-folder', chooseFolder);
window.addEventListener('menu-open-last', async () => {
  const target = getSelectedNode() || lastSample;
  if (!target) return;
  await window.electron.openItemInExplorer(target.path);
});
window.addEventListener('menu-open-last-in-aimp', async () => {
  const selected = getSelectedNode();
  if (!selected) return;
  await window.electron.openLastInAimp(selected.sample.path);
});
window.addEventListener('menu-copy-path', async () => {
  const selected = getSelectedNode();
  if (!selected) return;
  await navigator.clipboard.writeText(selected.sample.path);
});

function buildGraph() {
  const groups = {};
  for (const s of samples) {
    const cat = s.category;
    (groups[cat] = groups[cat] || []).push(s);
  }

  const cats = Object.keys(groups);
  const petals = cats.length || 1;
  const maxRadius = Math.min(width, height) * 0.42;
  const centerX = width / 2;
  const centerY = height / 2;

  nodes = [];
  links = [];
  centroids = {};
  let id = 0;

  const categoryLayout = [];
  cats.forEach((cat, idx) => {
    const angle = (idx / petals) * Math.PI * 2 - Math.PI / 2;
    categoryLayout.push({
      cat,
      cx: centerX + Math.cos(angle) * maxRadius * 0.55,
      cy: centerY + Math.sin(angle) * maxRadius * 0.55,
    });
  });

  const maxDuration = categoryLayout.reduce((m, item) => {
    const total = (groups[item.cat] || []).reduce((sum, s) => (typeof s.duration === 'number' ? sum + s.duration : sum + 1), 0);
    return Math.max(m, total);
  }, 1);

  categoryLayout.forEach(({ cat, cx, cy }) => {
    const items = groups[cat] || [];
    const total = items.reduce((sum, s) => (typeof s.duration === 'number' ? sum + s.duration : sum + 1), 0);
    const scale = 0.55 + 0.45 * (total / maxDuration);
    const rx = maxRadius * (0.22 + 0.78 * scale);
    const ry = maxRadius * (0.22 + 0.78 * scale);
    const groupNodes = [];

    const sorted = [...items].sort((a, b) => (b.duration || b.size || 0) - (a.duration || a.size || 0));
    for (let i = 0; i < sorted.length; i++) {
      const angle = (i / Math.max(1, sorted.length)) * Math.PI * 2 + Math.random() * 0.5;
      const radius = Math.sqrt(Math.random()) * Math.min(rx, ry);
      const x = cx + Math.cos(angle) * radius * (rx / Math.min(rx, ry));
      const y = cy + Math.sin(angle) * radius * (ry / Math.min(rx, ry));
      groupNodes.push({ s: sorted[i], x, y });
    }

    const gcx = groupNodes.reduce((s, n) => s + n.x, 0) / groupNodes.length;
    const gcy = groupNodes.reduce((s, n) => s + n.y, 0) / groupNodes.length;
    centroids[cat] = { x: gcx, y: gcy, label: cat.toUpperCase(), rx, ry };

    for (const item of groupNodes) {
      const node = {
        id: id++,
        sample: item.s,
        x: item.x,
        y: item.y,
        vx: 0,
        vy: 0,
        color: categoryColor(cat),
        r: s.duration ? 2.5 + Math.min(6, Math.sqrt(s.duration) * 2) : 2 + Math.random() * 1.5,
        group: cat,
      };
      nodes.push(node);
    }
  });

  draw();
  if (activeFilter !== 'all') {
    focusCategory(activeFilter);
  }
  startClusterSimulation();
}

function startClusterSimulation() {
  if (!d3) return;
  const sim = d3.forceSimulation(nodes)
    .alphaDecay(0.028)
    .velocityDecay(0.55)
    .force('x', d3.forceX((d) => {
      const c = centroids[d.group];
      return c ? c.x : width / 2;
    }).strength(0.12))
    .force('y', d3.forceY((d) => {
      const c = centroids[d.group];
      return c ? c.y : height / 2;
    }).strength(0.12))
    .force('collide', d3.forceCollide((d) => d.r + 3).strength(0.9))
    .on('tick', () => {
      for (const n of nodes) {
        const c = centroids[n.group];
        if (!c) continue;
        const dx = n.x - c.x;
        const dy = n.y - c.y;
        if (dx * dx / (c.rx * c.rx) + dy * dy / (c.ry * c.ry) > 0.9) {
          const ang = Math.atan2(dy, dx);
          n.x = c.x + Math.cos(ang) * c.rx * 0.9;
          n.y = c.y + Math.sin(ang) * c.ry * 0.9;
          n.vx *= 0.1;
          n.vy *= 0.1;
        }
      }
      draw();
    });
}

function focusCategory(cat) {
  const c = centroids[cat];
  if (!c) return;
  cam.zoom = 1.8;
  cam.x = width / 2 - (c.x * cam.zoom);
  cam.y = height / 2 - (c.y * cam.zoom);
  draw();
}

function draw() {
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  if (!nodes.length) {
    ctx.fillStyle = '#999';
    ctx.font = '14px sans-serif';
    ctx.fillText(t('empty'), 20, 40);
    return;
  }

  ctx.save();
  ctx.translate(cam.x, cam.y);
  ctx.scale(cam.zoom, cam.zoom);

  if (showLinks && links.length) {
    ctx.strokeStyle = 'rgba(140,140,255,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const l of links) {
      if (!nodeVisible(l.source) || !nodeVisible(l.target)) continue;
      ctx.moveTo(l.source.x, l.source.y);
      ctx.lineTo(l.target.x, l.target.y);
    }
    ctx.stroke();
  }

  const playingPaths = new Set(activeAudios.map((a) => a.path).filter(Boolean));
  for (const n of nodes) {
    if (activeFilter !== 'all' && n.group !== activeFilter) continue;
    if (loopFilter === 'loop' && !n.sample.loop) continue;
    if (loopFilter === 'oneshot' && n.sample.loop) continue;
    const matchesSearch = !searchTerm || n.sample.name.toLowerCase().includes(searchTerm) || (n.sample.folder || '').toLowerCase().includes(searchTerm);
    ctx.globalAlpha = matchesSearch ? 1 : 0.12;
    ctx.beginPath();
    let r = n.r;
    if (playingPaths.has(n.sample.path)) r *= 1.8;
    else if (shortlist.has(n.id)) r *= 1.4;
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fillStyle = n.color;
    ctx.fill();
    if (shortlist.has(n.id)) {
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  const selectedNode = getSelectedNode();
  if (selectedNode) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(selectedNode.x, selectedNode.y, selectedNode.r + 14, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(selectedNode.x, selectedNode.y, selectedNode.r + 6, 0, Math.PI * 2);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2/devicePixelRatio;
    ctx.stroke();
    ctx.restore();
  }

  ctx.restore();
}

async function hitTest(sx, sy) {
  const p = toWorld(sx, sy);
  let best = null;
  let bestD = Infinity;
  for (const n of nodes) {
    if (!nodeVisible(n)) continue;
    const dx = n.x - p.x, dy = n.y - p.y;
    const d = dx*dx + dy*dy;
    if (d < bestD) { bestD = d; best = n; }
  }
  if (best && bestD < (best.r + 4) * (best.r + 4)) return best;
  return null;
}

function stopCurrent(fade) {
  if (!activeAudios.length) return;
  for (const item of activeAudios) {
    try {
      item.source.pause();
    } catch {}
    cleanupPreview(item.url);
  }
  activeAudios = [];
  currentAudio = null;
}

function playPreview(preview, name, path) {
  try {
    ensureAudioContext();
    if (!fadeMode) stopCurrent(fadeMode);
    const audio = new Audio(preview.url);
    audio.play().catch((e) => console.error('play() rejected', e));
    const item = { source: audio, gain: null, context: null, url: preview.url, name, path };
    try {
      if (audioCtx) {
        const node = audioCtx.createMediaElementSource(audio);
        node.connect(masterGain);
      }
    } catch {}
    activeAudios.push(item);
    currentAudio = item;
    status.textContent = t('playing', name);
    draw();
    updatePlayButton();
    audio.onended = () => {
      activeAudios = activeAudios.filter((a) => a !== item);
      cleanupPreview(preview.url);
      if (currentAudio === item) currentAudio = null;
      draw();
      updatePlayButton();
    };
  } catch (e) {
    console.error('Preview error', e);
    status.textContent = t('previewFailed');
    cleanupPreview(preview.url);
  }
}

function cleanupPreview(url) {
  if (!url) return;
  window.electron.removeTmpFile(url).catch(() => {});
}

canvas.addEventListener('click', async (e) => {
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
  const hit = await hitTest(sx, sy);
  if (!hit) { selectedId = null; draw(); return; }
  selectedId = hit.id;
  lastSample = hit.sample;
  draw();
  status.textContent = `${hit.sample.name} | ${hit.sample.category} | ${hit.sample.path}`;
  openDetailPanel(hit);
  const preview = await window.electron.previewSampleUrl(hit.sample.path);
  if (!preview || !preview.url) { status.textContent = t('previewFailed'); return; }
  playPreview(preview, hit.sample.name, hit.sample.path);
});

canvas.addEventListener('dblclick', async (e) => {
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
  const hit = await hitTest(sx, sy);
  if (!hit) return;
  await window.electron.startDragFile(hit.sample.path);
});

canvas.addEventListener('contextmenu', async (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
  const hit = await hitTest(sx, sy);
  if (!hit) return;
  selectedId = hit.id;
  draw();
  const menu = document.getElementById('ctx-menu');
  menu.style.display = 'block';
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  const open = () => {
    window.electron.openItemInExplorer(hit.sample.path).catch(() => {});
    menu.style.display = 'none';
  };
  menu.onclick = (ev) => {
    const item = ev.target.closest('.item');
    if (!item) return;
    const action = item.getAttribute('data-action');
    if (action === 'open') open();
  };
});

window.addEventListener('click', (e) => {
  if (!e.target.closest('#ctx-menu')) {
    document.getElementById('ctx-menu').style.display = 'none';
  }
});

canvas.addEventListener('mousemove', async (e) => {
  if (isPanning) return;
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
  const hit = await hitTest(sx, sy);
  tooltip.style.display = 'none';
  if (hit) {
    tooltip.style.display = 'block';
    tooltip.style.left = (e.clientX + 12) + 'px';
    tooltip.style.top = (e.clientY - 28) + 'px';
    tooltip.querySelector('.name').textContent = hit.sample.name;
    tooltip.querySelector('.cat').textContent = hit.sample.category;
    canvas.style.cursor = hit ? 'pointer' : 'crosshair';
  }
});

// ---- Detail panel: waveform, metadata, similar samples ----
let detailNodeId = null;
let waveCache = new Map(); // path -> peaks Float32Array (min/max pairs)

function closeDetailPanel() {
  detailNodeId = null;
  const panel = document.getElementById('detail-panel');
  if (panel) panel.classList.remove('open');
}

async function openDetailPanel(node) {
  detailNodeId = node.id;
  const panel = document.getElementById('detail-panel');
  panel.classList.add('open');
  await renderDetailPanel(node);
}

async function renderDetailPanel(node) {
  const s = node.sample;
  document.getElementById('detail-title').textContent = s.name;
  const meta = [];
  meta.push(`${t('folderLabel')}: ${s.folder || '—'}`);
  const dur = s.duration != null ? s.duration : (descriptorCache.get(s.path) || {}).duration;
  if (dur != null) meta.push(`${t('duration')}: ${dur.toFixed(2)} s`);
  if (s.size != null) meta.push(`${t('size')}: ${(s.size / 1024).toFixed(0)} KB`);
  if (s.sampleRate) meta.push(`SR: ${s.sampleRate} Hz`);
  if (s.channels) meta.push(`CH: ${s.channels}`);
  if (s.bitsPerSample) meta.push(`${s.bitsPerSample}-bit`);
  if (s.loop) meta.push('LOOP');
  meta.push(s.path);
  document.getElementById('detail-meta').textContent = meta.join('\n');
  updateShortlistButton();
  updatePlayButton();
  drawWaveform(node);
  const simBox = document.getElementById('detail-sim');
  simBox.innerHTML = `<div style="color:#777;font-size:11px">${t('analyzing')}</div>`;
  const sim = await findSimilar(node, 6);
  if (detailNodeId !== node.id) return;
  simBox.innerHTML = '';
  if (!sim.length) {
    simBox.innerHTML = `<div style="color:#777;font-size:11px">${t('noSimilar')}</div>`;
    return;
  }
  for (const { node: cand, dist } of sim) {
    const row = document.createElement('div');
    row.className = 'sim-item';
    row.innerHTML = `<span class="nm" style="color:${cand.color}">${cand.sample.name}</span><span class="d">~${dist.toFixed(2)}</span>`;
    row.addEventListener('click', async () => {
      selectedId = cand.id;
      lastSample = cand.sample;
      draw();
      await openDetailPanel(cand);
      const preview = await window.electron.previewSampleUrl(cand.sample.path);
      if (preview?.url) playPreview(preview, cand.sample.name, cand.sample.path);
    });
    simBox.appendChild(row);
  }
}

function updateShortlistButton() {
  const btn = document.getElementById('detail-shortlist');
  if (!btn) return;
  const on = shortlist.has(detailNodeId);
  btn.textContent = on ? t('removeShortlist') : t('addShortlist');
}
function updatePlayButton() {
  const btn = document.getElementById('detail-play');
  if (!btn) return;
  const node = nodes.find((n) => n.id === detailNodeId);
  const playing = node && activeAudios.some((a) => a.path === node.sample.path);
  btn.textContent = playing ? '⏸ ' + (lang === 'ru' ? 'Пауза' : 'Pause') : '▶ ' + t('play');
}

async function drawWaveform(node) {
  const cv = document.getElementById('detail-wave');
  const wctx = cv.getContext('2d');
  const dpr = devicePixelRatio || 1;
  const W = cv.clientWidth || 280;
  const H = cv.clientHeight || 64;
  cv.width = W * dpr; cv.height = H * dpr;
  wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  wctx.clearRect(0, 0, W, H);
  const path = node.sample.path;
  let peaks = waveCache.get(path);
  if (!peaks) {
    wctx.fillStyle = '#555';
    wctx.font = '11px sans-serif';
    wctx.fillText(t('analyzing'), 8, H / 2 + 4);
    peaks = await computePeaks(path);
    if (peaks) waveCache.set(path, peaks);
  }
  if (detailNodeId !== node.id) return;
  wctx.clearRect(0, 0, W, H);
  if (!peaks || !peaks.length) {
    wctx.fillStyle = '#555';
    wctx.font = '11px sans-serif';
    wctx.fillText('waveform n/a', 8, H / 2 + 4);
    return;
  }
  wctx.strokeStyle = node.color;
  wctx.lineWidth = 1;
  wctx.beginPath();
  const cols = peaks.length / 2;
  for (let i = 0; i < cols; i++) {
    const x = (i / (cols - 1 || 1)) * W;
    const mn = peaks[i * 2], mx = peaks[i * 2 + 1];
    const y1 = H / 2 - mx * (H / 2 - 2);
    const y2 = H / 2 - mn * (H / 2 - 2);
    wctx.moveTo(x, y1);
    wctx.lineTo(x, y2);
  }
  wctx.stroke();
}

async function computePeaks(filePath, cols = 120) {
  try {
    ensureAudioContext();
    if (!audioCtx) return null;
    const preview = await window.electron.previewSampleUrl(filePath);
    if (!preview || !preview.url) return null;
    const res = await fetch(preview.url);
    const buf = await res.arrayBuffer();
    let audio;
    try { audio = await audioCtx.decodeAudioData(buf); }
    catch { cleanupPreview(preview.url); return null; }
    cleanupPreview(preview.url);
    const ch = audio.getChannelData(0);
    const per = Math.max(1, Math.floor(ch.length / cols));
    const peaks = new Float32Array(cols * 2);
    for (let c = 0; c < cols; c++) {
      let mn = 0, mx = 0;
      const start = c * per, end = Math.min(ch.length, start + per);
      for (let i = start; i < end; i++) {
        const v = ch[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      peaks[c * 2] = mn;
      peaks[c * 2 + 1] = mx;
    }
    return peaks;
  } catch {
    return null;
  }
}

document.getElementById('detail-close').addEventListener('click', closeDetailPanel);
document.getElementById('detail-play').addEventListener('click', async () => {
  const node = nodes.find((n) => n.id === detailNodeId);
  if (!node) return;
  const playing = activeAudios.find((a) => a.path === node.sample.path);
  if (playing) {
    try { playing.source.pause(); } catch {}
    activeAudios = activeAudios.filter((a) => a !== playing);
    cleanupPreview(playing.url);
    updatePlayButton();
    draw();
    return;
  }
  const preview = await window.electron.previewSampleUrl(node.sample.path);
  if (preview?.url) { playPreview(preview, node.sample.name, node.sample.path); updatePlayButton(); }
});
document.getElementById('detail-shortlist').addEventListener('click', () => {
  if (detailNodeId == null) return;
  if (shortlist.has(detailNodeId)) shortlist.delete(detailNodeId);
  else shortlist.add(detailNodeId);
  updateShortlistState();
  updateShortlistButton();
  draw();
});
document.getElementById('detail-reveal').addEventListener('click', () => {
  const node = nodes.find((n) => n.id === detailNodeId);
  if (node) window.electron.openItemInExplorer(node.sample.path).catch(() => {});
});

function renderShortlistPanel() {
  const panel = document.getElementById('shortlist-panel');
  const list = document.getElementById('shortlist-item');
  list.innerHTML = '';
  [...shortlist].map((id) => nodes.find((n) => n.id === id)).filter(Boolean).forEach((n) => {
    const row = document.createElement('div');
    row.className = 'shortlist-item';
    row.innerHTML = `<div class="name">${n.sample.name}</div><div class="cat">${n.sample.category}</div>`;
    row.addEventListener('click', async () => {
      selectedId = n.id;
      lastSample = n.sample;
      draw();
      await openDetailPanel(n);
      status.textContent = `${n.sample.name} | ${n.sample.category} | ${n.sample.path}`;
      const preview = await window.electron.previewSampleUrl(n.sample.path);
      if (preview?.url) playPreview(preview, n.sample.name, n.sample.path);
    });
    list.appendChild(row);
  });
  if (!list.children.length) {
    const empty = document.createElement('div');
    empty.style.color = '#aaa';
    empty.style.fontSize = '11px';
    empty.textContent = lang === 'ru' ? 'Пусто' : 'Empty';
    list.appendChild(empty);
  }
  panel.style.display = shortlist.size > 0 ? 'flex' : 'none';
}

function updateShortlistState() {
  const panel = document.getElementById('shortlist-panel');
  if (!panel) return;
  panel.style.display = shortlist.size > 0 ? 'flex' : 'none';
  if (shortlist.size > 0) renderShortlistPanel();
  const countEl = document.getElementById('shortlist-count');
  if (countEl) countEl.textContent = `${shortlist.size}`;
  try { localStorage.setItem('shortlist', JSON.stringify([...shortlist])); } catch {}
}

function restoreShortlist() {
  try {
    const raw = localStorage.getItem('shortlist');
    if (raw) {
      const ids = JSON.parse(raw);
      // node ids are rebuilt on each index; map old ids via saved paths if possible
      const byPath = new Map(samples.map((s) => [s.path, s]));
      shortlist = new Set(nodes.filter((n) => ids.includes(n.id)).map((n) => n.id));
    }
    closeDetailPanel();
    updateShortlistState();
    draw();
  } catch {}
}

function showToast(msg) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.style.cssText = 'position:absolute;bottom:12px;left:50%;transform:translateX(-50%);background:rgba(20,20,28,.92);border:1px solid #333;color:#eee;padding:8px 12px;border-radius:10px;font-size:12px;z-index:30;';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.display = 'none'; }, 1800);
}

// ---- ShortList export: TXT / CSV / JSON ----
function shortlistSamples() {
  return [...shortlist].map((id) => nodes.find((n) => n.id === id)).filter(Boolean).map((n) => n.sample);
}
function exportShortlist(format) {
  const items = shortlistSamples();
  if (!items.length) return;
  let content = '', filename = 'xo-shortlist';
  if (format === 'txt') {
    content = items.map((s) => s.path).join('\r\n');
    filename += '.txt';
  } else if (format === 'csv') {
    const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const rows = [['name', 'category', 'duration', 'loop', 'path'].join(',')];
    for (const s of items) {
      rows.push([esc(s.name), esc(s.category), s.duration != null ? s.duration.toFixed(3) : '', s.loop ? 1 : 0, esc(s.path)].join(','));
    }
    content = rows.join('\r\n');
    filename += '.csv';
  } else {
    content = JSON.stringify(items.map((s) => ({
      name: s.name, category: s.category, loop: !!s.loop,
      duration: s.duration ?? null, size: s.size ?? null,
      sampleRate: s.sampleRate ?? null, channels: s.channels ?? null, path: s.path,
    })), null, 2);
    filename += '.json';
  }
  window.electron.saveFile(filename, content).then((saved) => {
    if (saved) showToast(t('exported', items.length));
  });
}
document.getElementById('export-txt').addEventListener('click', () => exportShortlist('txt'));
document.getElementById('export-csv').addEventListener('click', () => exportShortlist('csv'));
document.getElementById('export-json').addEventListener('click', () => exportShortlist('json'));
document.getElementById('clear-shortlist').addEventListener('click', () => {
  shortlist.clear();
  updateShortlistState();
  draw();
});

document.getElementById('menu-lang').addEventListener('change', (e) => {
  lang = e.target.value;
  localStorage.setItem('lang', lang);
  updateFadeButton();
  renderCategoryChips([...new Set(samples.map((s) => s.category).filter(Boolean))].sort() || ['other']);
  applyStaticI18n();
});

function applyStaticI18n() {
  const si = document.getElementById('search');
  if (si) si.placeholder = t('searchPlaceholder');
  const lb = document.getElementById('links-toggle');
  if (lb) lb.textContent = showLinks ? t('linksOn') : t('links');
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (i18n[lang] && typeof i18n[lang][key] === 'string') el.textContent = i18n[lang][key];
  });
  updateShortlistButton();
  updatePlayButton();
}
updateFadeButton();
