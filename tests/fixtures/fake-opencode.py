"""Stands in for OpenCode after a wake.

Switches the terminal to raw mode, prints @@READY@@, then reads its input
until it sees the probe byte "Z" (or 3 s pass) and prints
@@RESULT@@<json>@@END@@ with its arguments, every input byte it got (as
latin-1 text), and whether the NAP_TEST_MARK sentinel was preserved.
"""

import json
import os
import select
import sys
import termios
import time
import tty

# TCSANOW keeps any input already queued, so leaked wake bytes show up.
tty.setraw(0, termios.TCSANOW)
os.write(1, b"@@READY@@")
got = bytearray()
deadline = time.monotonic() + 3
while b"Z" not in got and time.monotonic() < deadline:
    ready, _, _ = select.select([0], [], [], deadline - time.monotonic())
    if ready:
        chunk = os.read(0, 256)
        if not chunk:
            break
        got.extend(chunk)
result = {
    "argv": sys.argv[1:],
    "stdin": got.decode("latin1"),
    "markKept": os.environ.get("NAP_TEST_MARK") == "nap-test-mark",
}
os.write(1, b"@@RESULT@@" + json.dumps(result).encode() + b"@@END@@")
