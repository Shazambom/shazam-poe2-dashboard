"""The feedback listener: watches the #bug-reports forum, downloads each new post's
arbiter-report-*.arb, opens it with the owner's private key (pure math — a bad tag stops here),
hands the plaintext to the opener cell through the spool, and acks in the thread. The post's title and
the thread's messages are kept as plain JSON beside the report (`discord.json`; the reporter's words,
owner 2026-10-02) — data only: never rendered, parsed, followed or executed; authors are kept only as
reporter / other / bot. It never follows links, never executes anything.

    Discord ──► Handler.handle(thread) ──► SPOOL/in/<threadId>.gz ──► (opener container) ──►
    SPOOL/out/<threadId>/result.json ──► INBOX/<shortId>/ (fixed filenames only) ──► ✅ / ⚠️

`Handler` is pure asyncio over duck-typed thread/message/attachment objects, so the tests fake
Discord; `main()` binds it to discord.py. Env: DISCORD_TOKEN_FILE, FORUM_CHANNEL_ID, KEY_DIR
(feedback-key-<keyId>.pem), SPOOL, INBOX.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import time
from pathlib import Path

from cryptography.hazmat.primitives import serialization

import arbseal
from opener.dests import SCREENS

ATTACHMENT_RE = re.compile(r"^arbiter-report-[0-9A-HJ-NP-Z]{6}\.arb$")
MAX_ATTACHMENT = 4 * 1024 * 1024 + arbseal.OVERHEAD
SHORT_ID = re.compile(r"^[0-9A-HJ-NP-Z]{6}$")
STATUSES = {"OK", "REFUSE", "QUARANTINE"}
# The only files that ever move from the spool to the inbox — the opener's schema, never a glob.
FIXED_FILES = ["report.json", "index.html", "logs/main.txt", "logs/backend.txt", "logs/renderer.txt", "logs/updater.txt",
               *(f"screens/{i:02d}-{name}.jpg" for i, name in enumerate(SCREENS))]
ACK_OK = "report {sid} received — thanks"
ACK_BAD = "couldn't read that file — was it made by Arbiter's \"Report a problem\"?"
POST_FILE = "discord.json"
MAX_TEXT = 4000          # Discord caps a message at 2000 (4000 with Nitro)
MAX_MESSAGES = 100
# A post's starter message can 404 for a few seconds after its thread appears (Discord still taking
# the uploads; report XWZGZ0 was missed after one fetch at +2 s). Retried with backoff; a thread that
# still fails stays pending and every catch-up retries it. Catch-up also runs on a timer.
RETRY_DELAYS = (1, 2, 4, 8, 16)
CATCH_UP_EVERY_S = 300
ACTIONS_EVERY_S = 60
# A report's status (status.json beside it): new → triaged → resolved / closed. The owner's side asks
# through `inbox/actions/*.json` ({"report": <dir>, "action": …}, written by bugs.py); the bot applies
# them. The thread replies are FIXED texts: nothing is ever posted in anyone's words.
STATUS_FILE = "status.json"
ACTIONS = {"triage": "triaged", "resolve": "resolved", "close": "closed"}
REPLY = {"resolve": "Fixed — the fix ships in the next Arbiter update. Thanks for reporting it!",
         "close": "Closed — thanks for the report."}


def _log(msg):
    print(f"[bot] {msg}", flush=True)


class Handler:
    def __init__(self, spool: Path, inbox: Path, private_key, forum_id: int, process=None, wait_s: float = 60.0):
        self.spool, self.inbox, self.key, self.forum_id = Path(spool), Path(inbox), private_key, int(forum_id)
        self.process = process          # tests: run the cell inline; production: None → the opener container
        self.wait_s = wait_s
        self.retry_delays, self.sleep = RETRY_DELAYS, asyncio.sleep
        self._busy: set[int] = set()

    # ---- state
    def _state(self) -> dict:
        try:
            return json.loads((self.inbox / "state.json").read_text())
        except Exception:
            return {}

    def _record(self, thread_id: int, pending: bool = False):
        self.inbox.mkdir(parents=True, exist_ok=True)
        st = self._state()
        st["last_thread_id"] = max(int(st.get("last_thread_id") or 0), int(thread_id))
        left = [t for t in st.get("pending", []) if t != int(thread_id)]
        st["pending"] = sorted(left + [int(thread_id)]) if pending else left
        (self.inbox / "state.json").write_text(json.dumps(st))

    async def _starter(self, thread):
        """The forum post's starter message, fetched again while Discord answers that it is not there yet."""
        for delay in (*self.retry_delays, None):
            try:
                return await thread.fetch_message(thread.id)
            except Exception as e:
                if delay is None:
                    _log(f"thread {thread.id}: starter message unavailable ({e!r}); pending")
                    return None
                await self.sleep(delay)

    # ---- the post's words: title + messages, beside the report (or under posts/ without one)
    def _post_dir(self, thread_id) -> tuple[Path | None, int | None]:
        post = (self._state().get("posts") or {}).get(str(thread_id))
        return (self.inbox / post["dir"], post["reporter"]) if post else (None, None)

    def _start_post(self, thread, starter, rel: str):
        st = self._state()
        st.setdefault("posts", {})[str(thread.id)] = {"dir": rel, "reporter": starter.author.id}   # ids stay in state
        self.inbox.mkdir(parents=True, exist_ok=True)
        (self.inbox / "state.json").write_text(json.dumps(st))
        d = self.inbox / rel
        d.mkdir(parents=True, exist_ok=True)
        doc = {"title": str(getattr(thread, "name", ""))[:200], "messages": []}
        self._append(d, doc, starter, reporter_id=starter.author.id)
        self._set_status(d, "new")

    @staticmethod
    def _set_status(d: Path, state: str):
        (d / STATUS_FILE).write_text(json.dumps({"state": state, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}))

    # ---- the owner's actions: triage / resolve / close
    async def process_actions(self, get_thread):
        adir = self.inbox / "actions"
        if not adir.is_dir():
            return
        posts = {v["dir"]: int(tid) for tid, v in (self._state().get("posts") or {}).items()}
        for f in sorted(adir.glob("*.json")):
            try:
                a = json.loads(f.read_text())
                rel, kind = a["report"], a["action"]
                if kind not in ACTIONS or rel not in posts:
                    raise ValueError(f"unknown action or report: {kind!r} {rel!r}")
                d = self.inbox / rel
                now = json.loads((d / STATUS_FILE).read_text())["state"] if (d / STATUS_FILE).is_file() else "new"
                if now != ACTIONS[kind]:
                    if kind in REPLY:
                        thread = await get_thread(posts[rel])
                        await thread.send(REPLY[kind])
                        try:
                            await thread.edit(archived=True)
                        except Exception as e:                        # no Manage Threads: the reply still stands
                            _log(f"{rel}: could not archive the thread ({e!r})")
                    self._set_status(d, ACTIONS[kind])
                    _log(f"{rel}: {ACTIONS[kind]}")
                f.unlink()
            except Exception as e:
                _log(f"action {f.name} set aside: {e!r}")
                (adir / "rejected").mkdir(exist_ok=True)
                f.replace(adir / "rejected" / f.name)

    @staticmethod
    def _entry(msg, reporter_id) -> dict:
        who = "bot" if msg.author.bot else "reporter" if msg.author.id == reporter_id else "other"
        return {"at": msg.created_at.isoformat(), "from": who, "text": str(msg.content or "")[:MAX_TEXT]}

    def _append(self, d: Path, doc: dict, msg, reporter_id):
        if len(doc["messages"]) < MAX_MESSAGES:
            doc["messages"].append(self._entry(msg, reporter_id))
        (d / POST_FILE).write_text(json.dumps(doc, ensure_ascii=False, indent=1))

    async def on_reply(self, msg):
        """A later message in a thread the bot handled (the bot's own acks are not kept)."""
        if msg.author.bot:
            return
        d, reporter = self._post_dir(getattr(msg.channel, "id", None))
        if d is None or not (d / POST_FILE).is_file():
            return
        self._append(d, json.loads((d / POST_FILE).read_text()), msg, reporter)

    # ---- one thread
    async def handle(self, thread) -> str:
        if thread.id in self._busy:                                   # the timer's catch-up met an on_thread_create
            return "BUSY"
        self._busy.add(thread.id)
        try:
            return await self._handle(thread)
        finally:
            self._busy.discard(thread.id)

    async def _handle(self, thread) -> str:
        _log(f"thread {thread.id}: {str(getattr(thread, 'name', ''))[:80]!r}")
        msg = await self._starter(thread)                             # the forum post's starter message
        if msg is None:
            self._record(thread.id, pending=True)
            return "PENDING"
        att = next((a for a in msg.attachments if ATTACHMENT_RE.match(a.filename) and a.size <= MAX_ATTACHMENT), None)
        if att is None:
            self._start_post(thread, msg, f"posts/{thread.id}")
            self._record(thread.id)
            return "SKIP"
        data = await att.read()
        verdict = await self._process(thread.id, data)
        if verdict["status"] == "OK":
            self._start_post(thread, msg, verdict["dir"])
            await msg.add_reaction("✅")
            await thread.send(ACK_OK.format(sid=verdict["shortId"]))
        else:
            self._quarantine(thread.id, data)
            self._start_post(thread, msg, f"posts/{thread.id}")
            await msg.add_reaction("⚠️")
            await thread.send(ACK_BAD)
        self._record(thread.id)
        return verdict["status"]

    async def _process(self, thread_id: int, data: bytes) -> dict:
        if len(data) < arbseal.OVERHEAD or data[:4] != arbseal.MAGIC or data[4] != arbseal.KEY_ID:
            return {"status": "REFUSE", "shortId": "", "reason": "magic/keyId"}
        try:
            plain = arbseal.open_sealed(data, self.key)
        except Exception:
            return {"status": "REFUSE", "shortId": "", "reason": "bad tag"}
        inp = self.spool / "in" / f"{thread_id}.gz"
        out = self.spool / "out" / str(thread_id)
        inp.parent.mkdir(parents=True, exist_ok=True)
        tmp = inp.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(plain)
        os.replace(tmp, inp)                                          # atomic: the opener never sees a half file
        if self.process:
            self.process(inp, out)
        result = await self._wait_result(out)
        if result["status"] == "OK":
            result["dir"] = self._move(out, result["shortId"])
        shutil.rmtree(out, ignore_errors=True)
        inp.unlink(missing_ok=True)
        return result

    async def _wait_result(self, out: Path) -> dict:
        deadline = time.monotonic() + self.wait_s
        while time.monotonic() < deadline:
            p = out / "result.json"
            if p.exists():
                try:
                    r = json.loads(p.read_text())
                except (OSError, ValueError):
                    await asyncio.sleep(0.1)          # a poll that landed mid-write: not a verdict yet
                    continue
                if (isinstance(r, dict) and r.get("status") in STATUSES and isinstance(r.get("reason"), str)
                        and len(r["reason"]) <= 200 and isinstance(r.get("shortId"), str)
                        and (r["status"] != "OK" or SHORT_ID.match(r["shortId"]))):
                    return {"status": r["status"], "shortId": r["shortId"], "reason": r["reason"]}
                return {"status": "REFUSE", "shortId": "", "reason": "malformed result.json"}
            await asyncio.sleep(0.1)
        return {"status": "REFUSE", "shortId": "", "reason": "opener timeout"}

    def _move(self, out: Path, short_id: str):
        # Anyone can seal a report under any shortId (the public key ships in the app) and a real
        # report's id is public, so a second report under an earlier id goes BESIDE it, never over it.
        dest, n = self.inbox / short_id, 1
        while dest.exists():
            n += 1
            dest = self.inbox / f"{short_id}-{n}"
        dest.mkdir(parents=True)
        for rel in FIXED_FILES:
            src = out / rel
            if src.is_file():
                (dest / rel).parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(src), str(dest / rel))
        return dest.name

    def _quarantine(self, thread_id: int, data: bytes):
        q = self.inbox / "quarantine"
        q.mkdir(parents=True, exist_ok=True)
        (q / f"{thread_id}.arb").write_bytes(data)

    # ---- catch-up (at login and on a timer): every thread newer than the last one recorded, newest
    # first, and every pending one whatever its age
    async def catch_up(self, forum):
        st = self._state()
        last, pending = int(st.get("last_thread_id") or 0), set(st.get("pending", []))
        threads = {t.id: t for t in list(getattr(forum, "threads", []))}
        async for t in forum.archived_threads(limit=None):
            threads.setdefault(t.id, t)
        for tid in sorted(threads, reverse=True):
            if tid <= last and tid not in pending:
                continue
            try:
                await self.handle(threads[tid])
            except Exception as e:                                    # one bad thread never stops the rest
                _log(f"thread {tid} failed: {e!r}")


