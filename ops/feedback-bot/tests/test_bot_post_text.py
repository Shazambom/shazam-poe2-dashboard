"""The reporter's words travel with the report (owner, 2026-10-02: "we need to save the message from
discord along the report"). Report FY0M4R's file said nothing about the problem; the bug was only in
the forum post ("The item "Raven's reflection" doesn't show up…") and a reply after the bot's ack.
The bot keeps the post's title and the thread's messages as plain JSON beside the report
(`discord.json`): data, never rendered or followed; authors only as reporter / other / bot, never a
name. A post without a readable report keeps its words too (`posts/<threadId>/discord.json`)."""
import asyncio
import json

from test_bot import Attachment, Author, Message, Thread, sealed_report, h  # noqa: F401 (fixture)

REPORTER = Author(7)


def run(coro):
    return asyncio.run(coro)


def read(p):
    return json.loads(p.read_text())


def reply(thread, text, author, at="2026-10-02T23:54:26+00:00"):
    m = Message([], text, author, at)
    m.channel = thread
    return m


def test_the_post_title_and_text_land_beside_the_report(h):
    t = Thread(1001, [Attachment("arbiter-report-7F3K2Q.arb", sealed_report(h.pub))],
               name="Item doesn't show up", content='The item "Raven\'s reflection" doesn\'t show up <b>here</b>')
    assert run(h.handle(t)) == "OK"
    assert read(h.inbox / "7F3K2Q" / "discord.json") == {
        "title": "Item doesn't show up",
        "messages": [{"at": "2026-10-02T23:54:10+00:00", "from": "reporter",
                      "text": 'The item "Raven\'s reflection" doesn\'t show up <b>here</b>'}]}


def test_later_replies_in_the_thread_are_appended_and_the_bots_own_are_not(h):
    t = Thread(1001, [Attachment("arbiter-report-7F3K2Q.arb", sealed_report(h.pub))], content="first")
    run(h.handle(t))
    run(h.on_reply(reply(t, "Hope i did it right lol", REPORTER)))
    run(h.on_reply(reply(t, "report 7F3K2Q received — thanks", Author(1, bot=True))))
    run(h.on_reply(reply(t, "same here", Author(8), at="2026-10-02T23:55:00+00:00")))
    msgs = read(h.inbox / "7F3K2Q" / "discord.json")["messages"]
    assert [(m["from"], m["text"]) for m in msgs] == [("reporter", "first"), ("reporter", "Hope i did it right lol"),
                                                      ("other", "same here")]


def test_a_reply_in_a_thread_the_bot_never_handled_is_ignored(h):
    stray = Thread(5555, [])
    run(h.on_reply(reply(stray, "hello", REPORTER)))
    assert not (h.inbox / "posts").exists() and not any(h.inbox.rglob("discord.json"))


def test_a_post_without_a_readable_report_keeps_its_words(h):
    plain = Thread(1002, [], name="Hold is empty", content="no file, just this")
    assert run(h.handle(plain)) == "SKIP"
    assert read(h.inbox / "posts" / "1002" / "discord.json")["messages"][0]["text"] == "no file, just this"
    bad = Thread(1003, [Attachment("arbiter-report-7F3K2Q.arb", b"not sealed" * 20)], content="broken file")
    assert run(h.handle(bad)) == "REFUSE"
    assert read(h.inbox / "posts" / "1003" / "discord.json")["title"] == "my report"
    run(h.on_reply(reply(bad, "retrying", REPORTER)))
    assert len(read(h.inbox / "posts" / "1003" / "discord.json")["messages"]) == 2


def test_text_is_capped_and_a_thread_holds_at_most_100_messages(h):
    t = Thread(1001, [Attachment("arbiter-report-7F3K2Q.arb", sealed_report(h.pub))], content="x" * 10_000)
    run(h.handle(t))
    for i in range(150):
        run(h.on_reply(reply(t, f"m{i}", REPORTER)))
    msgs = read(h.inbox / "7F3K2Q" / "discord.json")["messages"]
    assert len(msgs[0]["text"]) == 4000 and len(msgs) == 100


def test_the_place_survives_a_restart(h):
    t = Thread(1001, [Attachment("arbiter-report-7F3K2Q.arb", sealed_report(h.pub))], content="first")
    run(h.handle(t))
    from bot import Handler
    again = Handler(spool=h.spool, inbox=h.inbox, private_key=h.key, forum_id=999)
    run(again.on_reply(reply(t, "after restart", REPORTER)))
    assert read(h.inbox / "7F3K2Q" / "discord.json")["messages"][-1]["text"] == "after restart"
