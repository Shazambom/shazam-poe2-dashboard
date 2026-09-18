import os, sys
pid = os.fork()
if pid == 0:
    os._exit(0)
os.waitpid(pid, 0)
sys.exit(0)
