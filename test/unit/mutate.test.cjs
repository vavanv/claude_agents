'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const M = require('../../plugin/bin/lib/mutate.cjs');
const { createSandbox, removeSandbox } = require('../../plugin/bin/lib/sandbox.cjs');
const { tempDir } = require('../helpers/project.cjs');

function mutantsOf(text, language = 'js', lines = null) {
  const changed = lines || new Set(text.split('\n').map((_, i) => i + 1));
  return M.generateMutants(text, language, changed).map((m) => M.applyMutant(text, m));
}

test('changedLines finds added and edited lines, and treats a new file as all changed', () => {
  assert.deepStrictEqual([...M.changedLines('a\nb\nc\n', 'a\nB\nc\nd\n')].sort(), [2, 4]);
  assert.deepStrictEqual([...M.changedLines(null, 'x\ny')], [1, 2]);
  assert.deepStrictEqual([...M.changedLines('a\nb\n', 'a\nb\n')], []);
  assert.deepStrictEqual([...M.changedLines('a\nb\n', 'a\r\nb\r\n')], [], 'line endings alone are not a change');
  assert.deepStrictEqual([...M.changedLines('a\nb\nc\nd\n', 'a\nx\nb\nd\n')], [2], 'a removal does not mark kept lines');
});

test('masking: strings, comments, templates and regexes are never mutated', () => {
  const source = [
    "const a = 'x === y';",
    'const b = "1 + 2"; // 3 + 4',
    '/* if (true) 5 */',
    'const c = `v ${d === 1} + 2`;',
    'const e = /a + b|c/.test(f);',
  ].join('\n');
  assert.deepStrictEqual(mutantsOf(source), []);
  assert.deepStrictEqual(mutantsOf('s = "a == 1"  # b == 2\nt = """c == 3\nd == 4"""\n', 'py'), []);
});

test('masking keeps offsets correct after characters outside the basic plane', () => {
  const source = "const a = '😀😀';\nd = b === c;\n";
  assert.deepStrictEqual(mutantsOf(source), ["const a = '😀😀';\nd = b !== c;\n"]);
});

test('returned values are replaced, unless there is nothing to replace', () => {
  assert.deepStrictEqual(mutantsOf('    return lower  # note\n', 'py'), ['    return None  # note\n']);
  assert.deepStrictEqual(mutantsOf('  return f(a, b);\n'), ['  return undefined;\n']);
  assert.deepStrictEqual(mutantsOf('  return g({\n    a,\n  });\n', 'js', new Set([1])), ['  return undefined;\n']);
  for (const source of ['return;\n', 'return null;\n', 'return undefined;\n']) {
    assert.deepStrictEqual(mutantsOf(source), [], source);
  }
  assert.deepStrictEqual(mutantsOf('return None\n', 'py'), []);
  assert.deepStrictEqual(mutantsOf('return\n', 'py'), []);
});

test('JS: the operators that matter are generated', () => {
  const has = (source, expected) => assert.ok(mutantsOf(source).includes(expected), `${source} -> ${expected}\n${mutantsOf(source).join('\n')}`);
  has('x = a === b;', 'x = a !== b;');
  has('x = a && b;', 'x = a || b;');
  has('x = a <= b;', 'x = a < b;');
  has('x = a > b;', 'x = a >= b;');
  has('x = a + b;', 'x = a - b;');
  has('x = true;', 'x = false;');
  has('x = 3;', 'x = 4;');
  has('if (a && b) { c(); }', 'if (false) { c(); }');
  has('if (a && b) { c(); }', 'if (true) { c(); }');
});

test('JS: ternary conditions are forced, including across lines', () => {
  const inline = 'return now <= end ? new Date(end) : null;';
  assert.ok(mutantsOf(inline).includes('return true ? new Date(end) : null;'));
  assert.ok(mutantsOf(inline).includes('return false ? new Date(end) : null;'));
  assert.ok(mutantsOf('const x = f(a > b ? 1 : 2);').includes('const x = f(true ? 1 : 2);'));
  const broken = 'const x = a > b\n  ? 1\n  : 2;';
  assert.ok(mutantsOf(broken).includes('const x = true\n  ? 1\n  : 2;'));
});

test('JS: syntax that only looks like an operator is left alone', () => {
  for (const source of [
    'const a: Array<string> = [];',
    'function f(a?: string) {}',
    'const f = (a) => a;',
    'i++;',
    'const x = -a;',
    'a?.b;',
    'const x = a ?? b;',
    "import * as a from 'b';",
    'type A = B extends C ? 1 : 2;',
    'interface A { b: 1 }',
    '@Max(3)',
  ]) {
    assert.deepStrictEqual(mutantsOf(source), [], source);
  }
});

