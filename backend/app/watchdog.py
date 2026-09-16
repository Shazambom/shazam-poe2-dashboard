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
    try:
        os.kill(pid, 0)            # signal 0 = existence probe (POSIX)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True                # exists, just not ours
    except (OSError, AttributeError):
        # Windows os.kill can't probe with 0; fall back to a real handle check.
        return _win_alive(pid)


def _win_alive(pid: int) -> bool:
    try:
        import ctypes
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        k = ctypes.windll.kernel32
        h = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not h:
            return False
        try:
            code = ctypes.c_ulong()
            if k.GetExitCodeProcess(h, ctypes.byref(code)):
                return code.value == STILL_ACTIVE
            return True
        finally:
            k.CloseHandle(h)
    except Exception:
        return True                # can't tell → assume alive (never self-kill on uncertainty)


def _hard_exit() -> None:
    os._exit(0)


def watch_parent(pid: Optional[int], *, interval: float = 2.0,
                 on_dead: Optional[Callable[[], None]] = None) -> Optional[threading.Thread]:
    """Poll `pid`; call on_dead (default: hard-exit) when it vanishes. No-op (returns None) when
    pid is falsy. Runs in a daemon thread."""
    if not pid:
        return None
    dead = on_dead or _hard_exit
    stop = threading.Event()

    def _loop() -> None:
        while not stop.wait(interval):
            if not parent_alive(pid):
                dead()
                return

    t = threading.Thread(target=_loop, daemon=True, name="parent-pid-watchdog")
    t.start()
    return t


def watch_stdin_eof(on_dead: Optional[Callable[[], None]] = None) -> Optional[threading.Thread]:
    """Block on stdin in a daemon thread; call on_dead (default: hard-exit) at EOF. This is how a
    child learns its parent closed the pipe (i.e. died), portably. No-op if stdin is unavailable."""
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
        dead()

    t = threading.Thread(target=_loop, daemon=True, name="stdin-eof-watchdog")
    t.start()
    return t


def guard(*, parent_pid: Optional[int] = None, stdin_eof: bool = True,
          interval: float = 2.0, on_dead: Optional[Callable[[], None]] = None) -> None:
    """Install the available death signals. Call once at startup from any tree child."""
    if stdin_eof:
        watch_stdin_eof(on_dead=on_dead)
    watch_parent(parent_pid, interval=interval, on_dead=on_dead)
