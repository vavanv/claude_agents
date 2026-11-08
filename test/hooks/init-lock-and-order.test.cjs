'use strict';
// One run at a time per project, even when two inits start together, and declared
// checks run in the approved order.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const H = require('../helpers/project.cjs');

const GATE = path.join(__dirname, '..', '..', 'plugin', 'bin', 'gate.cjs');

function lockFile(project) {
  const previous = process.env.DEV_GATE_HOME;
  process.env.DEV_GATE_HOME = project.home;
  try {
    const R = require('../../plugin/bin/lib/run.cjs');
    return path.join(R.projectDir(project.root), 'init.lock');
  } finally {
    if (previous === undefined) {
      delete process.env.DEV_GATE_HOME;
    } else {
      process.env.DEV_GATE_HOME = previous;
    }
  }
}

function initAsync(project) {
  return new Promise((resolve) => {
    const child = spawn('node', [GATE, 'init', '--project', project.root], {
      cwd: project.root,
      env: { ...process.env, DEV_GATE_HOME: project.home },
      windowsHide: true,
    });
    let err = '';
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('close', (code) => {
      resolve({ code, err });
    });
    child.stdin.end(JSON.stringify(H.spec({ checkBefore: false })));
  });
}

test('init: two concurrent inits start exactly one run', async () => {
  for (let round = 0; round < 3; round += 1) {
    const project = H.makeProject();
    const results = await Promise.all([initAsync(project), initAsync(project)]);
    const ok = results.filter((r) => r.code === 0);
    assert.equal(ok.length, 1, JSON.stringify(results));
    const loser = results.find((r) => r.code !== 0);
    assert.match(loser.err, /already active|Another run is starting/);
    assert.ok(!fs.existsSync(lockFile(project)), 'the lock is released');
    const status = JSON.parse(H.gate(project, ['status']).out);
    assert.ok(status.runId);
  }
});

test('init: a lock held by a live process refuses a second init', () => {
  const project = H.makeProject();
  const file = lockFile(project);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  const r = H.init(project, { checkBefore: false });
  assert.equal(r.code, 2);
  assert.match(r.err, /Another run is starting here/);
  assert.ok(fs.existsSync(file), 'someone else\'s lock is left alone');
});

test('init: a lock left by a dead process is cleared', () => {
  const project = H.makeProject();
  const file = lockFile(project);
  const dead = spawnSync('node', ['-e', ''], { windowsHide: true }).pid;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid: dead, at: new Date().toISOString() }));
  const r = H.init(project, { checkBefore: false });
  assert.equal(r.code, 0, r.err);
  assert.ok(!fs.existsSync(file));
});

test('validate: a later check cannot run before an earlier one', () => {
  const project = H.makeProject();
  const second = { id: 'second', kind: 'test', parser: 'unittest', command: H.PASSING, timeoutSec: 60 };
  const r = H.init(project, { checks: [H.spec().checks[0], second], checkBefore: false });
  assert.equal(r.code, 0, r.err);
  H.implement(project);
  H.startStage(project, 'validator');
  const early = H.validate(project, 'second');
  assert.equal(early.code, 2);
  assert.match(early.err, /Checks run in order\. Run unit first\./);
  assert.equal(H.validate(project, 'unit').code, 0);
  assert.equal(H.validate(project, 'second').code, 0);
});
