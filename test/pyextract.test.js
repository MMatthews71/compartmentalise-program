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

function check(t, src, secrets, expectHidden) {
  const out = extract(src, secrets);
  const hidden = [...out.results.values()].reduce((n, r) => n + r.hidden, 0);
  assert.strictEqual(hidden, expectHidden, JSON.stringify([...out.results.values()]));
  if (python) {
    const [before, after] = runBoth(src, out);
    // Names imported from the secrets module are extra; compare the rest.
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

test('unsafe spots are left alone and reported', (t) => {
  const src = 'def f():\n    TOKEN = "abc"\n    return TOKEN\nabc = 2\nd = {"k": 1}\nd["k"]\ny = "\\nabc"\n';
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
