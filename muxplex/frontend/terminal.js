// Phase 2b implementation — terminal.js
// xterm.js Terminal + FitAddon initialization (task-12)

// ─── Module-level state ───────────────────────────────────────────────────────
let _term = null;
let _fitAddon = null;
let _ws = null;
let _reconnectTimer = null;
let _currentSession = null;
let _vpHandler = null;
let _reconnectAttempts = 0; // tracks consecutive failed reconnect attempts for backoff + ttyd respawn
let _searchAddon = null;
let _resizeObserver = null;

// ─── Module-level encoding helpers ──────────────────────────────────────────
// Hoisted here so the clipboard key handler (in openTerminal) can also use them.
const _encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
// TextDecoder: used to decode UTF-8 bytes received from ttyd before writing to xterm.js.
// xterm.js write(Uint8Array) treats each byte as Latin-1, not UTF-8 — multi-byte characters
// like ─ (U+2500, bytes E2 94 80) render as â (Latin-1 0xE2) without decoding first.
// Matches ttyd's official client pattern: textDecoder.decode(payload) → _term.write(string).
const _decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

function _encodePayload(typeChar, str) {
  // Returns Uint8Array: [typeCharCode, ...utf8bytes]
  var strBytes = _encoder ? _encoder.encode(str) : new Uint8Array(Array.from(str).map(function(c) { return c.charCodeAt(0); }));
  var payload = new Uint8Array(1 + strBytes.length);
  payload[0] = typeChar;
  payload.set(strBytes, 1);
  return payload;
}

// Both xterm's OSC 8 link handler and xterm-addon-web-links receive terminal
// output as untrusted input, so they share one activation path (ported from
// upstream muxplex): http(s) only, and the new tab never gets window.opener.
function _termActivateExternalLink(uri) {
  var parsed;
  try {
    parsed = new URL(uri);
  } catch (_) {
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return;
  }
  var linkWindow = window.open('', '_blank');
  if (linkWindow) {
    linkWindow.opener = null;
    linkWindow.location.href = parsed.href;
  }
}

// ─── Clipboard helpers ───────────────────────────────────────────────────────
// Ctrl+Shift+C: copy terminal selection to system clipboard
// Ctrl+Shift+V: handled natively by xterm.js (browser paste event → xterm → WebSocket)

// Copy feedback ("Copied N chars" / failure) for every copy path — Cmd+C,
// Ctrl+Shift+C and OSC 52 from tmux — so a copy never succeeds or fails
// silently. showToast lives in app.js; guarded so terminal.js still works
// standalone (node tests).
function _notifyCopy(msg) {
  if (typeof showToast === 'function') showToast(msg);
}

function _copyToClipboard(text) {
  // Never write an empty string — an empty OSC 52 payload would otherwise
  // wipe whatever the user copied last.
  if (!text) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    // Chrome only allows writeText with transient user activation, so an
    // OSC 52 arriving without a recent gesture is rejected. Surface that
    // instead of swallowing it — a silent failure is indistinguishable from
    // "copy is broken".
    navigator.clipboard.writeText(text).then(function() {
      _notifyCopy('Copied ' + Array.from(text).length + ' chars');
    }, function(err) {
      console.warn('[clipboard] writeText rejected:', err && err.name, err && err.message);
      _notifyCopy('Copy failed — clipboard access blocked');
    });
  } else {
    // Fallback for non-HTTPS contexts (HTTP over LAN)
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch(e) {}
    document.body.removeChild(ta);
    _notifyCopy(ok ? 'Copied ' + Array.from(text).length + ' chars' : 'Copy failed — clipboard access blocked');
  }
}

