"""Fail on new ShellCheck warnings and on every error; preserve known diagnostics."""
import collections
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
baseline = json.loads((ROOT / "tests/shellcheck-baseline.json").read_text())
scripts = ["install.sh"]
for directory in ("package", "tests"):
    for path in sorted((ROOT / directory).rglob("*")):
        if not path.is_file():
            continue
        with path.open("rb") as stream:
            first = stream.readline(512)
        if path.suffix == ".sh" or re.match(
            rb"^#!\s*(?:/bin/(?:sh|ash|bash)|/usr/bin/env\s+(?:sh|ash|bash))(?:\s|$)", first
        ):
            scripts.append(path.relative_to(ROOT).as_posix())

if not scripts:
    sys.exit("No shell scripts found")
print("Checking:", *scripts, sep="\n  ", flush=True)
run = subprocess.run(
    ["shellcheck", "--shell=busybox", "--severity=warning", "--format=json", *scripts],
    cwd=ROOT, capture_output=True, text=True, check=False,
)
if run.returncode not in (0, 1):
    sys.exit(run.stderr or f"ShellCheck failed: {run.returncode}")
diagnostics = json.loads(run.stdout)
seen = collections.Counter()
failed = False
for item in diagnostics:
    path, code = item["file"], item["code"]
    message = f"{code}: {item['message']}"
    key = (path, message)
    seen[key] += 1
    known = item["level"] == "warning" and seen[key] <= baseline.get(path, {}).get(message, 0)
    print(f"{path}:{item['line']}:{item['column']}: "
          f"{'baseline' if known else item['level']} SC{message}")
    if not known:
        failed = True
print(f"Diagnostics: {len(diagnostics)}. {'New findings detected.' if failed else 'No new warnings or errors.'}")
sys.exit(int(failed))
