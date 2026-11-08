# dev-gate

`dev-gate` is a Claude Code plugin that takes one requested change through three separate agents: an implementer, a validator and a reviewer. You approve the requirements, the paths that may be edited and the commands that check the work before anything starts. A small script, not a model, enforces the stage order and works out the final result from recorded evidence.

The aim is to make an AI-generated change easier to judge: what changed, which checks really ran, whether the reviewed files are the tested files, and what remains unverified.

**Status:** version 0.1.0. It has been tested only on Windows 11, in a small number of real runs.

## Why use it

When one agent writes a change, picks its checks and summarizes the result, a convincing explanation can hide incomplete verification. Code and tests can also share the same wrong assumption. `dev-gate` splits those jobs and adds checkpoints, so you have more evidence when deciding whether to accept a change.

| Problem | What dev-gate does |
| --- | --- |
| Test results are reported without evidence | The gate runs the approved checks itself and records their exit codes, parsed test counts and output logs. Agent summaries don't decide the result. |
| The author misses its own assumptions | A separate reviewer reads the code, the acceptance criteria and the check evidence without the implementer's explanation. It can't edit files. |
| A small task grows into unrelated changes | Edits are limited to the approved paths. File snapshots catch changes outside scope, and changes made after the implementer finished. |
| Tests pass without noticing wrong behaviour | The optional mutation check makes small breaks on the changed lines and checks that the tests catch them. |
| Missing verification is presented as success | A `PASS` needs every recorded stage, check, file comparison and the reviewer's approval. Missing evidence gives `UNVERIFIED`. |
| Review findings lead to untracked retries | One repair is allowed by default, for concrete review findings or a low mutation score. The report keeps the evidence from both attempts. |

It suits bounded changes in projects with an existing, repeatable test suite. Every run needs at least one test check. Several agents and repeated checks add time and model cost, and the mutation check adds a control run plus one test run per break, so for a minor edit the overhead may outweigh the benefit.

You remain responsible for the requirements and the final decision. A `PASS` means the configured workflow succeeded. It doesn't prove the tests are complete or the change is correct.

## How it works

```text
Request -> Approved spec -> Checks before -> Implementer -> Validator -> Reviewer -> Report
                                 ^                         |
                                 +---- one repair, if -----+
                                       the gate allows it
```

| Part | Job |
| --- | --- |
| Implementer | Reads the project, and edits or deletes only approved paths. Its only shell command is the gate's `remove`, one file in scope at a time. |
| Validator | Runs the spec's checks through the gate, in order. Can't edit files or change the commands. |
| Reviewer | Reads the changed files and the tests, then approves or returns concrete findings. Has no edit or shell tools. |
| Gate and hooks | Enforce stage order and tool limits, compare file hashes at checkpoints, record evidence and compute the result. |

The gate records a baseline before the implementer starts and fingerprints the files when it finishes. Validation and review are checked against that fingerprint, so a file changed later can't inherit an earlier passing result. Uncommitted changes already in your working tree become part of the baseline.

Before any stage starts, `gate init` runs every check once on the unchanged project. A check that already fails can't show what the change did, so it stops the run with `SETUP_REQUIRED`, and the report shows its log. For a task whose point is to make a failing check pass, list it in `"failingBefore"`; it must still pass afterwards. `"checkBefore": false` skips this for checks too slow to run twice. The checks before the change share 540 s, so `gate init` fits in one Bash call.

## Requirements

- Claude Code 2.1.317 or later. The hooks rely on recent hook features. Tested on 2.1.317 to 2.1.319.
- Node.js on your `PATH`, tested on Node 24. The plugin has no other dependencies.
- Git is recommended. Without it, the gate walks the project folder instead of using `git ls-files`.
- Windows 11. Linux and macOS are out of scope.

## Install

Clone the repository, then add your copy as a plugin marketplace. The commands below use `C:/Develop/agents/claude_agents`; replace it with your checkout location. Adding the marketplace is a one-time step that writes to your user configuration:

```bash
git clone https://github.com/vavanv/claude_agents.git C:/Develop/agents/claude_agents
claude plugin marketplace add C:/Develop/agents/claude_agents
```