test('Python: conditions and operators are generated, signatures are skipped', () => {
  const statement = mutantsOf('    if a and b:\n        pass\n', 'py');
  assert.ok(statement.includes('    if True:\n        pass\n'));
  assert.ok(statement.includes('    if False:\n        pass\n'));
  assert.ok(statement.includes('    if a or b:\n        pass\n'));
  assert.ok(mutantsOf('x = a if b > c else d\n', 'py').includes('x = a if True else d\n'));
  assert.ok(mutantsOf('    elif a == 1:\n', 'py').includes('    elif a != 1:\n'));
  assert.deepStrictEqual(mutantsOf('def f(a=1, b=True):\n', 'py'), []);
  assert.deepStrictEqual(mutantsOf('import a\n', 'py'), []);
});

test('only changed lines are mutated', () => {
  const source = 'x = a === b;\ny = c === d;\n';
  assert.deepStrictEqual(mutantsOf(source, 'js', new Set([2])), ['x = a === b;\ny = c !== d;\n']);
});

test('test files, config and types are recognised; unknown languages have none', () => {
  for (const rel of ['src/a.spec.ts', 'src/a.test.js', 'test/a.ts', 'src/__tests__/a.ts', 'test_a.py', 'pkg/tests/a.py', 'conftest.py', 'test_calculator.ts']) {
    assert.ok(M.isTestFile(rel), rel);
  }
  for (const rel of ['src/a.ts', 'src/contest.ts', 'latest/a.py']) {
    assert.ok(!M.isTestFile(rel), rel);
  }
  assert.ok(M.isConfigOrTypes('jest.config.cjs'));
  assert.ok(M.isConfigOrTypes('src/a.d.ts'));
  assert.strictEqual(M.languageOf('a.tsx'), 'js');
  assert.strictEqual(M.languageOf('a.py'), 'py');
  assert.strictEqual(M.languageOf('a.go'), null);
  assert.strictEqual(M.languageOf('README'), null);
});

test('selection: stays within the limit, covers lines first, prefers conditions, is repeatable', () => {
  const mutant = (line, priority, start) => ({ file: 'a.ts', line, priority, start, end: start + 1 });
  const all = [mutant(1, 0, 0), mutant(1, 2, 1), mutant(2, 3, 10), mutant(3, 0, 20), mutant(3, 1, 21)];
  assert.strictEqual(M.selectMutants(all, 99).length, 5);
  const three = M.selectMutants(all, 3);
  assert.deepStrictEqual(three.map((m) => [m.line, m.priority]), [[1, 0], [2, 3], [3, 0]]);
  const two = M.selectMutants(all, 2);
  assert.deepStrictEqual(two.map((m) => m.priority), [0, 0], 'conditions come before a line with only a number');
  assert.deepStrictEqual(M.selectMutants(all, 3), three);
});

test('describeMutant shows the whole line before and after', () => {
  const source = 'a();\n  const s = x   === y;\nb();\n';
  const [mutant] = M.generateMutants(source, 'js', new Set([2]));
  assert.deepStrictEqual(M.describeMutant(source, mutant), { original: 'const s = x === y;', mutated: 'const s = x !== y;' });
});

test('sandbox: copies the candidate, leaves out protected files, links dependencies', () => {
  const root = tempDir('devgate-box-');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'a');
  fs.writeFileSync(path.join(root, '.env'), 'secret');
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), 'dep');
  const box = createSandbox(root, ['src/a.js', '.env', 'package.json', 'gone.js'], ['.env'], '.');
  assert.strictEqual(fs.readFileSync(path.join(box.dir, 'src', 'a.js'), 'utf8'), 'a');
  assert.ok(!fs.existsSync(path.join(box.dir, '.env')));
  assert.strictEqual(fs.readFileSync(path.join(box.dir, 'node_modules', 'dep', 'index.js'), 'utf8'), 'dep');
  fs.writeFileSync(path.join(box.dir, 'src', 'a.js'), 'mutated');
  assert.strictEqual(fs.readFileSync(path.join(root, 'src', 'a.js'), 'utf8'), 'a', 'the project is a separate copy');
  assert.strictEqual(removeSandbox(box), true);
  assert.ok(!fs.existsSync(box.dir));
});

test('sandbox: removing the copy never deletes the real dependency folder', () => {
  const root = tempDir('devgate-box-');
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), 'dep');
  const box = createSandbox(root, ['package.json'], [], '.');
  assert.strictEqual(box.links.length, 1);
  removeSandbox(box);
  assert.strictEqual(fs.readFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), 'utf8'), 'dep');
});
