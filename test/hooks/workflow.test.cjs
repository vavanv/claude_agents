'use strict';
// Runs the real gate CLI and hook script with payloads shaped like those recorded in
// Phase 0. Covers the state machine, results and guardrails without using a model.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('../helpers/project.cjs');

const { hook, denied } = H;
const WRITE = (file, agent) => ({
  tool_name: 'Write',
  tool_input: { file_path: file, content: 'x' },
  ...agent,
});
const BASH = (command, agent) => ({ tool_name: 'Bash', tool_input: { command }, ...agent });
const VALIDATE = (id = 'unit') => `node "${H.GATE_FOR_COMMAND}" validate --check ${id}`;

function started(overrides) {
  const project = H.makeProject();
  const r = H.init(project, overrides);
  assert.equal(r.code, 0, r.err);
  return project;
}

function reportOf(project) {
  const r = H.report(project);
  assert.equal(r.code, 0, r.err);
  return r;
}

test('happy path: PASS, computed from evidence, with model audit', () => {
  const p = started();
  H.implement(p);
  assert.equal(H.runValidator(p).code, 0);
  H.runReviewer(p);
  const r = reportOf(p);
  assert.equal(r.result, 'PASS');
  assert.match(r.out, /src\/a\.txt/);
  assert.match(r.out, /implementer:\*\* MATCH/);
  assert.match(r.out, /4 passed, 0 failed, 0 skipped/);
  assert.match(r.out, /not OS isolation/);
  assert.match(H.gate(p, ['status']).out, /No active run/);
});

test('stage order: nothing can run out of order', () => {
  const p = started();
  assert.ok(denied(H.spawnStage(p, 'reviewer')));
  assert.ok(denied(H.spawnStage(p, 'validator')));
  assert.ok(denied(hook(p, 'PreToolUse', { tool_name: 'Agent', tool_input: { subagent_type: 'Explore' } })));
  assert.ok(denied(hook(p, 'PreToolUse', { tool_name: 'Agent', tool_input: { subagent_type: 'implementer' } })));
  assert.ok(!denied(H.spawnStage(p, 'implementer')));
  assert.ok(denied(H.spawnStage(p, 'implementer')), 'second spawn of the same stage');
});

test('each stage runs exactly once', () => {
  const p = started();
  H.implement(p);
  assert.ok(denied(H.spawnStage(p, 'implementer')));
  H.runValidator(p);
  assert.ok(denied(H.spawnStage(p, 'validator')));
  H.runReviewer(p);
  assert.ok(denied(H.spawnStage(p, 'reviewer')));
});

test('implementer: scope, protected paths, project boundary', () => {
  const p = started({ scope: ['src/**', '.env'], protected: ['src/secret/**'] });
  H.startStage(p, 'implementer');
  const agent = H.asAgent('implementer');
  const ok = (rel) => WRITE(path.join(p.root, rel), agent);
  assert.ok(!denied(hook(p, 'PreToolUse', ok('src/a.txt'))));
  assert.ok(!denied(hook(p, 'PreToolUse', ok('src/new/b.txt'))));
  assert.ok(denied(hook(p, 'PreToolUse', ok('other.txt'))), 'outside scope');
  assert.ok(denied(hook(p, 'PreToolUse', ok('src/secret/k.txt'))), 'protected by spec');
  assert.ok(denied(hook(p, 'PreToolUse', ok('.env'))), 'protected by default even when in scope');
  assert.ok(denied(hook(p, 'PreToolUse', ok('.git/config'))));
  assert.ok(denied(hook(p, 'PreToolUse', WRITE(path.join(p.root, '..', 'x.txt'), agent))), 'outside project');
  assert.ok(denied(hook(p, 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: path.join(p.root, 'other.txt') }, ...agent })));
  assert.ok(denied(hook(p, 'PreToolUse', { tool_name: 'NotebookEdit', tool_input: { notebook_path: path.join(p.root, 'n.ipynb') }, ...agent })));
});

test('implementer: a link inside scope cannot write outside the project', () => {
  const p = started();
  const outside = H.tempDir('devgate-outside-');
  fs.symlinkSync(outside, path.join(p.root, 'src', 'link'), 'junction');
  H.startStage(p, 'implementer');
  assert.ok(denied(hook(p, 'PreToolUse', WRITE(path.join(p.root, 'src', 'link', 'x.txt'), H.asAgent('implementer')))));
});

