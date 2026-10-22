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
const { extract, restoreNames, renamesFor, suggestName, variableName, isValidName } = window.PyExtract;
// Only there when running inside the desktop app.
const fileBridge = window.files || null;

/** @type {{id:number, value:string, name:string, mode:'move'|'rename'}[]} */
let secrets = [];
let nextId = 1;
/** The file opened from disk, if any: { path, eol }. */
let openFile = null;
/** Current contents of the secrets module next to that file ('' if none). */
let existingModule = '';
let lastResult = null;

// ---------- element handles ----------
const el = (id) => document.getElementById(id);

const input = el('input');
const output = el('output');
const moduleOutput = el('module-output');
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

/** The open file's name, as rename notes in the secrets file record it. */
function fileName() {
  return openFile ? openFile.path.split(/[\\/]/).pop() : 'this file';
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
    replaceCount.textContent = `${moved} hidden` + (visible ? ` · ${visible} left visible` : '');
    replaceCount.style.color = visible ? 'var(--danger)' : 'var(--good)';
  }

  el('save-btn').disabled = !fileBridge || !openFile || !nameOk;
  el('restore-names-btn').disabled =
    !fileBridge || !openFile || !nameOk || renamesFor(existingModule, fileName()).length === 0;
}

// ---------- files ----------

function showPaths() {
  const dir = openFile ? openFile.path.replace(/[\\/][^\\/]*$/, '') : '';
  const sep = openFile && openFile.path.includes('\\') ? '\\' : '/';
  // The path boxes trim long paths from the left (CSS direction: rtl); the
  // left-to-right marks keep slashes on the correct side.
  const ltr = (text) => (text ? `\u200e${text}\u200e` : '');
  el('file-path').textContent = openFile ? ltr(openFile.path) : fileBridge ? 'No file open — paste code or open one' : '';
  el('output-path').textContent = openFile
    ? ltr(el('tab-module').classList.contains('active') ? `${dir}${sep}${moduleName()}.py` : openFile.path)
    : '';
}

async function loadModule() {
  existingModule = openFile && isValidName(moduleName()) ? (await fileBridge.readSecrets(openFile.path, moduleName())) || '' : '';
}

async function openFromDisk() {
  if (!fileBridge) return;
  const opened = await fileBridge.open();
  if (!opened) return;
  openFile = { path: opened.path, eol: opened.eol };
  input.value = opened.text;
  await loadModule();
  showPaths();
  update();
  showToast(existingModule ? `Opened — found ${moduleName()}.py next to it` : 'Opened');
}

async function save() {
  if (!fileBridge || !openFile || !lastResult) return;
  if (lastResult.code === input.value && lastResult.added === 0) {
    showToast('Nothing to save — add some secrets first');
    return;
  }
  const result = await fileBridge.save({
    sourcePath: openFile.path,
    sourceText: lastResult.code,
    moduleName: moduleName(),
    secretsText: lastResult.moduleText,
    eol: openFile.eol
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
  const saved = await fileBridge.save({
    sourcePath: openFile.path,
    sourceText: result.code,
    moduleName: moduleName(),
    secretsText: result.moduleText,
    eol: openFile.eol,
    restoring: true
  });
  if (saved.canceled) return;
  if (saved.error) {
    showToast(`Couldn't save: ${saved.error}`);
    return;
  }
  input.value = result.code;
  existingModule = result.moduleText;
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
  const fileActive = which === 'file';
  output.classList.toggle('hidden', !fileActive);
  moduleOutput.classList.toggle('hidden', fileActive);
  el('tab-file').classList.toggle('active', fileActive);
  el('tab-module').classList.toggle('active', !fileActive);
  el('tab-file').setAttribute('aria-selected', String(fileActive));
  el('tab-module').setAttribute('aria-selected', String(!fileActive));
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
    showPaths();
    update();
  });

  el('copy-output-btn').addEventListener('click', () =>
    el('tab-module').classList.contains('active')
      ? copyText(moduleOutput.value, 'Secrets file')
      : copyText(output.value, 'Safe code')
  );

  el('tab-file').addEventListener('click', () => showPreview('file'));
  el('tab-module').addEventListener('click', () => showPreview('module'));

  moduleNameInput.addEventListener('input', async () => {
    await loadModule();
    showPaths();
    update();
  });

  // Ctrl/Cmd+E on the input adds the current selection as a secret.
  input.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      hideSelection();
    }
  });

  if (!fileBridge) el('open-btn').disabled = true;
  renderSecrets();
  showPaths();
  update();
}

init();
