'use strict';

// Checks the Python extraction. Where python3 is available, each case also
// runs the original file and the rewritten file + secrets module and checks
// every variable ends up with the same value.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { extract } = require('../pyextract.js');

let python = null;
for (const cmd of ['python3', 'python']) {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' });
    python = cmd;
    break;
  } catch {}
}

const secretsOf = (...pairs) => pairs.map(([value, name], i) => ({ id: i + 1, value, name: name || `SECRET_${i + 1}` }));

/** Run the original and rewritten code; return both sets of globals. */
function runBoth(src, out) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyextract-'));
  fs.writeFileSync(path.join(dir, 'original.py'), src);
  fs.writeFileSync(path.join(dir, 'rewritten.py'), out.code);
  fs.writeFileSync(path.join(dir, 'hidden_secrets.py'), out.moduleText);
  const script = `
import json, runpy, sys
sys.path.insert(0, ${JSON.stringify(dir)})
def values(p):
    g = runpy.run_path(p)
    return {k: repr(v) for k, v in g.items() if not k.startswith('__') and not callable(v) and not k.startswith('SECRET')}
print(json.dumps([values(${JSON.stringify(path.join(dir, 'original.py'))}), values(${JSON.stringify(path.join(dir, 'rewritten.py'))})]))
`;
  const [a, b] = JSON.parse(execFileSync(python, ['-c', script], { encoding: 'utf8' }));
  fs.rmSync(dir, { recursive: true, force: true });
  return [a, b];
}

function check(t, src, secrets, expectHidden, renamed = {}) {
  const out = extract(src, secrets);
  const hidden = [...out.results.values()].reduce((n, r) => n + r.hidden, 0);
  assert.strictEqual(hidden, expectHidden, JSON.stringify([...out.results.values()]));
  if (python) {
    const [before, after] = runBoth(src, out);
    // A renamed variable is compared under its new name; names imported
    // from the secrets module are extra, so compare the rest.
    for (const [from, to] of Object.entries(renamed)) after[from] = after[to];
    for (const k of Object.keys(after)) if (!(k in before)) delete after[k];
    assert.deepStrictEqual(after, before, `rewritten:\n${out.code}\n--- module:\n${out.moduleText}`);
  } else t.diagnostic('python not found — skipped running the code');
  return out;
}

test('whole top-level variable moves out and is imported', (t) => {
  const src = '"""Docstring."""\nimport os\n\nAPI_KEY = "sk-live-123"\nurl = "x" + API_KEY\n';
  const out = check(t, src, secretsOf(['API_KEY = "sk-live-123"', 'API_KEY']), 1);
  assert.match(out.code, /^"""Docstring."""\nfrom hidden_secrets import API_KEY\n/);
  assert.match(out.moduleText, /^API_KEY = "sk-live-123"$/m);
});

test('multi-line list variable with different indentation', (t) => {
  const src = 'cols = ["ts_hk", "active_USD", "active_live_source", "active_open",\n        "active_closed_reason", "active_rev_USD_t", "active_contract",\n        "jrev_USD_t", "mrev_USD_t", "srev_USD_t"]\nn = len(cols)\n';
  const secret = '["ts_hk", "active_USD", "active_live_source", "active_open",\n                  "active_closed_reason", "active_rev_USD_t", "active_contract",\n                  "jrev_USD_t", "mrev_USD_t", "srev_USD_t"]';
  const out = check(t, src, secretsOf([secret, 'COLS']), 1);
  assert.match(out.code, /^cols = COLS$/m);
});

test('part of a string becomes an f-string', (t) => {
  const src = 'a = "abcdef"\nb = "x {literal} abc"\nc = r"abc\\d"\nd = f"{a}-abc"\nabcd = 1\n';
  const out = check(t, src, secretsOf(['abc']), 4);
  assert.strictEqual(out.added, 1, 'one definition shared by all four');
  assert.match(out.code, /^a = f"\{SECRET_1\}def"$/m);
  assert.match(out.code, /^b = f"x \{\{literal\}\} \{SECRET_1\}"$/m);
  assert.match(out.code, /^abcd = 1$/m, 'names in code are untouched');
});

test('whole string literal becomes the name', (t) => {
  const src = 'def connect(h, port):\n    return h\n\nhost = "db.internal"\nconnect("db.internal", port=5)\n';
  const out = check(t, src, secretsOf(['db.internal', 'DB_HOST']), 2);
  assert.match(out.code, /^host = DB_HOST$/m);
  assert.match(out.code, /connect\(DB_HOST, port=5\)/);
});

test('bytes are joined with +', (t) => {
  const src = 'k = b"key-abc-xyz"\n';
  const out = check(t, src, secretsOf(['abc']), 1);
  assert.match(out.code, /^k = \(b"key-" \+ SECRET_1 \+ b"-xyz"\)$/m);
});

