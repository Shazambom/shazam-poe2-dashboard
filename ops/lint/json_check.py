#!/usr/bin/env python3
"""Check JSON and NDJSON files for valid syntax and duplicate object keys."""

from __future__ import annotations

import json
import subprocess
import sys
from collections.abc import Sequence
from pathlib import Path


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            msg = f"duplicate key {key!r}"
            raise ValueError(msg)
        result[key] = value
    return result


def check_json_text(text: str) -> None:
    """Parse one JSON value, raising ValueError on bad syntax or duplicate keys."""
    json.loads(text, object_pairs_hook=_reject_duplicate_keys)


def check_file(path: Path) -> list[str]:
    """Validate one .json or .ndjson file; return list of 'path: message' errors."""
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return [f"{path}: {exc}"]

    if path.suffix == ".ndjson":
        errors: list[str] = []
        for lineno, line in enumerate(text.splitlines(), start=1):
            try:
                check_json_text(line)
            except ValueError as exc:
                errors.append(f"{path}: line {lineno}: {exc}")
        return errors

    try:
        check_json_text(text)
    except ValueError as exc:
        return [f"{path}: {exc}"]
    return []


def discover_repo_files(repo_root: Path) -> list[Path]:
    """Return tracked and untracked-nonignored .json/.ndjson files that exist on disk."""
    raw = subprocess.check_output(
        ["git", "ls-files", "-co", "--exclude-standard", "-z"],
        cwd=repo_root,
    )
    paths: list[Path] = []
    for entry in raw.decode("utf-8").split("\0"):
        if not entry:
            continue
        if not entry.endswith((".json", ".ndjson")):
            continue
        candidate = repo_root / entry
        if candidate.is_file():
            paths.append(Path(entry))
    return paths


def main(argv: Sequence[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    paths = [Path(arg) for arg in args] if args else discover_repo_files(Path.cwd())

    if not paths:
        print("json_check: no JSON or NDJSON files to check", file=sys.stderr)
        return 1

    failures: list[str] = []
    for path in paths:
        failures.extend(check_file(path))

    for failure in failures:
        print(failure)

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
