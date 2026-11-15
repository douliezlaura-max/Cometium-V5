(function () {
// Console page -- live worker log tail over Supabase realtime.
//
// Table name: public.logs (fn_worker_log in migration v02 inserts into
// it; the spec calls it `worker_logs` for shorthand but there is no
// table by that name in this project -- grep over supabase/migrations
// confirms `logs` is the only match). Added to the supabase_realtime
// publication in migration v30.
//
// Flow: F.realtime.subscribe('logs', {owner_id=F.ownerId}, onInsert).
// Rows append to a scrolling <pre>, capped at 500 lines (trim from the
// head). Pause holds new inserts in a buffer and flushes on resume;
// Clear empties the view (never touches the DB).
window.F = window.F || {};
F.pages = F.pages || {};

var MAX_LINES  = 500;
var CHANNELS   = ["info", "warn", "error", "system", "micro", "metrics", "other"];
var DEFAULT_ON = { info: true, warn: true, error: true, system: true, micro: false, metrics: false, other: true };

F.pages.console = async function (view) {
  var s = {
    deviceId:  "",
    accountId: "",
    text:      "",
    channels:  Object.assign({}, DEFAULT_ON),
    paused:    false,
    autoscroll: true,
    rows:      [],       // rendered rows (<= MAX_LINES)
    buffer:    [],       // held while paused
    sub:       null,
  };

  view.innerHTML =
    '<h1>Console</h1>' +
    '<div class="card">' +
      '<div class="card-h cons-bar">' +
        '<select class="input cons-sel" id="c-dev"><option value="">all devices</option></select>' +
        '<select class="input cons-sel" id="c-acc"><option value="">all accounts</option></select>' +
        '<input  class="input cons-txt" id="c-txt" type="text" placeholder="filter text..." autocomplete="off" />' +
        '<div class="cons-chans" id="c-chans">' +
          CHANNELS.map(function (c) {
            return '<label class="cons-chan" data-c="' + c + '">' +
                   '<input type="checkbox" data-c="' + c + '"' + (DEFAULT_ON[c] ? ' checked' : '') + ' />' +
                   '<span class="cons-chan-tag cons-c-' + c + '">' + c + '</span>' +
                   '</label>';
          }).join("") +
        '</div>' +
        '<div class="spacer"></div>' +
        '<button class="btn" id="c-pause"  title="hold new inserts">Pause</button>' +
        '<button class="btn" id="c-clear"  title="empty the view (does not delete rows)">Clear</button>' +
        '<label class="cons-auto"><input type="checkbox" id="c-auto" checked /> autoscroll</label>' +
      '</div>' +
      '<div class="cons-meta">' +
        '<span id="c-count">0</span> / ' + MAX_LINES + ' lines' +
        '<span class="cons-sep">&middot;</span>' +
        '<span id="c-state" class="muted">live</span>' +
        '<span id="c-held"  class="muted"></span>' +
      '</div>' +
      '<pre class="cons-view" id="c-view"><div class="muted cons-empty">no log lines yet. tail will populate here as workers write.</div></pre>' +
    '</div>';

  // ----- fill filter dropdowns ---------------------------------------
  try {
    var devRes = await F.sbTable("devices").select("id,name").order("name");
    var accRes = await F.sbTable("accounts").select("id,username").order("username").limit(500);
    fillSelect("c-dev", (devRes.data || []).map(function (d) { return [d.id, d.name]; }));
    fillSelect("c-acc", (accRes.data || []).map(function (a) { return [a.id, a.username]; }));
  } catch (e) {
    console.warn("[console] fill dropdowns failed:", e);
  }

  // ----- wire filters -------------------------------------------------
  view.querySelector("#c-dev").addEventListener("change", function (e) { s.deviceId  = e.target.value; });
  view.querySelector("#c-acc").addEventListener("change", function (e) { s.accountId = e.target.value; });

  var onText = F.debounce(function (val) { s.text = val.trim().toLowerCase(); rerender(s); }, 150);
  view.querySelector("#c-txt").addEventListener("input", function (e) { onText(e.target.value); });

  Array.prototype.forEach.call(view.querySelectorAll("#c-chans input"), function (cb) {
    cb.addEventListener("change", function (e) {
      s.channels[e.target.dataset.c] = e.target.checked;
      rerender(s);
    });
  });

  view.querySelector("#c-auto").addEventListener("change", function (e) { s.autoscroll = e.target.checked; });

  // Pause: hold new inserts; on resume, replay the buffer (respecting
  // MAX_LINES and filters) and keep tailing.
  var pauseBtn = view.querySelector("#c-pause");
  pauseBtn.addEventListener("click", function () {
    s.paused = !s.paused;
    pauseBtn.textContent = s.paused ? "Resume" : "Pause";
    pauseBtn.classList.toggle("primary", s.paused);
    var state = document.getElementById("c-state");
    if (state) {
      state.textContent = s.paused ? "paused" : "live";
      state.classList.toggle("warn", s.paused);
    }
    if (!s.paused) {
      // Flush buffer into rows, then render.
      if (s.buffer.length) {
        for (var i = 0; i < s.buffer.length; i++) {
          s.rows.push(s.buffer[i]);
          if (s.rows.length > MAX_LINES) s.rows.shift();
        }
        s.buffer.length = 0;
      }
      updateHeld(s);
      rerender(s);
    }
  });

  view.querySelector("#c-clear").addEventListener("click", function () {
    s.rows = [];
    s.buffer = [];
    updateHeld(s);
    rerender(s);
  });

  // ----- realtime subscribe ------------------------------------------
  // F.ownerId is set in app.js once auth resolves. If the page is
  // reached before auth finishes (edge case on hard reload) fall back
  // to no owner filter and let RLS do the gating server-side.
  var filter = F.ownerId ? { owner_id: F.ownerId } : null;

  s.sub = F.realtime.subscribe(
    "logs",
    filter,
    function onInsert(row) {
      if (s.paused) {
        s.buffer.push(row);
        // Also cap the buffer so a long pause does not grow unbounded.
        if (s.buffer.length > MAX_LINES * 2) s.buffer.shift();
        updateHeld(s);
        return;
      }
      s.rows.push(row);
      if (s.rows.length > MAX_LINES) s.rows.shift();
      appendRowOrRerender(s, row);
    },
    null, // onUpdate: logs are insert-only
    null  // onDelete: pruning is a cron, not user-visible
  );

  // Clean up on nav away.
  window.addEventListener("hashchange", function onHash() {
    window.removeEventListener("hashchange", onHash);
    if (s.sub) { try { s.sub.unsubscribe(); } catch (e) { /* no-op */ } s.sub = null; }
  });
};

// Fast path: when the view has not been fully rerendered (same filter
// set) and the new row would pass the filters, append it to the <pre>
// and trim the head. Otherwise fall back to a full rerender from s.rows
// so filter changes and trimmed rows stay consistent.
function appendRowOrRerender(s, row) {
  var el = document.getElementById("c-view");
  if (!el) return;

  // Drop the "no lines yet" placeholder on first live row.
  var empty = el.querySelector(".cons-empty");
  if (empty) empty.remove();

  if (!rowPasses(s, row)) {
    updateCount(s);
    return;
  }

  // If we trimmed a row from the head, drop the first child to match.
  if (el.children.length >= MAX_LINES) {
    while (el.children.length >= MAX_LINES && el.firstChild) el.removeChild(el.firstChild);
  }

  el.appendChild(buildRow(row));
  trimDomToVisibleWindow(el);
  updateCount(s);
  if (s.autoscroll) el.scrollTop = el.scrollHeight;
}

function trimDomToVisibleWindow(el) {
  while (el.children.length > MAX_LINES && el.firstChild) el.removeChild(el.firstChild);
}

function rerender(s) {
  var el = document.getElementById("c-view");
  if (!el) return;

  var visible = s.rows.filter(function (r) { return rowPasses(s, r); });

  if (!visible.length) {
    el.innerHTML = '<div class="muted cons-empty">' +
      (s.rows.length ? "no lines match the current filters." : "no log lines yet. tail will populate here as workers write.") +
      '</div>';
    updateCount(s);
    return;
  }

  // Build with a fragment so one reflow instead of N.
  var frag = document.createDocumentFragment();
  for (var i = 0; i < visible.length; i++) frag.appendChild(buildRow(visible[i]));
  el.innerHTML = "";
  el.appendChild(frag);
  updateCount(s);
  if (s.autoscroll) el.scrollTop = el.scrollHeight;
}

function rowPasses(s, r) {
  if (!r) return false;
  var ch = r.channel || "other";
  if (!(ch in s.channels)) ch = "other";
  if (!s.channels[ch]) return false;
  if (s.deviceId  && r.device_id  !== s.deviceId)  return false;
  if (s.accountId && r.account_id !== s.accountId) return false;
  if (s.text) {
    var hay = String(r.text || "").toLowerCase();
    if (hay.indexOf(s.text) === -1) return false;
  }
  return true;
}

function buildRow(r) {
  var ch = r.channel || "other";
  if (["info", "warn", "error", "system", "micro", "metrics", "other"].indexOf(ch) === -1) ch = "other";

  var ts;
  var d = new Date(r.at);
  var yr = d.getFullYear();
  if (!r.at || isNaN(d.getTime()) || yr < 2000 || yr > 9999) {
    ts = "--:--:--";
  } else {
    ts = pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
  }

  var line = document.createElement("div");
  line.className = "cons-line cons-c-" + ch;
  line.innerHTML =
    '<span class="cons-ts">' + ts + '</span>' +
    '<span class="cons-ch">' + padRight(ch, 7) + '</span>' +
    '<span class="cons-msg">' + F.esc(r.text || "") + '</span>';
  return line;
}

function pad2(n) { n = String(n); return n.length < 2 ? "0" + n : n; }
function padRight(s, n) { s = String(s); while (s.length < n) s = s + " "; return s; }

function updateCount(s) {
  var c = document.getElementById("c-count");
  if (c) c.textContent = String(s.rows.length);
}

function updateHeld(s) {
  var el = document.getElementById("c-held");
  if (!el) return;
  if (s.paused && s.buffer.length) {
    el.textContent = " - " + s.buffer.length + " held";
    el.classList.remove("muted");
    el.classList.add("warn");
  } else {
    el.textContent = "";
    el.classList.add("muted");
    el.classList.remove("warn");
  }
}

function fillSelect(id, pairs) {
  var el = document.getElementById(id);
  if (!el) return;
  var first = el.querySelector("option");
  el.innerHTML = "";
  if (first) el.appendChild(first);
  for (var i = 0; i < pairs.length; i++) {
    var o = document.createElement("option");
    o.value = pairs[i][0];
    o.textContent = pairs[i][1] || pairs[i][0];
    el.appendChild(o);
  }
}

})();