test('comments get the name, no import needed', (t) => {
  const src = '# password is hunter2\nx = 1\n';
  const out = check(t, src, secretsOf(['hunter2']), 1);
  assert.match(out.code, /# password is SECRET_1/);
  assert.doesNotMatch(out.code, /import/);
});

test('numbers and None', (t) => {
  const src = 'port = 5432\nother = 15432\nf = 1.5432\n';
  check(t, src, secretsOf(['5432']), 1);
});

test('signed numbers only when they are a value', (t) => {
  const src = 'a = -5\nb = a + 1\nc = -5 ** 2\nd = [-5, 1]\n';
  const out = check(t, src, secretsOf(['-5'], ['+ 1']), 2);
  assert.match(out.code, /^b = a \+ 1$/m);
  assert.match(out.code, /^c = -5 \*\* 2$/m);
});

test('unsafe spots are left alone and reported', (t) => {
  const src = 'def f():\n    TOKEN = "abc"\n    return TOKEN\ndef g(abc):\n    return abc\nd = {"k": 1}\nd["k"]\ny = "\\nabc"\n';
  const out = check(t, src, secretsOf(['TOKEN = "abc"'], ['abc'], ['["k"]']), 2);
  const reasons = [...out.results.values()].flatMap((r) => r.problems.map((p) => p.reason));
  assert.ok(reasons.some((r) => /indented/.test(r)), reasons.join('; '));
  assert.ok(reasons.some((r) => /call or index/.test(r)), reasons.join('; '));
});

test('existing secrets module and import are merged, not duplicated', (t) => {
  const src = 'from hidden_secrets import OLD\nx = OLD + "abc"\n';
  const existing = '# mine\nOLD = "o"\nKEY = "k"\n';
  const out = extract(src, secretsOf(['abc', 'KEY']), { existingModule: existing });
  // KEY already holds a different value, so the new one gets KEY_2.
  assert.match(out.code, /^from hidden_secrets import OLD, KEY_2$/m);
  assert.match(out.moduleText, /^# mine\nOLD = "o"\nKEY = "k"\n\nKEY_2 = "abc"\n$/);
});

test('a name already used in the file is refused', () => {
  const out = extract('x = 1\ny = "abc"\n', secretsOf(['abc', 'x']));
  assert.strictEqual(out.results.get(1).hidden, 0);
  assert.match(out.results.get(1).problems[0].reason, /already used/);
  assert.strictEqual(out.code, 'x = 1\ny = "abc"\n');
});

test('same value reuses an existing name', () => {
  const out = extract('x = "abc"\n', secretsOf(['abc', 'S']), { existingModule: 'S = "abc"\n' });
  assert.strictEqual(out.added, 0);
  assert.match(out.code, /^from hidden_secrets import S\n\nx = S\n$/);
});

test('implicitly joined strings stay valid', (t) => {
  const src = 'x = ("abc" "def")\n';
  const out = check(t, src, secretsOf(['abc']), 1);
  assert.match(out.code, /f"\{SECRET_1\}" "def"/);
});

test('secrets inside f-string {expressions}', (t) => {
  const src = [
    'd = {"active_USD": 1, "abcdef": 2}',
    'a = f"{d[\'active_USD\']} total"',
    'b = f"{d[\'abcdef\']:>5}|{5432 + 1}"',
    "c = f'{\"abc\" * 2}-abc'",
    "e = f\"{d['active_USD']=}\"",
    ''
  ].join('\n');
  const out = check(t, src, secretsOf(['active_USD', 'COL'], ['abc'], ['5432', 'PORT']), 7);
  assert.match(out.code, /^a = f"\{d\[COL\]\} total"$/m);
  assert.match(out.code, /^b = f"\{d\[f'\{SECRET_2\}def'\]:>5\}\|\{PORT \+ 1\}"$/m);
  assert.match(out.code, /^c = f'\{SECRET_2 \* 2\}-\{SECRET_2\}'$/m);
  assert.match(out.code, /^e = f"\{d\['active_USD'\]=\}"$/m, '{x=} prints its own code, so it stays');
});

test('f-string format specs and conversions are left alone', () => {
  const out = extract('x = 1\ny = f"{x!r:abc}"\n', secretsOf(['abc']));
  assert.strictEqual(out.results.get(1).hidden, 0);
  assert.match(out.results.get(1).problems[0].reason, /f-string/);
});

test('a variable name on its own moves its whole definition', (t) => {
  const src = [
    'import math',
    'n = 12',
    'MONTH_CODES = {',
    '    1: "F", 2: "G", 3: "H",  # winter',
    '}',
    'LOOKUP = dict(zip(range(n), "FGHJKMNQUVXZ"))',
    'ROOT = math.sqrt(n)',
    'label = f"{MONTH_CODES[1]} of {len(MONTH_CODES)}"',
    ''
  ].join('\n');
  const out = check(t, src, secretsOf(['MONTH_CODES', 'MONTH_CODES'], ['LOOKUP', 'LOOKUP'], ['ROOT', 'ROOT']), 1);
  assert.match(out.code, /^from hidden_secrets import MONTH_CODES$/m);
  assert.match(out.code, /^label = f"\{MONTH_CODES\[1\]\} of \{len\(MONTH_CODES\)\}"$/m, 'uses stay as they are');
  assert.match(out.moduleText, /^MONTH_CODES = \{\n    1: "F", 2: "G", 3: "H",  # winter\n\}$/m);
  const reasons = [...out.results.values()].flatMap((r) => r.problems.map((p) => p.reason));
  assert.ok(reasons.some((r) => /LOOKUP uses n, which stays in your file/.test(r)), reasons.join('; '));
  assert.ok(reasons.some((r) => /ROOT uses n/.test(r)), reasons.join('; '));
});

test('dependencies move together, with the imports they need', (t) => {
  const src = 'import math\nfrom os import path as p\nn = 12\nLOOKUP = dict(zip(range(n), "FGHJKMNQUVXZ"))\nROOT = math.sqrt(n)\nSEP = p.sep\nboth = (LOOKUP, ROOT, SEP)\n';
  const out = check(t, src, secretsOf(['LOOKUP', 'LOOKUP'], ['ROOT', 'ROOT'], ['n', 'n'], ['SEP', 'SEP']), 4);
  assert.match(out.code, /^from hidden_secrets import n, LOOKUP, ROOT, SEP$/m);
  assert.match(out.moduleText, /\nn = 12\nLOOKUP = dict\(zip\(range\(n\), "FGHJKMNQUVXZ"\)\)\nimport math\nROOT = math.sqrt\(n\)\nfrom os import path as p\nSEP = p.sep\n$/);
});

test('variables set more than once, or earlier in a block, stay put', () => {
  const twice = extract('X = 1\nX = 2\n', secretsOf(['X', 'X']));
  assert.match(twice.results.get(1).problems[0].reason, /more than once/);
  const earlier = extract('if True:\n    X = 0\nX = 1\n', secretsOf(['X', 'X']));
  assert.match(earlier.results.get(1).problems[0].reason, /set earlier/);
});

test('a renamed variable never shows its real name', (t) => {
  const src = [
    'MONTH_CODES = {1: "F", 2: "G"}  # CME month codes',
    '',
    'def code_for(m):',
    '    # look m up in MONTH_CODES',
    '    return MONTH_CODES[m]',
    '',
    'label = f"{MONTH_CODES[1]} of {len(MONTH_CODES)}"',
    'title = "MONTH_CODES"',
    'first = code_for(2)',
    ''
  ].join('\n');
  const out = check(t, src, secretsOf(['MONTH_CODES', 'CODES']), 6, { MONTH_CODES: 'CODES' });
  assert.ok(!out.code.includes('MONTH_CODES'), out.code);
  assert.match(out.code, /^from hidden_secrets import CODES, CODES_NAME$/m);
  assert.match(out.code, /^label = f"\{CODES\[1\]\} of \{len\(CODES\)\}"$/m);
  assert.match(out.code, /# look m up in CODES/);
  assert.match(out.moduleText, /\nMONTH_CODES = \{1: "F", 2: "G"\}  # CME month codes\nCODES = MONTH_CODES\nCODES_NAME = "MONTH_CODES"\n$/);
});

test('renaming a variable moved by an earlier save', () => {
  const out = extract(
    'from hidden_secrets import MONTH_CODES\nx = MONTH_CODES[1]\n',
    secretsOf(['MONTH_CODES', 'CODES']),
    { existingModule: 'MONTH_CODES = {1: "F"}\n' }
  );
  assert.strictEqual(out.code, 'from hidden_secrets import CODES\nx = CODES[1]\n');
  assert.strictEqual(out.moduleText, 'MONTH_CODES = {1: "F"}\n\nCODES = MONTH_CODES\n');
});

test('names that must stay are reported, and {x=} blocks a rename', () => {
  const kept = extract('X = 1\nclass C:\n    X = 2\nc = C.X\nd = dict(X=3)\n', secretsOf(['X', 'Y']));
  const reasons = kept.results.get(1).problems.map((p) => p.reason).join('; ');
  assert.match(reasons, /attribute name here/);
  assert.match(reasons, /keyword argument here/);
  const debug = extract('X = 1\ny = f"{X=}"\n', secretsOf(['X', 'Y']));
  assert.strictEqual(debug.results.get(1).hidden, 0);
  assert.match(debug.results.get(1).problems[0].reason, /printed by an f-string/);
});
