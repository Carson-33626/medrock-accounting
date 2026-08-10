/* Sweep Control Panel — client.
 *
 * No framework, no build step. Every piece of dynamic content (vendor labels, details, console
 * lines, report body, toasts) is written with textContent, never innerHTML — vendor detail strings
 * and child-process output are untrusted-ish input and must never be parsed as markup.
 *
 * Action buttons are rendered from ACTION_META, shipped by /api/status. That's what lets a live
 * action render as a distinct, arm-gated button; the page used to Title-Case the action name and
 * render every action identically, so every live button was a guaranteed HTTP 400.
 */
(function () {
  'use strict';

  var attentionEl = document.getElementById('attention');
  var lastSweepEl = document.getElementById('last-sweep');
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

  var pollTimer = null;
  var isBusy = false;
  // Per-card arming, keyed by card key. Kept across the 5s status re-render so a poll can't
  // silently disarm you mid-click, and cleared once a live action actually fires.
  var armedCards = Object.create(null);
  var actionMeta = Object.create(null);

  var ULINE_CODES = { 2: 'session expired', 3: 'account mismatch', 4: 'corrupt registry' };

  function toast(message) {
    var el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    toastsEl.appendChild(el);
    setTimeout(function () { el.remove(); }, 5000);
  }

  function metaFor(action) {
    var m = actionMeta[action];
    if (m) return m;
    // Defensive only: an action the server didn't describe is treated as live, i.e. the safest
    // possible assumption — it renders gated rather than as a one-click button.
    return { label: action, risk: 'live', requiresArm: true };
  }

  // ── Attention strip ──────────────────────────────────────────────────────

  function renderAttention(vendors) {
    var needy = vendors.filter(function (v) { return v.light !== 'green'; });
    attentionEl.textContent = '';
    attentionEl.hidden = false;

    if (needy.length === 0) {
      attentionEl.className = 'attention all-clear';
      attentionEl.textContent = 'All sources ready';
      return;
    }

    attentionEl.className = 'attention';
    var lead = document.createElement('strong');
    lead.textContent = needy.length === 1 ? '1 needs attention:' : needy.length + ' need attention:';
    attentionEl.appendChild(lead);

    needy.forEach(function (v) {
      var pill = document.createElement('span');
      pill.className = 'pill';
      var dot = document.createElement('span');
      dot.className = 'dot ' + v.light;
      pill.appendChild(dot);
      var name = document.createElement('span');
      name.textContent = v.label;
      pill.appendChild(name);
      attentionEl.appendChild(pill);
    });
  }

  // ── Vendor cards ─────────────────────────────────────────────────────────

  function makeButton(action, meta, extraClass) {
    var btn = document.createElement('button');
    btn.textContent = meta.label;
    if (extraClass) btn.className = extraClass;
    btn.addEventListener('click', function () {
      runAction(action, meta.requiresArm ? true : undefined);
    });
    return btn;
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

    var safeActions = card.actions.filter(function (a) { return metaFor(a).risk !== 'live'; });
    var liveActions = card.actions.filter(function (a) { return metaFor(a).risk === 'live'; });

    if (safeActions.length > 0) {
      var safeWrap = document.createElement('div');
      safeWrap.className = 'actions';
      safeActions.forEach(function (a) { safeWrap.appendChild(makeButton(a, metaFor(a))); });
      el.appendChild(safeWrap);
    }

    if (liveActions.length > 0) {
      var liveWrap = document.createElement('div');
      liveWrap.className = 'live-row';

      var armLabel = document.createElement('label');
      armLabel.className = 'arm';
      var armBox = document.createElement('input');
      armBox.type = 'checkbox';
      armBox.checked = armedCards[card.key] === true;
      armLabel.appendChild(armBox);
      armLabel.appendChild(document.createTextNode(' Arm LIVE writes'));
      liveWrap.appendChild(armLabel);

      var liveButtons = document.createElement('div');
      liveButtons.className = 'actions';
      var buttons = liveActions.map(function (a) {
        var btn = makeButton(a, metaFor(a), 'danger');
        btn.disabled = !armBox.checked || isBusy;
        liveButtons.appendChild(btn);
        return btn;
      });
      liveWrap.appendChild(liveButtons);

      armBox.addEventListener('change', function () {
        armedCards[card.key] = armBox.checked;
        buttons.forEach(function (b) { b.disabled = !armBox.checked || isBusy; });
      });

      el.appendChild(liveWrap);
    }

    return el;
  }

  function renderVendors(vendors) {
    ['receipts', 'bills'].forEach(function (group) {
      var host = document.querySelector('.cards[data-group="' + group + '"]');
      if (!host) return;
      host.textContent = '';
      vendors
        .filter(function (v) { return v.group === group; })
        .forEach(function (v) { host.appendChild(renderVendorCard(v)); });
    });
  }

  // ── Busy state ───────────────────────────────────────────────────────────

  function humanize(action) {
    var m = actionMeta[action];
    return m ? m.label : action.replace(/-/g, ' ');
  }

  function setBusyBanner(action) {
    if (action) {
      busyBannerEl.textContent = 'Running: ' + humanize(action);
      busyBannerEl.className = 'banner busy';
      busyBannerEl.hidden = false;
    } else {
      busyBannerEl.textContent = '';
      busyBannerEl.hidden = true;
    }
  }

  function applyBusyToButtons() {
    btnDry.disabled = isBusy;
    btnLive.disabled = isBusy || !armLive.checked;
    // btnScan (scan-only) is exempt from the busy-lock server-side, so it stays enabled here too.
    var cardButtons = document.querySelectorAll('.cards button');
    for (var i = 0; i < cardButtons.length; i++) {
      var btn = cardButtons[i];
      var isLive = btn.classList.contains('danger');
      if (isBusy) {
        btn.disabled = true;
      } else if (!isLive) {
        btn.disabled = false;
      }
      // Live buttons re-enable only via their own arm checkbox, handled in renderVendorCard.
    }
  }

  // ── Data ─────────────────────────────────────────────────────────────────

  function schedulePoll() {
    if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; }
    fetchStatus();
  }

  function fetchStatus() {
    fetch('/api/status')
      .then(function (res) { return res.json(); })
      .then(function (status) {
        actionMeta = status.actionMeta || Object.create(null);
        isBusy = !!status.busy;

        renderAttention(status.vendors);
        renderVendors(status.vendors);
        reportNameEl.textContent = status.latestReport || 'no report yet';

        if (status.lastSweep) {
          lastSweepEl.textContent =
            'Last sweep ' + status.lastSweep.runId + ' — ' + status.lastSweep.total +
            ' open txns ($' + (status.lastSweep.cents / 100).toFixed(2) + ')';
        } else {
          lastSweepEl.textContent = 'No sweep recorded yet';
        }

        setBusyBanner(status.busy ? status.busy.action : null);
        applyBusyToButtons();

        // Paused cadence while busy: a 'done' SSE event re-triggers immediately; this slow
        // fallback only guards against a done event that never arrives (e.g. the child runner
        // throwing before broadcastDone), so the panel can never wedge indefinitely.
        pollTimer = setTimeout(fetchStatus, status.busy ? 20000 : 5000);
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

  // ── Console ──────────────────────────────────────────────────────────────

  function isPinnedToBottom() {
    return consoleEl.scrollTop + consoleEl.clientHeight >= consoleEl.scrollHeight - 4;
  }

  function appendConsole(line) {
    var pinned = isPinnedToBottom();
    consoleEl.textContent += line + '\n';
    if (pinned) consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  function showDoneBanner(code) {
    var ok = code === 0;
    var codeText = code === null || code === undefined ? 'terminated' : 'exit ' + code;
    doneBannerEl.className = 'banner ' + (ok ? 'ok' : 'err');
    doneBannerEl.hidden = false;
    var text = 'Finished (' + codeText + ')';
    // Not gated on the label: run-sweep.ts's own child runs can surface a ULINE vendor job's exit
    // code via this same done event, not just a direct "ULINE bootstrap ..." action.
    if (!ok && typeof code === 'number' && ULINE_CODES[code]) text += ' — ' + ULINE_CODES[code];
    doneBannerEl.textContent = text;
  }

  // ── Actions ──────────────────────────────────────────────────────────────

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
        if (result.status === 409) { toast('busy: another action is already running'); return; }
        if (result.status >= 400) {
          toast((result.json && result.json.error) || 'error ' + result.status);
          return;
        }
        var json = result.json || {};
        if (json.launched) {
          // chrome-kind: detached launch, no child tracked server-side, no SSE 'done' to expect.
          toast('Chrome launched: ' + humanize(action));
          return;
        }
        // Disarm after a live action actually fires — arming is per-click, not a mode you leave on.
        if (armed === true) {
          armedCards = Object.create(null);
          armLive.checked = false;
        }
        doneBannerEl.hidden = true;
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
  armLive.addEventListener('change', function () { btnLive.disabled = isBusy || !armLive.checked; });

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
