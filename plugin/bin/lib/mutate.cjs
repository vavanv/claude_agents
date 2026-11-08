'use strict';
// Mutant generation for the gate's mutation check. No model and no parser dependency:
// source text is masked so strings and comments can't be mutated, then small breaks are
// generated on the lines the candidate changed. A pure module: it runs nothing.

const LANGUAGES = {
  '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js',
  '.ts': 'js', '.tsx': 'js', '.mts': 'js', '.cts': 'js',
  '.py': 'py',
};

const TEST_FILE = [
  /(^|\/)(__tests__|__mocks__|tests?|specs?|e2e|fixtures)\//i,
  /[._-](test|spec|e2e)\.[^./]+$/i,
  /(^|\/)test_[^/]+$/i,
  /(^|\/)conftest\.py$/i,
];
const NOT_SOURCE = [/\.d\.[cm]?ts$/i, /(^|\/)[^/]*\.config\.[^/]+$/i];

const DIFF_CELL_LIMIT = 4_000_000;
const PRIORITY = { condition: 0, logic: 1, equality: 1, boolean: 1, boundary: 2, arithmetic: 2, returned: 3, number: 3 };

function languageOf(rel) {
  const m = /\.[^./]+$/.exec(rel);
  return m ? LANGUAGES[m[0].toLowerCase()] || null : null;
}

function isTestFile(rel) {
  return TEST_FILE.some((re) => re.test(rel));
}

function isConfigOrTypes(rel) {
  return NOT_SOURCE.some((re) => re.test(rel));
}

// The line numbers (1-based) of `after` that aren't in `before`. A null `before` is a new
// file. Too large a changed region is treated as wholly changed rather than diffed.
function changedLines(before, after) {
  const newLines = after.split(/\r?\n/);
  if (before === null) {
    return new Set(newLines.map((_, i) => i + 1));
  }
  const oldLines = before.split(/\r?\n/);
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start += 1;
  }
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  const n = oldEnd - start;
  const m = newEnd - start;
  const changed = new Set();
  if (n * m > DIFF_CELL_LIMIT || n === 0) {
    for (let i = start; i < newEnd; i += 1) {
      changed.add(i + 1);
    }
    return changed;
  }
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] = oldLines[start + i] === newLines[start + j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (j < m) {
    if (i < n && oldLines[start + i] === newLines[start + j]) {
      i += 1;
      j += 1;
    } else if (i < n && table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      i += 1;
    } else {
      changed.add(start + j + 1);
      j += 1;
    }
  }
  return changed;
}

function blank(chars, from, to) {
  for (let i = from; i < to; i += 1) {
    if (chars[i] !== '\n' && chars[i] !== '\r') {
      chars[i] = ' ';
    }
  }
}

function maskPython(text) {
  const chars = text.split('');
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (c === '#') {
      let end = i;
      while (end < chars.length && chars[end] !== '\n') {
        end += 1;
      }
      blank(chars, i, end);
      i = end;
    } else if (c === '"' || c === "'") {
      const triple = chars[i + 1] === c && chars[i + 2] === c;
      const width = triple ? 3 : 1;
      let end = i + width;
      for (; end < chars.length; end += 1) {
        if (chars[end] === '\\') {
          end += 1;
        } else if (!triple && chars[end] === '\n') {
          break;
        } else if (chars[end] === c && (!triple || (chars[end + 1] === c && chars[end + 2] === c))) {
          end += width;
          break;
        }
      }
      blank(chars, i, Math.min(end, chars.length));
      i = end;
    } else {
      i += 1;
    }
  }
  return chars.join('');
}

// A `/` starts a regex when an expression can't have just ended.
function regexCanStart(chars, at) {
  let i = at - 1;
  while (i >= 0 && /\s/.test(chars[i])) {
    i -= 1;
  }
  if (i < 0) {
    return true;
  }
  if ('(,=:[!&|?{};+-*%<>~^'.includes(chars[i])) {
    return true;
  }
  let word = '';
  while (i >= 0 && /\w/.test(chars[i])) {
    word = chars[i] + word;
    i -= 1;
  }
  return ['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new'].includes(word);
}

