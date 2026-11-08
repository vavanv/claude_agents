'use strict';
// Run lifecycle: storage, spec validation, the stage state machine and the result.
// The result is computed from recorded evidence here, never supplied by a model.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { takeInventory, diffInventories, fingerprint, sha256 } = require('./inventory.cjs');
const { globMatcher, matchesAny, projectRelative } = require('./glob.cjs');
const { PARSER_NAMES, countRegex, validCounts } = require('./parsers.cjs');
const { DEPENDENCY_DIRS } = require('./sandbox.cjs');

const ROLES = ['implementer', 'validator', 'reviewer'];
const PLUGIN_PREFIX = 'dev-gate:';
const AGENTS_DIR = path.join(__dirname, '..', '..', 'agents');
const MAX_TIMEOUT_SEC = 570; // a foreground Bash call is capped at 10 minutes
const DEFAULT_TIMEOUT_SEC = 300;
const MAX_REPAIRS = 1;
const MUTATION_DEFAULTS = { budgetSec: 480, maxMutants: 12, minScore: 100 };

// Agents may never write these, whatever the spec says.
const ALWAYS_NO_WRITE = ['.git/**', '.claude/**'];
const DEFAULT_PROTECTED = ['.env', '.env.*', '**/.env', '**/.env.*'];

class SpecError extends Error {}

function homeDir() {
  return process.env.DEV_GATE_HOME || path.join(os.homedir(), '.claude', 'dev-gate');
}

// Nearest ancestor with .git, otherwise the starting directory. No process spawn:
// this runs on every hooked tool call.
function findProjectRoot(start) {
  const first = path.resolve(start);
  let cursor = first;
  for (;;) {
    if (fs.existsSync(path.join(cursor, '.git'))) {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return first;
    }
    cursor = parent;
  }
}

function projectDir(root) {
  let real = root;
  try {
    real = fs.realpathSync.native(root);
  } catch {
    // Keep the given path.
  }
  const key = process.platform === 'win32' ? real.toLowerCase() : real;
  const slug = `${path.basename(real).replace(/[^\w.-]/g, '_')}-${sha256(key).slice(0, 8)}`;
  return path.join(homeDir(), 'runs', slug);
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

function activePointer(root) {
  return path.join(projectDir(root), 'active.json');
}

function pendingSessionFile(root) {
  return path.join(projectDir(root), 'pending-session.json');
}

function recordPendingSession(root, sessionId) {
  writeJsonAtomic(pendingSessionFile(root), { sessionId, at: Date.now() });
}

function takePendingSession(root) {
  const file = pendingSessionFile(root);
  const pending = readJson(file);
  if (!pending) {
    return null;
  }
  fs.rmSync(file, { force: true });
  return Date.now() - pending.at < 60_000 ? pending.sessionId : null;
}

// Returns { dir, state } for the active run, or null.
function loadActive(root) {
  let raw;
  try { raw = fs.readFileSync(activePointer(root), 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
  const pointer = JSON.parse(raw);
  if (!pointer || typeof pointer.runId !== 'string' || !/^[\w-]+$/.test(pointer.runId)) {
    throw new Error('Invalid active-run pointer; use gate abort to preserve evidence and release it.');
  }
  const dir = path.join(projectDir(root), pointer.runId);
  const state = readJson(path.join(dir, 'state.json'));
  if (!state) {
    throw new Error(`Active run ${pointer.runId} has no state file`);
  }
  // Compared by storage folder: one project can be named with another drive-letter case or through a link.
  if (state.runId !== pointer.runId || typeof state.projectRoot !== 'string'
      || projectDir(state.projectRoot) !== projectDir(root) || typeof state.stage !== 'string'
      || !state.agents || !state.checks || !Array.isArray(state.comparisons) || !Array.isArray(state.attempts)) {
    throw new Error(`Active run ${pointer.runId} has inconsistent state; use gate abort.`);
  }
  return { dir, state };
}

// Corrupt state cannot be rendered as a normal report. Keep every evidence file,
// archive the pointer verbatim, and record the recovery separately as UNVERIFIED.
function recoverActive(root, reason, error) {
  const dir = path.join(projectDir(root), `recovery-${newRunId()}`);
  fs.mkdirSync(dir, { recursive: true });
  writeJsonAtomic(path.join(dir, 'report.json'), {
    result: 'UNVERIFIED', reason, storageError: error.message, at: new Date().toISOString(),
  });
  const report = `# Result: UNVERIFIED\n\n- Run aborted: ${reason}\n- Run storage could not be loaded: ${error.message}\n- Original evidence preserved in: \`${projectDir(root)}\`\n\nEvidence folder: \`${dir}\`\n`;
  fs.writeFileSync(path.join(dir, 'report.md'), report);
  fs.renameSync(activePointer(root), path.join(dir, 'active.json'));
  return report;
}

function saveState(run) {
  writeJsonAtomic(path.join(run.dir, 'state.json'), run.state);
}

// Replaces this process's copy with what is on disk. A check can outlast its stage, and
// the hook records that in the meantime, so a copy read before a check is out of date.
function reloadState(run) {
  run.state = readJson(path.join(run.dir, 'state.json'));
  return run.state;
}

function logEvent(run, event, details = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...details });
  fs.appendFileSync(path.join(run.dir, 'events.jsonl'), `${line}\n`);
}

function firstToken(command) {
  const m = /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command);
  return m ? m[1] || m[2] || m[3] : '';
}