test('only the implementer can write, and only during its stage', () => {
  const p = started();
  const target = path.join(p.root, 'src', 'a.txt');
  assert.ok(denied(hook(p, 'PreToolUse', WRITE(target))), 'root');
  H.implement(p);
  assert.ok(denied(hook(p, 'PreToolUse', WRITE(target, H.asAgent('implementer')))), 'after freeze');
  assert.ok(denied(hook(p, 'PreToolUse', WRITE(target, H.asAgent('validator')))));
  assert.ok(denied(hook(p, 'PreToolUse', WRITE(target, H.asAgent('reviewer')))));
  assert.ok(denied(hook(p, 'PreToolUse', WRITE(target, { agent_id: 'z', agent_type: 'general-purpose' }))));
});

test('validator shell: only the exact gate command', () => {
  const p = started();
  H.implement(p);
  H.startStage(p, 'validator');
  const a = H.asAgent('validator');
  const tryIt = (cmd) => denied(hook(p, 'PreToolUse', BASH(cmd, a)));
  assert.ok(!tryIt(VALIDATE()));
  for (const bad of [
    `${VALIDATE()}; echo "exit code: $?"`,
    `${VALIDATE()} | tail -5`,
    `${VALIDATE()} > out.txt`,
    `cd src && ${VALIDATE()}`,
    `node "${H.GATE_FOR_COMMAND}" report`,
    `node "${H.GATE_FOR_COMMAND}" abort`,
    'node other.js validate --check unit',
    'npm test',
    'git commit -m x',
  ]) {
    assert.ok(tryIt(bad), bad);
  }
  assert.ok(denied(hook(p, 'PreToolUse', { tool_name: 'PowerShell', tool_input: { command: 'npm test' }, ...a })));
});

test('root shell: read-only and gate commands only', () => {
  const p = started();
  const tryIt = (cmd) => denied(hook(p, 'PreToolUse', BASH(cmd)));
  assert.ok(!tryIt(`node "${H.GATE_FOR_COMMAND}" status`));
  assert.ok(!tryIt('git status'));
  assert.ok(!tryIt('rtk git diff'));
  assert.ok(!tryIt(`node "${H.GATE_FOR_COMMAND}" abort --reason "stuck"`));
  for (const bad of [VALIDATE(), 'git commit -m x', 'git status && rm -rf src', 'npm test', 'echo x > src/a.txt']) {
    assert.ok(tryIt(bad), bad);
  }
});

test('reads: subagents cannot read protected files', () => {
  const p = started({ protected: ['src/secret/**'] });
  const read = (rel, agent) => hook(p, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: path.join(p.root, rel) }, ...agent });
  const a = H.asAgent('implementer');
  assert.ok(!denied(read('src/a.txt', a)));
  assert.ok(denied(read('src/secret/k.txt', a)));
  assert.ok(denied(read('.env', a)));
});

test('out-of-scope change found at freeze: FAILED, next stage refused', () => {
  const p = started();
  H.startStage(p, 'implementer');
  fs.writeFileSync(path.join(p.root, 'other.txt'), 'changed');
  H.stopStage(p, 'implementer', { handback: 'done' });
  assert.ok(denied(H.spawnStage(p, 'validator')));
  const r = reportOf(p);
  assert.equal(r.result, 'FAILED');
  assert.match(r.out, /outside scope: other\.txt/);
});

test('implementer changed nothing: UNVERIFIED', () => {
  const p = started();
  H.startStage(p, 'implementer');
  H.stopStage(p, 'implementer', { handback: 'nothing to do' });
  assert.equal(reportOf(p).result, 'UNVERIFIED');
});

test('pre-existing dirty files are baseline, not blamed on the implementer', () => {
  const p = H.makeProject();
  fs.writeFileSync(path.join(p.root, 'other.txt'), 'dirty before the run');
  assert.equal(H.init(p).code, 0);
  H.implement(p);
  H.runValidator(p);
  H.runReviewer(p);
  const r = reportOf(p);
  assert.equal(r.result, 'PASS');
  assert.doesNotMatch(r.out, /Changed files:.*other\.txt/);
});

