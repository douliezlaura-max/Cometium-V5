(function () {
// Jobs inspector dashboard page.
// Route: #/jobs. Shows every job in the workspace with filters +
// server pagination (50/page), a side detail panel with the full
// payload/result/logs, and per-row Retry/Cancel/Inspect buttons. Live
// via F.realtime on the jobs table (owner-scoped).
//
// Error / log notes:
//   * jobs has no error_text column -- errors live inside result jsonb
//     (keys we commonly see: error, error_text, message, stack). The
//     detail panel surfaces them as a dedicated "Error" block when
//     result.error/result.message is set; the raw result is also
//     printed so nothing is hidden.
//   * public.logs has no job_id column (see 20260101000001_base.sql);
//     per-job logs are fetched by (device_id, account_id) within the
//     job's taken_at..finished_at window, plus a small +/- buffer
//     when one of those timestamps is null. Good enough for "what did
//     the worker say while running this job" without a schema change.
window.F = window.F || {};
F.pages = F.pages || {};

var PAGE_SIZE = 50;
var STATUSES  = ["pending", "taken", "done", "failed"];

// ---- module-level handle so re-mounts tear down the previous sub ----
var _jobsSub = null;
function teardownJobs() {
  if (_jobsSub) {
    try { _jobsSub.unsubscribe(); } catch (e) { /* no-op */ }
    _jobsSub = null;
  }
}

F.pages.jobs = async function (view) {
  teardownJobs();

  var s = {
    page: 1,
    total: 0,
    rows: [],
    // caches populated once per mount (devices + accounts don't change
    // often enough to re-fetch on every page flip).
    accountsById: {},
    devicesById:  {},
    // filter state
    statuses: new Set(),            // empty = all
    kinds:    new Set(),            // empty = all
    acctQ:    "",
    dateFrom: "",                   // yyyy-mm-dd
    dateTo:   "",
    // list of kinds the user has seen so the kind multiselect has
    // sane options -- populated from the first batch of rows + any
    // live INSERTs that mention a new kind.
    knownKinds: new Set(),
    // currently selected detail job (bigint id as string)
    selectedId: null,
    selectedJob: null,
  };

  view.innerHTML = shellHtml();

  // Populate accounts + devices maps once up front. Capped at 5000 to
  // match accounts.js / logs.js -- more than that and this page is
  // not where the user should be anyway.
  var ctx = await Promise.all([
    F.sbTable("accounts").select("id,username").limit(5000),
    F.sbTable("devices").select("id,name").limit(500),
  ]);
  (ctx[0].data || []).forEach(function (a) { s.accountsById[a.id] = a; });
  (ctx[1].data || []).forEach(function (d) { s.devicesById[d.id] = d; });

  // Wire filters.
  bindFilters(view, s, refresh);

  function refresh() { return load(s); }

  await refresh();

  // ---- realtime: jobs table, owner-scoped ----
  var filter = F.ownerId ? { owner_id: F.ownerId } : null;
  var debouncedReload = F.debounce(function () { load(s); }, 400);

  _jobsSub = F.realtime.subscribe(
    "jobs",
    filter,
    function onInsert(row) {
      remember(row, s);
      // A new job always lands on page 1 (ordered by created_at desc).
      // Reload so count + ordering stay correct; cheaper than trying
      // to splice while respecting every filter.
      debouncedReload();
    },
    function onUpdate(row) {
      remember(row, s);
      // Patch the visible row in place for the fast-path (status
      // flips from pending -> taken -> done/failed are the hot case).
      var patched = patchRow(row, s);
      if (!patched) {
        // Row isn't on the current page; filters may have changed
        // whether it should be. Reconcile.
        debouncedReload();
      }
      // If this row is the open detail, refresh the detail view.
      if (s.selectedId && String(row.id) === String(s.selectedId)) {
        s.selectedJob = row;
        renderDetail(s);
      }
    },
    function onDelete(oldRow) {
      if (!oldRow) return;
      var tr = document.querySelector('tr[data-jid="' + CSS.escape(String(oldRow.id)) + '"]');
      if (tr) tr.remove();
      if (s.selectedId && String(oldRow.id) === String(s.selectedId)) {
        closeDetail(s);
      }
      debouncedReload();
    },
    { onFallback: function () { load(s); }, pollMs: 30000 }
  );

  window.addEventListener("hashchange", teardownJobs, { once: true });
};

// ---------------------------------------------------------------------
// shell + filters
// ---------------------------------------------------------------------
function shellHtml() {
  return ''
    + '<h1>Jobs</h1>'
    + '<div class="card">'
    +   '<div class="card-h">'
    +     'Filter'
    +     '<div class="spacer"></div>'
    +     '<button class="btn" id="btn-clear">Clear</button>'
    +   '</div>'
    +   '<div class="jobs-filters">'
    +     dropdownHtml("status", "Status", STATUSES)
    +     dropdownHtml("kind",   "Kind",   [])
    +     '<input class="input" id="f-account" placeholder="account username contains..." autocomplete="off" />'
    +     '<input class="input" id="f-from" type="date" title="created_at from (inclusive)" />'
    +     '<input class="input" id="f-to"   type="date" title="created_at to (inclusive)" />'
    +   '</div>'
    + '</div>'
    + '<div class="jobs-wrap" id="jobs-wrap" data-detail="false">'
    +   '<div class="card">'
    +     '<div class="card-h">'
    +       '<span id="count">0</span> jobs'
    +       '<div class="spacer"></div>'
    +       '<span class="muted" id="page-lbl">page 1</span>'
    +     '</div>'
    +     '<table class="tbl jobs-tbl">'
    +       '<thead><tr>'
    +         '<th style="width:80px">ID</th>'
    +         '<th>Kind</th>'
    +         '<th style="width:100px">Status</th>'
    +         '<th style="width:60px">Pri</th>'
    +         '<th>Account</th>'
    +         '<th>Device</th>'
    +         '<th style="width:150px">Created</th>'
    +         '<th style="width:150px">Finished</th>'
    +         '<th style="width:80px">ms</th>'
    +         '<th style="width:220px"></th>'
    +       '</tr></thead>'
    +       '<tbody id="rows"><tr><td colspan="10" class="empty">loading...</td></tr></tbody>'
    +     '</table>'
    +     '<div class="jobs-pager" id="pager"></div>'
    +   '</div>'
    +   '<div id="detail-slot"></div>'
    + '</div>';
}

function dropdownHtml(key, label, items) {
  var itemsHtml = items.map(function (v) {
    return '<label><input type="checkbox" data-v="' + F.esc(v) + '" />'
         +   '<span class="pill" data-js="' + F.esc(v) + '">'
         +     '<span class="pill-dot"></span>' + F.esc(v)
         +   '</span>'
         + '</label>';
  }).join("");
  return ''
    + '<div class="chk-dd" data-key="' + F.esc(key) + '" data-open="false">'
    +   '<button class="chk-dd-btn" type="button">'
    +     '<span class="lbl">' + F.esc(label) + '</span>'
    +     '<span class="val muted">all</span>'
    +     '<span class="caret">v</span>'
    +   '</button>'
    +   '<div class="chk-dd-panel" data-items>' + itemsHtml + '</div>'
    + '</div>';
}

function bindFilters(view, s, refresh) {
  // Toggle dropdowns.
  view.querySelectorAll(".chk-dd .chk-dd-btn").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var dd = btn.parentElement;
      var open = dd.getAttribute("data-open") === "true";
      // Close siblings first.
      view.querySelectorAll('.chk-dd[data-open="true"]').forEach(function (o) {
        o.setAttribute("data-open", "false");
      });
      dd.setAttribute("data-open", open ? "false" : "true");
    });
  });
  // Close dropdowns on outside click.
  document.addEventListener("click", function onDocClick(e) {
    var any = view.querySelector('.chk-dd[data-open="true"]');
    if (!any) return;
    if (!e.target.closest || !e.target.closest(".chk-dd")) {
      view.querySelectorAll('.chk-dd[data-open="true"]').forEach(function (o) {
        o.setAttribute("data-open", "false");
      });
    }
  });

  // Status checkboxes.
  view.querySelector('.chk-dd[data-key="status"]').addEventListener("change", function (e) {
    var cb = e.target;
    if (cb.tagName !== "INPUT") return;
    if (cb.checked) s.statuses.add(cb.dataset.v); else s.statuses.delete(cb.dataset.v);
    updateDropdownLabel(view, "status", s.statuses);
    s.page = 1;
    refresh();
  });

  // Kind checkboxes -- the list is populated lazily by load().
  view.querySelector('.chk-dd[data-key="kind"]').addEventListener("change", function (e) {
    var cb = e.target;
    if (cb.tagName !== "INPUT") return;
    if (cb.checked) s.kinds.add(cb.dataset.v); else s.kinds.delete(cb.dataset.v);
    updateDropdownLabel(view, "kind", s.kinds);
    s.page = 1;
    refresh();
  });

  var onAcct = F.debounce(function (val) {
    s.acctQ = String(val || "").trim().toLowerCase();
    s.page = 1;
    refresh();
  }, 250);
  view.querySelector("#f-account").addEventListener("input", function (e) { onAcct(e.target.value); });

  view.querySelector("#f-from").addEventListener("change", function (e) {
    s.dateFrom = e.target.value || ""; s.page = 1; refresh();
  });
  view.querySelector("#f-to").addEventListener("change", function (e) {
    s.dateTo = e.target.value || ""; s.page = 1; refresh();
  });

  view.querySelector("#btn-clear").addEventListener("click", function () {
    s.statuses.clear(); s.kinds.clear();
    s.acctQ = ""; s.dateFrom = ""; s.dateTo = "";
    s.page = 1;
    view.querySelectorAll('.chk-dd input[type="checkbox"]').forEach(function (cb) { cb.checked = false; });
    view.querySelector("#f-account").value = "";
    view.querySelector("#f-from").value = "";
    view.querySelector("#f-to").value = "";
    updateDropdownLabel(view, "status", s.statuses);
    updateDropdownLabel(view, "kind",   s.kinds);
    refresh();
  });
}

