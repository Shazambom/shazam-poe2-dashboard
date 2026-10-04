"""ops/release_notes.py — a stable release's patch notes (docs/release-notes/<x.y.z>.md) and the
announcement payload built from them. Owner, 2026-10-04: "The patch notes should be only bullet points
and very user focused … a very very very brief summary for each release that encapsulates all of the
patch notes bullet points. Bullet points should be like short brief commit messages, no more than a few
words. The summary should be 1 to two short sentences"; with "a link to the latest windows installer and
mac installer and the version number"."""
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
_spec = importlib.util.spec_from_file_location("release_notes", ROOT / "ops" / "release_notes.py")
rn = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rn)

GOOD = """# 0.3.12

Your stash, grouped by league mechanic, with liquid net worth. Sales no longer inflate it.

- Stash tab replaces Sales
- Holdings grouped by mechanic
- Liquid net worth in the top bar
- Sales credited only once
"""


def test_a_good_file_parses_into_version_summary_and_bullets():
    n = rn.parse(GOOD)
    assert n == {"version": "0.3.12",
                 "summary": "Your stash, grouped by league mechanic, with liquid net worth. Sales no longer inflate it.",
                 "bullets": ["Stash tab replaces Sales", "Holdings grouped by mechanic", "Liquid net worth in the top bar",
                             "Sales credited only once"]}


@pytest.mark.parametrize("bad, why", [
    (GOOD.replace("# 0.3.12", "# Arbiter"), "heading"),
    (GOOD.replace("Your stash, grouped by league mechanic, with liquid net worth. Sales no longer inflate it.\n", ""), "summary"),
    (GOOD.replace("Sales no longer inflate it.", "Sales no longer inflate it. It is faster. It is nicer."), "two sentences"),
    (GOOD.replace("Your stash", "Your " + "very " * 40 + "stash"), "summary is too long"),
    (GOOD.replace("- Stash tab replaces Sales", "- The Stash tab replaces the old Sales tab and groups everything"), "words"),
    (GOOD.replace("- Stash tab replaces Sales", "- Stash tab replaces Sales."), "closing punctuation"),
    (GOOD.replace("- Stash tab replaces Sales\n", "Stash tab replaces Sales\n"), "only bullets"),
    ("\n".join(GOOD.splitlines()[:4]) + "\n", "at least one bullet"),
    (GOOD + "".join(f"- Extra item {i}\n" for i in range(12)), "at most"),
])
def test_a_file_that_breaks_the_owners_format_is_refused(bad, why):
    with pytest.raises(ValueError, match=why):
        rn.parse(bad)


def test_the_payload_is_the_notes_and_the_post_links_this_releases_own_installers(tmp_path):
    (tmp_path / "docs" / "release-notes").mkdir(parents=True)
    (tmp_path / "docs" / "release-notes" / "0.3.12.md").write_text(GOOD)
    p = rn.check("0.3.12", root=tmp_path)
    assert p == rn.parse(GOOD), "the payload carries the notes only: the links follow from the version"
    base = "https://github.com/Shazambom/shazam-poe2-dashboard/releases/download/desktop-v0.3.12/"
    text = rn.announce.render(p, role_id=1)
    assert f"Windows: <{base}Arbiter-Setup-0.3.12.exe>" in text and f"Mac: <{base}Arbiter-0.3.12-arm64.dmg>" in text


@pytest.mark.parametrize("version", ["0.3.12\n", "\u0660.\u0663.\u0661\u0662", "0.3.12 ", "v0.3.12"])
def test_only_a_plain_ascii_stable_version_is_accepted(version):
    with pytest.raises(ValueError):
        rn.announce.check_payload({**rn.parse(GOOD), "version": version})


def test_check_refuses_a_missing_file_or_a_version_mismatch(tmp_path):
    with pytest.raises(ValueError, match="no release notes"):
        rn.check("0.3.12", root=tmp_path)
    (tmp_path / "docs" / "release-notes").mkdir(parents=True)
    (tmp_path / "docs" / "release-notes" / "0.3.13.md").write_text(GOOD)
    with pytest.raises(ValueError, match="heading"):
        rn.check("0.3.13", root=tmp_path)