for (const [label, change] of [
  ['modified', (p) => fs.writeFileSync(path.join(p.root, 'src', 'a.txt'), 'tampered')],
  ['added', (p) => fs.writeFileSync(path.join(p.root, 'sneaky.txt'), 'new')],
  ['deleted', (p) => fs.rmSync(path.join(p.root, 'other.txt'))],
]) {
  test(`file ${label} after freeze, before validation: FAILED, check not run`, () => {
    const p = started();
    H.implement(p);
    change(p);
    H.startStage(p, 'validator');
    assert.equal(H.validate(p).code, 1);
    const r = reportOf(p);
    assert.equal(r.result, 'FAILED');
    assert.match(r.out, /Candidate changed/);
    assert.match(r.out, /unit:\*\* did not run/);
  });

  test(`file ${label} after validation, before review stop: FAILED`, () => {
    const p = started();
    H.implement(p);
    H.runValidator(p);
    H.startStage(p, 'reviewer');
    change(p);
    H.stopStage(p, 'reviewer', { handback: '{"verdict":"APPROVE","findings":[]}' });
    assert.equal(reportOf(p).result, 'FAILED');
  });
}

test('a check that modifies the candidate: FAILED', () => {
  const p = started({
    checkBefore: false,
    checks: [{
      id: 'unit', kind: 'test', parser: 'unittest', timeoutSec: 60,
      command: `node -e "require('fs').writeFileSync('junk.txt','x');console.log('Ran 1 tests in 0.1s');console.log('OK')"`,
    }],
  });
  H.implement(p);
  H.startStage(p, 'validator');
  assert.equal(H.validate(p).code, 1);
  assert.match(reportOf(p).out, /Candidate changed \(after-unit\): junk\.txt/);
});

test('declared artifacts from a check do not change the candidate', () => {
  const p = started({
    declaredArtifacts: ['junk.txt'],
    checks: [{
      id: 'unit', kind: 'test', parser: 'unittest', timeoutSec: 60,
      command: `node -e "require('fs').writeFileSync('junk.txt','x');console.log('Ran 1 tests in 0.1s');console.log('OK')"`,
    }],
  });
  H.implement(p);
  assert.equal(H.runValidator(p).code, 0);
  H.runReviewer(p);
  assert.equal(reportOf(p).result, 'PASS');
});

const CHECK_CASES = [
  ['failing tests', H.FAKE_TEST(4, 'FAILED (failures=1)', 1), 'FAILED', 'failed'],
  ['non-zero exit without counts', 'node -e "process.exit(3)"', 'FAILED', 'failed'],
  ['exit 0 but failures reported', H.FAKE_TEST(4, 'FAILED (failures=1)', 0), 'FAILED', 'failed'],
  ['zero tests', H.FAKE_TEST(0, 'OK', 0), 'UNVERIFIED', 'zero_tests'],
  ['unrecognised output', 'node -e "console.log(\'all good\')"', 'UNVERIFIED', 'counts_unknown'],
];
for (const [label, command, result, outcome] of CHECK_CASES) {
  test(`check: ${label} gives ${result} (${outcome})`, () => {
    const p = started({ checks: [{ id: 'unit', kind: 'test', parser: 'unittest', command, timeoutSec: 60 }], checkBefore: false });
    H.implement(p);
    H.startStage(p, 'validator');
    const v = H.validate(p);
    assert.equal(v.code, 1);
    assert.match(v.out, new RegExp(`outcome=${outcome}`));
    assert.ok(denied(H.spawnStage(p, 'reviewer')), 'reviewer refused after a failed check');
    assert.equal(reportOf(p).result, result);
  });
}

test('check: a command gone at run time is UNVERIFIED, not FAILED', () => {
  const p = H.makeProject();
  const tool = path.join(p.root, 'tool.cmd');
  fs.writeFileSync(tool, '@echo off\r\nexit /b 0\r\n');
  assert.equal(H.init(p, { checks: [{ id: 'unit', kind: 'test', parser: 'unittest', command: '.\\tool.cmd', timeoutSec: 60 }], declaredArtifacts: ['tool.cmd'], checkBefore: false }).code, 0);
  H.implement(p);
  fs.rmSync(tool);
  H.startStage(p, 'validator');
  assert.match(H.validate(p).out, /outcome=not_started/);
  assert.equal(reportOf(p).result, 'UNVERIFIED');
});