# ---------------------------------------------------------------- discord.py binding
def main():
    import discord

    token = Path(os.environ["DISCORD_TOKEN_FILE"]).read_text().strip()
    forum_id = int(os.environ["FORUM_CHANNEL_ID"])
    key_path = Path(os.environ.get("KEY_DIR", "/keys")) / f"feedback-key-{arbseal.KEY_ID}.pem"
    key = serialization.load_pem_private_key(key_path.read_bytes(), password=None)
    handler = Handler(spool=Path(os.environ.get("SPOOL", "/spool")), inbox=Path(os.environ.get("INBOX", "/inbox")),
                      private_key=key, forum_id=forum_id)

    intents = discord.Intents.none()
    intents.guilds = True
    intents.guild_messages = True     # replies in the forum's threads (kept beside the report)
    intents.message_content = True
    client = discord.Client(intents=intents)

    timer = None

    async def every():
        tick = 0
        while True:
            await asyncio.sleep(ACTIONS_EVERY_S)
            tick += 1
            try:
                await handler.process_actions(lambda tid: client.fetch_channel(tid))
            except Exception as e:
                _log(f"actions failed: {e!r}")
            if tick * ACTIONS_EVERY_S % CATCH_UP_EVERY_S == 0:
                try:
                    forum = client.get_channel(forum_id) or await client.fetch_channel(forum_id)
                    await handler.catch_up(forum)
                except Exception as e:
                    _log(f"catch-up failed: {e!r}")

    @client.event
    async def on_ready():
        nonlocal timer
        _log(f"ready as {client.user}; catching up on forum {forum_id}")
        forum = client.get_channel(forum_id) or await client.fetch_channel(forum_id)
        await handler.catch_up(forum)
        if timer is None:
            timer = asyncio.create_task(every())

    @client.event
    async def on_message(message):
        if getattr(getattr(message, "channel", None), "parent_id", None) != forum_id or message.id == message.channel.id:
            return                                                    # not a reply in the forum (the starter is handle()'s)
        try:
            await handler.on_reply(message)
        except Exception as e:
            _log(f"reply in {message.channel.id} failed: {e!r}")

    @client.event
    async def on_thread_create(thread):
        if getattr(thread, "parent_id", None) != forum_id:
            return
        try:
            await handler.handle(thread)
        except Exception as e:
            _log(f"thread {thread.id} failed: {e!r}")

    client.run(token, log_handler=None)


if __name__ == "__main__":
    main()