function maskJs(text) {
  const chars = text.split('');
  // Each entry is the brace depth inside a template's ${ }, so nested code stays visible
  // to the scanner while the template's own text is masked.
  const templates = [];
  let i = 0;
  const scanTemplate = () => {
    const from = i;
    i += 1;
    while (i < chars.length) {
      if (chars[i] === '\\') {
        i += 2;
      } else if (chars[i] === '`') {
        i += 1;
        blank(chars, from, i);
        return;
      } else if (chars[i] === '$' && chars[i + 1] === '{') {
        // The whole template is masked, code inside ${ } included: a mutant there would
        // be hard to read and it is rarely the logic under test.
        templates.push(0);
        i += 2;
        while (i < chars.length && templates[templates.length - 1] >= 0) {
          if (chars[i] === '{') {
            templates[templates.length - 1] += 1;
          } else if (chars[i] === '}') {
            templates[templates.length - 1] -= 1;
          } else if (chars[i] === '`') {
            scanTemplate();
            continue;
          }
          i += 1;
        }
        templates.pop();
      } else {
        i += 1;
      }
    }
    blank(chars, from, chars.length);
  };
  while (i < chars.length) {
    const c = chars[i];
    if (c === '/' && chars[i + 1] === '/') {
      let end = i;
      while (end < chars.length && chars[end] !== '\n') {
        end += 1;
      }
      blank(chars, i, end);
      i = end;
    } else if (c === '/' && chars[i + 1] === '*') {
      let end = i + 2;
      while (end < chars.length && !(chars[end] === '*' && chars[end + 1] === '/')) {
        end += 1;
      }
      end = Math.min(end + 2, chars.length);
      blank(chars, i, end);
      i = end;
    } else if (c === '"' || c === "'") {
      let end = i + 1;
      while (end < chars.length && chars[end] !== c && chars[end] !== '\n') {
        end += chars[end] === '\\' ? 2 : 1;
      }
      end = Math.min(end + 1, chars.length);
      blank(chars, i, end);
      i = end;
    } else if (c === '`') {
      scanTemplate();
    } else if (c === '/' && regexCanStart(chars, i)) {
      let end = i + 1;
      let inClass = false;
      while (end < chars.length && chars[end] !== '\n' && (inClass || chars[end] !== '/')) {
        if (chars[end] === '\\') {
          end += 1;
        } else if (chars[end] === '[') {
          inClass = true;
        } else if (chars[end] === ']') {
          inClass = false;
        }
        end += 1;
      }
      if (chars[end] === '/') {
        blank(chars, i, end + 1);
        i = end + 1;
      } else {
        i += 1;
      }
    } else {
      i += 1;
    }
  }
  return chars.join('');
}

function maskSource(text, language) {
  return language === 'py' ? maskPython(text) : maskJs(text);
}

const JS_TOKEN = /===|!==|==|!=|<=|>=|=>|&&|\|\||\?\?=?|\+\+|--|\*\*=?|\+=|-=|\*=|\/=|%=|<<=?|>>>?=?|\+|-|\*|\/|<|>|\btrue\b|\bfalse\b|(?<![\w.$])\d+(?![\w.])/g;
const PY_TOKEN = /==|!=|<=|>=|->|\*\*=?|\/\/=?|\+=|-=|\*=|\/=|%=|<<=?|>>=?|\+|-|\*|\/|<|>|\band\b|\bor\b|\bTrue\b|\bFalse\b|(?<![\w.])\d+(?![\w.])/g;

const SWAPS = {
  '===': ['!==', 'equality'],
  '!==': ['===', 'equality'],
  '==': ['!=', 'equality'],
  '!=': ['==', 'equality'],
  '<=': ['<', 'boundary'],
  '>=': ['>', 'boundary'],
  '<': ['<=', 'boundary'],
  '>': ['>=', 'boundary'],
  '&&': ['||', 'logic'],
  '||': ['&&', 'logic'],
  and: ['or', 'logic'],
  or: ['and', 'logic'],
  '+': ['-', 'arithmetic'],
  '-': ['+', 'arithmetic'],
  '*': ['/', 'arithmetic'],
  '/': ['*', 'arithmetic'],
  true: ['false', 'boolean'],
  false: ['true', 'boolean'],
  True: ['False', 'boolean'],
  False: ['True', 'boolean'],
};
// `<`, `>` and the arithmetic operators need space on both sides. That leaves out generics,
// JSX, unary signs and `import * as`, which would only produce mutants that don't compile.
const NEEDS_SPACES = new Set(['<', '>', '+', '-', '*', '/']);

const SKIP_LINE = {
  js: /^\s*(?:import\b|export\s+(?:\*|\{[^}]*\}\s*from)|(?:export\s+)?(?:declare\s+)?(?:type|interface)\s+\w|@|(?:export\s+)?enum\s)/,
  py: /^\s*(?:import\s|from\s+\S+\s+import\s|def\s|async\s+def\s|class\s|@)/,
};

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') {
      starts.push(i + 1);
    }
  }
  return starts;
}

