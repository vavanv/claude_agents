'use strict';
// The checks `gate init` runs on the unchanged project (G15), and `gate remove`, the
// implementer's only shell command (G16). Real gate CLI and hook script, no models.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('../helpers/project.cjs');

const { hook, denied } = H;
const BASH = (command, agent) => ({ tool_name: 'Bash', tool_input: { command }, ...agent });
const REMOVE = (target) => `node "${H.GATE_FOR_COMMAND}" remove ${target}`;

// unittest-style output that passes only once src/a.txt says "changed".
const NEEDS_CHANGE = 'node -e "const ok=require(\'fs\').readFileSync(\'src/a.txt\',\'utf8\').includes(\'changed\');console.log(\'Ran 4 tests in 0.01s\');console.log(ok?\'OK\':\'FAILED (failures=1)\');process.exit(ok?0:1)"';
const TEST_CHECK = (command) => ({ id: 'unit', kind: 'test', parser: 'unittest', command, timeoutSec: 60 });

function evidenceOf(out) {
  const m = /Evidence folder: (.+)/.exec(out);
  return m ? m[1].trim() : null;
}

function finish(p) {
  H.implement(p);
  assert.equal(H.runValidator(p).code, 0);
  H.runReviewer(p);
  return H.report(p);
}

test('checks before the change: a check that already fails stops the run with SETUP_REQUIRED', () => {
  const p = H.makeProject();
  const r = H.init(p, { checks: [TEST_CHECK(NEEDS_CHANGE)] });
  assert.equal(r.code, 2);
  assert.match(r.err, /SETUP_REQUIRED: Check unit failed before any change/);
  assert.match(r.err, /failingBefore/);
  assert.match(r.err, /FAILED \(failures=1\)/, 'the log tail is shown');
  assert.match(H.gate(p, ['status']).out, /No active run/, 'the project is free again');
  const dir = evidenceOf(r.err);
  const report = fs.readFileSync(path.join(dir, 'report.md'), 'utf8');
  assert.match(report, /^# Result: SETUP_REQUIRED/);
  assert.match(report, /## Checks before the change[\s\S]*\*\*unit:\*\* failed; exit 1/);
  assert.ok(fs.existsSync(path.join(dir, 'checks', 'before', 'unit.log')));
});

test('checks before the change: they pass, are reported, and a PASS needs them', () => {
  const p = H.makeProject();
  const r = H.init(p);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Checks before the change: unit passed/);
  const rep = finish(p);
  assert.equal(rep.result, 'PASS');
  assert.match(rep.out, /## Checks before the change\n\n- \*\*unit:\*\* passed; exit 0; 4 passed, 0 failed/);
});

test('checks before the change: failingBefore lets a check fail first, and it must pass after', () => {
  const p = H.makeProject();
  const r = H.init(p, { checks: [TEST_CHECK(NEEDS_CHANGE)], failingBefore: ['unit'] });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Checks before the change: unit failed/);
  H.implement(p);
  assert.equal(H.runValidator(p).code, 0);
  const started = H.startStage(p, 'reviewer');
  const context = started.started.output.hookSpecificOutput.additionalContext;
  assert.match(context, /Check unit before the change: failed, exit 1[\s\S]*The spec allows that\./);
  H.stopStage(p, 'reviewer', { handback: '{"verdict":"APPROVE","findings":[]}' });
  const rep = H.report(p);
  assert.equal(rep.result, 'PASS');
  assert.match(rep.out, /\*\*unit:\*\* failed; exit 1; \d+ passed, 1 failed; \d+ ms; allowed to fail by failingBefore/);
});

test('checks before the change: still failing after the change is FAILED', () => {
  const p = H.makeProject();
  assert.equal(H.init(p, { checks: [TEST_CHECK(NEEDS_CHANGE)], failingBefore: ['unit'] }).code, 0);
  H.implement(p, 'still wrong\n');
  assert.equal(H.runValidator(p).code, 1);
  assert.equal(H.report(p).result, 'FAILED');
});

test('checks before the change: checkBefore false skips them, and says so', () => {
  const p = H.makeProject();
  const r = H.init(p, { checks: [TEST_CHECK(NEEDS_CHANGE)], checkBefore: false });
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /Checks before the change/);
  const rep = finish(p);
  assert.equal(rep.result, 'PASS');
  assert.match(rep.out, /Not run: the spec set "checkBefore": false\./);
});

test('checks before the change: bad spec values are refused', () => {
  for (const [overrides, message] of [
    [{ checkBefore: 'yes' }, /checkBefore must be true or false/],
    [{ failingBefore: ['nope'] }, /failingBefore must list ids of declared checks/],
    [{ failingBefore: 'unit' }, /failingBefore must list ids of declared checks/],
    [{ failingBefore: ['unit'], checkBefore: false }, /cannot go with "checkBefore": false/],
  ]) {
    const p = H.makeProject();
    const r = H.init(p, overrides);
    assert.equal(r.code, 2);
    assert.match(r.err, message);
  }
});

