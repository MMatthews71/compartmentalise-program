'use strict';

/*
 * Compartmentalise — renderer logic.
 *
 * Everything here is plain, offline string work. The data model is a list of
 * secrets, each { id, value, placeholder }. "Sanitise" swaps every value for
 * its placeholder; "Restore" does the reverse. Secrets are held only in this
 * array in memory — never persisted, never sent anywhere.
 */

const IS_MAC = navigator.platform.toUpperCase().includes('MAC');
const MOD_KEY = IS_MAC ? 'Cmd' : 'Ctrl';

/** @type {{id:number, value:string, placeholder:string}[]} */
let secrets = [];
let nextId = 1;
let nextPlaceholderNum = 1;

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

// ---------- helpers ----------

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** Regex source for matching a secret in code.
 *  - Whole word only: if it starts (or ends) with a letter, digit or
 *    underscore, the neighbouring character must not be one. So "abc" matches
 *    in "x = abc;" but not inside "abcd" or "xabc".
 *  - Whitespace-tolerant: leading/trailing whitespace is ignored and any run
 *    of spaces, tabs or newlines matches any other run, so a multi-line secret
 *    still matches when its indentation differs from the code's. */
function secretSource(find) {
  const core = find.trim();
  const before = WORD_CHAR.test(core[0]) ? '(?<![\\p{L}\\p{N}_])' : '';
  const after = WORD_CHAR.test(core[core.length - 1]) ? '(?![\\p{L}\\p{N}_])' : '';
  return before + core.split(/\s+/).map(escapeRegExp).join('\\s+') + after;
}

/** Replace every occurrence of `find` with `replace`, returning text + count.
 *  With `asSecret`, matching follows secretSource's rules above. */
function replaceAllCounted(text, find, replace, asSecret = false) {
  if (!(asSecret ? find.trim() : find)) return { text, count: 0 };
  const source = asSecret ? secretSource(find) : escapeRegExp(find);
  const re = new RegExp(source, 'gu');
  let count = 0;
  const result = text.replace(re, () => {
    count += 1;
    return replace;
  });
  return { text: result, count };
}

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
  }, 1600);
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

// ---------- secrets model ----------

function addSecret(value = '', placeholder = '') {
  const ph = placeholder || `__SECRET_${nextPlaceholderNum++}__`;
  // Newest first, so a freshly added row is always visible at the top.
  secrets.unshift({ id: nextId++, value, placeholder: ph });
  renderSecrets();
  secretsList.scrollTop = 0;
  if (!value) secretsList.querySelector('.value-input')?.focus();
  sanitise();
}

function removeSecret(id) {
  secrets = secrets.filter((s) => s.id !== id);
  renderSecrets();
  sanitise();
}

function clearSecrets() {
  if (secrets.length === 0) return;
  secrets = [];
  nextPlaceholderNum = 1;
  renderSecrets();
  sanitise();
  showToast('Secrets cleared');
}

/** Build the ordered list used for replacing: longest values first so that a
 *  secret that is a substring of another never clobbers it. */
function secretsByValueLength() {
  return [...secrets]
    .filter((s) => s.value.length > 0)
    .sort((a, b) => b.value.length - a.value.length);
}

function placeholdersByLength() {
  return [...secrets]
    .filter((s) => s.placeholder.length > 0 && s.value.length > 0)
    .sort((a, b) => b.placeholder.length - a.placeholder.length);
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
    valueInput.addEventListener('input', () => {
      secret.value = valueInput.value;
      fitToContent(valueInput);
      sanitise();
    });

    const phInput = document.createElement('input');
    phInput.type = 'text';
    phInput.className = 'ph-input';
    phInput.value = secret.placeholder;
    phInput.spellcheck = false;
    phInput.addEventListener('input', () => {
      secret.placeholder = phInput.value;
      sanitise();
    });

    const hits = document.createElement('span');
    hits.className = 'hit-badge';
    hits.dataset.hits = 'badge';

    const del = document.createElement('button');
    del.className = 'del-btn';
    del.title = 'Remove this secret';
    del.textContent = '×';
    del.addEventListener('click', () => removeSecret(secret.id));

    row.append(valueInput, phInput, hits, del);
    secretsList.append(row);
    fitToContent(valueInput);
  }
}

