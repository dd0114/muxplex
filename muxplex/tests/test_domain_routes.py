"""
Tests for the session-domain route: GET /<session_name>.

URL domain separation — opening /<session_name> for a live tmux session serves
the dashboard index (the frontend reads location.pathname and filters to that
session), unknown names return 404, and all fixed routes (/, /login, /health,
/api/*, static assets) keep priority / keep working.
"""

import pytest
from fastapi.testclient import TestClient

from muxplex.main import app


# ---------------------------------------------------------------------------
# autouse fixture — redirect state/PID files, mock startup side-effects
# (mirrors test_main.py / test_api.py setup)
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def patch_startup_and_state(tmp_path, monkeypatch):
    """Redirect state/PID files to tmp_path, mock kill_orphan_ttyd, no-op poll loop."""
    tmp_state_dir = tmp_path / "state"
    tmp_state_path = tmp_state_dir / "state.json"
    monkeypatch.setattr("muxplex.state.STATE_DIR", tmp_state_dir)
    monkeypatch.setattr("muxplex.state.STATE_PATH", tmp_state_path)

    tmp_pid_dir = tmp_path / "ttyd"
    tmp_pid_path = tmp_pid_dir / "ttyd.pid"
    monkeypatch.setattr("muxplex.ttyd.TTYD_PID_DIR", tmp_pid_dir)
    monkeypatch.setattr("muxplex.ttyd.TTYD_PID_PATH", tmp_pid_path)

    async def _mock_kill_orphan():
        return False

    monkeypatch.setattr("muxplex.main.kill_orphan_ttyd", _mock_kill_orphan)

    async def noop_poll_loop() -> None:
        pass

    monkeypatch.setattr("muxplex.main._poll_loop", noop_poll_loop)


@pytest.fixture(autouse=True)
def mock_session_list(monkeypatch):
    """Pretend two live tmux sessions exist: sidekick, hmb."""
    monkeypatch.setattr(
        "muxplex.main.get_session_list", lambda: ["sidekick", "hmb"]
    )


@pytest.fixture
def client(monkeypatch):
    """Authenticated TestClient with the app lifespan active."""
    monkeypatch.setenv("MUXPLEX_PASSWORD", "test-password")
    with TestClient(app) as c:
        from muxplex.auth import create_session_cookie
        from muxplex.main import _auth_secret, _auth_ttl

        cookie = create_session_cookie(_auth_secret, _auth_ttl)
        c.cookies.set("muxplex_session", cookie)
        yield c


# ---------------------------------------------------------------------------
# GET /<live-session> serves the dashboard index
# ---------------------------------------------------------------------------


def test_live_session_name_serves_index(client):
    """GET /sidekick (live session) must return the dashboard index HTML."""
    resp = client.get("/sidekick")
    assert resp.status_code == 200, f"GET /sidekick returned {resp.status_code}"
    assert "text/html" in resp.headers["content-type"]
    # Same page as / — the app shell with the muxplex title and app.js.
    assert "muxplex</title>" in resp.text
    assert "/app.js" in resp.text


def test_live_session_index_has_cache_busted_assets(client):
    """The index served at /<session> carries the same ?v= tokens as /."""
    root_html = client.get("/").text
    session_html = client.get("/hmb").text
    assert session_html == root_html, (
        "GET /<session> must serve byte-identical index HTML to GET /"
    )


# ---------------------------------------------------------------------------
# Unknown session name → 404
# ---------------------------------------------------------------------------


def test_unknown_session_name_404(client):
    resp = client.get("/no-such-session")
    assert resp.status_code == 404, (
        f"GET /no-such-session returned {resp.status_code}, expected 404"
    )


# ---------------------------------------------------------------------------
# Fixed routes keep priority (no regression)
# ---------------------------------------------------------------------------


def test_health_unaffected(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_login_page_unaffected(client):
    resp = client.get("/login")
    assert resp.status_code == 200
    assert "Sign in" in resp.text


def test_api_routes_unaffected(client):
    resp = client.get("/api/state")
    assert resp.status_code == 200


def test_root_still_serves_index(client):
    resp = client.get("/")
    assert resp.status_code == 200
    assert "muxplex</title>" in resp.text


# ---------------------------------------------------------------------------
# Single-segment static assets still resolve (route must fall through)
# ---------------------------------------------------------------------------


def test_single_segment_static_assets_still_served(client):
    """/app.js, /style.css, /manifest.json are single-segment GETs that must
    NOT be swallowed by the /{session_name} route."""
    for path in ("/app.js", "/style.css", "/manifest.json", "/favicon.ico"):
        resp = client.get(path)
        assert resp.status_code == 200, (
            f"GET {path} returned {resp.status_code}, expected 200"
        )


def test_static_asset_wins_over_session_name_collision(client, monkeypatch):
    """If a tmux session is named like a real static file, the file wins
    (documented precedence: assets > session names)."""
    monkeypatch.setattr(
        "muxplex.main.get_session_list", lambda: ["app.js", "sidekick"]
    )
    resp = client.get("/app.js")
    assert resp.status_code == 200
    assert "javascript" in resp.headers["content-type"]


def test_path_traversal_not_served(client):
    """A traversal-looking name must not leak files outside the frontend dir."""
    resp = client.get("/%2e%2e%2fpyproject.toml")
    assert resp.status_code in (404, 400)
