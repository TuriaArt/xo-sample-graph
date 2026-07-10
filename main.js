const { app, BrowserWindow, ipcMain, nativeImage, clipboard, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

let mainWindow;

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const fileSub = isMac ? [{ role: 'close' }] : [];
  const template = [
    ...(isMac ? [{ label: app.name, submenu: [{ role: 'quit' }] }] : []),
    {
      label: 'Файл',
      submenu: [
        { label: 'Выбрать папку...', accelerator: 'CmdOrCtrl+O', click: () => mainWindow.webContents.send('menu-choose-folder') },
        { label: 'Переиндексировать', accelerator: 'CmdOrCtrl+R', click: () => mainWindow.webContents.send('menu-choose-folder') },
        { type: 'separator' },
        { label: 'Открыть в проводнике', accelerator: 'CmdOrCtrl+Shift+O', click: () => mainWindow.webContents.send('menu-open-last') },
        { label: 'Открыть последний файл в AIMP', click: () => mainWindow.webContents.send('menu-open-last-in-aimp') },
        ...fileSub,
      ],
    },
    {
      label: 'Правка',
      submenu: [
        { label: 'Копировать путь', accelerator: 'CmdOrCtrl+C', click: () => mainWindow.webContents.send('menu-copy-path') },
      ],
    },
    {
      label: 'Вид',
      submenu: [
        { label: 'Увеличить', accelerator: 'CmdOrCtrl+=', click: () => mainWindow.webContents.send('zoom-in') },
        { label: 'Уменьшить', accelerator: 'CmdOrCtrl+-', click: () => mainWindow.webContents.send('zoom-out') },
        { label: 'Сбросить зум', accelerator: 'CmdOrCtrl+0', click: () => mainWindow.webContents.send('zoom-reset') },
        { type: 'separator' },
        { label: 'Затухание ВКЛ', type: 'checkbox', click: () => mainWindow.webContents.send('toggle-fade') },
        { label: 'Фильтр LOOP', type: 'checkbox', click: () => mainWindow.webContents.send('toggle-loop') },
      ],
    },
    {
      label: 'Окно',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [
          { type: 'separator' },
          { role: 'front' },
        ] : [
          { role: 'close' },
        ]),
      ],
    },
    {
      label: 'Помощь',
      submenu: [
        { label: 'О программе', click: () => {} },
      ],
    },
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

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
  buildMenu();
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
        const isLoop = /loop|loops|loopable/.test(entry.name.toLowerCase());
        files.push({
          id: files.length,
          path: full,
          name: entry.name,
          folder: path.basename(dir),
          category: cat,
          loop: !!isLoop,
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

  mainWindow.webContents.send('index-progress', { folder, scanned, last: 'DONE' });
  return { files, categories: Array.from(categorySet).sort() };
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
    if (!filePath || !fs.existsSync(filePath)) return false;
    await shell.showItemInFolder(filePath);
    return true;
  } catch (e) {
    console.error('open-in-explorer error:', e);
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

ipcMain.handle('copy-selected-path', async (_event, filePath) => {
  try {
    if (!filePath) return false;
    clipboard.writeText(filePath);
    return true;
  } catch {
    return false;
  }
});
