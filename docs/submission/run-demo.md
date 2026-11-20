# Exact local run and demo steps

These steps use your existing macOS installation, hosted Groq Qwen for A/C, and OpenRouter’s Particle/Flint chain for B. No model weights are downloaded. A/C passed live rehearsals. B’s generated output passed acceptance, but its agent turn was cancelled before the final summary after about 29 minutes. A continuous four-minute live run is not yet verified. The timed script is a recording target.

## 1. Start the code

In a macOS Terminal (Terminal 1):

```sh
cd /Users/varunvyas/Downloads/anvil-agent
npm run trueforge
```

Keep that terminal open. If TrueForge is already running at http://127.0.0.1:8790, use that running instance instead of starting another.

In another macOS Terminal (Terminal 2):

```sh
cd /Users/varunvyas/Downloads/anvil-agent
npm run setup
npm run setup -- --status
```

Your keys are already in the ignored `.env`. Confirm the status lists `groq/qwen3-8-27b`, `openrouter/particle-1-free`, and `openrouter/flint-free`. Setup reads keys without printing them.

The VSIX is already built and installed. In Antigravity press **Cmd+Shift+P → Developer: Reload Window**. To rebuild after changing extension code, run `npm run package`, then **Extensions: Install from VSIX…**, select `anvil-agent.vsix` in this repo, and reload. For a fresh clone, run `npm ci` before building.

Optional mechanical verification, before modifying the clean fixture:

```sh
npm run verify:submission
```

This runs tests, packages the extension, and opens an editor smoke-test window. It uses a scripted test server and does not call a cloud model. Close the test window before recording.

## 2. Prepare the two demo folders

From Terminal 2:

```sh
npm run demo:prepare
npm run demo:prepare -- .demo/flask-resilience
```

Both folders already exist locally. Preparation checks the pinned Flask commit and runs baseline CLI tests; it refuses to overwrite existing changes. Keep `.demo/flask-groq` intact: it contains the previously generated B implementation. If your main fixture is dirty, inspect it and use a separate clean fixture rather than resetting work.

In Antigravity choose **File → Open Folder…** and open:

```text
/Users/varunvyas/Downloads/anvil-agent/.demo/flask
```

Use one active Anvil workspace at a time because its editor MCP registration is shared through local TrueForge. Open **Terminal → New Terminal** inside that workspace:

```sh
source .venv/bin/activate
git rev-parse HEAD
git status --short
```

Expected commit: `22d924701a6ae2e4cd01e9a15bbaf3946094af65`. Git status must be empty. Baseline CLI tests: 58 passing.

## 3. Configure A’s hosted model

Press **Cmd+Shift+P → Preferences: Open User Settings (JSON)**. Merge the contents of the repository’s `config/free-cloud.settings.json` into your existing settings object; preserve your other settings. This selects Qwen and the direct inline agent with compact budgets.

Press **Cmd+Shift+P → Anvil: Reconnect to TrueForge**. If needed, use **Anvil: Select Model Chain**, choose `groq/qwen3-8-27b` as primary, then press **Escape** at the fallback prompt. Start **Anvil: New Agent Session**. The configured model is hosted remotely.

## 4. Scenario A — inline edit, review, verification, undo

1. Open `src/flask/helpers.py`.
2. Select the complete `get_debug_flag` function, including its signature, docstring, and body.
3. Press **Cmd+Alt+I** and paste this exact instruction:

```text
Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.
```

4. To show cancellation, press **Escape** while it streams, before accepting anything. Confirm the file is unchanged, then repeat the same selection and instruction.
5. Show the proposed diff and the per-hunk Accept/Reject controls. Accept the required changes.
6. In the Flask workspace terminal:

```sh
FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
```

Expected: `False`.

7. In Terminal 2 (the Anvil repository):

```sh
npm run demo:verify -- A --root .demo/flask
```

Expected: PASS A, including mixed-case values, docstring, and selection boundaries.

8. In the editor run **Anvil: Undo Last Applied Change**. In the Flask terminal run `git status --short`; it must be empty before B.

## 5. Scenario B — discover and change code, tests, and docs

In User Settings JSON, replace the Anvil settings from step 3 with the following. These are the context and output budgets used by the observed B rehearsal; do not leave duplicate JSON keys.

