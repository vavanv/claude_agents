'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { findProtected, globMatcher, matchesAny, projectRelative } = require('../../plugin/bin/lib/glob.cjs');
const { parseCounts } = require('../../plugin/bin/lib/parsers.cjs');
const { takeInventory, diffInventories, fingerprint } = require('../../plugin/bin/lib/inventory.cjs');
const { auditModel, finalMessage, parseVerdict } = require('../../plugin/bin/lib/transcript.cjs');
const { makeProject, tempDir, writeTranscript } = require('../helpers/project.cjs');

test('glob: wildcards, directories and exact paths', () => {
  assert.ok(matchesAny('src/a/b.ts', ['src/**']));
  assert.ok(matchesAny('src/a/b.ts', ['src']));
  assert.ok(matchesAny('src/a/b.ts', ['src/']));
  assert.ok(matchesAny('src/b.ts', ['src/*.ts']));
  assert.ok(!matchesAny('src/a/b.ts', ['src/*.ts']));
  assert.ok(matchesAny('a/b/.env', ['**/.env']));
  assert.ok(matchesAny('.env', ['**/.env']));
  assert.ok(matchesAny('.env.local', ['.env.*']));
  assert.ok(!matchesAny('srcs/a.ts', ['src']));
  assert.ok(matchesAny('my file (1).txt', ['my file (1).txt']));
});

test('projectRelative: rejects traversal and the root itself', () => {
  const { root } = makeProject();
  assert.equal(projectRelative(root, path.join(root, 'src', 'new.txt')), 'src/new.txt');
  assert.equal(projectRelative(root, 'src/deep/missing/new.txt'), 'src/deep/missing/new.txt');
  assert.equal(projectRelative(root, path.join(root, '..', 'escape.txt')), null);
  assert.equal(projectRelative(root, root), null);
});

test('projectRelative: a link inside the project cannot lead outside it', () => {
  const { root } = makeProject();
  const outside = tempDir('devgate-outside-');
  try {
    fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
  } catch (err) {
    assert.fail(`could not create a junction: ${err.message}`);
  }
  assert.equal(projectRelative(root, path.join(root, 'link', 'x.txt')), null);
});

function searchTree() {
  const root = tempDir('devgate-search-');
  fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(root, 'private'));
  fs.writeFileSync(path.join(root, 'src', 'deep', 'a.txt'), 'a');
  fs.writeFileSync(path.join(root, 'private', 'x.txt'), 'x');
  return root;
}

test('findProtected: reports protected names at any depth, and allows clean trees', () => {
  const root = searchTree();
  const off = ['private', '**/.env'];
  assert.equal(findProtected(root, 'src', globMatcher(off)), null);
  assert.equal(findProtected(root, 'src/deep/a.txt', globMatcher(off)), null);
  assert.equal(findProtected(root, 'private', globMatcher(off)), 'private');
  assert.equal(findProtected(root, 'private/x.txt', globMatcher(off)), 'private/x.txt');
  assert.equal(findProtected(root, '.', globMatcher(off)), 'private');
  assert.equal(findProtected(root, path.join(root, '..'), globMatcher(off)), path.dirname(fs.realpathSync.native(root)));
  fs.writeFileSync(path.join(root, 'src', 'deep', '.env'), 'secret');
  assert.equal(findProtected(root, 'src', globMatcher(off)), 'src/deep/.env');
  assert.throws(() => findProtected(root, 'missing', globMatcher(off)), /ENOENT/);
});

test('findProtected: follows links to their real paths, and survives loops', () => {
  const root = searchTree();
  const off = ['private'];
  const link = path.join(root, 'src', 'link');
  fs.symlinkSync(path.join(root, 'private'), link, 'junction');
  assert.equal(findProtected(root, 'src', globMatcher(off)), 'private');
  assert.equal(findProtected(root, 'src/link', globMatcher(off)), 'private');
  fs.rmSync(link, { recursive: true });

  const outside = tempDir('devgate-outside-');
  fs.symlinkSync(outside, link, 'junction');
  assert.equal(findProtected(root, 'src', globMatcher(off)), link.replace(fs.realpathSync(root), fs.realpathSync.native(root)));
  fs.rmSync(link, { recursive: true });

  fs.symlinkSync(path.join(root, 'src'), link, 'junction');
  assert.equal(findProtected(root, 'src', globMatcher(off)), null);
});

