"""Desktop entrypoint: run the API on localhost for the Electron shell.

PyInstaller bundles this as a single binary; DATA_DIR and PORT come from the
shell so state lives in the user's app-data directory.
"""
import os

import uvicorn

from app.main import app

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT", 8210)), log_level="info")
