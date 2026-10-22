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
   *  and where their content sits. */
  function lex(src) {
    const tokens = [];
    const n = src.length;
    let i = 0;
    while (i < n) {
      const c = src[i];
      if (c === '#') {
        const nl = src.indexOf('\n', i);
        const end = nl === -1 ? n : nl;
        tokens.push({ type: 'comment', start: i, end, contentStart: i + 1, contentEnd: end });
        i = end;
        continue;
      }
      if (c === '"' || c === "'") {
        let p = i;
        while (p > 0 && i - p < 2 && /[rRbBuUfF]/.test(src[p - 1])) p--;
        if (p > 0 && WORD_CHAR.test(src[p - 1])) p = i; // letters belong to a name
        const quote = src.startsWith(c + c + c, i) ? c + c + c : c;
        let j = i + quote.length;
        let closed = false;
        while (j < n) {
          if (src[j] === '\\') {
            j += 2;
            continue;
          }
          if (src.startsWith(quote, j)) {
            closed = true;
            break;
          }
          if (quote.length === 1 && src[j] === '\n') break;
          j++;
        }
        const contentEnd = Math.min(j, n);
        tokens.push({
          type: 'string',
          start: p,
          end: closed ? j + quote.length : contentEnd,
          prefix: src.slice(p, i),
          quote,
          contentStart: i + quote.length,
          contentEnd,
          closed
        });
        i = closed ? j + quote.length : contentEnd;
        continue;
      }
      i++;
    }
    return tokens;
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

  /** Whether a string token is an f-string with {expressions} in it. */
  function hasFields(src, t) {
    return /f/i.test(t.prefix) && /\{(?!\{)/.test(src.slice(t.contentStart, t.contentEnd).replace(/\{\{/g, ''));
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
          if (hasFields(src, t)) fString = true;
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
    if (/f/i.test(t.prefix)) {
      if (/[{}]/.test(text)) return 'contains { or } inside an f-string';
      let depth = 0;
      for (let i = t.contentStart; i < s; i++) {
        const c = src[i];
        if ((c === '{' || c === '}') && depth === 0 && src[i + 1] === c) i++;
        else if (c === '{') depth++;
        else if (c === '}') depth = Math.max(0, depth - 1);
      }
      if (depth > 0) return 'is inside an f-string {expression}';
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

  /** Rebuild string token t with each occurrence swapped for its name. */
  function rebuildString(src, t, occs, neighbour) {
    const isBytes = /b/i.test(t.prefix);
    const isF = /f/i.test(t.prefix);
    const q = t.quote;
    if (occs.length === 1 && occs[0].s === t.contentStart && occs[0].e === t.contentEnd && !neighbour) {
      return occs[0].name;
    }
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
      return `(${parts.join(' + ')})`;
    }
    const prefix = (isF ? t.prefix : t.prefix + 'f').replace(/[uU]/g, '');
    const body = pieces
      .map((p) => (p.name ? `{${p.name}}` : isF ? p.lit : p.lit.replace(/[{}]/g, '$&$&')))
      .join('');
    return prefix + q + body + q;
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
      if (tokenIndexAt(tokens, m.index) === -1 && !/[\w.]/.test(src[m.index - 1] || '')) names.add(m[0]);
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
    const stringOccs = new Map(); // token index -> [{ s, e, name }]
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
        const ks = tokenIndexAt(tokens, s);
        const ke = tokenIndexAt(tokens, e - 1);
        const startsInside = ks !== -1 && tokens[ks].start !== s;
        const endsInside = ke !== -1 && tokens[ke].end !== e;
        if (!startsInside && !endsInside) candidates.push({ s, e, where: 'code' });
      }
      // In strings and comments: exact text, anywhere — even mid-word.
      for (let at = src.indexOf(value); at !== -1; at = src.indexOf(value, at + 1)) {
        const k = tokenIndexAt(tokens, at);
        const t = tokens[k];
        if (t && at >= t.contentStart && at + value.length <= t.contentEnd) {
          const where = t.type === 'string' && docstrings.has(k) ? 'docstring' : t.type;
          candidates.push({ s: at, e: at + value.length, where, k });
        }
      }
      candidates.sort((a, b) => a.s - b.s);

      for (const c of candidates) {
        if (overlaps(c.s, c.e)) continue;

        if (c.where === 'code') {
          // A whole docstring, quotes and all: hide its text, keep it a docstring.
          const k = tokenIndexAt(tokens, c.s);
          if (k !== -1 && docstrings.has(k) && tokens[k].start === c.s && tokens[k].end === c.e) {
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
            const why = literalProblem(src, tokens, c.s + assign[0].length, c.e);
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
          const why = literalProblem(src, tokens, c.s, c.e) || surroundingsProblem(src, tokens, c.s, c.e);
          if (why) {
            problem(c.s, why);
            continue;
          }
        } else if (c.where === 'docstring') {
          const why = stringProblem(src, tokens[c.k], c.s, c.e);
          if (why) {
            problem(c.s, why);
            continue;
          }
        } else if (c.where === 'string') {
          const t = tokens[c.k];
          const why =
            stringProblem(src, t, c.s, c.e) ||
            // (b"x" + NAME) can't be joined to a neighbouring bytes literal.
            (/b/i.test(t.prefix) && hasStringNeighbour(src, tokens, c.k) ? 'is in bytes joined to another string' : '');
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
          const t = tokens[c.k];
          // Without backslashes r"…" means the same as "…", so drop the r and
          // let equal values share one name.
          const prefix = t.prefix.replace(text.includes('\\') ? /[fF]/g : /[fFrR]/g, '');
          stored = prefix + t.quote + text + t.quote;
        } else stored = JSON.stringify(text);
        const name = allocate(base, normaliseExpr(stored), (n) => `${n} = ${stored}`, false);

        if (c.where === 'code') {
          edits.push({ s: c.s, e: c.e, text: name });
          imported.add(name);
        } else if (c.where === 'string') {
          if (!stringOccs.has(c.k)) stringOccs.set(c.k, []);
          stringOccs.get(c.k).push({ s: c.s, e: c.e, name });
          imported.add(name);
        } else {
          edits.push({ s: c.s, e: c.e, text: name });
        }
        consumed.push([c.s, c.e]);
        result.hidden++;
      }
    }

    for (const [k, occs] of stringOccs) {
      const t = tokens[k];
      occs.sort((a, b) => a.s - b.s);
      edits.push({ s: t.start, e: t.end, text: rebuildString(src, t, occs, hasStringNeighbour(src, tokens, k)) });
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

  const api = { extract, suggestName, assignedName, isValidName, lex, parseModule };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PyExtract = api;
})(typeof window !== 'undefined' ? window : globalThis);
