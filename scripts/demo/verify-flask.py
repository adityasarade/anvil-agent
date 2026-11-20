"""Read-only acceptance checks for actual agent-produced Flask changes.

Run via npm run demo:verify -- A|B|C [--root PATH]. These checks never implement
the requested feature, reset a checkout, or count scripted-model output as live evidence.
"""
import argparse
import ast
import inspect
import json
import os
from pathlib import Path
import subprocess
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("task", choices=["A", "B", "C"])
parser.add_argument("--root", default=str(Path(__file__).resolve().parents[2] / ".demo/flask"))
args = parser.parse_args()
root = Path(args.root).resolve()
python = root / ".venv/bin/python"
if not python.exists():
    parser.error(f"Missing {python}. Run npm run demo:prepare first.")
if Path(sys.prefix).resolve() != python.parent.parent:
    os.execv(str(python), [str(python), str(Path(__file__).resolve()), args.task, "--root", str(root)])
os.chdir(root)
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
sys.path.insert(0, str(root / "src"))

def git(*arguments):
    return subprocess.check_output(["git", *arguments], text=True).strip()

assert git("rev-parse", "HEAD") == "22d924701a6ae2e4cd01e9a15bbaf3946094af65", "Wrong Flask revision"
if args.task == "A":
    from flask.helpers import get_debug_flag
    for value in [None, "", "0", "false", "FALSE", "no", "No", "off", "OFF", "Off", "n", "N"]:
        if value is None:
            os.environ.pop("FLASK_DEBUG", None)
        else:
            os.environ["FLASK_DEBUG"] = value
        assert get_debug_flag() is False, f"Expected false for {value!r}"
    for value in ["1", "true", "yes", "on", "anything"]:
        os.environ["FLASK_DEBUG"] = value
        assert get_debug_flag() is True, f"Regression for {value!r}"
    doc = inspect.getdoc(get_debug_flag).lower()
    for value in ["0", "false", "no", "off", "n"]:
        import re
        assert re.search(r"(?<![a-z0-9_])" + value + r"(?![a-z0-9_])", doc), f"Docstring omits {value}"
    current = (root / "src/flask/helpers.py").read_text()
    baseline = subprocess.check_output(["git", "show", "HEAD:src/flask/helpers.py"], text=True)
    def outside_function(source):
        node = next(n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name == "get_debug_flag")
        lines = source.splitlines(keepends=True)
        return "".join(lines[:node.lineno - 1] + lines[node.end_lineno:])
    assert outside_function(current) == outside_function(baseline), "Task A changed code outside the selection"
    os.environ["FLASK_DEBUG"] = "off"
    print("FLASK_DEBUG=off:", get_debug_flag())
    print("PASS A: false/true cases, docstring, and selection boundary")
elif args.task == "B":
    from flask import Flask
    from flask.cli import cli
    from click.testing import CliRunner
    app = Flask("anvil_acceptance")
    sensitive = {"SECRET_KEY": "secret-value", "db_PASSWORD": "password-value", "ACCESS_TOKEN": "token-value", "API_KEY": "key-value", "mixed_secret_value": "mixed-value"}
    ordinary = {"PUBLIC_NAME": "anvil", "COUNT": 7, "ENABLED": True, "NESTED": {"visible": "yes"}}
    app.config.update(sensitive)
    app.config.update(ordinary)
    before = dict(app.config)
    runner = app.test_cli_runner()
    help_result = CliRunner().invoke(cli, ["--help"])
    assert help_result.exit_code == 0 and "config" in help_result.output, help_result.output
    # Built-ins belong to FlaskGroup, while app.cli contains app-defined commands.
    # FlaskCliRunner supplies the app through ScriptInfo when invoking the group.
    result = runner.invoke(cli, args=["config"])
    assert result.exit_code == 0, result.output + repr(result.exception)
    output = json.loads(result.output)
    assert isinstance(output, dict), "Output must be a JSON object"
    assert set(output) == set(before), "Output omitted configuration keys"
    for key in sensitive:
        assert output[key] == "***", f"Unmasked value for {key}"
    for key, value in ordinary.items():
        assert output[key] == value, f"Ordinary value changed: {key}"
    assert dict(app.config) == before, "The command mutated application configuration"
    changed = set(git("diff", "HEAD", "--name-only").splitlines())
    expected = {"src/flask/cli.py", "tests/test_cli.py", "docs/cli.rst"}
    assert expected <= changed, f"Expected implementation, paired tests, and built-in CLI docs; got {sorted(changed)}"
    subprocess.run([sys.executable, "-m", "pytest", "tests/test_cli.py", "-q"], check=True)
    print(result.output)
    print("PASS B: help, JSON including defaults, masking, unchanged app config, three-file diff, CLI tests")
else:
    status = git("status", "--porcelain", "--untracked-files=all")
    assert not status, f"Task C must leave a clean workspace:\n{status}"
    print("PASS C: git status --short is empty")
    print("Also show primary failure, backoff/fallback, responsive editor, and rejected proposal in the recording.")
