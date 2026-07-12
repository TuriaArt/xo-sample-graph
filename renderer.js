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
  if (e.target.tagName === 'INPUT') return;
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
      if (preview?.url) playPreview(preview, selected.sample.name);
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
        r: 2 + Math.random() * 1.5,
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

  for (const n of nodes) {
    if (activeFilter !== 'all' && n.group !== activeFilter) continue;
    if (loopFilter === 'loop' && !n.sample.loop) continue;
    if (loopFilter === 'oneshot' && n.sample.loop) continue;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
    ctx.fillStyle = n.color;
    ctx.fill();
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
    if (activeFilter !== 'all' && n.group !== activeFilter) continue;
    if (loopFilter === 'loop' && !n.sample.loop) continue;
    if (loopFilter === 'oneshot' && n.sample.loop) continue;
    if (searchTerm && !n.sample.name.toLowerCase().includes(searchTerm)) continue;
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

function playPreview(preview, name) {
  try {
    ensureAudioContext();
    if (!fadeMode) stopCurrent(fadeMode);
    const audio = new Audio(preview.url);
    audio.play().catch((e) => console.error('play() rejected', e));
    const item = { source: audio, gain: null, context: null, url: preview.url, name };
    try {
      if (audioCtx) {
        const node = audioCtx.createMediaElementSource(audio);
        node.connect(masterGain);
      }
    } catch {}
    activeAudios.push(item);
    currentAudio = item;
    status.textContent = t('playing', name);
    audio.onended = () => {
      activeAudios = activeAudios.filter((a) => a !== item);
      cleanupPreview(preview.url);
      if (currentAudio === item) currentAudio = null;
      draw();
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
  const preview = await window.electron.previewSampleUrl(hit.sample.path);
  if (!preview || !preview.url) { status.textContent = t('previewFailed'); return; }
  playPreview(preview, hit.sample.name);
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
      draw();
      status.textContent = `${n.sample.name} | ${n.sample.category} | ${n.sample.path}`;
      const preview = await window.electron.previewSampleUrl(n.sample.path);
      if (preview?.url) playPreview(preview, n.sample.name);
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
    if (!raw) return;
    const ids = JSON.parse(raw);
    const valid = new Set(ids.filter((id) => nodes.some((n) => n.id === id)));
    shortlist = valid;
    updateShortlistState();
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

document.getElementById('menu-lang').addEventListener('change', (e) => {
  lang = e.target.value;
  localStorage.setItem('lang', lang);
  updateFadeButton();
  renderCategoryChips([...new Set(samples.map((s) => s.category).filter(Boolean))].sort() || ['other']);
});
updateFadeButton();
