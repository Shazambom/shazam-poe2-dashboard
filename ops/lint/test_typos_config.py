"""Self-tests for ops/lint/typos.toml allowlist liveness."""

from __future__ import annotations

import re
import subprocess
import tomllib
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
TYPOS_CONFIG = REPO_ROOT / "ops" / "lint" / "typos.toml"

_IDENT_RE = re.compile(r"[A-Za-z0-9_]+")
_ALPHA_RE = re.compile(r"[A-Za-z]+")
_CAMEL_SPLIT_RE = re.compile(r"(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")


def _glob_to_regex(pattern: str) -> re.Pattern[str]:
    """Convert a typos.toml extend-exclude glob to a repo-relative path regex."""
    parts: list[str] = []
    i = 0
    n = len(pattern)
    while i < n:
        if pattern[i : i + 3] == "**/":
            parts.append("(?:.*/)?")
            i += 3
        elif pattern[i : i + 2] == "**":
            parts.append(".*")
            i += 2
        elif pattern[i] == "*":
            parts.append("[^/]*")
            i += 1
        elif pattern[i] == "?":
            parts.append("[^/]")
            i += 1
        else:
            parts.append(re.escape(pattern[i]))
            i += 1
    return re.compile("^" + "".join(parts) + "$")


def _collect_allowlist_keys(config: dict[str, Any]) -> tuple[list[str], list[str]]:
    """Collect all extend-words and extend-identifiers keys from a parsed TOML config."""
    words: list[str] = []
    identifiers: list[str] = []

    def walk(table: dict[str, Any]) -> None:
        ext_words = table.get("extend-words")
        if isinstance(ext_words, dict):
            words.extend(str(key) for key in ext_words)
        ext_idents = table.get("extend-identifiers")
        if isinstance(ext_idents, dict):
            identifiers.extend(str(key) for key in ext_idents)
        for key, value in table.items():
            if key not in ("extend-words", "extend-identifiers") and isinstance(
                value, dict
            ):
                walk(value)

    walk(config)
    return words, identifiers


def _extract_tokens(text: str) -> tuple[set[str], set[str]]:
    """Extract lowercase word tokens and exact-case identifier tokens from text."""
    identifiers = set(_IDENT_RE.findall(text))
    words: set[str] = set()
    for run in _ALPHA_RE.findall(text):
        words.add(run.lower())
        for piece in _CAMEL_SPLIT_RE.split(run):
            words.add(piece.lower())
    return words, identifiers


def find_dead_entries(
    config: dict[str, Any], file_texts: dict[str, str]
) -> tuple[list[str], list[str]]:
    """Return (dead_words, dead_identifiers) absent from all provided file texts."""
    words, identifiers = _collect_allowlist_keys(config)
    seen_words: set[str] = set()
    seen_identifiers: set[str] = set()
    for text in file_texts.values():
        file_words, file_identifiers = _extract_tokens(text)
        seen_words.update(file_words)
        seen_identifiers.update(file_identifiers)

    dead_words = [word for word in words if word.lower() not in seen_words]
    dead_identifiers = [ident for ident in identifiers if ident not in seen_identifiers]
    return dead_words, dead_identifiers


def _non_excluded_tracked_text_files(excludes: list[str]) -> list[str]:
    """Return tracked text files checked by typos, excluding typos.toml and extend-exclude."""
    result = subprocess.run(
        ["node", "ops/lint/files.mjs", "typos"],
        cwd=REPO_ROOT,
        capture_output=True,
        check=True,
    )
    tracked = [
        path
        for path in result.stdout.decode("utf-8").split("\0")
        if path and path != "ops/lint/typos.toml"
    ]
    exclude_res = [_glob_to_regex(pattern) for pattern in excludes]
    return [
        path for path in tracked if not any(regex.match(path) for regex in exclude_res)
    ]


def test_every_typos_allowlist_entry_occurs_in_tracked_text() -> None:
    config = tomllib.loads(TYPOS_CONFIG.read_text(encoding="utf-8"))
    excludes = [
        str(pattern) for pattern in config.get("files", {}).get("extend-exclude", [])
    ]
    paths = _non_excluded_tracked_text_files(excludes)
    assert paths, "expected non-excluded tracked text files for typos"

    file_texts = {
        rel_path: (REPO_ROOT / rel_path).read_text(encoding="utf-8", errors="replace")
        for rel_path in paths
    }
    dead_words, dead_identifiers = find_dead_entries(config, file_texts)
    assert dead_words == [], f"unused extend-words in typos.toml: {dead_words}"
    assert dead_identifiers == [], (
        f"unused extend-identifiers in typos.toml: {dead_identifiers}"
    )


def test_find_dead_entries_catches_unused_words_and_identifiers() -> None:
    config = {
        "default": {
            "extend-words": {"alpha": "alpha", "unusedword": "unusedword"},
            "extend-identifiers": {
                "BetaTag": "BetaTag",
                "XY": "XY",
                "betatag": "betatag",
            },
        }
    }
    files = {
        "a.txt": "AlphaCamelCase uses BetaTag inside OXYGEN.\n",
    }
    dead_words, dead_identifiers = find_dead_entries(config, files)
    assert dead_words == ["unusedword"]
    assert dead_identifiers == ["XY", "betatag"]
