# dev-gate

**A structured implementation, validation and review workflow for AI-assisted code changes.**

`dev-gate` is a Claude Code plugin that takes a bounded development task through three separate agents: an implementer, a validator and a reviewer. You approve the requirements, editable paths and verification commands before work starts. A Node.js gate enforces the workflow and computes the final result from recorded evidence.

The goal is to make AI-generated changes easier to assess: what changed, which checks actually ran, whether the reviewed files match the tested files, and what remains unverified.

**Status:** version 0.1.0. Local testing has been limited to Windows 11; broader reliability and cross-platform compatibility have not been established.

## Why use dev-gate?

AI coding agents can produce useful changes quickly, but evaluating those changes still takes work. When the same agent implements a solution, selects its checks and summarizes the result, a convincing explanation can hide an incomplete verification process. Code and tests can also share the same mistaken assumption.

`dev-gate` adds explicit checkpoints and separates responsibilities so you have more evidence when deciding whether to accept a change.

| Problem | What dev-gate does |
| --- | --- |
| Test results are reported without enough evidence | The gate executes the approved checks and records their exit codes, parsed test counts and output logs. Agent summaries do not determine the result. |
| The author overlooks its own assumptions | A separate reviewer inspects the code, acceptance criteria and validation evidence without receiving the implementer's reasoning. The reviewer cannot edit files. |
| A small task grows into unrelated changes | Approved path rules restrict edits. File snapshots detect changes outside scope and changes to the candidate after implementation. |
| Tests pass without detecting faulty behavior | Optional mutation testing introduces small faults on changed lines and checks whether the tests detect them. |
| Missing verification is presented as success | A `PASS` requires the recorded stages, checks, candidate comparisons and reviewer approval. Missing required evidence produces `UNVERIFIED`. |
| Review findings lead to repeated, untracked attempts | One automatic repair is allowed by default for concrete review findings or a mutation score below the required threshold. The report preserves evidence from both attempts. |

### What it can help you achieve

- **Review focused bug fixes with clearer evidence.** Define the expected behavior, constrain the affected files, and retain the checks and review findings for that change.
- **Find gaps in regression tests.** For example, mutation testing can change `age >= 18` to `age > 18`. Tests that never exercise the boundary may still pass, exposing a missing case.
- **Keep maintenance work within an agreed scope.** Use explicit file patterns for a targeted refactor or feature change, including the tests that may need updating.
- **Investigate unsuccessful runs.** Check logs, file fingerprints, reviewer findings and earlier attempts help distinguish a code failure from an incomplete verification.

The workflow is best suited to bounded changes in projects with an existing, repeatable test suite. Every run requires at least one test check. Multiple agents and repeated checks add latency and model cost; mutation testing adds a control run and one test run per selected mutation. For minor edits, this overhead may outweigh the benefit.

You remain responsible for the requirements and the final acceptance decision. A `PASS` means the configured workflow succeeded; it does not establish complete test coverage or guarantee correctness.

## How it works

```text
Request -> Approved specification -> Implementer -> Validator -> Reviewer -> Report
                                          ^                        |
                                          +-- One eligible repair -+
```

| Component | Responsibility |
| --- | --- |
| Implementer | Reads the project and edits only approved paths. Has no shell access. |
| Validator | Invokes the gate's declared checks in order. Cannot edit files or substitute commands. |
| Reviewer | Reads the candidate and relevant tests, then returns approval or concrete findings. Has no edit or shell tools. |
| Gate and hooks | Enforce stage order and tool restrictions, compare file hashes at checkpoints, record evidence and compute the result. |

The gate captures a baseline before implementation and fingerprints the candidate afterward. Validation and review are checked against that candidate so a detected file change cannot silently inherit an earlier passing result. Existing working-tree changes are included in the baseline.

## Requirements

- Claude Code 2.1.317 or later. The hooks rely on recent hook features. It was tested on 2.1.317 and 2.1.318.
- Node.js on your `PATH`, tested on Node 24. The plugin has no other dependencies.
- Git is recommended. Without it, the gate walks the project folder instead of using `git ls-files`.

## Install

Keep a local copy of this repository and add it as a plugin marketplace. The commands below use `C:/Develop/agents/claude_agents`; replace that path with your checkout location. Adding the marketplace is a one-time operation that writes to your user configuration:

```bash
claude plugin marketplace add C:/Develop/agents/claude_agents
```

Then, from the project you want to use it in:

```bash
claude plugin install dev-gate@claude-agents --scope local
claude plugin list
```

`dev-gate` should be listed. `--scope local` writes only `.claude/settings.local.json` in that project, and your `CLAUDE.md` and `AGENTS.md` aren't touched.

