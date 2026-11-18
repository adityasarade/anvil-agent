#!/usr/bin/env bash
# Prepares the pinned Round 1 repository: pallets/flask 3.1.3 (commit 22d92470)
# with a local virtualenv that `run_command` picks up automatically.
# The venv is excluded through .git/info/exclude, so `git status` stays clean.
#
# Usage: scripts/demo/prepare-flask.sh [target-dir]   (default: ../flask)
set -euo pipefail

TARGET="${1:-../flask}"
TAG="3.1.3"
COMMIT="22d924701a6ae2e4cd01e9a15bbaf3946094af65"

if [ ! -d "$TARGET/.git" ]; then
  git clone --branch "$TAG" --depth 1 https://github.com/pallets/flask.git "$TARGET"
fi
cd "$TARGET"
[ "$(git rev-parse HEAD)" = "$COMMIT" ] || { echo "expected $COMMIT, got $(git rev-parse HEAD)"; exit 1; }
grep -qxF '.venv/' .git/info/exclude || echo '.venv/' >> .git/info/exclude

if command -v uv >/dev/null 2>&1; then
  uv venv --python 3.12 .venv
  VIRTUAL_ENV=.venv uv pip install -e . python-dotenv "pytest==8.4.2"
else
  python3 -m venv .venv
  .venv/bin/pip install -e . python-dotenv "pytest==8.4.2"
fi

.venv/bin/python -m pytest tests/test_cli.py -q | tail -1
echo "Task A baseline (should print True before the edit):"
FLASK_DEBUG=off .venv/bin/python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
git status --short
echo "Ready: open $(pwd) in VS Code."
