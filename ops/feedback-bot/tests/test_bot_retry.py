"""A report posted while Discord was still processing its uploads was never read (thread
1555738598714908793, report XWZGZ0, 2026-10-03 00:29 UTC): the bot slept a fixed 2 s after the thread
appeared, fetched the starter message ONCE, got 404 "Unknown Message", logged it and recorded nothing;
catch-up runs only on login and stops at the newest thread handled, so once a newer post arrived the
missed one could never be reached. Now: the fetch is retried with backoff; a thread that still fails
is kept as pending and retried by every catch-up (which also runs on a timer), whatever newer
threads were handled since; one thread is never handled twice at once."""
import asyncio
import json

from test_bot import Attachment, Thread, sealed_report, h  # noqa: F401 (fixture)


def run(coro, timeout=10):
    return asyncio.run(asyncio.wait_for(coro, timeout))   # a hang is a failure, not a stuck suite


class NotFound(Exception):
    pass


class Late(Thread):
    """A thread whose starter message 404s the first `misses` fetches."""
    def __init__(self, tid, attachments, misses, **kw):
        super().__init__(tid, attachments, **kw)
        self.misses, self.fetches = misses, 0

    async def fetch_message(self, mid):
        self.fetches += 1
        if self.fetches <= self.misses:
            raise NotFound("404 Not Found (error code: 10008): Unknown Message")
        return await super().fetch_message(mid)


def report(h):
    return [Attachment("arbiter-report-7F3K2Q.arb", sealed_report(h.pub))]


def forum(*threads):
    class Forum:
        def __init__(self):
            self.threads = list(threads)

        def archived_threads(self, limit=None):
            async def gen():
                return
                yield
            return gen()
    return Forum()


def state(h):
    return json.loads((h.inbox / "state.json").read_text())


def test_a_starter_message_that_is_not_ready_yet_is_fetched_again(h):
    h.retry_delays = (0, 0, 0)
    t = Late(4001, report(h), misses=2)
    assert run(h.handle(t)) == "OK"
    assert t.fetches == 3 and (h.inbox / "7F3K2Q" / "report.json").is_file()


def test_the_backoff_grows_and_spans_about_half_a_minute(h):
    waited = []
    from bot import RETRY_DELAYS
    h.retry_delays = RETRY_DELAYS

    async def sleep(s):
        waited.append(s)
    h.sleep = sleep
    t = Late(4002, report(h), misses=99)
    assert run(h.handle(t)) == "PENDING"
    assert waited == sorted(waited) and 20 <= sum(waited) <= 60, waited


def test_a_thread_that_still_fails_is_pending_and_the_next_catch_up_reads_it(h):
    h.retry_delays = (0,)
    stuck = Late(4003, report(h), misses=2)            # fails both tries now; ready later
    assert run(h.handle(stuck)) == "PENDING"
    assert state(h)["pending"] == [4003]
    newer = Thread(4004, report(h))
    assert run(h.handle(newer)) == "OK"
    assert state(h)["last_thread_id"] == 4004, "a newer post is handled meanwhile"
    run(h.catch_up(forum(newer, stuck)))
    assert stuck.fetches == 3, "the pending thread is retried though it is older than the last one handled"
    assert state(h)["pending"] == [] and (h.inbox / "7F3K2Q-2" / "report.json").is_file()


def test_catch_up_never_reprocesses_a_handled_thread(h):
    t = Thread(4005, report(h))
    run(h.handle(t))
    run(h.catch_up(forum(t)))
    assert not (h.inbox / "7F3K2Q-2").exists()


def test_one_thread_is_never_handled_twice_at_once(h):
    gate = asyncio.Event()

    class Slow(Thread):
        async def fetch_message(self, mid):
            await gate.wait()
            return await super().fetch_message(mid)

    t = Slow(4006, report(h))

    async def both():
        a = asyncio.create_task(h.handle(t))
        await asyncio.sleep(0)
        b = await h.handle(t)                 # the timer's catch-up reaching it mid-handle
        gate.set()
        return await a, b
    first, second = run(both())
    assert (first, second) == ("OK", "BUSY") and not (h.inbox / "7F3K2Q-2").exists()


def test_the_bot_catches_up_on_a_timer_not_only_at_login():
    from pathlib import Path
    src = (Path(__file__).resolve().parents[1] / "bot" / "bot.py").read_text()
    assert "CATCH_UP_EVERY_S" in src and "asyncio.sleep(2)" not in src