test('check: a hanging suite times out, is killed, and gives UNVERIFIED', () => {
  const p = started({ checks: [{ id: 'unit', kind: 'test', parser: 'unittest', timeoutSec: 2, command: 'node -e "setInterval(()=>{},1000)"' }], checkBefore: false });
  H.implement(p);
  H.startStage(p, 'validator');
  const before = Date.now();
  const v = H.validate(p);
  assert.ok(Date.now() - before < 30_000, 'returned promptly');
  assert.match(v.out, /outcome=timed_out/);
  assert.equal(reportOf(p).result, 'UNVERIFIED');
});

test('checks run once, with no retry', () => {
  const p = started();
  H.implement(p);
  H.startStage(p, 'validator');
  assert.equal(H.validate(p).code, 0);
  const again = H.validate(p);
  assert.equal(again.code, 2);
  assert.match(again.err, /already run/);
});

test('checks cannot run outside the validator stage', () => {
  const p = started();
  assert.equal(H.validate(p).code, 2);
  H.implement(p);
  assert.equal(H.validate(p).code, 2);
});

test('validator skipped a declared check: UNVERIFIED', () => {
  const p = started({
    checks: [
      { id: 'unit', kind: 'test', parser: 'unittest', command: H.PASSING, timeoutSec: 60 },
      { id: 'types', kind: 'typecheck', command: 'node -e "0"', timeoutSec: 60 },
    ],
  });
  H.implement(p);
  H.runValidator(p, 'unit');
  const r = reportOf(p);
  assert.equal(r.result, 'UNVERIFIED');
  assert.match(r.out, /did not run: types/);
});

const REJECT = 'Problem.\n{"verdict":"REQUEST_CHANGES","findings":["src/a.txt:1: wrong"]}';

// One full rejected attempt, leaving the run waiting for the repair.
function rejected(overrides) {
  const p = started(overrides);
  H.implement(p);
  H.runValidator(p);
  H.runReviewer(p, REJECT);
  return p;
}

