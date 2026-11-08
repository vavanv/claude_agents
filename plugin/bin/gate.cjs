#!/usr/bin/env node
'use strict';
// dev-gate CLI. No dependencies. Usage:
//   gate init [--spec file]        reads the spec from stdin when --spec is absent
//   gate validate --check <id>     runs one declared check, as the validator
//   gate validate --mutation       runs the spec's mutation check, as the validator
//   gate remove <path>             deletes one file in scope, as the implementer
//   gate status | report | abort [--reason text]
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const R = require('./lib/run.cjs');
const { parseCounts, validCounts } = require('./lib/parsers.cjs');
const { sha256 } = require('./lib/inventory.cjs');
const { matchesAny, projectRelative } = require('./lib/glob.cjs');
const M = require('./lib/mutate.cjs');
const { createSandbox, removeSandbox } = require('./lib/sandbox.cjs');

const TAIL_LINES = 60;

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function fail(message, code = 2) {
  process.stderr.write(`gate: ${message}\n`);
  process.exit(code);
}

function requireActive(root) {
  const run = R.loadActive(root);
  if (!run) {
    fail('No active run in this project.');
  }
  return run;
}

function killTree(child) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

// Runs a command through the platform shell (.cmd files such as npm.cmd need one),
// sending all output to a log file. Resolves with what actually happened.
function execute(check, cwd, logPath, timeoutSec, env) {
  return new Promise((resolve) => {
    const started = Date.now();
    const log = fs.openSync(logPath, 'w');
    let settled = false;
    let timedOut = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      fs.closeSync(log);
      resolve({ ...result, timedOut, durationMs: Date.now() - started });
    };
    let child;
    try {
      child = spawn(check.command, {
        cwd,
        env: env || process.env,
        shell: true,
        stdio: ['ignore', log, log],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      finish({ exitCode: null, spawnError: err.message });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutSec * 1000);
    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ exitCode: null, spawnError: err.message });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      finish({ exitCode: code, signal });
    });
  });
}

function classify(check, cwd, exec, counts) {
  if (exec.timedOut) {
    return 'timed_out';
  }
  if (exec.spawnError) {
    return 'not_started';
  }
  if (exec.exitCode === null) {
    return 'killed';
  }
  if (exec.exitCode !== 0) {
    if ([126, 127, 9009].includes(exec.exitCode) || !R.commandResolves(check.command, cwd)) {
      return 'not_started';
    }
    return 'failed';
  }
  if (check.kind === 'test') {
    if (!validCounts(counts)) {
      return 'counts_unknown';
    }
    if (counts.total === 0 || counts.passed === 0) {
      return 'zero_tests';
    }
    if (counts.failed > 0) {
      return 'failed';
    }
  }
  return 'passed';
}

const OUTCOME_RESULT = {
  failed: ['FAILED', 'failed'],
  timed_out: ['UNVERIFIED', 'timed out'],
  not_started: ['UNVERIFIED', 'could not start'],
  killed: ['UNVERIFIED', 'was killed'],
  counts_unknown: ['UNVERIFIED', 'gave no recognisable test counts'],
  zero_tests: ['UNVERIFIED', 'ran zero passing tests'],
};

// Reads the candidate's changed source files and works out which mutants to try.
function planMutants(run, settings) {
  const { state } = run;
  const off = R.protectedPaths(R.spec(run));
  const all = [];
  const notMutated = [];
  for (const rel of [...state.candidate.added, ...state.candidate.modified].sort()) {
    if (M.isTestFile(rel) || M.isConfigOrTypes(rel) || matchesAny(rel, [...settings.exclude, ...off])) {
      continue;
    }
    const language = M.languageOf(rel);
    if (!language) {
      notMutated.push(rel);
      continue;
    }
    const after = fs.readFileSync(path.join(state.projectRoot, rel), 'utf8');
    const baseline = path.join(run.dir, 'baseline', rel);
    const before = fs.existsSync(baseline) ? fs.readFileSync(baseline, 'utf8') : null;
    for (const mutant of M.generateMutants(after, language, M.changedLines(before, after))) {
      all.push({ ...mutant, file: rel, ...M.describeMutant(after, mutant) });
    }
  }
  return { candidates: all.length, selected: M.selectMutants(all, settings.maxMutants), notMutated };
}

