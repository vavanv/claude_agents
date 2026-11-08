'use strict';
// G2: the reviewer states how each acceptance criterion is checked, and the report lists
// the criteria with no named test. It is a statement, not a measurement, so it never
// changes the result.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('../helpers/project.cjs');
const { parseVerdict } = require('../../plugin/bin/lib/transcript.cjs');

const TWO = { acceptance: ['a.txt says changed', 'nothing else changes'] };

function reviewed(verdictLine, overrides = TWO) {
  const p = H.makeProject();
  assert.equal(H.init(p, overrides).code, 0);
  H.implement(p, 'changed\n');
  H.runValidator(p);
  H.runReviewer(p, verdictLine);
  const r = H.report(p);
  const dir = /Evidence folder: `(.+)`/.exec(r.out)[1];
  return { r, json: JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8')) };
}

test('parseVerdict keeps a valid coverage list, and a malformed one never spoils the verdict', () => {
  const ok = parseVerdict('{"verdict":"APPROVE","findings":[],"coverage":[{"criterion":1,"by":"test","where":"t.py:3"},{"criterion":2,"by":"reading"},{"criterion":1,"by":"reading"}]}');
  assert.deepEqual(ok.coverage, [{ criterion: 1, by: 'test', where: 't.py:3' }, { criterion: 2, by: 'reading', where: null }]);
  for (const bad of ['"yes"', '[{"criterion":0,"by":"test"}]', '[{"criterion":1,"by":"guess"}]', '[null]', '[{"criterion":"1","by":"test"}]']) {
    const v = parseVerdict(`{"verdict":"APPROVE","findings":[],"coverage":${bad}}`);
    assert.equal(v.verdict, 'APPROVE');
    assert.equal(v.coverage, null, bad);
  }
  assert.equal(parseVerdict('{"verdict":"APPROVE","findings":[]}').coverage, null);
});

test('the reviewer is given the criteria by number', () => {
  const p = H.makeProject();
  assert.equal(H.init(p, TWO).code, 0);
  H.implement(p);
  H.runValidator(p);
  H.spawnStage(p, 'reviewer');
  const started = H.hook(p, 'SubagentStart', H.asAgent('reviewer'));
  const context = started.output.hookSpecificOutput.additionalContext;
  assert.match(context, /^1\. a\.txt says changed$/m);
  assert.match(context, /^2\. nothing else changes$/m);
});

test('every criterion with a named test: PASS with no note', () => {
  const { r, json } = reviewed('{"verdict":"APPROVE","findings":[],"coverage":[{"criterion":1,"by":"test","where":"t.py:3"},{"criterion":2,"by":"test","where":"t.py:9"}]}');
  assert.equal(r.result, 'PASS', r.out);
  assert.doesNotMatch(r.out, /\*\*Note:\*\*/);
  assert.match(r.out, /^1\. a\.txt says changed: \*\*test, `t\.py:3`\*\*$/m);
  assert.deepEqual(json.coverage.map((c) => c.by), ['test', 'test']);
});

test('a criterion checked only by reading is listed and noted, and the result is still PASS', () => {
  const { r, json } = reviewed('{"verdict":"APPROVE","findings":[],"coverage":[{"criterion":1,"by":"test","where":"t.py:3"},{"criterion":2,"by":"reading"}]}');
  assert.equal(r.result, 'PASS', r.out);
  assert.match(r.out, /^- \*\*Note:\*\* the reviewer didn't name a test for criteria 2\./m);
  assert.match(r.out, /^2\. nothing else changes: \*\*checked only by reading\*\*$/m);
  assert.deepEqual(json.coverage[1], { criterion: 2, text: 'nothing else changes', by: 'reading', where: null });
});

test('no coverage list, or a test with no name, counts as not stated', () => {
  const none = reviewed('{"verdict":"APPROVE","findings":[]}');
  assert.equal(none.r.result, 'PASS');
  assert.match(none.r.out, /The reviewer gave no readable coverage list\./);
  assert.match(none.r.out, /criteria 1, 2\./);
  assert.deepEqual(none.json.coverage.map((c) => c.by), ['not_stated', 'not_stated']);
  const unnamed = reviewed('{"verdict":"APPROVE","findings":[],"coverage":[{"criterion":1,"by":"test"},{"criterion":2,"by":"test","where":"t.py:1"},{"criterion":7,"by":"test","where":"x"}]}');
  assert.match(unnamed.r.out, /criteria 1\./);
  assert.match(unnamed.r.out, /^1\. a\.txt says changed: \*\*test, none named\*\*$/m);
});

test('a rejection still lists coverage, with no PASS note', () => {
  const { r } = reviewed('{"verdict":"REQUEST_CHANGES","findings":["src/a.txt:1: wrong"],"coverage":[{"criterion":1,"by":"reading"}]}', { ...TWO, maxRepairs: 0 });
  assert.equal(r.result, 'FAILED');
  assert.doesNotMatch(r.out, /\*\*Note:\*\*/);
  assert.match(r.out, /^1\. a\.txt says changed: \*\*checked only by reading\*\*$/m);
  assert.match(r.out, /^2\. nothing else changes: \*\*not stated\*\*$/m);
});

// Decision D6: opt-in spec.requireTests turns a criterion with no named test into a
// rejection: one repair, then FAILED. No readable list at all is UNVERIFIED.
const REQUIRED = { ...TWO, requireTests: true };
const ALL_TESTED = '{"verdict":"APPROVE","findings":[],"coverage":[{"criterion":1,"by":"test","where":"t.py:3"},{"criterion":2,"by":"test","where":"t.py:9"}]}';
const ONE_READ = '{"verdict":"APPROVE","findings":[],"coverage":[{"criterion":1,"by":"test","where":"t.py:3"},{"criterion":2,"by":"reading"}]}';

test('requireTests: must be true or false', () => {
  const p = H.makeProject();
  const r = H.init(p, { ...TWO, requireTests: 'yes' });
  assert.match(r.err + r.out, /SETUP_REQUIRED: spec\.requireTests must be true or false/);
});

test('requireTests: every criterion with a named test is a PASS', () => {
  const { r } = reviewed(ALL_TESTED, REQUIRED);
  assert.equal(r.result, 'PASS', r.out);
  assert.match(r.out, /The spec requires a named test for each criterion\./);
});

test('requireTests: an approval with an untested criterion goes to repair, with a finding for it', () => {
  const p = H.makeProject();
  assert.equal(H.init(p, REQUIRED).code, 0);
  H.implement(p, 'changed\n');
  H.runValidator(p);
  H.runReviewer(p, ONE_READ);
  const status = JSON.parse(H.gate(p, ['status']).out);
  assert.equal(status.next, 'implementer');
  H.startStage(p, 'implementer');
  const context = H.hook(p, 'SubagentStart', H.asAgent('implementer')).output.hookSpecificOutput.additionalContext;
  assert.match(context, /Criterion 2 \(nothing else changes\): the reviewer named no test/);
  assert.match(context, /requires a test for each criterion/);
  fs.writeFileSync(path.join(p.root, 'src', 'a.txt'), 'repaired\n');
  H.stopStage(p, 'implementer', { handback: 'done' });
  H.runValidator(p);
  H.runReviewer(p, ALL_TESTED);
  assert.equal(H.report(p).result, 'PASS');
});

test('requireTests: still untested with no repair left is FAILED', () => {
  const { r } = reviewed(ONE_READ, { ...REQUIRED, maxRepairs: 0 });
  assert.equal(r.result, 'FAILED');
  assert.match(r.out, /named no test for some criteria/);
});

test('requireTests: no readable coverage list is UNVERIFIED, never repaired', () => {
  const { r, json } = reviewed('{"verdict":"APPROVE","findings":[]}', REQUIRED);
  assert.equal(r.result, 'UNVERIFIED');
  assert.equal(json.repairs, 0);
  assert.match(r.out, /gave no readable coverage list/);
});

test('requireTests: the reviewer is told the gate applies it', () => {
  const p = H.makeProject();
  assert.equal(H.init(p, REQUIRED).code, 0);
  H.implement(p);
  H.runValidator(p);
  H.spawnStage(p, 'reviewer');
  const context = H.hook(p, 'SubagentStart', H.asAgent('reviewer')).output.hookSpecificOutput.additionalContext;
  assert.match(context, /requires a named test for each criterion\. The gate applies that/);
});

test('without requireTests, an untested criterion never triggers a repair', () => {
  const { json } = reviewed(ONE_READ);
  assert.equal(json.result, 'PASS');
  assert.equal(json.repairs, 0);
});
