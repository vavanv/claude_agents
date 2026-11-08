'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('../helpers/project.cjs');
const { parseCounts } = require('../../plugin/bin/lib/parsers.cjs');

function started(overrides) {
  const p = H.makeProject();
  const result = H.init(p, overrides);
  assert.equal(result.code, 0, result.err);
  const dir = /Evidence folder: (.+)/.exec(result.out)[1].trim();
  return { ...p, dir, pointer: path.join(path.dirname(dir), 'active.json') };
}

for (const [label, corrupt] of [
  ['malformed pointer', (p) => fs.writeFileSync(p.pointer, '{broken')],
  ['null pointer', (p) => fs.writeFileSync(p.pointer, 'null')],
  ['escaping pointer', (p) => fs.writeFileSync(p.pointer, '{"runId":"../escape"}')],
  ['malformed state', (p) => fs.writeFileSync(path.join(p.dir, 'state.json'), '{broken')],
  ['missing state', (p) => fs.unlinkSync(path.join(p.dir, 'state.json'))],
  ['inconsistent state', (p) => fs.writeFileSync(path.join(p.dir, 'state.json'), '{}')],
]) {
  test(`corrupt storage: ${label} blocks actions and abort preserves evidence`, () => {
    const p = started();
    corrupt(p);
    const pointer = fs.readFileSync(p.pointer);
    const statePath = path.join(p.dir, 'state.json');
    const state = fs.existsSync(statePath) ? fs.readFileSync(statePath) : null;
    assert.ok(H.denied(H.hook(p, 'PreToolUse', {
      tool_name: 'Write', tool_input: { file_path: path.join(p.root, 'other.txt') },
    })));
    assert.ok(H.denied(H.spawnStage(p, 'implementer')));
    const command = `node "${H.GATE_FOR_COMMAND}" abort --reason "storage recovery"`;
    assert.ok(!H.denied(H.hook(p, 'PreToolUse', { tool_name: 'Bash', tool_input: { command } })));
    assert.ok(H.denied(H.hook(p, 'PreToolUse', {
      tool_name: 'Bash', tool_input: { command }, ...H.asAgent('implementer'),
    })));
    const result = H.gate(p, ['abort', '--reason', 'storage recovery']);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /^# Result: UNVERIFIED/);
    assert.match(result.out, /Original evidence preserved in: `[^`]+`/);
    const recovery = /Evidence folder: `(.+)`/.exec(result.out)[1];
    assert.deepEqual(fs.readFileSync(path.join(recovery, 'active.json')), pointer);
    assert.equal(JSON.parse(fs.readFileSync(path.join(recovery, 'report.json'))).result, 'UNVERIFIED');
    if (state) {
      assert.deepEqual(fs.readFileSync(statePath), state);
    } else {
      assert.ok(!fs.existsSync(statePath));
    }
    assert.equal(H.init(p).code, 0, 'can start a new run after recovery');
  });
}

const APPROVE = '{"verdict":"APPROVE","findings":[]}';
for (const [label, handback] of [
  ['malformed rejection after approval', `${APPROVE}\nChanged my mind.\n{"verdict":"REQUEST_CHANGES","findings":[`],
  ['trailing prose', `${APPROVE}\nActually, please fix this.`],
  ['missing findings', '{"verdict":"APPROVE"}'],
  ['non-array findings', '{"verdict":"APPROVE","findings":{}}'],
  ['null findings', '{"verdict":"APPROVE","findings":null}'],
]) {
  test(`invalid review: ${label} is UNVERIFIED`, () => {
    const p = started();
    H.implement(p);
    assert.equal(H.runValidator(p).code, 0);
    H.runReviewer(p, handback);
    assert.equal(H.report(p).result, 'UNVERIFIED');
  });
}

for (const output of ['no tests ran', '-1', '1.5', 'Infinity', '9007199254740992', '']) {
  test(`invalid regex counts ${JSON.stringify(output)} cannot pass`, () => {
    const p = started({ checks: [{ id: 'unit', kind: 'test', parser: 'regex',
      countRegex: '(?<passed>.+)', command: `node -e "console.log('${output}')"` }], checkBefore: false });
    H.implement(p);
    H.startStage(p, 'validator');
    assert.match(H.validate(p).out, /outcome=counts_unknown/);
    assert.equal(H.report(p).result, 'UNVERIFIED');
  });
}

test('regex setup rejects invalid syntax and absent named passing count', () => {
  const p = H.makeProject();
  for (const countRegex of ['(', '(?<failed>\\d+)', '\\(\\?<passed>\\d+\\)', 42, '']) {
    const result = H.init(p, { checks: [{ id: 'unit', kind: 'test', parser: 'regex', countRegex, command: H.PASSING }] });
    assert.equal(result.code, 2);
    assert.match(result.err, /SETUP_REQUIRED.*(?:countRegex|regular expression)/i);
  }
});

test('all parsers reject inconsistent counts, including optional regex total', () => {
  for (const value of ['-1', '0.5', 'NaN', 'Infinity', '']) {
    for (const field of ['failed', 'skipped']) {
      assert.equal(parseCounts({ parser: 'regex', countRegex: `(?<passed>\\d+):(?<${field}>.*)` }, `1:${value}`), null);
    }
  }
  assert.deepEqual(parseCounts({ parser: 'regex', countRegex: '(?<passed>\\d+) of (?<total>\\d+)' }, '5 of 5'),
    { passed: 5, failed: 0, skipped: 0, total: 5 });
  assert.equal(parseCounts({ parser: 'regex', countRegex: '(?<passed>\\d+) of (?<total>\\d+)' }, '5 of 2'), null);
  assert.equal(parseCounts({ parser: 'node-test' }, '# tests 1\n# pass 2\n# fail 0\n'), null);
  assert.equal(parseCounts({ parser: 'jest' }, 'Tests: 2 passed, 1 total\n'), null);
  assert.equal(parseCounts({ parser: 'vitest' }, 'Tests 2 passed (1)\n'), null);
  assert.equal(parseCounts({ parser: 'unittest' }, 'Ran 1 tests in 0.1s\nFAILED (failures=2)\n'), null);
});

test('report rejects invalid persisted counts even with a saved passed outcome', () => {
  const p = started();
  H.implement(p);
  H.runValidator(p);
  H.runReviewer(p);
  const file = path.join(p.dir, 'state.json');
  const state = JSON.parse(fs.readFileSync(file));
  state.checks.unit.counts.passed = null;
  fs.writeFileSync(file, JSON.stringify(state));
  assert.equal(H.report(p).result, 'UNVERIFIED');
});

test('Read and Grep protect content for root and every stage, including directory searches', () => {
  const p = started({ protected: ['other.txt', 'private/**'] });
  fs.mkdirSync(path.join(p.root, 'private'));
  fs.writeFileSync(path.join(p.root, 'private', 'secret.txt'), 'secret');
  fs.writeFileSync(path.join(p.root, 'src', '.env.local'), 'secret');
  for (const agent of [{}, ...['implementer', 'validator', 'reviewer'].map((r) => H.asAgent(r))]) {
    for (const rel of ['other.txt', 'private/secret.txt', 'src/.env.local']) {
      assert.ok(H.denied(H.hook(p, 'PreToolUse', {
        tool_name: 'Read', tool_input: { file_path: path.join(p.root, rel) }, ...agent,
      })), rel);
    }
    for (const rel of ['other.txt', 'private', 'src', '.', null]) {
      assert.ok(H.denied(H.hook(p, 'PreToolUse', {
        tool_name: 'Grep', tool_input: { pattern: '.', output_mode: 'content',
          ...(rel === null ? {} : { path: path.join(p.root, rel) }) }, ...agent,
      })), String(rel));
    }
    assert.ok(!H.denied(H.hook(p, 'PreToolUse', {
      tool_name: 'Grep', tool_input: { pattern: '.', path: path.join(p.root, 'src/a.txt') }, ...agent,
    })));
  }
  const hooks = require('../../plugin/hooks/hooks.json');
  assert.match(hooks.hooks.PreToolUse[0].matcher, /\bGrep\b/);
});

test('a dependency folder\'s .env files do not block Read or Grep, for root and every stage', () => {
  const p = started({ protected: ['node_modules/dep/private.txt'] });
  const dep = path.join(p.root, 'vendor', 'node_modules', 'dep');
  fs.mkdirSync(dep, { recursive: true });
  fs.writeFileSync(path.join(dep, '.env.example'), 'X=1');
  const venv = path.join(p.root, '.venv');
  fs.mkdirSync(venv);
  fs.writeFileSync(path.join(venv, '.env'), 'X=1');
  for (const agent of [{}, H.asAgent('implementer'), H.asAgent('reviewer')]) {
    for (const rel of ['vendor', 'vendor/node_modules/dep', '.venv']) {
      assert.ok(!H.denied(H.hook(p, 'PreToolUse', {
        tool_name: 'Grep', tool_input: { pattern: '.', path: path.join(p.root, rel) }, ...agent,
      })), rel);
    }
    assert.ok(!H.denied(H.hook(p, 'PreToolUse', {
      tool_name: 'Read', tool_input: { file_path: path.join(dep, '.env.example') }, ...agent,
    })));
  }
});

test('the dependency exemption covers only package files, not secrets or edits', () => {
  const p = started({ protected: ['**/private.txt'], scope: ['**'] });
  const dep = path.join(p.root, 'node_modules', 'dep');
  fs.mkdirSync(dep, { recursive: true });
  const grep = (rel) => H.hook(p, 'PreToolUse', {
    tool_name: 'Grep', tool_input: { pattern: '.', path: path.join(p.root, rel) },
  });
  const read = (rel) => H.hook(p, 'PreToolUse', {
    tool_name: 'Read', tool_input: { file_path: path.join(p.root, rel) },
  });

  // The spec's own paths still apply inside a dependency folder.
  fs.writeFileSync(path.join(dep, 'private.txt'), 'secret');
  assert.ok(H.denied(grep('node_modules')));
  assert.ok(H.denied(read('node_modules/dep/private.txt')));
  fs.unlinkSync(path.join(dep, 'private.txt'));
  assert.ok(!H.denied(grep('node_modules')));

  // A real .env elsewhere still refuses a search, and parent paths can't dodge the rule.
  fs.writeFileSync(path.join(p.root, 'src', '.env'), 'secret');
  assert.ok(H.denied(grep('src')));
  assert.ok(H.denied(read('node_modules/../src/.env')));

  // A dependency folder inside a protected folder is not exempt.
  fs.mkdirSync(path.join(p.root, 'cfg', '.env', 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(p.root, 'cfg', '.env', 'node_modules', 'x.txt'), 'secret');
  assert.ok(H.denied(read('cfg/.env/node_modules/x.txt')));
  assert.ok(H.denied(grep('cfg')));

  // A link from a dependency folder to a real secret is judged by where it leads.
  fs.mkdirSync(path.join(p.root, 'creds'));
  fs.writeFileSync(path.join(p.root, 'creds', '.env'), 'secret');
  fs.symlinkSync(path.join(p.root, 'creds'), path.join(dep, 'link'), 'junction');
  assert.ok(H.denied(grep('node_modules')));
  assert.ok(H.denied(read('node_modules/dep/link/.env')));

  // Edits keep the full rule, even with a scope that would allow the path.
  H.startStage(p, 'implementer');
  assert.ok(H.denied(H.hook(p, 'PreToolUse', {
    tool_name: 'Write', tool_input: { file_path: path.join(dep, '.env.example') }, ...H.asAgent('implementer'),
  })));
  assert.ok(!H.denied(H.hook(p, 'PreToolUse', {
    tool_name: 'Write', tool_input: { file_path: path.join(dep, 'index.js') }, ...H.asAgent('implementer'),
  })));
});

test('Grep checks protected names even in ignored directories and through links', () => {
  const p = started({ protected: ['private'] });
  fs.mkdirSync(path.join(p.root, 'private'));
  fs.writeFileSync(path.join(p.root, 'private', 'x.txt'), 'secret');
  fs.mkdirSync(path.join(p.root, 'safe'));
  fs.writeFileSync(path.join(p.root, 'safe', 'x.txt'), 'safe');
  const search = (rel) => H.hook(p, 'PreToolUse', {
    tool_name: 'Grep', tool_input: { pattern: '.', path: path.join(p.root, rel) },
  });
  assert.ok(!H.denied(search('safe')));
  fs.symlinkSync(path.join(p.root, 'private'), path.join(p.root, 'safe', 'link'), 'junction');
  assert.ok(H.denied(search('safe')));
  fs.writeFileSync(path.join(p.root, '.gitignore'), 'private/\n');
  assert.ok(H.denied(search('.')));
});
