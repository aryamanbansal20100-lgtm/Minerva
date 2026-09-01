#!/usr/bin/env python3
"""Minerva — notes for students.

    python run.py

Standard library only. Nothing to install.
"""

from __future__ import annotations

import os
import stat
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

TEMPLATE = """# Minerva. Copy of .env.example — keys live here, never in the browser.

# The one key that matters. Free, no card: https://console.groq.com/keys
# Turns on BOTH the note-writing brain and the class transcription.
GROQ_API_KEY=
# No GROQ_MODEL line on purpose. Groq retires model names without warning, and
# a name pinned here silently OVERRIDES the live model list in ai.py -- which is
# exactly how every request ended up answering
# "llama-3.3-70b-versatile does not exist". Left unset, the app asks Groq which
# models the key can actually use and picks a working one. Only set this if you
# deliberately want to force one specific model.
GROQ_STT_MODEL=whisper-large-v3-turbo

# Minutes per audio slice. Each slice is transcribed while the lesson runs,
# so a crash costs you this many minutes, not the hour.
EVIE_CHUNK_MINUTES=4

# Start/stop recording from anywhere, even with the browser minimised.
EVIE_HOTKEY=ctrl+alt+N

EVIE_HOST=127.0.0.1
EVIE_PORT=7400
"""


def ensure_env() -> None:
    env = ROOT / ".env"
    if not env.exists():
        env.write_text(TEMPLATE, encoding="utf-8")
        print("  created .env — add your free Groq key there")
    try:
        if os.name == "nt":
            user = os.environ.get("USERNAME", "")
            subprocess.run(["icacls", str(env), "/inheritance:r", "/grant:r",
                            f"{user}:F"], capture_output=True, check=False)
        else:
            env.chmod(stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        pass


def watch_and_restart() -> None:
    """Restart the server whenever a server file changes.

    Python loads a module once. Edit server code while it is running and the
    process keeps executing the old version from memory — silently, with no
    error and no warning. That cost a full day here: fix after fix landed on
    disk, every test passed because tests run in a fresh process, and the
    running app kept behaving exactly as it had the night before.

    A parent watching mtimes and restarting the child makes that impossible.
    Set EVIE_NO_RELOAD=1 to turn it off.
    """
    import time

    def stamps() -> dict:
        files = list((ROOT / "server").glob("*.py")) + [ROOT / "run.py"]
        return {f.name: f.stat().st_mtime for f in files if f.exists()}

    def spawn():
        return subprocess.Popen([sys.executable, str(ROOT / "run.py")],
                                env={**os.environ, "EVIE_CHILD": "1"})

    seen = stamps()
    child = spawn()
    try:
        while True:
            time.sleep(1.0)
            if child.poll() is not None:
                return
            now = stamps()
            # Never restart mid-request: a note takes the better part of a
            # minute to write, and killing that loses the lesson.
            busy_file = ROOT / "data" / ".busy"
            try:
                inflight = int(busy_file.read_text()) if busy_file.exists() else 0
            except (OSError, ValueError):
                inflight = 0
            if inflight > 0:
                continue
            if now != seen:
                changed = sorted(n for n in set(now) | set(seen)
                                 if seen.get(n) != now.get(n))
                print(f"\n  reloading — changed: {', '.join(changed)}")
                seen = now
                child.terminate()
                try:
                    child.wait(timeout=6)
                except subprocess.TimeoutExpired:
                    child.kill()
                child = spawn()
    except KeyboardInterrupt:
        child.terminate()
        print("\n  stopped\n")


def ensure_web_built() -> None:
    """Build the React app once if it has never been built.

    The whole point of this project is ONE command. The student runs
    `python run.py`; they never touch npm. So if the built app is missing, build
    it here — but never block startup on it: if npm is not installed or the build
    fails, the server still comes up on the vanilla UI. It is a convenience, not
    a requirement.
    """
    dist = ROOT / "web" / "dist" / "index.html"
    pkg = ROOT / "web" / "package.json"
    if dist.exists() or not pkg.exists():
        return
    npm = "npm.cmd" if os.name == "nt" else "npm"
    try:
        print("  first run — building the app (about a minute)…")
        if not (ROOT / "web" / "node_modules").exists():
            subprocess.run([npm, "install"], cwd=str(ROOT / "web"), check=True)
        subprocess.run([npm, "run", "build"], cwd=str(ROOT / "web"), check=True)
        print("  app built.")
    except (OSError, subprocess.CalledProcessError):
        print("  (could not build the React app — using the simple UI instead)")


def main() -> int:
    ensure_env()
    ensure_web_built()

    # The parent watches files; the child actually serves.
    if not os.environ.get("EVIE_CHILD") and not os.environ.get("EVIE_NO_RELOAD"):
        watch_and_restart()
        return 0

    from server import main as server

    try:
        server.serve()
    except KeyboardInterrupt:
        print("\n  stopped\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