// ─── Native selection under tmux `mouse on` ──────────────────────────────────
// tmux `mouse on` asks the terminal for mouse tracking (DECSET 1000/1002/1003).
// If xterm.js honors it, every drag becomes a tmux copy-mode selection that is
// cancelled on release (copy-*-and-cancel) — the highlight vanishes the moment
// the button comes up, and keeping it (copy-pipe-no-clear) leaves the pane in
// copy-mode so typing stops reaching the app. So by default we swallow the
// tracking request: drags stay native xterm.js selections (highlight persists
// until the next click, copied with Cmd+C), and only the wheel is forwarded to
// tmux as SGR mouse reports, so tmux's WheelUpPane/copy-mode scrolling works.
//
// App passthrough: when the app in the viewed window has mouse tracking on
// itself (tmux #{mouse_any_flag}, e.g. fullscreen Claude Code — its agent
// roster is clickable and it does its own drag-select + OSC 52 copy), app.js
// calls setTerminalAppMouse(true) from the GET /api/windows `mouse_any` field
// and we apply tmux's tracking request to xterm after all, so clicks, drags
// and the wheel reach the app through tmux unchanged.
var _MOUSE_TRACKING_MODES = [9, 1000, 1001, 1002, 1003];
var _WHEEL_STEP_PX = 50;       // accumulated pixel delta per forwarded wheel notch
var _tmuxTrackingModes = {};   // tracking modes tmux currently asks for
var _mousePassthrough = false; // app in the viewed window wants the mouse
var _localDecsetWrites = 0;    // our own DECSET writes in flight (not tmux's)
var _wheelAccum = 0;

function _decsetModes(params) {
  var modes = [];
  for (var i = 0; i < params.length; i++) {
    modes.push(Array.isArray(params[i]) ? params[i][0] : params[i]);
  }
  return modes;
}

function _isTrackingMode(m) {
  return _MOUSE_TRACKING_MODES.indexOf(m) !== -1;
}

function _tmuxWantsMouse() {
  return Object.keys(_tmuxTrackingModes).length > 0;
}

// Forward one wheel notch to the app as an SGR mouse report (button 64 = up,
// 65 = down) at the cell under the pointer.
function _sendWheelReport(e, dir) {
  if (!_ws || _ws.readyState !== WebSocket.OPEN) return;
  var col = 1, row = 1;
  var screen = _term.element && _term.element.querySelector('.xterm-screen');
  if (screen && e.clientX !== undefined) {
    var rect = screen.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      col = Math.floor((e.clientX - rect.left) / (rect.width / _term.cols)) + 1;
      row = Math.floor((e.clientY - rect.top) / (rect.height / _term.rows)) + 1;
    }
  }
  col = Math.min(Math.max(col, 1), _term.cols);
  row = Math.min(Math.max(row, 1), _term.rows);
  _ws.send(_encodePayload(0x30, '\x1b[<' + (dir < 0 ? 64 : 65) + ';' + col + ';' + row + 'M'));
}

/**
 * Switch between native selection (false) and app mouse passthrough (true).
 * Replays tmux's current tracking request into xterm (DECSET h/l) so the
 * change takes effect immediately, without waiting for tmux to resend it.
 */
function setTerminalAppMouse(on) {
  on = !!on;
  if (on === _mousePassthrough) return;
  _mousePassthrough = on;
  if (!_term) return;
  var modes = Object.keys(_tmuxTrackingModes);
  if (!modes.length) return;
  if (on && _term.clearSelection) _term.clearSelection();
  var seq = modes.map(function(m) { return '\x1b[?' + m + (on ? 'h' : 'l'); }).join('');
  _localDecsetWrites++;
  _term.write(seq, function() { _localDecsetWrites--; });
}

window.setTerminalAppMouse = setTerminalAppMouse;

