"""Print one macOS process's argv and environment as JSON.

Usage: procargs.py PID

macOS has no /proc, so this reads sysctl KERN_PROCARGS2: argc, the
executable path and its NUL padding, then argv and the environment, which ends
at the first empty string.
"""

import ctypes
import json
import os
import sys

CTL_KERN, KERN_ARGMAX, KERN_PROCARGS2 = 1, 8, 49

libc = ctypes.CDLL(None, use_errno=True)
# Without a prototype the call succeeds on macOS arm64 but leaves the buffer empty.
libc.sysctl.argtypes = [
    ctypes.POINTER(ctypes.c_int), ctypes.c_uint, ctypes.c_void_p,
    ctypes.POINTER(ctypes.c_size_t), ctypes.c_void_p, ctypes.c_size_t,
]


def sysctl(mib, buffer):
    """Fills buffer and returns how many bytes were written."""
    size = ctypes.c_size_t(ctypes.sizeof(buffer))
    names = (ctypes.c_int * len(mib))(*mib)
    if libc.sysctl(names, len(mib), ctypes.byref(buffer), ctypes.byref(size), None, 0) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    return size.value


def main():
    pid = int(sys.argv[1])
    argmax = ctypes.c_int()
    sysctl([CTL_KERN, KERN_ARGMAX], argmax)
    buffer = ctypes.create_string_buffer(argmax.value)
    raw = buffer.raw[:sysctl([CTL_KERN, KERN_PROCARGS2, pid], buffer)]
    argc = int.from_bytes(raw[:4], sys.byteorder)
    fields = raw[4:].decode("utf-8", "surrogateescape").split("\0")
    start = next((index for index in range(1, len(fields)) if fields[index]), None)
    if start is None:
        sys.exit(f"no arguments for pid {pid}: argc {argc}, {len(raw)} bytes, executable {fields[0]!r}")
    argv = fields[start:start + argc]
    rest = fields[start + argc:]
    environ = rest[:rest.index("")] if "" in rest else rest
    json.dump({"cmdline": argv, "environ": environ}, sys.stdout)


if __name__ == "__main__":
    main()
