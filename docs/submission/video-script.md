# Team Asterix four minute demo

Target **3:55**, leaving five seconds spare. Paste the [exact A and B prompts](demo.md) instead of typing them. A and C passed real-model rehearsals. Task B’s generated changes pass independent acceptance checks, but its run was cancelled before the final summary. Record a fresh complete sequence before submission. Keep instruction-to-diff interactions continuous, as required by the PDF.

| Time | Show | Say |
|---|---|---|
| 0:00–0:10 | Anvil in the editor; Flask tag `3.1.3`, commit `22d92470`, clean status. | “We’re Team Asterix. This is Anvil, our editor-native coding agent powered by TrueForge. Here are the three fixed tasks on Flask.” |
| 0:10–0:25 | **A:** select `get_debug_flag`, invoke inline edit, paste Prompt A. Show streaming, press Escape before applying, then repeat. | “Edits stream directly into the editor. Escape stops generation without applying the proposal.” |
| 0:25–0:45 | Per-hunk Accept/Reject controls. Accept both changes. Run the A command below; hold on `False`. | “We review every hunk before applying it. With `FLASK_DEBUG=off`, the result is False.” |
| 0:45–0:55 | **Undo Last Applied Change**, restored source, empty `git status --short`. | “Applied changes are undoable. The original file is restored.” |
| 0:55–1:10 | **B:** briefly show `@file`/`@symbol` suggestions, clear them, then send Prompt B with no mentions. | “For agent mode, we describe the outcome without naming files.” |
| 1:10–1:35 | Context card: paths, reasons, budget; scout findings. | “The scout finds the implementation, tests, and documentation. Context selection explains each choice and stays within its token budget.” |
| 1:35–2:20 | Review implementation, test, and documentation hunks; accept. Approve verification. | “TrueForge runs the tool loop. Each proposed file change comes back through review.” |
| 2:20–2:50 | Passing CLI tests, `config` in help, masked JSON, and three-file diff. | “Tests pass. Config appears in help, sensitive values are masked, and the change spans code, tests, and documentation.” |
| 2:50–3:10 | **Session ↗**: actual Task B session, scout thread, MCP calls, approvals. | “This is the actual TrueForge session, including the scout, tool calls, and approvals.” |
| 3:10–3:40 | **C:** clean resilience workspace; broken primary then working fallback. Repeat Prompt A. Show retries, automatic fallback, responsive editor. Reject all hunks. | “Now the primary endpoint is unreachable. Anvil retries with backoff and switches automatically to the fallback. We reject the proposal.” |
| 3:40–3:50 | Empty `git status --short`. | “The editor stays responsive, and the workspace remains unchanged.” |
| 3:50–3:55 | Anvil and repository URL. | “Anvil: focused context, reviewed changes, resilient execution.” |

## Commands to keep ready

Paste Prompt A for both A and C:

```text
Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.
```

Paste Prompt B with no file mentions:

```text
Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.
```

Activate the Flask workspace’s `.venv` before recording. Start TrueForge, load the agents, prepare the separate clean C workspace, and create the dedicated failure provider using the [runbook](demo.md). Keep API keys off screen.

Opening:

```sh
git describe --tags --exact-match
git rev-parse --short=8 HEAD
git status --short
```

Task A:

```sh
FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
```

Task B:

```sh
pytest tests/test_cli.py -q
flask --help
flask --app 'flask:Flask("demo")' config
git diff --stat
```

Point to `SECRET_KEY: "***"` in the JSON. Use dummy application values if showing additional sensitive keys; never use actual credentials. Hold each result long enough to read it.

Undo and Task C:

```sh
git status --short
```

The narration leaves room for visible evidence. The free OpenRouter B rehearsal took about 29 minutes before cancellation; this timeline is a presentation target, not a measured completion time. Free endpoint latency currently prevents promising a continuous four-minute live run. Rehearse model latency before recording. The PDF permits removing waiting time but also prohibits cutting between the instruction and the diff appearing; preserve that sequence and do not hide failures. Enter the final recording’s actual timestamps in the write-up scorecard.