The plugin loads from this folder, so keep the folder in place. Edits here apply at the next session start or after `/reload-plugins`.

To try it without installing, start Claude Code from your project with `claude --plugin-dir C:/Develop/agents/claude_agents/plugin`.

## Use

Start `claude` in your project, then enter:

```text
/dev-gate:develop Fix the lower-bound bug in clamp
```

1. Claude drafts a spec: acceptance criteria, the paths that may be edited, and the commands that check the work. You approve it.
2. The **implementer** makes the change. It has no shell, and edits outside the approved paths are refused.
3. The **validator** runs each check through the gate, which records the real exit code and test counts. If the spec asks for it, it also runs the mutation check.
4. The **reviewer** reads the code and returns a verdict. It can't edit anything.
5. The gate prints the report.

Stages may run in the background, one at a time. Don't change files yourself until the report has printed.

| Result | Meaning |
| --- | --- |
| `PASS` | All stages finished, every declared check passed, each test check recorded at least one passing test and no failures, the reviewer approved, the mutation check passed if requested, and candidate comparisons matched at the required checkpoints. |
| `FAILED` | A check, the reviewer or the mutation check rejected the change, or files changed that shouldn't have. |
| `UNVERIFIED` | Required evidence is missing: for example a command couldn't start, no tests ran, a stage didn't finish, or the mutation check couldn't get a result. |
| `SETUP_REQUIRED` | The run stopped before any work, because of a bad spec or a missing command. |

If the reviewer rejects a change with concrete findings, or the mutation check finds breaks the tests miss, the gate sends those findings back to the implementer once, and all three stages run again with new agents. The report keeps both attempts. Set `"maxRepairs": 0` in the spec to turn this off.

Nothing else is retried: a failed check, a changed candidate, or a second rejection ends the run. Its changes stay in your working tree for you to keep or discard.

Evidence for each run is kept in `~/.claude/dev-gate/runs/`, and the report's last line gives the folder.

### Evidence you can inspect

Each completed run produces a Markdown report (`report.md`) and a JSON report (`report.json`). The run directory also retains the approved specification (`spec.json`), state (`state.json`), event history (`events.jsonl`) and check logs.

The reports include changed paths, the candidate fingerprint, checkpoint comparisons, check outcomes and test counts, mutation results when requested, reviewer findings and any earlier repair attempt. A separate model audit compares local transcript records with the configured models; its outcome does not determine `PASS` or `FAILED`.

### Permission prompts

Permission prompts depend on your Claude Code configuration and the checks in the specification. In `manual` mode, expect prompts for inspection, initialization, edits, validation and reporting. Prompts from background stages identify the requesting agent.

In local testing, the broad persistent permission offered for gate commands was `node *`, which covers every Node command. The pending session identifier expires after 60 seconds: if approval of `gate init` takes longer, the run may start without a session identifier. Its restrictions then apply to every hooked session in that project until the run closes.

### Mutation check

Passing tests don't show that the tests would notice a wrong implementation. Add `mutation` to the spec and the gate tests this itself: it makes small breaks on the lines the implementer changed, such as forcing a condition to true or swapping `<=` for `<`, and runs the tests once per break. It uses no model, and it works in a temporary copy, so your files are never mutated.

```json
"mutation": {
  "command": "npx --no-install jest --runInBand src/billing",
  "maxMutants": 30,
  "budgetSec": 300
}
```

All the settings are optional, and `{}` uses the defaults:

| Setting | Default | Meaning |
| --- | --- | --- |
| `check` | First test check | The test check whose parser, working folder and command are used. |
| `command` | That check's command | A narrower command with the same output format. Each break runs it once, so use one if the full suite is slow. |
| `maxMutants` | 12 | How many breaks to try, from 1 to 200. If there are more, one is chosen per line first, and the choice is repeatable. |
| `budgetSec` | 480 | Total time allowed, up to 570. |
| `minScore` | 100 | The percentage of breaks the tests must catch. |
| `exclude` | None | Paths not to break. Test files are always left out. |

| Mutation outcome | Run result |
| --- | --- |
| Enough breaks caught | Doesn't block a `PASS`. Any uncaught breaks are still listed. |
| Too few caught | Repair if one is left, otherwise `FAILED`, even if the reviewer approved. |
| Unmodified tests fail in the copy, nothing to break on the changed lines, unsupported language only, every break stopped the suite from building, or out of time | `UNVERIFIED` |

