'use strict';

/*
 * Compartmentalise — renderer logic.
 *
 * The data model is a list of secrets, each { id, value, name }. Every edit
 * re-runs PyExtract (pyextract.js) over the code, which moves each secret into
 * a separate secrets module and imports it back by name. Nothing leaves this
 * machine; files are only read and written through the bridge in preload.js.
 */

const IS_MAC = navigator.platform.toUpperCase().includes('MAC');
const MOD_KEY = IS_MAC ? 'Cmd' : 'Ctrl';
const {
  extract,
  restoreNames,
  renamesFor,
  renameMap,
  moduleAliases,
  definedIn,
  updateImporters,
  hiddenEarlier,
  suggestName,
  variableName,
  isValidName
} = window.PyExtract;
// Only there when running inside the desktop app.
const fileBridge = window.files || null;

/** @type {{id:number, value:string, name:string, mode:'move'|'rename'}[]} */
let secrets = [];
let nextId = 1;
/** The file opened from disk, if any: { path, eol }. */
let openFile = null;
/** Current contents of the secrets module next to that file ('' if none). */
let existingModule = '';
/** The project's folder (where its secrets file lives), and its other .py
 *  files: [{ path, text, eol }]. */
let projectRoot = null;
let folderFiles = [];
let lastResult = null;
/** Files that import from the open file and change with it: [{ path, code, changes, problems }]. */
let lastOthers = [];

// ---------- element handles ----------
const el = (id) => document.getElementById(id);

const input = el('input');
const output = el('output');
const moduleOutput = el('module-output');
const othersOutput = el('others-output');
const secretsList = el('secrets-list');
const replaceCount = el('replace-count');
const moduleNameInput = el('module-name');

// ---------- helpers ----------

function showToast(message) {
  const toast = el('toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  // force reflow so the transition replays
  void toast.offsetWidth;
  toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.classList.add('hidden'), 200);
  }, 2200);
}

async function copyText(text, label) {
  if (!text) {
    showToast('Nothing to copy');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast(`${label} copied`);
  } catch (err) {
    showToast('Copy failed — select the text and copy manually');
  }
}

function moduleName() {
  return moduleNameInput.value.trim();
}

/** A path relative to the project folder, with / separators. */
function relative(filePath) {
  const root = (projectRoot || '').replace(/[\\/]+$/, '');
  const rel = root && filePath.startsWith(root) ? filePath.slice(root.length).replace(/^[\\/]+/, '') : filePath;
  return rel.replace(/\\/g, '/');
}

/** The open file as rename notes in the secrets file record it: its path in
 *  the project (just the name for files at the top). */
function fileName() {
  return openFile ? relative(openFile.path) : 'this file';
}

/** Path of the project's secrets file. */
function secretsFilePath() {
  const sep = openFile && openFile.path.includes('\\') ? '\\' : '/';
  return `${(projectRoot || '').replace(/[\\/]+$/, '')}${sep}${moduleName()}.py`;
}

/** The project files that follow the open file's renames, as they'd be with
 *  its new `code` and the secrets module's new `moduleText`:
 *  - files importing from the open file switch names in `map` (old -> new);
 *  - files importing a renamed variable straight from the secrets module
 *    (`NEW = OLD` there) switch to NEW.
 *  Only the ones that change or have something to report. */
function importersAfter(code, map, moduleText) {
  if (!openFile) return [];
  const stem = openFile.path.split(/[\\/]/).pop().replace(/\.pyw?$/, '');
  const candidates = folderFiles.filter((f) => f.path !== secretsFilePath());
  const before = new Map(candidates.map((f) => [f.path, f.text]));
  const byPath = new Map();
  const merge = (results) => {
    for (const o of results) {
      const prev = byPath.get(o.path);
      byPath.set(o.path, {
        path: o.path,
        code: o.code,
        changes: (prev ? prev.changes : 0) + o.changes,
        problems: (prev ? prev.problems : []).concat(o.problems)
      });
    }
  };
  if (map.size) merge(updateImporters(candidates, stem, map, definedIn(code)));
  const aliases = moduleAliases(moduleText);
  if (aliases.size) {
    const current = candidates.map((f) => ({ path: f.path, text: byPath.has(f.path) ? byPath.get(f.path).code : f.text }));
    merge(updateImporters(current, moduleName(), aliases, (name) => !aliases.has(name)));
  }
  return [...byPath.values()].filter((o) => o.code !== before.get(o.path) || o.problems.length);
}

