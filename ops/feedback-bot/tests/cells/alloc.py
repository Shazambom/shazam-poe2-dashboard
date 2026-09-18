import sys
b = bytearray(2 * 1024 * 1024 * 1024)   # 2 GB
b[-1] = 1
sys.exit(0)
