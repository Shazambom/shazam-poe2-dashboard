"""bot.py's handler with discord objects faked and the spool on disk. The bot fetches only
`arbiter-report-*.arb` attachments, decrypts (a bad tag acks ⚠️ without spooling), waits for the
opener's result.json, moves only fixed filenames into the inbox, acks, and records the thread."""
import asyncio
import gzip
import json
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

import arbseal
from bot import Handler, ATTACHMENT_RE
from conftest import valid_doc
from opener import opener


class Attachment:
    def __init__(self, filename, data):
        self.filename, self._data, self.size = filename, data, len(data)
        self.reads = 0

    async def read(self):
        self.reads += 1
        return self._data


class Message:
    def __init__(self, attachments):
        self.attachments, self.reactions = attachments, []

    async def add_reaction(self, emoji):
        self.reactions.append(emoji)


class Thread:
    def __init__(self, tid, attachments, name="my report"):
        self.id, self.name, self.parent_id = tid, name, 999
        self.starter = Message(attachments)
        self.sent = []

    async def fetch_message(self, mid):
        assert mid == self.id
        return self.starter

    async def send(self, text):
        self.sent.append(text)


def keys():
    priv = X25519PrivateKey.generate()
    pub = priv.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return priv, pub


def sealed_report(pub, doc=None):
    return arbseal.seal(gzip.compress(json.dumps(doc or valid_doc()).encode()), pub)


@pytest.fixture
def h(tmp_path):
    priv, pub = keys()
    spool, inbox = tmp_path / "spool", tmp_path / "inbox"
    # `process` stands in for the opener container: the real cell, run synchronously.
    handler = Handler(spool=spool, inbox=inbox, private_key=priv, forum_id=999,
                      process=lambda inp, out: opener.run_one(inp, out, wall_s=10), wait_s=5)
    handler.pub = pub
    return handler


def run(coro):
    return asyncio.run(coro)


def test_attachment_name_rule():
    assert ATTACHMENT_RE.match("arbiter-report-7F3K2Q.arb")
    for bad in ("arbiter-report-7F3K2Q.arb.exe", "report.arb", "arbiter-report-7f3k2q.arb", "arbiter-report-7F3K2QQ.arb", "../arbiter-report-7F3K2Q.arb"):
        assert not ATTACHMENT_RE.match(bad), bad


def test_a_good_report_lands_in_the_inbox_and_is_acked(h):
    t = Thread(1001, [Attachment("arbiter-report-7F3K2Q.arb", sealed_report(h.pub))])
    assert run(h.handle(t)) == "OK"
    assert t.starter.reactions == ["✅"] and t.sent == ["report 7F3K2Q received — thanks"]
    got = sorted(str(p.relative_to(h.inbox / "7F3K2Q")) for p in (h.inbox / "7F3K2Q").rglob("*") if p.is_file())
    assert got == ["index.html", "logs/backend.txt", "logs/main.txt", "logs/renderer.txt", "logs/updater.txt",
                   "report.json", "screens/00-current.jpg", "screens/01-board.jpg"]
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
    data = bytearray(sealed_report(h.pub)); data[-1] ^= 1
    t = Thread(1004, [Attachment("arbiter-report-7F3K2Q.arb", bytes(data))])
    assert run(h.handle(t)) == "REFUSE"
    assert t.starter.reactions == ["⚠️"] and "couldn't read that file" in t.sent[0]
    assert not (h.spool / "in").exists() or not list((h.spool / "in").glob("*"))
    assert (h.inbox / "quarantine" / "1004.arb").read_bytes() == bytes(data)


def test_a_wrong_magic_or_key_id_is_refused_before_decrypting(h):
    t = Thread(1005, [Attachment("arbiter-report-7F3K2Q.arb", b"NOPE" + b"x" * 100)])
    assert run(h.handle(t)) == "REFUSE"
    data = bytearray(sealed_report(h.pub)); data[4] = 9
    t = Thread(1006, [Attachment("arbiter-report-7F3K2Q.arb", bytes(data))])
    assert run(h.handle(t)) == "REFUSE"
    assert "⚠️" in t.starter.reactions


def test_a_hostile_plaintext_is_quarantined_with_the_sealed_original_kept(h):
    doc = valid_doc(); del doc["manifest"]["shortId"]
    t = Thread(1007, [Attachment("arbiter-report-7F3K2Q.arb", sealed_report(h.pub, doc))])
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
        (out / "result.json").write_text(json.dumps({"status": "OK", "shortId": "../../x", "reason": "x"}))

    h = Handler(spool=spool, inbox=inbox, private_key=priv, forum_id=999, process=evil_opener, wait_s=2)
    t = Thread(1008, [Attachment("arbiter-report-7F3K2Q.arb", sealed_report(pub))])
    assert run(h.handle(t)) == "REFUSE"
    assert not list(inbox.glob("**/extra.sh"))

    def sloppy_opener(inp, out):
        out.mkdir(parents=True, exist_ok=True)
        (out / "report.json").write_text("{}")
        (out / "extra.sh").write_text("rm -rf /")
        (out / "screens").mkdir(); (out / "screens" / "00-current.jpg").write_bytes(b"\xff\xd8\xff")
        (out / "screens" / "99-evil.jpg").write_bytes(b"x")
        (out / "result.json").write_text(json.dumps({"status": "OK", "shortId": "7F3K2Q", "reason": ""}))

    h2 = Handler(spool=spool, inbox=inbox, private_key=priv, forum_id=999, process=sloppy_opener, wait_s=2)
    t = Thread(1009, [Attachment("arbiter-report-7F3K2Q.arb", sealed_report(pub))])
    assert run(h2.handle(t)) == "OK"
    got = sorted(str(p.relative_to(inbox / "7F3K2Q")) for p in (inbox / "7F3K2Q").rglob("*") if p.is_file())
    assert got == ["report.json", "screens/00-current.jpg"]


def test_opener_timeout_is_refused(tmp_path):
    priv, pub = keys()
    h = Handler(spool=tmp_path / "spool", inbox=tmp_path / "inbox", private_key=priv, forum_id=999, process=lambda i, o: None, wait_s=0.3)
    t = Thread(1010, [Attachment("arbiter-report-7F3K2Q.arb", sealed_report(pub))])
    assert run(h.handle(t)) == "REFUSE"
    assert t.starter.reactions == ["⚠️"]


def test_catch_up_walks_newest_first_and_stops_at_the_last_seen_thread(h):
    seen = []
    orig = h.handle

    async def spy(t):
        seen.append(t.id); return await orig(t)
    h.handle = spy
    (h.inbox).mkdir(parents=True, exist_ok=True)
    (h.inbox / "state.json").write_text(json.dumps({"last_thread_id": 2002}))
    mk = lambda i: Thread(i, [Attachment("arbiter-report-7F3K2Q.arb", sealed_report(h.pub))])

    class Forum:
        threads = [mk(2004), mk(2001)]              # active, any order

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
        threads = [Broken(3002, []), Thread(3001, [Attachment("arbiter-report-7F3K2Q.arb", sealed_report(h.pub))])]

        def archived_threads(self, limit=None):
            async def gen():
                return
                yield
            return gen()

    run(h.catch_up(Forum()))
    assert (h.inbox / "7F3K2Q").exists()
