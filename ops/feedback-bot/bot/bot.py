"""The feedback listener: watches the #bug-reports forum, downloads each new post's
arbiter-report-*.arb, opens it with the owner's private key (pure math — a bad tag stops here),
hands the plaintext to the opener cell through the spool, and acks in the thread. It never reads
post text beyond logging the title, never follows links, never executes anything.

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


def _log(msg):
    print(f"[bot] {msg}", flush=True)


class Handler:
    def __init__(self, spool: Path, inbox: Path, private_key, forum_id: int, process=None, wait_s: float = 60.0):
        self.spool, self.inbox, self.key, self.forum_id = Path(spool), Path(inbox), private_key, int(forum_id)
        self.process = process          # tests: run the cell inline; production: None → the opener container
        self.wait_s = wait_s

    # ---- state
    def _state(self) -> dict:
        try:
            return json.loads((self.inbox / "state.json").read_text())
        except Exception:
            return {}

    def _record(self, thread_id: int):
        self.inbox.mkdir(parents=True, exist_ok=True)
        st = self._state()
        st["last_thread_id"] = max(int(st.get("last_thread_id") or 0), int(thread_id))
        (self.inbox / "state.json").write_text(json.dumps(st))

    # ---- one thread
    async def handle(self, thread) -> str:
        _log(f"thread {thread.id}: {str(getattr(thread, 'name', ''))[:80]!r}")
        msg = await thread.fetch_message(thread.id)                  # the forum post's starter message
        att = next((a for a in msg.attachments if ATTACHMENT_RE.match(a.filename) and a.size <= MAX_ATTACHMENT), None)
        if att is None:
            self._record(thread.id)
            return "SKIP"
        data = await att.read()
        verdict = await self._process(thread.id, data)
        if verdict["status"] == "OK":
            await msg.add_reaction("✅")
            await thread.send(ACK_OK.format(sid=verdict["shortId"]))
        else:
            self._quarantine(thread.id, data)
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
            self._move(out, result["shortId"])
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
                    if (isinstance(r, dict) and r.get("status") in STATUSES and isinstance(r.get("reason"), str)
                            and len(r["reason"]) <= 200 and isinstance(r.get("shortId"), str)
                            and (r["status"] != "OK" or SHORT_ID.match(r["shortId"]))):
                        return {"status": r["status"], "shortId": r["shortId"], "reason": r["reason"]}
                except Exception:
                    pass
                return {"status": "REFUSE", "shortId": "", "reason": "malformed result.json"}
            await asyncio.sleep(0.1)
        return {"status": "REFUSE", "shortId": "", "reason": "opener timeout"}

    def _move(self, out: Path, short_id: str):
        dest = self.inbox / short_id
        dest.mkdir(parents=True, exist_ok=True)
        for rel in FIXED_FILES:
            src = out / rel
            if src.is_file():
                (dest / rel).parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(src), str(dest / rel))

    def _quarantine(self, thread_id: int, data: bytes):
        q = self.inbox / "quarantine"
        q.mkdir(parents=True, exist_ok=True)
        (q / f"{thread_id}.arb").write_bytes(data)

    # ---- catch-up on start: every thread newer than the last one recorded, newest first
    async def catch_up(self, forum):
        last = int(self._state().get("last_thread_id") or 0)
        threads = {t.id: t for t in list(getattr(forum, "threads", []))}
        async for t in forum.archived_threads(limit=None):
            threads.setdefault(t.id, t)
        for tid in sorted(threads, reverse=True):
            if tid <= last:
                break
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
    intents.message_content = True
    client = discord.Client(intents=intents)

    @client.event
    async def on_ready():
        _log(f"ready as {client.user}; catching up on forum {forum_id}")
        forum = client.get_channel(forum_id) or await client.fetch_channel(forum_id)
        await handler.catch_up(forum)

    @client.event
    async def on_thread_create(thread):
        if getattr(thread, "parent_id", None) != forum_id:
            return
        await asyncio.sleep(2)   # the starter message (with the attachment) lands a beat after the thread
        try:
            await handler.handle(thread)
        except Exception as e:
            _log(f"thread {thread.id} failed: {e!r}")

    client.run(token, log_handler=None)


if __name__ == "__main__":
    main()