def test_the_largest_notes_the_format_allows_still_fit_one_discord_message(tmp_path):
    # check() refuses anything over one message; this pins that the format's own limits stay under it.
    long_bullets = "".join(f"- Feature number {i:02d} works now ok\n" for i in range(rn.announce.MAX_BULLETS))
    text = "# 0.3.12\n\n" + "A" * (rn.announce.MAX_SUMMARY_CHARS - 1) + ".\n\n" + long_bullets
    (tmp_path / "docs" / "release-notes").mkdir(parents=True)
    (tmp_path / "docs" / "release-notes" / "0.3.12.md").write_text(text)
    assert rn.check("0.3.12", root=tmp_path)["version"] == "0.3.12"


def test_the_cli_checks_and_prints_the_payload(tmp_path):
    (tmp_path / "docs" / "release-notes").mkdir(parents=True)
    (tmp_path / "docs" / "release-notes" / "0.3.12.md").write_text(GOOD)
    out = subprocess.run([sys.executable, str(ROOT / "ops" / "release_notes.py"), "payload", "0.3.12", "--root", str(tmp_path)],
                         capture_output=True, text=True, check=True).stdout
    assert json.loads(out) == rn.parse(GOOD)
    bad = subprocess.run([sys.executable, str(ROOT / "ops" / "release_notes.py"), "check", "9.9.9", "--root", str(tmp_path)],
                         capture_output=True, text=True)
    assert bad.returncode != 0 and "no release notes" in bad.stderr


# QA pass 1 (2026-10-04): good files refused, and errors that pointed at the wrong thing.
@pytest.mark.parametrize("summary", ["New tabs, e.g. a stash. Sales fixed.", "Sales vs. Stash fixed. Prices right.",
                                     "New tabs, e.g. Stash. Prices like 3.5 div in v0.3 now right."])
def test_an_abbreviation_is_not_a_sentence_end(summary):
    assert rn.parse(GOOD.replace(rn.parse(GOOD)["summary"], summary))["summary"] == summary


def test_errors_name_the_limit_that_was_broken(tmp_path):
    with pytest.raises(ValueError, match="60 characters"):
        rn.parse(GOOD.replace("- Stash tab replaces Sales", "- Strat Calculator recalculates denominations automatically everywhere immediately"))
    with pytest.raises(ValueError, match="closing punctuation"):
        rn.parse(GOOD.replace("- Stash tab replaces Sales", "- Stash tab replaces Sales?"))
    with pytest.raises(ValueError, match="only stable releases"):
        rn.check("0.3.12-beta.1", root=tmp_path)
    with pytest.raises(ValueError, match="only stable releases"):
        rn.check("../0.3.12", root=tmp_path)                 # never a path outside docs/release-notes/


def test_a_file_saved_with_a_bom_is_read_like_any_other(tmp_path):
    (tmp_path / "docs" / "release-notes").mkdir(parents=True)
    (tmp_path / "docs" / "release-notes" / "0.3.12.md").write_text("﻿" + GOOD, encoding="utf-8")
    assert rn.check("0.3.12", root=tmp_path)["version"] == "0.3.12"


@pytest.mark.parametrize("trick", ["@everyone", "@here", "<@&123>", "<@123456>", "[click](https://evil.example)",
                                   "see https://evil.example"])
def test_notes_carry_no_mentions_or_links(trick):
    # The post's only mention is the @notifier role and its only links are the installers.
    with pytest.raises(ValueError, match="no mentions or links"):
        rn.parse(GOOD.replace("- Stash tab replaces Sales", f"- Stash {trick}"))
    with pytest.raises(ValueError, match="no mentions or links"):
        rn.parse(GOOD.replace("Sales no longer inflate it.", f"Sales no longer inflate it {trick}."))
