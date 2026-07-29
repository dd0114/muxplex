"""
Tests for the cache-busting version suffix on static asset URLs served by index_page().

Verifies that GET / (the main dashboard) injects ?v=<content-hash> on every
<script src="…"> and <link href="…"> URL so browsers pick up new code
immediately whenever an asset's content changes — not only on a package
version bump — rather than serving stale JS/CSS from the HTTP cache.
"""

import hashlib
import importlib.metadata
import re

import pytest
from bs4 import BeautifulSoup
from fastapi.testclient import TestClient

from muxplex.main import _FRONTEND_DIR, _UI_VERSION, _asset_version, app

# Content-hash tokens are the first 12 hex chars of a sha256 digest.
_HASH_RE = re.compile(r"^[0-9a-f]{12}$")


def _query_token(url: str) -> str:
    """Return the ?v=<token> value from a URL, or '' if absent."""
    if "?v=" not in url:
        return ""
    return url.split("?v=", 1)[1]


# ---------------------------------------------------------------------------
# Shared fixtures (mirror test_api.py setup so tests run cleanly in isolation)
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def patch_startup_and_state(tmp_path, monkeypatch):
    """Redirect state/PID files to tmp_path and stub out long-running startup tasks."""
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
def reset_federation_cache():
    """Clear _federation_cache before and after each test."""
    import muxplex.main as main_mod

    main_mod._federation_cache.clear()
    yield
    main_mod._federation_cache.clear()


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
# Helpers
# ---------------------------------------------------------------------------


def _get_index_soup(client) -> BeautifulSoup:
    response = client.get("/")
    assert response.status_code == 200, f"GET / returned {response.status_code}"
    return BeautifulSoup(response.text, "html.parser")


# ---------------------------------------------------------------------------
# Test 1 — every script src and link href carries the version suffix
# ---------------------------------------------------------------------------


def test_index_all_asset_urls_have_version_suffix(client):
    """GET / must inject a ?v=<content-hash> token on every asset URL.

    Regression guard for the "is the user seeing stale JS?" investigation:
    verifies that the standard HTTP cache is busted whenever an asset changes
    by appending a content-hash query parameter to each static asset reference.
    """
    soup = _get_index_soup(client)

    # All <script src="…"> tags
    script_tags = soup.find_all("script", src=True)
    assert len(script_tags) >= 7, (
        f"Expected at least 7 <script src> tags, found {len(script_tags)}"
    )
    for tag in script_tags:
        token = _query_token(tag["src"])
        assert _HASH_RE.match(token), (
            f"<script src> missing content-hash ?v= token: {tag['src']!r}"
        )

    # All <link href="…"> tags
    link_tags = soup.find_all("link", href=True)
    assert len(link_tags) >= 1, "Expected at least one <link href> tag"
    for tag in link_tags:
        token = _query_token(tag["href"])
        assert _HASH_RE.match(token), (
            f"<link href> missing content-hash ?v= token: {tag['href']!r}"
        )


# ---------------------------------------------------------------------------
# Test 2 — vendor scripts are individually versioned (not just app.js)
# ---------------------------------------------------------------------------


def test_index_vendor_scripts_each_versioned(client):
    """All five vendor JS bundles must carry a content-hash token, not just app.js.

    The browser-tester on spark-1 observed bare vendor URLs.  This test
    ensures that xterm.js and its addons are cache-busted alongside the
    first-party scripts.
    """
    soup = _get_index_soup(client)

    script_srcs = [tag["src"] for tag in soup.find_all("script", src=True)]
    # Map bare path -> token for every versioned script.
    by_path = {}
    for src in script_srcs:
        path = src.split("?v=", 1)[0]
        by_path[path] = _query_token(src)

    expected_paths = [
        "/vendor/xterm.js",
        "/vendor/xterm-addon-fit.js",
        "/vendor/xterm-addon-web-links.js",
        "/vendor/xterm-addon-search.js",
        "/vendor/addon-image.js",
        "/app.js",
        "/terminal.js",
    ]
    for path in expected_paths:
        assert path in by_path, f"Expected script {path!r}; found srcs: {script_srcs}"
        assert _HASH_RE.match(by_path[path]), (
            f"Script {path!r} missing content-hash token: {by_path[path]!r}"
        )


def test_asset_version_is_content_hash_and_distinct_per_file(client):
    """_asset_version returns the sha256[:12] of the file content, so two files
    with different content get different tokens and it is not the package version."""
    from muxplex import main as main_mod

    main_mod._ASSET_VERSION_CACHE.clear()

    app_token = _asset_version("/app.js")
    css_token = _asset_version("/style.css")

    expected_app = hashlib.sha256((_FRONTEND_DIR / "app.js").read_bytes()).hexdigest()[:12]
    assert app_token == expected_app, "app.js token must be sha256[:12] of its bytes"
    assert app_token != css_token, "distinct files must get distinct cache-busting tokens"
    # The whole point of the fix: the token is NOT the (static) package version.
    assert app_token != _UI_VERSION


def test_asset_version_falls_back_to_package_version_for_unresolvable(client):
    """A URL that does not map to a real file under the frontend dir (incl. a
    path-traversal attempt) falls back to the package version rather than 500."""
    from muxplex import main as main_mod

    main_mod._ASSET_VERSION_CACHE.clear()
    assert _asset_version("/does-not-exist.js") == _UI_VERSION
    assert _asset_version("/../../etc/passwd") == _UI_VERSION


# ---------------------------------------------------------------------------
# Test 3 — versioned asset URLs still resolve to the actual static files
# ---------------------------------------------------------------------------


def test_versioned_asset_url_resolves_to_static_file(client):
    """GET /app.js?v=<version> must return HTTP 200 (static handler ignores query string).

    Sanity check: adding the version suffix must not break asset loading.
    Starlette's StaticFiles handler ignores query parameters when looking up
    files on disk, so the versioned URL must serve identically to the bare URL.
    """
    version = importlib.metadata.version("muxplex")

    # First-party assets
    for path in ("/app.js", "/terminal.js", "/style.css"):
        url = f"{path}?v={version}"
        resp = client.get(url)
        assert resp.status_code == 200, (
            f"Versioned URL {url!r} returned {resp.status_code}, expected 200"
        )

    # Vendor asset
    vendor_url = f"/vendor/xterm.js?v={version}"
    resp = client.get(vendor_url)
    assert resp.status_code == 200, (
        f"Versioned vendor URL {vendor_url!r} returned {resp.status_code}, expected 200"
    )