function _installNativeSelection(term, container) {
  // A new terminal starts native; app.js re-asserts passthrough on its next
  // /api/windows poll. tmux re-sends its tracking request on attach.
  _tmuxTrackingModes = {};
  _mousePassthrough = false;
  _localDecsetWrites = 0;
  _wheelAccum = 0;

  // tmux sends each DECSET mode as its own sequence; a mixed sequence falls
  // through to xterm unchanged. Our own replays (setTerminalAppMouse) always
  // apply and never touch the record of what tmux asked for.
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, function(params) {
    var modes = _decsetModes(params);
    var tracking = modes.filter(_isTrackingMode);
    if (!tracking.length || _localDecsetWrites > 0) return false;
    tracking.forEach(function(m) { _tmuxTrackingModes[m] = true; });
    if (_mousePassthrough) return false;
    return tracking.length === modes.length;
  });
  term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, function(params) {
    if (_localDecsetWrites > 0) return false;
    _decsetModes(params).filter(_isTrackingMode).forEach(function(m) {
      delete _tmuxTrackingModes[m];
    });
    return false;
  });

  // Container listeners are bound once — openTerminal reuses the container
  // for every session, and they read the module-level _term/_ws.
  if (container._muxplexNativeSelection) return;
  container._muxplexNativeSelection = true;

  // Cmd+C: xterm.js fills the clipboard from its own 'copy' handler on the
  // focused textarea; this bubble-phase listener only confirms it.
  container.addEventListener('copy', function() {
    if (!_term || !_term.hasSelection()) return;
    var sel = _term.getSelection();
    if (sel) _notifyCopy('Copied ' + Array.from(sel).length + ' chars');
  });

  // Capture phase: runs before xterm's own wheel handler (which, with no
  // tracking on the alternate screen, would turn the wheel into arrow keys).
  // In passthrough xterm is tracking itself and reports the wheel to tmux.
  container.addEventListener('wheel', function(e) {
    if (!_term || _mousePassthrough || !_tmuxWantsMouse()) return;
    e.preventDefault();
    e.stopPropagation();
    var px = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
    _wheelAccum += px;
    while (Math.abs(_wheelAccum) >= _WHEEL_STEP_PX) {
      var dir = _wheelAccum < 0 ? -1 : 1;
      _sendWheelReport(e, dir);
      _wheelAccum -= dir * _WHEEL_STEP_PX;
    }
  }, { capture: true, passive: false });
}

// ─── Forward declarations ─────────────────────────────────────────────────────