function updateDropdownLabel(view, key, set) {
  var el = view.querySelector('.chk-dd[data-key="' + key + '"] .val');
  if (!el) return;
  if (!set.size) { el.textContent = "all"; el.classList.add("muted"); return; }
  var arr = [].concat.apply([], [[].slice.call(set)]);
  el.classList.remove("muted");
  el.textContent = arr.length <= 2 ? arr.join(", ") : (arr.length + " selected");
}

// ---------------------------------------------------------------------
// data loading
// ---------------------------------------------------------------------
async function load(s) {
  // Account filter: resolve to a set of account_ids first so we can
  // push the filter into the server query (jobs.account_id in [...]).
  // The username field is on accounts, not jobs; without this step the
  // filter would be client-only and rows past the visible page would
  // never match.
  var acctIds = null;
  if (s.acctQ) {
    try {
      var r = await F.sbTable("accounts")
        .select("id,username")
        .ilike("username", "%" + s.acctQ + "%")
        .limit(500);
      acctIds = (r.data || []).map(function (a) { return a.id; });
      // Keep the local name cache warm.
      (r.data || []).forEach(function (a) { s.accountsById[a.id] = a; });
      if (!acctIds.length) {
        s.rows = []; s.total = 0; render(s); return;
      }
    } catch (e) {
      // best-effort; fall back to no account filter rather than stalling.
      acctIds = null;
    }
  }

  var from = (s.page - 1) * PAGE_SIZE;
  var to   = from + PAGE_SIZE - 1;

  var q = F.sbTable("jobs")
    .select("id,kind,status,priority,account_id,device_id,payload,result,created_at,taken_at,finished_at,attempts,max_attempts,tags,depends_on,reserved_until", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, to);

  if (s.statuses.size) q = q.in("status", [].concat.apply([], [[].slice.call(s.statuses)]));
  if (s.kinds.size)    q = q.in("kind",   [].concat.apply([], [[].slice.call(s.kinds)]));
  if (acctIds)         q = q.in("account_id", acctIds);
  if (s.dateFrom) {
    // Start of the chosen day, UTC. Good enough for a dashboard
    // filter; exact timezone precision is not worth the complexity.
    q = q.gte("created_at", s.dateFrom + "T00:00:00Z");
  }
  if (s.dateTo) {
    q = q.lte("created_at", s.dateTo + "T23:59:59.999Z");
  }

  var res = await q;
  if (res.error) { F.toast(res.error.message, "err"); return; }

  s.rows  = res.data || [];
  s.total = res.count || 0;

  // Remember known kinds + refresh the Kind dropdown's options.
  s.rows.forEach(function (r) { if (r.kind) s.knownKinds.add(r.kind); });
  rebuildKindDropdown(s);

  render(s);
}

