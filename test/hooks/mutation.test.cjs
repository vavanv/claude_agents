'use strict';
// The gate's mutation check, end to end through the real CLI and hooks, against a small
// real Node project and suite. No models.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const H = require('../helpers/project.cjs');

const SOURCE = "function isAdult(age) {\n  return age >= 18;\n}\nmodule.exports = { isAdult };\n";
const WEAK_SUITE = `const { isAdult } = require('./src/age.js');
if (!isAdult(30)) { console.log('Ran 1 tests in 0.01s'); console.log('FAILED (failures=1)'); process.exit(1); }
console.log('Ran 1 tests in 0.01s'); console.log('OK');
`;
const STRONG_SUITE = `const { isAdult } = require('./src/age.js');
const good = isAdult(18) === true && isAdult(17) === false && isAdult(30) === true;
console.log('Ran 3 tests in 0.01s');
if (!good) { console.log('FAILED (failures=1)'); process.exit(1); }
console.log('OK');
`;

function project(suite, mutation = {}, overrides = {}, prepare = () => {}) {
  const p = H.makeProject();
  prepare(p);
  fs.writeFileSync(path.join(p.root, 'src', 'age.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(p.root, 'age.test.js'), suite);
  const init = H.init(p, {
    scope: ['src/**', 'age.test.js'],
    checks: [{ id: 'unit', kind: 'test', parser: 'unittest', command: 'node age.test.js', timeoutSec: 60 }],
    mutation,
    // The suite tests code the implementer writes, so it can't pass before the change.
    checkBefore: false,
    ...overrides,
  });
  assert.strictEqual(init.code, 0, init.err);
  return p;
}

function implementSource(p, source = SOURCE) {
  H.startStage(p, 'implementer');
  fs.writeFileSync(path.join(p.root, 'src', 'age.js'), source);
  H.stopStage(p, 'implementer', { handback: 'done' });
}

function validator(p) {
  H.startStage(p, 'validator');
  const unit = H.validate(p);
  const mutation = H.gate(p, ['validate', '--mutation']);
  H.stopStage(p, 'validator', { handback: 'done' });
  return { unit, mutation };
}

function reportJson(p) {
  const runs = path.join(p.home, 'runs');
  const slug = fs.readdirSync(runs)[0];
  const run = fs.readdirSync(path.join(runs, slug)).find((x) => !x.endsWith('.json'));
  return JSON.parse(fs.readFileSync(path.join(runs, slug, run, 'report.json'), 'utf8'));
}

test('mutation: strong tests catch every break, and the run can PASS', () => {
  const p = project(STRONG_SUITE);
  implementSource(p);
  const { mutation } = validator(p);
  assert.strictEqual(mutation.code, 0, mutation.out + mutation.err);
  assert.match(mutation.out, /GATE_MUTATION passed; 100% caught/);
  H.runReviewer(p);
  const r = H.report(p);
  assert.strictEqual(r.result, 'PASS', r.out);
  assert.match(r.out, /## Mutation check/);
  assert.strictEqual(reportJson(p).mutation.survived, 0);
});

test('mutation: a gap the suite misses overrides an APPROVE and is FAILED', () => {
  const p = project(STRONG_SUITE.replace('isAdult(18) === true && isAdult(17) === false && ', ''), { maxMutants: 50 }, { maxRepairs: 0 });
  implementSource(p);
  const { mutation } = validator(p);
  assert.strictEqual(mutation.code, 1);
  assert.match(mutation.out, /Not caught: src\/age\.js:2/);
  H.runReviewer(p, '{"verdict":"APPROVE","findings":[]}');
  const r = H.report(p);
  assert.strictEqual(r.result, 'FAILED', r.out);
  assert.match(r.out, /did not catch enough deliberate breaks/);
});

test('mutation: a lower threshold accepts survivors, and still reports each one', () => {
  const p = project(WEAK_SUITE, { minScore: 0 }, { maxRepairs: 0 });
  implementSource(p);
  validator(p);
  H.runReviewer(p);
  const r = H.report(p);
  assert.strictEqual(r.result, 'PASS', r.out);
  assert.match(r.out, /\*\*Not caught:\*\* src\/age\.js:2/);
});

test('mutation: survivors go to the reviewer, then to a repair that fixes them', () => {
  const p = project(WEAK_SUITE);
  implementSource(p);
  validator(p);
  const reviewer = H.startStage(p, 'reviewer');
  const context = reviewer.started.output.hookSpecificOutput.additionalContext;
  assert.match(context, /Not caught by any test: src\/age\.js:2/);
  H.stopStage(p, 'reviewer', { handback: '{"verdict":"APPROVE","findings":[]}' });
  assert.match(H.gate(p, ['status']).out, /"next": "implementer"/);

  const implementer = H.startStage(p, 'implementer');
  assert.match(implementer.started.output.hookSpecificOutput.additionalContext, /no test failed when `return age >= 18;`/);
  fs.writeFileSync(path.join(p.root, 'age.test.js'), STRONG_SUITE);
  H.stopStage(p, 'implementer', { handback: 'done' });
  const round2 = validator(p);
  assert.strictEqual(round2.mutation.code, 0, round2.mutation.out);
  H.runReviewer(p);
  const r = H.report(p);
  assert.strictEqual(r.result, 'PASS', r.out);
  const json = reportJson(p);
  assert.strictEqual(json.repairs, 1);
  assert.strictEqual(json.attempts[0].mutation.outcome, 'below_threshold');
  assert.strictEqual(json.mutation.outcome, 'passed');
});

test('mutation: reviewer and mutation findings are repaired together', () => {
  const p = project(WEAK_SUITE);
  implementSource(p);
  validator(p);
  H.runReviewer(p, '{"verdict":"REQUEST_CHANGES","findings":["src/age.js:2: wrong name"]}');
  const context = H.startStage(p, 'implementer').started.output.hookSpecificOutput.additionalContext;
  assert.match(context, /wrong name/);
  assert.match(context, /no test failed/);
});

test('mutation: survivors left after the repair are FAILED', () => {
  const p = project(WEAK_SUITE);
  implementSource(p);
  validator(p);
  H.runReviewer(p);
  H.startStage(p, 'implementer');
  fs.writeFileSync(path.join(p.root, 'age.test.js'), `${WEAK_SUITE}\n// still weak\n`);
  H.stopStage(p, 'implementer', { handback: 'done' });
  validator(p);
  H.runReviewer(p);
  assert.strictEqual(H.report(p).result, 'FAILED');
});

test('mutation: the real project is never mutated', () => {
  const p = project(STRONG_SUITE);
  implementSource(p);
  H.startStage(p, 'validator');
  H.validate(p);
  H.gate(p, ['validate', '--mutation']);
  assert.strictEqual(fs.readFileSync(path.join(p.root, 'src', 'age.js'), 'utf8'), SOURCE);
  H.stopStage(p, 'validator', { handback: 'done' });
  H.runReviewer(p);
  H.report(p);
  const labels = reportJson(p).comparisons.map((c) => `${c.label}:${c.match}`);
  assert.ok(labels.includes('before-mutation:true'));
  assert.ok(labels.includes('after-mutation:true'));
});

test('mutation: suites that fail to start count as unusable, never as caught', () => {
  const crash = `const { isAdult } = require('./src/age.js');
if (isAdult(17)) throw new Error('crash with no test counts');
console.log('Ran 1 tests in 0.01s'); console.log('OK');
`;
  const p = project(crash, { minScore: 100, maxMutants: 1 });
  implementSource(p, "function isAdult(age) {\n  return age >= 18 ? true : false;\n}\nmodule.exports = { isAdult };\n");
  const { mutation } = validator(p);
  const json = /(\d+) didn't build or crashed/.exec(mutation.out);
  assert.ok(json && Number(json[1]) === 1, mutation.out);
  assert.match(mutation.out, /GATE_MUTATION all_invalid/);
  H.runReviewer(p);
  assert.strictEqual(H.report(p).result, 'UNVERIFIED');
});

const SETUP = [
  ['nothing to mutate', '// comment only\nmodule.exports = {};\n', /nothing to mutate/],
  ['an unsupported language', null, /Unsupported language: src\/age\.go/],
];
for (const [label, source, expected] of SETUP) {
  test(`mutation: ${label} is UNVERIFIED, not PASS`, () => {
    const p = project(STRONG_SUITE.replace(/isAdult\(\d+\) === \w+ && /g, '').replace('isAdult(30) === true', 'true').replace("const { isAdult } = require('./src/age.js');", ''));
    H.startStage(p, 'implementer');
    if (source) {
      fs.writeFileSync(path.join(p.root, 'src', 'age.js'), source);
    } else {
      fs.writeFileSync(path.join(p.root, 'src', 'age.go'), 'package age\n');
    }
    H.stopStage(p, 'implementer', { handback: 'done' });
    validator(p);
    const r = H.report(p);
    assert.strictEqual(r.result, 'UNVERIFIED', r.out);
    assert.match(r.out, expected);
  });
}

test('mutation: tests that need a file left out of the copy give UNVERIFIED', () => {
  const p = project(`${STRONG_SUITE}\nrequire('fs').readFileSync('secrets/key.txt');\n`, {}, { protected: ['secrets/**'] }, (q) => {
    fs.mkdirSync(path.join(q.root, 'secrets'));
    fs.writeFileSync(path.join(q.root, 'secrets', 'key.txt'), 'x');
  });
  implementSource(p);
  const { unit, mutation } = validator(p);
  assert.strictEqual(unit.code, 0, unit.out);
  assert.match(mutation.out, /GATE_MUTATION control_failed/);
  const r = H.report(p);
  assert.strictEqual(r.result, 'UNVERIFIED', r.out);
  assert.match(r.out, /didn't pass unmodified/);
});

test('mutation: running out of budget gives UNVERIFIED, not PASS', () => {
  const slow = `const end = Date.now() + 1500; while (Date.now() < end);\n${STRONG_SUITE}`;
  const p = project(slow, { budgetSec: 2, maxMutants: 50 });
  implementSource(p);
  const { mutation } = validator(p);
  assert.match(mutation.out, /GATE_MUTATION (incomplete|control_failed)/, mutation.out);
  assert.strictEqual(H.report(p).result, 'UNVERIFIED');
});

test('mutation: a hanging mutant counts as caught', () => {
  const source = "function isAdult(age) {\n  if (age >= 18) return true;\n  return false;\n}\nmodule.exports = { isAdult };\n";
  const suite = `const { isAdult } = require('./src/age.js');
if (!isAdult(18) || isAdult(17) || !isAdult(30)) { while (true); }
console.log('Ran 3 tests in 0.01s'); console.log('OK');
`;
  const p = project(suite, { maxMutants: 1 }, {
    checks: [{ id: 'unit', kind: 'test', parser: 'unittest', command: 'node age.test.js', timeoutSec: 3 }],
  });
  implementSource(p, source);
  const { mutation } = validator(p);
  assert.match(mutation.out, /GATE_MUTATION passed; 100% caught, needed 100%; 1 caught/, mutation.out);
});

test('mutation: skipping it, or running it twice or out of order, is refused', () => {
  const p = project(STRONG_SUITE);
  implementSource(p);
  assert.match(H.gate(p, ['validate', '--mutation']).err, /only during the validator stage/);
  H.startStage(p, 'validator');
  assert.match(H.gate(p, ['validate', '--mutation']).err, /Run the declared checks first/);
  H.validate(p);
  H.stopStage(p, 'validator', { handback: 'done' });
  const r = H.report(p);
  assert.strictEqual(r.result, 'UNVERIFIED', r.out);
  assert.match(r.out, /did not run the mutation check/);

  const again = project(STRONG_SUITE);
  implementSource(again);
  H.startStage(again, 'validator');
  H.validate(again);
  assert.strictEqual(H.gate(again, ['validate', '--mutation']).code, 0);
  assert.match(H.gate(again, ['validate', '--mutation']).err, /already run/);
});

test('mutation: the validator may run the exact command, and nothing longer', () => {
  const p = project(STRONG_SUITE);
  implementSource(p);
  const started = H.startStage(p, 'validator').started;
  assert.match(started.output.hookSpecificOutput.additionalContext, /validate --mutation/);
  const shell = (command) => H.hook(p, 'PreToolUse', { ...H.asAgent('validator'), tool_name: 'Bash', tool_input: { command } });
  assert.ok(!H.denied(shell(`node "${H.GATE_FOR_COMMAND}" validate --mutation`)));
  assert.ok(H.denied(shell(`node "${H.GATE_FOR_COMMAND}" validate --mutation --extra`)));
  assert.ok(H.denied(shell(`node "${H.GATE_FOR_COMMAND}" validate --mutation; echo hi`)));
});

test('mutation: a run without it reports that it was not requested', () => {
  const p = H.makeProject();
  H.init(p);
  H.implement(p);
  H.runValidator(p);
  H.runReviewer(p);
  const r = H.report(p);
  assert.strictEqual(r.result, 'PASS');
  assert.match(r.out, /Not requested in the spec/);
  assert.ok(!fs.existsSync(path.join(path.dirname(p.root), 'baseline')));
});

test('mutation: invalid settings are refused', () => {
  const cases = [
    ['not an object', 5],
    ['unknown check', { check: 'nope' }],
    ['budget too long', { budgetSec: 571 }],
    ['score too high', { minScore: 101 }],
    ['no mutants', { maxMutants: 0 }],
    ['exclude outside project', { exclude: ['../x'] }],
    ['empty command', { command: ' ' }],
  ];
  for (const [label, mutation] of cases) {
    const p = H.makeProject();
    const r = H.init(p, { mutation });
    assert.notStrictEqual(r.code, 0, label);
    assert.match(r.err, /SETUP_REQUIRED/, label);
  }
  const p = H.makeProject();
  const r = H.init(p, { mutation: { command: 'surely-not-a-real-command-xyz --go' } });
  assert.match(r.err, /Command not found: mutation/);
});

test('mutation: excluded files are not mutated, and changed tests never are', () => {
  const p = project(STRONG_SUITE, { exclude: ['src/skip.js'] }, { scope: ['src/**', 'test/**'] });
  H.startStage(p, 'implementer');
  fs.writeFileSync(path.join(p.root, 'src', 'age.js'), SOURCE);
  fs.writeFileSync(path.join(p.root, 'src', 'skip.js'), 'module.exports = 1 === 2;\n');
  fs.mkdirSync(path.join(p.root, 'test'));
  fs.writeFileSync(path.join(p.root, 'test', 'x.js'), 'module.exports = 3 === 4;\n');
  H.stopStage(p, 'implementer', { handback: 'done' });
  const { mutation } = validator(p);
  assert.strictEqual(mutation.code, 0, mutation.out);
  H.runReviewer(p);
  H.report(p);
  const summary = reportJson(p).mutation;
  assert.ok(summary.candidates > 0);
  const runs = path.join(p.home, 'runs');
  const slug = fs.readdirSync(runs)[0];
  const run = fs.readdirSync(path.join(runs, slug)).find((x) => !x.endsWith('.json'));
  const tried = JSON.parse(fs.readFileSync(path.join(runs, slug, run, 'checks', 'mutation', 'mutants.json'), 'utf8'));
  assert.deepStrictEqual([...new Set(tried.map((m) => m.file))], ['src/age.js']);
});