function closingParen(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    if ('([{'.includes(masked[i])) {
      depth += 1;
    } else if (')]}'.includes(masked[i])) {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function trimmedRange(masked, from, to) {
  let start = from;
  let end = to;
  while (start < end && /\s/.test(masked[start])) {
    start += 1;
  }
  while (end > start && /\s/.test(masked[end - 1])) {
    end -= 1;
  }
  return start < end ? [start, end] : null;
}

// Where the condition of the ternary whose `?` is at `at` begins.
function ternaryConditionStart(masked, at) {
  let depth = 0;
  for (let i = at - 1; i >= 0; i -= 1) {
    const c = masked[i];
    if (')]}'.includes(c)) {
      depth += 1;
    } else if ('([{'.includes(c)) {
      if (depth === 0) {
        return i + 1;
      }
      depth -= 1;
    } else if (depth === 0) {
      if (';,?:'.includes(c)) {
        return i + 1;
      }
      if (c === '=' && !'=!<>'.includes(masked[i - 1]) && masked[i + 1] !== '=' && masked[i + 1] !== '>') {
        return i + 1;
      }
      if (c === '>' && masked[i - 1] === '=') {
        return i + 1;
      }
      if (c === 'n' && masked.slice(i - 5, i + 1) === 'return' && !/\w/.test(masked[i - 6] || '')) {
        return i + 1;
      }
    }
  }
  return 0;
}

function conditionMutants(masked, language, lines, starts, add) {
  const force = (start, end, line) => {
    const range = trimmedRange(masked, start, end);
    if (!range) {
      return;
    }
    const [yes, no] = language === 'py' ? ['True', 'False'] : ['true', 'false'];
    add(range[0], range[1], yes, 'condition', line);
    add(range[0], range[1], no, 'condition', line);
  };
  for (const line of lines) {
    const from = starts[line - 1];
    if (from === undefined) {
      continue;
    }
    const to = line < starts.length ? starts[line] - 1 : masked.length;
    const text = masked.slice(from, to);
    if (SKIP_LINE[language].test(text)) {
      continue;
    }
    if (language === 'js') {
      for (const m of text.matchAll(/\bif\s*\(/g)) {
        const open = from + m.index + m[0].length - 1;
        const close = closingParen(masked, open);
        if (close > 0) {
          force(open + 1, close, line);
        }
      }
      for (const m of text.matchAll(/(?:^|\s)\?(?=\s)/g)) {
        const at = from + m.index + m[0].length - 1;
        // `x ?: y` isn't valid here, and `a ? b : c` always has a term after the `?`.
        const rest = /\s*(\S)/.exec(masked.slice(at + 1, at + 80));
        if (rest && rest[1] !== ':') {
          force(ternaryConditionStart(masked, at), at, line);
        }
      }
    } else {
      const statement = /^\s*(?:el)?if\b/.exec(text);
      if (statement) {
        let depth = 0;
        for (let i = from + statement[0].length; i < masked.length; i += 1) {
          if ('([{'.includes(masked[i])) {
            depth += 1;
          } else if (')]}'.includes(masked[i])) {
            depth -= 1;
          } else if (masked[i] === ':' && depth === 0) {
            force(from + statement[0].length, i, line);
            break;
          }
        }
      } else {
        for (const m of text.matchAll(/\bif\b(.+?)\belse\b/g)) {
          const start = from + m.index + 2;
          force(start, start + m[1].length, line);
        }
      }
    }
  }
}

// Replaces a returned value, so a fix like `return lower` has something to break. In typed
// code this may not compile, and a mutant that doesn't build is left out of the score.
function returnMutants(masked, language, lines, starts, add) {
  const empty = language === 'py' ? 'None' : 'undefined';
  for (const line of lines) {
    const from = starts[line - 1];
    if (from === undefined) {
      continue;
    }
    const m = /^\s*return\b/.exec(masked.slice(from, line < starts.length ? starts[line] - 1 : masked.length));
    if (!m) {
      continue;
    }
    const valueFrom = from + m[0].length;
    let depth = 0;
    let end = valueFrom;
    for (; end < masked.length; end += 1) {
      const c = masked[end];
      if ('([{'.includes(c)) {
        depth += 1;
      } else if (')]}'.includes(c)) {
        if (depth === 0) {
          break;
        }
        depth -= 1;
      } else if (depth === 0 && (c === ';' || c === '\n')) {
        break;
      }
    }
    const range = trimmedRange(masked, valueFrom, end);
    if (!range) {
      continue;
    }
    const value = masked.slice(range[0], range[1]);
    if (!['None', 'null', 'undefined'].includes(value)) {
      add(range[0], range[1], empty, 'returned', line);
    }
  }
}

function tokenMutants(masked, language, lines, starts, add) {
  const token = language === 'py' ? PY_TOKEN : JS_TOKEN;
  for (const line of lines) {
    const from = starts[line - 1];
    if (from === undefined) {
      continue;
    }
    const to = line < starts.length ? starts[line] - 1 : masked.length;
    const text = masked.slice(from, to);
    if (SKIP_LINE[language].test(text)) {
      continue;
    }
    for (const m of text.matchAll(token)) {
      const value = m[0];
      const at = from + m.index;
      if (/^\d+$/.test(value)) {
        add(at, at + value.length, String(BigInt(value) + 1n), 'number', line);
      } else if (SWAPS[value]) {
        if (NEEDS_SPACES.has(value) && !(/\s/.test(masked[at - 1] || '') && /\s/.test(masked[at + value.length] || ''))) {
          continue;
        }
        add(at, at + value.length, SWAPS[value][0], SWAPS[value][1], line);
      }
    }
  }
}

// Returns mutants for one file: { start, end, replacement, operator, line, priority },
// with `start` and `end` as UTF-16 offsets in `text`.
function generateMutants(text, language, changed) {
  const masked = maskSource(text, language);
  const starts = lineStarts(masked);
  const lines = [...changed].sort((a, b) => a - b);
  const seen = new Set();
  const out = [];
  const add = (start, end, replacement, operator, line) => {
    const key = `${start}:${end}:${replacement}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    out.push({ start, end, replacement, operator, line, priority: PRIORITY[operator] });
  };
  conditionMutants(masked, language, lines, starts, add);
  tokenMutants(masked, language, lines, starts, add);
  returnMutants(masked, language, lines, starts, add);
  return out.sort((a, b) => a.line - b.line || a.priority - b.priority || a.start - b.start);
}

// Chooses at most `max` mutants, deterministically: one for each line before a second for
// any line, the most telling operators first, and spread evenly if a tier doesn't fit.
function selectMutants(mutants, max) {
  if (mutants.length <= max) {
    return [...mutants];
  }
  const groups = new Map();
  for (const m of mutants) {
    const key = `${m.file}:${m.line}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(m);
  }
  const lists = [...groups.values()];
  const chosen = [];
  for (let pass = 0; chosen.length < max; pass += 1) {
    const layer = lists.filter((l) => l.length > pass).map((l) => l[pass]);
    if (layer.length === 0) {
      break;
    }
    const tiers = new Map();
    for (const m of layer) {
      if (!tiers.has(m.priority)) {
        tiers.set(m.priority, []);
      }
      tiers.get(m.priority).push(m);
    }
    for (const priority of [...tiers.keys()].sort((a, b) => a - b)) {
      const tier = tiers.get(priority);
      const room = max - chosen.length;
      if (room <= 0) {
        break;
      }
      if (tier.length <= room) {
        chosen.push(...tier);
      } else {
        for (let i = 0; i < room; i += 1) {
          chosen.push(tier[Math.floor((i * tier.length) / room)]);
        }
      }
    }
  }
  return chosen.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.line - b.line || a.start - b.start);
}

function applyMutant(text, mutant) {
  return text.slice(0, mutant.start) + mutant.replacement + text.slice(mutant.end);
}

// The mutated source line and the original, for a reader.
function describeMutant(text, mutant) {
  const lineFrom = text.lastIndexOf('\n', mutant.start - 1) + 1;
  const after = text.indexOf('\n', mutant.end);
  const lineTo = after === -1 ? text.length : after;
  const original = text.slice(lineFrom, lineTo).replace(/\s+/g, ' ').trim();
  const mutated = (text.slice(lineFrom, mutant.start) + mutant.replacement + text.slice(mutant.end, lineTo)).replace(/\s+/g, ' ').trim();
  return { original, mutated };
}

module.exports = {
  applyMutant,
  changedLines,
  describeMutant,
  generateMutants,
  isConfigOrTypes,
  isTestFile,
  languageOf,
  maskSource,
  selectMutants,
};
