"""Desktop entrypoint: run the API on localhost for the Electron shell, or act as the
heavy-analytics sidecar when invoked with ``--sidecar`` (reusing the same frozen Python +
NumPy runtime so the installer ships one binary instead of two).

PyInstaller bundles this as a single binary; DATA_DIR and PORT come from the
shell so state lives in the user's app-data directory.
"""

import os
import sys

if len(sys.argv) > 1 and sys.argv[1] == "--sidecar":
    # Dispatch BEFORE importing uvicorn/FastAPI/cryptography so the sidecar child stays lean.
    from sidecar.run_sidecar import main as _sidecar_main

    raise SystemExit(_sidecar_main(sys.argv[2:]))

import uvicorn

# The desktop backend answers only its own app on loopback (app/main.py `loopback_only`).
os.environ.setdefault("ARBITER_LOOPBACK_ONLY", "1")

from app import accesslog
from app.main import app

if __name__ == "__main__":
    accesslog.install()  # successful polls stay out of the log a problem report carries
    uvicorn.run(
        app, host="127.0.0.1", port=int(os.environ.get("PORT", 8210)), log_level="info"
    )