function rebuildKindDropdown(s) {
  var panel = document.querySelector('.chk-dd[data-key="kind"] [data-items]');
  if (!panel) return;
  // Preserve current checked set.
  var checked = new Set(s.kinds);
  var items = [].slice.call(s.knownKinds).sort();
  panel.innerHTML = items.map(function (v) {
    var on = checked.has(v) ? " checked" : "";
    return '<label><input type="checkbox" data-v="' + F.esc(v) + '"' + on + ' />'
         +   '<span class="pill">' + F.esc(v) + '</span>'
         + '</label>';
  }).join("") || '<div class="muted small" style="padding:4px 6px">no kinds seen yet</div>';
}

// ---------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------
function render(s) {
  var countEl = document.getElementById("count");
  if (countEl) countEl.textContent = String(s.total);

  var body = document.getElementById("rows");
  if (!body) return;

  if (!s.rows.length) {
    body.innerHTML = '<tr><td colspan="10" class="empty">no jobs match the filters</td></tr>';
    renderPager(s);
    return;
  }

  body.innerHTML = s.rows.map(function (r) { return rowHtml(r, s); }).join("");

  // Row click -> open detail. Delegate on tbody.
  body.onclick = function (e) {
    var btn = e.target.closest ? e.target.closest("button[data-a]") : null;
    if (btn) {
      e.stopPropagation();
      var id = btn.closest("tr").dataset.jid;
      if (btn.dataset.a === "retry")   return retryJob(id, s);
      if (btn.dataset.a === "cancel")  return cancelJob(id, s);
      if (btn.dataset.a === "inspect") return openDetail(id, s);
      return;
    }
    var tr = e.target.closest ? e.target.closest("tr[data-jid]") : null;
    if (tr) openDetail(tr.dataset.jid, s);
  };

  renderPager(s);
}

