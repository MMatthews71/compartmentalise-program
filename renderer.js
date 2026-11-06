'use strict';

/*
 * Compartmentalise — renderer logic.
 *
 * The data model is a list of secrets, each { id, value, placeholder }.
 * "Sanitise" swaps every value for its placeholder; "Restore" does the
 * reverse. The replace logic itself lives in core.js.
 *
 * Paste mode keeps secrets only in memory. Folder mode also saves them into
 * <project>/compartmentalise-secrets/secrets.json (via preload.js), so the
 * same terms are hidden the next time that folder is opened.
 */

const Core = window.Core;
const bridge = window.fsBridge; // undefined if the preload failed to load

const IS_MAC = navigator.platform.toUpperCase().includes('MAC');
const MOD_KEY = IS_MAC ? 'Cmd' : 'Ctrl';

/** @type {{id:number, value:string, placeholder:string}[]} */
let secrets = [];
let nextId = 1;
let nextPlaceholderNum = 1;
let engine = null; // Core engine for the current secret list, rebuilt lazily

let mode = 'sanitise';

/**
 * The open project folder:
 * { id, root, name, files:[{path, text|null, reason, size}], skippedDirs,
 *   truncated, secretsPath }
 */
let folder = null;
/** Per-file results for the current secrets: Map<path, {safePath, safeText, hits}> */
let folderResults = new Map();
/** Map<secretId, {hits, files}> across the whole folder. */
let folderSecretHits = new Map();
let folderTotal = 0;
let currentPath = null;
let viewSafe = false;

/** Last per-secret hit counts from the paste box. */
let pasteHits = new Map();

// ---------- element handles ----------
const el = (id) => document.getElementById(id);

const input = el('input');
const output = el('output');
const secretsList = el('secrets-list');
const replaceCount = el('replace-count');
const restoreInput = el('restore-input');
const restoreOutput = el('restore-output');
const restoreCount = el('restore-count');
const restoreEmptyNote = el('restore-empty-note');
const fileList = el('file-list');
const fileView = el('file-view');
const fileFilter = el('file-filter');
const hitsOnly = el('hits-only');

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