test('findProtected: skips a dangling link, but still finds what follows it', () => {
  const root = searchTree();
  const gone = path.join(root, 'gone');
  fs.mkdirSync(gone);
  fs.symlinkSync(gone, path.join(root, 'src', 'dangling'), 'junction');
  fs.rmSync(gone, { recursive: true });
  assert.equal(findProtected(root, 'src', globMatcher(['private'])), null);
  fs.writeFileSync(path.join(root, 'src', 'z.env'), 'secret');
  assert.equal(findProtected(root, 'src', globMatcher(['**/z.env'])), 'src/z.env');
});

test('findProtected: resolves links only, so its cost does not grow with plain files', () => {
  const root = searchTree();
  for (let i = 0; i < 500; i += 1) {
    fs.writeFileSync(path.join(root, 'src', `f${i}.js`), '');
  }
  const original = fs.realpathSync.native;
  let calls = 0;
  fs.realpathSync.native = (...args) => { calls += 1; return original(...args); };
  try {
    assert.equal(findProtected(root, 'src', globMatcher(['private'])), null);
  } finally {
    fs.realpathSync.native = original;
  }
  assert.ok(calls <= 2, `expected the root and target only, got ${calls} realpath calls`);
});

test('parsers: real output shapes', () => {
  assert.deepEqual(parseCounts({ parser: 'unittest' }, 'x\nRan 4 tests in 0.001s\n\nOK\n'),
    { passed: 4, failed: 0, skipped: 0, total: 4 });
  assert.deepEqual(parseCounts({ parser: 'unittest' }, 'Ran 5 tests in 0.1s\n\nFAILED (failures=1, errors=1, skipped=1)\n'),
    { passed: 2, failed: 2, skipped: 1, total: 5 });
  assert.deepEqual(parseCounts({ parser: 'unittest' }, 'Ran 0 tests in 0.000s\n\nNO TESTS RAN\n'), null);
  assert.deepEqual(parseCounts({ parser: 'jest' }, 'Tests:       1 failed, 2 skipped, 3 passed, 6 total\n'),
    { passed: 3, failed: 1, skipped: 2, total: 6 });
  assert.deepEqual(parseCounts({ parser: 'jest' }, '\u001b[1mTests:\u001b[22m       35 passed, 35 total\r\n'),
    { passed: 35, failed: 0, skipped: 0, total: 35 });
  assert.deepEqual(parseCounts({ parser: 'node-test' }, '# tests 3\n# pass 2\n# fail 1\n# skipped 0\n'),
    { passed: 2, failed: 1, skipped: 0, total: 3 });
  assert.deepEqual(parseCounts({ parser: 'node-test' }, 'ℹ tests 2\nℹ pass 2\nℹ fail 0\n'),
    { passed: 2, failed: 0, skipped: 0, total: 2 });
  assert.deepEqual(parseCounts({ parser: 'pytest' }, '==== 1 failed, 3 passed, 1 skipped in 0.12s ====\n'),
    { passed: 3, failed: 1, skipped: 1, total: 5 });
  assert.deepEqual(parseCounts({ parser: 'vitest' }, '      Tests  1 failed | 3 passed (4)\n'),
    { passed: 3, failed: 1, skipped: 0, total: 4 });
  const regexCheck = { parser: 'regex', countRegex: '(?<passed>\\d+) passed, (?<failed>\\d+) failed' };
  assert.deepEqual(parseCounts(regexCheck, 'done: 4 passed, 0 failed\n'), { passed: 4, failed: 0, skipped: 0, total: 4 });
  assert.equal(parseCounts({ parser: 'jest' }, 'no summary here'), null);
  assert.equal(parseCounts({ parser: 'unknown' }, 'Tests: 1 passed, 1 total'), null);
});

test('inventory: added, removed and modified files; ignored files; spaces', () => {
  const { root } = makeProject();
  fs.writeFileSync(path.join(root, '.gitignore'), 'ignored.txt\n');
  fs.writeFileSync(path.join(root, 'ignored.txt'), 'x');
  fs.writeFileSync(path.join(root, 'with space.txt'), 'x');
  const before = takeInventory(root);
  assert.equal(before.method, 'git-ls-files');
  assert.ok('with space.txt' in before.files);
  assert.ok(!('ignored.txt' in before.files));
  fs.writeFileSync(path.join(root, 'src', 'a.txt'), 'changed');
  fs.writeFileSync(path.join(root, 'new.txt'), 'new');
  fs.rmSync(path.join(root, 'other.txt'));
  const after = takeInventory(root);
  const diff = diffInventories(before.files, after.files);
  assert.deepEqual(diff.modified, ['src/a.txt']);
  assert.deepEqual(diff.added, ['new.txt']);
  assert.deepEqual(diff.removed, ['other.txt']);
  assert.notEqual(fingerprint(before.files), fingerprint(after.files));
});

