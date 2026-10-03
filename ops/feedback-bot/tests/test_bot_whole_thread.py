"""The bot keeps the WHOLE thread of every post it keeps, in every forum (owner, 2026-10-03: "I want the bot
to pull the whole thread not just the initial message"). Keeping a post reads the thread's history; every
catch-up reads again any kept thread whose newest message moved (replies posted while the bot was down, or
a post kept before this rule), rebuilding `discord.json` from Discord, so nothing is doubled. A thread that
has not moved is not read again. The bot's own messages are never kept."""
import asyncio
import json

from test_bot import Attachment, Author, Thread, sealed_report, h  # noqa: F401 (fixture)

REPORTER, OTHER, BOT = Author(7), Author(8), Author(1, bot=True)
IDEAS = 777


def run(coro):
    return asyncio.run(asyncio.wait_for(coro, 10))


def words(h, d):
    return [(m["from"], m["text"]) for m in json.loads((h.inbox / d / "discord.json").read_text())["messages"]]


def forum(fid, *threads):
    class Forum:
        id = fid

        def __init__(self):
            self.threads = list(threads)

        def archived_threads(self, limit=None):
            async def gen():
                return
                yield
            return gen()
    return Forum()


def test_a_bug_report_keeps_the_replies_already_in_its_thread(h):
    t = Thread(7001, [Attachment("arbiter-report-7F3K2Q.arb", sealed_report(h.pub))], content="hold is empty")
    t.say("me too", OTHER)
    t.say("on 0.3.10", REPORTER)
    assert run(h.handle(t)) == "OK"
    assert words(h, "7F3K2Q") == [("reporter", "hold is empty"), ("other", "me too"), ("reporter", "on 0.3.10")]


def test_catch_up_fills_in_replies_the_bot_missed_without_doubling_any(h):
    t = Thread(7002, [], content="no file")
    run(h.handle(t))
    seen_live = t.say("live reply", OTHER)
    run(h.on_reply(seen_live))
    t.say("ack", BOT)
    t.say("while the bot was down", REPORTER)
    run(h.catch_up(forum(999, t)))
    assert words(h, "posts/7002") == [("reporter", "no file"), ("other", "live reply"), ("reporter", "while the bot was down")]


def test_a_post_kept_before_this_rule_gets_its_whole_thread_at_the_next_catch_up(h):
    h.text_forums = {IDEAS: "ideas"}
    t = Thread(7003, [], name="Include/Exclude items", content="let me exclude items")
    t.parent_id = IDEAS
    for i in range(11):
        t.say(f"reply {i}", OTHER if i % 2 else REPORTER)
    h.inbox.mkdir(parents=True)                                       # what the first deploy left: the starter only
    (h.inbox / "ideas" / "7003").mkdir(parents=True)
    (h.inbox / "ideas" / "7003" / "discord.json").write_text(json.dumps(
        {"title": "Include/Exclude items", "messages": [{"at": "x", "from": "reporter", "text": "let me exclude items"}]}))
    (h.inbox / "state.json").write_text(json.dumps({"posts": {"7003": {"dir": "ideas/7003", "reporter": 7}}}))
    run(h.catch_up(forum(IDEAS, t)))
    assert len(words(h, "ideas/7003")) == 12
    assert words(h, "ideas/7003")[-1] == ("reporter", "reply 10")


def test_a_thread_that_has_not_moved_is_not_read_again(h):
    t = Thread(7004, [], content="no file")
    t.say("a reply", OTHER)
    run(h.handle(t))
    reads = t.history_reads
    run(h.catch_up(forum(999, t)))
    run(h.catch_up(forum(999, t)))
    assert t.history_reads == reads
    t.say("new", OTHER)
    run(h.catch_up(forum(999, t)))
    assert t.history_reads == reads + 1 and words(h, "posts/7004")[-1] == ("other", "new")


def test_a_failed_history_read_keeps_what_is_there_and_retries_next_time(h):
    t = Thread(7005, [], content="no file")
    run(h.handle(t))
    t.say("missed", OTHER)
    real = t.history

    def broken(**kw):
        raise RuntimeError("discord hiccup")
    t.history = broken
    run(h.catch_up(forum(999, t)))
    assert words(h, "posts/7005") == [("reporter", "no file")]
    t.history = real
    run(h.catch_up(forum(999, t)))
    assert words(h, "posts/7005")[-1] == ("other", "missed")


def test_the_bots_own_replies_are_never_kept_and_never_cause_a_read(h):
    """Owner, 2026-10-03: "the bot should ignore its own replies"."""
    t = Thread(7006, [Attachment("arbiter-report-7F3K2Q.arb", sealed_report(h.pub))], content="broken")
    run(h.handle(t))                                                  # acks "report … received" in the thread
    assert t.sent and t.messages[-1].author.bot
    reads = t.history_reads
    run(h.on_reply(t.messages[-1]))
    run(h.catch_up(forum(999, t)))
    assert t.history_reads == reads, "its own ack is not news"
    assert words(h, "7F3K2Q") == [("reporter", "broken")]


def test_a_reply_seen_live_is_not_read_again(h):
    t = Thread(7007, [], content="no file")
    run(h.handle(t))
    run(h.on_reply(t.say("live", OTHER)))
    reads = t.history_reads
    run(h.catch_up(forum(999, t)))
    assert t.history_reads == reads and words(h, "posts/7007")[-1] == ("other", "live")