function plural(n, one, many = one + 's') {
  return `${n} ${n === 1 ? one : many}`;
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function getEngine() {
  if (!engine) engine = Core.makeEngine(secrets);
  return engine;
}

function activeSecrets() {
  return secrets.filter((s) => s.value.length > 0 && s.placeholder.length > 0);
}

// ---------- secrets model ----------

function freshPlaceholder() {
  const used = new Set(secrets.map((s) => s.placeholder));
  let ph;
  do {
    ph = `__SECRET_${nextPlaceholderNum++}__`;
  } while (used.has(ph));
  return ph;
}

function syncPlaceholderCounter() {
  let max = 0;
  for (const s of secrets) {
    const m = /^__SECRET_(\d+)__$/.exec(s.placeholder);
    if (m) max = Math.max(max, Number(m[1]));
  }
  nextPlaceholderNum = max + 1;
}

function addSecrets(values) {
  for (const value of values) {
    secrets.push({ id: nextId++, value, placeholder: freshPlaceholder() });
  }
  renderSecrets();
  secretsChanged();
}

/** Import terms from a secrets file the user already has. */
async function importSecretsFile() {
  if (!bridge) {
    showToast('File access is unavailable in this build');
    return;
  }
  let res;
  try {
    res = await bridge.importSecretsFile();
  } catch (_) {
    showToast('Could not read that file');
    return;
  }
  if (!res || res.canceled) return;
  if (res.error) {
    alert(res.error);
    return;
  }

  const { entries, skipped } = Core.parseSecretsFile(res.text);
  const usedPh = new Set(secrets.map((s) => s.placeholder));
  let added = 0;
  let already = 0;
  for (const e of entries) {
    if (secrets.some((s) => s.value === e.value)) {
      already += 1;
      continue;
    }
    let ph = e.placeholder;
    if (ph && usedPh.has(ph)) {
      const base = ph.replace(/__$/, '');
      let n = 2;
      while (usedPh.has(`${base}_${n}__`)) n += 1;
      ph = `${base}_${n}__`;
    }
    if (!ph) ph = freshPlaceholder();
    usedPh.add(ph);
    secrets.push({ id: nextId++, value: e.value, placeholder: ph });
    added += 1;
  }
  syncPlaceholderCounter();
  renderSecrets();
  secretsChanged();

  if (added === 0 && entries.length === 0) {
    alert(`No terms found in ${res.name}.`);
    return;
  }
  let msg = `Imported ${plural(added, 'term')} from ${res.name}`;
  if (already) msg += ` · ${already} already hidden`;
  if (skipped) msg += ` · ${skipped} skipped (numbers, true/false, very short or non-literal values)`;
  if (folder) {
    refreshFolderNow();
    msg += ` · ${plural(folderTotal, 'hit')} across the folder`;
  }
  showToast(msg);
}

function addSecret(value = '', placeholder = '') {
  secrets.push({ id: nextId++, value, placeholder: placeholder || freshPlaceholder() });
  renderSecrets();
  secretsChanged();
}

function removeSecret(id) {
  secrets = secrets.filter((s) => s.id !== id);
  renderSecrets();
  secretsChanged();
}

function clearSecrets() {
  if (secrets.length === 0) return;
  if (folder && !confirm(`Remove every hidden term from "${folder.name}"? Its saved secrets file will be emptied too.`)) {
    return;
  }
  secrets = [];
  nextPlaceholderNum = 1;
  renderSecrets();
  secretsChanged();
  showToast('Secrets cleared');
}

/** Call after any change to the secret list. */
function secretsChanged({ save = true } = {}) {
  engine = null;
  sanitise();
  if (mode === 'restore') restore();
  if (folder) {
    scheduleFolderRefresh();
    if (save) scheduleSave();
  }
}

// ---------- saving (folder mode only) ----------

const scheduleSave = debounce(async () => {
  if (!folder || !bridge) return;
  try {
    const res = await bridge.saveSecrets(
      folder.id,
      secrets.filter((s) => s.value && s.placeholder).map((s) => ({ value: s.value, placeholder: s.placeholder }))
    );
    if (!res || !res.ok) showToast('Could not save the secrets file');
  } catch (_) {
    showToast('Could not save the secrets file');
  }
}, 400);

// ---------- rendering the secrets table ----------

function renderSecrets() {
  secretsList.innerHTML = '';

  for (const secret of secrets) {
    const row = document.createElement('div');
    row.className = 'secret-row';
    row.dataset.id = String(secret.id);

    const valueInput = document.createElement('input');
    valueInput.type = 'text';
    valueInput.value = secret.value;
    valueInput.spellcheck = false;
    valueInput.addEventListener('input', () => {
      secret.value = valueInput.value;
      secretsChanged();
    });

    const phInput = document.createElement('input');
    phInput.type = 'text';
    phInput.className = 'ph-input';
    phInput.value = secret.placeholder;
    phInput.spellcheck = false;
    const flagPlaceholder = () => {
      const bad = phInput.value !== '' && !Core.IDENT_SAFE.test(phInput.value);
      phInput.classList.toggle('bad', bad);
      phInput.title = bad
        ? 'Tip: use only letters, digits and _ so code that uses this term keeps working'
        : '';
    };
    flagPlaceholder();
    phInput.addEventListener('input', () => {
      secret.placeholder = phInput.value;
      flagPlaceholder();
      secretsChanged();
    });

    const hits = document.createElement('span');
    hits.className = 'hit-badge';

    const del = document.createElement('button');
    del.className = 'del-btn';
    del.title = 'Remove this secret';
    del.textContent = '×';
    del.addEventListener('click', () => removeSecret(secret.id));

    row.append(valueInput, phInput, hits, del);
    secretsList.append(row);
  }
  updateHitBadges();
}

/** Write the per-row hit counts for whichever mode is showing. */
function updateHitBadges() {
  const inFolder = mode === 'folder' && folder;
  for (const row of secretsList.children) {
    const id = Number(row.dataset.id);
    const badge = row.querySelector('.hit-badge');
    if (!badge) continue;
    let n;
    if (inFolder) {
      const h = folderSecretHits.get(id) || { hits: 0, files: 0 };
      n = h.hits;
      badge.title = `${plural(h.hits, 'hit')} in ${plural(h.files, 'file')}`;
    } else {
      n = pasteHits.get(id) || 0;
      badge.title = '';
    }
    badge.textContent = String(n);
    badge.classList.toggle('zero', n === 0);
    badge.classList.toggle('live', n > 0);
  }
}

function updatePrivacyNote() {
  const note = el('privacy-note');
  if (folder) {
    note.textContent =
      `🔒 Saved only to ${folder.secretsPath} — git-ignored and never included in a safe copy. Nothing is sent anywhere.`;
  } else {
    note.textContent =
      "🔒 Secrets live only in this window's memory. Nothing is written to disk or sent anywhere. Closing the app forgets them.";
  }
}

// ---------- paste mode ----------

function sanitise() {
  const { text, hits, total } = getEngine().text(input.value, 'sanitise');
  output.value = text;
  pasteHits = hits;
  updateHitBadges();

  if (activeSecrets().length === 0) {
    replaceCount.textContent = '';
  } else if (total === 0) {
    replaceCount.textContent = 'no matches found';
    replaceCount.style.color = 'var(--text-faint)';
  } else {
    replaceCount.textContent = `${plural(total, 'secret')} hidden`;
    replaceCount.style.color = 'var(--good)';
  }

  warnDuplicatePlaceholders();
}

function restore() {
  const { text, total } = getEngine().text(restoreInput.value, 'restore');
  restoreOutput.value = text;

  if (secrets.length === 0) {
    restoreCount.textContent = '';
    restoreEmptyNote.textContent =
      '⚠ No secrets are defined yet. Add them in Sanitise or Folder mode first so there is something to restore.';
  } else if (!restoreInput.value) {
    restoreCount.textContent = '';
    restoreEmptyNote.textContent = '';
  } else if (total === 0) {
    restoreCount.textContent = 'no placeholders found';
    restoreCount.style.color = 'var(--text-faint)';
    restoreEmptyNote.textContent = '';
  } else {
    restoreCount.textContent = `${plural(total, 'placeholder')} restored`;
    restoreCount.style.color = 'var(--good)';
    restoreEmptyNote.textContent = '';
  }
}

function duplicatePlaceholder() {
  const seen = new Set();
  for (const s of secrets) {
    if (!s.placeholder) continue;
    if (seen.has(s.placeholder)) return s.placeholder;
    seen.add(s.placeholder);
  }
  return null;
}

/** Two secrets sharing one placeholder makes restore ambiguous — flag it. */
function warnDuplicatePlaceholders() {
  const dupe = duplicatePlaceholder();
  if (dupe) {
    replaceCount.textContent = `⚠ "${dupe}" is used twice — restore will be ambiguous`;
    replaceCount.style.color = 'var(--danger)';
  }
}

// ---------- auto-detect ----------

// Ordered patterns for things that commonly are, or hold, secrets. Each entry
// extracts the sensitive substring (usually capture group 1, else the match).
const DETECTORS = [
  // key = "value"  /  key: 'value'  /  "key": "value"  (password, token, …)
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

/** Find new candidate secrets across one or more texts. */
function detectIn(texts) {
  const existing = new Set(secrets.map((s) => s.value));
  const found = new Set();
  for (const text of texts) {
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
  }
  return found;
}

function reportDetected(found) {
  if (found.size === 0) {
    showToast('Nothing obvious found — add secrets by hand');
    return;
  }
  addSecrets(found);
  showToast(`Added ${found.size} detected ${found.size === 1 ? 'secret' : 'secrets'} — review them`);
}

function autoDetect() {
  if (!input.value.trim()) {
    showToast('Paste some code first');
    return;
  }
  reportDetected(detectIn([input.value]));
}

function folderAutoDetect() {
  if (!folder) return;
  reportDetected(detectIn(folder.files.filter((f) => f.text != null).map((f) => f.text)));
}

// ---------- "hide selected text" ----------

function hideSelection(textarea, sourceText) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  if (start === end) {
    showToast(`Select some text first, then press ${MOD_KEY}+E`);
    return;
  }
  let selected = textarea.value.slice(start, end).trim();
  if (!selected) return;
  // A textarea always reports line breaks as \n; match the file's own style.
  if (sourceText && sourceText.includes('\r\n')) selected = selected.replace(/\r?\n/g, '\r\n');
  if (secrets.some((s) => s.value === selected)) {
    showToast('That value is already hidden');
    return;
  }
  addSecret(selected);
  if (mode === 'folder' && folder) {
    refreshFolderNow();
    const h = folderSecretHits.get(secrets[secrets.length - 1].id) || { hits: 0, files: 0 };
    showToast(`Hidden everywhere: ${plural(h.hits, 'hit')} in ${plural(h.files, 'file')}`);
  } else {
    showToast('Selection added as a secret');
  }
}

// ---------- folder mode ----------

function computeFolder() {
  folderResults = new Map();
  folderSecretHits = new Map();
  folderTotal = 0;
  if (!folder) return;
  const eng = getEngine();
  for (const f of folder.files) {
    const safePath = eng.path(f.path, 'sanitise');
    let safeText = null;
    let hits = new Map();
    let total = 0;
    if (f.text != null) {
      const r = eng.file(f.path, f.text, 'sanitise');
      safeText = r.text;
      hits = r.hits;
      total = r.total;
    }
    // Count terms that appear in the file's name too.
    const pathHits = eng.text(f.path, 'sanitise').hits;
    for (const [id, n] of pathHits) hits.set(id, (hits.get(id) || 0) + n);
    for (const [id, n] of hits) {
      const agg = folderSecretHits.get(id) || { hits: 0, files: 0 };
      agg.hits += n;
      agg.files += 1;
      folderSecretHits.set(id, agg);
      folderTotal += n;
    }
    let fileTotal = total;
    for (const n of pathHits.values()) fileTotal += n;
    folderResults.set(f.path, { safePath, safeText, total: fileTotal });
  }
}

function refreshFolderNow() {
  computeFolder();
  renderFolderBar();
  renderFileList();
  renderViewer();
  updateHitBadges();
}

const scheduleFolderRefresh = debounce(refreshFolderNow, 120);

function renderFolderBar() {
  const has = !!folder;
  el('folder-detect-btn').disabled = !has;
  el('export-folder-btn').disabled = !has;
  el('restore-folder-btn').disabled = !has;
  if (!has) return;

  el('folder-name').textContent = folder.name;
  el('folder-name').title = folder.root;
  const scanned = folder.files.filter((f) => f.text != null).length;
  const withHits = [...folderResults.values()].filter((r) => r.total > 0).length;
  let stats = `${plural(scanned, 'text file')} scanned`;
  if (activeSecrets().length) stats += ` · ${plural(folderTotal, 'hit')} in ${plural(withHits, 'file')}`;
  el('folder-stats').textContent = stats;

  const notes = [];
  const unscanned = folder.files.length - scanned;
  if (unscanned) {
    notes.push(`${plural(unscanned, 'file')} (images, binaries, very large files) can't be scanned and will be copied unchanged.`);
  }
  if (folder.skippedDirs.length) {
    notes.push(`Left out entirely: ${folder.skippedDirs.join(', ')}.`);
  }
  if (folder.truncated) notes.push('This folder is very large — only the first 20,000 files were loaded.');
  const note = el('folder-note');
  note.textContent = notes.join(' ');
  note.classList.toggle('hidden', notes.length === 0);
}

function renderFileList() {
  fileList.innerHTML = '';
  if (!folder) return;
  const q = fileFilter.value.trim().toLowerCase();
  const only = hitsOnly.checked;
  const LIMIT = 3000;
  let shown = 0;
  let matching = 0;

  const frag = document.createDocumentFragment();
  for (const f of folder.files) {
    const r = folderResults.get(f.path) || { total: 0 };
    if (q && !f.path.toLowerCase().includes(q)) continue;
    if (only && r.total === 0) continue;
    matching += 1;
    if (shown >= LIMIT) continue;
    shown += 1;

    const item = document.createElement('button');
    item.className = 'file-item';
    if (f.path === currentPath) item.classList.add('active');
    if (f.text == null) item.classList.add('unscanned');
    item.title = f.text == null ? `${f.path} — ${f.reason}, copied unchanged` : f.path;

    const name = document.createElement('span');
    name.className = 'fname';
    name.textContent = f.path;
    item.append(name);

    if (r.total > 0) {
      const badge = document.createElement('span');
      badge.className = 'fhits';
      badge.textContent = String(r.total);
      item.append(badge);
    } else if (f.text == null) {
      const tag = document.createElement('span');
      tag.className = 'ftag';
      tag.textContent = f.reason;
      item.append(tag);
    }

    item.addEventListener('click', () => {
      currentPath = f.path;
      renderFileList();
      renderViewer({ resetScroll: true });
    });
    frag.append(item);
  }
  fileList.append(frag);

  if (matching === 0) {
    const empty = document.createElement('div');
    empty.className = 'file-empty';
    empty.textContent = only ? 'No files contain a hidden term yet.' : 'No files match.';
    fileList.append(empty);
  } else if (matching > shown) {
    const more = document.createElement('div');
    more.className = 'file-empty';
    more.textContent = `…and ${matching - shown} more. Type in the filter to narrow the list.`;
    fileList.append(more);
  }
}

function renderViewer({ resetScroll = false } = {}) {
  const f = folder && folder.files.find((x) => x.path === currentPath);
  el('view-original').classList.toggle('active', !viewSafe);
  el('view-safe').classList.toggle('active', viewSafe);
  const count = el('viewer-count');

  if (!f) {
    el('viewer-title').textContent = folder ? 'Select a file' : 'No folder open';
    el('viewer-title').title = '';
    fileView.value = '';
    count.textContent = '';
    return;
  }

  const r = folderResults.get(f.path) || { safePath: f.path, safeText: f.text, total: 0 };
  const shownPath = viewSafe ? r.safePath : f.path;
  el('viewer-title').textContent = shownPath;
  el('viewer-title').title = shownPath;

  const top = fileView.scrollTop;
  const left = fileView.scrollLeft;
  if (f.text == null) {
    fileView.value = `(${f.reason} — this file is copied into the safe copy unchanged)`;
  } else {
    fileView.value = viewSafe ? r.safeText : f.text;
  }
  fileView.scrollTop = resetScroll ? 0 : top;
  fileView.scrollLeft = resetScroll ? 0 : left;

  if (r.total > 0) {
    count.textContent = `${plural(r.total, 'hit')} hidden`;
    count.style.color = 'var(--good)';
  } else {
    count.textContent = activeSecrets().length ? 'no hits' : '';
    count.style.color = 'var(--text-faint)';
  }
}

function mergeSecrets(list) {
  for (const s of list) {
    if (!s.value) continue;
    if (secrets.some((x) => x.value === s.value)) continue;
    secrets.push({ id: nextId++, value: s.value, placeholder: s.placeholder });
  }
  syncPlaceholderCounter();
}

async function openFolder() {
  if (!bridge) {
    showToast('Folder access is unavailable in this build');
    return;
  }
  let res;
  try {
    res = await bridge.openProject();
  } catch (_) {
    showToast('Could not open that folder');
    return;
  }
  if (!res || res.canceled) return;

  const hadFolder = !!folder;
  const before = JSON.stringify(secrets.map((s) => [s.value, s.placeholder]));
  // Switching projects starts from that project's own saved secrets; the
  // first folder opened also keeps anything already typed into Paste mode.
  if (hadFolder) {
    secrets = [];
    nextPlaceholderNum = 1;
  }
  const stored = res.secrets || [];
  mergeSecrets(stored);
  const storedJson = JSON.stringify(stored.map((s) => [s.value, s.placeholder]));
  const nowJson = JSON.stringify(secrets.map((s) => [s.value, s.placeholder]));

  folder = res;
  computeFolder();
  const firstHit = folder.files.find((f) => (folderResults.get(f.path) || {}).total > 0);
  const firstText = folder.files.find((f) => f.text != null);
  currentPath = (firstHit || firstText || folder.files[0] || {}).path || null;
  viewSafe = false;

  renderSecrets();
  updatePrivacyNote();
  secretsChanged({ save: nowJson !== storedJson });
  refreshFolderNow();

  if (stored.length) {
    showToast(`Opened ${folder.name} — loaded ${plural(stored.length, 'saved secret')}`);
  } else {
    showToast(`Opened ${folder.name}${before !== '[]' && !hadFolder ? ' — your current secrets will be saved to it' : ''}`);
  }
}

/** Check a planned output for things that would make it not work the same. */
function checkPlan(plan, { checkJson, checkPlaceholderInSource }) {
  const problems = [];
  const warnings = [];
  const seen = new Map();
  for (const item of plan) {
    if (item.to !== item.from) {
      const bad = Core.badPathReason(item.to);
      if (bad) problems.push(`${item.from} → ${item.to}: the new name ${bad}`);
    }
    const key = item.to.toLowerCase();
    if (seen.has(key)) problems.push(`${seen.get(key)} and ${item.from} would both become ${item.to}`);
    else seen.set(key, item.from);

    if (checkJson && item.content != null && Core.isJsonPath(item.from)) {
      if (Core.parsesAsJson(item.source) && !Core.parsesAsJson(item.content)) {
        warnings.push(`${item.to} would no longer be valid JSON (a hidden term probably sits outside quotes, e.g. a number).`);
      }
    }
    if (checkPlaceholderInSource && item.source != null) {
      for (const s of activeSecrets()) {
        if (item.source.includes(s.placeholder)) {
          warnings.push(`${item.from} already contains the text "${s.placeholder}" — restoring later would turn it into the real value.`);
        }
      }
    }
  }
  const dupe = duplicatePlaceholder();
  if (dupe) problems.push(`"${dupe}" is used as the placeholder for two different secrets.`);
  return { problems, warnings };
}

function listForDialog(lines, max = 8) {
  const shown = lines.slice(0, max).map((l) => `• ${l}`);
  if (lines.length > max) shown.push(`• …and ${lines.length - max} more`);
  return shown.join('\n');
}

async function exportFolder() {
  if (!folder) return;
  if (activeSecrets().length === 0) {
    showToast('Hide at least one term first');
    return;
  }
  computeFolder();
  const plan = [];
  let changed = 0;
  let unscanned = 0;
  for (const f of folder.files) {
    const r = folderResults.get(f.path);
    const item = { from: f.path, to: r.safePath, source: f.text };
    if (f.text == null) unscanned += 1;
    else if (r.safeText !== f.text) {
      item.content = r.safeText;
      changed += 1;
    }
    plan.push(item);
  }

  const { problems, warnings } = checkPlan(plan, { checkJson: true, checkPlaceholderInSource: true });
  if (problems.length) {
    alert(`Can't export yet:\n\n${listForDialog(problems)}`);
    return;
  }

  // Placeholders that aren't plain names can break code where the term is a
  // variable, key or import rather than text inside quotes.
  for (const s of activeSecrets()) {
    if ((folderSecretHits.get(s.id) || {}).hits && !Core.IDENT_SAFE.test(s.placeholder)) {
      warnings.push(`Placeholder "${s.placeholder}" isn't a plain name (letters, digits, _). If it replaces code rather than text in quotes, that code may break.`);
    }
  }

  let msg =
    `Write a safe copy of "${folder.name}"?\n\n` +
    `• ${plural(folderTotal, 'hit')} replaced across ${plural(changed, 'file')}\n` +
    `• ${plural(plan.length - changed, 'other file')} copied unchanged` +
    (unscanned ? ` (${unscanned} of them couldn't be scanned — check they hold nothing secret)` : '') +
    `\n• The compartmentalise-secrets folder is NOT included`;
  if (warnings.length) msg += `\n\nHeads up:\n${listForDialog(warnings)}`;
  msg += '\n\nYour original files are not changed.';
  if (!confirm(msg)) return;

  const res = await bridge.writeFolder({
    sourceId: folder.id,
    mode: 'new',
    title: 'Save the safe copy as…',
    suggestedName: `${folder.name}-safe`,
    files: plan.map(({ from, to, content }) => ({ from, to, content }))
  });
  reportWrite(res, 'Safe copy');
}

async function restoreFolder() {
  if (activeSecrets().length === 0) {
    showToast('No secrets to restore — open the original project first');
    return;
  }
  const src = await bridge.openOther('Open the folder the AI edited (your safe copy)');
  if (!src || src.canceled) return;
  if (folder && src.root === folder.root) {
    alert("That's the original project. Pick the safe copy (or the AI's edited version of it) instead.");
    return;
  }

  const eng = getEngine();
  const plan = [];
  let total = 0;
  let changed = 0;
  for (const f of src.files) {
    const to = eng.path(f.path, 'restore');
    const item = { from: f.path, to, source: f.text };
    total += eng.text(f.path, 'restore').total;
    if (f.text != null) {
      const r = eng.file(f.path, f.text, 'restore');
      if (r.total > 0) {
        item.content = r.text;
        total += r.total;
        changed += 1;
      }
    }
    plan.push(item);
  }

  const { problems } = checkPlan(plan, { checkJson: false, checkPlaceholderInSource: false });
  if (problems.length) {
    alert(`Can't restore:\n\n${listForDialog(problems)}`);
    return;
  }

  const ok = confirm(
    `Found ${plural(total, 'placeholder')} in "${src.name}" (${plural(changed, 'file')} to fix, ${plural(plan.length, 'file')} in total).\n\n` +
      'Next, choose where to write the restored project.\n\n' +
      'Tip: choose your original project folder to apply the AI\'s changes straight onto it — files with the same name are overwritten, nothing is deleted.'
  );
  if (!ok) return;

  const res = await bridge.writeFolder({
    sourceId: src.id,
    mode: 'existing',
    title: 'Choose where to write the restored project',
    files: plan.map(({ from, to, content }) => ({ from, to, content }))
  });
  reportWrite(res, 'Restored project');
}

function reportWrite(res, label) {
  if (!res || res.canceled) return;
  if (res.error) {
    alert(res.error);
    return;
  }
  const n = res.written + res.copied;
  let msg = `${label} written: ${plural(n, 'file')} → ${res.dest}`;
  if (res.failed && res.failed.length) {
    msg += `\n\n${plural(res.failed.length, 'file')} could not be written:\n${listForDialog(res.failed)}`;
    alert(msg);
  }
  showToast(`${label} written (${plural(n, 'file')})`);
  const note = el('folder-note');
  note.textContent = `✓ ${label} written to ${res.dest}`;
  note.classList.remove('hidden');
}

// ---------- mode switching ----------

function switchMode(next) {
  mode = next;
  for (const m of ['sanitise', 'folder', 'restore']) {
    const on = m === next;
    el(`view-${m}`).classList.toggle('hidden', !on);
    el(`tab-${m}`).classList.toggle('active', on);
    el(`tab-${m}`).setAttribute('aria-selected', String(on));
  }
  el('secrets-panel').classList.toggle('hidden', next === 'restore');
  el('secrets-title').textContent =
    next === 'folder' ? 'Hidden terms — replaced in every file' : '2 · Secrets to hide';
  if (next === 'restore') restore();
  if (next === 'folder' && folder) refreshFolderNow();
  updateHitBadges();
}

// ---------- wiring ----------

function onModE(handler) {
  return (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      handler();
    }
  };
}

