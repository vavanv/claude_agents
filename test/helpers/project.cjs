'use strict';
// Shared helpers: a throwaway Git project, an isolated gate home, and ways to call
// the real gate CLI and hook entry point the same way Claude Code does.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN = path.join(__dirname, '..', '..', 'plugin', 'bin');
const GATE = path.join(BIN, 'gate.cjs');
const HOOK = path.join(BIN, 'hook.cjs');
const GATE_FOR_COMMAND = GATE.replace(/\\/g, '/');

// Prints unittest-style output and exits with a chosen code.
const FAKE_TEST = (ran, tail, code) => `node -e "console.log('Ran ${ran} tests in 0.01s');console.log('${tail}');process.exit(${code})"`;
const PASSING = FAKE_TEST(4, 'OK', 0);

function tempDir(prefix) {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function makeProject({ git = true } = {}) {
  const root = tempDir('devgate-project-');
  const home = tempDir('devgate-home-');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.txt'), 'original\n');
  fs.writeFileSync(path.join(root, 'other.txt'), 'other\n');
  if (git) {
    spawnSync('git', ['init', '-q'], { cwd: root });
  }
  return { root, home };
}

function spec(overrides = {}) {
  return {
    task: 'Change a.txt',
    acceptance: ['a.txt says changed'],
    scope: ['src/**'],
    checks: [{ id: 'unit', kind: 'test', parser: 'unittest', command: PASSING, timeoutSec: 60 }],
    ...overrides,
  };
}

function gate(project, args, input) {
  const r = spawnSync('node', [GATE, ...args, '--project', project.root], {
    cwd: project.root,
    input,
    encoding: 'utf8',
    env: { ...process.env, DEV_GATE_HOME: project.home },
    windowsHide: true,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function init(project, overrides) {
  return gate(project, ['init'], JSON.stringify(spec(overrides)));
}

// Sends one hook event to the real hook script. Returns its parsed JSON output.
function hook(project, event, fields = {}, { env = {} } = {}) {
  const payload = { session_id: 'session-1', cwd: project.root, hook_event_name: event, ...fields };
  const r = spawnSync('node', [HOOK], {
    cwd: project.root,
    input: typeof fields === 'string' ? fields : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, DEV_GATE_HOME: project.home, CLAUDE_PROJECT_DIR: project.root, ...env },
    windowsHide: true,
  });
  let output = {};
  try {
    output = JSON.parse(r.stdout || '{}');
  } catch {
    output = { unparsable: r.stdout };
  }
  return { code: r.status, output, err: r.stderr };
}

function denied(result) {
  const out = result.output.hookSpecificOutput;
  return Boolean(out && out.permissionDecision === 'deny');
}

function spawnStage(project, role) {
  return hook(project, 'PreToolUse', {
    tool_name: 'Agent',
    tool_input: { subagent_type: `dev-gate:${role}`, prompt: 'go' },
  });
}

function asAgent(role, extra = {}) {
  return { agent_id: `id-${role}`, agent_type: `dev-gate:${role}`, ...extra };
}

// A minimal transcript in the observed shape: the final message is a handback call.
function writeTranscript(project, role, { model, handback, text } = {}) {
  const file = path.join(project.home, `${role}-transcript.jsonl`);
  const content = [];
  if (text) {
    content.push({ type: 'text', text });
  }
  if (handback) {
    content.push({ type: 'tool_use', name: 'SubagentHandback', input: { message: handback } });
  }
  const record = { type: 'assistant', effort: 'low', version: '2.1.317', message: { model, content } };
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user' })}\n${JSON.stringify(record)}\n`);
  return file;
}

const MODELS = { implementer: 'claude-sonnet-5-5', validator: 'claude-haiku-5-5', reviewer: 'claude-opus-5-5' };

function stopStage(project, role, transcript = {}) {
  const agent_transcript_path = writeTranscript(project, role, { model: MODELS[role], ...transcript });
  return hook(project, 'SubagentStop', { ...asAgent(role), agent_transcript_path, stop_hook_active: false });
}

function startStage(project, role) {
  const spawned = spawnStage(project, role);
  const started = hook(project, 'SubagentStart', asAgent(role));
  return { spawned, started };
}

function implement(project, content = 'changed\n') {
  startStage(project, 'implementer');
  fs.writeFileSync(path.join(project.root, 'src', 'a.txt'), content);
  return stopStage(project, 'implementer', { handback: 'done' });
}

function validate(project, id = 'unit') {
  return gate(project, ['validate', '--check', id]);
}

function runValidator(project, id = 'unit') {
  startStage(project, 'validator');
  const result = validate(project, id);
  stopStage(project, 'validator', { handback: 'done' });
  return result;
}

function runReviewer(project, handback = '{"verdict":"APPROVE","findings":[]}') {
  startStage(project, 'reviewer');
  return stopStage(project, 'reviewer', { handback });
}

function report(project) {
  const r = gate(project, ['report']);
  const m = /^# Result: (\w+)/m.exec(r.out);
  return { ...r, result: m ? m[1] : null };
}

module.exports = {
  GATE_FOR_COMMAND,
  FAKE_TEST,
  PASSING,
  MODELS,
  asAgent,
  denied,
  gate,
  hook,
  implement,
  init,
  makeProject,
  report,
  runReviewer,
  runValidator,
  spawnStage,
  spec,
  startStage,
  stopStage,
  tempDir,
  validate,
  writeTranscript,
};
