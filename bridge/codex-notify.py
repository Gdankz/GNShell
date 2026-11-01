#!/usr/bin/env python3
"""Codex notify hook -> existing GNOME notification service. No message storage."""
import json
import shutil
import subprocess
import sys
from pathlib import Path


def command(payload, show_project=False):
    if not isinstance(payload, dict) or payload.get("type") != "agent-turn-complete":
        return None
    body = "Satu giliran Codex telah selesai."
    cwd = payload.get("cwd")
    if show_project and isinstance(cwd, str) and cwd:
        project = "".join(c for c in Path(cwd).name if c.isprintable())[:80]
        body = f"Proyek: {project}" if project else body
    return ["notify-send", "--app-name=Islet Codex", "--icon=utilities-terminal",
            "--urgency=normal", "--", "Codex selesai", body]


def main():
    args = sys.argv[1:]
    show_project = "--show-project" in args
    if show_project:
        args.remove("--show-project")
    if len(args) != 1 or len(args[0]) > 1_048_576:
        return 2
    try:
        argv = command(json.loads(args[0]), show_project)
    except (ValueError, TypeError):
        return 2
    if argv is None:
        return 0
    if not shutil.which("notify-send"):
        return 127
    try:
        return subprocess.run(argv, check=False, timeout=5).returncode
    except (OSError, subprocess.TimeoutExpired):
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
