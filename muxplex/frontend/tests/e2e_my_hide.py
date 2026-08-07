"""Manual e2e regression for the /my curation page hide flows (DONE4 bug).

Not collected by pytest (no test_ prefix) — it needs a LIVE muxplex on
127.0.0.1:8088 plus Playwright chromium, so it can't run in the normal suite
(conftest refuses live hosts). Run by hand after a deploy:

    python3 muxplex/frontend/tests/e2e_my_hide.py

Covers the two hide affordances on /my:
  1. the × button on a tile → tile disappears + localStorage written
  2. the ⋮ flyout "Hide" → same page-local hide, NO server-settings PATCH
     (the original bug: flyout ran the server hide, which is invisible on /my
     and silently polluted hidden_sessions on the normal dashboard)

Exit code 0 = all pass. Restores localStorage state via fresh browser context;
never mutates server settings.
"""
import json
import sys
import urllib.request

from playwright.sync_api import sync_playwright

BASE = "http://localhost:8088"


def server_hidden():
    with urllib.request.urlopen(BASE + "/api/settings") as r:
        return json.load(r)["hidden_sessions"]


def open_dashboard(pg):
    pg.goto(BASE + "/my", wait_until="networkidle")
    pg.wait_for_timeout(2500)  # first poll renders sessions
    back = pg.locator("#back-btn")
    if back.count() and back.is_visible():  # restored into fullscreen view
        back.click()
        pg.wait_for_timeout(600)


def main():
    failures = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        # --- 1. × button hide ---
        pg = browser.new_context().new_page()
        open_dashboard(pg)
        tiles = pg.locator("#session-grid .session-tile").count()
        if tiles == 0:
            print("SKIP: no live sessions to test against")
            return 0
        btn = pg.locator("#session-grid .curation-hide-btn").first
        key = btn.get_attribute("data-session-key")
        btn.click()
        pg.wait_for_timeout(500)
        store = json.loads(pg.evaluate("localStorage.getItem('muxplexCurationHidden')") or "[]")
        after = pg.locator("#session-grid .session-tile").count()
        pg.wait_for_timeout(3500)  # must survive the next poll re-render
        after_poll = pg.locator("#session-grid .session-tile").count()
        ok = key in store and after == tiles - 1 and after_poll == after
        print(f"[x-button] key={key} tiles {tiles}->{after} (poll {after_poll}) store={store} -> {'PASS' if ok else 'FAIL'}")
        if not ok:
            failures.append("x-button hide")

        # --- 2. flyout ⋮ Hide is page-local, no server PATCH ---
        hidden_before = server_hidden()
        pg = browser.new_context().new_page()
        open_dashboard(pg)
        tiles = pg.locator("#session-grid .session-tile").count()
        pg.locator("#session-grid .tile-options-btn").first.click()
        pg.wait_for_timeout(400)
        menu_actions = pg.evaluate(
            "Array.from(document.querySelectorAll('.flyout-menu [data-action]')).map(el => el.dataset.action)"
        )
        if "hide" in menu_actions or "curation-hide" not in menu_actions:
            print(f"[flyout] FAIL: menu actions on /my = {menu_actions}")
            failures.append("flyout menu contents")
        else:
            pg.locator('.flyout-menu [data-action="curation-hide"]').click()
            pg.wait_for_timeout(800)
            after = pg.locator("#session-grid .session-tile").count()
            store = json.loads(pg.evaluate("localStorage.getItem('muxplexCurationHidden')") or "[]")
            hidden_after = server_hidden()
            ok = after == tiles - 1 and len(store) == 1 and hidden_after == hidden_before
            print(f"[flyout] tiles {tiles}->{after} store={store} server_hidden unchanged={hidden_after == hidden_before} -> {'PASS' if ok else 'FAIL'}")
            if not ok:
                failures.append("flyout curation-hide")

        browser.close()
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