/** The changed importers, ready to hand to the save bridge. */
function othersToSave(others) {
  const eolOf = new Map(folderFiles.map((f) => [f.path, f.eol]));
  return others.filter((o) => o.changes).map((o) => ({ path: o.path, text: o.code, eol: eolOf.get(o.path) }));
}

/** After a save, remember the new contents of the other files. */
function rememberSaved(saved) {
  const text = new Map(saved.map((o) => [o.path, o.text]));
  folderFiles = folderFiles.map((f) => (text.has(f.path) ? { ...f, text: text.get(f.path) } : f));
}

/** Show the other files that change, each under a header with its path. */
function showOthers() {
  const tab = el('tab-others');
  tab.classList.toggle('hidden', lastOthers.length === 0);
  tab.textContent = `Other files (${lastOthers.length})`;
  if (lastOthers.length === 0 && tab.classList.contains('active')) showPreview('file');
  othersOutput.value = lastOthers
    .map((o) => {
      const head = `# ===== ${o.path.split(/[\\/]/).pop()} — ${o.changes} ${o.changes === 1 ? 'change' : 'changes'} =====`;
      const notes = o.problems.map((p) => `# ⚠ ${p}`);
      return [head, ...notes, o.code].join('\n');
    })
    .join('\n\n');
}

// ---------- secrets model ----------

function addSecret(value = '') {
  const name = suggestName(new Set(secrets.map((s) => s.name)), input.value, existingModule);
  // Newest first, so a freshly added row is always visible at the top.
  secrets.unshift({ id: nextId++, value, name, mode: 'move' });
  renderSecrets();
  secretsList.scrollTop = 0;
  if (!value) secretsList.querySelector('.value-input')?.focus();
  update();
}

function removeSecret(id) {
  secrets = secrets.filter((s) => s.id !== id);
  renderSecrets();
  update();
}

function clearSecrets() {
  if (secrets.length === 0) return;
  secrets = [];
  renderSecrets();
  update();
  showToast('Secrets cleared');
}

// ---------- rendering the secrets table ----------

function renderSecrets() {
  secretsList.innerHTML = '';

  for (const secret of secrets) {
    const row = document.createElement('div');
    row.className = 'secret-row';
    row.dataset.id = String(secret.id);

    // A textarea (not an input) so secrets can span several lines.
    const valueInput = document.createElement('textarea');
    valueInput.className = 'value-input';
    valueInput.rows = 1;
    valueInput.value = secret.value;
    valueInput.spellcheck = false;

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'ph-input';
    nameInput.value = secret.name;
    nameInput.spellcheck = false;
    const setNameHint = () => {
      const varName = variableName(secret.value, input.value);
      nameInput.title =
        secret.mode === 'rename'
          ? `The new name your code will use instead of ${secret.value.trim() || 'it'}`
          : varName
            ? `Your code will say this instead of ${varName}. Type ${varName} itself to keep the name visible.`
            : 'The name your code will use';
    };
    setNameHint();
    nameInput.addEventListener('input', () => {
      secret.name = nameInput.value;
      update();
    });

    valueInput.addEventListener('input', () => {
      secret.value = valueInput.value;
      setNameHint();
      fitToContent(valueInput);
      update();
    });

    // Move the value out to the secrets file, or just give the name a new one.
    const modeSelect = document.createElement('select');
    modeSelect.className = 'mode-select';
    modeSelect.title = 'Move out: the value goes to the secrets file. Rename only: the code stays, under a new name.';
    for (const [value, label] of [
      ['move', 'Move out'],
      ['rename', 'Rename only']
    ]) {
      modeSelect.append(new Option(label, value, false, secret.mode === value));
    }
    modeSelect.addEventListener('change', () => {
      secret.mode = modeSelect.value;
      setNameHint();
      update();
    });

    const hits = document.createElement('span');
    hits.className = 'hit-badge';

    const del = document.createElement('button');
    del.className = 'del-btn';
    del.title = 'Remove this secret';
    del.textContent = '×';
    del.addEventListener('click', () => removeSecret(secret.id));

    const note = document.createElement('div');
    note.className = 'row-note hidden';

    row.append(valueInput, modeSelect, nameInput, hits, del, note);
    secretsList.append(row);
    fitToContent(valueInput);
  }
}