function connectWebSocket(name, remoteId) {
  // Always connect to the same origin — remote sessions route through the
  // federation proxy (ws://host/federation/{remoteId}/terminal/ws) so that
  // no cross-origin WebSocket connections are made from the browser.
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var url;
  if (remoteId) {
    // Remote session via federation proxy — same origin, different path
    url = proto + '//' + location.host + '/federation/' + remoteId + '/terminal/ws';
  } else {
    // Local session: same origin
    url = proto + '//' + location.host + '/terminal/ws';
  }
  const reconnectOverlay = document.getElementById('reconnect-overlay');
  // Use module-level _encodePayload (hoisted above connectWebSocket)
  var encodePayload = _encodePayload;

  // Register terminal event handlers once on this _term instance.
  // These handlers read the module-level _ws at call time (not a captured reference),
  // so they always target the live socket. createTerminal() disposes _term before
  // the next session, removing these handlers automatically.
  if (_term) {
    _term.onData(function(data) {
      if (_ws && _ws.readyState === WebSocket.OPEN) {
        // ttyd protocol: input is type 0x30 ('0') + UTF-8 keystroke bytes
        _ws.send(encodePayload(0x30, data));
      }
    });
    _term.onResize(function(size) {
      if (_ws && _ws.readyState === WebSocket.OPEN) {
        // ttyd protocol: resize is type 0x31 ('1') + UTF-8 JSON
        _ws.send(encodePayload(0x31, JSON.stringify({ columns: size.cols, rows: size.rows })));
      }
    });
  }

  // _connectWebSocket — creates the WebSocket instance and registers all event handlers.
  // Called directly for normal reconnects (ttyd still alive), or after a brief delay
  // following the /connect POST (ttyd was dead and needed respawning).
  //
  // Local const `ws` captures this specific instance so each handler can check
  // `if (ws !== _ws) return;` (stale guard). Without it, rapid reconnects or
  // session switches cause old handlers to fire on the new _ws while it is still
  // CONNECTING → send error → close → reconnect → infinite loop (Bug 2).
  function _connectWebSocket() {
    // 'tty' subprotocol is REQUIRED — without it ttyd never starts the PTY.
    // Confirmed via raw Python WebSocket tests: ttyd accepts the TCP upgrade but
    // sits completely silent (no child process spawned) when subprotocol is omitted.
    const ws = new WebSocket(url, ['tty']);
    _ws = ws;
    ws.binaryType = 'arraybuffer';

    ws.addEventListener('open', function() {
      if (ws !== _ws) return; // stale connection — superseded by a newer one, ignore
      // NOTE: do NOT reset _reconnectAttempts here. The server-side proxy accepts
      // the WS before confirming ttyd is alive (auto-spawning if needed), but the
      // browser 'open' event fires as soon as the proxy accepts — not when ttyd
      // is actually ready. Resetting here caused the 0→1→0→1 bounce. Instead,
      // reset on first data message (proves ttyd is alive and relaying).
      if (reconnectOverlay) reconnectOverlay.classList.add('hidden');
      // Step 1: TEXT frame auth handshake — ttyd checks AuthToken before starting PTY
      ws.send(JSON.stringify({ AuthToken: '' }));
      // Step 2: BINARY frame with initial terminal dimensions — [0x31] + JSON({columns, rows})
      if (_term) {
        ws.send(encodePayload(0x31, JSON.stringify({ columns: _term.cols, rows: _term.rows })));
      }
      // Auto-focus the terminal so user can type immediately without clicking
      if (_term) _term.focus();
    });

    ws.addEventListener('message', function(e) {
      if (ws !== _ws) return; // stale connection — superseded by a newer one, ignore
      if (!_term) return;
      // First data message proves ttyd is alive and relaying — safe to reset counter.
      // We deliberately do NOT reset in the 'open' handler: the server-side proxy
      // accepts the browser WS before ttyd is fully confirmed alive, so 'open'
      // firing alone doesn't mean data will flow. Resetting here prevents the
      // 0→1→0→1 bounce that kept the reconnect loop from escalating to /connect.
      if (_reconnectAttempts > 0) _reconnectAttempts = 0;
      if (e.data instanceof ArrayBuffer) {
        var msg = new Uint8Array(e.data);
        if (msg.length < 1) return;
        var msgType = msg[0];
        var payload = msg.slice(1);
        if (msgType === 0x30) {  // '0' = terminal output — write to xterm.js
          // decode: Uint8Array → UTF-8 string. write(Uint8Array) treats bytes as Latin-1.
          _term.write(_decoder ? _decoder.decode(payload) : payload);
        }
        // 0x31 ('1') = window title, 0x32 ('2') = preferences — ignore for now
      } else if (typeof e.data === 'string') {
        _term.write(e.data);  // fallback for text frames
      }
    });

    ws.addEventListener('close', function() {
      if (ws !== _ws) return; // stale connection — don't reconnect for old sockets
      if (!_currentSession) return; // intentional close — don't reconnect
      if (reconnectOverlay) reconnectOverlay.classList.remove('hidden');
      _reconnectAttempts++;
      // Exponential backoff: 1s, 2s, 4s, 8s, cap at 15s. Add jitter to avoid thundering herd.
      var delay = Math.min(1000 * Math.pow(2, _reconnectAttempts - 1), 15000);
      delay += Math.random() * 500; // jitter
      _reconnectTimer = setTimeout(connect, delay);
    });

    ws.addEventListener('error', function() {
      if (ws !== _ws) return; // stale connection — ignore
      console.warn('tmux-web: WebSocket error on', url);
    });
  }

  function connect() {
    // After 2 failed WS attempts, ttyd is likely dead (e.g. after service restart).
    // AWAIT the /connect POST before opening the WebSocket — ttyd must be alive first.
    // fetch() includes cookies automatically for same-origin requests so auth is transparent.
    //
    // Critical: this path uses .then() so _connectWebSocket() runs only AFTER the POST
    // response (plus an 800ms settle delay for ttyd to bind its port). The early return
    // prevents falling through to the direct _connectWebSocket() call below.
    if (_reconnectAttempts >= 2 && _currentSession) {
      var connectPath;
      if (remoteId) {
        // Remote session: route through federation proxy
        connectPath = '/api/federation/' + encodeURIComponent(remoteId) + '/connect/' + encodeURIComponent(_currentSession);
      } else {
        // Local session
        connectPath = '/api/sessions/' + encodeURIComponent(_currentSession) + '/connect';
      }
      fetch(connectPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
        .catch(function() { return null; })
        .then(function() {
          // Brief delay for ttyd to bind its port after /connect spawns it
          setTimeout(_connectWebSocket, 800);
        });
      return; // Don't fall through — .then() handles the WebSocket creation
    }

    _connectWebSocket();
  }

  connect();
}
function initVisualViewport() {
  if (!window.visualViewport) return;
  if (_vpHandler) window.visualViewport.removeEventListener('resize', _vpHandler);

  _vpHandler = function() {
    if (!_term || !_fitAddon) return;
    var container = document.getElementById('terminal-container');
    if (!container) return;

    // Resize container to fill visual viewport above keyboard
    var headerHeight = 44; // matches --header-height CSS custom property
    var vvh = window.visualViewport.height;
    var termHeight = Math.max(100, vvh - headerHeight);
    container.style.height = termHeight + 'px';

    // Refit xterm.js to new container size
    try { _fitAddon.fit(); } catch (_) {}
  };

  window.visualViewport.addEventListener('resize', _vpHandler);
}

// ─── Terminal creation ────────────────────────────────────────────────────────

/**
 * Create (or recreate) the xterm.js Terminal and FitAddon instances.
 * Disposes any existing terminal first.
 * Stores the results in module-level _term and _fitAddon.
 * @param {number} [fontSize=14] - font size in pixels, from server display settings
 */
function createTerminal(fontSize) {
  // Dispose any existing instance
  if (_term) {
    _term.dispose();
    _term = null;
    _fitAddon = null;
  }

  // Use the fontSize passed from app.js (getDisplaySettings().fontSize), defaulting to 14.
  var storedFontSize = (typeof fontSize === 'number' && fontSize > 0) ? fontSize : 14;

  const mobile = window.innerWidth < 600; // matches MOBILE_THRESHOLD in app.js
  const effectiveFontSize = mobile ? Math.min(storedFontSize, 12) : storedFontSize;

  _term = new window.Terminal({
    cursorBlink: true,
    fontSize: effectiveFontSize,
    fontFamily: "'SF Mono', 'Fira Code', Consolas, monospace",
    theme: {
      background: '#000000',
      foreground: '#c9d1d9',
      cursor: '#58a6ff',
    },
    scrollback: mobile ? 500 : 5000,
    allowProposedApi: true,
    // OSC 8 hyperlinks (e.g. Claude Code's Markdown link labels; needs tmux
    // `terminal-features ',xterm*:hyperlinks'` or tmux strips them). Without a
    // handler xterm.js falls back to a confirm() prompt. Same gesture as the
    // plain-URL addon below: Cmd/Ctrl+click opens, a plain click stays a click.
    linkHandler: {
      activate: function(event, uri) {
        if (event.ctrlKey || event.metaKey) _termActivateExternalLink(uri);
      },
    },
  });

  _fitAddon = new window.FitAddon.FitAddon();
  _term.loadAddon(_fitAddon);

  // Clickable URLs — Ctrl+Click (Windows/Linux) or Cmd+Click (macOS) opens in new tab.
  // xterm-addon-web-links auto-detects URLs and adds hover underlines.
  // Plain click is preserved for normal terminal text selection.
  var WebLinksAddon = window.WebLinksAddon && window.WebLinksAddon.WebLinksAddon;
  if (WebLinksAddon) {
    _term.loadAddon(new WebLinksAddon(function(event, uri) {
      if (event.ctrlKey || event.metaKey) {
        _termActivateExternalLink(uri);
      }
    }));
  }

  // Search addon — Ctrl+F to find text in terminal buffer
  var SearchAddon = window.SearchAddon && window.SearchAddon.SearchAddon;
  if (SearchAddon) {
    _searchAddon = new SearchAddon();
    _term.loadAddon(_searchAddon);
  }

  // Image addon — inline image rendering (Sixel, iTerm2 IIP, Kitty graphics)
  // Needed for tools like yazi file manager that use graphic protocols
  var ImageAddon = window.ImageAddon && window.ImageAddon.ImageAddon;
  if (ImageAddon) {
    _term.loadAddon(new ImageAddon());
  }
}

// ─── Search helpers ──────────────────────────────────────────────────────────────────────────────────────────────────

function _openSearch() {
  var bar = document.getElementById('terminal-search-bar');
  var input = document.getElementById('terminal-search-input');
  if (bar) {
    bar.classList.remove('hidden');
    if (input) {
      input.focus();
      input.select();
    }
  }
}

function _closeSearch() {
  var bar = document.getElementById('terminal-search-bar');
  if (bar) bar.classList.add('hidden');
  if (_searchAddon) _searchAddon.clearDecorations();
  if (_term) _term.focus();
}

function _searchNext() {
  var input = document.getElementById('terminal-search-input');
  if (input && input.value && _searchAddon) {
    _searchAddon.findNext(input.value);
  }
}

function _searchPrev() {
  var input = document.getElementById('terminal-search-input');
  if (input && input.value && _searchAddon) {
    _searchAddon.findPrevious(input.value);
  }
}

// ─── Open / close ─────────────────────────────────────────────────────────────

/**
 * Open a terminal session inside #terminal-container.
 * @param {string} sessionName
 * @param {string} [remoteId]  Optional federation remote ID.
 *   When provided, the WebSocket connects via the federation proxy path
 *   ws://host/federation/{remoteId}/terminal/ws (same origin, no cross-origin).
 */
function openTerminal(sessionName, remoteId, fontSize) {
  // Null _currentSession first so any in-flight close handler on the old WS won't
  // schedule a reconnect (it checks `if (!_currentSession) return;`).
  _currentSession = null;
  _reconnectAttempts = 0; // reset backoff on new session open

  // Cancel any pending reconnect timer from the previous session.
  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }

  // Close existing WebSocket so it can't write to the new terminal (Bug 1 fix).
  if (_ws) {
    _ws.close();
    _ws = null;
  }

  _currentSession = sessionName;

  const container = document.getElementById('terminal-container');
  if (!container) {
    console.warn('[openTerminal] #terminal-container not found');
    return;
  }

  createTerminal(fontSize);

  _term.open(container);

  // --- Auto-refit on container resize (sidebar toggle, etc.) ---
  // xterm.js FitAddon only resizes on explicit fit() calls. A ResizeObserver
  // on the container handles ALL layout changes: sidebar toggle, window resize,
  // and any future CSS geometry change. Debounced to coalesce rapid events
  // (e.g. during CSS transition animation frames).
  if (_resizeObserver) { _resizeObserver.disconnect(); _resizeObserver = null; }
  if (typeof ResizeObserver !== 'undefined') {
    var _roTimer = null;
    _resizeObserver = new ResizeObserver(function() {
      clearTimeout(_roTimer);
      _roTimer = setTimeout(function() {
        if (_fitAddon) try { _fitAddon.fit(); } catch (_) {}
      }, 50);
    });
    _resizeObserver.observe(container);
  }

  // --- Clipboard integration ---
  // Copy: Ctrl+Shift+C intercepts and copies selection to system clipboard
  // Paste: handled natively by xterm.js (browser paste event → hidden textarea → onData → WebSocket)
  //   Cmd+V (macOS) and Ctrl+Shift+V (Linux) both trigger native browser paste events
  _term.attachCustomKeyEventHandler(function(e) {
    if (e.type !== 'keydown') return true;

    // Ctrl+Shift+C → copy selection to clipboard
    if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.code === 'KeyC')) {
      var sel = _term.getSelection();
      if (sel) _copyToClipboard(sel);
      return false;  // prevent xterm from processing
    }

    // Ctrl+F → open search bar
    if (e.ctrlKey && !e.shiftKey && (e.key === 'f' || e.key === 'F' || e.code === 'KeyF')) {
      _openSearch();
      return false;
    }

    return true;  // let xterm handle all other keys normally
  });

  // No auto-copy on selection: like any other app, a drag selects and
  // Cmd+C (macOS) / Ctrl+Shift+C copies. xterm.js serves the browser's copy
  // event from its focused textarea; see the 'copy' listener in
  // _installNativeSelection for the confirmation toast.

  _installNativeSelection(_term, container);

  // OSC 52 clipboard integration — bridges tmux clipboard to the browser.
  // When tmux copies text (with `set-clipboard on` in .tmux.conf), it sends
  // an OSC 52 escape sequence to the terminal. xterm.js surfaces this via the
  // parser API. We intercept and write the decoded text to the system clipboard
  // so that: Ctrl+B [ → select → Enter (tmux copy) → system clipboard receives it.
  _term.parser.registerOscHandler(52, function(data) {
    // OSC 52 format: Pc ; Pd — Pc = selection target (c/p/q/s/0-7), Pd = base64 text
    var parts = data.split(';');
    if (parts.length >= 2) {
      try {
        // atob() returns a "binary string" — one JS char per decoded byte
        // (effectively Latin-1). tmux's OSC 52 payload is UTF-8 bytes, so
        // multi-byte characters (box-drawing, bullets, em dashes, emoji)
        // must be re-wrapped into a byte array and passed through the same
        // TextDecoder used for the WebSocket output path — otherwise they
        // decode as mojibake (e.g. "─" becomes "â") even though the primary
        // terminal-output path (see _decoder.decode(payload) above) is
        // already UTF-8 correct.
        var binary = atob(parts[1]);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        var text = _decoder ? _decoder.decode(bytes) : binary;
        _copyToClipboard(text);
      } catch (e) {
        // Invalid base64 or unsupported — silently ignore
      }
    }
    return true;  // Handled — don't pass to xterm's default handler
  });

  if (_fitAddon) {
    // requestAnimationFrame guarantees one full browser layout pass after the flex
    // container becomes visible before fit() measures dimensions.
    // iOS Safari defers flex layout — calling fit() synchronously here gives 0px width
    // → 2-column terminal. The RAF and 500ms fallback fix this race condition.
    // Falls back to immediate execution in Node.js test environments where RAF is absent.
    const fitAddonRef = _fitAddon;
    const raf = typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame : (fn) => fn();
    raf(function() {
      try { fitAddonRef.fit(); } catch (_) {}
      // 500ms fallback for slow mobile layout engines (e.g. first paint on low-end devices)
      setTimeout(function() {
        try { if (_fitAddon) _fitAddon.fit(); } catch (_) {}
      }, 500);
    });
  }

  // Wire search bar buttons + keyboard handlers (idempotent — elements are static)
  var searchInput = document.getElementById('terminal-search-input');
  var searchClose = document.getElementById('terminal-search-close');
  var searchNextBtn = document.getElementById('terminal-search-next');
  var searchPrevBtn = document.getElementById('terminal-search-prev');

  if (searchInput) {
    // Remove old listeners by replacing with cloned element (avoids duplicate handlers on reconnect)
    var newInput = searchInput.cloneNode(true);
    searchInput.parentNode.replaceChild(newInput, searchInput);
    searchInput = newInput;
    searchInput.addEventListener('input', function() {
      if (_searchAddon && searchInput.value) {
        _searchAddon.findNext(searchInput.value);
      } else if (_searchAddon) {
        _searchAddon.clearDecorations();
      }
    });
    searchInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) _searchPrev(); else _searchNext();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        _closeSearch();
      }
    });
  }
  if (searchClose) {
    var newClose = searchClose.cloneNode(true);
    searchClose.parentNode.replaceChild(newClose, searchClose);
    newClose.addEventListener('click', _closeSearch);
  }
  if (searchNextBtn) {
    var newNext = searchNextBtn.cloneNode(true);
    searchNextBtn.parentNode.replaceChild(newNext, searchNextBtn);
    newNext.addEventListener('click', _searchNext);
  }
  if (searchPrevBtn) {
    var newPrev = searchPrevBtn.cloneNode(true);
    searchPrevBtn.parentNode.replaceChild(newPrev, searchPrevBtn);
    newPrev.addEventListener('click', _searchPrev);
  }

  // --- Right-click context menu ---
  // Suppress the browser context menu on plain right-click inside the terminal
  // so tmux's own menu (when `set -g mouse on`) isn't covered by the browser's.
  // Shift+RMB and Ctrl+RMB still open the browser context menu as escape hatches.
  container.addEventListener('contextmenu', function(e) {
    if (e.shiftKey || e.ctrlKey || e.metaKey) return; // let modified clicks through
    e.preventDefault();
  });

  connectWebSocket(sessionName, remoteId);
  initVisualViewport(); /* defined in Task 14 */
}

