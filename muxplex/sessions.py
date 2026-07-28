"""
tmux session enumeration and snapshot helpers for the tmux-web muxplex.

In-memory cache:
    _session_list  — most-recently-enumerated list of session names.
    _snapshots     — most-recently-captured pane text, keyed by session name.

Public API:
    get_session_list()                    → list[str]
    get_snapshots()                       → dict[str, str]
    update_session_cache(names, snapshots) → None
    run_tmux(*args)                       → str   (raises RuntimeError on nonzero exit)
    enumerate_sessions()                  → list[str]
    capture_pane(name, lines)             → str
    snapshot_all(names)                   → dict[str, str]
"""

import asyncio
import os

from muxplex.settings import load_settings

# ---------------------------------------------------------------------------
# In-memory cache
# ---------------------------------------------------------------------------

_session_list: list[str] = []
_snapshots: dict[str, str] = {}


def get_session_list() -> list[str]:
    """Return a copy of the cached session name list."""
    return list(_session_list)


def get_snapshots() -> dict[str, str]:
    """Return a copy of the cached pane-snapshot dict."""
    return dict(_snapshots)


def update_session_cache(names: list[str], snapshots: dict[str, str]) -> None:
    """Replace the in-memory caches with fresh data.

    Sets _session_list to *names* and _snapshots to the provided *snapshots* dict.
    Callers must pass the return value of snapshot_all() as *snapshots*.
    """
    global _session_list, _snapshots
    _session_list = list(names)
    _snapshots = snapshots


# ---------------------------------------------------------------------------
# Subprocess helpers
# ---------------------------------------------------------------------------


def tmux_env() -> dict[str, str] | None:
    """Build the environment for tmux subprocess calls, honoring `tmux_socket_dir`.

    A systemd/launchd service does NOT inherit the user's interactive login
    shell environment. If the user sets TMUX_TMPDIR in their shell rc (common
    when keeping sockets out of the shared, world-writable /tmp), the muxplex
    *service* process never sees it -- tmux silently falls back to its
    compiled-in default (/tmp/tmux-$UID) and every real session becomes
    invisible to muxplex, even though `tmux list-sessions` works fine when
    run interactively by the same user.

    Returns:
        None if `tmux_socket_dir` is unset/empty -- callers should pass
        `env=None` to the subprocess call, inheriting the process's own
        environment unchanged (fully backward compatible).
        Otherwise, a copy of `os.environ` with `TMUX_TMPDIR` overridden to
        the configured directory. Copying (not replacing) preserves PATH,
        HOME, and everything else the subprocess needs.

        Also removes `TMUX` from the returned environment. tmux gives `$TMUX`
        (set whenever a process is a descendant of an *attached* tmux client)
        priority over `TMUX_TMPDIR` when resolving which server socket to
        talk to -- if it were left in place, a muxplex process that happens
        to be a descendant of some other tmux client (e.g. started manually
        from inside a tmux pane while debugging) would silently ignore this
        override and keep talking to that other server. The muxplex *service*
        itself is never an attached tmux client, so this is a no-op in the
        normal (systemd/launchd) deployment -- it only matters for robustness
        in atypical invocation contexts.
    """
    tmpdir = load_settings().get("tmux_socket_dir", "")
    if not tmpdir:
        return None
    env = dict(os.environ)
    env["TMUX_TMPDIR"] = tmpdir
    env.pop("TMUX", None)
    return env


async def run_tmux(*args: str) -> str:
    """Run `tmux <args>` in a subprocess and return stdout as a string.

    Honors the `tmux_socket_dir` setting (see `tmux_env()`) so tmux looks in
    the configured socket directory instead of always defaulting to
    /tmp/tmux-$UID.

    Raises:
        RuntimeError: If the process exits with a nonzero return code.
                      The error message contains the decoded stderr output.
    """
    proc = await asyncio.create_subprocess_exec(
        "tmux",
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=tmux_env(),
    )
    stdout_bytes, stderr_bytes = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(stderr_bytes.decode("utf-8", errors="replace"))
    return stdout_bytes.decode("utf-8", errors="replace")


# ---------------------------------------------------------------------------
# Session enumeration
# ---------------------------------------------------------------------------


async def enumerate_sessions() -> list[str]:
    """Return the list of currently running tmux session names.

    Calls ``tmux list-sessions -F #{session_name}``, splits on newlines,
    and strips whitespace from each entry.

    Returns [] if tmux is not running (RuntimeError from run_tmux).
    """
    try:
        output = await run_tmux("list-sessions", "-F", "#{session_name}")
    except (RuntimeError, FileNotFoundError):
        return []

    names = [line.strip() for line in output.splitlines() if line.strip()]
    return names