/** Grow a textarea to show all of its lines. */
function fitToContent(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight + 2}px`;
}

/** Write each row's moved count and any spots that had to stay visible. */
function updateRows(results) {
  for (const row of secretsList.children) {
    const result = results.get(Number(row.dataset.id)) || { hidden: 0, problems: [] };
    const badge = row.querySelector('.hit-badge');
    badge.textContent = String(result.hidden);
    badge.classList.toggle('zero', result.hidden === 0);
    badge.classList.toggle('live', result.hidden > 0);

    const note = row.querySelector('.row-note');
    const shown = result.problems.slice(0, 3).map((p) => `line ${p.line}: ${p.reason}`);
    if (result.problems.length > 3) shown.push(`…and ${result.problems.length - 3} more`);
    note.textContent = shown.length ? `⚠ Left visible — ${shown.join(' · ')}` : '';
    note.classList.toggle('hidden', shown.length === 0);
  }
}

// ---------- the core pass ----------

function update() {
  const name = moduleName();
  const nameOk = isValidName(name);
  moduleNameInput.classList.toggle('invalid', !nameOk);
  el('module-file-name').textContent = `${name || '?'}.py`;

  lastResult = extract(input.value, nameOk ? secrets : [], { moduleName: name, existingModule, fileName: fileName() });
  // Files that import from this one must follow its renames, or they'd break.
  lastOthers = nameOk
    ? importersAfter(lastResult.code, renameMap(lastResult.renamed, lastResult.moduleText, fileName()), lastResult.moduleText)
    : [];
  showOthers();
  output.value = lastResult.code;
  moduleOutput.value = lastResult.moduleText;
  updateRows(lastResult.results);

  let moved = 0;
  let visible = 0;
  for (const r of lastResult.results.values()) {
    moved += r.hidden;
    visible += r.problems.length;
  }
  if (!nameOk) {
    replaceCount.textContent = "⚠ the secrets file name isn't a valid Python name";
    replaceCount.style.color = 'var(--danger)';
  } else if (secrets.length === 0) {
    replaceCount.textContent = '';
  } else if (moved === 0 && visible === 0) {
    replaceCount.textContent = 'no matches found';
    replaceCount.style.color = 'var(--text-faint)';
  } else {
    const others = lastOthers.filter((o) => o.changes).length;
    replaceCount.textContent =
      `${moved} hidden` +
      (others ? ` · ${others} other ${others === 1 ? 'file' : 'files'} updated` : '') +
      (visible ? ` · ${visible} left visible` : '');
    replaceCount.style.color = visible ? 'var(--danger)' : 'var(--good)';
  }

  el('save-btn').disabled = !fileBridge || !openFile || !nameOk;
  renderEarlier();
  renderProject();
  // Ask before quitting while there are secrets that haven't been saved.
  if (fileBridge) fileBridge.setUnsaved(secrets.some((s) => s.value.trim()));
  if (nameOk && secrets.length === 0 && lastOthers.some((o) => o.changes)) {
    // Nothing new to hide, but files broken by an earlier save can be fixed.
    replaceCount.textContent = `${lastOthers.filter((o) => o.changes).length} other file(s) need updating — Save fixes them`;
    replaceCount.style.color = 'var(--danger)';
  }
  el('restore-names-btn').disabled =
    !fileBridge || !openFile || !nameOk || renamesFor(existingModule, fileName()).length === 0;
}

// ---------- files ----------

function showPaths() {
  const dir = projectRoot || '';
  const sep = openFile && openFile.path.includes('\\') ? '\\' : '/';
  // The path boxes trim long paths from the left (CSS direction: rtl); the
  // left-to-right marks keep slashes on the correct side.
  const ltr = (text) => (text ? `\u200e${text}\u200e` : '');
  el('file-path').textContent = openFile ? ltr(openFile.path) : fileBridge ? 'No file open — paste code or open one' : '';
  el('output-path').textContent = openFile
    ? ltr(
        el('tab-module').classList.contains('active')
          ? secretsFilePath()
          : el('tab-others').classList.contains('active')
            ? `${dir}${sep}…`
            : openFile.path
      )
    : '';
}

async function loadModule() {
  existingModule = openFile && isValidName(moduleName()) ? (await fileBridge.readSecrets(openFile.path, moduleName())) || '' : '';
}

/** Show a file the main process opened, and remember it for next time. */
async function showOpened(opened, verb = 'Opened') {
  if (!opened) return;
  openFile = { path: opened.path, eol: opened.eol };
  input.value = opened.text;
  await loadModule();
  const folder = (await fileBridge.readFolder(openFile.path)) || { root: null, files: [] };
  projectRoot = folder.root;
  folderFiles = folder.files;
  showPaths();
  update();
  await fileBridge.remember(openFile.path, moduleName());
  await refreshRecent();
  showToast(existingModule ? `${verb} — using the project's ${moduleName()}.py` : verb);
}

