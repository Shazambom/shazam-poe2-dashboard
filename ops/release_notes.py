"""A stable release's patch notes and its #releases announcement payload. Stdlib only (the Mac's python3).

    python3 ops/release_notes.py check <x.y.z>     # publish-github.sh: refuse a stable release without good notes
    python3 ops/release_notes.py payload <x.y.z>   # ops/announce.sh: the JSON the bot posts

The notes live in docs/release-notes/<x.y.z>.md, written to docs/release-notes/STYLE.md:

    # 0.3.12

    One or two short sentences that sum up every bullet.

    - A few words each
    - User-facing only

The message itself and the payload rules are defined once, in ops/feedback-bot/bot/announce.py.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ops" / "feedback-bot" / "bot"))
import announce  # noqa: E402  (the bot's own module: one definition of the message and its rules)


def parse(text: str) -> dict:
    """{version, summary, bullets} from a notes file, or ValueError saying what breaks the format."""
    lines = [l.rstrip() for l in text.lstrip("\ufeff").strip().splitlines()]   # a BOM (Notepad) is not text
    if not lines or not lines[0].startswith("# ") or not announce.VERSION_RE.fullmatch(lines[0][2:].strip()):
        raise ValueError("the first line must be the heading '# <x.y.z>'")
    version, summary, bullets = lines[0][2:].strip(), [], []
    summary_done = False                       # the summary is the one paragraph under the heading
    for line in lines[1:]:
        if not line.strip():
            summary_done = summary_done or bool(summary)
            continue
        if line.startswith("- "):
            bullets.append(line[2:].strip())
        elif bullets or summary_done:
            raise ValueError(f"after the summary the notes are only bullets ('- …'): {line!r}")
        else:
            summary.append(line.strip())
    summary_text = " ".join(summary)
    announce.check_notes(summary_text, bullets)
    return {"version": version, "summary": summary_text, "bullets": bullets}


def check(version: str, root: Path = ROOT) -> dict:
    """The release's own notes, in the owner's format, fitting one Discord message, as a payload."""
    if not announce.VERSION_RE.fullmatch(version):
        raise ValueError(f"only stable releases (x.y.z) get release notes, not {version!r}")
    path = Path(root) / "docs" / "release-notes" / f"{version}.md"
    if not path.is_file():
        raise ValueError(f"no release notes for {version}: write {path.relative_to(root)} (docs/release-notes/STYLE.md)")
    notes = parse(path.read_text(encoding="utf-8"))
    if notes["version"] != version:
        raise ValueError(f"the heading names {notes['version']}, not {version}")
    return announce.check_payload(notes)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("cmd", choices=("check", "payload"))
    ap.add_argument("version")
    ap.add_argument("--root", type=Path, default=ROOT)
    a = ap.parse_args(argv)
    try:
        p = check(a.version, a.root)
    except ValueError as e:
        print(f"release notes: {e}", file=sys.stderr)
        return 1
    print(json.dumps(p, ensure_ascii=False) if a.cmd == "payload" else f"release notes for {a.version}: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
