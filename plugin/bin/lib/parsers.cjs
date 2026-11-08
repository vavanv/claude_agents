'use strict';
// Test-count parsers. Each returns { passed, failed, skipped, total } or null when
// the output has no recognisable summary. Null means "unknown", which is never a pass.

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

function lastMatch(text, re) {
  let found = null;
  for (const m of text.matchAll(re)) {
    found = m;
  }
  return found;
}

function num(value) {
  return value === undefined ? 0 : (/^\d+$/.test(value) ? Number(value) : NaN);
}

function validCounts(value) {
  return Boolean(value) && ['passed', 'failed', 'skipped', 'total'].every(
    (key) => Number.isSafeInteger(value[key]) && value[key] >= 0,
  ) && value.total === value.passed + value.failed + value.skipped;
}

function countRegex(source) {
  if (typeof source !== 'string' || !source) {
    throw new Error('countRegex must be a nonempty string');
  }
  const re = new RegExp(source, 'gm');
  // An empty alternative exposes named groups even if the real pattern needs input.
  const probe = new RegExp(`(?:${source})|`, 'm').exec('');
  if (!probe.groups || !Object.hasOwn(probe.groups, 'passed')) {
    throw new Error('countRegex needs a named passed group');
  }
  return re;
}

function counts(passed, failed, skipped) {
  return { passed, failed, skipped, total: passed + failed + skipped };
}

const parsers = {
  unittest(text) {
    const ran = lastMatch(text, /^Ran (\d+) tests? in /gm);
    if (!ran) {
      return null;
    }
    const total = Number(ran[1]);
    const status = lastMatch(text, /^(OK|FAILED)(?: \(([^)]*)\))?\s*$/gm);
    if (!status) {
      return null;
    }
    const field = (name) => {
      const m = new RegExp(`${name}=(\\d+)`).exec(status[2] || '');
      return m ? Number(m[1]) : 0;
    };
    const failed = field('failures') + field('errors');
    const skipped = field('skipped');
    return { passed: total - failed - skipped, failed, skipped, total };
  },

  'node-test'(text) {
    const read = (name) => lastMatch(text, new RegExp(`^(?:#|ℹ) ${name} (\\d+)\\s*$`, 'gm'));
    const tests = read('tests');
    const pass = read('pass');
    const fail = read('fail');
    if (!tests || !pass || !fail) {
      return null;
    }
    const skipped = read('skipped');
    const todo = read('todo');
    const cancelled = read('cancelled');
    return {
      passed: Number(pass[1]),
      failed: Number(fail[1]) + (cancelled ? Number(cancelled[1]) : 0),
      skipped: (skipped ? Number(skipped[1]) : 0) + (todo ? Number(todo[1]) : 0),
      total: Number(tests[1]),
    };
  },

  jest(text) {
    const line = lastMatch(text, /^Tests:\s+(.*\b\d+ total)\s*$/gm);
    if (!line) {
      return null;
    }
    const field = (name) => {
      const m = new RegExp(`(\\d+) ${name}`).exec(line[1]);
      return m ? Number(m[1]) : 0;
    };
    const skipped = field('skipped') + field('todo');
    return { passed: field('passed'), failed: field('failed'), skipped, total: field('total') };
  },

  vitest(text) {
    const line = lastMatch(text, /^\s*Tests\s+(.*\(\d+\))\s*$/gm);
    if (!line) {
      return null;
    }
    const field = (name) => {
      const m = new RegExp(`(\\d+) ${name}`).exec(line[1]);
      return m ? Number(m[1]) : 0;
    };
    const result = counts(field('passed'), field('failed'), field('skipped') + field('todo'));
    result.total = Number(/\((\d+)\)\s*$/.exec(line[1])[1]);
    return result;
  },

  pytest(text) {
    const line = lastMatch(text, /^=+ (.*\bin [\d.]+s.*?) =+\s*$/gm);
    if (!line) {
      return null;
    }
    const field = (name) => {
      const m = new RegExp(`(\\d+) ${name}`).exec(line[1]);
      return m ? Number(m[1]) : 0;
    };
    return counts(field('passed'), field('failed') + field('errors?'), field('skipped'));
  },
};

// `check.parser` names a parser; "regex" uses check.countRegex with named groups
// passed, failed and skipped. Returns null for anything unrecognised.
function parseCounts(check, rawOutput) {
  const text = rawOutput.replace(ANSI, '').replace(/\r\n/g, '\n');
  let result;
  if (check.parser === 'regex') {
    let re;
    try { re = countRegex(check.countRegex); } catch { return null; }
    const m = lastMatch(text, re);
    if (!m || !m.groups || m.groups.passed === undefined) {
      return null;
    }
    result = counts(num(m.groups.passed), num(m.groups.failed), num(m.groups.skipped));
    if (m.groups.total !== undefined) {
      result.total = num(m.groups.total);
    }
  } else {
    const parser = parsers[check.parser];
    result = parser ? parser(text) : null;
  }
  return validCounts(result) ? result : null;
}

module.exports = { parseCounts, validCounts, countRegex, PARSER_NAMES: [...Object.keys(parsers), 'regex'] };