async function openFromDisk() {
  if (!fileBridge) return;
  await showOpened(await fileBridge.open());
}

/** Reopen a recent file, with the secrets file name it had. */
async function openRecent(filePath, verb) {
  const entry = (await fileBridge.recent()).find((r) => r.path === filePath);
  if (!entry) return;
  moduleNameInput.value = entry.moduleName;
  await showOpened(await fileBridge.openRecent(entry.path), verb);
}

/** Open another file of the project — asking first if this one has changes
 *  that haven't been saved. The secrets list stays, so it applies there too. */
async function switchTo(filePath) {
  if (!openFile || filePath === openFile.path) return;
  const pending = lastResult && (lastResult.code !== input.value || lastResult.added || othersToSave(lastOthers).length);
  if (
    pending &&
    !(await fileBridge.confirm({
      message: `${fileName()} has changes you haven't saved.`,
      detail: `Open ${relative(filePath)} anyway? Nothing has been changed on disk. Your secrets list stays, so you can use it on the other file.`,
      ok: 'Open without saving'
    }))
  ) {
    return;
  }
  await showOpened(await fileBridge.openInProject(filePath), secrets.length ? 'Opened — your secrets list applies here too' : 'Opened');
}

/** List the project's files, grouped by folder, marking the open one, the
 *  ones that use the secrets file and the ones a save would update. */
function renderProject() {
  const aside = el('project');
  aside.classList.toggle('hidden', !openFile || !projectRoot);
  if (!openFile || !projectRoot) return;
  el('project-name').textContent = projectRoot.split(/[\\/]/).filter(Boolean).pop() || projectRoot;
  el('project-name').title = projectRoot;
  const updating = new Set(lastOthers.filter((o) => o.changes).map((o) => o.path));
  const usesSecrets = new RegExp(`^\\s*(?:from\\s+${moduleName()}\\s+import|import\\s+${moduleName()}\\b)`, 'm');
  const textOf = new Map(folderFiles.map((f) => [f.path, f.text]));
  textOf.set(openFile.path, input.value);
  const entries = [...textOf.keys()]
    .filter((p) => p !== secretsFilePath())
    .map((p) => {
      const rel = relative(p);
      const cut = rel.lastIndexOf('/');
      return { path: p, dir: cut === -1 ? '' : rel.slice(0, cut), name: rel.slice(cut + 1) };
    })
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : !a.dir ? -1 : !b.dir ? 1 : a.dir.localeCompare(b.dir)));

  const nav = el('project-files');
  nav.innerHTML = '';
  let dir = '';
  for (const entry of entries) {
    if (entry.dir && entry.dir !== dir) {
      const folder = document.createElement('div');
      folder.className = 'project-folder';
      folder.textContent = `${entry.dir}/`;
      nav.append(folder);
    }
    dir = entry.dir;
    const button = document.createElement('button');
    button.className = 'project-file' + (entry.dir ? ' nested' : '') + (entry.path === openFile.path ? ' active' : '');
    button.title = relative(entry.path);
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = entry.name;
    button.append(name);
    if (updating.has(entry.path)) {
      const mark = document.createElement('span');
      mark.className = 'mark updates';
      mark.textContent = '▲';
      mark.title = 'Imports a name you are renaming — Save updates it too';
      button.append(mark);
    } else if (usesSecrets.test(textOf.get(entry.path))) {
      const mark = document.createElement('span');
      mark.className = 'mark uses';
      mark.textContent = '●';
      mark.title = `Already uses ${moduleName()}.py`;
      button.append(mark);
    }
    button.addEventListener('click', () => switchTo(entry.path));
    nav.append(button);
  }
}

/** Fill the Recent dropdown. */
async function refreshRecent() {
  const select = el('recent-select');
  const recent = fileBridge ? await fileBridge.recent() : [];
  select.length = 1;
  for (const r of recent) {
    const option = new Option(r.path.split(/[\\/]/).pop(), r.path);
    option.title = r.path;
    select.append(option);
  }
  select.value = '';
  select.disabled = recent.length === 0;
}

