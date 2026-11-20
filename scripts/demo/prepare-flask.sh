#!/usr/bin/env bash
# Prepare the official fixture without resetting or overwriting existing work.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TARGET="${1:-$ROOT/.demo/flask}"
COMMIT="22d924701a6ae2e4cd01e9a15bbaf3946094af65"
if [ ! -e "$TARGET" ]; then
  mkdir -p "$(dirname "$TARGET")"
  git clone --branch 3.1.3 --depth 1 https://github.com/pallets/flask.git "$TARGET"
fi
cd "$TARGET"
[ "$(git rev-parse --show-toplevel)" = "$(pwd -P)" ] || { echo 'Target is not a repository root.'; exit 1; }
[ "$(git rev-parse HEAD)" = "$COMMIT" ] || { echo "Expected Flask $COMMIT. Existing checkout was left untouched."; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo 'Fixture has changes. Preserve them and prepare a different directory.'; exit 1; }
EXCLUDE="$(git rev-parse --git-path info/exclude)"
grep -qxF '.venv/' "$EXCLUDE" || printf '\n.venv/\n' >> "$EXCLUDE"
if [ ! -x .venv/bin/python ]; then python3 -m venv .venv; fi
.venv/bin/python -m pip install -e . python-dotenv 'pytest==8.4.2'
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m pytest tests/test_cli.py -q
printf '\nTask A baseline (expected True):\n'
FLASK_DEBUG=off .venv/bin/python -c 'from flask.helpers import get_debug_flag; print(get_debug_flag())'
[ -z "$(git status --porcelain)" ] || { echo 'Fixture is unexpectedly dirty.'; exit 1; }
echo "Ready: $(pwd)"
