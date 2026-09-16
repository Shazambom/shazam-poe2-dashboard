"""Parent-death watchdog — stdlib only (imported by both the backend and the lean sidecar).

The supervision tree is Electron → backend → sidecar; no child may outlive its parent (a
dangling backend locks the Windows install dir and breaks the next update; a dangling sidecar
wastes CPU/RAM). Two mechanisms, used together:

  * stdin-EOF (primary, cross-platform): the parent spawns the child holding its stdin open and
    never writes to it; when the parent dies, the pipe closes and the child's stdin hits EOF.
  * PARENT_PID poll (backup, POSIX): watch the recorded parent pid and exit when it vanishes.

`guard()` wires whichever are available and hard-exits on the first death signal.
"""
from __future__ import annotations

import os
import sys
import threading
from typing import Callable, Optional


def parent_alive(pid: Optional[int]) -> bool:
    """True if `pid` names a live process. A falsy pid means 'no parent tracked' → alive, so a
    standalone/dev run never self-terminates."""
    if not pid:
        return True
    # ⚠️ Windows: os.kill(pid, 0) is NOT a probe — signal 0 is CTRL_C_EVENT, so calling it would send
    # Ctrl+C to our own console process group and kill the whole supervision tree (backend + sidecar)
    # every poll. Use the side-effect-free handle check there and never touch os.kill. (POSIX below.)
    if os.name == "nt":
        return _win_alive(pid)
    try:
        os.kill(pid, 0)            # signal 0 = existence probe (POSIX only)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True                # exists, just not ours
    except (OSError, AttributeError):
        return _win_alive(pid)


def _win_alive(pid: int) -> bool:
    try:
        import ctypes
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        ERROR_ACCESS_DENIED = 5
        ERROR_INVALID_PARAMETER = 87   # no process with that pid
        k = ctypes.windll.kernel32
        h = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not h:
            # ⚠️ A null handle does NOT mean "dead". OpenProcess fails with ACCESS_DENIED for a
            # process that is very much alive (integrity/ACL); only INVALID_PARAMETER means the pid
            # is gone. Treating null as dead made the sidecar os._exit(0) mid-job on Windows — the
            # "claimed → running → vanishes, rc=0, no traceback" signature. Never self-kill on
            # uncertainty: only report dead on an explicit "no such process".
            err = ctypes.get_last_error() if hasattr(ctypes, "get_last_error") else k.GetLastError()
            if err == ERROR_INVALID_PARAMETER:
                return False
            return True                                # ACCESS_DENIED or anything ambiguous → alive
        try:
            code = ctypes.c_ulong()
            if k.GetExitCodeProcess(h, ctypes.byref(code)):
                return code.value == STILL_ACTIVE
            return True
        finally:
            k.CloseHandle(h)
    except Exception:
        return True                # can't tell → assume alive (never self-kill on uncertainty)


def _hard_exit(reason: Optional[str] = None) -> None:
    os._exit(0)


def _call_dead(dead: Callable, reason: str) -> None:
    """Invoke an on_dead callback whether it accepts a reason arg or not (back-compat)."""
    try:
        dead(reason)
    except TypeError:
        dead()


def watch_parent(pid: Optional[int], *, interval: float = 2.0, misses: int = 2,
                 on_dead: Optional[Callable] = None) -> Optional[threading.Thread]:
    """Poll `pid`; call on_dead when it stays gone for `misses` CONSECUTIVE polls. No-op (returns
    None) when pid is falsy. The debounce (default 2) means a single spurious probe — e.g. a
    transient OpenProcess failure on Windows — can't kill a healthy child mid-job; a real parent
    death is still caught within `misses*interval` seconds. Runs in a daemon thread."""
    if not pid:
        return None
    dead = on_dead or _hard_exit
    stop = threading.Event()

    def _loop() -> None:
        gone = 0
        while not stop.wait(interval):
            if parent_alive(pid):
                gone = 0
                continue
            gone += 1
            if gone >= misses:
                _call_dead(dead, "parent-pid-gone")
                return

    t = threading.Thread(target=_loop, daemon=True, name="parent-pid-watchdog")
    t.start()
    return t


def watch_stdin_eof(on_dead: Optional[Callable] = None) -> Optional[threading.Thread]:
    """Block on stdin in a daemon thread; call on_dead at EOF. This is how a child learns its
    parent closed the pipe (i.e. died), portably. No-op if stdin is unavailable."""
    try:
        buf = sys.stdin.buffer
    except (AttributeError, ValueError):
        return None
    if buf is None:
        return None
    dead = on_dead or _hard_exit

    def _loop() -> None:
        try:
            while buf.read(1):     # returns b'' only on EOF (parent gone); blocks otherwise
                pass
        except Exception:
            pass
        _call_dead(dead, "stdin-eof")

    t = threading.Thread(target=_loop, daemon=True, name="stdin-eof-watchdog")
    t.start()
    return t


def guard(*, parent_pid: Optional[int] = None, stdin_eof: bool = True,
          interval: float = 2.0, on_dead: Optional[Callable] = None) -> None:
    """Install the available death signals. Call once at startup from any tree child. `on_dead`
    may accept an optional reason string ('stdin-eof' | 'parent-pid-gone')."""
    if stdin_eof:
        watch_stdin_eof(on_dead=on_dead)
    watch_parent(parent_pid, interval=interval, on_dead=on_dead)
