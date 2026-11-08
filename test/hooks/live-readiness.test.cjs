'use strict';
// Problems found reviewing the plugin for live use: one project named two ways, a check
// that outlasts its stage, and a search path the guard can't check. No models.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const H = require('../helpers/project.cjs');

const GATE = path.join(__dirname, '..', '..', 'plugin', 'bin', 'gate.cjs');

function started(overrides) {
  const p = H.makeProject();
  const result = H.init(p, overrides);
  assert.equal(result.code, 0, result.err);
  return { ...p, dir: /Evidence folder: (.+)/.exec(result.out)[1].trim() };
}

function allowsNextStage(p, env) {
  return !H.denied(H.hook(p, 'PreToolUse', {
    tool_name: 'Agent', tool_input: { subagent_type: 'dev-gate:implementer', prompt: 'go' },
  }, { env }));
}

test('a project opened through a link is still the same project', () => {
  const p = started();
  const link = path.join(H.tempDir('devgate-link-'), 'via');
  fs.symlinkSync(p.root, link, 'junction');
  assert.ok(allowsNextStage(p, { CLAUDE_PROJECT_DIR: link }));
});

test('a project named with a lower-case drive letter is still the same project', { skip: process.platform !== 'win32' }, () => {
  const p = started();
  const lower = p.root[0].toLowerCase() + p.root.slice(1);
  assert.ok(allowsNextStage(p, { CLAUDE_PROJECT_DIR: lower }));
});