Then, from the project you want to use it in:

```bash
claude plugin install dev-gate@claude-agents --scope local
claude plugin list
```

`dev-gate` should be listed. `--scope local` writes only `.claude/settings.local.json` in that project. Your `CLAUDE.md` and `AGENTS.md` aren't touched.

Installed this way, from a local folder, the plugin loads from that folder, so keep it in place. Edits apply at the next session start or after `/reload-plugins`, with no version change or reinstall. `claude plugin list` shows the folder as `readFromFolder`. To try it without installing, use `claude --plugin-dir C:/Develop/agents/claude_agents/plugin`.

## Use

Start `claude` in your project, then enter:

```text
/dev-gate:develop Fix the lower-bound bug in clamp
```

1. Claude drafts a spec: acceptance criteria, the paths that may be edited, and the commands that check the work. You approve it.
2. The gate runs the checks once on the unchanged project, and stops if one already fails.
3. The **implementer** makes the change. Its only shell command deletes one file in scope, and edits outside the approved paths are refused.
4. The **validator** runs each check through the gate, which records the real exit code and test counts. If the spec asks for it, it also runs the mutation check.
5. The **reviewer** reads the code and returns a verdict. It can't edit anything.
6. The gate prints the report.

Stages may run in the background, one at a time. Don't change files yourself until the report has printed.

| Result | Meaning |
| --- | --- |
| `PASS` | All stages finished, all checks passed with at least one test, the reviewer approved, the mutation check passed if requested, and the files never changed after the implementer finished. |
| `FAILED` | A check, the reviewer or the mutation check rejected the change, or files changed that shouldn't have. |
| `UNVERIFIED` | Required evidence is missing: for example a command couldn't start, no tests ran, a stage didn't finish, or the mutation check couldn't get a result. |
| `SETUP_REQUIRED` | The run stopped before any work, because of a bad spec, a missing command, or a check that already failed before the change. |

The report also lists each acceptance criterion with the test the reviewer says covers it, or says the reviewer checked it only by reading. That's the reviewer's statement, not something the gate measured, so it doesn't change the result. A `PASS` with any criterion lacking a named test carries a note.

To make that binding, add `"requireTests": true` to the spec. A criterion with no named test then goes back to the implementer once, like a review finding, and the run is `FAILED` if it still has none. A reviewer that gives no readable list makes it `UNVERIFIED`. This still rests on the reviewer's statement: a reviewer that names a test which doesn't really cover the criterion isn't caught. Write each criterion so that a test can check it. Something like "nothing else changes" has no natural test, so rely on the scope for that.

If the reviewer rejects a change with concrete findings, or the mutation check finds breaks the tests miss, the gate sends those findings back to the implementer once, and all three stages run again with new agents. The report keeps both attempts. Set `"maxRepairs": 0` in the spec to turn this off.

Nothing else is retried: a failed check, a changed candidate, or a second rejection ends the run. Its changes stay in your working tree for you to keep or discard.

### Evidence you can inspect

Evidence for each run is kept in `~/.claude/dev-gate/runs/`, and the report's last line gives the folder. It holds:

- `report.md` and `report.json`: changed paths, the file fingerprint, checkpoint comparisons, check results and test counts, mutation results if requested, reviewer findings, and any earlier repair attempt.
- `spec.json`, `state.json` and `events.jsonl`: the approved spec, the run's state and its event history.
- The check logs, with those from before the change in `checks/before/`.
- The original files in `baseline/` and a copy of each changed file in `changes/attempt-N/files/`. Protected files aren't copied.

To see what a run changed, compare the two copies, for example:

```bash
git diff --no-index baseline/src/a.txt changes/attempt-1/files/src/a.txt
```

The report also has a model audit, which compares the local transcripts with the configured models. Its outcome doesn't affect `PASS` or `FAILED`.

### Permission prompts

How many prompts you see depends on your Claude Code permission settings and on the checks in the spec. In the default mode, expect prompts for reading the project, starting the run, edits, checks and the report.

If Claude Code offers to always allow a broad rule such as `node *`, note that it covers every Node command, not just the gate.