function rowHtml(r, s) {
  var acc = r.account_id ? s.accountsById[r.account_id] : null;
  var dev = r.device_id  ? s.devicesById[r.device_id]   : null;
  var ms  = msElapsed(r);
  var pri = Number(r.priority || 0);
  var selected = s.selectedId && String(r.id) === String(s.selectedId) ? "true" : "false";
  return ''
    + '<tr data-jid="' + F.esc(String(r.id)) + '" data-selected="' + selected + '">'
    +   '<td class="id">#' + F.esc(String(r.id)) + '</td>'
    +   '<td class="job-kind">' + F.esc(r.kind || "-") + '</td>'
    +   '<td><span class="pill" data-js="' + F.esc(r.status) + '"><span class="pill-dot"></span>' + F.esc(r.status) + '</span></td>'
    +   '<td><span class="job-pri" data-hi="' + (pri >= 7 ? "true" : "false") + '">' + F.esc(String(pri)) + '</span></td>'
    +   '<td>' + (acc ? F.esc(acc.username) : '<span class="muted">-</span>') + '</td>'
    +   '<td>' + (dev ? F.esc(dev.name)     : '<span class="muted">-</span>') + '</td>'
    +   '<td class="mono">' + F.esc(fmtDate(r.created_at))  + '</td>'
    +   '<td class="mono">' + F.esc(fmtDate(r.finished_at)) + '</td>'
    +   '<td class="mono">' + (ms == null ? '<span class="muted">-</span>' : F.esc(ms + " ms")) + '</td>'
    +   '<td class="cell-actions">'
    +     actionButtonsHtml(r)
    +   '</td>'
    + '</tr>';
}

