"""Run one command under a 120x40 pseudo-terminal for the tests.

Usage: pty_driver.py --output FILE --cwd DIR -- COMMAND...

The command inherits this process's environment. Everything it writes to the
terminal is appended, raw, to FILE. Control is line-delimited JSON:

stdout: {"pid": N} once the command starts, then {"exit": CODE} when it ends
        (CODE is negative for a signal, as in subprocess).
stdin:  {"write": "<base64 bytes>"} sends input to the terminal. EOF,
        SIGTERM, SIGINT or SIGHUP stop the command's process group (SIGTERM,
        then SIGKILL) and end the driver.
"""

import argparse
import base64
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


def emit(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def exit_code(status):
    if os.WIFSIGNALED(status):
        return -os.WTERMSIG(status)
    return os.WEXITSTATUS(status)


def signal_group(pid, sig):
    try:
        os.killpg(pid, sig)
    except ProcessLookupError:
        pass


def reap(pid, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            done, status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            return None
        if done:
            return status
        time.sleep(0.05)
    return None


def stop(pid):
    signal_group(pid, signal.SIGTERM)
    status = reap(pid, 3)
    # The group may outlive its leader, so always finish it off.
    signal_group(pid, signal.SIGKILL)
    if status is None:
        status = reap(pid, 3)
    return status


def drain(master, output):
    # Output written just before the command exited is still buffered.
    while select.select([master], [], [], 0)[0]:
        try:
            data = os.read(master, 65536)
        except OSError:
            return
        if not data:
            return
        output.write(data)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--cwd", required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("missing command")

    pid, master = pty.fork()
    if pid == 0:
        try:
            fcntl.ioctl(sys.stdin.fileno(), termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
            os.chdir(args.cwd)
            os.execvp(command[0], command)
        finally:
            os._exit(127)

    stopping = []

    def request_stop(_signum, _frame):
        stopping.append(True)

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, request_stop)

    emit({"pid": pid})
    output = open(args.output, "ab", buffering=0)
    control = sys.stdin.buffer
    pending = b""
    status = None
    try:
        while not stopping:
            try:
                ready, _, _ = select.select([master, control], [], [], 0.1)
            except InterruptedError:
                continue
            if master in ready:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    data = b""
                if not data:
                    break
                output.write(data)
            if control in ready:
                chunk = os.read(control.fileno(), 65536)
                if not chunk:
                    break
                pending += chunk
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    if line.strip():
                        os.write(master, base64.b64decode(json.loads(line)["write"]))
            done, raw = os.waitpid(pid, os.WNOHANG)
            if done:
                status = raw
                break
    finally:
        final = stop(pid)
        status = status if status is not None else final
        drain(master, output)
        output.close()
        os.close(master)
        emit({"exit": exit_code(status) if status is not None else None})


if __name__ == "__main__":
    main()