function hideFromViewer() {
  if (!folder) return;
  if (viewSafe) {
    showToast('Switch to Original to pick text to hide');
    return;
  }
  const f = folder.files.find((x) => x.path === currentPath);
  if (!f || f.text == null) {
    showToast('Pick a text file first');
    return;
  }
  hideSelection(fileView, f.text);
}

function init() {
  input.addEventListener('input', sanitise);
  restoreInput.addEventListener('input', restore);

  el('add-secret-btn').addEventListener('click', () => addSecret());
  el('import-secrets-btn').addEventListener('click', importSecretsFile);
  el('clear-secrets-btn').addEventListener('click', clearSecrets);
  el('detect-btn').addEventListener('click', autoDetect);

  el('clear-input-btn').addEventListener('click', () => {
    input.value = '';
    sanitise();
  });
  el('clear-restore-btn').addEventListener('click', () => {
    restoreInput.value = '';
    restore();
  });

  el('copy-output-btn').addEventListener('click', () => copyText(output.value, 'Sanitised code'));
  el('copy-restore-btn').addEventListener('click', () => copyText(restoreOutput.value, 'Restored code'));

  el('tab-sanitise').addEventListener('click', () => switchMode('sanitise'));
  el('tab-folder').addEventListener('click', () => switchMode('folder'));
  el('tab-restore').addEventListener('click', () => switchMode('restore'));

  // Folder mode
  el('open-folder-btn').addEventListener('click', openFolder);
  el('folder-detect-btn').addEventListener('click', folderAutoDetect);
  el('export-folder-btn').addEventListener('click', exportFolder);
  el('restore-folder-btn').addEventListener('click', restoreFolder);
  el('hide-selection-btn').addEventListener('click', hideFromViewer);
  el('view-original').addEventListener('click', () => {
    viewSafe = false;
    renderViewer();
  });
  el('view-safe').addEventListener('click', () => {
    viewSafe = true;
    renderViewer();
  });
  fileFilter.addEventListener('input', renderFileList);
  hitsOnly.addEventListener('change', renderFileList);

  // Ctrl/Cmd+E adds the current selection as a secret.
  input.addEventListener('keydown', onModE(() => hideSelection(input, input.value)));
  fileView.addEventListener('keydown', onModE(hideFromViewer));

  fileView.placeholder = 'Open a folder, pick a file, select a term and press ' + MOD_KEY + '+E to hide it everywhere.';

  renderSecrets();
  updatePrivacyNote();
  renderFolderBar();
  renderViewer();
  sanitise();
}

init();