/** List what this file already hides, from the secrets file. */
function renderEarlier() {
  const items = openFile ? hiddenEarlier(input.value, existingModule, { moduleName: moduleName(), fileName: fileName() }) : [];
  el('earlier').classList.toggle('hidden', items.length === 0);
  el('earlier-count').textContent = String(items.length);
  const list = el('earlier-list');
  list.innerHTML = '';
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'earlier-row';
    const part = (cls, text) => {
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = text;
      return span;
    };
    row.append(part('earlier-name', item.name));
    if (item.realName !== item.name) row.append(part('earlier-value', 'is'), part('earlier-real', item.realName));
    if (item.value) {
      const value = item.value.length > 120 ? `${item.value.slice(0, 117)}…` : item.value;
      row.append(part('earlier-value', `= ${value}`));
    }
    row.append(part('earlier-kind', item.kind === 'renamed' ? 'renamed' : 'moved out'));
    list.append(row);
  }
}

async function save() {
  if (!fileBridge || !openFile || !lastResult) return;
  const others = othersToSave(lastOthers);
  if (lastResult.code === input.value && lastResult.added === 0 && others.length === 0) {
    showToast('Nothing to save — add some secrets first');
    return;
  }
  const result = await fileBridge.save({
    sourcePath: openFile.path,
    sourceText: lastResult.code,
    moduleName: moduleName(),
    secretsText: lastResult.moduleText,
    eol: openFile.eol,
    others
  });
  if (result.canceled) return;
  if (result.error) {
    showToast(`Couldn't save: ${result.error}`);
    return;
  }
  const changed = [...lastResult.results.values()].reduce((n, r) => n + r.hidden, 0);
  // The file on disk is now the safe version; carry on from there.
  input.value = lastResult.code;
  existingModule = lastResult.moduleText;
  rememberSaved(others);
  secrets = [];
  renderSecrets();
  update();
  showToast(`Saved — ${changed} ${changed === 1 ? 'change' : 'changes'}, secrets in ${moduleName()}.py`);
}

/** Undo the renames noted in the secrets file for this file, and save. */
async function putNamesBack() {
  if (!fileBridge || !openFile) return;
  const result = restoreNames(input.value, existingModule, { moduleName: moduleName(), fileName: fileName() });
  const stuck = result.renames.filter((r) => result.results.get(r.id).problems.length);
  // Files that import the renamed names go back too.
  const others = othersToSave(
    importersAfter(result.code, new Map(result.restored.map((r) => [r.to, r.from])), result.moduleText)
  );
  const saved = await fileBridge.save({
    sourcePath: openFile.path,
    sourceText: result.code,
    moduleName: moduleName(),
    secretsText: result.moduleText,
    eol: openFile.eol,
    restoring: true,
    others
  });
  if (saved.canceled) return;
  if (saved.error) {
    showToast(`Couldn't save: ${saved.error}`);
    return;
  }
  input.value = result.code;
  existingModule = result.moduleText;
  rememberSaved(others);
  update();
  showToast(
    stuck.length
      ? `Names put back, except ${stuck.map((r) => r.value).join(', ')} — that name is in use now`
      : 'Names put back'
  );
}

// ---------- auto-detect ----------

