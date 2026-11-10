"""Run a command under a pseudo-terminal and script its input.

Usage: python3 -I pty-run.py '<json spec>'

The spec is {"file": path, "argv": [...], "steps": [...], "timeout": seconds}.
Steps run in order: {"expect": text} waits for text in the output since the
last match, {"send": hex} writes bytes, {"sleep": seconds} keeps reading for a
while.
Prints {"output": hex, "status": exit code or null, "timedOut": bool,
"pid": child pid} as JSON. The child is killed on timeout or on SIGTERM.
"""

import json
import os
import pty
import select
import signal
import sys
import time


def main():
    spec = json.loads(sys.argv[1])
    deadline = time.monotonic() + spec.get("timeout", 10)
    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.execv(spec["file"], spec["argv"])
        finally:
            os._exit(127)

    def kill(*_):
        try:
            os.killpg(pid, signal.SIGKILL)
        except OSError:
            pass

    signal.signal(signal.SIGTERM, lambda *a: (kill(), sys.exit(1)))
    output = bytearray()
    state = {"eof": False}

    def pump(seconds):
        if state["eof"]:
            return
        ready, _, _ = select.select([fd], [], [], max(0, seconds))
        if not ready:
            return
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            chunk = b""
        if chunk:
            output.extend(chunk)
        else:
            state["eof"] = True

    timed_out = False
    seen = 0
    try:
        for step in spec["steps"]:
            if "expect" in step:
                needle = step["expect"].encode()
                while output.find(needle, seen) < 0:
                    if state["eof"] or time.monotonic() > deadline:
                        raise TimeoutError(step["expect"])
                    pump(deadline - time.monotonic())
                seen = output.find(needle, seen) + len(needle)
            elif "send" in step:
                os.write(fd, bytes.fromhex(step["send"]))
            elif "sleep" in step:
                until = time.monotonic() + step["sleep"]
                while time.monotonic() < until and not state["eof"]:
                    pump(until - time.monotonic())
        while not state["eof"]:
            if time.monotonic() > deadline:
                raise TimeoutError("exit")
            pump(deadline - time.monotonic())
    except TimeoutError:
        timed_out = True
        kill()

    _, raw = os.waitpid(pid, 0)
    os.close(fd)
    status = os.waitstatus_to_exitcode(raw)
    print(json.dumps({
        "output": output.hex(),
        "status": None if timed_out else status,
        "timedOut": timed_out,
        "pid": pid,
    }))


main()
