# Recording and acceptance runbook

Use the [four minute video script](video-script.md) for the concise timeline and narration.

The official order is A → B → C, with a maximum of four minutes. Keep the editor and terminal legible. The PDF allows waiting time to be removed but says not to cut between giving an instruction and its diff appearing. Keep that interaction continuous; rehearse for short model waits and avoid hiding failures with edits.

## Before recording

```sh
npm ci
npm run demo:prepare
npm run demo:prepare -- .demo/flask-resilience
npm run trueforge
# In another terminal, after setting keys in the ignored .env:
npm run setup
npm run setup -- --status
npm run verify:submission
```

TrueForge uses the providers already registered in its Settings UI too. Never put keys into video, screenshots, prompts, or git. `config/models.example.json` names Gemini and **Groq** (not xAI Grok); names and `${ENV}` placeholders are not credentials. Configure two usable models and verify them before recording. API availability, quotas, and cost depend on your account.

Install `anvil-agent.vsix` with Antigravity's **Extensions: Install from VSIX…**, then reload. Open `.demo/flask`; select your model chain through Anvil's status bar. F5 in this repository also launches a development host with this fixture. Open a terminal in the fixture and activate its virtual environment:

```sh
source .venv/bin/activate
git rev-parse HEAD
git status --short
```

Use a fresh, unchanged fixture for strict automated checks. Preparation refuses a dirty or unexpected checkout and never resets your work. Keep generated verification artifacts outside Flask. For a custom fixture: `ANVIL_FLASK_ROOT=/absolute/path npm run verify:submission`.

Optional automated **real-model** rehearsal inside an isolated editor profile:

```sh
ANVIL_LIVE_TASK=A npm run test:live
ANVIL_LIVE_TASK=B npm run test:live
# After creating the failure provider, with a separate clean C fixture:
ANVIL_LIVE_TASK=C npm run test:live
```

These use the exact prompts and production review/apply services, automate CodeLens decisions, and approve shell commands only inside the Extension Test Host. A applies, verifies, then undoes; B leaves the agent's changes for inspection; C rejects the fallback proposal. They use actual configured models and may consume provider quota. Override the normal chain with `ANVIL_LIVE_MODELS='["provider/model","other/model"]'`. Results and streamed events are saved under `.artifacts/live-A-result.json` (and B/C). They do not record the required video. Each task uses an isolated editor profile. Run tasks against the same fixture sequentially.

## A — target 0:00–0:55

Open `src/flask/helpers.py`, select the complete `get_debug_flag` function, press Cmd+Alt+I, and enter exactly:

> Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.

On a first attempt, show streaming, press Escape or Stop, and show that no proposal was applied. Repeat the same instruction, show the live preview and per-hunk Accept/Reject controls, and accept the required hunks. Then show:

```sh
FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
# Expected: False
```

From the Anvil repository terminal run `npm run demo:verify -- A` to check mixed-case inputs, old behavior, docstring coverage, and no edits outside the selected function. Show **Anvil: Undo Last Applied Change**, then show the file restored and `git status --short` empty. This supplies the working undo evidence.

## B — target 0:55–2:55

In the Anvil panel, with no mentions or attached files, enter exactly:

> Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.

Show the context card's paths, reasons, budget, and scout findings. Review and accept the implementation, test, and documentation hunks. Approve the relevant test command. Open **Session ↗** briefly and show the TrueForge turns, scout, and MCP tool calls.

In the fixture terminal:

```sh
pytest tests/test_cli.py -q
flask --help
flask --app 'flask:Flask("demo")' config
git diff --stat
```

From the Anvil repository terminal run `npm run demo:verify -- B`. It exercises real application defaults (including non-JSON-native values), sensitive and ordinary configuration, unchanged application state, CLI help, the three relevant files, and the CLI tests. It prints masked JSON without writing a demo application into the fixture. If this fails, let the agent correct its implementation and review the correction before repeating.

## C — target 2:55–3:55

From the Anvil repo run:

```sh
npm run demo:failure -- --fallback YOUR_WORKING_PROVIDER/MODEL
```

This creates a dedicated provider pointing at an unused localhost port; it never replaces a real provider key. Follow the printed model-chain selection instructions. Open `.demo/flask-resilience` in Antigravity, verify its clean status, and repeat Task A's selection and exact instruction. Show the retry/backoff notification and automatic switch to the working model. Move around the editor while it runs to show responsiveness. **Reject all hunks** when the fallback proposal arrives.

```sh
git status --short
# Must be empty.
```

From the Anvil repo run `npm run demo:verify -- C --root .demo/flask-resilience`. The verifier checks disk state; the video must supply failure/fallback and responsiveness evidence. Restore your normal model chain, reconnect, then run `npm run demo:failure -- --remove`.

## Submission

- Repo: preserve history, MIT licence, example configuration, and tested setup instructions; confirm the intended repository is public.
- Video: public/unlisted link, ≤4 minutes, A/B/C in order with each verification visible.
- Write-up: fill `writeup.html`, replace every `FILL` field, remove the DRAFT notice, enter actual video timestamps and actual model costs, then run `npm run writeup:pdf`. Check that it is 1–3 pages.
- Open all three links while signed out. Do not submit a verification report as proof of a live-model demo.

The supplied challenge PDF lists 20 November 2026 at 23:59 IST as the Round 1 deadline. Publishing and portal submission remain team actions.