// True when the command's executable can be found. Used before a run, and after a
// failure to separate "could not start" from "ran and failed" in any locale.
function commandResolves(command, cwd) {
  const token = firstToken(command);
  if (!token) {
    return false;
  }
  if (/[\\/]/.test(token)) {
    return fs.existsSync(path.resolve(cwd, token));
  }
  const r = process.platform === 'win32'
    ? spawnSync('where.exe', [token], { cwd, encoding: 'utf8', windowsHide: true })
    : spawnSync('sh', ['-c', `command -v "${token.replace(/"/g, '')}"`], { cwd, encoding: 'utf8' });
  return r.status === 0;
}

function assertPatterns(name, patterns, required) {
  if (patterns === undefined && !required) {
    return;
  }
  if (!Array.isArray(patterns) || (required && patterns.length === 0)) {
    throw new SpecError(`spec.${name} must be a${required ? ' non-empty' : 'n'} array of paths`);
  }
  for (const p of patterns) {
    if (typeof p !== 'string' || !p.trim()) {
      throw new SpecError(`spec.${name} has an empty entry`);
    }
    const clean = p.replace(/\\/g, '/');
    if (path.isAbsolute(p) || /^[A-Za-z]:/.test(p) || clean.split('/').includes('..')) {
      throw new SpecError(`spec.${name} entry must stay inside the project: ${p}`);
    }
  }
}

function validateSpec(spec, root) {
  if (!spec || typeof spec !== 'object') {
    throw new SpecError('spec must be a JSON object');
  }
  if (typeof spec.task !== 'string' || !spec.task.trim()) {
    throw new SpecError('spec.task is required');
  }
  if (!Array.isArray(spec.acceptance) || spec.acceptance.length === 0) {
    throw new SpecError('spec.acceptance must list at least one criterion');
  }
  assertPatterns('scope', spec.scope, true);
  assertPatterns('protected', spec.protected, false);
  assertPatterns('declaredArtifacts', spec.declaredArtifacts, false);
  if (!Array.isArray(spec.checks) || spec.checks.length === 0) {
    throw new SpecError('spec.checks must list at least one check');
  }
  const ids = new Set();
  for (const check of spec.checks) {
    if (!/^[A-Za-z0-9_-]+$/.test(check.id || '')) {
      throw new SpecError(`Invalid check id: ${check.id}`);
    }
    if (ids.has(check.id)) {
      throw new SpecError(`Duplicate check id: ${check.id}`);
    }
    ids.add(check.id);
    if (typeof check.command !== 'string' || !check.command.trim()) {
      throw new SpecError(`Check ${check.id} has no command`);
    }
    if (!['test', 'typecheck', 'build', 'lint'].includes(check.kind)) {
      throw new SpecError(`Check ${check.id} kind must be test, typecheck, build or lint`);
    }
    if (check.kind === 'test' && !PARSER_NAMES.includes(check.parser)) {
      throw new SpecError(`Test check ${check.id} needs a parser: ${PARSER_NAMES.join(', ')}`);
    }
    if (check.parser === 'regex') {
      try { countRegex(check.countRegex); } catch (err) {
        throw new SpecError(`Check ${check.id}: ${err.message}`);
      }
    }
    const timeout = check.timeoutSec === undefined ? DEFAULT_TIMEOUT_SEC : check.timeoutSec;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_SEC) {
      throw new SpecError(`Check ${check.id} timeoutSec must be 1 to ${MAX_TIMEOUT_SEC}`);
    }
    const cwd = check.cwd || '.';
    const abs = path.resolve(root, cwd);
    const inside = path.resolve(root) === abs || projectRelative(root, abs) !== null;
    if (!inside || !fs.existsSync(abs)) {
      throw new SpecError(`Check ${check.id} cwd is not in the project: ${cwd}`);
    }
  }
  if (spec.maxRepairs !== undefined && ![0, MAX_REPAIRS].includes(spec.maxRepairs)) {
    throw new SpecError(`spec.maxRepairs must be 0 or ${MAX_REPAIRS}`);
  }
  if (!spec.checks.some((c) => c.kind === 'test')) {
    throw new SpecError('spec.checks must include at least one test check');
  }
  if (spec.mutation !== undefined) {
    validateMutation(spec);
  }
  if (spec.requireTests !== undefined && typeof spec.requireTests !== 'boolean') {
    throw new SpecError('spec.requireTests must be true or false');
  }
  if (spec.checkBefore !== undefined && typeof spec.checkBefore !== 'boolean') {
    throw new SpecError('spec.checkBefore must be true or false');
  }
  if (spec.failingBefore !== undefined) {
    if (!Array.isArray(spec.failingBefore) || spec.failingBefore.some((id) => !ids.has(id))) {
      throw new SpecError('spec.failingBefore must list ids of declared checks');
    }
    if (spec.checkBefore === false) {
      throw new SpecError('spec.failingBefore needs the checks before the change, so it cannot go with "checkBefore": false');
    }
  }
}