// Only real test failures count as caught. A mutant that stops the suite from building,
// or that crashes it before any test fails, says nothing about the tests.
function classifyMutant(check, exec, counts, limitedByBudget) {
  if (exec.timedOut) {
    return limitedByBudget ? 'not_tested' : 'killed';
  }
  if (exec.spawnError || exec.exitCode === null) {
    return 'invalid';
  }
  if (counts && counts.failed > 0) {
    return 'killed';
  }
  if (exec.exitCode === 0 && counts && counts.passed > 0) {
    return 'survived';
  }
  return 'invalid';
}

function mutationOutcome(summary, minScore) {
  const { killed, survived, notTested } = summary;
  const atLeast = (caught, total) => caught * 100 >= minScore * total;
  if (!atLeast(killed + notTested, killed + survived + notTested)) {
    return 'below_threshold';
  }
  if (notTested > 0) {
    return 'incomplete';
  }
  if (killed + survived === 0) {
    return 'all_invalid';
  }
  return atLeast(killed, killed + survived) ? 'passed' : 'below_threshold';
}

const MUTATION_HALTS = {
  no_mutants: 'The mutation check found nothing to mutate on the changed lines.',
  control_failed: "The tests didn't pass unmodified in the mutation check's copy of the project.",
  incomplete: 'The mutation check ran out of time before trying every mutant. Set mutation.command to a narrower test command, or lower mutation.maxMutants.',
  all_invalid: 'No mutant gave a usable test result: they broke the build or crashed the suite.',
};

async function runMutants(run, settings, plan, outDir) {
  const { state } = run;
  const started = Date.now();
  const deadline = started + settings.budgetSec * 1000;
  const check = settings.check;
  const results = [];
  const finish = (outcome, controlMs, reason) => {
    const count = (name) => results.filter((r) => r.status === name).length;
    const summary = { killed: count('killed'), survived: count('survived'), invalid: count('invalid'), notTested: count('not_tested') };
    const scored = summary.killed + summary.survived;
    return {
      outcome: outcome || mutationOutcome(summary, settings.minScore),
      reason: reason || null,
      score: scored > 0 ? Math.floor((summary.killed * 100) / scored) : null,
      minScore: settings.minScore,
      ...summary,
      candidates: plan.candidates,
      selected: plan.selected.length,
      survivors: results.filter((r) => r.status === 'survived').map(({ file, line, operator, original, mutated }) => ({ file, line, operator, original, mutated })),
      notMutated: plan.notMutated,
      command: check.command,
      controlMs,
      durationMs: Date.now() - started,
      results,
    };
  };
  if (plan.selected.length === 0) {
    return finish('no_mutants', null, plan.notMutated.length > 0 ? `Unsupported language: ${plan.notMutated.join(', ')}` : 'No mutable code on the changed lines.');
  }

  const box = createSandbox(state.projectRoot, Object.keys(state.candidate.files), R.protectedPaths(R.spec(run)), check.cwd || '.');
  // Without this, Python could reuse bytecode cached from a same-sized mutant of the same file.
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
  const cwd = path.resolve(box.dir, check.cwd || '.');
  try {
    const checkLimit = check.timeoutSec || 300;
    const controlLog = path.join(outDir, 'control.log');
    const control = await execute(check, cwd, controlLog, Math.min(checkLimit, settings.budgetSec), env);
    const controlCounts = check.parser ? parseCounts(check, fs.readFileSync(controlLog, 'utf8')) : null;
    const controlOutcome = classify(check, cwd, control, controlCounts);
    if (controlOutcome !== 'passed') {
      return finish('control_failed', control.durationMs, `Control run: ${controlOutcome}, exit ${control.exitCode}. See ${controlLog}. Tests may need a file that isn't copied: Git-ignored files and protected paths stay out.`);
    }
    const ownLimit = Math.min(checkLimit, Math.max(Math.ceil(control.durationMs / 1000) * 3 + 10, 30));
    const texts = new Map();
    for (const [index, mutant] of plan.selected.entries()) {
      const { start, end, replacement, line, file, operator, original, mutated } = mutant;
      const record = { id: index + 1, file, line, operator, original, mutated };
      const remainingSec = Math.floor((deadline - Date.now()) / 1000);
      if (remainingSec * 1000 < control.durationMs * 1.2 || remainingSec < 1) {
        results.push({ ...record, status: 'not_tested' });
        continue;
      }
      const target = path.join(box.dir, file);
      if (!texts.has(file)) {
        texts.set(file, fs.readFileSync(target, 'utf8'));
      }
      const source = texts.get(file);
      fs.writeFileSync(target, M.applyMutant(source, { start, end, replacement }));
      const log = path.join(outDir, `mutant-${String(index + 1).padStart(3, '0')}.log`);
      const limit = Math.min(ownLimit, remainingSec);
      const exec = await execute(check, cwd, log, limit, env);
      fs.writeFileSync(target, source);
      const counts = check.parser ? parseCounts(check, fs.readFileSync(log, 'utf8')) : null;
      const status = classifyMutant(check, exec, counts, limit < ownLimit);
      results.push({ ...record, status, exitCode: exec.exitCode, timedOut: exec.timedOut, counts, durationMs: exec.durationMs });
      R.logEvent(run, 'mutant', { id: index + 1, file, line, operator, status });
    }
    return finish(null, control.durationMs);
  } finally {
    if (!removeSandbox(box)) {
      R.logEvent(run, 'sandbox_left', { dir: box.dir });
    }
  }
}

