"""Sidecar entrypoint: the heavy-analytics runtime the backend spawns as its child.

PyInstaller bundles this as a second single binary (numpy/stumpy). It reads market.sqlite from
DATA_DIR (RO/RW on the disposable market DB), never opens a socket, and dies with the backend
(ARBITER_PARENT_PID + stdin-EOF). See docs/db-architecture.md "Heavy analytics".
"""
import sys
from pathlib import Path

# When frozen, `app`/`sidecar` are on the bundle path; in dev, add backend/ so both import.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sidecar import runner  # noqa: E402

if __name__ == "__main__":
    runner.main()