function validateMutation(spec) {
  const m = spec.mutation;
  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    throw new SpecError('spec.mutation must be an object');
  }
  if (m.check !== undefined) {
    const target = spec.checks.find((c) => c.id === m.check);
    if (!target || target.kind !== 'test') {
      throw new SpecError(`spec.mutation.check must name a test check: ${m.check}`);
    }
  }
  if (m.command !== undefined && (typeof m.command !== 'string' || !m.command.trim())) {
    throw new SpecError('spec.mutation.command must be a command');
  }
  const ranged = [['budgetSec', 1, MAX_TIMEOUT_SEC], ['maxMutants', 1, 200], ['minScore', 0, 100]];
  for (const [name, low, high] of ranged) {
    if (m[name] !== undefined && (!Number.isInteger(m[name]) || m[name] < low || m[name] > high)) {
      throw new SpecError(`spec.mutation.${name} must be a whole number from ${low} to ${high}`);
    }
  }
  assertPatterns('mutation.exclude', m.exclude, false);
}

function mutationSettings(spec) {
  const m = spec.mutation;
  const check = m.check ? spec.checks.find((c) => c.id === m.check) : spec.checks.find((c) => c.kind === 'test');
  return {
    ...MUTATION_DEFAULTS,
    ...m,
    exclude: m.exclude || [],
    check: { ...check, command: m.command || check.command },
  };
}

function excludesOf(spec) {
  return spec.declaredArtifacts || [];
}

function protectedPaths(spec) {
  return [...DEFAULT_PROTECTED, ...(spec.protected || [])];
}

const DEPENDENCY_PATH = new RegExp(
  `(?:^|/)(?:${DEPENDENCY_DIRS.join('|').replace(/\./g, '\\.')})(?:/|$)`,
  process.platform === 'win32' ? 'i' : '',
);

// Decides what Read and Grep may not reach. A `.env*` file inside a dependency folder
// is one a package shipped, not the user's secret, so the default rule stops at the
// first dependency folder. The spec's own paths still apply everywhere. Edits and the
// mutation copy keep using the full protectedPaths list.
function contentProtection(spec) {
  const own = globMatcher(spec.protected || []);
  const defaults = globMatcher(DEFAULT_PROTECTED);
  return (rel) => {
    if (own(rel)) {
      return true;
    }
    const dependency = DEPENDENCY_PATH.exec(rel);
    return defaults(dependency ? rel.slice(0, dependency.index) : rel);
  };
}

