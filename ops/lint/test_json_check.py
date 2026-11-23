"""Tests for ops/lint/json_check.py."""

from __future__ import annotations

from pathlib import Path

import json_check
import pytest


def test_valid_json_file(tmp_path: Path) -> None:
    target = tmp_path / "valid.json"
    target.write_text(
        '{"a": {"k": 1}, "b": [{"k": 2}, {"k": 3}]}\n',
        encoding="utf-8",
    )

    assert json_check.check_file(target) == []
    assert json_check.main([str(target)]) == 0


def test_duplicate_key_at_depth(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    target = tmp_path / "dup.json"
    target.write_text(
        '{"outer": {"items": [{"ok": 1, "deep": {"x": 1, "x": 2}}]}}\n',
        encoding="utf-8",
    )

    errors = json_check.check_file(target)
    assert len(errors) == 1
    assert errors[0].startswith(f"{target}: ")
    assert "duplicate key" in errors[0]
    assert "'x'" in errors[0]

    assert json_check.main([str(target)]) == 1
    captured = capsys.readouterr()
    assert f"{target}: " in captured.out
    assert "duplicate key" in captured.out


def test_invalid_json_syntax(tmp_path: Path) -> None:
    target = tmp_path / "broken.json"
    target.write_text('{"a": [1, 2,]}\n', encoding="utf-8")

    errors = json_check.check_file(target)
    assert len(errors) == 1
    assert errors[0].startswith(f"{target}: ")
    assert json_check.main([str(target)]) == 1


def test_ndjson_valid_and_line_errors(tmp_path: Path) -> None:
    good = tmp_path / "good.ndjson"
    good.write_text('{"a": 1}\n{"a": 2, "nested": {"b": 3}}\n', encoding="utf-8")
    assert json_check.check_file(good) == []

    bad = tmp_path / "bad.ndjson"
    bad.write_text(
        '{"ok": 1}\n{"dup": {"k": 1, "k": 2}}\n{not json}\n',
        encoding="utf-8",
    )
    errors = json_check.check_file(bad)
    assert len(errors) == 2
    assert errors[0].startswith(f"{bad}: line 2: ")
    assert "duplicate key" in errors[0]
    assert errors[1].startswith(f"{bad}: line 3: ")
    assert json_check.main([str(bad)]) == 1