function actionButtonsHtml(r) {
  var canRetry  = r.status === "failed" || r.status === "done";
  var canCancel = r.status === "pending" || r.status === "taken";
  var out = "";
  if (canRetry)  out += '<button class="btn" data-a="retry"  title="reset to pending, attempts=0">Retry</button>';
  if (canCancel) out += '<button class="btn danger" data-a="cancel" title="mark as failed">Cancel</button>';
  out += '<button class="btn" data-a="inspect" title="open detail panel">Inspect</button>';
  return out;
}

function renderPager(s) {
  var pager = document.getElementById("pager");
  var lbl   = document.getElementById("page-lbl");
  if (!pager) return;

  var pages = Math.max(1, Math.ceil(s.total / PAGE_SIZE));
  if (lbl) lbl.textContent = "page " + s.page + " / " + pages;

  if (pages <= 1) { pager.innerHTML = ""; return; }

  pager.innerHTML = ''
    + '<button class="btn" id="pg-prev" ' + (s.page <= 1 ? "disabled" : "") + '>&lsaquo; prev</button>'
    + '<span class="muted">' + s.page + ' / ' + pages + '</span>'
    + '<button class="btn" id="pg-next" ' + (s.page >= pages ? "disabled" : "") + '>next &rsaquo;</button>';

  var prev = pager.querySelector("#pg-prev");
  var next = pager.querySelector("#pg-next");
  if (prev) prev.addEventListener("click", function () {
    if (s.page > 1) { s.page -= 1; load(s); }
  });
  if (next) next.addEventListener("click", function () {
    if (s.page < pages) { s.page += 1; load(s); }
  });
}

function patchRow(row, s) {
  var tr = document.querySelector('tr[data-jid="' + CSS.escape(String(row.id)) + '"]');
  if (!tr) return false;
  // Rebuild the row in-place. Cheap, and avoids stale cells when
  // multiple fields change at once (status + finished_at + result).
  var fresh = F.el(rowHtml(row, s));
  tr.replaceWith(fresh);
  // Keep the local cache in sync so the next full render doesn't
  // overwrite the patch with stale data.
  var i = s.rows.findIndex(function (x) { return String(x.id) === String(row.id); });
  if (i >= 0) s.rows[i] = Object.assign({}, s.rows[i], row);
  return true;
}

function remember(row, s) {
  if (row && row.kind) s.knownKinds.add(row.kind);
}

// ---------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------
async function retryJob(id, s) {
  if (!(await F.confirm("Retry job #" + id + "? This resets attempts to 0 and re-queues it."))) return;
  var res = await F.sb.rpc("fn_retry_job", { p_token: null, p_job_id: Number(id) });
  if (res.error) return F.toast(res.error.message, "err");
  F.toast("job #" + id + " re-queued");
  // Realtime will patch the row, but reload too in case the row is
  // paged off-screen and the user wants the fresh order.
  load(s);
}

async function cancelJob(id, s) {
  if (!(await F.confirm("Cancel job #" + id + "? It will be marked failed."))) return;
  var res = await F.sb.rpc("fn_cancel_job", { p_token: null, p_job_id: Number(id) });
  if (res.error) return F.toast(res.error.message, "err");
  F.toast("job #" + id + " canceled");
  load(s);
}