// The original text of in-scope files. The mutation check needs it to know which lines
// changed, and with the saved change below it shows what the run changed.
function saveBaselineSources(run, spec) {
  const off = protectedPaths(spec);
  for (const rel of Object.keys(run.state.baseline.files)) {
    if (!matchesAny(rel, spec.scope) || matchesAny(rel, off)) {
      continue;
    }
    const from = path.join(run.state.projectRoot, rel);
    if (!fs.lstatSync(from).isFile()) {
      continue;
    }
    const to = path.join(run.dir, 'baseline', rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

// Reads one frontmatter value from an agent file: `model:` is what we expect to run.
function agentConfig(role) {
  const file = path.join(AGENTS_DIR, `${role}.md`);
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch {
    return { path: null, sha256: null, model: null };
  }
  const m = /^model:\s*(\S+)\s*$/m.exec(raw.toString('utf8').replace(/\r\n/g, '\n'));
  return { path: `agents/${role}.md`, sha256: sha256(raw), model: m ? m[1] : null };
}

function newRunId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

const INIT_LOCK_STALE_MS = 10 * 60_000;

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// A lock left by a crashed init: its process is gone, or it is far older than any init.
function initLockStale(file) {
  let stat;
  let holder = null;
  try {
    stat = fs.statSync(file);
    holder = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      return true;
    }
    // Unreadable or half written: the holder may still be writing it.
  }
  if (stat && Date.now() - stat.mtimeMs > INIT_LOCK_STALE_MS) {
    return true;
  }
  return Boolean(holder && Number.isInteger(holder.pid) && !processAlive(holder.pid));
}

// One init at a time per project: the active check and the pointer write happen
// under an exclusive lock file, so two concurrent inits cannot both start a run.
function withInitLock(root, fn) {
  const file = path.join(projectDir(root), 'init.lock');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd = null;
  for (let attempt = 0; attempt < 2 && fd === null; attempt += 1) {
    try {
      fd = fs.openSync(file, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') {
        throw err;
      }
      if (attempt > 0 || !initLockStale(file)) {
        throw new SpecError('Another run is starting here. Wait for it, then use gate status.');
      }
      fs.rmSync(file, { force: true });
    }
  }
  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    fs.closeSync(fd);
    fd = null;
    return fn();
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
    fs.rmSync(file, { force: true });
  }
}

function createRun(root, spec, sessionId) {
  validateSpec(spec, root);
  return withInitLock(root, () => createRunLocked(root, spec, sessionId));
}

function createRunLocked(root, spec, sessionId) {
  if (loadActive(root)) {
    throw new SpecError('A run is already active here. Use gate status, then gate report or gate abort.');
  }
  const unresolved = spec.checks.filter((c) => !commandResolves(c.command, path.resolve(root, c.cwd || '.')));
  if (spec.mutation && spec.mutation.command) {
    const { check } = mutationSettings(spec);
    if (!commandResolves(check.command, path.resolve(root, check.cwd || '.'))) {
      unresolved.push({ id: 'mutation', command: check.command });
    }
  }
  const runId = newRunId();
  const dir = path.join(projectDir(root), runId);
  fs.mkdirSync(path.join(dir, 'checks'), { recursive: true });
  writeJsonAtomic(path.join(dir, 'spec.json'), spec);
  const roleConfigs = Object.fromEntries(ROLES.map((role) => {
    const config = agentConfig(role);
    const expected = (spec.models && spec.models[role]) || config.model;
    return [role, { ...config, expectedModel: expected }];
  }));
  const state = {
    runId,
    projectRoot: root,
    sessionId: sessionId || null,
    createdAt: new Date().toISOString(),
    // The checks run once on the unchanged project before any stage may start.
    stage: spec.checkBefore === false ? 'implementer_ready' : 'checking_before',
    before: null,
    halt: null,
    closed: null,
    roleConfigs,
    agents: {},
    baseline: null,
    candidate: null,
    comparisons: [],
    checks: {},
    mutation: null,
    review: null,
    modelAudit: {},
    attempts: [],
    repair: null,
  };
  const run = { dir, state };
  if (unresolved.length > 0) {
    halt(run, 'SETUP_REQUIRED', `Command not found: ${unresolved.map((c) => `${c.id} (${firstToken(c.command)})`).join(', ')}`);
    state.closed = { at: new Date().toISOString(), by: 'init' };
    saveState(run);
    logEvent(run, 'init', { result: 'SETUP_REQUIRED' });
    return run;
  }
  state.baseline = takeInventory(root, excludesOf(spec));
  saveBaselineSources(run, spec);
  saveState(run);
  logEvent(run, 'init', { files: Object.keys(state.baseline.files).length, method: state.baseline.method });
  writeJsonAtomic(activePointer(root), { runId });
  return run;
}

function spec(run) {
  return readJson(path.join(run.dir, 'spec.json'));
}

// First halt wins: later problems cannot soften or replace the original result.
function halt(run, result, reason) {
  if (!run.state.halt) {
    run.state.halt = { result, reason, at: new Date().toISOString() };
    logEvent(run, 'halt', { result, reason });
  }
}

function expectedRole(state) {
  if (state.halt || state.closed) {
    return null;
  }
  const m = /^(implementer|validator|reviewer)_ready$/.exec(state.stage);
  return m ? m[1] : null;
}

function runningRole(state) {
  const m = /^(implementer|validator|reviewer)_running$/.exec(state.stage);
  return m ? m[1] : null;
}

function roleOf(agentType) {
  if (typeof agentType !== 'string' || !agentType.startsWith(PLUGIN_PREFIX)) {
    return null;
  }
  const role = agentType.slice(PLUGIN_PREFIX.length);
  return ROLES.includes(role) ? role : null;
}

// Keeps a copy of every changed file as frozen, so the change the run judged can be
// read, checked against the result and restored after the working copy is gone. Each
// attempt has its own folder. Protected files and links are listed but never copied.
function saveChange(run, s) {
  const { state } = run;
  const c = state.candidate;
  const rel = path.join('changes', `attempt-${state.attempts.length + 1}`);
  const dir = path.join(run.dir, rel);
  fs.mkdirSync(dir, { recursive: true });
  const off = protectedPaths(s);
  const removed = new Set(c.removed);
  const entries = c.changed.map((file) => {
    const status = removed.has(file) ? 'removed' : (c.added.includes(file) ? 'added' : 'modified');
    if (status === 'removed') {
      return { file, status, saved: false, reason: 'removed' };
    }
    if (matchesAny(file, off)) {
      return { file, status, saved: false, reason: 'protected' };
    }
    const from = path.join(state.projectRoot, file);
    let st;
    try {
      st = fs.lstatSync(from);
    } catch {
      return { file, status, saved: false, reason: 'missing at freeze' };
    }
    if (!st.isFile()) {
      return { file, status, saved: false, reason: 'not a regular file' };
    }
    const to = path.join(dir, 'files', file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    return { file, status, saved: true, sha256: c.files[file] };
  });
  writeJsonAtomic(path.join(dir, 'manifest.json'), { fingerprint: c.fingerprint, files: entries });
  return { dir: rel, files: entries };
}

// Problems with the saved change. Each saved copy must still have the bytes that were
// frozen; anything else means the evidence of what was judged is missing or altered.
function savedChangeProblems(run) {
  const c = run.state.candidate;
  if (!c) {
    return [];
  }
  if (!c.saved) {
    return ['No saved copy of the change.'];
  }
  const problems = [];
  for (const entry of c.saved.files) {
    if (!entry.saved) {
      continue;
    }
    const copy = path.join(run.dir, c.saved.dir, 'files', entry.file);
    let hash = null;
    try {
      hash = sha256(fs.readFileSync(copy));
    } catch {
      // missing: reported below
    }
    if (hash === null) {
      problems.push(`Saved copy missing: ${entry.file}.`);
    } else if (hash !== entry.sha256 || hash !== c.files[entry.file]) {
      problems.push(`Saved copy does not match the candidate: ${entry.file}.`);
    }
  }
  return problems;
}

function freeze(run) {
  const { state } = run;
  const s = spec(run);
  const current = takeInventory(state.projectRoot, excludesOf(s));
  const diff = diffInventories(state.baseline.files, current.files);
  const outside = diff.changed.filter((rel) => !matchesAny(rel, s.scope));
  state.candidate = {
    fingerprint: fingerprint(current.files),
    files: current.files,
    method: current.method,
    changed: diff.changed,
    added: diff.added,
    removed: diff.removed,
    modified: diff.modified,
  };
  state.candidate.saved = saveChange(run, s);
  logEvent(run, 'freeze', { fingerprint: state.candidate.fingerprint, changed: diff.changed, outside });
  if (outside.length > 0) {
    halt(run, 'FAILED', `Changes outside scope: ${outside.join(', ')}`);
  } else if (diff.changed.length === 0) {
    halt(run, 'UNVERIFIED', 'The implementer changed no files.');
  } else if (state.repair && state.candidate.fingerprint === state.repair.fromFingerprint) {
    halt(run, 'FAILED', "The repair changed nothing, so the reviewer's rejection stands.");
  }
}

function mutationRejected(state) {
  return Boolean(state.mutation) && state.mutation.outcome === 'below_threshold';
}

function survivorFindings(state) {
  if (!mutationRejected(state)) {
    return [];
  }
  return state.mutation.survivors.map((m) => `${m.file}:${m.line}: no test failed when \`${m.original}\` was changed to \`${m.mutated}\` (mutation check). Add a test that fails for this change.`);
}

// Decision D6: with spec.requireTests, the reviewer must name a test for every criterion.
// A list that leaves criteria out, or marks them "reading", is a rejection. No readable
// list at all is missing evidence, so UNVERIFIED, and never repaired.
function coverageMissing(run) {
  const { review } = run.state;
  return Boolean(spec(run).requireTests) && Boolean(review) && !Array.isArray(review.coverage);
}

function coverageRejected(run) {
  const { review } = run.state;
  return Boolean(spec(run).requireTests) && Boolean(review) && Array.isArray(review.coverage)
    && untestedCriteria(run).length > 0;
}

function coverageFindings(run) {
  if (!coverageRejected(run)) {
    return [];
  }
  return criterionCoverage(run).filter((c) => c.by !== 'test' || !c.where)
    .map((c) => `Criterion ${c.criterion} (${c.text}): the reviewer named no test that would fail if it broke. The spec requires one for each criterion, so add it.`);
}

// A repair needs a concrete rejection, by the reviewer, the mutation check or the
// required coverage, an otherwise intact run, and one still allowed. Failed checks and
// unreadable verdicts never lead here.
function canRepair(run) {
  const { state } = run;
  const allowed = spec(run).maxRepairs === undefined ? MAX_REPAIRS : spec(run).maxRepairs;
  if (state.halt || state.attempts.length >= allowed || state.review === null) {
    return false;
  }
  return state.review.verdict === 'REQUEST_CHANGES'
    ? state.review.findings.length > 0
    : mutationRejected(state) || coverageRejected(run);
}

// Keeps this attempt's evidence and sends the run back to the implementer. The baseline
// stays the same, so the scope check still covers everything changed since the start.
function beginRepair(run) {
  const { state } = run;
  const attempt = state.attempts.length + 1;
  const checksDir = path.join(run.dir, 'checks');
  const archive = path.join(checksDir, `attempt-${attempt}`);
  fs.mkdirSync(archive);
  for (const entry of fs.readdirSync(checksDir)) {
    if (entry.endsWith('.log') || entry === 'mutation') {
      fs.renameSync(path.join(checksDir, entry), path.join(archive, entry));
    }
  }
  state.attempts.push({
    attempt,
    fingerprint: state.candidate.fingerprint,
    changed: state.candidate.changed,
    saved: state.candidate.saved || null,
    agents: state.agents,
    checks: state.checks,
    comparisons: state.comparisons,
    mutation: state.mutation,
    review: state.review,
    modelAudit: state.modelAudit,
    logs: archive,
  });
  state.repair = {
    attempt: attempt + 1,
    findings: [...state.review.findings, ...survivorFindings(state), ...coverageFindings(run)],
    fromFingerprint: state.candidate.fingerprint,
  };
  state.agents = {};
  state.checks = {};
  state.comparisons = [];
  state.mutation = null;
  state.review = null;
  state.modelAudit = {};
  state.stage = 'implementer_ready';
  logEvent(run, 'repair_start', { attempt: attempt + 1, findings: state.repair.findings.length });
}

function enumerate(run) {
  return takeInventory(run.state.projectRoot, excludesOf(spec(run)));
}

function changedSinceBaseline(run) {
  return diffInventories(run.state.baseline.files, enumerate(run).files).changed;
}

// Why the implementer may not edit or remove this project-relative path, or null if it may.
function editRefusal(s, rel) {
  if (matchesAny(rel, [...ALWAYS_NO_WRITE, ...DEFAULT_PROTECTED, ...(s.protected || [])])) {
    return `Path is protected: ${rel}`;
  }
  if (!matchesAny(rel, s.scope)) {
    return `Path is outside the approved scope: ${rel}`;
  }
  return null;
}

// Compares the project with the frozen candidate, enumerating it unless given a listing.
function verify(run, label, current = enumerate(run)) {
  const { state } = run;
  if (!state.candidate) {
    return false;
  }
  const diff = diffInventories(state.candidate.files, current.files);
  const match = diff.changed.length === 0;
  state.comparisons.push({ label, match, fingerprint: fingerprint(current.files), changed: diff.changed });
  logEvent(run, 'verify', { label, match, changed: diff.changed });
  if (!match) {
    halt(run, 'FAILED', `Candidate changed (${label}): ${diff.changed.join(', ')}`);
  }
  return match;
}

// PASS needs every piece of evidence. Anything missing is UNVERIFIED, never PASS.
function computeResult(run) {
  const { state } = run;
  if (state.halt) {
    return { result: state.halt.result, reasons: [state.halt.reason] };
  }
  const missing = [];
  const s = spec(run);
  if (s.checkBefore !== false && !state.before) {
    missing.push('The checks did not run before the change.');
  }
  if (!state.candidate) {
    missing.push('No frozen candidate.');
  }
  missing.push(...savedChangeProblems(run));
  for (const role of ROLES) {
    if (!state.agents[role] || !state.agents[role].finished) {
      missing.push(`Stage did not finish: ${role}.`);
    }
  }
  for (const check of s.checks) {
    const evidence = state.checks[check.id];
    if (!evidence) {
      missing.push(`Check did not run: ${check.id}.`);
    } else if (evidence.outcome !== 'passed') {
      missing.push(`Check ${check.id} outcome: ${evidence.outcome}.`);
    } else if (check.kind === 'test' && (!validCounts(evidence.counts)
        || evidence.counts.passed <= 0 || evidence.counts.failed !== 0)) {
      missing.push(`Check ${check.id} has no valid passing test counts.`);
    }
  }
  if (s.mutation) {
    if (!state.mutation) {
      missing.push('The mutation check did not run.');
    } else if (state.mutation.outcome !== 'passed') {
      missing.push(`Mutation check outcome: ${state.mutation.outcome}.`);
    }
  }
  if (!state.review) {
    missing.push('No reviewer verdict.');
  } else if (state.review.verdict !== 'APPROVE') {
    missing.push(`Reviewer verdict: ${state.review.verdict}.`);
  } else if (coverageMissing(run)) {
    missing.push('The spec requires a named test for each criterion, and the reviewer gave no readable coverage list.');
  } else if (coverageRejected(run)) {
    missing.push(`No named test for criteria ${untestedCriteria(run).join(', ')}, which the spec requires.`);
  }
  const labels = state.comparisons.map((c) => c.label);
  for (const needed of ['after-validation', 'after-review']) {
    if (!labels.includes(needed)) {
      missing.push(`Candidate comparison missing: ${needed}.`);
    }
  }
  if (state.comparisons.some((c) => !c.match)) {
    missing.push('A candidate comparison did not match.');
  }
  return missing.length > 0 ? { result: 'UNVERIFIED', reasons: missing } : { result: 'PASS', reasons: [] };
}

function mutationSummary(m) {
  const score = m.score === null ? 'no score' : `${m.score}% caught, needed ${m.minScore}%`;
  return `${m.outcome}; ${score}; ${m.killed} caught, ${m.survived} not caught, ${m.invalid} didn't build or crashed, ${m.notTested} not tested; ${m.selected} tried of ${m.candidates} possible`;
}

function renderMutation(lines, m) {
  lines.push(`- **Outcome:** ${mutationSummary(m)}`);
  if (m.reason) {
    lines.push(`- **Detail:** ${m.reason}`);
  }
  lines.push(`- **Command:** \`${m.command}\`; control run ${m.controlMs === null ? 'not run' : `${m.controlMs} ms`}; total ${m.durationMs} ms`);
  for (const s of m.survivors) {
    lines.push(`- **Not caught:** ${s.file}:${s.line} \`${s.original}\` changed to \`${s.mutated}\``);
  }
  if (m.notMutated.length > 0) {
    lines.push(`- **Changed but not mutated (unsupported language):** ${m.notMutated.join(', ')}`);
  }
}

function renderSaved(lines, run, saved) {
  if (!saved) {
    lines.push('- **Saved change:** none');
    return;
  }
  const copied = saved.files.filter((f) => f.saved).length;
  lines.push(`- **Saved change:** \`${path.join(run.dir, saved.dir)}\` (${copied} of ${saved.files.length} changed files copied; originals in \`baseline\`)`);
  for (const f of saved.files) {
    if (!f.saved && f.reason !== 'removed') {
      lines.push(`  - not copied: ${f.file} (${f.reason})`);
    }
  }
}

// Each criterion with the reviewer's statement of how it is checked. Criteria the
// reviewer left out, or numbered wrongly, are "not_stated". It is a statement, not a
// measurement, and the result doesn't depend on it.
function criterionCoverage(run) {
  const review = run.state.review;
  const stated = review && Array.isArray(review.coverage) ? review.coverage : [];
  return spec(run).acceptance.map((text, i) => {
    const c = stated.find((x) => x.criterion === i + 1);
    return { criterion: i + 1, text, by: c ? c.by : 'not_stated', where: c ? c.where : null };
  });
}

function renderCoverage(lines, run) {
  const review = run.state.review;
  lines.push('', '## Criterion coverage (the reviewer\'s statement, not measured by the gate)', '');
  if (!review) {
    lines.push('- No verdict.');
    return;
  }
  if (spec(run).requireTests) {
    lines.push('- The spec requires a named test for each criterion.');
  }
  if (!Array.isArray(review.coverage)) {
    lines.push('- The reviewer gave no readable coverage list.');
  }
  for (const c of criterionCoverage(run)) {
    const how = c.by === 'test' ? `test${c.where ? `, \`${c.where}\`` : ', none named'}`
      : c.by === 'reading' ? 'checked only by reading' : 'not stated';
    lines.push(`${c.criterion}. ${c.text}: **${how}**`);
  }
}

function untestedCriteria(run) {
  return criterionCoverage(run).filter((c) => c.by !== 'test' || !c.where).map((c) => c.criterion);
}

function beforeSummary(e) {
  const counts = e.counts ? `; ${e.counts.passed} passed, ${e.counts.failed} failed` : '';
  return `${e.outcome}; exit ${e.exitCode}${counts}; ${e.durationMs} ms${e.mayFail ? '; allowed to fail by failingBefore' : ''}`;
}

function renderBefore(lines, run) {
  const s = spec(run);
  const before = run.state.before;
  lines.push('', '## Checks before the change', '');
  if (s.checkBefore === false) {
    lines.push('- Not run: the spec set "checkBefore": false.');
    return;
  }
  for (const check of s.checks) {
    const e = before && before[check.id];
    if (!e) {
      lines.push(`- **${check.id}:** did not run`);
      continue;
    }
    lines.push(`- **${check.id}:** ${beforeSummary(e)}`);
    lines.push(`  - log: \`${path.join(run.dir, 'checks', 'before', `${check.id}.log`)}\` (sha256 ${e.logSha256})`);
  }
}

