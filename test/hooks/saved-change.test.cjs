'use strict';
// The evidence must keep the change the run judged, so it can be read, checked against
// the result and restored once the working copy is gone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('../helpers/project.cjs');

function started(overrides) {
  const p = H.makeProject();
  const result = H.init(p, overrides);
  assert.equal(result.code, 0, result.err);
  const dir = /Evidence folder: (.+)/.exec(result.out)[1].trim();
  return { ...p, dir };
}

function manifest(p, attempt = 1) {
  return JSON.parse(fs.readFileSync(path.join(p.dir, 'changes', `attempt-${attempt}`, 'manifest.json'), 'utf8'));
}

function savedCopy(p, rel, attempt = 1) {
  return path.join(p.dir, 'changes', `attempt-${attempt}`, 'files', rel);
}

test('a passing run keeps the original and the changed file, and says so in the report', () => {
  const p = started();
  H.implement(p, 'changed\n');
  H.runValidator(p);
  H.runReviewer(p);
  const r = H.report(p);
  assert.equal(r.result, 'PASS', r.out);
  assert.equal(fs.readFileSync(path.join(p.dir, 'baseline', 'src', 'a.txt'), 'utf8'), 'original\n');
  assert.equal(fs.readFileSync(savedCopy(p, 'src/a.txt'), 'utf8'), 'changed\n');
  const m = manifest(p);
  assert.deepEqual(m.files.map((f) => [f.file, f.status, f.saved]), [['src/a.txt', 'modified', true]]);
  assert.match(r.out, /\*\*Saved change:\*\* `[^`]+attempt-1` \(1 of 1 changed files copied; originals in `baseline`\)/);
  const json = JSON.parse(fs.readFileSync(path.join(p.dir, 'report.json'), 'utf8'));
  assert.equal(json.savedChange.dir, path.join('changes', 'attempt-1'));
});

test('an added file is kept; the originals are kept without a mutation check too', () => {
  const p = started();
  H.startStage(p, 'implementer');
  fs.writeFileSync(path.join(p.root, 'src', 'new.txt'), 'new file\n');
  H.stopStage(p, 'implementer', { handback: 'done' });
  assert.equal(fs.readFileSync(savedCopy(p, 'src/new.txt'), 'utf8'), 'new file\n');
  assert.equal(manifest(p).files[0].status, 'added');
  assert.ok(fs.existsSync(path.join(p.dir, 'baseline', 'src', 'a.txt')));
});

test('an altered saved copy makes the result UNVERIFIED, never PASS', () => {
  const p = started();
  H.implement(p, 'changed\n');
  H.runValidator(p);
  H.runReviewer(p);
  fs.writeFileSync(savedCopy(p, 'src/a.txt'), 'tampered\n');
  const r = H.report(p);
  assert.equal(r.result, 'UNVERIFIED');
  assert.match(r.out, /Saved copy does not match the candidate: src\/a\.txt\./);
});

test('a missing saved copy makes the result UNVERIFIED', () => {
  const p = started();
  H.implement(p, 'changed\n');
  H.runValidator(p);
  H.runReviewer(p);
  fs.rmSync(savedCopy(p, 'src/a.txt'));
  const r = H.report(p);
  assert.equal(r.result, 'UNVERIFIED');
  assert.match(r.out, /Saved copy missing: src\/a\.txt\./);
});

test('a protected file is listed but never copied into the evidence', () => {
  const p = started({ scope: ['src/**'], protected: ['src/secret.txt'] });
  H.startStage(p, 'implementer');
  fs.writeFileSync(path.join(p.root, 'src', 'a.txt'), 'changed\n');
  fs.writeFileSync(path.join(p.root, 'src', 'secret.txt'), 'made-up secret\n');
  H.stopStage(p, 'implementer', { handback: 'done' });
  const entry = manifest(p).files.find((f) => f.file === 'src/secret.txt');
  assert.deepEqual([entry.saved, entry.reason], [false, 'protected']);
  assert.ok(!fs.existsSync(savedCopy(p, 'src/secret.txt')));
  const all = fs.readdirSync(p.dir, { recursive: true }).map(String);
  for (const rel of all) {
    const abs = path.join(p.dir, rel);
    if (fs.statSync(abs).isFile()) {
      assert.doesNotMatch(fs.readFileSync(abs, 'utf8'), /made-up secret/, rel);
    }
  }
});

test('a repair keeps each attempt\'s change in its own folder', () => {
  const p = started();
  H.implement(p, 'changed\n');
  H.runValidator(p);
  H.runReviewer(p, 'Problem.\n{"verdict":"REQUEST_CHANGES","findings":["src/a.txt:1: wrong"]}');
  H.implement(p, 'repaired\n');
  H.runValidator(p);
  H.runReviewer(p);
  const r = H.report(p);
  assert.equal(r.result, 'PASS', r.out);
  assert.equal(fs.readFileSync(savedCopy(p, 'src/a.txt', 1), 'utf8'), 'changed\n');
  assert.equal(fs.readFileSync(savedCopy(p, 'src/a.txt', 2), 'utf8'), 'repaired\n');
  assert.equal((r.out.match(/\*\*Saved change:\*\*/g) || []).length, 2);
});
