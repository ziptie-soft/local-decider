"""Launch the managed strands-decider entry point with a descriptive process title."""

from importlib.metadata import entry_points
import sys


def main() -> int:
    args = sys.argv[1:]
    if len(args) < 3 or args[0] != "--title" or args[2] != "--":
        raise SystemExit("usage: launch.py --title TITLE -- <strands-decider args>")
    title = args[1]
    serve_args = args[3:]
    try:
        from setproctitle import setproctitle

        setproctitle(title)
    except ImportError:
        pass
    matches = entry_points(group="console_scripts", name="strands-decider")
    if not matches:
        raise SystemExit("strands-decider console entry point is missing from this venv")
    sys.argv = ["strands-decider", *serve_args]
    return int(matches[0].load()() or 0)


if __name__ == "__main__":
    sys.exit(main())