function renderReport(run, computed) {
  const { state } = run;
  const s = spec(run);
  const lines = [`# Result: ${computed.result}`, ''];
  for (const reason of computed.reasons) {
    lines.push(`- ${reason}`);
  }
  if (computed.result === 'PASS' && state.review) {
    const untested = untestedCriteria(run);
    if (untested.length > 0) {
      lines.push(`- **Note:** the reviewer didn't name a test for criteria ${untested.join(', ')}. See "Criterion coverage". This note doesn't change the result.`);
    }
  }
  if (lines.length > 2) {
    lines.push('');
  }
  lines.push(`- **Run:** ${state.runId}`, `- **Project:** \`${state.projectRoot}\``,`- **Task:** ${s.task}`);
  lines.push(`- **Scope:** ${s.scope.join(', ')}`, '', '## Stages', '');
  for (const role of ROLES) {
    const agent = state.agents[role];
    lines.push(`- **${role}:** ${agent ? `agent ${agent.agentId || 'unknown'}${agent.finished ? '' : ' (did not finish)'}` : 'did not run'}`);
  }
  lines.push('', '## Candidate', '');
  if (state.candidate) {
    lines.push(`- **Fingerprint:** ${state.candidate.fingerprint}`);
    lines.push(`- **Enumerated with:** ${state.candidate.method}`);
    lines.push(`- **Changed files:** ${state.candidate.changed.join(', ') || 'none'}`);
    renderSaved(lines, run, state.candidate.saved);
    for (const c of state.comparisons) {
      lines.push(`- **${c.label}:** ${c.match ? 'match' : `MISMATCH (${c.changed.join(', ')})`}`);
    }
  } else {
    lines.push('- None frozen.');
  }
  renderBefore(lines, run);
  lines.push('', '## Checks', '');
  for (const check of s.checks) {
    const e = state.checks[check.id];
    if (!e) {
      lines.push(`- **${check.id}:** did not run`);
      continue;
    }
    const counts = e.counts
      ? `${e.counts.passed} passed, ${e.counts.failed} failed, ${e.counts.skipped} skipped`
      : (check.kind === 'test' ? 'counts unknown' : 'no test counts');
    lines.push(`- **${check.id}:** ${e.outcome}; exit ${e.exitCode}; ${counts}; ${e.durationMs} ms`);
    lines.push(`  - \`${check.command}\` in \`${check.cwd || '.'}\``);
    lines.push(`  - log: \`${path.join(run.dir, 'checks', `${check.id}.log`)}\` (sha256 ${e.logSha256})`);
  }
  lines.push('', '## Mutation check', '');
  if (!s.mutation) {
    lines.push('- Not requested in the spec.');
  } else if (!state.mutation) {
    lines.push('- Did not run.');
  } else {
    renderMutation(lines, state.mutation);
  }
  lines.push('', '## Review', '');
  if (state.review) {
    lines.push(`- **Verdict:** ${state.review.verdict}`);
    for (const f of state.review.findings) {
      lines.push(`- ${typeof f === 'string' ? f : JSON.stringify(f)}`);
    }
  } else {
    lines.push('- No verdict.');
  }
  renderCoverage(lines, run);
  lines.push('', '## Model audit (separate from the result)', '');
  for (const role of ROLES) {
    const a = state.modelAudit[role];
    const agent = state.agents[role];
    const missing = !agent ? 'not audited, stage did not run'
      : !agent.finished ? 'not audited, stage did not finish'
        : 'no transcript evidence';
    lines.push(a
      ? `- **${role}:** ${a.status}; configured ${a.configuredModel || 'unknown'}; observed ${a.observedModels.join(', ') || 'none'}; effort ${a.observedEfforts.join(', ') || 'unknown'}`
      : `- **${role}:** UNVERIFIED; ${missing}`);
  }
  if (state.attempts.length > 0) {
    lines.push('', '## Earlier attempts', '');
    lines.push(`This result is from attempt ${state.attempts.length + 1}, after the automatic repair of the review findings below.`, '');
    for (const a of state.attempts) {
      lines.push(`### Attempt ${a.attempt}`, '');
      lines.push(`- **Fingerprint:** ${a.fingerprint}`);
      lines.push(`- **Changed files:** ${a.changed.join(', ')}`);
      renderSaved(lines, run, a.saved);
      for (const [id, e] of Object.entries(a.checks)) {
        lines.push(`- **${id}:** ${e.outcome}; exit ${e.exitCode}${e.counts ? `; ${e.counts.passed} passed, ${e.counts.failed} failed` : ''}`);
      }
      if (a.mutation) {
        lines.push(`- **Mutation check:** ${mutationSummary(a.mutation)}`);
      }
      lines.push(`- **Verdict:** ${a.review.verdict}`);
      for (const f of a.review.findings) {
        lines.push(`- ${typeof f === 'string' ? f : JSON.stringify(f)}`);
      }
      const audit = ROLES.map((role) => `${role} ${a.modelAudit[role] ? a.modelAudit[role].status : 'UNVERIFIED'}`);
      lines.push(`- **Model audit:** ${audit.join('; ')}`);
      lines.push(`- **Logs:** \`${a.logs}\``, '');
    }
  }
  lines.push('', '## Limits', '');
  lines.push('- These are workflow guardrails, not OS isolation or defence against a hostile agent.');
  lines.push('- Comparisons cover the enumerated files at each checkpoint. Git-ignored files, declared artifacts and changes undone between checkpoints are not covered.');
  lines.push('- Separate agents can share blind spots, particularly where tests and code encode the same wrong assumption.');
  if (s.mutation) {
    lines.push('- The mutation check tries a limited set of small breaks on changed lines. Catching them all is evidence about the tests, not proof that they are complete.');
  }
  lines.push('- The model audit reads the local transcript. It is a record, not a cryptographic attestation.');
  lines.push('', `Evidence folder: \`${run.dir}\``, '');
  return lines.join('\n');
}