```json
{
  "anvil.models": ["openrouter/particle-1-free", "openrouter/flint-free"],
  "anvil.agents.inline": "anvil-inline-direct",
  "anvil.context.budgetTokens": 4000,
  "anvil.context.repoMapTokens": 1200,
  "anvil.context.compactionTokens": 60000,
  "anvil.modelParams": {
    "openrouter/particle-1-free": { "max_tokens": 16384 },
    "openrouter/flint-free": { "max_tokens": 16384 }
  }
}
```

Run **Anvil: Reconnect to TrueForge**, then **Anvil: New Agent Session**, then **Anvil: Open Agent Panel**. Keep the main Flask workspace open. Clear all file/symbol mentions. Paste the exact prompt:

```text
Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.
```

1. Show streaming, the context card’s paths/reasons/budget, and the scout findings.
2. Review and accept the implementation, test, and documentation proposals. Approve relevant verification commands. Keep the editor open; Escape cancels the run.
3. Let the agent finish. If verification fails, ask it to correct the failure, review its changes, and verify again. Do not present a cancelled run as a completed one.
4. In the Flask terminal:

```sh
pytest tests/test_cli.py -q
flask --help
flask --app 'flask:Flask("demo")' config
git diff --stat
```

Expected: tests pass; `config` appears in help; JSON contains `"SECRET_KEY": "***"`; changes include `src/flask/cli.py`, `tests/test_cli.py`, and `docs/cli.rst`. Test count depends on generated coverage; the previous accepted output has 61 passing tests.

5. In Terminal 2:

```sh
npm run demo:verify -- B --root .demo/flask
```

Expected: PASS B for help, valid JSON including defaults, masking, unchanged app configuration, and the three-file diff. Open **Anvil: Open TrueForge Session** to show the actual tool loop and scout.

To inspect the already generated B output without another cloud run:

```sh
npm run demo:verify -- B --root .demo/flask-groq
git -C .demo/flask-groq diff --stat
```

This verifies saved output; it does not replace the video’s real agent interaction.

## 6. Scenario C — primary failure, retries, fallback, reject

In Terminal 2:

```sh
npm run demo:failure -- --fallback groq/qwen3-8-27b
```

This creates an unreachable local demo endpoint without changing real keys. If it says a demo provider already exists, reuse it rather than creating another.

1. In the same editor window choose **File → Open Folder…** and switch to `/Users/varunvyas/Downloads/anvil-agent/.demo/flask-resilience`. Preserve B’s changes when leaving its folder.
2. Restore the Qwen settings from step 3, then run **Anvil: Reconnect to TrueForge**.
3. Run **Anvil: Select Model Chain**. Select `anvil-demo-failure/unreachable` as primary, `groq/qwen3-8-27b` as fallback, then **Escape** at the second-fallback prompt.
4. Open the new workspace terminal and run:

```sh
source .venv/bin/activate
git status --short
```

Status must be empty.

5. Select `get_debug_flag` in `src/flask/helpers.py` and repeat A’s exact instruction using **Cmd+Alt+I**.
6. Show failure, retries/backoff, and the automatic Qwen fallback. Move around the editor to demonstrate responsiveness.
7. **Reject All Hunks** when the fallback proposal arrives. Run `git status --short`; it must remain empty.
8. In Terminal 2:

```sh
npm run demo:verify -- C --root .demo/flask-resilience
```

Expected: PASS C. The video supplies evidence of retries/fallback and responsiveness; the verifier checks the clean disk state.

## 7. Clean up and record

Select the normal Qwen-only chain again, reconnect, then run in Terminal 2:

```sh
npm run demo:failure -- --remove
```

Use `video-script.md` / `anvil-demo-script.pdf` for the A → B → C recording. Keep keys and `.env` off screen. Free capacity can be slow or return 429s; wait for the provider’s retry delay and rehearse before recording. The previous B run took about 29 minutes, so the four-minute target is not a promise of real-time completion. Follow the challenge PDF’s editing restrictions and preserve prompt-to-diff continuity.

Fill real timestamps and remaining details in `docs/submission/writeup.html`, then run `npm run writeup:pdf`. The demo PDF exporter is `npm run demo:pdf`.