# ---------------------------------------------------------------------------
# Pane capture
# ---------------------------------------------------------------------------


async def capture_pane(session_name: str, lines: int = 30) -> str:
    """Capture the last *lines* lines of output from *session_name*.

    Returns the captured text, or '' on any error.
    """
    try:
        return await run_tmux(
            "capture-pane",
            "-e",  # preserve ANSI escape sequences for color rendering
            "-p",
            "-t",
            session_name,
            "-S",
            f"-{lines}",
        )
    except RuntimeError:
        return ""


# ---------------------------------------------------------------------------
# Window enumeration (window-tree sidebar layer)
# ---------------------------------------------------------------------------

# Field separator for `tmux list-windows -F`. A tab cannot appear in a tmux
# window name, session name, or option value, so it is a safe delimiter.
_WINDOW_FIELD_SEP = "\t"
_WINDOW_FORMAT = _WINDOW_FIELD_SEP.join(
    [
        "#{session_name}",
        "#{window_index}",
        "#{window_name}",
        "#{window_active}",
        "#{@task}",  # user option; expands to '' when unset
        "#{@fstate}",  # fleet live state; '' when unset (see FLEET_STATES)
    ]
)

# Recognized fleet activity states, set on the tmux ``@fstate`` window option by
# the fleet-state hook (UserPromptSubmit→working, Stop→reply_ready,
# Notification→needs_attention). Anything else (including '') is treated as idle
# by the frontend. Kept here as the single source of truth for the vocabulary.
FLEET_STATES = ("working", "reply_ready", "needs_attention", "stale")


async def list_windows() -> dict[str, list[dict]]:
    """Return all tmux windows grouped by session name.

    Runs ``tmux list-windows -a -F <format>`` (one call, all sessions) and
    parses each tab-delimited line into a dict:
        {"index": int, "name": str, "active": bool, "task": str, "state": str}

    ``state`` is the window's live ``@fstate`` fleet option (see FLEET_STATES);
    '' when the hook has never fired for that window. Because it is read from
    the live tmux server it is naturally scoped to windows that actually exist
    (unlike the ~/.fleet/state/*.json files, which accumulate stale entries).

    Returns {} if tmux is not running (RuntimeError/FileNotFoundError).
    """
    try:
        output = await run_tmux("list-windows", "-a", "-F", _WINDOW_FORMAT)
    except (RuntimeError, FileNotFoundError):
        return {}

    windows: dict[str, list[dict]] = {}
    for line in output.splitlines():
        if not line:
            continue
        # maxsplit-limited on the leading fixed fields; @task and @fstate are the
        # trailing pair. @fstate is a controlled vocabulary with no tabs, so a
        # final split on the last separator cleanly isolates it even if @task
        # itself contained tabs.
        parts = line.split(_WINDOW_FIELD_SEP, 5)
        if len(parts) < 4:
            continue
        session_name, index_str, win_name, active_str = parts[:4]
        task = parts[4] if len(parts) > 4 else ""
        state = parts[5] if len(parts) > 5 else ""
        try:
            index = int(index_str)
        except ValueError:
            continue
        windows.setdefault(session_name, []).append(
            {
                "index": index,
                "name": win_name,
                "active": active_str == "1",
                "task": task,
                "state": state if state in FLEET_STATES else "",
            }
        )
    return windows


async def select_window(session_name: str, index: int) -> None:
    """Activate window *index* in *session_name* via ``tmux select-window``.

    Reuses run_tmux, so it honors the configured socket dir. Raises
    RuntimeError (from run_tmux) if the target does not exist.
    """
    await run_tmux("select-window", "-t", f"{session_name}:{index}")


async def snapshot_all(names: list[str]) -> dict[str, str]:
    """Capture all sessions concurrently and return a name→text mapping.

    Uses asyncio.gather with return_exceptions=True so that individual
    failures do not abort the whole batch.  Failed sessions map to ''.

    Note: this function does not mutate module state — it does not update the module cache.
    Callers are responsible for passing the result to update_session_cache.
    """
    if not names:
        return {}
    results = await asyncio.gather(
        *[capture_pane(name) for name in names],
        return_exceptions=True,
    )
    snapshots: dict[str, str] = {}
    for name, result in zip(names, results):
        if isinstance(result, BaseException):
            snapshots[name] = ""
        else:
            snapshots[name] = result
    return snapshots
