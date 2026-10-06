#!/usr/bin/env python3
"""Runs a command under a real pseudo-terminal and answers its prompts.

usage: pty_run.py '<json list of {"expect": regex, "send": text}>' -- cmd [args...]
Prints everything the command wrote to the terminal; exits with the command's status.
Deterministic: each answer is sent only after its prompt text has appeared, never on a timer.
Fails (exit 1, reason on stderr) when a prompt never appeared, and kills the command and fails when it is
still running after PTY_RUN_TIMEOUT seconds (default 120).
"""
import json, os, pty, re, select, signal, sys, time

steps = json.loads(sys.argv[1])
cmd = sys.argv[sys.argv.index('--') + 1:]
timeout = float(os.environ.get('PTY_RUN_TIMEOUT', '120'))
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
buf = b''
out = b''
deadline = time.time() + timeout
i = 0
timed_out = True
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 0.2)
    if r:
        try:
            data = os.read(fd, 4096)
        except OSError:
            data = b''
        if not data:
            timed_out = False
            break
        out += data
        buf += data
        while i < len(steps) and re.search(steps[i]['expect'].encode(), buf):
            os.write(fd, steps[i]['send'].encode())
            buf = b''
            i += 1
if timed_out:
    os.kill(pid, signal.SIGKILL)
_, st = os.waitpid(pid, 0)
sys.stdout.write(out.decode('utf-8', 'replace'))
sys.stdout.flush()
if timed_out:
    sys.stderr.write(f'pty_run: timed out after {timeout:g} s; killed the command\n')
    sys.exit(1)
if i < len(steps):
    sys.stderr.write(f"pty_run: prompt never appeared: {steps[i]['expect']}\n")
    sys.exit(1)
# os.waitstatus_to_exitcode needs Python 3.9.
if os.WIFSIGNALED(st):
    sys.exit(128 + os.WTERMSIG(st))
sys.exit(os.WEXITSTATUS(st))
