"""Run mypy on app/ and fail on any error that is not in mypy-baseline.txt.

The baseline lists the errors from before CI ran mypy, without line numbers so unrelated edits
don't shift them. New code is held to a clean check; when an old error is fixed, its line
leaves the baseline (run with --update). Usage, from backend/:

    uv run python scripts/mypy_check.py           # CI
    uv run python scripts/mypy_check.py --update  # after fixing baseline errors
"""

import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

BASELINE = Path(__file__).resolve().parent.parent / "mypy-baseline.txt"
ERROR = re.compile(r"^(?P<file>[^:]+):\d+: error: (?P<message>.*)$")


def current_errors() -> tuple[Counter[str], str]:
    run = subprocess.run(
        [sys.executable, "-m", "mypy", "--no-error-summary", "--hide-error-context"],
        capture_output=True,
        text=True,
        check=False,
    )
    errors: Counter[str] = Counter()
    for line in run.stdout.splitlines():
        if match := ERROR.match(line):
            errors[f"{match['file']}: {match['message']}"] += 1
    if run.returncode not in (0, 1) or (run.returncode == 1 and not errors):
        sys.exit(f"mypy failed to run:\n{run.stdout}{run.stderr}")
    return errors, run.stdout


def main() -> int:
    errors, output = current_errors()
    if "--update" in sys.argv:
        BASELINE.write_text("".join(f"{e}\n" for e in sorted(errors.elements())))
        print(f"Wrote {sum(errors.values())} errors to {BASELINE.name}.")
        return 0
    baseline = Counter(BASELINE.read_text().splitlines()) if BASELINE.exists() else Counter()
    new = errors - baseline
    fixed = baseline - errors
    if new:
        print("New mypy errors (not in mypy-baseline.txt):")
        for line in output.splitlines():
            match = ERROR.match(line)
            if match and new[f"{match['file']}: {match['message']}"] > 0:
                print(f"  {line}")
        return 1
    print(f"mypy: no new errors ({sum(errors.values())} known in mypy-baseline.txt).")
    if fixed:
        print(f"{sum(fixed.values())} baseline errors are fixed; run with --update to drop them.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