/**
 * Close the current terminal session and clean up all resources.
 */
function closeTerminal() {
  if (_vpHandler) {
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', _vpHandler);
    _vpHandler = null;
  }

  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }

  if (_ws) {
    _ws.close();
    _ws = null;
  }

  if (_resizeObserver) { _resizeObserver.disconnect(); _resizeObserver = null; }

  if (_term) {
    _term.dispose();
    _term = null;
    _fitAddon = null;
    _searchAddon = null;
  }

  _closeSearch();
  _currentSession = null;
  _reconnectAttempts = 0; // reset backoff on intentional close
}

// ─── Expose to app.js ─────────────────────────────────────────────────────────
window._openTerminal = openTerminal;
window._closeTerminal = closeTerminal;
window._openSearch = _openSearch;
window._closeSearch = _closeSearch;

// ---------------------------------------------------------------------------
// setTerminalFontSize — live font-size update without reconnecting
// ---------------------------------------------------------------------------

/**
 * Update the terminal font size at runtime without reconnecting.
 * Modifies _term.options.fontSize and refits the terminal to recalculate dimensions.
 * No-op when no terminal is open.
 * @param {number} size - font size in pixels
 */
function setTerminalFontSize(size) {
  if (!_term) return;
  _term.options.fontSize = size;
  if (_fitAddon) {
    try { _fitAddon.fit(); } catch (_) {}
  }
}