// Loads the current state after a long step, listing the project first so that this read
// and the save that follows are moments apart. If the stage has moved on, the result
// arrived too late to count: it is logged and the state the hook recorded is left alone.
function resume(run, attempt, label, outcome) {
  const inventory = R.enumerate(run);
  let state = null;
  try { state = R.reloadState(run); } catch { state = null; }
  if (!state) {
    R.logEvent(run, 'storage_unreadable', { label, outcome });
    fail(`${label} finished (${outcome}), but the run's state could not be read afterwards, so the result was not recorded. Use gate abort to keep the evidence and release the project.`, 1);
  }
  if (state.closed || state.stage !== 'validator_running' || state.attempts.length !== attempt) {
    R.logEvent(run, 'late_result', { label, outcome });
    fail(`${label} finished (${outcome}) after the validator stage ended, so the result was not recorded.`, 1);
  }
  return inventory;
}

async function cmdMutation(root) {
  const run = requireActive(root);
  const { state } = run;
  const s = R.spec(run);
  if (state.halt) {
    fail(`Run has halted: ${state.halt.reason}`);
  }
  if (state.stage !== 'validator_running') {
    fail(`The mutation check runs only during the validator stage (now ${state.stage}).`);
  }
  if (!s.mutation) {
    fail('This run has no mutation check.');
  }
  if (state.mutation) {
    fail('The mutation check has already run. It runs once; there are no retries.');
  }
  const pending = s.checks.filter((c) => !state.checks[c.id] || state.checks[c.id].outcome !== 'passed').map((c) => c.id);
  if (pending.length > 0) {
    fail(`Run the declared checks first: ${pending.join(', ')}`);
  }
  const attempt = state.attempts.length;
  const matched = R.verify(run, 'before-mutation');
  R.saveState(run);
  if (!matched) {
    fail(state.halt.reason, 1);
  }

  const settings = R.mutationSettings(s);
  const outDir = path.join(run.dir, 'checks', 'mutation');
  fs.mkdirSync(outDir, { recursive: true });
  const { results, ...summary } = await runMutants(run, settings, planMutants(run, settings), outDir);
  fs.writeFileSync(path.join(outDir, 'mutants.json'), `${JSON.stringify(results, null, 2)}\n`);
  const inventory = resume(run, attempt, 'The mutation check', summary.outcome);
  if (run.state.mutation) {
    fail('The mutation check has already run. It runs once; there are no retries.', 1);
  }
  run.state.mutation = summary;
  R.logEvent(run, 'mutation', { outcome: summary.outcome, score: summary.score, killed: summary.killed, survived: summary.survived });
  if (MUTATION_HALTS[summary.outcome]) {
    R.halt(run, 'UNVERIFIED', summary.reason ? `${MUTATION_HALTS[summary.outcome]} ${summary.reason}` : MUTATION_HALTS[summary.outcome]);
  }
  R.verify(run, 'after-mutation', inventory);
  R.saveState(run);

  for (const m of summary.survivors) {
    process.stdout.write(`Not caught: ${m.file}:${m.line}: ${m.original} -> ${m.mutated}\n`);
  }
  process.stdout.write(`GATE_MUTATION ${R.mutationSummary(summary)}\n`);
  process.exit(summary.outcome === 'passed' && !run.state.halt ? 0 : 1);
}

