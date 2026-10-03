"""Desktop entrypoint: run the API on localhost for the Electron shell.

PyInstaller bundles this as a single binary; DATA_DIR and PORT come from the
shell so state lives in the user's app-data directory.
"""
import os

import uvicorn

# The desktop backend answers only its own app on loopback (app/main.py `loopback_only`).
os.environ.setdefault("ARBITER_LOOPBACK_ONLY", "1")

from app import accesslog  # noqa: E402
from app.main import app  # noqa: E402

if __name__ == "__main__":
    accesslog.install()   # successful polls stay out of the log a problem report carries
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT", 8210)), log_level="info")
