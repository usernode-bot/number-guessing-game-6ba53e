/**
 * usernode-loading.js — Node-readiness overlay for Usernode dapps.
 * Vendored from usernode-dapp-starter.
 *
 * Usage:
 *   UsernodeLoading.init({ appName: "My App", streamKey: "myapp" })
 */
(function () {
  'use strict';

  if (window.UsernodeLoading) return;

  var ENDPOINT = '/__usernode/node_status';
  var OVERLAY_ID = 'usernode-loading-overlay';
  var STYLE_ID = 'usernode-loading-style';

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '#' + OVERLAY_ID + '{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;',
      'background:rgba(9,9,11,0.92);backdrop-filter:blur(8px);transition:opacity .35s ease;font-family:system-ui,sans-serif;}',
      '@media(prefers-color-scheme:light){#' + OVERLAY_ID + '{background:rgba(240,240,245,0.92);}}',
      '#' + OVERLAY_ID + '.unl-fading{opacity:0;pointer-events:none;}',
      '.unl-card{background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:1rem;',
      'padding:2rem 2.5rem;text-align:center;max-width:22rem;width:90%;}',
      '@media(prefers-color-scheme:light){.unl-card{background:rgba(0,0,0,0.05);border-color:rgba(0,0,0,0.1);}}',
      '.unl-app{font-size:.75rem;letter-spacing:.08em;text-transform:uppercase;opacity:.5;margin-bottom:.5rem;color:#e4e4e7;}',
      '@media(prefers-color-scheme:light){.unl-app{color:#27272a;}}',
      '.unl-title{font-size:1rem;font-weight:600;color:#e4e4e7;margin-bottom:1.25rem;}',
      '@media(prefers-color-scheme:light){.unl-title{color:#18181b;}}',
      '.unl-track{height:4px;background:rgba(255,255,255,0.1);border-radius:2px;overflow:hidden;margin-bottom:.75rem;}',
      '@media(prefers-color-scheme:light){.unl-track{background:rgba(0,0,0,0.1);}}',
      '.unl-fill{height:100%;background:#7c3aed;border-radius:2px;transition:width .4s ease;}',
      '.unl-fill.unl-indeterminate{width:40%!important;animation:unl-pulse 1.6s ease-in-out infinite;}',
      '@keyframes unl-pulse{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}',
      '.unl-meta{font-size:.75rem;color:#71717a;min-height:1.1rem;}',
    ].join('');
    document.head.appendChild(s);
  }

  function buildOverlay(appName) {
    var el = document.createElement('div');
    el.id = OVERLAY_ID;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');

    var card = document.createElement('div');
    card.className = 'unl-card';

    var appEl = document.createElement('div');
    appEl.className = 'unl-app';
    appEl.textContent = appName || 'Loading';

    var title = document.createElement('div');
    title.className = 'unl-title';
    title.textContent = 'Node starting…';

    var track = document.createElement('div');
    track.className = 'unl-track';
    var fill = document.createElement('div');
    fill.className = 'unl-fill unl-indeterminate';
    track.appendChild(fill);

    var meta = document.createElement('div');
    meta.className = 'unl-meta';

    card.appendChild(appEl);
    card.appendChild(title);
    card.appendChild(track);
    card.appendChild(meta);
    el.appendChild(card);
    return { overlay: el, title: title, fill: fill, meta: meta };
  }

  function fetchSnapshot() {
    return fetch(ENDPOINT, { cache: 'no-store' })
      .then(function (r) {
        if (r.status === 404) return { __notWired: true };
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
  }

  function streamGateOk(snap, streamKey) {
    if (!streamKey) return true;
    if (!snap || !snap.streams) return true;
    if (!(streamKey in snap.streams)) return true;
    return snap.streams[streamKey] === true;
  }

  function explorerGateOk(snap) {
    if (!snap || !snap.explorer) return true;
    var s = snap.explorer;
    if (s === 'ok' || s === 'degraded' || s === 'mock' || s === 'unknown') return true;
    if (snap.explorerHasBeenOk) return true;
    return false;
  }

  function shouldDismiss(snap, requireSynced, streamKey) {
    if (!snap) return false;
    if (snap.__notWired) return true;
    if (snap.status === 'mock' || snap.status === 'unknown') return true;
    if (!streamGateOk(snap, streamKey)) return false;
    if (!explorerGateOk(snap)) return false;
    if (snap.status === 'Synced') return true;
    if (!requireSynced && snap.hasBeenSynced &&
        (snap.status === 'Connected' || snap.status === 'Syncing')) return true;
    return false;
  }

  function describeStatus(snap, streamKey) {
    if (!snap) return { title: 'Node starting…', meta: '', percent: 0, indeterminate: true };

    if (snap.explorerDown && !snap.explorerHasBeenOk) {
      return { title: 'Explorer unreachable…', meta: 'Check your connection', percent: 0, indeterminate: true };
    }

    if (!streamGateOk(snap, streamKey) &&
        (snap.status === 'Synced' || snap.status === 'Connected' || snap.status === 'Syncing')) {
      return { title: 'Connecting to live updates…', meta: 'Almost ready', percent: 95, indeterminate: false };
    }

    if (snap.status === 'Synced') {
      return { title: 'Node synced', meta: '', percent: 100, indeterminate: false };
    }
    if (snap.status === 'Syncing') {
      var pct = 0;
      var tip = snap.bestTipHeight || 0;
      var peer = snap.peerBestTipHeight || 0;
      if (peer > 0) pct = Math.min(98, Math.round((tip / peer) * 100));
      var meta = tip && peer ? (tip + ' / ' + peer + ' blocks') : '';
      return { title: 'Syncing…', meta: meta, percent: pct || 10, indeterminate: !pct };
    }
    if (snap.status === 'Connected') {
      var peers = snap.peerCount || 0;
      return { title: 'Node joining network…', meta: peers ? (peers + ' peer' + (peers !== 1 ? 's' : '')) : '', percent: 0, indeterminate: true };
    }
    if (snap.status === 'Connecting') {
      return { title: 'Node connecting to network…', meta: '', percent: 0, indeterminate: true };
    }
    return { title: 'Node starting…', meta: '', percent: 0, indeterminate: true };
  }

  function init(opts) {
    opts = opts || {};
    var appName = opts.appName || 'Loading';
    var pollIntervalMs = opts.pollIntervalMs || 500;
    var requireSynced = opts.requireSynced || false;
    var streamKey = opts.streamKey || null;
    var onStatusChange = opts.onStatusChange || null;

    var dismissed = false;
    var pollTimer = null;
    var ui = null;
    var lastSnapshotJson = '';

    // LOCAL DIVERGENCE from the vendored usernode-dapp-starter copy: upstream
    // gates the overlay behind window.usernode.isMockEnabled() and skips it in
    // mock mode. This app runs exclusively in live Usernode DApps mode (no mock
    // layer — see the /__mock/enabled route in server.js), so that branch is
    // dead weight here and is removed; we always run the overlay/poll path.
    // If this file is ever re-vendored, drop the isMockEnabled branch again.
    {
      function ensureOverlayMounted() {
        if (ui) return;
        injectStyle();
        ui = buildOverlay(appName);
        document.body.appendChild(ui.overlay);
      }

      function applyDescription(desc) {
        if (!ui) return;
        ui.title.textContent = desc.title;
        ui.meta.textContent = desc.meta || '';
        if (desc.indeterminate) {
          ui.fill.classList.add('unl-indeterminate');
          ui.fill.style.width = '';
        } else {
          ui.fill.classList.remove('unl-indeterminate');
          ui.fill.style.width = desc.percent + '%';
        }
      }

      function dismiss() {
        if (dismissed) return;
        dismissed = true;
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        if (!ui) return;
        ui.overlay.classList.add('unl-fading');
        setTimeout(function () {
          if (ui && ui.overlay.parentNode) ui.overlay.parentNode.removeChild(ui.overlay);
        }, 400);
      }

      function fireStatusChange(snap) {
        if (!onStatusChange) return;
        var key = JSON.stringify({ status: snap.status, streams: snap.streams, explorer: snap.explorer });
        if (key === lastSnapshotJson) return;
        lastSnapshotJson = key;
        try { onStatusChange(snap); } catch {}
      }

      function tick() {
        fetchSnapshot().then(function (snap) {
          fireStatusChange(snap);
          if (shouldDismiss(snap, requireSynced, streamKey)) {
            dismiss();
          } else {
            ensureOverlayMounted();
            applyDescription(describeStatus(snap, streamKey));
          }
        }).catch(function (e) {
          console.warn('[UsernodeLoading] status fetch failed:', e.message);
          ensureOverlayMounted();
        });
      }

      // Initial fetch
      fetchSnapshot().then(function (snap) {
        fireStatusChange(snap);
        if (shouldDismiss(snap, requireSynced, streamKey)) {
          // Already ready — no overlay needed, start polling for regressions
          pollTimer = setInterval(tick, pollIntervalMs * 8);
        } else {
          ensureOverlayMounted();
          applyDescription(describeStatus(snap, streamKey));
          pollTimer = setInterval(tick, pollIntervalMs);
        }
      }).catch(function (e) {
        console.warn('[UsernodeLoading] initial fetch failed:', e.message);
        ensureOverlayMounted();
        pollTimer = setInterval(tick, pollIntervalMs);
      });
    }
  }

  window.UsernodeLoading = { init: init };
})();
