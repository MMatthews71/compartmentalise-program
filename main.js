const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs/promises');

// Keep a global reference so the window isn't garbage-collected.
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: '#0f1117',
    title: 'Compartmentalise',
    webPreferences: {
      // The page itself gets no Node access. The only filesystem access is
      // the small, explicit API in preload.js, handled below in this file.
      // Nothing is ever sent over the network.
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

// ================= Folder support =================

// Where a project's secrets are stored. This folder is never scanned and never
// included in a safe copy.
const SECRETS_DIR = 'compartmentalise-secrets';
const SECRETS_FILE = 'secrets.json';

// Folders that are never read or copied: version-control history (which still
// holds every old secret), dependency installs and caches.
const SKIP_DIRS = new Set([
  SECRETS_DIR,
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.tox',
  '.idea'
]);

const MAX_TEXT_BYTES = 2 * 1024 * 1024; // larger files are copied, not scanned
const MAX_FILES = 20000;

// Folders the page has opened, by id. Writes and copies are only ever done
// relative to one of these or to a folder the user just picked in a dialog.
const roots = new Map();
let nextRootId = 1;

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Resolve a "/"-separated relative path under base, refusing escapes. */
function resolveUnder(base, rel) {
  if (typeof rel !== 'string' || rel === '' || path.isAbsolute(rel)) return null;
  const full = path.resolve(base, ...rel.split('/'));
  if (full === base || !isInside(full, base)) return null;
  return full;
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

async function readTree(root) {
  const files = [];
  const skipped = new Set();
  let truncated = false;

  async function walk(dir, rel) {
    if (truncated) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (files.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      const full = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) {
          skipped.add(ent.name);
          continue;
        }
        await walk(full, relPath);
      } else if (ent.isFile()) {
        const file = { path: relPath, text: null, reason: null, size: 0 };
        try {
          const stat = await fs.stat(full);
          file.size = stat.size;
          if (stat.size > MAX_TEXT_BYTES) {
            file.reason = 'too large to scan';
          } else {
            const buf = await fs.readFile(full);
            if (looksBinary(buf)) {
              file.reason = 'binary';
            } else {
              const text = buf.toString('utf8');
              // Only treat it as text if it round-trips byte-for-byte, so
              // writing it back can never change anything we didn't replace.
              if (Buffer.from(text, 'utf8').equals(buf)) file.text = text;
              else file.reason = 'not UTF-8 text';
            }
          }
        } catch (err) {
          file.reason = 'could not be read';
        }
        files.push(file);
      }
    }
  }

  await walk(root, '');
  return { files, skippedDirs: [...skipped], truncated };
}

async function loadSecrets(root) {
  try {
    const raw = await fs.readFile(path.join(root, SECRETS_DIR, SECRETS_FILE), 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.secrets)) return [];
    return data.secrets
      .filter((s) => s && typeof s.value === 'string' && typeof s.placeholder === 'string')
      .map((s) => ({ value: s.value, placeholder: s.placeholder }));
  } catch (_) {
    return null; // no secrets saved yet
  }
}

async function pickAndRead(title) {
  const res = await dialog.showOpenDialog(mainWindow, {
    title,
    properties: ['openDirectory']
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const root = path.resolve(res.filePaths[0]);
  const id = nextRootId++;
  roots.set(id, root);
  const tree = await readTree(root);
  return { id, root, name: path.basename(root), ...tree };
}

ipcMain.handle('folder:open-project', async () => {
  const result = await pickAndRead('Open your project folder');
  if (!result) return { canceled: true };
  result.secrets = await loadSecrets(result.root);
  result.secretsPath = path.join(result.root, SECRETS_DIR, SECRETS_FILE);
  return result;
});

ipcMain.handle('folder:open-other', async (_e, { title } = {}) => {
  const result = await pickAndRead(title || 'Open a folder');
  return result || { canceled: true };
});

ipcMain.handle('secrets:import', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose your secrets file',
    properties: ['openFile'],
    filters: [
      { name: 'Secrets files', extensions: ['json', 'env', 'py', 'txt', 'yaml', 'yml', 'ini', 'cfg', 'toml'] },
      { name: 'All files', extensions: ['*'] }
    ]
  });
  if (res.canceled || !res.filePaths[0]) return { canceled: true };
  const file = res.filePaths[0];
  const stat = await fs.stat(file);
  if (stat.size > 5 * 1024 * 1024) return { error: 'That file is too big to be a secrets file.' };
  return { name: path.basename(file), text: await fs.readFile(file, 'utf8') };
});