async function cmdValidate(root, argv) {
  if (argv.includes('--mutation')) {
    return cmdMutation(root);
  }
  const run = requireActive(root);
  const id = arg(argv, 'check');
  const { state } = run;
  if (state.halt) {
    fail(`Run has halted: ${state.halt.reason}`);
  }
  if (state.stage !== 'validator_running') {
    fail(`Checks can run only during the validator stage (now ${state.stage}).`);
  }
  const checks = R.spec(run).checks;
  const index = checks.findIndex((c) => c.id === id);
  if (index < 0) {
    fail(`Unknown check: ${id}`);
  }
  const check = checks[index];
  if (state.checks[id]) {
    fail(`Check ${id} has already run. Checks run once; there are no retries.`);
  }
  // Checks run in the approved order: a later check may depend on an earlier one.
  const earlier = checks.slice(0, index).filter((c) => !state.checks[c.id]).map((c) => c.id);
  if (earlier.length > 0) {
    fail(`Checks run in order. Run ${earlier[0]} first.`);
  }

  const attempt = state.attempts.length;
  const matched = R.verify(run, `before-${id}`);
  R.saveState(run);
  if (!matched) {
    fail(state.halt.reason, 1);
  }
  const cwd = path.resolve(root, check.cwd || '.');
  const logPath = path.join(run.dir, 'checks', `${id}.log`);
  const exec = await execute(check, cwd, logPath, check.timeoutSec || 300);
  const output = fs.readFileSync(logPath);
  const text = output.toString('utf8');
  const counts = check.parser ? parseCounts(check, text) : null;
  const outcome = classify(check, cwd, exec, counts);
  const inventory = resume(run, attempt, `Check ${id}`, outcome);
  if (run.state.checks[id]) {
    fail(`Check ${id} has already run. Checks run once; there are no retries.`, 1);
  }
  run.state.checks[id] = {
    outcome,
    exitCode: exec.exitCode,
    signal: exec.signal || null,
    spawnError: exec.spawnError || null,
    counts,
    durationMs: exec.durationMs,
    logSha256: sha256(output),
    at: new Date().toISOString(),
  };
  R.logEvent(run, 'check', { id, outcome, exitCode: exec.exitCode, counts });
  if (outcome !== 'passed') {
    const [result, phrase] = OUTCOME_RESULT[outcome];
    R.halt(run, result, `Check ${id} ${phrase}.`);
  }
  R.verify(run, `after-${id}`, inventory);
  R.saveState(run);

  const tail = text.replace(/\r\n/g, '\n').trimEnd().split('\n').slice(-TAIL_LINES).join('\n');
  process.stdout.write(`${tail}\n\n`);
  process.stdout.write(`GATE_CHECK id=${id} outcome=${outcome} exit=${exec.exitCode} counts=${JSON.stringify(counts)}\n`);
  process.exit(outcome === 'passed' && !run.state.halt ? 0 : 1);
}