// Writes the reports and releases the project for the next run.
function closeRun(run, by) {
  const { state } = run;
  if (!state.halt && by !== 'stop-hook' && !state.closed) {
    if (state.candidate && state.stage === 'report_ready') {
      verify(run, 'at-report');
    }
  }
  const computed = computeResult(run);
  state.closed = { at: new Date().toISOString(), by, result: computed.result };
  state.stage = 'closed';
  saveState(run);
  const report = renderReport(run, computed);
  fs.writeFileSync(path.join(run.dir, 'report.md'), report);
  writeJsonAtomic(path.join(run.dir, 'report.json'), {
    runId: state.runId,
    result: computed.result,
    reasons: computed.reasons,
    candidateFingerprint: state.candidate ? state.candidate.fingerprint : null,
    changed: state.candidate ? state.candidate.changed : [],
    savedChange: state.candidate && state.candidate.saved ? state.candidate.saved : null,
    comparisons: state.comparisons,
    before: state.before || null,
    checks: state.checks,
    mutation: state.mutation,
    review: state.review,
    coverage: state.review ? criterionCoverage(run) : null,
    modelAudit: state.modelAudit,
    repairs: state.attempts.length,
    attempts: state.attempts,
  });
  logEvent(run, 'closed', { by, result: computed.result });
  fs.rmSync(activePointer(state.projectRoot), { force: true });
  return { ...computed, report };
}

module.exports = {
  ALWAYS_NO_WRITE,
  DEFAULT_PROTECTED,
  ROLES,
  SpecError,
  beginRepair,
  canRepair,
  changedSinceBaseline,
  closeRun,
  commandResolves,
  computeResult,
  coverageMissing,
  coverageRejected,
  createRun,
  editRefusal,
  enumerate,
  expectedRole,
  findProjectRoot,
  freeze,
  halt,
  loadActive,
  logEvent,
  mutationRejected,
  mutationSettings,
  mutationSummary,
  contentProtection,
  projectDir,
  protectedPaths,
  recordPendingSession,
  recoverActive,
  reloadState,
  renderReport,
  roleOf,
  runningRole,
  saveState,
  spec,
  takePendingSession,
  verify,
};