test('repair: a rejection returns to the implementer, then PASS keeps both attempts', () => {
  const p = rejected();
  const status = JSON.parse(H.gate(p, ['status']).out);
  assert.equal(status.next, 'implementer');
  assert.equal(H.report(p).code, 2, 'report refused while the repair is due');
  assert.ok(denied(H.spawnStage(p, 'validator')), 'cannot skip the implementer');
  const { started: packet } = H.startStage(p, 'implementer');
  const context = packet.output.hookSpecificOutput.additionalContext;
  assert.match(context, /repair attempt 2/);
  assert.match(context, /src\/a\.txt:1: wrong/);
  fs.writeFileSync(path.join(p.root, 'src', 'a.txt'), 'repaired\n');
  H.stopStage(p, 'implementer', { handback: 'done' });
  assert.equal(H.runValidator(p).code, 0, 'the same check can run again on the new candidate');
  const { started: review } = H.startStage(p, 'reviewer');
  assert.match(review.output.hookSpecificOutput.additionalContext, /src\/a\.txt:1: wrong/);
  H.stopStage(p, 'reviewer', { handback: '{"verdict":"APPROVE","findings":[]}' });
  const r = reportOf(p);
  assert.equal(r.result, 'PASS');
  assert.match(r.out, /Earlier attempts/);
  assert.match(r.out, /result is from attempt 2/);
  assert.match(r.out, /\*\*Verdict:\*\* REQUEST_CHANGES/);
  assert.match(r.out, /\*\*Logs:\*\* `[^`]+`/);
  const folder = /Evidence folder: `(.+)`/.exec(r.out)[1];
  assert.ok(fs.existsSync(path.join(folder, 'checks', 'attempt-1', 'unit.log')), 'first log kept');
  assert.ok(fs.existsSync(path.join(folder, 'checks', 'unit.log')), 'second log written');
  const json = JSON.parse(fs.readFileSync(path.join(folder, 'report.json'), 'utf8'));
  assert.equal(json.repairs, 1);
  assert.equal(json.attempts[0].review.verdict, 'REQUEST_CHANGES');
  assert.notEqual(json.attempts[0].fingerprint, json.candidateFingerprint);
});

test('repair: a second rejection is FAILED, with no further repair', () => {
  const p = rejected();
  H.implement(p, 'repaired\n');
  H.runValidator(p);
  H.runReviewer(p, '{"verdict":"REQUEST_CHANGES","findings":["src/a.txt:1: still wrong"]}');
  assert.ok(denied(H.spawnStage(p, 'implementer')));
  const r = reportOf(p);
  assert.equal(r.result, 'FAILED');
  assert.match(r.out, /still wrong/);
  assert.match(r.out, /Earlier attempts/);
});

test('repair: changing nothing leaves the rejection standing', () => {
  const p = rejected();
  H.startStage(p, 'implementer');
  H.stopStage(p, 'implementer', { handback: 'no change' });
  assert.ok(denied(H.spawnStage(p, 'validator')));
  const r = reportOf(p);
  assert.equal(r.result, 'FAILED');
  assert.match(r.out, /repair changed nothing/);
});

test('repair: scope is still enforced, by hook and at freeze', () => {
  const p = rejected();
  H.startStage(p, 'implementer');
  const agent = H.asAgent('implementer');
  assert.ok(denied(hook(p, 'PreToolUse', WRITE(path.join(p.root, 'other.txt'), agent))));
  fs.writeFileSync(path.join(p.root, 'other.txt'), 'changed');
  fs.writeFileSync(path.join(p.root, 'src', 'a.txt'), 'repaired\n');
  H.stopStage(p, 'implementer', { handback: 'done' });
  const r = reportOf(p);
  assert.equal(r.result, 'FAILED');
  assert.match(r.out, /outside scope: other\.txt/);
});

test('repair: a failing check in the repair is FAILED, not repaired again', () => {
  const p = rejected({
    checks: [{
      id: 'unit', kind: 'test', parser: 'unittest', timeoutSec: 60,
      command: `node -e "const b=require('fs').readFileSync('src/a.txt','utf8').includes('bad');console.log('Ran 1 tests in 0.1s');console.log(b?'FAILED (failures=1)':'OK');process.exit(b?1:0)"`,
    }],
  });
  H.implement(p, 'bad\n');
  H.startStage(p, 'validator');
  assert.equal(H.validate(p).code, 1);
  assert.equal(reportOf(p).result, 'FAILED');
});

for (const [label, overrides, handback, tamper, result] of [
  ['maxRepairs 0', { maxRepairs: 0 }, REJECT, false, 'FAILED'],
  ['no concrete findings', {}, '{"verdict":"REQUEST_CHANGES","findings":[]}', false, 'FAILED'],
  ['candidate changed during review', {}, REJECT, true, 'FAILED'],
  ['unreadable verdict', {}, 'Please fix this.', false, 'UNVERIFIED'],
]) {
  test(`repair: not offered for ${label}`, () => {
    const p = started(overrides);
    H.implement(p);
    H.runValidator(p);
    H.startStage(p, 'reviewer');
    if (tamper) {
      fs.writeFileSync(path.join(p.root, 'other.txt'), 'tampered');
    }
    H.stopStage(p, 'reviewer', { handback });
    assert.ok(denied(H.spawnStage(p, 'implementer')));
    assert.equal(reportOf(p).result, result);
  });
}

test('repair: an invalid maxRepairs is refused', () => {
  const p = H.makeProject();
  for (const value of [2, -1, 'yes']) {
    const r = H.init(p, { maxRepairs: value });
    assert.equal(r.code, 2);
    assert.match(r.err, /maxRepairs/);
  }
});

test('repair: an earlier wrong model stays visible after a clean repair', () => {
  const p = started({ models: { reviewer: 'claude-fable-5-1' } });
  H.implement(p);
  H.runValidator(p);
  H.runReviewer(p, REJECT);
  H.implement(p, 'repaired\n');
  H.runValidator(p);
  H.runReviewer(p);
  const r = reportOf(p);
  assert.equal(r.result, 'PASS');
  assert.match(r.out, /reviewer MISMATCH/);
});

test('reviewer: REQUEST_CHANGES is FAILED, with findings reported', () => {
  const p = started({ maxRepairs: 0 });
  H.implement(p);
  H.runValidator(p);
  H.runReviewer(p, REJECT);
  const r = reportOf(p);
  assert.equal(r.result, 'FAILED');
  assert.match(r.out, /src\/a\.txt:1: wrong/);
});

test('reviewer: no readable verdict is UNVERIFIED, whatever the prose says', () => {
  const p = started();
  H.implement(p);
  H.runValidator(p);
  H.runReviewer(p, 'I approve this change. PASS!');
  assert.equal(reportOf(p).result, 'UNVERIFIED');
});

test('abort mid-stage: the audit says why each stage was not audited', () => {
  const p = started();
  H.startStage(p, 'implementer');
  const a = H.gate(p, ['abort', '--reason', 'session lost']);
  assert.equal(a.code, 0, a.err);
  assert.match(a.out, /# Result: UNVERIFIED/);
  assert.match(a.out, /\*\*implementer:\*\* agent .* \(did not finish\)/);
  assert.match(a.out, /\*\*implementer:\*\* UNVERIFIED; not audited, stage did not finish/);
  assert.match(a.out, /\*\*validator:\*\* UNVERIFIED; not audited, stage did not run/);
  assert.match(a.out, /\*\*reviewer:\*\* UNVERIFIED; not audited, stage did not run/);
  assert.doesNotMatch(a.out, /no transcript evidence/);
});

test('report is refused before the run finishes; abort gives UNVERIFIED', () => {
  const p = started();
  assert.equal(H.report(p).code, 2);
  const a = H.gate(p, ['abort', '--reason', 'testing']);
  assert.equal(a.code, 0);
  assert.match(a.out, /# Result: UNVERIFIED/);
  assert.match(a.out, /testing/);
  assert.equal(H.init(p).code, 0, 'project is free for a new run');
});

test('a second run cannot start while one is active', () => {
  const p = started();
  const r = H.init(p);
  assert.equal(r.code, 2);
  assert.match(r.err, /already active/);
});

test('model mismatch is reported but does not change the functional result', () => {
  const p = started({ models: { reviewer: 'claude-fable-5-1' } });
  H.implement(p);
  H.runValidator(p);
  H.runReviewer(p);
  const r = reportOf(p);
  assert.equal(r.result, 'PASS');
  assert.match(r.out, /reviewer:\*\* MISMATCH/);
});

test('missing transcript leaves the model UNVERIFIED and the result unchanged', () => {
  const p = started();
  H.implement(p);
  H.runValidator(p);
  H.startStage(p, 'reviewer');
  const file = H.writeTranscript(p, 'reviewer', { model: 'x', handback: '{"verdict":"APPROVE","findings":[]}' });
  // The verdict still reads from this transcript; delete the model field only.
  const rec = fs.readFileSync(file, 'utf8').replace('"model":"x",', '');
  fs.writeFileSync(file, rec);
  hook(p, 'SubagentStop', { ...H.asAgent('reviewer'), agent_transcript_path: file, stop_hook_active: false });
  const r = reportOf(p);
  assert.equal(r.result, 'PASS');
  assert.match(r.out, /reviewer:\*\* UNVERIFIED/);
});

test('Stop: blocked once when a report is due, then closed as UNVERIFIED', () => {
  const p = started();
  H.implement(p);
  H.runValidator(p);
  H.runReviewer(p);
  const first = hook(p, 'Stop', { stop_hook_active: false });
  assert.equal(first.output.decision, 'block');
  assert.match(first.output.reason, /gate report/);
  const second = hook(p, 'Stop', { stop_hook_active: true });
  assert.equal(second.output.decision, undefined);
  assert.match(H.gate(p, ['status']).out, /No active run/);
});

test('Stop: allowed while a stage is running or background work is active', () => {
  const p = started();
  H.startStage(p, 'implementer');
  assert.equal(hook(p, 'Stop', { stop_hook_active: false }).output.decision, undefined);
  const q = started();
  assert.equal(hook(q, 'Stop', { stop_hook_active: false, background_tasks: [{ id: 'x' }] }).output.decision, undefined);
  assert.equal(hook(q, 'Stop', { stop_hook_active: false }).output.decision, 'block');
});

test('no active run: every hook is a no-op', () => {
  const p = H.makeProject();
  assert.ok(!denied(hook(p, 'PreToolUse', WRITE(path.join(p.root, 'anything.txt')))));
  assert.ok(!denied(hook(p, 'PreToolUse', BASH('npm test'))));
  assert.equal(hook(p, 'Stop', { stop_hook_active: false }).output.decision, undefined);
});

test('another session is unaffected by this session\'s run', () => {
  const p = H.makeProject();
  assert.equal(H.gate(p, ['init', '--session', 'session-1'], JSON.stringify(H.spec())).code, 0);
  const other = { session_id: 'session-2' };
  assert.ok(!denied(hook(p, 'PreToolUse', { ...WRITE(path.join(p.root, 'x.txt')), ...other })));
  assert.ok(denied(hook(p, 'PreToolUse', WRITE(path.join(p.root, 'x.txt')))));
});

test('the session id reaches the run through the init hook', () => {
  const p = H.makeProject();
  hook(p, 'PreToolUse', BASH(`node "${H.GATE_FOR_COMMAND}" init <<'SPEC'\n{}\nSPEC`, { session_id: 'owner' }));
  assert.equal(H.init(p).code, 0);
  assert.ok(!denied(hook(p, 'PreToolUse', { ...WRITE(path.join(p.root, 'x.txt')), session_id: 'someone-else' })));
  assert.ok(denied(hook(p, 'PreToolUse', { ...WRITE(path.join(p.root, 'x.txt')), session_id: 'owner' })));
});

test('the session id reaches the run when root puts cd before gate init', () => {
  const p = H.makeProject();
  const bashPath = p.root.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
  for (const dir of [`"${p.root.replace(/\\/g, '/')}"`, process.platform === 'win32' ? bashPath : `'${p.root}'`]) {
    hook(p, 'PreToolUse', BASH(`cd ${dir} && node "${H.GATE_FOR_COMMAND}" init <<'SPEC'\n{}\nSPEC`, { session_id: 'owner' }));
    assert.equal(H.init(p).code, 0, dir);
    assert.ok(!denied(hook(p, 'PreToolUse', { ...WRITE(path.join(p.root, 'x.txt')), session_id: 'someone-else' })), dir);
    assert.ok(denied(hook(p, 'PreToolUse', { ...WRITE(path.join(p.root, 'x.txt')), session_id: 'owner' })), dir);
    assert.equal(H.gate(p, ['abort', '--reason', 'next form']).code, 0);
  }
});

test('a cd into another project notes the session there, not here', () => {
  const p = H.makeProject();
  const other = H.makeProject();
  hook(p, 'PreToolUse', BASH(`cd "${other.root.replace(/\\/g, '/')}" && node "${H.GATE_FOR_COMMAND}" init <<'SPEC'\n{}\nSPEC`, { session_id: 'owner' }));
  assert.equal(H.init(p).code, 0);
  assert.ok(denied(hook(p, 'PreToolUse', { ...WRITE(path.join(p.root, 'x.txt')), session_id: 'someone-else' })), 'no session id here, so every session is held');
});

test('a late answer to the init prompt leaves no session id, so every session is held', () => {
  const p = H.makeProject();
  hook(p, 'PreToolUse', BASH(`node "${H.GATE_FOR_COMMAND}" init <<'SPEC'\n{}\nSPEC`, { session_id: 'owner' }));
  const runs = path.join(p.home, 'runs');
  const pending = fs.readdirSync(runs).map((slug) => path.join(runs, slug, 'pending-session.json')).find((f) => fs.existsSync(f));
  assert.ok(pending, 'the init hook noted the session');
  const note = JSON.parse(fs.readFileSync(pending, 'utf8'));
  fs.writeFileSync(pending, JSON.stringify({ ...note, at: note.at - 70000 }));
  assert.equal(H.init(p).code, 0);
  assert.ok(!fs.existsSync(pending), 'the note is used up');
  for (const session of ['owner', 'someone-else']) {
    assert.ok(denied(hook(p, 'PreToolUse', { ...WRITE(path.join(p.root, 'x.txt')), session_id: session })), session);
  }
  // Reading an unprotected file is never refused, in any session, so it can't show this.
  assert.ok(!denied(hook(p, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: path.join(p.root, 'x.txt') }, session_id: 'someone-else' })));
});

test('fail closed: malformed input during a run denies the action', () => {
  const p = started();
  const r = hook(p, 'PreToolUse', '{not json');
  assert.ok(denied(r));
  const clean = H.makeProject();
  assert.ok(!denied(hook(clean, 'PreToolUse', '{not json')), 'no run: not blocked');
});

test('hook payload with plugin namespace mismatch is not treated as a role', () => {
  const p = started();
  H.startStage(p, 'implementer');
  const fake = { agent_id: 'x', agent_type: 'implementer' };
  assert.ok(denied(hook(p, 'PreToolUse', WRITE(path.join(p.root, 'src', 'a.txt'), fake))));
});

test('setup problems: bad specs and missing commands', () => {
  const p = H.makeProject();
  for (const bad of [
    { scope: [] },
    { scope: ['../outside'] },
    { scope: ['C:\\Windows'] },
    { acceptance: [] },
    { checks: [] },
    { checks: [{ id: 't', kind: 'typecheck', command: 'node -e "0"' }] },
    { checks: [{ id: 'u', kind: 'test', command: 'node -e "0"' }] },
    { checks: [{ id: 'u', kind: 'test', parser: 'unittest', command: 'node -e "0"', cwd: '../..' }] },
    { checks: [{ id: 'u', kind: 'test', parser: 'unittest', command: 'node -e "0"', timeoutSec: 9999 }] },
    { checks: [{ id: 'bad id', kind: 'test', parser: 'unittest', command: 'node -e "0"' }] },
  ]) {
    const r = H.init(p, bad);
    assert.equal(r.code, 2, JSON.stringify(bad));
    assert.match(r.err, /SETUP_REQUIRED/);
  }
  const missing = H.init(p, { checks: [{ id: 'u', kind: 'test', parser: 'jest', command: 'no_such_tool_xyz --run' }] });
  assert.equal(missing.code, 2);
  assert.match(missing.err, /SETUP_REQUIRED: Command not found: u \(no_such_tool_xyz\)/);
  assert.match(H.gate(p, ['status']).out, /No active run/);
});

test('works without Git', () => {
  const p = H.makeProject({ git: false });
  assert.equal(H.init(p).code, 0);
  H.implement(p);
  H.runValidator(p);
  H.runReviewer(p);
  assert.equal(reportOf(p).result, 'PASS');
});

test('paths with spaces work end to end', () => {
  const p = H.makeProject();
  const spaced = path.join(p.root, 'my src');
  fs.mkdirSync(spaced);
  fs.writeFileSync(path.join(spaced, 'b c.txt'), 'x');
  assert.equal(H.init(p, { scope: ['my src/**'] }).code, 0);
  H.startStage(p, 'implementer');
  assert.ok(!denied(hook(p, 'PreToolUse', WRITE(path.join(spaced, 'b c.txt'), H.asAgent('implementer')))));
  fs.writeFileSync(path.join(spaced, 'b c.txt'), 'y');
  H.stopStage(p, 'implementer', { handback: 'done' });
  H.runValidator(p);
  H.runReviewer(p);
  assert.equal(reportOf(p).result, 'PASS');
});

test('evidence survives: events, log and report are written', () => {
  const p = started();
  H.implement(p);
  H.runValidator(p);
  H.runReviewer(p);
  const r = reportOf(p);
  const folder = /Evidence folder: `(.+)`/.exec(r.out)[1];
  assert.match(r.out, /\*\*Project:\*\* `[^`]+`/);
  assert.match(r.out, /- log: `[^`]+unit\.log` \(sha256/);
  for (const name of ['report.md', 'report.json', 'events.jsonl', 'spec.json', path.join('checks', 'unit.log')]) {
    assert.ok(fs.existsSync(path.join(folder, name)), name);
  }
  const json = JSON.parse(fs.readFileSync(path.join(folder, 'report.json'), 'utf8'));
  assert.equal(json.result, 'PASS');
});
