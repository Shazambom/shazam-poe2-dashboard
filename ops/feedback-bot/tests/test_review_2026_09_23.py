"""Reproductions from the 2026-09-23 review: two ways a good report is lost on the shazam side.
Both run the real cell over a real sealed report, exactly as test_bot does. Both FAIL on main."""
import asyncio
import json
import threading
import time

from bot import Handler
from conftest import valid_doc
from opener import opener
from test_bot import Attachment, Thread, keys, sealed_report


def run(coro):
    return asyncio.run(coro)


def _handler(tmp_path, process, wait_s=5):
    priv, pub = keys()
    h = Handler(spool=tmp_path / "spool", inbox=tmp_path / "inbox", private_key=priv, forum_id=999,
                process=process, wait_s=wait_s)
    h.pub = pub
    return h


def test_a_second_report_with_the_same_short_id_does_not_replace_the_first(tmp_path):
    """The public key ships in the app, so anyone can seal a report with any shortId, and a real
    report's shortId is public (the attachment name, the ✅ ack). Posting a second report under an
    earlier one's id must not overwrite the owner's copy of the first."""
    h = _handler(tmp_path, lambda inp, out: opener.run_one(inp, out, wall_s=10))
    first = valid_doc()
    first["logs"]["backend"] = "FIRST REPORT\n"
    second = valid_doc()
    second["logs"]["backend"] = "SECOND REPORT\n"
    assert first["manifest"]["shortId"] == second["manifest"]["shortId"] == "7F3K2Q"

    assert run(h.handle(Thread(2001, [Attachment("arbiter-report-7F3K2Q.arb", sealed_report(h.pub, first))]))) == "OK"
    kept = (h.inbox / "7F3K2Q" / "logs" / "backend.txt").read_text()
    assert "FIRST REPORT" in kept

    run(h.handle(Thread(2002, [Attachment("arbiter-report-7F3K2Q.arb", sealed_report(h.pub, second))])))
    stored = [p.read_text() for p in h.inbox.rglob("backend.txt")]
    assert (h.inbox / "7F3K2Q" / "logs" / "backend.txt").read_text() == kept, "the first report was overwritten"
    assert any("SECOND REPORT" in s for s in stored), "the second report must still be kept somewhere"


def test_a_half_written_result_json_is_waited_out_not_refused(tmp_path):
    """The opener writes result.json in place while the bot polls for it every 100ms. A poll that
    lands mid-write reads half a JSON document; the bot must keep waiting, not refuse a good report."""
    def slow_writer(inp, out):
        opener.run_one(inp, out, wall_s=10)
        full = (out / "result.json").read_text()
        assert json.loads(full)["status"] == "OK"
        (out / "result.json").write_text(full[: len(full) // 2])          # a poll sees this first
        def finish():
            try:
                (out / "result.json").write_text(full)
            except OSError:
                pass                                                     # the bot gave up and cleaned up
        threading.Timer(0.35, finish).start()

    h = _handler(tmp_path, slow_writer)
    t = Thread(2003, [Attachment("arbiter-report-7F3K2Q.arb", sealed_report(h.pub))])
    assert run(h.handle(t)) == "OK", t.sent
    assert t.starter.reactions == ["✅"]
    time.sleep(0.4)      # let the timer finish before tmp_path goes away