// ---------------------------------------------------------------------
// detail side panel
// ---------------------------------------------------------------------
async function openDetail(id, s) {
  s.selectedId = String(id);
  // Pull the fresh row + its logs. If we already have it in s.rows use
  // that as the seed so the panel paints instantly; still re-fetch for
  // freshness.
  var seed = s.rows.find(function (r) { return String(r.id) === String(id); });
  s.selectedJob = seed || null;
  renderDetail(s, { loading: !seed });

  var res = await F.sbTable("jobs")
    .select("id,kind,status,priority,account_id,device_id,payload,result,created_at,taken_at,finished_at,attempts,max_attempts,tags,depends_on,reserved_until")
    .eq("id", Number(id))
    .maybeSingle();
  if (res.error) { F.toast(res.error.message, "err"); return; }
  if (!res.data) { F.toast("job #" + id + " not found", "err"); closeDetail(s); return; }
  s.selectedJob = res.data;

  // Mark the row as selected.
  document.querySelectorAll('.jobs-tbl tr[data-selected="true"]').forEach(function (tr) {
    tr.setAttribute("data-selected", "false");
  });
  var trSel = document.querySelector('tr[data-jid="' + CSS.escape(String(id)) + '"]');
  if (trSel) trSel.setAttribute("data-selected", "true");

  renderDetail(s);
  loadJobLogs(s.selectedJob, s);
}

function closeDetail(s) {
  s.selectedId = null;
  s.selectedJob = null;
  var slot = document.getElementById("detail-slot");
  if (slot) slot.innerHTML = "";
  var wrap = document.getElementById("jobs-wrap");
  if (wrap) wrap.setAttribute("data-detail", "false");
  document.querySelectorAll('.jobs-tbl tr[data-selected="true"]').forEach(function (tr) {
    tr.setAttribute("data-selected", "false");
  });
}