Answer the prompt for `gate init` within 60 seconds. After that the run starts without a session id, and its limits then apply to every session in that project until the run ends.

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
- **The copy holds the files in the gate's file list,** minus protected paths. With Git, that's the files Git doesn't ignore. `node_modules`, `.venv` and `venv` are linked, not copied, so a test that writes to them changes the real folder. Tests that need `.env` or a build output fail in the copy, which gives `UNVERIFIED`.

### Project defaults

The skill reads an optional `.claude/dev-gate.json` for defaults such as protected paths and common checks. Claude reads it when drafting the spec, and the gate itself doesn't, so check that the spec you approve includes them.

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

Aborting gives `UNVERIFIED`, unless the run had already stopped with a result, which is kept. If the active pointer or state is corrupt, `abort` archives the pointer and writes an `UNVERIFIED` recovery report, preserving the original run evidence. Other hooked actions stay blocked until recovery. As a last resort, `claude plugin disable dev-gate` turns the hooks off.

### Questions

**The reviewer rejected the change. Can I fix it and rerun only the reviewer?**
No. The gate already sends the findings back to the implementer once, and all three stages run again. After that the run is closed, and no stage can run again. The checks and the reviewer's verdict apply to the change as it was frozen when the implementer finished. A reviewer approving code that no validator checked would defeat the point. To continue, fix the code yourself without a gate verdict, or start a new `/dev-gate:develop` request with the findings in the task. A new run starts from the project as it is now, including your fix.

**Can I edit files while a run is going?**
Don't. The hooks only limit Claude, not your editor. If you change a file after the implementer finishes, the gate's next comparison with the frozen change doesn't match, and the run can't get `PASS`. Wait until the report has printed.

**Can I allow more than one repair?**
No. `maxRepairs` can be `1`, the default, or `0`. A second rejection ends the run, so that retries don't go on until a reviewer happens to approve.

**The run ended `FAILED`. What happened to my files?**
The gate doesn't undo anything. The implementer's changes stay in your working tree for you to keep or discard. The evidence folder keeps the original files and a copy of each attempt, as described in [Evidence you can inspect](#evidence-you-can-inspect).

## Uninstall

From the project:

```bash
claude plugin uninstall dev-gate@claude-agents --scope local
```

To remove the marketplace from your user configuration as well:

```bash
claude plugin marketplace remove claude-agents
```

Run evidence stays in `~/.claude/dev-gate/runs/`.

## What this doesn't guarantee

Use it with supervision. Real runs have been few, so there's no measured reliability rate, and it isn't suited to unattended use.

- **These are guardrails, not security.** They catch drift and mistakes, not a hostile agent. Claude Code's Bash sandbox doesn't run on native Windows.
- **Files are compared at checkpoints.** With Git, the comparison covers the tracked and untracked files that `git ls-files --exclude-standard` lists. Without Git, a folder walk skips dependency and common output folders. Git-ignored files, declared artifacts and changes undone between checkpoints aren't covered.
- **Commands run by checks aren't restricted.** They run with your permissions, so only approve commands you trust.
- **Protected content is guarded in `Read`, `Grep` and edits, including root access.** Directory searches are refused if their tree contains protected paths, even when search filters would exclude them; search an unprotected file or smaller directory instead. A `.env*` file inside `node_modules`, `.venv` or `venv` is treated as part of a package, so it's readable and doesn't block a search, unless you list it in `protected`; edits to it are still refused. Don't keep real secrets there under those names. A real `.env` at the project root means root-level searches are refused. `Glob`, file references, shell output and check commands aren't content boundaries, so use permission deny rules as well for real secrets.
- **Separate agents can share blind spots.** A `PASS` doesn't prove the change is correct or fully tested. In testing, one reviewer rejected a test gap that another reviewer, given the same spec, approved. The mutation check narrows this, but it tries only a limited set of breaks on changed lines, and it can't tell whether the requirements themselves are right.
- **A passing criterion can have no test.** Without `requireTests`, a criterion whose behaviour is outside the changed lines and untested gets only a note, and nothing stops a `PASS`.
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
```

## License

[MIT](LICENSE)
