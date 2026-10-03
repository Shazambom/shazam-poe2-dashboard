"""Bug reports have a status, and the owner closes them through the bot (owner, 2026-10-03: "we need a
way to close bug reports too … once we've merged in code to fix bug reports we need a way for the bot
to mark them as resolved"). The bot stays the inbox's only writer: every report or post starts
"new"; the owner's side drops an action file in `inbox/actions/` (`bugs.py act`), and the bot applies
it on its timer: "triage" (an agent is looking at it: status only), "resolve" / "close" (status, a
FIXED reply in the thread — never free text, nothing is posted in anyone's words — and the thread
archived where the bot may). A malformed or unknown action is set aside, never applied."""
import asyncio
import json

from test_bot import Attachment, Thread, sealed_report, h  # noqa: F401 (fixture)
import bot


def run(coro):
    return asyncio.run(asyncio.wait_for(coro, 10))


def status(h, d):
    return json.loads((h.inbox / d / "status.json").read_text())["state"]


def act(h, name, body):
    (h.inbox / "actions").mkdir(parents=True, exist_ok=True)
    (h.inbox / "actions" / name).write_text(body if isinstance(body, str) else json.dumps(body))


class Archivable(Thread):
    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.edits = []

    async def edit(self, **kw):
        self.edits.append(kw)


def setup(h):
    t = Archivable(5001, [Attachment("arbiter-report-7F3K2Q.arb", sealed_report(h.pub))], content="broken")
    run(h.handle(t))
    plain = Archivable(5002, [], content="no file")
    run(h.handle(plain))
    threads = {5001: t, 5002: plain}

    async def get_thread(tid):
        return threads[tid]
    return t, plain, get_thread


def test_every_report_and_post_starts_new(h):
    setup(h)
    assert status(h, "7F3K2Q") == "new" and status(h, "posts/5002") == "new"


def test_triage_only_marks_it(h):
    t, _, get = setup(h)
    act(h, "a.json", {"report": "7F3K2Q", "action": "triage"})
    run(h.process_actions(get))
    assert status(h, "7F3K2Q") == "triaged" and t.sent == ["report 7F3K2Q received — thanks"]
    assert not list((h.inbox / "actions").glob("*.json")), "an applied action is consumed"


def test_resolve_replies_with_the_fixed_text_and_archives(h):
    t, plain, get = setup(h)
    act(h, "a.json", {"report": "7F3K2Q", "action": "resolve"})
    act(h, "b.json", {"report": "posts/5002", "action": "close"})
    run(h.process_actions(get))
    assert status(h, "7F3K2Q") == "resolved" and t.sent[-1] == bot.REPLY["resolve"] and t.edits == [{"archived": True}]
    assert status(h, "posts/5002") == "closed" and plain.sent[-1] == bot.REPLY["close"]


def test_archiving_without_permission_still_resolves(h):
    t, _, get = setup(h)

    async def forbidden(**kw):
        raise PermissionError("Missing Permissions")
    t.edit = forbidden
    act(h, "a.json", {"report": "7F3K2Q", "action": "resolve"})
    run(h.process_actions(get))
    assert status(h, "7F3K2Q") == "resolved"


def test_a_resolved_report_is_not_resolved_again(h):
    t, _, get = setup(h)
    act(h, "a.json", {"report": "7F3K2Q", "action": "resolve"})
    run(h.process_actions(get))
    act(h, "b.json", {"report": "7F3K2Q", "action": "resolve"})
    run(h.process_actions(get))
    assert t.sent.count(bot.REPLY["resolve"]) == 1


def test_bad_actions_are_set_aside_unapplied(h):
    t, _, get = setup(h)
    act(h, "a.json", "{not json")
    act(h, "b.json", {"report": "7F3K2Q", "action": "say", "text": "hello"})
    act(h, "c.json", {"report": "../../etc", "action": "resolve"})
    act(h, "d.json", {"report": "ZZZZZZ", "action": "resolve"})
    run(h.process_actions(get))
    assert sorted(p.name for p in (h.inbox / "actions" / "rejected").iterdir()) == ["a.json", "b.json", "c.json", "d.json"]
    assert status(h, "7F3K2Q") == "new" and t.sent == ["report 7F3K2Q received — thanks"]


def test_replies_are_fixed_texts():
    assert set(bot.REPLY) == {"resolve", "close"} and all(isinstance(v, str) and v for v in bot.REPLY.values())
