"""The #feature-ideas and #feedback forums are kept too (owner, 2026-10-03: "build skills to pull the
feature ideas and feedback from the discord"). A post there is words only: the bot keeps its title and
the thread's messages under `<kind>/<threadId>/discord.json` with a status, exactly like a bug post
without a report, and never fetches an attachment, reacts or replies (nothing is posted in anyone's
words). Those forums never move the bug forum's catch-up mark, and a post the bot already keeps is never
started again; an old post from before the bot read the forum is picked up by the next catch-up."""
import asyncio
import json

from test_bot import Attachment, Author, Message, Thread, h  # noqa: F401 (fixture)

IDEAS, FEEDBACK = 777, 888


def run(coro):
    return asyncio.run(asyncio.wait_for(coro, 10))


def read(p):
    return json.loads(p.read_text())


def idea(tid, parent=IDEAS, name="Include/Exclude items", content="let me exclude items", attachments=()):
    t = Thread(tid, list(attachments), name=name, content=content)
    t.parent_id = parent
    return t


def forum(fid, *threads, archived=()):
    class Forum:
        id = fid

        def __init__(self):
            self.threads = list(threads)

        def archived_threads(self, limit=None):
            async def gen():
                for t in archived:
                    yield t
            return gen()
    return Forum()


def text_forums(h):
    h.text_forums = {IDEAS: "ideas", FEEDBACK: "feedback"}
    return h


def test_an_idea_keeps_its_words_and_status_and_the_bot_stays_silent(h):
    text_forums(h)
    shot = Attachment("mockup.png", b"\x89PNG")
    t = idea(6001, attachments=[shot])
    assert run(h.handle(t)) == "TEXT"
    d = h.inbox / "ideas" / "6001"
    assert read(d / "discord.json") == {"title": "Include/Exclude items", "messages": [
        {"at": "2026-10-02T23:54:10+00:00", "from": "reporter", "text": "let me exclude items"}]}
    assert read(d / "status.json")["state"] == "new"
    assert t.sent == [] and t.starter.reactions == [] and shot.reads == 0


def test_feedback_lands_under_its_own_kind_and_replies_append(h):
    text_forums(h)
    t = idea(6002, parent=FEEDBACK, name="Love the Hold tab", content="great app")
    run(h.handle(t))
    m = Message([], "agreed", Author(8), "2026-10-03T01:00:00+00:00")
    m.channel = t
    run(h.on_reply(m))
    msgs = read(h.inbox / "feedback" / "6002" / "discord.json")["messages"]
    assert [(x["from"], x["text"]) for x in msgs] == [("reporter", "great app"), ("other", "agreed")]


def test_text_forums_never_move_the_bug_forums_catch_up_mark(h):
    text_forums(h)
    h.inbox.mkdir(parents=True)
    (h.inbox / "state.json").write_text(json.dumps({"last_thread_id": 5000}))
    run(h.handle(idea(9000)))
    assert read(h.inbox / "state.json")["last_thread_id"] == 5000


def test_catch_up_reads_every_post_it_does_not_keep_yet_old_or_new_once(h):
    text_forums(h)
    h.inbox.mkdir(parents=True)
    (h.inbox / "state.json").write_text(json.dumps({"last_thread_id": 9999}))   # bug posts are far newer
    old, new = idea(6003, name="old"), idea(6004, name="new")
    seen = []
    orig = h.handle

    async def spy(t):
        seen.append(t.id)
        return await orig(t)
    h.handle = spy
    run(h.catch_up(forum(IDEAS, new, archived=[old])))
    assert sorted(seen) == [6003, 6004]
    assert (h.inbox / "ideas" / "6003" / "discord.json").is_file()
    run(h.catch_up(forum(IDEAS, new, archived=[old])))
    assert sorted(seen) == [6003, 6004], "a kept post is never started again"


def test_an_idea_whose_starter_is_not_ready_is_pending_and_retried(h):
    text_forums(h)

    class Late(Thread):
        tries = 0

        async def fetch_message(self, mid):
            self.tries += 1
            if self.tries <= 2:
                raise RuntimeError("404 Unknown Message")
            return await super().fetch_message(mid)
    t = Late(6005, [], content="later")
    t.parent_id = IDEAS
    assert run(h.handle(t)) == "PENDING"
    assert read(h.inbox / "state.json")["pending"] == [6005]
    assert "last_thread_id" not in read(h.inbox / "state.json"), "a pending idea leaves the bug forum's mark alone"
    run(h.catch_up(forum(IDEAS, t)))
    assert read(h.inbox / "state.json")["pending"] == []
    assert read(h.inbox / "ideas" / "6005" / "discord.json")["messages"][0]["text"] == "later"


def test_a_thread_in_the_bug_forum_still_goes_through_the_report_path(h):
    text_forums(h)
    t = Thread(6006, [], content="no file")             # parent 999 = the bug forum
    assert run(h.handle(t)) == "SKIP"
    assert (h.inbox / "posts" / "6006" / "discord.json").is_file()


def test_a_post_kept_late_keeps_the_discussion_already_in_its_thread(h):
    """The Include/Exclude idea had 12 messages before the bot read #feature-ideas; replies are only seen live,
    so a post kept late reads its thread's history once (oldest first; the starter and the bot's own skipped)."""
    text_forums(h)
    t = idea(6007, content="exclude items please")
    earlier = [t.starter, Message([], "+1", Author(8), "2026-10-03T00:10:00+00:00"),
               Message([], "noted", Author(1, bot=True), "2026-10-03T00:11:00+00:00"),
               Message([], "like a blacklist", Author(7), "2026-10-03T00:12:00+00:00")]
    for i, m in enumerate(earlier[1:]):
        m.id = 9000 + i

    def history(limit=None, oldest_first=False):
        async def gen():
            for m in (earlier if oldest_first else earlier[::-1])[:limit]:
                yield m
        return gen()
    t.history = history
    run(h.handle(t))
    msgs = read(h.inbox / "ideas" / "6007" / "discord.json")["messages"]
    assert [(m["from"], m["text"]) for m in msgs] == [("reporter", "exclude items please"), ("other", "+1"),
                                                      ("reporter", "like a blacklist")]
