const { app, BrowserWindow, ipcMain, nativeImage, clipboard, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { analyzeFile } = require('./audio-analyze');

// simple on-disk cache for audio analysis (keyed by path|size|mtime)
const CACHE_FILE = () => path.join(app.getPath('userData'), 'analysis-cache.json');
let analysisCache = null;
function loadCache() {
  if (analysisCache) return analysisCache;
  try { analysisCache = JSON.parse(fs.readFileSync(CACHE_FILE(), 'utf8')); }
  catch { analysisCache = {}; }
  return analysisCache;
}
function saveCache() {
  try { fs.writeFileSync(CACHE_FILE(), JSON.stringify(analysisCache)); } catch {}
}
function cachedAnalyze(filePath) {
  const cache = loadCache();
  let stat;
  try { stat = fs.statSync(filePath); } catch { return {}; }
  const key = filePath + '|' + stat.size + '|' + Math.round(stat.mtimeMs);
  if (cache[key]) return cache[key];
  const info = analyzeFile(filePath) || {};
  cache[key] = info;
  return info;
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  try { Menu.setApplicationMenu(null); } catch {}
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('index-folder', async (_event, folder) => {
  const exts = ['.wav', '.mp3', '.flac', '.aif', '.aiff', '.ogg'];
  const files = [];
  const categorySet = new Set();
  let scanned = 0;
  let last = '';

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (exts.includes(path.extname(entry.name).toLowerCase())) {
        const cat = guessCategory(full);
        categorySet.add(cat);
        const isLoop = /loop|loops|loopable/.test(entry.name.toLowerCase()) || /loop|loops|loopable/.test(path.basename(dir).toLowerCase());
        const meta = cachedAnalyze(full);
        files.push({
          id: files.length,
          path: full,
          name: entry.name,
          folder: path.basename(dir),
          category: cat,
          loop: !!isLoop,
          duration: typeof meta.duration === 'number' ? meta.duration : undefined,
          size: meta.size,
          sampleRate: meta.sampleRate,
          channels: meta.channels,
          bitsPerSample: meta.bitsPerSample,
        });
        scanned++;
        last = entry.name;
        if (scanned % 500 === 0) {
          mainWindow.webContents.send('index-progress', { folder, scanned, last });
        }
      }
    }
  }

  try {
    await walk(folder);
  } catch (e) {
    mainWindow.webContents.send('index-error', { folder, error: String(e) });
  }

  saveCache();
  mainWindow.webContents.send('index-progress', { folder, scanned, last: 'DONE' });
  return { files, categories: Array.from(categorySet).sort() };
});

ipcMain.handle('analyze-file', async (_event, filePath) => {
  try {
    return cachedAnalyze(filePath);
  } catch {
    return {};
  }
});

function guessCategory(full) {
  const base = full.toLowerCase();
  if (/(kick|bd|bassdrum)/.test(base)) return 'kick';
  if (/(snare|sn)/.test(base)) return 'snare';
  if (/(hh|hat|hihat|hi-hat|closed|open hat)/.test(base)) return 'hat';
  if (/(clap)/.test(base)) return 'clap';
  if (/(perc|tom|conga|bongo)/.test(base)) return 'perc';
  if (/(fx|riser|down|impact|transition|noise)/.test(base)) return 'fx';
  if (/(vox|vocal|choir)/.test(base)) return 'vox';
  if (/(bass|sub)/.test(base)) return 'bass';
  return 'other';
}

ipcMain.handle('preview-sample-url', async (_event, filePath) => {
  try {
    const tmpName = 'xo-preview-' + path.basename(filePath);
    const tmpPath = path.join(os.tmpdir(), tmpName);
    fs.copyFileSync(filePath, tmpPath);
    return { url: pathToFileURL(tmpPath).href };
  } catch {
    return null;
  }
});

ipcMain.handle('remove-tmp-file', async (_event, url) => {
  try {
    if (!url || !url.startsWith('file://')) return;
    const p = decodeURIComponent(url.slice(7));
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
  } catch {}
});

ipcMain.handle('get-sample-raw-path', (_event, filePath) => {
  return filePath;
});

ipcMain.handle('start-drag-file', async (_event, filePath) => {
  const img = nativeImage.createFromPath(filePath);
  mainWindow.webContents.startDrag({
    file: filePath,
    icon: img,
  });
});

ipcMain.handle('open-in-explorer', async (_event, filePath) => {
  try {
    console.log('open-in-explorer:', filePath);
    if (!filePath || !filePath.trim()) return false;
    try {
      await shell.showItemInFolder(filePath);
      return true;
    } catch (e) {
      console.error('open-in-explorer shell error:', e);
    }
    try {
      const { execFile } = require('child_process');
      await new Promise((resolve, reject) => {
        execFile('explorer.exe', ['/select,', filePath], (err) => {
          if (err) reject(err); else resolve();
        });
      });
      return true;
    } catch (e2) {
      console.error('open-in-explorer fallback error:', e2);
      return false;
    }
  } catch (e) {
    console.error('open-in-explorer error:', e);
    return false;
  }
});

ipcMain.handle('open-in-browser', async (_event, filePath) => {
  try {
    await shell.openPath(filePath);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('open-last-in-aimp', async (_event, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return false;
    const candidates = [
      'C:\\Program Files\\AIMP\\AIMP.exe',
      'C:\\Program Files (x86)\\AIMP\\AIMP.exe',
      path.join(process.env.LOCALAPPDATA || '', 'AIMP', 'AIMP.exe'),
    ];
    const aimp = candidates.find((c) => fs.existsSync(c));
    if (aimp) {
      try {
        spawn(aimp, [filePath], { detached: true, stdio: 'ignore', shell: true }).unref();
        return true;
      } catch (e) {
        console.error('AIMP spawn error:', e);
      }
    }
    await shell.openPath(filePath);
    return true;
  } catch (e) {
    console.error('open-last-in-aimp error:', e);
    return false;
  }
});

ipcMain.handle('set-interface-zoom', (_event, level) => {
  try {
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.setZoomLevel(level);
    }
  } catch (e) {
    console.error('set-interface-zoom error:', e);
  }
  return true;
});

ipcMain.handle('copy-selected-path', async (_event, filePath) => {
  try {
    if (!filePath) return false;
    clipboard.writeText(filePath);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('save-file', async (_event, defaultName, content) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: defaultName,
      filters: [
        { name: 'Text', extensions: ['txt'] },
        { name: 'CSV', extensions: ['csv'] },
        { name: 'JSON', extensions: ['json'] },
      ],
    });
    if (result.canceled || !result.filePath) return false;
    fs.writeFileSync(result.filePath, String(content), 'utf8');
    return result.filePath;
  } catch {
    return false;
  }
});
