"""A stable release's announcement in #releases (owner, 2026-10-04): the @notifier role, the version, a
very brief summary, the patch-note bullets and this release's own Windows and Mac installers. The ONE
definition of the message and of what a payload may hold. The bot posts it; ops/release_notes.py (the
publish script's check) and bugs.py (the hand-off on shazam) load this file by path. Stdlib only.

    payload = {"version": "0.3.12", "summary": "...", "bullets": ["...", ...]}

The installer links follow from the version (installers()), so a payload can never point anywhere else.
"""
from __future__ import annotations

import re

DISCORD_LIMIT = 2000
REPO = "Shazambom/shazam-poe2-dashboard"
VERSION_RE = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")   # stable releases only (fullmatch: no beta, no stray newline)
MAX_SUMMARY_CHARS = 240
MAX_SENTENCES = 2
MAX_BULLETS = 12
MAX_BULLET_WORDS = 7
MAX_BULLET_CHARS = 60


def installers(version: str) -> dict:
    base = f"https://github.com/{REPO}/releases/download/desktop-v{version}/"
    return {"windows": base + f"Arbiter-Setup-{version}.exe", "mac": base + f"Arbiter-{version}-arm64.dmg"}


ABBREVIATIONS = re.compile(r"\b(e\.g|i\.e|vs|etc|approx|incl|no)\.", re.IGNORECASE)
# The post's only mention is the @notifier role and its only links the installers: notes carry neither.
MENTION_OR_LINK = re.compile(r"@everyone|@here|<[@#][!&]?\d+>|https?://|\]\(|www\.", re.IGNORECASE)


def sentences(text: str) -> int:
    """Sentences end at . ! ? before a space (or the end), never at an abbreviation like "e.g." or "vs."."""
    plain = ABBREVIATIONS.sub(lambda m: m.group(0)[:-1], text.strip())
    return len([s for s in re.split(r"(?<=[.!?])\s+", plain) if s])


def check_notes(summary: str, bullets: list[str]) -> None:
    """The owner's format, or ValueError saying what is wrong."""
    if not summary:
        raise ValueError("the summary is missing (one or two short sentences under the heading)")
    if sentences(summary) > MAX_SENTENCES:
        raise ValueError(f"the summary is more than two sentences: {summary!r}")
    if len(summary) > MAX_SUMMARY_CHARS:
        raise ValueError(f"the summary is too long ({len(summary)} > {MAX_SUMMARY_CHARS} characters)")
    if not bullets:
        raise ValueError("the notes need at least one bullet")
    if len(bullets) > MAX_BULLETS:
        raise ValueError(f"at most {MAX_BULLETS} bullets ({len(bullets)} given)")
    for text in (summary, *bullets):
        if MENTION_OR_LINK.search(text):
            raise ValueError(f"the notes carry no mentions or links (the post adds the role and the installers): {text!r}")
    for b in bullets:
        if len(b.split()) > MAX_BULLET_WORDS:
            raise ValueError(f"a bullet is a few words (at most {MAX_BULLET_WORDS} words): {b!r}")
        if len(b) > MAX_BULLET_CHARS:
            raise ValueError(f"a bullet is at most {MAX_BULLET_CHARS} characters ({len(b)}): {b!r}")
        if b.endswith((".", "!", "?", ";", ":")):
            raise ValueError(f"a bullet has no closing punctuation, like a commit message: {b!r}")


def check_payload(p) -> dict:
    """A payload the bot may post: the exact keys, a plain stable version, the owner's format, one message."""
    if not isinstance(p, dict) or set(p) != {"version", "summary", "bullets"}:
        raise ValueError("the payload must hold exactly version, summary and bullets")
    if not isinstance(p["version"], str) or not VERSION_RE.fullmatch(p["version"]):
        raise ValueError(f"not a stable version: {p['version']!r}")
    if not isinstance(p["summary"], str) or not isinstance(p["bullets"], list) or not all(isinstance(b, str) for b in p["bullets"]):
        raise ValueError("summary must be text and bullets a list of text")
    check_notes(p["summary"].strip(), [b.strip() for b in p["bullets"]])
    if len(render(p, role_id=10 ** 19)) > DISCORD_LIMIT:
        raise ValueError(f"the announcement is longer than one Discord message ({DISCORD_LIMIT} characters)")
    return p


def target_problem(role_mentionable: bool, can_send: bool, can_mention_roles: bool) -> str | None:
    """Why the bot can't announce yet (None when it can): it must be able to post in the channel and to ping
    the role. Discord drops a ping of a role that isn't mentionable unless the sender may mention all roles."""
    if not can_send:
        return "the bot may not send messages in the channel"
    if not (role_mentionable or can_mention_roles):
        return "the bot can't ping the role (make it mentionable, or allow the bot to mention all roles)"
    return None


def render(p: dict, role_id: int) -> str:
    links = installers(p["version"])
    bullets = "\n".join(f"- {b.strip()}" for b in p["bullets"])
    return (f"<@&{int(role_id)}> **Arbiter {p['version']}** is out\n\n"
            f"{p['summary'].strip()}\n\n{bullets}\n\n"
            f"Windows: <{links['windows']}>\nMac: <{links['mac']}>")