test('checks before the change: a check that writes to the project stops the run', () => {
  const p = H.makeProject();
  const writes = 'node -e "require(\'fs\').writeFileSync(\'src/a.txt\',\'fixed\');console.log(\'Ran 4 tests in 0.01s\');console.log(\'OK\')"';
  const r = H.init(p, { checks: [TEST_CHECK(writes)] });
  assert.equal(r.code, 2);
  assert.match(r.err, /SETUP_REQUIRED: The checks changed files before any change: src\/a\.txt/);
});

test('checks before the change: a check that times out on its own limit stops the run', () => {
  const p = H.makeProject();
  const hang = 'node -e "setTimeout(function(){},20000)"';
  const r = H.init(p, { checks: [{ ...TEST_CHECK(hang), timeoutSec: 1 }] });
  assert.equal(r.code, 2);
  assert.match(r.err, /SETUP_REQUIRED: Check unit timed out before any change/);
});

function removable() {
  const p = H.makeProject();
  fs.writeFileSync(path.join(p.root, 'src', 'old.txt'), 'old\n');
  fs.mkdirSync(path.join(p.root, 'src', 'dir'));
  fs.writeFileSync(path.join(p.root, 'src', 'dir', 'x.txt'), 'x\n');
  assert.equal(H.init(p).code, 0);
  return p;
}

test('remove: the implementer deletes a file in scope, and the run records it', () => {
  const p = removable();
  H.startStage(p, 'implementer');
  const implementer = H.asAgent('implementer');
  assert.ok(!denied(hook(p, 'PreToolUse', BASH(REMOVE('"src/old.txt"'), implementer))));
  const r = H.gate(p, ['remove', 'src/old.txt']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Removed src\/old\.txt/);
  assert.ok(!fs.existsSync(path.join(p.root, 'src', 'old.txt')));
  H.stopStage(p, 'implementer', { handback: 'done' });
  assert.equal(H.runValidator(p).code, 0);
  const started = H.startStage(p, 'reviewer');
  assert.match(started.started.output.hookSpecificOutput.additionalContext, /Removed files: src\/old\.txt/);
  H.stopStage(p, 'reviewer', { handback: '{"verdict":"APPROVE","findings":[]}' });
  const rep = H.report(p);
  assert.equal(rep.result, 'PASS');
  assert.match(rep.out, /Changed files:\*\* src\/old\.txt/);
});

test('remove: the implementer is told the command, and nothing else runs in its shell', () => {
  const p = removable();
  const { started } = H.startStage(p, 'implementer');
  assert.match(started.output.hookSpecificOutput.additionalContext, /remove "<path>", one file per call/);
  const implementer = H.asAgent('implementer');
  for (const command of [
    REMOVE('other.txt'),
    REMOVE('"src/old.txt" && echo hi'),
    REMOVE('src/old.txt src/a.txt'),
    REMOVE('.env'),
    REMOVE('../outside.txt'),
    'rm src/old.txt',
    `node "${H.GATE_FOR_COMMAND}" status`,
  ]) {
    assert.ok(denied(hook(p, 'PreToolUse', BASH(command, implementer))), command);
  }
  const outOfScope = hook(p, 'PreToolUse', BASH(REMOVE('other.txt'), implementer));
  assert.match(outOfScope.output.hookSpecificOutput.permissionDecisionReason, /outside the approved scope: other\.txt/);
  assert.ok(fs.existsSync(path.join(p.root, 'src', 'old.txt')));
});

test('remove: root and the validator may not use it, and the gate checks again', () => {
  const p = removable();
  assert.ok(denied(hook(p, 'PreToolUse', BASH(REMOVE('src/old.txt')))), 'root');
  assert.match(H.gate(p, ['remove', 'src/old.txt']).err, /only during the implementer stage \(now implementer_ready\)/);
  H.startStage(p, 'implementer');
  assert.match(H.gate(p, ['remove', 'other.txt']).err, /outside the approved scope/);
  assert.match(H.gate(p, ['remove', 'src/dir']).err, /Not a file: src\/dir/);
  assert.match(H.gate(p, ['remove', 'src/missing.txt']).err, /Not a file/);
  fs.writeFileSync(path.join(p.root, 'src', 'a.txt'), 'changed\n');
  H.stopStage(p, 'implementer', { handback: 'done' });
  H.startStage(p, 'validator');
  assert.ok(denied(hook(p, 'PreToolUse', BASH(REMOVE('src/old.txt'), H.asAgent('validator')))));
  assert.match(H.gate(p, ['remove', 'src/old.txt']).err, /only during the implementer stage/);
  assert.ok(fs.existsSync(path.join(p.root, 'src', 'old.txt')));
});