ipcMain.handle('secrets:save', async (_e, { rootId, secrets }) => {
  const root = roots.get(rootId);
  if (!root || !Array.isArray(secrets)) return { ok: false, error: 'Unknown folder' };
  const dir = path.join(root, SECRETS_DIR);
  await fs.mkdir(dir, { recursive: true });
  // A .gitignore of "*" keeps git from ever committing this folder, without
  // touching the project's own .gitignore.
  await fs.writeFile(path.join(dir, '.gitignore'), '# Created by Compartmentalise: never commit real secrets.\n*\n');
  const data = {
    about:
      'Real values hidden by Compartmentalise. Keep this folder private: never share or commit it.',
    secrets: secrets
      .filter((s) => s && typeof s.value === 'string' && typeof s.placeholder === 'string')
      .map((s) => ({ value: s.value, placeholder: s.placeholder }))
  };
  await fs.writeFile(path.join(dir, SECRETS_FILE), JSON.stringify(data, null, 2) + '\n');
  return { ok: true };
});

/**
 * opts: {
 *   sourceId,          // folder that "copy" entries are read from
 *   title, mode,       // 'new' = save dialog for a new folder, 'existing' = pick a folder
 *   suggestedName,
 *   files: [{ from, to, content? }]  // content present = write it, else copy bytes
 * }
 */
ipcMain.handle('folder:write', async (_e, opts) => {
  const sourceRoot = roots.get(opts && opts.sourceId);
  if (!sourceRoot) return { error: 'Unknown source folder' };

  let dest;
  if (opts.mode === 'new') {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: opts.title,
      buttonLabel: 'Create folder',
      defaultPath: path.join(path.dirname(sourceRoot), opts.suggestedName || 'output'),
      properties: ['createDirectory', 'showOverwriteConfirmation']
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    dest = path.resolve(res.filePath);
  } else {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: opts.title,
      buttonLabel: 'Write here',
      properties: ['openDirectory', 'createDirectory', 'promptToCreate']
    });
    if (res.canceled || !res.filePaths[0]) return { canceled: true };
    dest = path.resolve(res.filePaths[0]);
  }

  if (isInside(dest, sourceRoot)) {
    return { error: 'Pick a folder outside the one being read.' };
  }

  let existing = [];
  try {
    const stat = await fs.stat(dest);
    if (!stat.isDirectory()) return { error: 'That path is a file, not a folder.' };
    existing = await fs.readdir(dest);
  } catch (_) {
    // doesn't exist yet — will be created
  }
  if (existing.length > 0) {
    const answer = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Overwrite matching files', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Folder is not empty',
      message: `"${path.basename(dest)}" already has files in it.`,
      detail:
        'Files with the same names will be overwritten. Other files in it are left alone.'
    });
    if (answer.response !== 0) return { canceled: true };
  }

  let written = 0;
  let copied = 0;
  const failed = [];
  for (const f of opts.files || []) {
    const target = resolveUnder(dest, f.to);
    if (!target) {
      failed.push(f.to);
      continue;
    }
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      if (typeof f.content === 'string') {
        await fs.writeFile(target, f.content, 'utf8');
        written += 1;
      } else {
        const src = resolveUnder(sourceRoot, f.from);
        if (!src) throw new Error('bad source');
        await fs.copyFile(src, target);
        copied += 1;
      }
    } catch (_) {
      failed.push(f.to);
    }
  }
  return { dest, written, copied, failed };
});

app.whenReady().then(() => {
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
