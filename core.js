'use strict';

/*
 * Compartmentalise — pure find/replace logic shared by every mode.
 *
 * No DOM, no Node APIs: this file is loaded by the renderer with a <script>
 * tag and can also be require()'d from Node for testing.
 *
 * A "secret" is { id, value, placeholder }. Sanitising swaps value ->
 * placeholder; restoring swaps placeholder -> value. Both directions run as a
 * single regex pass with the longest strings tried first, so a secret that is
 * a substring of another never clobbers it, and replaced text is never
 * re-scanned (no chained replacements).
 */

(function (root) {
  function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** The text a string occupies *inside* a JSON string literal. */
  function jsonInner(str) {
    return JSON.stringify(str).slice(1, -1);
  }

  const JSON_EXT = /\.(json|jsonc|json5|ipynb|geojson|webmanifest|code-workspace)$/i;

  function isJsonPath(p) {
    return JSON_EXT.test(p);
  }

  /**
   * Build a replacer for one direction.
   * @param {{id:number,value:string,placeholder:string}[]} secrets
   * @param {'sanitise'|'restore'} direction
   * @param {boolean} jsonMode  also match the JSON-escaped form of each string
   */
  function makeReplacer(secrets, direction, jsonMode) {
    const from = direction === 'sanitise' ? 'value' : 'placeholder';
    const to = direction === 'sanitise' ? 'placeholder' : 'value';
    /** @type {Map<string,{replace:string,id:number}>} */
    const table = new Map();

    for (const s of secrets) {
      if (!s.value || !s.placeholder) continue;
      const f = s[from];
      const t = s[to];
      if (jsonMode) {
        // In a JSON file a value like  C:\keys\"prod"  is stored escaped.
        // Match that form too, and always write the replacement escaped, so
        // the file stays valid JSON and decodes to exactly the same data.
        const fe = jsonInner(f);
        const te = jsonInner(t);
        if (!table.has(fe)) table.set(fe, { replace: te, id: s.id });
        if (!table.has(f)) table.set(f, { replace: te, id: s.id });
        continue;
      }
      if (!table.has(f)) table.set(f, { replace: t, id: s.id });
    }

    const keys = [...table.keys()].sort((a, b) => b.length - a.length);
    const re = keys.length ? new RegExp(keys.map(escapeRegExp).join('|'), 'g') : null;

    return {
      /** @returns {{text:string, hits:Map<number,number>, total:number}} */
      apply(text) {
        const hits = new Map();
        if (!re || !text) return { text, hits, total: 0 };
        let total = 0;
        const out = text.replace(re, (m) => {
          const entry = table.get(m);
          hits.set(entry.id, (hits.get(entry.id) || 0) + 1);
          total += 1;
          return entry.replace;
        });
        return { text: out, hits, total };
      }
    };
  }

  /**
   * Holds the four replacers (sanitise/restore × plain/json) for one version
   * of the secret list, so a whole folder can be processed without rebuilding
   * the regex per file.
   */
  function makeEngine(secrets) {
    const cache = {};
    const get = (direction, json) => {
      const key = direction + (json ? ':json' : ':plain');
      if (!cache[key]) cache[key] = makeReplacer(secrets, direction, json);
      return cache[key];
    };
    return {
      text(text, direction) {
        return get(direction, false).apply(text);
      },
      file(path, text, direction) {
        return get(direction, isJsonPath(path)).apply(text);
      },
      path(relPath, direction) {
        return get(direction, false).apply(relPath).text;
      }
    };
  }

  // Characters Windows (the strictest common filesystem) refuses in a name.
  const BAD_NAME_CHARS = /[<>:"\\|?*\u0000-\u001f]/;

  /** Returns a reason string if a relative "/"-separated path is unusable. */
  function badPathReason(relPath) {
    const parts = relPath.split('/');
    for (const part of parts) {
      if (part === '' || part === '.' || part === '..') return 'empty or relative name';
      if (BAD_NAME_CHARS.test(part)) return 'contains a character file names cannot use';
      if (/[. ]$/.test(part)) return 'ends with a dot or space';
    }
    return null;
  }

  function parsesAsJson(text) {
    try {
      JSON.parse(text.replace(/^\uFEFF/, ''));
      return true;
    } catch (_) {
      return false;
    }
  }

  const IDENT_SAFE = /^[A-Za-z_][A-Za-z0-9_]*$/;

  const api = {
    escapeRegExp,
    jsonInner,
    isJsonPath,
    makeReplacer,
    makeEngine,
    badPathReason,
    parsesAsJson,
    IDENT_SAFE
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Core = api;
})(typeof self !== 'undefined' ? self : this);
