---
name: develop
description: Run one change through an implementer, an independent validator and an independent reviewer, with the result computed from recorded evidence.
argument-hint: "<task>"
disable-model-invocation: true
---

# dev-gate: one change, three independent stages

Task from the user: $ARGUMENTS

The gate is `node "${CLAUDE_PLUGIN_ROOT}/bin/gate.cjs"`. Use that exact form, with the path in double quotes and nothing added before the command or after the arguments. Don't put `cd` in front: the session already runs in the project folder. Hooks enforce the stages and refuse anything out of order. Treat a refusal as information; never work around one.

## 1. Draft the spec

Read the project's guidance and `.claude/dev-gate.json` if it exists (its values are defaults for the spec). Work out:

- **task** and **acceptance**: concrete, checkable criteria.
- **scope**: the paths the implementer may edit, as narrow as the task allows, including tests if they should change. The implementer can also delete files in scope, so list files the task removes.
- **protected** (optional): paths blocked for `Read`, `Grep` and edits for root and all stages, such as secrets. Directory searches that contain protected paths are refused; search an unprotected file or narrower directory. Default `.env*` protection doesn't cover files inside `node_modules`, `.venv` or `venv` for `Read` and `Grep`, so list any such path you need protected. These hooks don't cover file references, `Glob`, shell output or check commands; use permission deny rules for real secrets.
- **checks**: real commands from the project's own scripts and configuration. Each has `id`, `kind` (`test`, `typecheck`, `build` or `lint`), `command`, `cwd`, and optional `timeoutSec` (at most 570). A `test` check also needs `parser`: `unittest`, `node-test`, `jest`, `vitest`, `pytest`, or `regex` with a `countRegex` using a required named group `passed` and optional `failed`, `skipped` and `total` groups. Counts must be nonnegative integers, agree with the total, and include a positive passing count. Include at least one test check. Don't choose commands that install, deploy or use the network, or that change files, such as a lint `--fix`.
- **Checks before the change:** `gate init` runs every check once on the unchanged project, and a check that already fails stops the run with `SETUP_REQUIRED`. So prefer checks the project passes now: for example, lint only the scope's paths if the whole project has old lint errors. All of them share 540 s.
  - **failingBefore** (optional): ids of checks allowed to fail before the change, for a task whose point is to make them pass, such as a fix with a failing test already written. If the project already has a test for the bug being fixed, include its check here. It still has to pass afterwards.
  - **checkBefore** (optional, `true` by default): set `false` only if the user agrees, for checks too slow to run twice.
- **declaredArtifacts** (optional): files the checks generate that aren't git-ignored.
- **requireTests** (optional, off by default): set `true` only if the user asks for it. The reviewer must then name a test for every acceptance criterion. Otherwise the run goes to repair, and then `FAILED`. Write each criterion so that a test can check it. A criterion like "nothing else changes" has no natural test, so leave it out and rely on the scope instead.
- **maxRepairs** (optional): `1` by default, which lets a rejection go back to the implementer once. Set `0` if the user wants no repair.
- **mutation** (include it when the change edits JavaScript, TypeScript or Python logic; use `{}` for the defaults): the gate makes small breaks on the changed lines, in a temporary copy of the project, and confirms the tests catch them. Only suggest it if the test suite is safe to run repeatedly: no real databases or external services. The scope should include the tests, so a repair can add them. Omit it for changes with no logic to break, such as documentation or configuration, and for other languages. Otherwise the run ends `UNVERIFIED`. Options:
  - `check`: the test check to use. The default is the first one.
  - `command`: a narrower test command with the same output format. Each break runs it once, so use one when the full suite is slow: for example the tests for the changed area. A too-narrow command makes breaks look uncaught, so it can't hide a gap.
  - `budgetSec` (default 480, at most 570) and `maxMutants` (default 12, at most 200). Running out of budget gives `UNVERIFIED`, so check that `maxMutants` runs fit.
  - `minScore` (default 100): the percentage of breaks the tests must catch. Lower it only if the user agrees: it lets any break go uncaught, including an important one.
  - `exclude`: paths not to break. Test files are always left out.

Only inspect the project at this point; don't change or run anything.

## 2. Get approval

Show the user the spec and ask them to approve it, unless they already approved these exact details in this request. If scope or checks can't be established, ask. Don't guess.

## 3. Start the run

Use the Bash tool with a timeout of 600000, passing the approved spec as JSON on stdin:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/gate.cjs" init <<'SPEC'
{ ...spec... }
SPEC
```

It runs the checks before it returns, so it can take minutes. If it prints `SETUP_REQUIRED`, report its reason and the log lines it printed, and stop. If a check failed before the change, say so plainly. If the task is to make that check pass, offer the same spec with the check in `failingBefore`, and start again only after the user approves it. Otherwise the project needs fixing first, or the spec needs a narrower check, and that takes a new request. From here until the report, you may not edit files or run other commands. All the work happens in the stages.

## 4. Run the stages, one at a time

Use the Agent tool for each, and wait for it to finish before starting the next. If the tool offers `run_in_background`, set it to false. A stage may still run in the background: if so, end your turn without checking on it, and start the next stage when you're told it has finished.

1. `subagent_type: "dev-gate:implementer"`
2. `subagent_type: "dev-gate:validator"`
3. `subagent_type: "dev-gate:reviewer"`

Each prompt should be one line asking the agent to carry out its role in the current run. The gate gives each agent its own details. **Don't pass the implementer's explanation to the reviewer.** Don't do a stage's work yourself, and don't retry a stage.

If a spawn is refused because the run halted, go straight to step 5.

If a stage can't finish, for example because the session was closed and reopened while it ran, run `node "${CLAUDE_PLUGIN_ROOT}/bin/gate.cjs" status`. A stage still shown as running, with no agent working on it, is a dead stage. Don't resume it, restart it or do its work. Tell the user, and offer to end the run with `node "${CLAUDE_PLUGIN_ROOT}/bin/gate.cjs" abort --reason "<why>"`. That gives `UNVERIFIED` and frees the project, and only then can a new request start another run. Abort only if the user agrees.

After the reviewer finishes, run `node "${CLAUDE_PLUGIN_ROOT}/bin/gate.cjs" status`. If it shows `"next": "implementer"`, the gate has allowed its one repair, even if the reviewer approved: the mutation check can also ask for one. Run all three stages again in the same order. The gate gives the agents the findings, so don't pass them yourself. Otherwise go to step 5. The gate alone decides whether a repair happens; never ask for one yourself.

## 5. Report

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/gate.cjs" report
```

Print its output verbatim. The gate computes the result; you may add a short note below it, but don't restate the result differently. A note about why a run failed must come from the evidence: read the log or file the report names first, and say only what it shows. If you haven't read it, say where the log is instead of guessing. On `FAILED` or `UNVERIFIED`, stop there. A new attempt needs a new request from the user.
