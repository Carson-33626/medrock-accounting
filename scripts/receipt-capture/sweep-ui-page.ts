// web/scripts/receipt-capture/sweep-ui-page.ts
//
// Inline HTML/CSS/JS for the Sweep Control Panel (DS 2026-07-29 §3.3). No framework, no build
// step, no external assets -- the whole page is this one string, served as-is by GET / in
// sweep-ui-server.ts. All dynamic content (vendor labels/details, console lines, the report body)
// is written into the DOM via textContent, never innerHTML, on the client side below.
export const SWEEP_UI_PAGE: string = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sweep Control Panel</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f5f6f8;
    --panel: #ffffff;
    --text: #16181d;
    --muted: #5b6270;
    --border: #dde1e7;
    --green: #1b8a4c;
    --amber: #b8860b;
    --red: #c62c2c;
    --accent: #2757c9;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14161a;
      --panel: #1d2026;
      --text: #e7e9ee;
      --muted: #9aa1ad;
      --border: #2c3038;
      --green: #3ecb76;
      --amber: #e0ac3a;
      --red: #ef5555;
      --accent: #6d93e8;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
    padding: 1.5rem;
  }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; }
  h2 { font-size: 1rem; margin: 0 0 0.75rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .panels { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1rem; align-items: start; }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; }
  .cards { display: flex; flex-direction: column; gap: 0.6rem; }
  .card { border: 1px solid var(--border); border-radius: 6px; padding: 0.6rem 0.75rem; }
  .card-head { display: flex; align-items: center; gap: 0.5rem; font-weight: 600; }
  .dot { width: 0.65rem; height: 0.65rem; border-radius: 50%; flex: none; }
  .dot.green { background: var(--green); }
  .dot.amber { background: var(--amber); }
  .dot.red { background: var(--red); }
  .detail { color: var(--muted); font-size: 0.85rem; margin: 0.25rem 0 0.5rem; }
  .actions { display: flex; flex-wrap: wrap; gap: 0.4rem; }
  button { font: inherit; padding: 0.35rem 0.7rem; border-radius: 5px; border: 1px solid var(--border); background: var(--panel); color: var(--text); cursor: pointer; }
  button:hover:not(:disabled) { border-color: var(--accent); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
  button.danger { background: var(--red); color: #fff; border-color: var(--red); }
  .run-row { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 0.75rem; }
  .arm { display: flex; align-items: center; gap: 0.4rem; color: var(--muted); }
  .banner { padding: 0.5rem 0.75rem; border-radius: 6px; margin-bottom: 0.75rem; font-size: 0.9rem; display: none; }
  .banner.show { display: block; }
  .banner.busy { background: rgba(39, 87, 201, 0.16); color: var(--accent); }
  .banner.ok { background: rgba(27, 138, 76, 0.16); color: var(--green); }
  .banner.err { background: rgba(198, 44, 44, 0.16); color: var(--red); }
  pre.console { background: #0d0f13; color: #d7dde6; padding: 0.6rem; border-radius: 6px; height: 260px; overflow: auto; font-size: 0.8rem; white-space: pre-wrap; word-break: break-word; margin: 0; }
  pre.report { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 0.6rem; max-height: 420px; overflow: auto; font-size: 0.8rem; white-space: pre-wrap; word-break: break-word; margin: 0; }
  .report-name { color: var(--muted); font-size: 0.8rem; margin: 0 0 0.4rem; }
  .toasts { position: fixed; right: 1rem; bottom: 1rem; display: flex; flex-direction: column; gap: 0.4rem; z-index: 10; }
  .toast { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 0.5rem 0.75rem; font-size: 0.85rem; box-shadow: 0 2px 8px rgba(0,0,0,0.2); }
</style>
</head>
<body>
<h1>Sweep Control Panel</h1>
<div class="panels">
  <section class="panel" id="panel-sessions">
    <h2>Sessions &amp; sources</h2>
    <div class="cards" id="vendor-cards"></div>
  </section>
  <section class="panel" id="panel-run">
    <h2>Run</h2>
    <div class="banner" id="busy-banner"></div>
    <div class="banner" id="done-banner"></div>
    <div class="run-row">
      <button class="primary" id="btn-dry">Dry run</button>
      <label class="arm"><input type="checkbox" id="arm-live" /> Arm LIVE</label>
      <button class="danger" id="btn-live" disabled>Run LIVE sweep</button>
    </div>
    <pre class="console" id="console"></pre>
  </section>
  <section class="panel" id="panel-results">
    <h2>Results</h2>
    <div class="run-row">
      <button id="btn-scan">Scan (refresh counts)</button>
    </div>
    <p class="report-name" id="report-name">no report yet</p>
    <pre class="report" id="report"></pre>
  </section>
</div>
<div class="toasts" id="toasts"></div>
<script>
(function () {
  'use strict';

  var vendorCardsEl = document.getElementById('vendor-cards');
  var busyBannerEl = document.getElementById('busy-banner');
  var doneBannerEl = document.getElementById('done-banner');
  var consoleEl = document.getElementById('console');
  var reportEl = document.getElementById('report');
  var reportNameEl = document.getElementById('report-name');
  var toastsEl = document.getElementById('toasts');
  var btnDry = document.getElementById('btn-dry');
  var btnLive = document.getElementById('btn-live');
  var btnScan = document.getElementById('btn-scan');
  var armLive = document.getElementById('arm-live');

  var currentLabel = null; // label of the action believed to be running, for the done-code banner
  var pollTimer = null;

  var ULINE_CODES = {
    2: 'session expired',
    3: 'account mismatch',
    4: 'corrupt registry',
  };

  function toast(message) {
    var el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    toastsEl.appendChild(el);
    setTimeout(function () { el.remove(); }, 4000);
  }

  function humanize(action) {
    return action.replace(/-/g, ' ').replace(/\\b\\w/g, function (c) { return c.toUpperCase(); });
  }

  function setBusyBanner(action) {
    if (action) {
      busyBannerEl.textContent = 'Running: ' + humanize(action);
      busyBannerEl.className = 'banner busy show';
    } else {
      busyBannerEl.textContent = '';
      busyBannerEl.className = 'banner';
    }
  }

  function setButtonsDisabled(disabled) {
    var buttons = vendorCardsEl.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = disabled;
    btnDry.disabled = disabled;
    btnLive.disabled = disabled || !armLive.checked;
    // btnScan (scan-only) is exempt from the busy-lock server-side, so it stays enabled here too.
  }

  function renderVendorCard(card) {
    var el = document.createElement('div');
    el.className = 'card';

    var head = document.createElement('div');
    head.className = 'card-head';
    var dot = document.createElement('span');
    dot.className = 'dot ' + card.light;
    head.appendChild(dot);
    var label = document.createElement('span');
    label.textContent = card.label;
    head.appendChild(label);
    el.appendChild(head);

    var detail = document.createElement('p');
    detail.className = 'detail';
    // amazon-csv's PDF count is a shared cache across all three accounts, not per-account.
    detail.textContent = card.key === 'amazon-csv'
      ? card.detail.replace('invoice PDF(s)', 'invoices cached (all accounts)')
      : card.detail;
    el.appendChild(detail);

    if (card.actions.length > 0) {
      var actionsEl = document.createElement('div');
      actionsEl.className = 'actions';
      card.actions.forEach(function (action) {
        var btn = document.createElement('button');
        btn.textContent = humanize(action);
        btn.addEventListener('click', function () { runAction(action); });
        actionsEl.appendChild(btn);
      });
      el.appendChild(actionsEl);
    }

    return el;
  }

  function renderVendors(vendors) {
    vendorCardsEl.textContent = '';
    vendors.forEach(function (card) { vendorCardsEl.appendChild(renderVendorCard(card)); });
  }

  function schedulePoll() {
    if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; }
    fetchStatus();
  }

  function fetchStatus() {
    fetch('/api/status')
      .then(function (res) { return res.json(); })
      .then(function (status) {
        renderVendors(status.vendors);
        reportNameEl.textContent = status.latestReport || 'no report yet';
        if (status.busy) {
          setBusyBanner(status.busy.action);
          setButtonsDisabled(true);
          // Paused: normal 5s cadence stops. A 'done' SSE event re-triggers immediately; this
          // slow fallback just guards against a done event that never arrives (e.g. the child
          // runner throwing before broadcastDone), so the panel can never wedge indefinitely.
          pollTimer = setTimeout(fetchStatus, 20000);
        } else {
          setBusyBanner(null);
          setButtonsDisabled(false);
          pollTimer = setTimeout(fetchStatus, 5000);
        }
      })
      .catch(function (e) {
        toast('status fetch failed: ' + e.message);
        pollTimer = setTimeout(fetchStatus, 5000);
      });
  }

  function fetchReport() {
    fetch('/api/report')
      .then(function (res) { return res.text(); })
      .then(function (text) { reportEl.textContent = text; })
      .catch(function (e) { toast('report fetch failed: ' + e.message); });
  }

  function isPinnedToBottom() {
    return consoleEl.scrollTop + consoleEl.clientHeight >= consoleEl.scrollHeight - 4;
  }

  function appendConsole(line) {
    var pinned = isPinnedToBottom();
    consoleEl.textContent += line + '\\n';
    if (pinned) consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  function showDoneBanner(code) {
    var ok = code === 0;
    var codeText = code === null || code === undefined ? 'terminated' : ('exit ' + code);
    doneBannerEl.className = 'banner show ' + (ok ? 'ok' : 'err');
    var text = 'Finished (' + codeText + ')';
    // Not gated on the label text: run-sweep.ts's own child runs (Dry run / Run LIVE sweep) can
    // surface a ULINE vendor job's exit code via this same done event, not just a direct
    // "ULINE bootstrap ..." action, so the annotation applies to any action's exit code.
    if (!ok && typeof code === 'number' && ULINE_CODES[code]) {
      text += ' -- ' + ULINE_CODES[code];
    }
    doneBannerEl.textContent = text;
  }

  function runAction(action, armed) {
    var body = { action: action };
    if (armed !== undefined) body.armed = armed;
    fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (res) {
        return res.json().then(function (json) { return { status: res.status, json: json }; });
      })
      .then(function (result) {
        if (result.status === 409) {
          toast('busy: another action is already running');
          return;
        }
        if (result.status >= 400) {
          toast((result.json && result.json.error) || ('error ' + result.status));
          return;
        }
        var json = result.json || {};
        if (json.launched) {
          // chrome-kind: detached launch, no child tracked server-side, no SSE 'done' to expect.
          toast('Chrome launched: ' + humanize(action));
          return;
        }
        currentLabel = json.label || action;
        doneBannerEl.className = 'banner';
        doneBannerEl.textContent = '';
        consoleEl.textContent = '';
        schedulePoll();
      })
      .catch(function (e) { toast('action failed: ' + e.message); });
  }

  btnDry.addEventListener('click', function () { runAction('sweep-dry'); });
  btnLive.addEventListener('click', function () {
    if (!armLive.checked) return;
    runAction('sweep-live', true);
  });
  btnScan.addEventListener('click', function () { runAction('scan-only'); });
  armLive.addEventListener('change', function () {
    btnLive.disabled = !armLive.checked;
  });

  var stream = new EventSource('/api/stream');
  stream.onmessage = function (ev) { appendConsole(ev.data); };
  stream.addEventListener('done', function (ev) {
    var payload = JSON.parse(ev.data);
    showDoneBanner(payload.code);
    fetchReport();
    schedulePoll();
  });
  stream.onerror = function () {
    // EventSource auto-reconnects on its own; nothing additional to do here.
  };

  fetchStatus();
  fetchReport();
})();
</script>
</body>
</html>
`;
