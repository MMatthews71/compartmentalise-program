const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

// Keep a global reference so the window isn't garbage-collected.
let mainWindow = null;
// The file the user last opened. Saving only ever writes this file, the
// secrets module next to it, and other .py files read from its folder.
let openedPath = null;
// The project: the folder of the file opened with Open file… or Recent.
// Clicking between its files keeps it; folderPaths are its other .py files.
let projectRoot = null;
let folderPaths = new Set();
// Set by the renderer while it holds secrets that haven't been saved yet.
let unsaved = false;

const MODULE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: '#0f1117',
    title: 'Compartmentalise',
    webPreferences: {
      // The renderer does only string work; file access goes through the
      // narrow bridge in preload.js. Nothing is ever sent over the network.
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Open external links (e.g. the help link) in the real browser, never
  // inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Don't lose secrets that were added but never saved.
  mainWindow.on('close', (event) => {
    if (!unsaved) return;
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Quit without saving', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Unsaved secrets',
      message: "You've added secrets that haven't been saved.",
      detail: 'Quit anyway? They will be lost (nothing has been changed on disk).'
    });
    if (choice !== 0) event.preventDefault();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// A minimal menu: keep the standard edit shortcuts (copy/paste/select-all)
// working, drop everything else.
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [isMac ? { role: 'close' } : { role: 'quit' }]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- file access for the renderer ----------

/** The project's secrets module: one per project, in its folder. */
function secretsPathFor(sourcePath, moduleName) {
  if (!MODULE_NAME_RE.test(moduleName)) throw new Error(`"${moduleName}" isn't a valid module name`);
  return path.join(projectRoot || path.dirname(sourcePath), `${moduleName}.py`);
}

function readText(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return { text: text.replace(/\r\n/g, '\n'), eol: text.includes('\r\n') ? '\r\n' : '\n' };
}

// Folders that never hold the user's own code.
const SKIP_DIRS = new Set(['__pycache__', 'node_modules', 'venv', 'env', 'site-packages', 'dist', 'build']);
const MAX_FOLDER_FILES = 2000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Every .py file under `dir`, skipping hidden, virtualenv and build folders. */
function pythonFilesUnder(dir, found = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (found.length >= MAX_FOLDER_FILES) break;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) pythonFilesUnder(full, found);
    } else if (entry.isFile() && /\.pyw?$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

// ---------- recent files ----------
// Only paths and secrets-file names are remembered — never secret values,
// which live in the secrets file and nowhere else.

const MAX_RECENT = 10;
const recentFile = () => path.join(app.getPath('userData'), 'recent.json');

function readRecent() {
  try {
    const list = JSON.parse(fs.readFileSync(recentFile(), 'utf8'));
    return Array.isArray(list) ? list.filter((r) => r && typeof r.path === 'string') : [];
  } catch {
    return [];
  }
}

function rememberRecent(filePath, moduleName) {
  const list = readRecent().filter((r) => path.resolve(r.path) !== path.resolve(filePath));
  list.unshift({
    path: filePath,
    root: projectRoot || path.dirname(filePath),
    moduleName: MODULE_NAME_RE.test(moduleName || '') ? moduleName : 'hidden_secrets'
  });
  try {
    fs.mkdirSync(path.dirname(recentFile()), { recursive: true });
    fs.writeFileSync(recentFile(), JSON.stringify(list.slice(0, MAX_RECENT), null, 2));
  } catch {
    // Not being able to remember is no reason to fail.
  }
}

function registerFileHandlers() {
  ipcMain.handle('file:open', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Open a Python file',
      properties: ['openFile'],
      filters: [
        { name: 'Python', extensions: ['py', 'pyw'] },
        { name: 'All files', extensions: ['*'] }
      ]
    });
    if (canceled || filePaths.length === 0) return null;
    openedPath = filePaths[0];
    projectRoot = path.dirname(openedPath);
    return { path: openedPath, ...readText(openedPath) };
  });

  // Switch to another .py file of the open project.
  ipcMain.handle('file:open-in-project', (_event, filePath) => {
    if (!folderPaths.has(path.resolve(filePath))) return null;
    openedPath = filePath;
    return { path: openedPath, ...readText(openedPath) };
  });

  // Recent files that still exist, most recent first.
  ipcMain.handle('recent:list', () => readRecent().filter((r) => fs.existsSync(r.path)));

  ipcMain.handle('recent:remember', (_event, filePath, moduleName) => {
    if (filePath === openedPath) rememberRecent(filePath, moduleName);
  });

  // Reopen a file from the recent list (only those — no arbitrary paths).
  ipcMain.handle('file:open-recent', (_event, filePath) => {
    const entry = readRecent().find((r) => path.resolve(r.path) === path.resolve(filePath));
    if (!entry || !fs.existsSync(filePath)) return null;
    openedPath = filePath;
    const root = entry.root && fs.existsSync(entry.root) ? entry.root : path.dirname(filePath);
    projectRoot = path.relative(root, filePath).startsWith('..') ? path.dirname(filePath) : root;
    return { path: openedPath, ...readText(openedPath) };
  });

  // A yes/no question from the renderer, as a proper dialog.
  ipcMain.handle('app:confirm', async (_event, { message, detail, ok }) => {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: [String(ok || 'OK'), 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: String(message),
      detail: String(detail || '')
    });
    return response === 0;
  });

  ipcMain.handle('app:set-unsaved', (_event, value) => {
    unsaved = Boolean(value);
  });

  // The other Python files in the opened file's folder (and below), so files
  // that import from it can be kept working when its names change.
  ipcMain.handle('file:read-folder', (_event, sourcePath) => {
    if (sourcePath !== openedPath) return { root: null, files: [] };
    folderPaths = new Set();
    const files = [];
    const root = projectRoot || path.dirname(sourcePath);
    for (const file of pythonFilesUnder(root)) {
      if (path.resolve(file) === path.resolve(sourcePath)) continue;
      try {
        if (fs.statSync(file).size > MAX_FILE_BYTES) continue;
        files.push({ path: file, ...readText(file) });
        folderPaths.add(path.resolve(file));
      } catch {
        // Unreadable files are simply left out.
      }
    }
    return { root, files };
  });

  ipcMain.handle('file:read-secrets', (_event, sourcePath, moduleName) => {
    if (sourcePath !== openedPath) return null;
    const secretsPath = secretsPathFor(sourcePath, moduleName);
    return fs.existsSync(secretsPath) ? readText(secretsPath).text : null;
  });

  ipcMain.handle('file:save', async (_event, { sourcePath, sourceText, moduleName, secretsText, eol, restoring, others = [] }) => {
    try {
      if (!openedPath || sourcePath !== openedPath) throw new Error('Open the file again before saving');
      const secretsPath = secretsPathFor(sourcePath, moduleName);
      if (path.resolve(secretsPath) === path.resolve(sourcePath)) {
        throw new Error('The secrets file must be a different file from the one you opened');
      }
      for (const other of others) {
        const resolved = path.resolve(other.path);
        if (!folderPaths.has(resolved) || resolved === path.resolve(secretsPath)) {
          throw new Error(`Won't write ${other.path}: it wasn't read from this folder`);
        }
      }
      const othersList = others.length
        ? `\n\nand updates ${others.length} other ${others.length === 1 ? 'file that imports' : 'files that import'} from it:\n` +
          others.map((o) => `  ${path.relative(projectRoot || path.dirname(sourcePath), o.path)}`).join('\n')
        : '';
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['Save', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        title: 'Save changes',
        message: restoring ? 'Put the real names back and save?' : 'Hide the secrets and save?',
        detail:
          (restoring
            ? `This overwrites:\n  ${sourcePath}\n     (renamed names changed back)\n\n` +
              `and updates:\n  ${secretsPath}\n     (the notes about those renames are removed)`
            : `This overwrites:\n  ${sourcePath}\n     (secrets removed or renamed, imports added)\n\n` +
              `and writes:\n  ${secretsPath}\n     (keep this one away from AI tools)`) + othersList
      });
      if (response !== 0) return { canceled: true };
      const toDisk = (text, ending = eol) => (ending === '\r\n' ? text.replace(/\n/g, '\r\n') : text);
      // Secrets first, so a failure writing the source never loses them.
      fs.writeFileSync(secretsPath, toDisk(secretsText), 'utf8');
      for (const other of others) fs.writeFileSync(other.path, toDisk(other.text, other.eol), 'utf8');
      fs.writeFileSync(sourcePath, toDisk(sourceText), 'utf8');
      return { ok: true, secretsPath };
    } catch (err) {
      return { error: err.message };
    }
  });
}

app.whenReady().then(() => {
  registerFileHandlers();
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
