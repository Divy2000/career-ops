#!/usr/bin/env python3
"""Runs a command under a real pseudo-terminal and answers its prompts.

usage: pty_run.py '<json list of {"expect": regex, "send": text}>' -- cmd [args...]
Prints everything the command wrote to the terminal; exits with the command's status.
Deterministic: each answer is sent only after its prompt text has appeared, never on a timer.
"""
import json, os, pty, re, select, sys, time

steps = json.loads(sys.argv[1])
cmd = sys.argv[sys.argv.index('--') + 1:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
buf = b''
out = b''
deadline = time.time() + 120
i = 0
status = None
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 0.2)
    if r:
        try:
            data = os.read(fd, 4096)
        except OSError:
            data = b''
        if not data:
            break
        out += data
        buf += data
        while i < len(steps) and re.search(steps[i]['expect'].encode(), buf):
            os.write(fd, steps[i]['send'].encode())
            buf = b''
            i += 1
_, st = os.waitpid(pid, 0)
sys.stdout.write(out.decode('utf-8', 'replace'))
sys.exit(os.waitstatus_to_exitcode(st))