- **Only a real test failure counts as caught,** or a hang. A break that stops the suite from building or crashes it before a test fails is left out of the score.
- **The default needs every break caught.** Some breaks can't be caught in practice, or don't change behaviour. For example, `now <= end` versus `now < end` needs a frozen clock. Lowering `minScore` allows for this, but it can't choose which breaks to let through, so it could also let through an important one.
- **JavaScript, TypeScript and Python are supported.** Other changed files are listed in the report as not mutated.
- **Use it only with tests that are safe to repeat.** Mutated code runs your tests up to `maxMutants` more times, with your permissions. Don't use it if they touch real databases or external services.
- **The copy uses the candidate's file inventory,** minus protected paths. `node_modules`, `.venv` and `venv` are linked, not copied, so a test that writes to them changes the real folder. Tests that need an omitted `.env` or build output fail in the copy, which gives `UNVERIFIED`.

### Project defaults

The skill reads an optional `.claude/dev-gate.json` for defaults such as protected paths and common checks. Claude reads this file when drafting the spec, and the gate itself doesn't, so check that the spec you approve includes them.

```json
{
  "protected": ["secrets/**", "config/production.*"],
  "checks": [
    { "id": "types", "kind": "typecheck", "cwd": ".", "command": "npx --no-install tsc --noEmit" },
    { "id": "unit", "kind": "test", "parser": "jest", "cwd": ".", "command": "npx --no-install jest --runInBand" }
  ]
}
```

### If a run gets stuck

Run these from your project. If you closed the session while a stage was running, that stage won't finish on its own, and `status` still shows it as running.

```bash
node C:/Develop/agents/claude_agents/plugin/bin/gate.cjs status
node C:/Develop/agents/claude_agents/plugin/bin/gate.cjs abort --reason "why"
```

Aborting an unfinished run produces `UNVERIFIED` unless the gate has already recorded a halt result; the first halt is preserved. If the active pointer or state is corrupt, `abort` archives the pointer and writes an `UNVERIFIED` recovery report, preserving the original run evidence. Other hooked actions stay blocked until recovery. As a last resort, `claude plugin disable dev-gate` turns the hooks off.

## Uninstall

From the project:

```bash
claude plugin uninstall dev-gate@claude-agents --scope local
```

To remove the marketplace from your user config as well:

```bash
claude plugin marketplace remove claude-agents
```

Run evidence stays in `~/.claude/dev-gate/runs/`.

## Limitations

Use it with supervision. Real runs have been few, so there's no measured reliability rate, and it isn't suited to unattended use.

- **These are guardrails, not security.** They catch drift and mistakes, not a hostile agent. Claude Code's Bash sandbox doesn't run on native Windows.
- **Files are compared at checkpoints.** With Git, the inventory covers tracked and untracked files that `git ls-files --exclude-standard` enumerates. Without Git, a directory walk skips dependency and common output folders. Declared artifacts and changes undone between checkpoints aren't covered.
- **Commands run by checks aren't restricted.** They run with your permissions, so only approve commands you trust.
- **Protected content is guarded in `Read`, `Grep` and edits, including root access.** Directory searches are refused if their tree contains protected paths, even when search filters would exclude them; search an unprotected file or smaller directory instead. A `.env*` file inside `node_modules`, `.venv` or `venv` is treated as part of a package, so it's readable and doesn't block a search, unless you list it in `protected`; edits to it are still refused. Don't keep real secrets there under those names. A real `.env` at the project root means root-level searches are refused. `Glob`, file references, shell output and check commands aren't content boundaries, so use permission deny rules as well for real secrets.
- **Separate agents can share blind spots.** A `PASS` doesn't prove the change is correct or fully tested. In testing, one reviewer rejected a test gap that another reviewer, given the same spec, approved. The mutation check narrows this, but it tries only a limited set of breaks on changed lines, and it can't tell whether the requirements themselves are right.
- **A passing criterion can have no test.** If a criterion's behaviour is outside the changed lines and untested, neither the mutation check nor a non-blocking review note stops a `PASS`.
- **The model audit reads a local transcript.** It's a record, not an attestation.

## Project layout

```text
.claude-plugin/marketplace.json   Local marketplace definition
plugin/agents/                    Implementer, validator and reviewer
plugin/skills/develop/SKILL.md    The /dev-gate:develop command
plugin/hooks/hooks.json           Hook registration
plugin/bin/gate.cjs               Gate command line
plugin/bin/hook.cjs               Hook entry point
plugin/bin/lib/                   Run state, parsers and mutation check
test/                             Tests
```

## Tests

```bash
npm test
```

No dependency installation is needed. The suite uses Node's built-in test runner and makes no model calls. It covers workflow ordering, scope restrictions, candidate integrity, test-output parsing, review and repair handling, mutation testing and recovery from corrupt state. These automated checks do not replace live testing in Claude Code.
