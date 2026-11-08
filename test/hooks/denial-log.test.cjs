'use strict';
// Refused calls must leave enough in the event log to tell later what was tried and
// by whom, including a caller that has an agent id but no agent type.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('../helpers/project.cjs');

function started() {
  const p = H.makeProject();
  const result = H.init(p);
  assert.equal(result.code, 0, result.err);
  const dir = /Evidence folder: (.+)/.exec(result.out)[1].trim();
  return { ...p, dir };
}

function deniedEvents(p) {
  return fs.readFileSync(path.join(p.dir, 'events.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .filter((e) => e.event === 'denied');
}

test('a refused shell call from an agent with no type is logged with its command', () => {
  const p = started();
  const result = H.hook(p, 'PreToolUse', {
    tool_name: 'Bash', tool_input: { command: 'git status' }, agent_id: 'id-mystery',
  });
  assert.ok(H.denied(result));
  const reason = result.output.hookSpecificOutput.permissionDecisionReason;
  assert.doesNotMatch(reason, /undefined/);
  assert.match(reason, /Not allowed for an unidentified agent\./);
  const [event] = deniedEvents(p);
  assert.equal(event.role, 'an unidentified agent');
  assert.equal(event.agentId, 'id-mystery');
  assert.deepEqual(event.attempted, { command: 'git status' });
});

test('a refused root edit is logged as root with its file', () => {
  const p = started();
  const file = path.join(p.root, 'other.txt');
  const result = H.hook(p, 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: file } });
  assert.ok(H.denied(result));
  assert.match(result.output.hookSpecificOutput.permissionDecisionReason, /\(root tried\)/);
  const [event] = deniedEvents(p);
  assert.equal(event.role, 'root');
  assert.equal(event.agentId, null);
  assert.deepEqual(event.attempted, { file_path: file });
});

test('an edit from an agent with no type is refused and not named as root', () => {
  const p = started();
  const result = H.hook(p, 'PreToolUse', {
    tool_name: 'Write', tool_input: { file_path: path.join(p.root, 'src', 'a.txt') }, agent_id: 'id-mystery',
  });
  assert.ok(H.denied(result));
  assert.match(result.output.hookSpecificOutput.permissionDecisionReason, /\(an unidentified agent tried\)/);
  assert.equal(deniedEvents(p)[0].role, 'an unidentified agent');
});

test('a long refused command is cut in the log', () => {
  const p = started();
  const command = `echo ${'x'.repeat(2000)}`;
  assert.ok(H.denied(H.hook(p, 'PreToolUse', { tool_name: 'Bash', tool_input: { command } })));
  const logged = deniedEvents(p)[0].attempted.command;
  assert.equal(logged.length, 503);
  assert.ok(logged.endsWith('...'));
});