window._setTerminalFontSize = setTerminalFontSize;

// ---------------------------------------------------------------------------
// Mobile touch scroll — rAF-batched WheelEvent dispatch
// Mobile devices batch touchmove events irregularly; dispatching one WheelEvent
// per frame (via requestAnimationFrame) smooths over burst delivery.
// Applies to Android, iOS, and iPadOS touch devices.
// ---------------------------------------------------------------------------
;(function initMobileTerminalScroll() {
  var isTouchDevice = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
                      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!isTouchDevice) return;

  var container = document.getElementById('terminal-container');
  if (!container) return;

  var _lastY      = 0;
  var _accumulated = 0;  // pixel debt between rAF ticks
  var _rafId       = null;
  var SCROLL_PX    = 20; // pixels of touch movement = one WheelEvent dispatch

  function flushScroll() {
    _rafId = null;
    if (!_term || Math.abs(_accumulated) < SCROLL_PX) return;

    var viewport = container.querySelector('.xterm-viewport');
    if (!viewport) { _accumulated = 0; return; }

    // One WheelEvent per frame — dir * 120 = one standard scroll click
    var dir = _accumulated > 0 ? 1 : -1;
    viewport.dispatchEvent(new WheelEvent('wheel', {
      deltaY: dir * 120,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      bubbles: true,
      cancelable: true,
    }));
    _accumulated -= dir * SCROLL_PX;

    // Self-schedule until remainder is consumed
    if (Math.abs(_accumulated) >= SCROLL_PX) {
      _rafId = requestAnimationFrame(flushScroll);
    }
  }

  container.addEventListener('touchstart', function (e) {
    _lastY       = e.touches[0].clientY;
    _accumulated = 0;
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
  }, { passive: true });

  container.addEventListener('touchmove', function (e) {
    if (!_term) return;
    e.preventDefault(); // block outer-container scroll

    var y      = e.touches[0].clientY;
    _accumulated += _lastY - y;   // positive = swipe up = newer content
    _lastY = y;

    if (!_rafId) {
      _rafId = requestAnimationFrame(flushScroll);
    }
  }, { passive: false }); // passive:false required for preventDefault

  container.addEventListener('touchend', function () {
    _lastY       = 0;
    _accumulated = 0;
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
  }, { passive: true });
})();