function renderDetail(s, opts) {
  opts = opts || {};
  var slot = document.getElementById("detail-slot");
  var wrap = document.getElementById("jobs-wrap");
  if (!slot || !wrap) return;
  wrap.setAttribute("data-detail", "true");

  var j = s.selectedJob;
  if (!j) {
    slot.innerHTML = ''
      + '<div class="jobs-detail">'
      +   '<div class="jobs-detail-h">Job #' + F.esc(String(s.selectedId || "")) + '<div class="spacer"></div><span class="close" id="d-close">x</span></div>'
      +   '<div class="muted">' + (opts.loading ? "loading..." : "not found") + '</div>'
      + '</div>';
    var x = document.getElementById("d-close");
    if (x) x.addEventListener("click", function () { closeDetail(s); });
    return;
  }

  var acc = j.account_id ? s.accountsById[j.account_id] : null;
  var dev = j.device_id  ? s.devicesById[j.device_id]   : null;
  var ms  = msElapsed(j);
  var err = extractError(j.result);

  var payloadStr = prettyJson(j.payload);
  var resultStr  = prettyJson(j.result);
  var errHtml = err
    ? ('<div class="jobs-detail-section">'
        + '<h3>Error</h3>'
        + '<pre class="jobs-code err">' + F.esc(err) + '</pre>'
      + '</div>')
    : '';
  var retryBtn = (j.status === "failed" || j.status === "done")
    ? '<button class="btn primary" data-a="retry">Retry</button>'
    : '';
  var cancelBtn = (j.status === "pending" || j.status === "taken")
    ? '<button class="btn danger" data-a="cancel">Cancel</button>'
    : '';

  slot.innerHTML = ''
    + '<div class="jobs-detail">'
    +   '<div class="jobs-detail-h">'
    +     'Job #' + F.esc(String(j.id))
    +     '<div class="spacer"></div>'
    +     '<span class="close" id="d-close" title="close">x</span>'
    +   '</div>'

    +   '<div class="jobs-detail-meta">'
    +     metaRow("Kind",       F.esc(j.kind || "-"))
    +     metaRow("Status",     '<span class="pill" data-js="' + F.esc(j.status) + '"><span class="pill-dot"></span>' + F.esc(j.status) + '</span>')
    +     metaRow("Priority",   F.esc(String(j.priority || 0)))
    +     metaRow("Attempts",   F.esc(String(j.attempts || 0)) + ' / ' + F.esc(String(j.max_attempts || 0)))
    +     metaRow("Account",    acc ? F.esc(acc.username) : '<span class="muted">-</span>')
    +     metaRow("Device",     dev ? F.esc(dev.name)     : '<span class="muted">-</span>')
    +     metaRow("Tags",       (j.tags && j.tags.length) ? j.tags.map(function (t) { return '<span class="pill">' + F.esc(t) + '</span>'; }).join(" ") : '<span class="muted">-</span>')
    +     metaRow("Depends on", j.depends_on ? '#' + F.esc(String(j.depends_on)) : '<span class="muted">-</span>')
    +     metaRow("Created",    F.esc(fmtDate(j.created_at, true)))
    +     metaRow("Taken",      F.esc(fmtDate(j.taken_at, true)))
    +     metaRow("Finished",   F.esc(fmtDate(j.finished_at, true)))
    +     metaRow("Reserved",   F.esc(fmtDate(j.reserved_until, true)))
    +     metaRow("Elapsed",    ms == null ? '<span class="muted">-</span>' : F.esc(ms + " ms"))
    +   '</div>'

    +   '<div class="jobs-detail-actions">'
    +     retryBtn
    +     cancelBtn
    +   '</div>'
    +   errHtml
    +   '<div class="jobs-detail-section">'
    +     '<h3>Payload</h3>'
    +     '<pre class="jobs-code' + (payloadStr ? '' : ' empty') + '">' + F.esc(payloadStr || "(empty)") + '</pre>'
    +   '</div>'

    +   '<div class="jobs-detail-section">'
    +     '<h3>Result</h3>'
    +     '<pre class="jobs-code' + (resultStr ? '' : ' empty') + '">' + F.esc(resultStr || "(empty)") + '</pre>'
    +   '</div>'

    +   '<div class="jobs-detail-section">'
    +     '<h3>Logs (matched window)</h3>'
    +     '<div class="jobs-detail-logs" id="job-logs"><div class="muted small" style="padding:4px 6px">loading logs...</div></div>'
    +   '</div>'
    + '</div>';

  var x = document.getElementById("d-close");
  if (x) x.addEventListener("click", function () { closeDetail(s); });

  slot.querySelectorAll(".jobs-detail-actions button[data-a]").forEach(function (b) {
    b.addEventListener("click", function () {
      if (b.dataset.a === "retry")  retryJob(j.id, s);
      if (b.dataset.a === "cancel") cancelJob(j.id, s);
    });
  });
}

function metaRow(k, vHtml) {
  return '<div class="k">' + F.esc(k) + '</div><div class="v">' + vHtml + '</div>';
}

