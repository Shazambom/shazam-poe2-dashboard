"""bot.py's handler with discord objects faked and the spool on disk. The bot fetches only
`arbiter-report-*.arb` attachments, decrypts (a bad tag acks ⚠️ without spooling), waits for the
opener's result.json, moves only fixed filenames into the inbox, acks, and records the thread."""

import asyncio
import gzip
import json
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import ClassVar

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

import arbseal
from bot import ATTACHMENT_RE, Handler
from conftest import valid_doc
from opener import opener


class Attachment:
    def __init__(self, filename, data):
        self.filename, self._data, self.size = filename, data, len(data)
        self.reads = 0

    async def read(self):
        self.reads += 1
        return self._data


class Author:
    def __init__(self, uid, bot=False):
        self.id, self.bot = uid, bot


class Message:
    id: int
    channel: "Thread"

    def __init__(
        self, attachments, content="", author=None, at="2026-10-02T23:54:10+00:00"
    ):
        self.attachments, self.reactions = attachments, []
        self.content, self.author = content, author or Author(7)
        self.created_at = __import__("datetime").datetime.fromisoformat(at)

    async def add_reaction(self, emoji):
        self.reactions.append(emoji)


class Thread:
    def __init__(self, tid, attachments, name="my report", content=""):
        self.id, self.name, self.parent_id = tid, name, 999
        self.starter = Message(attachments, content)
        self.starter.id = tid  # a forum post's starter shares its thread's id
        self.messages = [self.starter]  # the thread on Discord, oldest first
        self.sent = []
        self.history_reads = 0

    @property
    def last_message_id(self):
        return self.messages[-1].id

    def say(self, text, author, at="2026-10-03T00:10:00+00:00"):
        """A message posted in the thread on Discord (whether or not the bot saw it live)."""
        m = Message([], text, author, at)
        m.id, m.channel = self.messages[-1].id + 1, self
        self.messages.append(m)
        return m

    def history(self, limit=None, oldest_first=False):
        self.history_reads += 1
        msgs = self.messages if oldest_first else self.messages[::-1]

        async def gen():
            for m in msgs[:limit]:
                yield m

        return gen()

    async def fetch_message(self, mid):
        assert mid == self.id
        return self.starter

    async def send(self, text):
        self.sent.append(text)
        return self.say(text, Author(1, bot=True))


def keys():
    priv = X25519PrivateKey.generate()
    pub = priv.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    return priv, pub


def sealed_report(pub, doc=None):
    return arbseal.seal(gzip.compress(json.dumps(doc or valid_doc()).encode()), pub)


class _HandlerWithPublicKey(Handler):
    pub: bytes


@pytest.fixture
def h(tmp_path):
    priv, pub = keys()
    spool, inbox = tmp_path / "spool", tmp_path / "inbox"
    # `process` stands in for the opener container: the real cell, run synchronously.
    handler = _HandlerWithPublicKey(
        spool=spool,
        inbox=inbox,
        private_key=priv,
        forum_id=999,
        process=lambda inp, out: opener.run_one(inp, out, wall_s=10),
        wait_s=5,
    )
    handler.pub = pub
    handler.retry_delays = (0,)  # the real backoff schedule is test_bot_retry's
    return handler


def run(coro):
    return asyncio.run(coro)