// The checks before the change share one budget, so `gate init` ends inside a
// 10-minute Bash call.
const BEFORE_BUDGET_SEC = 540;

// Runs every check once on the unchanged project. A check that already fails can't
// show what the change did, so it stops the run before any work, unless the spec lists
// it in failingBefore. Returns the reason the run can't start, or null.
async function checkBefore(run) {
  const s = R.spec(run);
  const mayFail = new Set(s.failingBefore || []);
  const dir = path.join(run.dir, 'checks', 'before');
  fs.mkdirSync(dir, { recursive: true });
  const started = Date.now();
  const before = {};
  let problem = null;
  for (const check of s.checks) {
    const own = check.timeoutSec || 300;
    const remaining = BEFORE_BUDGET_SEC - Math.floor((Date.now() - started) / 1000);
    const outOfTime = `The checks before the change ran out of time (${BEFORE_BUDGET_SEC} s in all) at ${check.id}. Use faster checks, or set "checkBefore": false.`;
    if (remaining < 1) {
      problem = outOfTime;
      break;
    }
    const limit = Math.min(own, remaining);
    const cwd = path.resolve(run.state.projectRoot, check.cwd || '.');
    const logPath = path.join(dir, `${check.id}.log`);
    const exec = await execute(check, cwd, logPath, limit);
    const output = fs.readFileSync(logPath);
    const counts = check.parser ? parseCounts(check, output.toString('utf8')) : null;
    const outcome = classify(check, cwd, exec, counts);
    before[check.id] = {
      outcome,
      exitCode: exec.exitCode,
      counts,
      durationMs: exec.durationMs,
      logSha256: sha256(output),
      mayFail: mayFail.has(check.id),
    };
    R.logEvent(run, 'check_before', { id: check.id, outcome, exitCode: exec.exitCode, counts });
    if (outcome !== 'passed' && !mayFail.has(check.id)) {
      problem = exec.timedOut && limit < own ? outOfTime
        : `Check ${check.id} ${OUTCOME_RESULT[outcome][1]} before any change, so the run couldn't tell what the change did. Fix the project first, or narrow the check. If the task is to make this check pass, list it in "failingBefore". Log: ${logPath}`;
      break;
    }
  }
  const changed = problem ? [] : R.changedSinceBaseline(run);
  if (changed.length > 0) {
    problem = `The checks changed files before any change: ${changed.join(', ')}. A check must not write to the project; list files it generates in declaredArtifacts.`;
  }
  let state = null;
  try { state = R.reloadState(run); } catch { state = null; }
  if (!state || state.closed || state.stage !== 'checking_before') {
    fail('The run changed while the checks before the change ran, so their results were not recorded. Use gate status.', 1);
  }
  state.before = before;
  return problem;
}

function tailOf(file, count) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trimEnd().split('\n').slice(-count).join('\n');
  } catch {
    return '';
  }
}

async function cmdInit(root, argv) {
  const file = arg(argv, 'spec');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file || 0, 'utf8'));
  } catch (err) {
    fail(`Could not read the spec as JSON: ${err.message}`);
  }
  const sessionId = arg(argv, 'session') || R.takePendingSession(root);
  let run;
  try {
    run = R.createRun(root, parsed, sessionId);
  } catch (err) {
    if (err instanceof R.SpecError) {
      fail(`SETUP_REQUIRED: ${err.message}`);
    }
    throw err;
  }
  if (run.state.halt) {
    fail(`${run.state.halt.result}: ${run.state.halt.reason}`);
  }
  process.stdout.write(`GATE_RUN ${run.state.runId} files=${Object.keys(run.state.baseline.files).length} method=${run.state.baseline.method}\n`);
  if (run.state.stage === 'checking_before') {
    const problem = await checkBefore(run);
    if (problem) {
      R.halt(run, 'SETUP_REQUIRED', problem);
      R.closeRun(run, 'init');
      const failed = Object.entries(run.state.before).find(([, e]) => e.outcome !== 'passed' && !e.mayFail);
      const tail = failed ? tailOf(path.join(run.dir, 'checks', 'before', `${failed[0]}.log`), 30) : '';
      process.stderr.write(`${tail ? `${tail}\n\n` : ''}`);
      fail(`SETUP_REQUIRED: ${problem}\nEvidence folder: ${run.dir}`);
    }
    run.state.stage = 'implementer_ready';
    R.saveState(run);
    const summary = Object.entries(run.state.before).map(([id, e]) => `${id} ${e.outcome}`).join(', ');
    process.stdout.write(`Checks before the change: ${summary}\n`);
  }
  process.stdout.write(`Evidence folder: ${run.dir}\nNext stage: implementer\n`);
}