/** Grow a textarea to show all of its lines. */
function fitToContent(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight + 2}px`;
}

/** Write the per-row hit counts after a sanitise pass. */
function updateHitBadges(hitMap) {
  for (const row of secretsList.children) {
    const id = Number(row.dataset.id);
    const badge = row.querySelector('.hit-badge');
    if (!badge) continue;
    const n = hitMap.get(id) || 0;
    badge.textContent = String(n);
    badge.classList.toggle('zero', n === 0);
    badge.classList.toggle('live', n > 0);
  }
}

// ---------- the core passes ----------

function sanitise() {
  let text = input.value;
  const hitMap = new Map();
  let total = 0;

  for (const secret of secretsByValueLength()) {
    const { text: next, count } = replaceAllCounted(text, secret.value, secret.placeholder, true);
    text = next;
    hitMap.set(secret.id, count);
    total += count;
  }

  output.value = text;
  updateHitBadges(hitMap);

  if (secretsByValueLength().length === 0) {
    replaceCount.textContent = '';
  } else if (total === 0) {
    replaceCount.textContent = 'no matches found';
    replaceCount.style.color = 'var(--text-faint)';
  } else {
    const noun = total === 1 ? 'secret' : 'secrets';
    replaceCount.textContent = `${total} ${noun} hidden`;
    replaceCount.style.color = 'var(--good)';
  }

  warnDuplicatePlaceholders();
}

function restore() {
  let text = restoreInput.value;
  let total = 0;

  for (const secret of placeholdersByLength()) {
    const { text: next, count } = replaceAllCounted(text, secret.placeholder, secret.value);
    text = next;
    total += count;
  }

  restoreOutput.value = text;

  if (secrets.length === 0) {
    restoreCount.textContent = '';
    restoreEmptyNote.textContent =
      '⚠ No secrets are defined yet. Add them in Sanitise mode first so there is something to restore.';
  } else if (!restoreInput.value) {
    restoreCount.textContent = '';
    restoreEmptyNote.textContent = '';
  } else if (total === 0) {
    restoreCount.textContent = 'no placeholders found';
    restoreCount.style.color = 'var(--text-faint)';
    restoreEmptyNote.textContent = '';
  } else {
    const noun = total === 1 ? 'placeholder' : 'placeholders';
    restoreCount.textContent = `${total} ${noun} restored`;
    restoreCount.style.color = 'var(--good)';
    restoreEmptyNote.textContent = '';
  }
}

/** Two secrets sharing one placeholder makes restore ambiguous — flag it. */
function warnDuplicatePlaceholders() {
  const seen = new Map();
  let dupe = null;
  for (const s of secrets) {
    if (!s.placeholder) continue;
    if (seen.has(s.placeholder)) dupe = s.placeholder;
    seen.set(s.placeholder, true);
  }
  if (dupe) {
    replaceCount.textContent = `⚠ "${dupe}" is used twice — restore will be ambiguous`;
    replaceCount.style.color = 'var(--danger)';
  }
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
  if (secrets.some((s) => s.value === selected)) {
    showToast('That value is already a secret');
    return;
  }
  addSecret(selected);
  showToast('Selection added as a secret');
}

// ---------- mode switching ----------

function switchMode(mode) {
  const sanitiseActive = mode === 'sanitise';
  el('view-sanitise').classList.toggle('hidden', !sanitiseActive);
  el('view-restore').classList.toggle('hidden', sanitiseActive);
  el('tab-sanitise').classList.toggle('active', sanitiseActive);
  el('tab-restore').classList.toggle('active', !sanitiseActive);
  el('tab-sanitise').setAttribute('aria-selected', String(sanitiseActive));
  el('tab-restore').setAttribute('aria-selected', String(!sanitiseActive));
  if (!sanitiseActive) restore();
}

// ---------- wiring ----------

function init() {
  input.addEventListener('input', sanitise);
  restoreInput.addEventListener('input', restore);

  el('add-secret-btn').addEventListener('click', () => addSecret());
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
  el('tab-restore').addEventListener('click', () => switchMode('restore'));

  // Ctrl/Cmd+E on the input adds the current selection as a secret.
  input.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      hideSelection();
    }
  });

  renderSecrets();
  sanitise();
}

init();
