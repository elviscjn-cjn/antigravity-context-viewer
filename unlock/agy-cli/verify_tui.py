#!/usr/bin/env python3
"""Black-box acceptance test for the agy Context selector.

Drives the real TUI in a pseudo-terminal, opens /model, presses Tab and records
which Context chip is highlighted at each step. This is the check that proves
the patch actually reached the UI layer, not just the byte layer.

    python3 verify_tui.py --binary ~/.local/bin/agy --model gemini-3.8-flash-high

Expected on a patched binary for ANY model:
    open   -> Default
    tab x1 -> 256K
    tab x2 -> 512K

Expected on an unpatched binary for a non-whitelisted model:
    the "Context" row never appears at all.

Requires pexpect. Presses Esc and Ctrl-C to leave the TUI.
"""

import argparse
import os
import re
import sys
import time

try:
    import pexpect
except ImportError:
    sys.exit("pexpect is required: python3 -m pip install pexpect")

ANSI = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\x1b[=>]")
CHIP = re.compile(r"\[(Default|256K|512K|900K)\]")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--binary", default=os.path.expanduser("~/.local/bin/agy"))
    ap.add_argument("--model", default="gemini-3.8-flash-high",
                    help="any model works; use one outside the whitelist to test the patch")
    ap.add_argument("--tabs", type=int, default=2)
    ap.add_argument("--rows", type=int, default=40)
    ap.add_argument("--cols", type=int, default=120)
    ap.add_argument("--wait", type=float, default=15.0, help="startup settle time")
    args = ap.parse_args()

    env = dict(os.environ)
    env.setdefault("TERM", "xterm-256color")
    cwd = os.path.dirname(os.path.abspath(args.binary)) or "."

    child = pexpect.spawn(args.binary, ["--model", args.model], cwd=cwd,
                          dimensions=(args.rows, args.cols), encoding="utf-8",
                          codec_errors="replace", timeout=30, env=env)
    buf = []

    def drain(seconds):
        end = time.time() + seconds
        while time.time() < end:
            try:
                buf.append(child.read_nonblocking(size=40000, timeout=0.3))
            except pexpect.TIMEOUT:
                pass
            except pexpect.EOF:
                return

    def screen():
        return ANSI.sub("", "".join(buf))

    def chips():
        found = CHIP.findall(screen())
        return found[-1] if found else None

    def menu_open():
        return "Keyboard:" in screen()

    def wait_for(predicate, timeout, step=0.5):
        end = time.time() + timeout
        while time.time() < end:
            if predicate():
                return True
            drain(step)
        return predicate()

    try:
        # Wait for the input box instead of guessing a startup duration:
        # keystrokes sent before the TUI is ready are simply lost.
        if not wait_for(lambda: "? for shortcuts" in screen(), args.wait):
            print("FAIL: TUI never became ready (check auth / permissions)")
            print("hint: raise --wait, or run agy manually once to warm it up")
            return 1

        child.send("/model")
        drain(1.5)
        child.send("\r")

        if not wait_for(menu_open, 10):
            print("FAIL: /model menu did not open")
            return 1
        drain(1.0)

        steps = [("open", chips())]
        for i in range(args.tabs):
            child.send("\t")
            drain(1.2)
            steps.append((f"tab x{i + 1}", chips()))
    finally:
        try:
            child.send("\x1b"); drain(0.3); child.send("\x03"); drain(0.3)
        except Exception:
            pass
        child.close(force=True)

    for label, chip in steps:
        print(f"  {label:<9} -> [{chip}]" if chip else f"  {label:<9} -> (no Context row)")

    first = steps[0][1]
    if first is None:
        print("\nRESULT: Context row absent. Either unpatched, or the model is "
              "outside the whitelist and offersContextWindow still returns false.")
        return 2
    if len(steps) > 1 and steps[1][1] == first:
        print("\nRESULT: row rendered but Tab did not move the selection.")
        return 3
    print("\nRESULT: OK - Context row rendered and Tab cycles it.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
