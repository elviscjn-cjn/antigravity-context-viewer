#!/usr/bin/env python3
"""Compatibility entry point. Keep the release manifest in package-release.js."""
import subprocess
import sys
from pathlib import Path

if __name__ == "__main__":
    script = Path(__file__).resolve().with_suffix(".js")
    sys.exit(subprocess.call(["node", str(script), *sys.argv[1:]], cwd=script.parent.parent))