// Ordered patterns for things that commonly are, or hold, secrets. Each entry
// extracts the sensitive substring (usually capture group 1, else the match).
const DETECTORS = [
  // key = "value"  /  key: 'value'  (password, token, secret, api_key, …)
  {
    re: /(?:pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|auth|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*["']([^"'\n]{3,})["']/gi,
    group: 1
  },
  // Authorization: Bearer <token>
  { re: /Bearer\s+([A-Za-z0-9\-._~+/]{10,}=*)/g, group: 1 },
  // AWS access key id
  { re: /\b(AKIA[0-9A-Z]{16})\b/g, group: 1 },
  // Common provider key prefixes (OpenAI, GitHub, Slack, Stripe, Google, …)
  { re: /\b((?:sk|pk|rk)-[A-Za-z0-9]{8,})\b/g, group: 1 },
  { re: /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, group: 1 },
  { re: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g, group: 1 },
  { re: /\b(AIza[0-9A-Za-z\-_]{20,})\b/g, group: 1 },
  // JWT
  { re: /\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g, group: 1 },
  // URL carrying credentials:  scheme://user:pass@host
  { re: /[a-z]+:\/\/[^\s:/@]+:([^\s:/@]+)@/gi, group: 1 },
  // Email addresses
  { re: /\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, group: 1 },
  // IPv4 addresses (skip the everyday local ones)
  { re: /\b((?:\d{1,3}\.){3}\d{1,3})\b/g, group: 1 }
];

const DETECT_SKIP = new Set(['127.0.0.1', '0.0.0.0', '255.255.255.255', 'localhost']);

function autoDetect() {
  const text = input.value;
  if (!text.trim()) {
    showToast('Paste some code first');
    return;
  }

  const existing = new Set(secrets.map((s) => s.value));
  const found = new Set();

  for (const { re, group } of DETECTORS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const candidate = (group ? m[group] : m[0]).trim();
      if (!candidate || candidate.length < 3) continue;
      if (DETECT_SKIP.has(candidate)) continue;
      if (existing.has(candidate) || found.has(candidate)) continue;
      found.add(candidate);
    }
  }

  if (found.size === 0) {
    showToast('Nothing obvious found — add secrets by hand');
    return;
  }

  for (const value of found) addSecret(value);
  showToast(`Added ${found.size} detected ${found.size === 1 ? 'secret' : 'secrets'} — review them`);
}

// ---------- "hide selected text" shortcut ----------

function hideSelection() {
  const start = input.selectionStart;
  const end = input.selectionEnd;
  if (start === end) {
    showToast(`Select some text first, then press ${MOD_KEY}+E`);
    return;
  }
  const selected = input.value.slice(start, end).trim();
  if (!selected) return;
  if (secrets.some((s) => s.value.trim() === selected)) {
    showToast('That value is already a secret');
    return;
  }
  addSecret(selected);
  showToast('Selection added as a secret');
}

// ---------- preview tabs ----------

function showPreview(which) {
  for (const [name, box] of [
    ['file', output],
    ['module', moduleOutput],
    ['others', othersOutput]
  ]) {
    const active = name === which;
    box.classList.toggle('hidden', !active);
    el(`tab-${name}`).classList.toggle('active', active);
    el(`tab-${name}`).setAttribute('aria-selected', String(active));
  }
  showPaths();
}

// ---------- wiring ----------

function init() {
  input.addEventListener('input', update);

  el('add-secret-btn').addEventListener('click', () => addSecret());
  el('clear-secrets-btn').addEventListener('click', clearSecrets);
  el('detect-btn').addEventListener('click', autoDetect);
  el('open-btn').addEventListener('click', openFromDisk);
  el('save-btn').addEventListener('click', save);
  el('restore-names-btn').addEventListener('click', putNamesBack);

  el('clear-input-btn').addEventListener('click', () => {
    input.value = '';
    openFile = null;
    existingModule = '';
    projectRoot = null;
    folderFiles = [];
    showPaths();
    update();
  });

  el('copy-output-btn').addEventListener('click', () => {
    if (el('tab-module').classList.contains('active')) copyText(moduleOutput.value, 'Secrets file');
    else if (el('tab-others').classList.contains('active')) copyText(othersOutput.value, 'Other files');
    else copyText(output.value, 'Safe code');
  });

  el('tab-file').addEventListener('click', () => showPreview('file'));
  el('tab-module').addEventListener('click', () => showPreview('module'));
  el('tab-others').addEventListener('click', () => showPreview('others'));

  moduleNameInput.addEventListener('input', async () => {
    await loadModule();
    showPaths();
    update();
    if (openFile && isValidName(moduleName())) await fileBridge.remember(openFile.path, moduleName());
  });

  el('recent-select').addEventListener('change', (e) => {
    if (e.target.value) openRecent(e.target.value, 'Opened');
  });

  // Ctrl/Cmd+E on the input adds the current selection as a secret.
  input.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      hideSelection();
    }
  });

  if (!fileBridge) {
    el('open-btn').disabled = true;
    el('recent-select').disabled = true;
  }
  renderSecrets();
  showPaths();
  update();
  // Pick up where you left off: reopen the last file, fresh from disk.
  if (fileBridge) {
    refreshRecent().then(async () => {
      const [last] = await fileBridge.recent();
      if (last && !openFile && !input.value) await openRecent(last.path, `Reopened ${last.path.split(/[\\/]/).pop()}`);
    });
  }
}

init();