test('state that names a different project is still refused', () => {
  const p = started();
  const file = path.join(p.dir, 'state.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...state, projectRoot: H.tempDir('devgate-other-') }));
  const result = H.spawnStage(p, 'implementer');
  assert.match(result.output.hookSpecificOutput.permissionDecisionReason, /inconsistent state/);
});

// A test command that stays running until the test releases it.
function slowCommand(p) {
  const started = path.join(p.home, 'started').replace(/\\/g, '/');
  const release = path.join(p.home, 'release').replace(/\\/g, '/');
  const script = path.join(p.home, 'slow.js');
  fs.writeFileSync(script, `const fs = require('fs');
fs.writeFileSync('${started}', '');
const wait = setInterval(() => {
  if (!fs.existsSync('${release}')) return;
  clearInterval(wait);
  console.log('Ran 4 tests in 0.01s');
  console.log('OK');
}, 20);
`);
  return {
    command: `node "${script.replace(/\\/g, '/')}"`,
    release: () => fs.writeFileSync(release, ''),
    hasStarted: async () => {
      for (let i = 0; i < 1500 && !fs.existsSync(started); i += 1) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(fs.existsSync(started), 'the slow check never started');
    },
  };
}

function gateInBackground(p, args) {
  const child = spawn('node', [GATE, ...args, '--project', p.root], {
    cwd: p.root, env: { ...process.env, DEV_GATE_HOME: p.home }, stdio: 'ignore', windowsHide: true,
  });
  return new Promise((resolve) => { child.on('close', resolve); });
}

const events = (p) => fs.readFileSync(path.join(p.dir, 'events.jsonl'), 'utf8');
const status = (p) => JSON.parse(H.gate(p, ['status']).out);

function assertHaltKept(p, code) {
  assert.equal(code, 1);
  const after = status(p);
  assert.equal(after.stage, 'reviewer_ready');
  assert.equal(after.halt.result, 'UNVERIFIED');
  assert.match(events(p), /"event":"late_result"/);
  const stop = H.hook(p, 'Stop', { stop_hook_active: false });
  assert.equal(stop.output.decision, 'block');
  assert.match(stop.output.reason, /gate report/);
  const report = H.report(p);
  assert.equal(report.code, 0, report.err);
  assert.equal(report.result, 'UNVERIFIED');
}

test('a check that outlasts the validator stage cannot undo what the hook recorded', async () => {
  const q = H.makeProject();
  const check = slowCommand(q);
  const init = H.init(q, { checks: [{ id: 'unit', kind: 'test', parser: 'unittest', command: check.command, timeoutSec: 60 }], checkBefore: false });
  q.dir = /Evidence folder: (.+)/.exec(init.out)[1].trim();
  H.implement(q);
  H.startStage(q, 'validator');
  const finished = gateInBackground(q, ['validate', '--check', 'unit']);
  await check.hasStarted();
  H.stopStage(q, 'validator', { handback: 'done' });
  check.release();
  assertHaltKept(q, await finished);
});

test('a mutation check that outlasts the validator stage cannot undo what the hook recorded', async () => {
  const q = H.makeProject();
  const check = slowCommand(q);
  fs.writeFileSync(path.join(q.root, 'src', 'age.js'), 'module.exports = {};\n');
  const init = H.init(q, { mutation: { command: check.command } });
  assert.equal(init.code, 0, init.err);
  q.dir = /Evidence folder: (.+)/.exec(init.out)[1].trim();
  H.startStage(q, 'implementer');
  fs.writeFileSync(path.join(q.root, 'src', 'age.js'), 'module.exports = (age) => age >= 18;\n');
  H.stopStage(q, 'implementer', { handback: 'done' });
  H.startStage(q, 'validator');
  assert.equal(H.validate(q).code, 0);
  const finished = gateInBackground(q, ['validate', '--mutation']);
  await check.hasStarted();
  H.stopStage(q, 'validator', { handback: 'done' });
  check.release();
  assertHaltKept(q, await finished);
});

test('a check still running when the run is closed leaves the closed run alone', async () => {
  const q = H.makeProject();
  const check = slowCommand(q);
  const init = H.init(q, { checks: [{ id: 'unit', kind: 'test', parser: 'unittest', command: check.command, timeoutSec: 60 }], checkBefore: false });
  q.dir = /Evidence folder: (.+)/.exec(init.out)[1].trim();
  H.implement(q);
  H.startStage(q, 'validator');
  const finished = gateInBackground(q, ['validate', '--check', 'unit']);
  await check.hasStarted();
  assert.match(H.gate(q, ['abort', '--reason', 'test']).out, /^# Result: UNVERIFIED/m);
  const file = path.join(q.dir, 'state.json');
  const closed = fs.readFileSync(file, 'utf8');
  check.release();
  assert.equal(await finished, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), closed);
  assert.match(H.gate(q, ['status']).out, /No active run/);
});

function grep(p, target, extra = {}) {
  return H.hook(p, 'PreToolUse', { tool_name: 'Grep', tool_input: { pattern: 'x', path: target }, ...H.asAgent('reviewer'), ...extra });
}

test('Grep on a missing path is refused as a path problem, without suggesting an abort', () => {
  const p = started();
  const result = grep(p, path.join(p.root, 'nope'));
  assert.ok(H.denied(result));
  const reason = result.output.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /Correct the path/);
  assert.doesNotMatch(reason, /abort/);
});

test('a dangling link does not stop a search, and a protected file beside it still does', () => {
  const p = started({ protected: ['src/private.txt'] });
  const gone = path.join(p.root, 'gone');
  fs.mkdirSync(gone);
  fs.symlinkSync(gone, path.join(p.root, 'src', 'dangling'), 'junction');
  fs.rmSync(gone, { recursive: true });
  assert.ok(!H.denied(grep(p, path.join(p.root, 'src'))));
  fs.writeFileSync(path.join(p.root, 'src', 'private.txt'), 'secret');
  assert.ok(H.denied(grep(p, path.join(p.root, 'src'))));
});

test('a relative Grep path is checked where the agent is, not at the project root', () => {
  const p = started();
  const app = path.join(p.root, 'app');
  fs.mkdirSync(path.join(app, 'config'), { recursive: true });
  fs.writeFileSync(path.join(app, 'config', '.env'), 'secret');
  fs.mkdirSync(path.join(p.root, 'config'));
  assert.ok(H.denied(grep(p, 'config', { cwd: app })));
  assert.ok(!H.denied(grep(p, 'config', { cwd: p.root })));
});
