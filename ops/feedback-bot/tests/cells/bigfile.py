import sys
with open(sys.argv[2] + "-big", "wb") as f:
    f.write(b"\0" * (100 * 1024 * 1024))
sys.exit(0)
