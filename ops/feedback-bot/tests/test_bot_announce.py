"""Stable releases are announced in #releases (owner, 2026-10-04: "a releases announcement and tag the
@notifier with the patchnotes … along with a link to the latest windows installer and mac installer and
the version number"; "should only fire after confirmed released"). The publish script confirms the
release is live, then drops one payload in `inbox/announce/` (bugs.py announce); the bot posts it once,
mentioning only that role, and never posts a payload that breaks the format."""
import asyncio
import json

import pytest

from test_bot import h  # noqa: F401 (fixture)
import announce


def run(coro):
    return asyncio.run(asyncio.wait_for(coro, 10))


class Role:
    id = 4242


class HTTPError(Exception):
    def __init__(self, status):
        super().__init__(f"HTTP {status}")
        self.status = status


class Message:
    def __init__(self, fail_publish=False):
        self.published, self.fail_publish = False, fail_publish

    async def publish(self):
        if self.fail_publish:
            raise HTTPError(403)
        self.published = True


class Channel:
    def __init__(self, fail=None, news=False, fail_publish=False):
        self.sent, self.fail, self.news, self.fail_publish = [], fail, news, fail_publish
        self.messages = []

    def is_news(self):
        return self.news

    async def send(self, text, allowed_mentions=None):
        if self.fail:
            raise self.fail
        self.sent.append((text, allowed_mentions))
        m = Message(self.fail_publish)
        self.messages.append(m)
        return m


def payload(version="0.3.12", **over):
    return {"version": version, "summary": "Stash UI redesign and minor bug fixes.",
            "bullets": ["Stash tab replaces Sales", "Holdings grouped by mechanic", "Sales credited only once"], **over}


def drop(h, p, name=None):
    d = h.inbox / "announce"
    d.mkdir(parents=True, exist_ok=True)
    f = d / (name or f"{p.get('version', 'x')}.json")
    f.write_text(json.dumps(p) if not isinstance(p, str) else p)
    return f


def target(channel, role=Role()):
    async def get():
        return channel, role
    return get


def announced(h):
    p = h.inbox / "state.json"
    return json.loads(p.read_text()).get("announced", []) if p.exists() else []


def test_a_release_is_announced_once_tagging_only_the_role(h):
    ch = Channel()
    h.allow_role = lambda role: ("only", role.id)
    f = drop(h, payload())
    run(h.process_announcements(target(ch)))
    assert len(ch.sent) == 1
    text, allowed = ch.sent[0]
    assert text == announce.render(payload(), role_id=4242)
    assert text.startswith("<@&4242> **Arbiter 0.3.12** is out")
    assert "- Stash tab replaces Sales" in text and "/desktop-v0.3.12/Arbiter-Setup-0.3.12.exe" in text
    assert allowed == ("only", 4242), "the only mention allowed is the @notifier role"
    assert not f.exists() and announced(h) == ["0.3.12"]


def test_the_same_release_is_never_announced_twice(h):
    ch = Channel()
    drop(h, payload())
    run(h.process_announcements(target(ch)))
    f = drop(h, payload(), name="again.json")              # a re-run of the publish script
    run(h.process_announcements(target(ch)))
    assert len(ch.sent) == 1 and not f.exists()


@pytest.mark.parametrize("bad", [
    payload("0.3.12-beta.3"),
    payload("0.3.12\n"),
    payload(bullets=["The Stash tab now replaces the old Sales tab entirely"]),
    {**payload(), "windows": "https://evil.example/Arbiter-Setup-0.3.12.exe"},
    "not json",
])
def test_a_payload_that_breaks_the_rules_is_set_aside_unposted(h, bad):
    ch = Channel()
    drop(h, bad, name="bad.json")
    run(h.process_announcements(target(ch)))
    assert ch.sent == []
    assert (h.inbox / "announce" / "rejected" / "bad.json").exists()


def test_while_the_bot_cannot_post_or_ping_it_waits_for_the_next_minute(h):
    f = drop(h, payload())

    async def not_ready():
        return None
    run(h.process_announcements(not_ready))
    assert f.exists(), "kept: the bot tries again on its next minute"


def test_a_temporary_failure_is_retried_not_marked_announced(h):
    f = drop(h, payload())
    run(h.process_announcements(target(Channel(fail=HTTPError(503)))))
    assert f.exists() and announced(h) == []
    ch = Channel()
    run(h.process_announcements(target(ch)))
    assert len(ch.sent) == 1 and not f.exists()


def test_a_permanent_refusal_is_set_aside_and_never_blocks_a_later_release(h):
    drop(h, payload("0.3.12"))
    drop(h, payload("0.3.13"))
    run(h.process_announcements(target(Channel(fail=HTTPError(403)))))
    assert (h.inbox / "announce" / "rejected" / "0.3.12.json").exists()
    assert (h.inbox / "announce" / "rejected" / "0.3.13.json").exists(), "each is tried, none blocks the next"
    assert announced(h) == []


def test_releases_are_announced_oldest_first(h):
    ch = Channel()
    for v in ("0.3.10", "0.3.9"):                          # "0.3.10" sorts before "0.3.9" as text
        drop(h, payload(v))
    run(h.process_announcements(target(ch)))
    assert [t.split("**")[1] for t, _ in ch.sent] == ["Arbiter 0.3.9", "Arbiter 0.3.10"]


def test_once_posted_a_failed_bookkeeping_step_never_posts_it_again(h, monkeypatch):
    ch = Channel()
    drop(h, payload())
    calls = {"n": 0}
    real = h._save_state

    def flaky(st):
        calls["n"] += 1
        if calls["n"] == 1:
            raise OSError("disk full")
        real(st)
    monkeypatch.setattr(h, "_save_state", flaky)
    with pytest.raises(OSError):
        run(h.process_announcements(target(ch)))
    run(h.process_announcements(target(ch)))
    assert len(ch.sent) == 1, "the payload was taken off the queue as soon as it was posted"


def test_in_an_announcement_channel_the_post_is_published_to_followers(h):
    ch = Channel(news=True)
    drop(h, payload())
    run(h.process_announcements(target(ch)))
    assert ch.messages[0].published


def test_a_failed_publish_never_posts_again(h):
    ch = Channel(news=True, fail_publish=True)
    f = drop(h, payload())
    run(h.process_announcements(target(ch)))
    run(h.process_announcements(target(ch)))
    assert len(ch.sent) == 1 and not f.exists() and announced(h) == ["0.3.12"]


@pytest.mark.parametrize("mentionable, can_send, can_mention, problem", [
    (True, True, False, None),
    (False, True, True, None),
    (False, True, False, "ping"),
    (True, False, True, "send"),
])
def test_the_bot_announces_only_where_it_can_post_and_ping(mentionable, can_send, can_mention, problem):
    got = announce.target_problem(role_mentionable=mentionable, can_send=can_send, can_mention_roles=can_mention)
    assert (got is None) if problem is None else (problem in got)