test('inventory: line endings count as a change, and declared artifacts do not', () => {
  const { root } = makeProject();
  const before = takeInventory(root, ['coverage/**']);
  fs.writeFileSync(path.join(root, 'src', 'a.txt'), 'original\r\n');
  fs.mkdirSync(path.join(root, 'coverage'));
  fs.writeFileSync(path.join(root, 'coverage', 'r.txt'), 'x');
  const after = takeInventory(root, ['coverage/**']);
  assert.deepEqual(diffInventories(before.files, after.files).changed, ['src/a.txt']);
});

test('inventory: works outside Git and skips dependency folders', () => {
  const { root } = makeProject({ git: false });
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'node_modules', 'x.js'), 'x');
  const inv = takeInventory(root);
  assert.equal(inv.method, 'walk');
  assert.deepEqual(Object.keys(inv.files).sort(), ['other.txt', 'src/a.txt']);
});

test('transcript: model audit outcomes', () => {
  const project = makeProject();
  const file = writeTranscript(project, 'x', { model: 'claude-haiku-5-5', handback: 'hi' });
  assert.equal(auditModel(file, 'claude-haiku-5-5').status, 'MATCH');
  assert.equal(auditModel(file, 'claude-opus-5-5').status, 'MISMATCH');
  assert.equal(auditModel(file, null).status, 'UNVERIFIED');
  assert.equal(auditModel(path.join(project.home, 'missing.jsonl'), 'm').status, 'UNVERIFIED');
});

test('transcript: an earlier wrong model is not hidden by a later match', () => {
  const project = makeProject();
  const file = path.join(project.home, 'mixed.jsonl');
  const rec = (model) => JSON.stringify({ type: 'assistant', message: { model, content: [] } });
  fs.writeFileSync(file, `${rec('claude-opus-5-5')}\n${rec('claude-haiku-5-5')}\nnot json\n`);
  assert.equal(auditModel(file, 'claude-haiku-5-5').status, 'MISMATCH');
});

test('transcript: final message from each known shape', () => {
  const project = makeProject();
  assert.equal(finalMessage({ last_assistant_message: 'direct' }), 'direct');
  const handback = writeTranscript(project, 'a', { model: 'm', handback: 'from handback' });
  assert.equal(finalMessage({ agent_transcript_path: handback }), 'from handback');
  const text = writeTranscript(project, 'b', { model: 'm', text: 'plain text' });
  assert.equal(finalMessage({ agent_transcript_path: text }), 'plain text');
  assert.equal(finalMessage({ agent_transcript_path: path.join(project.home, 'none') }), '');
});

test('transcript: a handback verdict survives closing text after it', () => {
  const project = makeProject();
  const verdict = '{"verdict":"APPROVE","findings":[]}';
  const file = path.join(project.home, 'closing-transcript.jsonl');
  const records = [
    { type: 'user' },
    { type: 'assistant', message: { model: 'm', content: [{ type: 'tool_use', name: 'SubagentHandback', input: { message: verdict } }] } },
    { type: 'assistant', message: { model: 'm', content: [{ type: 'text', text: 'Review complete.' }] } },
  ];
  fs.writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  assert.equal(finalMessage({ agent_transcript_path: file }), verdict);
  const withClosing = { agent_transcript_path: file, last_assistant_message: 'Review complete.' };
  assert.equal(parseVerdict(finalMessage(withClosing)).verdict, 'APPROVE');
  // The handback is the one source: a bad handback is not rescued by other text.
  const bad = writeTranscript(project, 'bad', { model: 'm', handback: 'no verdict here' });
  assert.equal(parseVerdict(finalMessage({ agent_transcript_path: bad, last_assistant_message: verdict })), null);
});

test('verdict: strict last-line parsing', () => {
  assert.equal(parseVerdict('Looks fine.\n{"verdict":"APPROVE","findings":[]}').verdict, 'APPROVE');
  assert.equal(parseVerdict('`{"verdict":"APPROVE","findings":[]}`'), null);
  assert.deepEqual(parseVerdict('{"verdict":"REQUEST_CHANGES","findings":["a.ts:1: bad"]}').findings, ['a.ts:1: bad']);
  assert.equal(parseVerdict('I approve this.'), null);
  assert.equal(parseVerdict('{"verdict":"MAYBE"}'), null);
  assert.equal(parseVerdict('{"verdict":'), null);
  assert.equal(parseVerdict(''), null);
});
