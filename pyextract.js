'use strict';

/*
 * Compartmentalise — Python extraction.
 *
 * Moves secrets out of Python source into a separate module and imports them
 * back, so the rewritten file still runs while hiding the real values:
 *
 *   API_KEY = "sk-live-123"      ->  (line removed)     + from hidden_secrets import API_KEY
 *   connect("db.internal")       ->  connect(SECRET_1)
 *   url = "https://db.internal/x" -> url = f"https://{SECRET_1}/x"
 *
 * Pure string work with a small Python lexer — no Node or DOM needed, so the
 * same file runs in the app window and under `node --test`.
 */

(function (root) {
  const WORD_CHAR = /[\p{L}\p{N}_]/u;
  const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const KEYWORDS = new Set(
    ('False None True and as assert async await break class continue def del elif else except ' +
      'finally for from global if import in is lambda nonlocal not or pass raise return try ' +
      'while with yield').split(' ')
  );
  // `NAME =` or `NAME: type =` at the start of a statement.
  const ASSIGN_RE = /^([A-Za-z_]\w*)[ \t]*(?::[^=\n]*)?=(?!=)[ \t]*/;
  const MODULE_HEADER =
    '# Secrets moved out of your code by Compartmentalise.\n' +
    "# Keep this file private: don't let AI tools read it and don't commit it.\n";

  function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function isValidName(name) {
    return NAME_RE.test(name) && !KEYWORDS.has(name);
  }

  // ---------- lexer ----------

  /** Find every string literal and comment, in source order. Everything
   *  between them is code. Strings record their prefix (r, b, f, u…), quote
   *  and where their content sits; f-strings also record their {fields} and
   *  the strings inside them (`children`). */
  function lex(src) {
    return lexCode(src, 0, false, false).tokens;
  }

  /** Lex code from `i`. Inside an f-string {field} (`inField`), stop where
   *  the expression ends: at the closing }, or at the ! or : that starts a
   *  conversion or format spec. */
  function lexCode(src, i, inField, oneLine) {
    const tokens = [];
    const n = src.length;
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (inField) {
        if (oneLine && c === '\n') break;
        if (depth === 0 && (c === '}' || c === ':' || (c === '!' && src[i + 1] !== '='))) break;
        if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) depth--;
      }
      if (c === '#' && !inField) {
        const nl = src.indexOf('\n', i);
        const end = nl === -1 ? n : nl;
        tokens.push({ type: 'comment', start: i, end, contentStart: i + 1, contentEnd: end });
        i = end;
        continue;
      }
      if (c === '"' || c === "'") {
        const t = lexString(src, i);
        tokens.push(t);
        i = t.end;
        continue;
      }
      i++;
    }
    return { tokens, end: i };
  }

  /** Lex the string literal whose opening quote is at `i`. */
  function lexString(src, i) {
    const n = src.length;
    const c = src[i];
    let p = i;
    while (p > 0 && i - p < 2 && /[rRbBuUfF]/.test(src[p - 1])) p--;
    if (p > 0 && WORD_CHAR.test(src[p - 1])) p = i; // letters belong to a name
    const prefix = src.slice(p, i);
    const quote = src.startsWith(c + c + c, i) ? c + c + c : c;
    const oneLine = quote.length === 1;
    const isF = /f/i.test(prefix);
    const raw = /r/i.test(prefix);
    const fields = []; // { open, start, end, close }: {, expression, }
    const children = [];
    let j = i + quote.length;
    let closed = false;
    while (j < n) {
      const ch = src[j];
      if (ch === '\\') {
        if (isF && !raw && src.startsWith('N{', j + 1)) {
          // \N{EM DASH}: the braces belong to the escape, not a field.
          const close = src.indexOf('}', j);
          j = close === -1 ? n : close + 1;
        } else {
          // A backslash never stops a brace starting an f-string field.
          j += isF && (src[j + 1] === '{' || src[j + 1] === '}') ? 1 : 2;
        }
        continue;
      }
      if (src.startsWith(quote, j)) {
        closed = true;
        break;
      }
      if (oneLine && ch === '\n') break;
      if (isF && ch === '{' && src[j + 1] === '{') {
        j += 2;
        continue;
      }
      if (isF && ch === '{') {
        const inner = lexCode(src, j + 1, true, oneLine);
        children.push(...inner.tokens);
        // f"{x=}": the = asks Python to print the expression; it isn't part of it.
        const debug = /(?<![=!<>])=\s*$/.exec(src.slice(j + 1, inner.end));
        const exprEnd = debug ? j + 1 + debug.index : inner.end;
        // Skip any !conversion or :format spec to the closing brace.
        let k = inner.end;
        let depth = 0;
        for (; k < n; k++) {
          const x = src[k];
          if (oneLine && x === '\n') break;
          if (x === '{') depth++;
          else if (x === '}' && depth-- === 0) break;
        }
        fields.push({ open: j, start: j + 1, end: exprEnd, close: Math.min(k + 1, n), debug: Boolean(debug) });
        j = src[k] === '}' ? k + 1 : k;
        continue;
      }
      j++;
    }
    const contentEnd = Math.min(j, n);
    return {
      type: 'string',
      start: p,
      end: closed ? j + quote.length : contentEnd,
      prefix,
      quote,
      contentStart: i + quote.length,
      contentEnd,
      closed,
      fields,
      children
    };
  }

  /** Index of the token containing `pos`, or -1. */
  function tokenIndexAt(tokens, pos) {
    let lo = 0;
    let hi = tokens.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (tokens[mid].end <= pos) lo = mid + 1;
      else if (tokens[mid].start > pos) hi = mid - 1;
      else return mid;
    }
    return -1;
  }

  /** What `pos` sits in: the innermost token list whose code holds it
   *  (descending into f-string {fields}), the index of the token containing
   *  it there (-1 if it's code), and the field, if any. */
  function locate(tokens, pos, field = null) {
    const k = tokenIndexAt(tokens, pos);
    const t = tokens[k];
    const f = t && t.fields ? t.fields.find((x) => x.start <= pos && pos < x.end) : null;
    return f ? locate(t.children, pos, f) : { tokens, k, field };
  }

  /** Walk [s, e) calling onCode(index) for code characters and
   *  onToken(token) for each string or comment inside it. */
  function walk(src, tokens, s, e, onCode, onToken) {
    let k = tokenIndexAt(tokens, s);
    if (k === -1) {
      k = tokens.findIndex((t) => t.start >= s);
      if (k === -1) k = tokens.length;
    }
    let i = s;
    while (i < e) {
      const t = tokens[k];
      if (t && t.start <= i) {
        onToken(t);
        i = t.end;
        k++;
        continue;
      }
      const stop = Math.min(e, t ? t.start : e);
      for (; i < stop; i++) onCode(i);
    }
  }

  /** Expression text with comments dropped and whitespace outside strings
   *  collapsed, so equal values compare equal however they're laid out. */
  function normaliseExpr(text) {
    const tokens = lex(text);
    let out = '';
    walk(
      text,
      tokens,
      0,
      text.length,
      (i) => {
        out += text[i];
      },
      (t) => {
        out += t.type === 'string' ? text.slice(t.start, t.end) : ' ';
      }
    );
    return out.replace(/\s+/g, ' ').trim();
  }

  /** Indexes of string tokens that stand alone as a statement — docstrings
   *  and the like. They aren't values, and turning one into an f-string
   *  would stop it being a docstring, so they're treated like comments. */
  function statementStrings(src, tokens) {
    const result = new Set();
    let depth = 0;
    let k = 0;
    walk(
      src,
      tokens,
      0,
      src.length,
      (i) => {
        const c = src[i];
        if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) depth = Math.max(0, depth - 1);
      },
      (t) => {
        k = tokens.indexOf(t, k);
        if (t.type !== 'string' || depth > 0) return;
        const lineStart = src.lastIndexOf('\n', t.start - 1) + 1;
        const nl = src.indexOf('\n', t.end);
        const rest = src.slice(t.end, nl === -1 ? src.length : nl);
        if (!src.slice(lineStart, t.start).trim() && /^[ \t]*(?:#.*)?$/.test(rest)) result.add(k);
      }
    );
    return result;
  }

  // ---------- what can be swapped for a name ----------

  /** Why code range [s, e) can't be replaced by a name, or '' if it can. It
   *  must be one plain literal value: a number, string(s), True/False/None,
   *  or a list/tuple/dict/set built only from those. */
  function literalProblem(src, tokens, s, e) {
    let summary = '';
    let fString = false;
    walk(
      src,
      tokens,
      s,
      e,
      (i) => {
        summary += src[i];
      },
      (t) => {
        if (t.type === 'string') {
          summary += ' \u0001 ';
          if (t.fields.length) fString = true;
        } else summary += ' ';
      }
    );
    if (fString) return 'contains an f-string with {expressions}';

    const parts = summary.match(/\n|(?:\d|\.\d)(?:[eE][+-]|[\w.])*|[A-Za-z_]\w*|\S/g) || [];
    let depth = 0;
    let shape = '';
    for (const p of parts) {
      if ('([{'.includes(p)) {
        if (depth === 0) shape += 'G';
        depth++;
      } else if (')]}'.includes(p)) {
        depth--;
        if (depth < 0) return "its brackets don't match";
      } else if (/^[A-Za-z_]/.test(p) && !/^(True|False|None)$/.test(p)) {
        return `uses the name "${p}", not just a value`;
      } else if (p === '\n') {
        if (depth === 0) return 'spans more than one statement';
      } else if (depth > 0) {
        if (!/^(?:[,:+\-\u0001]$|\d|\.\d|(?:True|False|None)$)/.test(p)) return `contains "${p}"`;
      } else if (p === '\u0001') shape += 'S';
      else if (/^(?:\d|\.\d)|^(?:True|False|None)$/.test(p)) shape += 'N';
      else if (p === '-' || p === '+') shape += '-';
      else return `contains "${p}" outside brackets`;
    }
    if (depth !== 0) return "its brackets don't match";
    if (!/^(?:-*N|S+|G)$/.test(shape)) return "isn't a single value";
    return '';
  }

  /** Whether `pos` falls strictly inside a number like 1.5e-3. */
  function splitsNumber(src, pos) {
    const lineStart = src.lastIndexOf('\n', pos - 1) + 1;
    const nl = src.indexOf('\n', pos);
    const line = src.slice(lineStart, nl === -1 ? src.length : nl);
    const re = /(?<![\p{L}\p{N}_])(?:\d|\.\d)(?:[eE][+-]|[\w.])*/gu;
    let m;
    while ((m = re.exec(line)) !== null) {
      const a = lineStart + m.index;
      if (a < pos && pos < a + m[0].length) return true;
    }
    return false;
  }

  /** Why code range [s, e) can't be swapped in place, judging by what sits
   *  around it, or '' if it can. */
  function surroundingsProblem(src, tokens, s, e) {
    const first = src[s];
    const last = src[e - 1];
    const before = src[s - 1] || '';
    const after = src[e] || '';
    const edge = /[\p{L}\p{N}_.]/u;
    if ((WORD_CHAR.test(first) || first === '.') && edge.test(before)) return 'is part of a longer name or number';
    if ((WORD_CHAR.test(last) || last === '.') && edge.test(after)) return 'is part of a longer name or number';
    if (splitsNumber(src, s) || splitsNumber(src, e)) return 'is part of a longer number';
    if (first === '+' || first === '-') {
      // `x + 1` is a sum, not x followed by the value +1; and -5 ** 2 is
      // -(5 ** 2), so a signed number can't stand in front of **.
      const prev = src.slice(0, s).replace(/[ \t]+$/, '').slice(-1);
      if (/[\p{L}\p{N}_)\]}"']/u.test(prev)) return 'is part of a sum, not a value';
      if (/^\s*\*\*/.test(src.slice(e))) return 'is part of a power (**)';
    }
    if ('([{'.includes(first)) {
      const prev = src.slice(0, s).replace(/[ \t]+$/, '').slice(-1);
      if (/[\p{L}\p{N}_)\]}"']/u.test(prev)) return 'is part of a call or index, not a value';
    }
    // Adjacent strings join together ("a" "b"), so a name can't stand in for one.
    const k = tokenIndexAt(tokens, s);
    const prevTok = k > 0 ? tokens[k - 1] : tokens.filter((t) => t.end <= s).pop();
    const nextTok = tokens.find((t) => t.start >= e);
    if (prevTok && prevTok.type === 'string' && !src.slice(prevTok.end, s).trim()) return 'is joined to the string before it';
    if (nextTok && nextTok.type === 'string' && !src.slice(e, nextTok.start).trim()) return 'is joined to the string after it';
    return '';
  }

  /** Why a secret at [s, e) inside string token t can't be moved, or ''. */
  function stringProblem(src, t, s, e) {
    if (!t.closed) return "is in a string that isn't closed";
    const text = src.slice(s, e);
    let slashes = 0;
    for (let i = s - 1; i >= t.contentStart && src[i] === '\\'; i--) slashes++;
    if (slashes % 2 === 1) return 'starts in the middle of an escape like \\n';
    if (/(?:^|[^\\])(?:\\\\)*\\$/.test(text)) return 'ends in the middle of an escape like \\n';
    if (!/r/i.test(t.prefix) && /\\N\{/.test(src.slice(t.contentStart, t.contentEnd))) {
      return 'is in a string with a \\N{…} escape';
    }
    if (/f/i.test(t.prefix)) {
      if (/[{}]/.test(text)) return 'contains { or } inside an f-string';
      if (t.fields.some((f) => s < f.close && e > f.open)) return 'runs into an f-string {…} part';
    }
    return '';
  }

  function hasStringNeighbour(src, tokens, k) {
    const t = tokens[k];
    const prev = tokens[k - 1];
    const next = tokens[k + 1];
    return Boolean(
      (prev && prev.type === 'string' && !src.slice(prev.end, t.start).trim()) ||
        (next && next.type === 'string' && !src.slice(t.end, next.start).trim())
    );
  }

  /** Edits that swap each occurrence in string token t for its name. */
  function stringEdits(src, t, occs, neighbour) {
    const isBytes = /b/i.test(t.prefix);
    const isF = /f/i.test(t.prefix);
    const q = t.quote;
    if (occs.length === 1 && occs[0].s === t.contentStart && occs[0].e === t.contentEnd && !neighbour) {
      return [{ s: t.start, e: t.end, text: occs[0].name }];
    }
    // Already an f-string: drop each name in as a {field}, leaving the rest
    // (and any {fields} it already has) untouched.
    if (isF) return occs.map((o) => ({ s: o.s, e: o.e, text: `{${o.name}}` }));
    const pieces = [];
    let pos = t.contentStart;
    for (const o of occs) {
      pieces.push({ lit: src.slice(pos, o.s) }, { name: o.name });
      pos = o.e;
    }
    pieces.push({ lit: src.slice(pos, t.contentEnd) });
    if (isBytes) {
      // Bytes can't be f-strings: join the pieces with + instead.
      const parts = pieces.filter((p) => p.name || p.lit).map((p) => p.name || t.prefix + q + p.lit + q);
      return [{ s: t.start, e: t.end, text: `(${parts.join(' + ')})` }];
    }
    const prefix = (t.prefix + 'f').replace(/[uU]/g, '');
    const body = pieces.map((p) => (p.name ? `{${p.name}}` : p.lit.replace(/[{}]/g, '$&$&'))).join('');
    return [{ s: t.start, e: t.end, text: prefix + q + body + q }];
  }

  // ---------- the secrets module ----------

  /** Top-level `NAME = value` definitions in a module: name -> value key. */
  function parseModule(text) {
    const defs = new Map();
    if (!text) return defs;
    const tokens = lex(text);
    const re = /^([A-Za-z_]\w*)[ \t]*(?::[^=\n]*)?=(?!=)[ \t]*/gm;
    const starts = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      if (tokenIndexAt(tokens, m.index) === -1) starts.push({ name: m[1], at: m.index, valueAt: m.index + m[0].length });
    }
    starts.forEach((d, i) => {
      const end = i + 1 < starts.length ? starts[i + 1].at : text.length;
      defs.set(d.name, normaliseExpr(text.slice(d.valueAt, end)));
    });
    return defs;
  }

  /** Identifiers used in the code parts of src (not strings or comments). */
  function namesInCode(src) {
    const tokens = lex(src);
    const names = new Set();
    const re = /[A-Za-z_]\w*/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      if (locate(tokens, m.index).k === -1 && !/[\w.]/.test(src[m.index - 1] || '')) names.add(m[0]);
    }
    return names;
  }

  // ---------- the import line ----------

  /** Where a new import goes: after header comments, the module docstring
   *  and any `from __future__` imports. */
  function importPosition(src) {
    const tokens = lex(src);
    const skipBlank = (pos) => pos + /^(?:[ \t]*(?:#[^\n]*)?(?:\n|$))*/.exec(src.slice(pos))[0].length;
    let pos = skipBlank(0);
    const k = tokenIndexAt(tokens, pos);
    if (k !== -1 && tokens[k].type === 'string' && tokens[k].start === pos && !/[fb]/i.test(tokens[k].prefix)) {
      const nl = src.indexOf('\n', tokens[k].end);
      pos = skipBlank(nl === -1 ? src.length : nl + 1);
    }
    let m;
    while ((m = /^from[ \t]+__future__[ \t]+import[^\n]*(?:\n|$)/.exec(src.slice(pos))) !== null) {
      pos = skipBlank(pos + m[0].length);
    }
    return pos;
  }

  function formatImport(moduleName, names) {
    const line = `from ${moduleName} import ${names.join(', ')}`;
    if (line.length <= 79) return line;
    return `from ${moduleName} import (\n${names.map((n) => `    ${n},`).join('\n')}\n)`;
  }

  /** Add `names` to the file's `from <module> import …`, creating it if needed. */
  function addImport(src, moduleName, names) {
    if (names.length === 0) return src;
    const tokens = lex(src);
    const re = new RegExp(`^from[ \\t]+${escapeRegExp(moduleName)}[ \\t]+import[ \\t]+(\\([^)]*\\)|[^\\n#]*)`, 'gm');
    let m;
    while ((m = re.exec(src)) !== null) {
      if (tokenIndexAt(tokens, m.index) !== -1) continue;
      const entries = m[1]
        .replace(/[()]/g, '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      const have = new Set(entries.map((x) => x.split(/\s+as\s+/)[0]));
      const merged = entries.concat(names.filter((n) => !have.has(n)));
      const trailing = /[ \t]*$/.exec(m[0])[0];
      return src.slice(0, m.index) + formatImport(moduleName, merged) + trailing + src.slice(m.index + m[0].length);
    }
    const pos = importPosition(src);
    const lead = pos > 0 && src[pos - 1] !== '\n' ? '\n' : '';
    const gap = pos < src.length ? '\n' : '';
    return src.slice(0, pos) + lead + formatImport(moduleName, names) + '\n' + gap + src.slice(pos);
  }

  // ---------- main entry ----------

  /**
   * Move `secrets` ([{id, value, name}]) out of `src`.
   *
   * Returns {
   *   code:        the rewritten source, importing what it needs,
   *   moduleText:  the secrets module with new definitions appended,
   *   results:     Map id -> { hidden, problems: [{line, reason}] },
   *   added:       number of new definitions written to the module
   * }
   */
  function extract(src, secrets, { moduleName = 'hidden_secrets', existingModule = '' } = {}) {
    const tokens = lex(src);
    const docstrings = statementStrings(src, tokens);
    const moduleDefs = parseModule(existingModule);
    const codeNames = namesInCode(src);
    const results = new Map();
    const consumed = []; // [s, e) ranges already taken by a longer secret
    const edits = []; // { s, e, text }
    const stringOccs = new Map(); // string token -> { scope, k, occs: [{ s, e, name }] }
    const imported = new Set();
    const taken = new Map(moduleDefs); // name -> value key, for this run
    const newDefs = []; // { name, text }
    const lineOf = (pos) => src.slice(0, pos).split('\n').length;
    const overlaps = (s, e) => consumed.some(([a, b]) => s < b && e > a);

    /** Name to store `key` under: `base` if free (or already holding the
     *  same value), else base_2, base_3… Fixed names (real variables) never
     *  change, so a clash comes back as null. `define(name)` gives the line
     *  to write to the module for a new name. */
    function allocate(base, key, define, fixed) {
      for (let n = 1; ; n++) {
        const name = n === 1 ? base : `${base}_${n}`;
        if (!taken.has(name)) {
          taken.set(name, key);
          newDefs.push({ name, text: define(name) });
          return name;
        }
        if (taken.get(name) === key) return name;
        if (fixed) return null;
      }
    }

    const ordered = secrets
      .filter((x) => x.value.trim())
      .sort((a, b) => b.value.trim().length - a.value.trim().length);

    for (const secret of ordered) {
      const result = { hidden: 0, problems: [] };
      results.set(secret.id, result);
      const value = secret.value.trim();
      const problem = (pos, reason) => result.problems.push({ line: lineOf(pos), reason });
      const base = secret.name.trim();
      const nameOk = isValidName(base);

      const candidates = [];
      // In code: whole words only, any whitespace matches any whitespace.
      const body = value.split(/\s+/).map(escapeRegExp).join('\\s+');
      const lead = WORD_CHAR.test(value[0]) ? '(?<![\\p{L}\\p{N}_])' : '';
      const tail = WORD_CHAR.test(value[value.length - 1]) ? '(?![\\p{L}\\p{N}_])' : '';
      const codeRe = new RegExp(lead + body + tail, 'gu');
      let m;
      while ((m = codeRe.exec(src)) !== null) {
        if (m[0].length === 0) {
          codeRe.lastIndex++;
          continue;
        }
        const s = m.index;
        const e = s + m[0].length;
        // Both ends must be in the same stretch of code — at the top level or
        // inside the same f-string {field} — and not part-way into a string.
        const a = locate(tokens, s);
        const b = locate(tokens, e - 1);
        const sameCode = a.tokens === b.tokens && a.field === b.field;
        const startsInside = a.k !== -1 && a.tokens[a.k].start !== s;
        const endsInside = b.k !== -1 && b.tokens[b.k].end !== e;
        if (sameCode && !startsInside && !endsInside) {
          candidates.push({ s, e, where: 'code', scope: a.tokens, field: a.field });
        } else if (!(sameCode && a.k !== -1 && a.k === b.k)) {
          // Not wholly inside one string either (that's the search below).
          candidates.push({ s, e, where: 'partial' });
        }
      }
      // In strings and comments: exact text, anywhere — even mid-word.
      for (let at = src.indexOf(value); at !== -1; at = src.indexOf(value, at + 1)) {
        const end = at + value.length;
        const { tokens: scope, k, field } = locate(tokens, at);
        const last = locate(tokens, end - 1);
        const t = scope[k];
        if (t && end <= t.contentEnd && at >= t.contentStart) {
          const where = t.type === 'string' && scope === tokens && docstrings.has(k) ? 'docstring' : t.type;
          candidates.push({ s: at, e: end, where, scope, k, field });
        } else if (k !== -1 || last.k !== -1 || last.tokens !== scope || last.field !== field) {
          // Crosses the edge of a string or comment. (Plain code is the
          // whole-word search above; part of a longer name is left alone.)
          candidates.push({ s: at, e: end, where: 'partial' });
        }
      }
      // Spots that can't work go last, so they never block one that can.
      candidates.sort((a, b) => (a.where === 'partial') - (b.where === 'partial') || a.s - b.s);

      for (const c of candidates) {
        if (overlaps(c.s, c.e)) continue;
        if (c.where === 'partial') {
          problem(c.s, 'starts or ends part-way through a string — select the whole string, or only text inside it');
          continue;
        }
        if (c.field && c.field.debug) {
          // f"{x=}" prints its own source, so renaming inside it changes the output.
          problem(c.s, 'is in an f-string {…=} that prints its own code');
          continue;
        }

        if (c.where === 'code') {
          // A whole docstring, quotes and all: hide its text, keep it a docstring.
          const k = tokenIndexAt(tokens, c.s);
          if (c.scope === tokens && k !== -1 && docstrings.has(k) && tokens[k].start === c.s && tokens[k].end === c.e) {
            Object.assign(c, { s: tokens[k].contentStart, e: tokens[k].contentEnd, where: 'docstring', k });
            if (c.s === c.e) continue;
          }
        }
        const text = src.slice(c.s, c.e);

        if (c.where === 'code') {
          const assign = ASSIGN_RE.exec(text);
          const lineStart = src.lastIndexOf('\n', c.s - 1) + 1;
          if (assign && !src.slice(lineStart, c.s).trim()) {
            // A whole variable: move the statement, import the name.
            if (c.s !== lineStart) {
              problem(c.s, 'is indented — only top-level variables can be moved out');
              continue;
            }
            const nl = src.indexOf('\n', c.e);
            const restEnd = nl === -1 ? src.length : nl;
            if (!/^[ \t]*(?:#.*)?$/.test(src.slice(c.e, restEnd))) {
              problem(c.s, "isn't the whole statement — select to the end of the line");
              continue;
            }
            const why = literalProblem(src, c.scope, c.s + assign[0].length, c.e);
            if (why) {
              problem(c.s, `${assign[1]}'s value ${why}`);
              continue;
            }
            const varName = assign[1];
            const key = normaliseExpr(text.slice(assign[0].length));
            if (!allocate(varName, key, () => text, true)) {
              problem(c.s, `${varName} is already in ${moduleName}.py with a different value`);
              continue;
            }
            const blankRest = /^[ \t]*$/.test(src.slice(c.e, restEnd));
            edits.push({ s: c.s, e: blankRest && nl !== -1 ? nl + 1 : c.e, text: '' });
            imported.add(varName);
            consumed.push([c.s, c.e]);
            result.hidden++;
            continue;
          }
          const why = literalProblem(src, c.scope, c.s, c.e) || surroundingsProblem(src, c.scope, c.s, c.e);
          if (why) {
            problem(c.s, why);
            continue;
          }
        } else if (c.where === 'docstring') {
          const why = stringProblem(src, c.scope[c.k], c.s, c.e);
          if (why) {
            problem(c.s, why);
            continue;
          }
        } else if (c.where === 'string') {
          const t = c.scope[c.k];
          const why =
            stringProblem(src, t, c.s, c.e) ||
            // (b"x" + NAME) can't be joined to a neighbouring bytes literal.
            (/b/i.test(t.prefix) && hasStringNeighbour(src, c.scope, c.k) ? 'is in bytes joined to another string' : '');
          if (why) {
            problem(c.s, why);
            continue;
          }
        }

        if (!nameOk) {
          problem(c.s, base ? `"${base}" isn't a valid Python name` : 'needs a name');
          continue;
        }
        if (codeNames.has(base)) {
          problem(c.s, `"${base}" is already used in this file — pick another name`);
          continue;
        }

        let stored;
        if (c.where === 'code') stored = text;
        else if (c.where === 'string') {
          const t = c.scope[c.k];
          // Without backslashes r"…" means the same as "…", so drop the r and
          // let equal values share one name.
          const prefix = t.prefix.replace(text.includes('\\') ? /[fF]/g : /[fFrR]/g, '');
          // Likewise 'x' and "x" are the same value; use "x" where it's safe.
          const quote = /["'\\\n]/.test(text) ? t.quote : '"';
          stored = prefix + quote + text + quote;
        } else stored = JSON.stringify(text);
        const name = allocate(base, normaliseExpr(stored), (n) => `${n} = ${stored}`, false);

        if (c.where === 'code') {
          edits.push({ s: c.s, e: c.e, text: name });
          imported.add(name);
        } else if (c.where === 'string') {
          const t = c.scope[c.k];
          if (!stringOccs.has(t)) stringOccs.set(t, { scope: c.scope, k: c.k, occs: [] });
          stringOccs.get(t).occs.push({ s: c.s, e: c.e, name });
          imported.add(name);
        } else {
          edits.push({ s: c.s, e: c.e, text: name });
        }
        consumed.push([c.s, c.e]);
        result.hidden++;
      }
    }

    for (const [t, { scope, k, occs }] of stringOccs) {
      occs.sort((a, b) => a.s - b.s);
      edits.push(...stringEdits(src, t, occs, hasStringNeighbour(src, scope, k)));
    }

    edits.sort((a, b) => b.s - a.s);
    let code = src;
    for (const ed of edits) code = code.slice(0, ed.s) + ed.text + code.slice(ed.e);

    const usedNames = [...imported].filter((n) => newDefs.some((d) => d.name === n) || moduleDefs.has(n));
    code = addImport(code, moduleName, usedNames);

    let moduleText = existingModule || '';
    if (newDefs.length) {
      if (!moduleText.trim()) moduleText = MODULE_HEADER;
      if (!moduleText.endsWith('\n')) moduleText += '\n';
      moduleText += '\n' + newDefs.map((d) => d.text).join('\n') + '\n';
    }

    return { code, moduleText, results, added: newDefs.length };
  }

  /** First free SECRET_n name, avoiding `taken` (a Set) and names in src/module. */
  function suggestName(taken, src, moduleText) {
    const inCode = namesInCode(src || '');
    const inModule = parseModule(moduleText || '');
    for (let n = 1; ; n++) {
      const name = `SECRET_${n}`;
      if (!taken.has(name) && !inCode.has(name) && !inModule.has(name)) return name;
    }
  }

  /** The variable name if `value` is a `NAME = …` statement, else ''. */
  function assignedName(value) {
    const m = ASSIGN_RE.exec(value.trim());
    return m ? m[1] : '';
  }

  const api = { extract, suggestName, assignedName, isValidName, lex, locate, parseModule };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PyExtract = api;
})(typeof window !== 'undefined' ? window : globalThis);