async function loadJobLogs(job, s) {
  var el = document.getElementById("job-logs");
  if (!el) return;
  // No job_id column on logs -- match by device_id + account_id in the
  // job's lifetime window. Fall back to a 10-minute window ending at
  // created_at+30min when timestamps are missing. Hard cap at 200 rows
  // so an infinite-loop job can't blow the panel out.
  var since = job.taken_at || job.created_at;
  var until = job.finished_at || job.reserved_until || (job.taken_at ? null : job.created_at);
  // Pad each side a bit so first/last lines emitted next to the
  // boundary still show up.
  var sinceMs = since ? new Date(since).getTime() - 2000 : null;
  var untilMs = until ? new Date(until).getTime() + 2000 : null;
  if (!untilMs) untilMs = Date.now();
  if (!sinceMs) sinceMs = untilMs - 10 * 60 * 1000;

  var q = F.sbTable("logs")
    .select("id,channel,text,at,device_id,account_id")
    .order("at", { ascending: true })
    .limit(200)
    .gte("at", new Date(sinceMs).toISOString())
    .lte("at", new Date(untilMs).toISOString());

  if (job.device_id)  q = q.eq("device_id",  job.device_id);
  if (job.account_id) q = q.eq("account_id", job.account_id);

  var res = await q;
  // If this detail was closed / switched while we waited, bail.
  if (!s.selectedJob || String(s.selectedJob.id) !== String(job.id)) return;
  if (res.error) {
    el.innerHTML = '<div class="muted small" style="padding:4px 6px">logs query failed: ' + F.esc(res.error.message) + '</div>';
    return;
  }
  var rows = res.data || [];
  if (!rows.length) {
    el.innerHTML = '<div class="muted small" style="padding:4px 6px">no log lines in this job\'s window.</div>';
    return;
  }
  el.innerHTML = rows.map(function (r) {
    var ch = r.channel || "other";
    var d = new Date(r.at);
    var ts = (!r.at || isNaN(d.getTime()))
      ? "--:--:--"
      : (pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds()));
    return ''
      + '<div class="lg-row">'
      +   '<span class="lg-t">' + ts + '</span>'
      +   '<span class="lg-c lg-c-' + F.esc(ch) + '">' + F.esc(padRight(ch, 5)) + '</span>'
      +   '<span class="lg-m">' + F.esc(r.text || "") + '</span>'
      + '</div>';
  }).join("");
}

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------
function msElapsed(r) {
  if (!r) return null;
  // Prefer taken_at -> finished_at (actual run time). Fall back to
  // created_at -> finished_at for jobs that failed before being taken
  // (scheduler marks attempts >= max_attempts as 'failed' without ever
  // flipping through 'taken').
  if (r.finished_at && r.taken_at) {
    return Math.max(0, new Date(r.finished_at).getTime() - new Date(r.taken_at).getTime());
  }
  if (r.finished_at && r.created_at) {
    return Math.max(0, new Date(r.finished_at).getTime() - new Date(r.created_at).getTime());
  }
  return null;
}

function fmtDate(iso, long) {
  if (!iso) return "-";
  var d = new Date(iso);
  if (isNaN(d.getTime())) return "-";
  var yr = d.getFullYear();
  if (yr < 2000 || yr > 9999) return "-";
  if (long) return d.toLocaleString();
  // Short: HH:MM:SS  MMM D
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds())
       + "  " + MONTHS[d.getMonth()] + " " + d.getDate();
}

var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function pad2(n) { n = String(n); return n.length < 2 ? "0" + n : n; }
function padRight(s, n) { s = String(s); while (s.length < n) s = s + " "; return s; }

function prettyJson(v) {
  if (v == null) return "";
  try {
    if (typeof v === "string") {
      // The column is jsonb; the client already parses it. But some
      // older rows may have been written as a JSON-string-in-jsonb,
      // in which case supabase-js hands us a string -- try to
      // re-parse once so the panel shows structured data.
      try { v = JSON.parse(v); } catch (e) { /* leave as string */ }
    }
    if (typeof v === "string") return v;
    var s = JSON.stringify(v, null, 2);
    if (s === "{}" || s === "[]" || s === "null") return "";
    return s;
  } catch (e) {
    return String(v);
  }
}

function extractError(result) {
  if (!result || typeof result !== "object") return null;
  var r = result;
  // Common keys workers write under: error, error_text, message, msg,
  // failure, stack. Pick the first non-empty one in that order.
  var keys = ["error", "error_text", "err", "message", "msg", "failure", "stack"];
  for (var i = 0; i < keys.length; i++) {
    var v = r[keys[i]];
    if (v != null && v !== "") {
      if (typeof v === "string") return v;
      try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); }
    }
  }
  // Last resort: if result.ok === false or result.success === false,
  // surface the whole thing as the "error" so the user sees it.
  if (r.ok === false || r.success === false) {
    try { return JSON.stringify(r, null, 2); } catch (e) { return String(r); }
  }
  return null;
}

})();