@pytest.mark.parametrize(
    "operation", ["reports", "replies", "catchup", "actions", "announcements"]
)
def test_feedback_file_steps_run_off_loop(h, monkeypatch, operation):
    thread = Thread(
        1001, [Attachment("arbiter-report-7F3K2Q.arb", sealed_report(h.pub))]
    )
    if operation != "reports":
        h._start_post(thread, thread.starter, "posts/1001")
    if operation in ("actions", "announcements"):
        directory = h.inbox / ("actions" if operation == "actions" else "announce")
        directory.mkdir()
        payload = (
            {"report": "posts/1001", "action": "triage"}
            if operation == "actions"
            else {"version": "1.2.3"}
        )
        (directory / "fixture.json").write_text(json.dumps(payload))

    async def archived_threads(limit=None):
        for item in ():
            yield item

    async def get_target():
        return None

    loop_thread = threading.get_ident()
    calls = []
    read = Path.read_text
    write = Path.write_text

    def read_text(path, *args, **kwargs):
        calls.append((path.name, threading.get_ident()))
        return read(path, *args, **kwargs)

    def write_text(path, *args, **kwargs):
        calls.append((path.name, threading.get_ident()))
        return write(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", read_text)
    monkeypatch.setattr(Path, "write_text", write_text)
    if operation == "reports":
        assert run(h.handle(thread)) == "OK"
        assert "result.json" in {name for name, _ in calls}
    elif operation == "replies":
        run(h.on_reply(thread.say("more", Author(7))))
    elif operation == "catchup":
        run(
            h.catch_up(
                SimpleNamespace(threads=[thread], archived_threads=archived_threads)
            )
        )
    elif operation == "actions":
        run(h.process_actions(get_target))
    else:
        run(h.process_announcements(get_target))
    assert calls
    assert [name for name, ident in calls if ident == loop_thread] == []


def test_attachment_name_rule():
    assert ATTACHMENT_RE.match("arbiter-report-7F3K2Q.arb")
    for bad in (
        "arbiter-report-7F3K2Q.arb.exe",
        "report.arb",
        "arbiter-report-7f3k2q.arb",
        "arbiter-report-7F3K2QQ.arb",
        "../arbiter-report-7F3K2Q.arb",
    ):
        assert not ATTACHMENT_RE.match(bad), bad


def test_a_good_report_lands_in_the_inbox_and_is_acked(h):
    t = Thread(1001, [Attachment("arbiter-report-7F3K2Q.arb", sealed_report(h.pub))])
    assert run(h.handle(t)) == "OK"
    assert t.starter.reactions == ["✅"] and t.sent == [
        "report 7F3K2Q received — thanks"
    ]
    got = sorted(
        str(p.relative_to(h.inbox / "7F3K2Q"))
        for p in (h.inbox / "7F3K2Q").rglob("*")
        if p.is_file()
    )
    assert got == [
        "discord.json",
        "index.html",
        "logs/backend.txt",
        "logs/main.txt",
        "logs/renderer.txt",
        "logs/updater.txt",
        "report.json",
        "screens/00-current.jpg",
        "screens/01-board.jpg",
        "status.json",
    ]
    assert json.loads((h.inbox / "state.json").read_text())["last_thread_id"] == 1001
    assert not list((h.spool / "in").glob("*")), "spool input consumed"


def test_only_matching_attachments_are_fetched_and_the_first_wins(h):
    junk = Attachment("notes.txt", b"hi")
    big = Attachment("arbiter-report-AAAAAA.arb", b"x" * (4 * 1024 * 1024 + 66))
    good = Attachment("arbiter-report-7F3K2Q.arb", sealed_report(h.pub))
    second = Attachment("arbiter-report-BBBBBB.arb", sealed_report(h.pub))
    t = Thread(1002, [junk, big, good, second])
    assert run(h.handle(t)) == "OK"
    assert junk.reads == 0 and big.reads == 0 and good.reads == 1 and second.reads == 0


def test_no_report_attachment_is_skipped_silently(h):
    t = Thread(1003, [Attachment("screenshot.png", b"\x89PNG")])
    assert run(h.handle(t)) == "SKIP"
    assert t.starter.reactions == [] and t.sent == []


def test_a_bad_tag_acks_warning_without_spooling(h):
    data = bytearray(sealed_report(h.pub))
    data[-1] ^= 1
    t = Thread(1004, [Attachment("arbiter-report-7F3K2Q.arb", bytes(data))])
    assert run(h.handle(t)) == "REFUSE"
    assert t.starter.reactions == ["⚠️"] and "couldn't read that file" in t.sent[0]
    assert not (h.spool / "in").exists() or not list((h.spool / "in").glob("*"))
    assert (h.inbox / "quarantine" / "1004.arb").read_bytes() == bytes(data)


def test_a_wrong_magic_or_key_id_is_refused_before_decrypting(h):
    t = Thread(1005, [Attachment("arbiter-report-7F3K2Q.arb", b"NOPE" + b"x" * 100)])
    assert run(h.handle(t)) == "REFUSE"
    data = bytearray(sealed_report(h.pub))
    data[4] = 9
    t = Thread(1006, [Attachment("arbiter-report-7F3K2Q.arb", bytes(data))])
    assert run(h.handle(t)) == "REFUSE"
    assert "⚠️" in t.starter.reactions


def test_a_hostile_plaintext_is_quarantined_with_the_sealed_original_kept(h):
    doc = valid_doc()
    del doc["manifest"]["shortId"]
    t = Thread(
        1007, [Attachment("arbiter-report-7F3K2Q.arb", sealed_report(h.pub, doc))]
    )
    assert run(h.handle(t)) == "QUARANTINE"
    assert t.starter.reactions == ["⚠️"]
    assert (h.inbox / "quarantine" / "1007.arb").exists()
    assert not (h.inbox / "7F3K2Q").exists()


def test_a_malformed_result_json_is_refused_and_only_fixed_filenames_move(tmp_path):
    priv, pub = keys()
    spool, inbox = tmp_path / "spool", tmp_path / "inbox"

    def evil_opener(inp, out):
        out.mkdir(parents=True, exist_ok=True)
        (out / "report.json").write_text("{}")
        (out / "extra.sh").write_text("rm -rf /")
        (out / "result.json").write_text(
            json.dumps({"status": "OK", "shortId": "../../x", "reason": "x"})
        )

    h = Handler(
        spool=spool,
        inbox=inbox,
        private_key=priv,
        forum_id=999,
        process=evil_opener,
        wait_s=2,
    )
    t = Thread(1008, [Attachment("arbiter-report-7F3K2Q.arb", sealed_report(pub))])
    assert run(h.handle(t)) == "REFUSE"
    assert not list(inbox.glob("**/extra.sh"))

    def sloppy_opener(inp, out):
        out.mkdir(parents=True, exist_ok=True)
        (out / "report.json").write_text("{}")
        (out / "extra.sh").write_text("rm -rf /")
        (out / "screens").mkdir()
        (out / "screens" / "00-current.jpg").write_bytes(b"\xff\xd8\xff")
        (out / "screens" / "99-evil.jpg").write_bytes(b"x")
        (out / "discord.json").write_text(
            '{"title": "forged by the report"}'
        )  # the report never speaks for the post
        (out / "status.json").write_text(
            '{"state": "resolved"}'
        )  # nor sets its own status
        (out / "result.json").write_text(
            json.dumps({"status": "OK", "shortId": "7F3K2Q", "reason": ""})
        )

    h2 = Handler(
        spool=spool,
        inbox=inbox,
        private_key=priv,
        forum_id=999,
        process=sloppy_opener,
        wait_s=2,
    )
    t = Thread(1009, [Attachment("arbiter-report-7F3K2Q.arb", sealed_report(pub))])
    assert run(h2.handle(t)) == "OK"
    got = sorted(
        str(p.relative_to(inbox / "7F3K2Q"))
        for p in (inbox / "7F3K2Q").rglob("*")
        if p.is_file()
    )
    assert got == [
        "discord.json",
        "report.json",
        "screens/00-current.jpg",
        "status.json",
    ]
    assert (
        json.loads((inbox / "7F3K2Q" / "status.json").read_text())["state"] == "new"
    ), "the bot's status, not the report's"
    assert (
        json.loads((inbox / "7F3K2Q" / "discord.json").read_text())["title"]
        == "my report"
    ), "the bot's, not the report's"


def test_opener_timeout_is_refused(tmp_path):
    priv, pub = keys()
    h = Handler(
        spool=tmp_path / "spool",
        inbox=tmp_path / "inbox",
        private_key=priv,
        forum_id=999,
        process=lambda i, o: None,
        wait_s=0.3,
    )
    t = Thread(1010, [Attachment("arbiter-report-7F3K2Q.arb", sealed_report(pub))])
    assert run(h.handle(t)) == "REFUSE"
    assert t.starter.reactions == ["⚠️"]


def test_catch_up_walks_newest_first_and_stops_at_the_last_seen_thread(h):
    seen = []
    orig = h.handle

    async def spy(t):
        seen.append(t.id)
        return await orig(t)

    h.handle = spy
    (h.inbox).mkdir(parents=True, exist_ok=True)
    (h.inbox / "state.json").write_text(json.dumps({"last_thread_id": 2002}))

    def mk(i):
        return Thread(
            i, [Attachment("arbiter-report-7F3K2Q.arb", sealed_report(h.pub))]
        )

    class Forum:
        threads: ClassVar[list[Thread]] = [mk(2004), mk(2001)]  # active, any order

        def archived_threads(self, limit=None):
            async def gen():
                for t in (mk(2003), mk(2002), mk(2000)):
                    yield t

            return gen()

    run(h.catch_up(Forum()))
    assert sorted(seen) == [2003, 2004]
    assert json.loads((h.inbox / "state.json").read_text())["last_thread_id"] == 2004


def test_an_exception_in_one_thread_does_not_stop_the_next(h):
    class Broken(Thread):
        async def fetch_message(self, mid):
            raise RuntimeError("discord hiccup")

    (h.inbox).mkdir(parents=True, exist_ok=True)

    class Forum:
        threads: ClassVar[list[Thread]] = [
            Broken(3002, []),
            Thread(
                3001, [Attachment("arbiter-report-7F3K2Q.arb", sealed_report(h.pub))]
            ),
        ]

        def archived_threads(self, limit=None):
            async def gen():
                for thread in ():
                    yield thread

            return gen()

    run(h.catch_up(Forum()))
    assert (h.inbox / "7F3K2Q").exists()


def test_report_input_is_atomic_and_private_until_the_opener_returns(h):
    report = sealed_report(h.pub)
    paths = []

    def process(inp, out):
        paths.extend((inp, out))
        assert inp.is_file()
        assert not inp.with_suffix(".tmp").exists()
        assert inp.stat().st_mode & 0o777 == 0o600
        assert json.loads(gzip.decompress(inp.read_bytes())) == valid_doc()
        out.mkdir(parents=True)
        (out / "result.json").write_text(
            '{"status": "REFUSE", "shortId": "", "reason": ""}'
        )

    h.process = process
    assert run(h._process(3002, report)) == {
        "status": "REFUSE",
        "shortId": "",
        "reason": "",
    }
    assert len(paths) == 2
    assert all(not path.exists() for path in paths)


def test_cancelled_report_keeps_the_thread_busy_until_staging_finishes(h, monkeypatch):
    import threading

    import bot

    report = sealed_report(h.pub)
    thread = Thread(3003, [Attachment("arbiter-report-123456.arb", report)])
    started, release = threading.Event(), threading.Event()
    stage_report = bot._stage_report

    def stage(inp, plain):
        started.set()
        assert release.wait(5)
        stage_report(inp, plain)

    monkeypatch.setattr(bot, "_stage_report", stage)

    async def process():
        task = asyncio.create_task(h.handle(thread))
        try:
            assert await asyncio.to_thread(started.wait, 2)
            task.cancel()
            await asyncio.sleep(0)
            task.cancel()
            await asyncio.sleep(0)
            assert not task.done()
            assert await h.handle(thread) == "BUSY"
        finally:
            release.set()
        with pytest.raises(asyncio.CancelledError):
            await task

    run(process())
    staged = h.spool / "in" / "3003.gz"
    assert json.loads(gzip.decompress(staged.read_bytes())) == valid_doc()
    assert staged.stat().st_mode & 0o777 == 0o600
    assert not staged.with_suffix(".tmp").exists()
    assert 3003 not in h._busy


def test_finish_io_returns_result_and_propagates_errors_without_cancel():
    import bot

    def succeed(x: int) -> int:
        return x + 1

    def fail() -> None:
        raise RuntimeError("boom")

    assert run(bot._finish_io(succeed, 41)) == 42
    with pytest.raises(RuntimeError, match="boom"):
        run(bot._finish_io(fail))


def test_finish_io_waits_for_successful_worker_then_raises_cancelled():
    import bot

    started, release, finished = (
        threading.Event(),
        threading.Event(),
        threading.Event(),
    )

    def slow_ok() -> int:
        started.set()
        assert release.wait(5)
        finished.set()
        return 7

    async def go() -> asyncio.Task[int]:
        task = asyncio.create_task(bot._finish_io(slow_ok))
        try:
            assert await asyncio.to_thread(started.wait, 2)
            task.cancel()
            await asyncio.sleep(0)
            assert not task.done()
        finally:
            release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        return task

    task = run(go())
    assert finished.is_set()
    assert task.cancelled()


def test_finish_io_preserves_cancellation_when_worker_fails():
    import bot

    started, release = threading.Event(), threading.Event()

    def slow_fail() -> None:
        started.set()
        assert release.wait(5)
        raise RuntimeError("disk full")

    async def go() -> tuple[asyncio.Task[None], BaseException | None]:
        task = asyncio.create_task(bot._finish_io(slow_fail))
        try:
            assert await asyncio.to_thread(started.wait, 2)
            task.cancel()
            await asyncio.sleep(0)
            assert not task.done()
        finally:
            release.set()
        caught: BaseException | None = None
        try:
            await task
        except BaseException as exc:
            caught = exc
        return task, caught

    task, caught = run(go())
    assert task.cancelled()
    assert isinstance(caught, asyncio.CancelledError)
    assert isinstance(caught.__cause__, RuntimeError)
    assert "disk full" in str(caught.__cause__)