// Deletes one file for the implementer, which has no other shell. The hook lets only
// the implementer call this; the gate checks the stage, scope and protection again.
function cmdRemove(root, argv) {
  const run = requireActive(root);
  const { state } = run;
  const target = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--project');
  if (state.halt) {
    fail(`Run has halted: ${state.halt.reason}`);
  }
  if (state.stage !== 'implementer_running') {
    fail(`Files can be removed only during the implementer stage (now ${state.stage}).`);
  }
  if (!target) {
    fail('Usage: gate remove <path>');
  }
  const abs = path.resolve(process.cwd(), target);
  const rel = projectRelative(state.projectRoot, abs);
  if (rel === null) {
    fail(`Path is outside the project: ${target}`);
  }
  const refused = R.editRefusal(R.spec(run), rel);
  if (refused) {
    fail(refused);
  }
  let st = null;
  try { st = fs.lstatSync(abs); } catch { st = null; }
  if (!st || !st.isFile()) {
    fail(`Not a file: ${rel}. Only single files can be removed.`);
  }
  fs.rmSync(abs);
  R.logEvent(run, 'removed', { file: rel });
  process.stdout.write(`Removed ${rel}\n`);
}

function cmdStatus(root) {
  const run = R.loadActive(root);
  if (!run) {
    process.stdout.write('No active run in this project.\n');
    return;
  }
  const { state } = run;
  process.stdout.write(`${JSON.stringify({
    runId: state.runId,
    stage: state.stage,
    next: R.expectedRole(state),
    halt: state.halt,
    changed: state.candidate ? state.candidate.changed : null,
    checks: Object.fromEntries(Object.entries(state.checks).map(([k, v]) => [k, v.outcome])),
    mutation: state.mutation ? state.mutation.outcome : null,
    verdict: state.review ? state.review.verdict : null,
    evidence: run.dir,
  }, null, 2)}\n`);
}

function cmdReport(root) {
  const run = requireActive(root);
  const { state } = run;
  if (!state.halt && state.stage !== 'report_ready') {
    fail(`The run is not finished (stage ${state.stage}). Finish it, or use gate abort.`);
  }
  const closed = R.closeRun(run, 'report');
  process.stdout.write(closed.report);
}

function cmdAbort(root, argv) {
  try {
    const run = requireActive(root);
    R.halt(run, 'UNVERIFIED', `Run aborted: ${arg(argv, 'reason') || 'no reason given'}`);
    const closed = R.closeRun(run, 'abort');
    process.stdout.write(closed.report);
  } catch (err) {
    process.stdout.write(R.recoverActive(root, arg(argv, 'reason') || 'no reason given', err));
  }
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const root = R.findProjectRoot(arg(argv, 'project') || process.cwd());
  switch (command) {
    case 'init': return cmdInit(root, argv);
    case 'validate': return cmdValidate(root, argv);
    case 'status': return cmdStatus(root);
    case 'report': return cmdReport(root);
    case 'abort': return cmdAbort(root, argv);
    case 'remove': return cmdRemove(root, argv);
    default: return fail('Usage: gate init|validate --check <id>|validate --mutation|remove <path>|status|report|abort [--reason text]');
  }
}

main().catch((err) => fail(err.stack || String(err)));
