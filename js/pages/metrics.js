(function () {
// Metrics page - cost + throughput dashboard (ASCII only, no new deps).
//
// Data sources:
//   1. supabase view v_metrics_24h (migration v23): per-solver 24h
//      aggregates (solves, ok, avg_ms, cost_usd) scoped to workspace via
//      security_invoker RLS.
//   2. supabase view v_cost_rollup_24h (migration v36): per-account 24h
//      rollup joining captcha_solves + proxy_usage + jobs so the
//      "Cost breakdown 24h" section can show captcha $ + proxy $ +
//      session minutes down to the username level.
//   3. supabase captcha_solves (last hour): rate / recent-events tile.
//   4. supabase devices + device_states: running devices, active clients.
//   5. supabase jobs: finished-per-hour throughput.
//   6. optional GET /api/metrics proxy. If a server shim exists it merges
//      worker-reported stats (queue depth, in-flight, uptime) on top of
//      the supabase numbers. If it 404s or times out, the panel still
//      renders with the supabase data alone.
//
// Unit-cost table (fake USD per OK solve) matches the migration view so
// the tiles always line up with the SQL numbers:
//   capsolver  = $0.001
//   yescaptcha = $0.0008
//   capmonster = $0.001
//   anything else (webview, local, none) = $0
//
// To change a price:
//   captcha ($/OK solve) -> edit COST_PER_OK below AND the CASE in
//     supabase/migrations/20260101000023_metrics_view.sql + v36 rollup.
//   proxy ($/GB) -> edit PROXY_USD_PER_GB below AND the 2.00 literal in
//     supabase/migrations/20260101000036_cost_rollup.sql. The dashboard
//     displays the client-side number, but the SQL total_cost_24h is
//     computed server-side, so both have to move together or the "Total
//     $" tile will drift from the per-account rows.
window.F = window.F || {};
F.pages = F.pages || {};

const COST_PER_OK = {
  capsolver:  0.001,
  yescaptcha: 0.0008,
  capmonster: 0.001,
};

// DataImpulse residential pricing. Must match the 2.00 literal in the
// v_cost_rollup_24h view (migration v36); see comment above.
const PROXY_USD_PER_GB = 2.00;

// Drivers to always show as a cost card even when they have zero solves,
// so the operator sees the full fleet instead of an empty grid at 04:00.
const DRIVER_ORDER = ["capsolver", "yescaptcha", "capmonster", "webview"];

// Per-account cost table: client-side sort + filter state. Rebuilt in
// place on every filter change so the sort order is preserved.
const costTableState = {
  rows: [],
  sortKey: "total_cost_24h",
  sortDir: "desc",
  filterStatus: "all",
  filterQuery: "",
  filterOwner: "all",
};

F.pages.metrics = async function (view) {
  view.innerHTML = shellHtml();

  if (!F.sb) {
    document.getElementById("metrics-source").innerHTML =
      '<span class="cold">offline - supabase env missing</span>';
    renderEmpty();
    return;
  }

  await load();
};

function shellHtml() {
  return `
    <h1>Metrics</h1>

    <div class="metrics-grid">
      <div class="metrics-tile" data-tone="count">
        <div class="tile-k">Solves 24h</div>
        <div class="tile-v" id="m-solves">-</div>
        <div class="tile-sub" id="m-solves-sub">loading...</div>
      </div>
      <div class="metrics-tile" data-tone="ok">
        <div class="tile-k">OK rate</div>
        <div class="tile-v" id="m-okrate">-</div>
        <div class="tile-sub" id="m-okrate-sub">overall success</div>
      </div>
      <div class="metrics-tile" data-tone="cost">
        <div class="tile-k">Cost 24h</div>
        <div class="tile-v" id="m-cost">-</div>
        <div class="tile-sub" id="m-cost-sub">across all solvers</div>
      </div>
      <div class="metrics-tile" data-tone="count">
        <div class="tile-k">Running devices</div>
        <div class="tile-v" id="m-devices">-</div>
        <div class="tile-sub" id="m-devices-sub">last 2 min</div>
      </div>
      <div class="metrics-tile" data-tone="count">
        <div class="tile-k">Active clients</div>
        <div class="tile-v" id="m-clients">-</div>
        <div class="tile-sub" id="m-clients-sub">accounts in-game</div>
      </div>
      <div class="metrics-tile" data-tone="rate">
        <div class="tile-k">Jobs / hour</div>
        <div class="tile-v" id="m-jobs">-</div>
        <div class="tile-sub" id="m-jobs-sub">finished last 60 min</div>
      </div>
    </div>

    <div class="card">
      <div class="card-h">
        Cost breakdown 24h
        <div class="spacer"></div>
        <span class="muted" style="font-size:11px">window: fixed 24h</span>
        <button class="btn" id="cost-csv-btn" style="margin-left:10px">Export CSV</button>
      </div>

      <div class="metrics-grid cost-breakdown-grid">
        <div class="metrics-tile" data-tone="cost">
          <div class="tile-k">Captcha $</div>
          <div class="tile-v" id="cb-captcha">-</div>
          <div class="tile-sub" id="cb-captcha-sub">per-OK solve unit cost</div>
        </div>
        <div class="metrics-tile" data-tone="cost">
          <div class="tile-k">Proxy $</div>
          <div class="tile-v" id="cb-proxy">-</div>
          <div class="tile-sub" id="cb-proxy-sub">$${PROXY_USD_PER_GB.toFixed(2)}/GB residential</div>
        </div>
        <div class="metrics-tile" data-tone="rate">
          <div class="tile-k">Session min</div>
          <div class="tile-v" id="cb-session">-</div>
          <div class="tile-sub" id="cb-session-sub">operator-hours proxy</div>
        </div>
        <div class="metrics-tile" data-tone="cost">
          <div class="tile-k">Total $</div>
          <div class="tile-v" id="cb-total">-</div>
          <div class="tile-sub" id="cb-total-sub">captcha + proxy</div>
        </div>
      </div>

      <div class="cost-filters">
        <label>
          Status
          <select id="cost-f-status">
            <option value="all">all</option>
            <option value="enabled">enabled</option>
            <option value="active">active</option>
            <option value="connected">connected</option>
            <option value="joining">joining</option>
            <option value="retired">retired</option>
          </select>
        </label>
        <label id="cost-f-owner-wrap" style="display:none">
          Owner
          <select id="cost-f-owner">
            <option value="all">all</option>
          </select>
        </label>
        <label>
          Search
          <input id="cost-f-query" type="search" placeholder="username..." />
        </label>
        <span class="muted cost-f-count" id="cost-f-count"></span>
      </div>

      <table class="tbl metrics-tbl cost-tbl">
        <thead><tr>
          <th data-sort="username">Account</th>
          <th data-sort="status">Status</th>
          <th class="num" data-sort="jobs_done_24h">Jobs done</th>
          <th class="num" data-sort="session_min_24h">Session min</th>
          <th class="num" data-sort="captcha_cost_24h">Captcha $</th>
          <th class="num" data-sort="proxy_gb_24h">Proxy GB</th>
          <th class="num" data-sort="proxy_cost_24h">Proxy $</th>
          <th class="num" data-sort="total_cost_24h">Total $</th>
          <th class="num" data-sort="per_job">$ / job</th>
        </tr></thead>
        <tbody id="cost-rows">
          <tr><td colspan="9" class="empty">loading...</td></tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <div class="card-h">
        Cost per driver (24h)
        <div class="spacer"></div>
        <span class="metrics-source" id="metrics-source">loading...</span>
      </div>
      <div class="metrics-cost-row" id="cost-row">
        <div class="empty">loading...</div>
      </div>
    </div>

    <div class="card">
      <div class="card-h">Per-driver detail</div>
      <table class="tbl metrics-tbl">
        <thead><tr>
          <th>Driver</th>
          <th class="num">Solves</th>
          <th class="num">OK</th>
          <th class="num">Success</th>
          <th class="num">Avg ms</th>
          <th class="num">Cost (USD)</th>
          <th class="num">$ per OK</th>
        </tr></thead>
        <tbody id="drv-rows">
          <tr><td colspan="7" class="empty">loading...</td></tr>
        </tbody>
      </table>
    </div>
  `;
}

async function load() {
  // 1) v_metrics_24h - per-solver rollup. The view is owner-scoped via
  //    security_invoker RLS, so no owner_id filter is needed client-side.
  // 2) devices + device_states - count fresh heartbeats for "running devices".
  // 3) accounts - head-count for "active clients".
  // 4) jobs - head-count of rows finished in the last hour.
  // 5) optional /api/metrics - worker-reported stats on top of supabase.
  const sinceHour = new Date(Date.now() - 3600 * 1000).toISOString();

  const [viewQ, rollupQ, devsQ, statesQ, activeQ, jobsQ, workerStats] = await Promise.all([
    F.sb.from("v_metrics_24h").select("solver,solves,ok,avg_ms,cost_usd").limit(100),
    F.sb.from("v_cost_rollup_24h")
      .select("account_id,username,status,owner_id,captcha_cost_24h,proxy_gb_24h,proxy_cost_24h,session_min_24h,total_cost_24h,jobs_done_24h")
      .limit(5000),
    F.sb.from("devices").select("id,last_seen_at").limit(500),
    F.sb.from("device_states").select("device_id,clients,active,updated_at").limit(500),
    F.sb.from("accounts").select("id", { count: "exact", head: true })
      .in("status", ["active", "connected", "joining"]),
    F.sb.from("jobs").select("id", { count: "exact", head: true })
      .gte("finished_at", sinceHour)
      .eq("status", "done"),
    fetchWorkerMetrics(),
  ]);

  if (viewQ.error)   F.toast(viewQ.error.message, "err");
  if (rollupQ.error) F.toast(rollupQ.error.message, "err");
  if (devsQ.error)   F.toast(devsQ.error.message, "err");
  if (statesQ.error) F.toast(statesQ.error.message, "err");
  if (activeQ.error) F.toast(activeQ.error.message, "err");
  if (jobsQ.error)   F.toast(jobsQ.error.message, "err");

  const rows = (viewQ.data || []).map((r) => ({
    solver:   r.solver || "none",
    solves:   Number(r.solves || 0),
    ok:       Number(r.ok || 0),
    avg_ms:   r.avg_ms == null ? null : Math.round(Number(r.avg_ms)),
    cost_usd: Number(r.cost_usd || 0),
  }));

  const totalSolves = rows.reduce((s, r) => s + r.solves, 0);
  const totalOk     = rows.reduce((s, r) => s + r.ok, 0);
  const totalCost   = rows.reduce((s, r) => s + r.cost_usd, 0);
  const okRate      = totalSolves ? Math.round((totalOk * 100) / totalSolves) : null;

  // Fresh heartbeat window: a device_state row updated in the last 120s
  // is "running". Falls back to devices.last_seen_at when the row is
  // missing so new workers show up before their first state upsert.
  const now = Date.now();
  const stMap = Object.fromEntries((statesQ.data || []).map((s) => [s.device_id, s]));
  const runningDevs = (devsQ.data || []).filter((d) => {
    const st = stMap[d.id];
    const ts = st ? st.updated_at : d.last_seen_at;
    if (!ts) return false;
    return (now - new Date(ts).getTime()) < 120_000;
  });
  const clientsOnDev = runningDevs.reduce((s, d) => s + Number((stMap[d.id] || {}).clients || 0), 0);

  // Tiles.
  setText("m-solves", fmtInt(totalSolves));
  setText("m-solves-sub", `${fmtInt(totalOk)} ok / ${fmtInt(totalSolves - totalOk)} not ok`);

  setText("m-okrate", okRate == null ? "-" : `${okRate}%`);
  const okEl = document.getElementById("m-okrate");
  if (okEl) okEl.style.color = okRateColor(okRate);

  setText("m-cost", fmtUsd(totalCost));
  setText("m-cost-sub", `${rows.filter((r) => r.cost_usd > 0).length} paid solvers hit`);

  setText("m-devices", fmtInt(runningDevs.length));
  setText("m-devices-sub", `${clientsOnDev} clients reported`);

  setText("m-clients", fmtInt(activeQ.count || 0));

  const jobsPerHour = workerStats && workerStats.jobsPerHour != null
    ? Math.round(workerStats.jobsPerHour)
    : (jobsQ.count || 0);
  setText("m-jobs", fmtInt(jobsPerHour));
  setText("m-jobs-sub", workerStats && workerStats.jobsPerHour != null
    ? "from worker /metrics"
    : "finished last 60 min");

  // Source badge.
  const srcEl = document.getElementById("metrics-source");
  if (srcEl) {
    srcEl.innerHTML = workerStats
      ? '<span class="ok">supabase + worker</span>'
      : '<span class="cold">supabase only</span>';
  }

  renderCostCards(rows);
  renderDriverTable(rows);

  // Normalize the rollup rows (numeric-cast everything so client-side
  // sorting is not string-lexical) and prime the cost table.
  const rollupRows = (rollupQ.data || []).map((r) => ({
    account_id:       r.account_id,
    username:         r.username || "",
    status:           r.status || "",
    owner_id:         r.owner_id || "",
    captcha_cost_24h: Number(r.captcha_cost_24h || 0),
    proxy_gb_24h:     Number(r.proxy_gb_24h || 0),
    proxy_cost_24h:   Number(r.proxy_cost_24h || 0),
    session_min_24h:  Number(r.session_min_24h || 0),
    total_cost_24h:   Number(r.total_cost_24h || 0),
    jobs_done_24h:    Number(r.jobs_done_24h || 0),
  }));
  costTableState.rows = rollupRows;
  renderCostBreakdown(rollupRows);
  wireCostFilters();
  renderCostTable();
}

function renderCostCards(rows) {
  const row = document.getElementById("cost-row");
  if (!row) return;

  const byDriver = Object.fromEntries(rows.map((r) => [r.solver, r]));
  const seen = new Set();
  const cards = [];

  for (const drv of DRIVER_ORDER) {
    seen.add(drv);
    cards.push(costCardHtml(drv, byDriver[drv]));
  }
  // Any additional solver names seen in the window (future-proofing: a worker
  // could stamp a new provider label before the DRIVER_ORDER list is updated).
  for (const r of rows) {
    if (seen.has(r.solver)) continue;
    cards.push(costCardHtml(r.solver, r));
  }
  row.innerHTML = cards.join("");
}

function costCardHtml(driver, r) {
  const solves  = r ? r.solves : 0;
  const ok      = r ? r.ok : 0;
  const cost    = r ? r.cost_usd : 0;
  const perOk   = COST_PER_OK[driver] || 0;
  const free    = perOk === 0;
  const okPct   = solves ? Math.round((ok * 100) / solves) : null;
  const grade   = okPct == null ? "warn" : (okPct >= 90 ? "ok" : okPct >= 70 ? "warn" : "bad");
  const barPct  = okPct == null ? 0 : okPct;

  return `
    <div class="metrics-cost-card" data-free="${free ? "true" : "false"}">
      <div class="drv">
        <span class="pill cap-driver" data-k="${F.esc(driver)}">${F.esc(driver)}</span>
      </div>
      <div class="drv-cost">${fmtUsd(cost)}</div>
      <div class="drv-meta">
        <span>${fmtInt(solves)} solves</span>
        <span>${fmtInt(ok)} ok</span>
        <span>${okPct == null ? "- %" : okPct + "%"}</span>
        <span>$${perOk.toFixed(4)} / ok</span>
      </div>
      <div class="metrics-bar">
        <div class="metrics-bar-fill" data-good="${grade}" style="width:${barPct}%"></div>
      </div>
    </div>
  `;
}

function renderDriverTable(rows) {
  const body = document.getElementById("drv-rows");
  if (!body) return;

  // Sort: by cost desc then solves desc so the money sinks sit on top.
  const sorted = [...rows].sort((a, b) =>
    (b.cost_usd - a.cost_usd) || (b.solves - a.solves)
  );

  if (!sorted.length) {
    body.innerHTML = `<tr><td colspan="7" class="empty">no solves in the last 24h</td></tr>`;
    return;
  }

  body.innerHTML = sorted.map((r) => {
    const perOk  = COST_PER_OK[r.solver] || 0;
    const succ   = r.solves ? Math.round((r.ok * 100) / r.solves) : null;
    return `
      <tr>
        <td><span class="pill cap-driver" data-k="${F.esc(r.solver)}">${F.esc(r.solver)}</span></td>
        <td class="num">${fmtInt(r.solves)}</td>
        <td class="num">${fmtInt(r.ok)}</td>
        <td class="num" style="color:${okRateColor(succ)}">${succ == null ? "-" : succ + "%"}</td>
        <td class="num">${r.avg_ms == null ? "-" : fmtInt(r.avg_ms)}</td>
        <td class="num">${fmtUsd(r.cost_usd)}</td>
        <td class="num muted">$${perOk.toFixed(4)}</td>
      </tr>
    `;
  }).join("");
}

function renderCostBreakdown(rows) {
  // Top-of-section tiles: workspace-wide totals across every account.
  // Numbers come straight off the rollup view so they always match the
  // sum of the table rows below, even with filters applied (the tiles
  // are deliberately total-of-everything, not total-of-filtered -- the
  // operator picks the filter to drill in, the tiles stay a fixed
  // reference "bill for the last 24h").
  const totals = rows.reduce((a, r) => {
    a.captcha += r.captcha_cost_24h;
    a.proxy   += r.proxy_cost_24h;
    a.session += r.session_min_24h;
    a.total   += r.total_cost_24h;
    a.proxyGb += r.proxy_gb_24h;
    a.jobs    += r.jobs_done_24h;
    return a;
  }, { captcha: 0, proxy: 0, session: 0, total: 0, proxyGb: 0, jobs: 0 });

  setText("cb-captcha", fmtUsd(totals.captcha));
  const paidSolvers = rows.filter((r) => r.captcha_cost_24h > 0).length;
  setText("cb-captcha-sub", `${fmtInt(paidSolvers)} accounts billed`);

  setText("cb-proxy", fmtUsd(totals.proxy));
  setText("cb-proxy-sub", `${totals.proxyGb.toFixed(2)} GB @ $${PROXY_USD_PER_GB.toFixed(2)}/GB`);

  setText("cb-session", fmtInt(Math.round(totals.session)));
  setText("cb-session-sub", `${fmtInt(totals.jobs)} jobs done`);

  setText("cb-total", fmtUsd(totals.total));
  setText("cb-total-sub", `${fmtInt(rows.length)} accounts in workspace`);

  // Owner filter is only useful when the workspace actually has more
  // than one owner_id in its rows (e.g. a shared workspace joined via
  // the v8 shared_workspace migration). With a single owner we hide it.
  const owners = Array.from(new Set(rows.map((r) => r.owner_id).filter(Boolean)));
  const ownerWrap = document.getElementById("cost-f-owner-wrap");
  const ownerSel  = document.getElementById("cost-f-owner");
  if (ownerWrap && ownerSel && owners.length > 1) {
    ownerSel.innerHTML = `<option value="all">all</option>` +
      owners.map((o) => `<option value="${F.esc(o)}">${F.esc(o.slice(0, 8))}</option>`).join("");
    ownerWrap.style.display = "";
  } else if (ownerWrap) {
    ownerWrap.style.display = "none";
  }
}

function wireCostFilters() {
  // Idempotent: rebind every call since load() rewrites the shell.
  const statusEl = document.getElementById("cost-f-status");
  const queryEl  = document.getElementById("cost-f-query");
  const ownerEl  = document.getElementById("cost-f-owner");
  const csvBtn   = document.getElementById("cost-csv-btn");

  if (statusEl && !statusEl.dataset.wired) {
    statusEl.value = costTableState.filterStatus;
    statusEl.addEventListener("change", () => {
      costTableState.filterStatus = statusEl.value;
      renderCostTable();
    });
    statusEl.dataset.wired = "1";
  }
  if (queryEl && !queryEl.dataset.wired) {
    queryEl.value = costTableState.filterQuery;
    queryEl.addEventListener("input", () => {
      costTableState.filterQuery = queryEl.value.trim().toLowerCase();
      renderCostTable();
    });
    queryEl.dataset.wired = "1";
  }
  if (ownerEl && !ownerEl.dataset.wired) {
    ownerEl.value = costTableState.filterOwner;
    ownerEl.addEventListener("change", () => {
      costTableState.filterOwner = ownerEl.value;
      renderCostTable();
    });
    ownerEl.dataset.wired = "1";
  }
  if (csvBtn && !csvBtn.dataset.wired) {
    csvBtn.addEventListener("click", () => downloadCostCsv());
    csvBtn.dataset.wired = "1";
  }

  // Sort headers. data-sort="<key>" toggles asc/desc; clicking the
  // active column flips direction, a different column resets to desc
  // (useful default: biggest-cost-first for money columns).
  const ths = document.querySelectorAll(".cost-tbl th[data-sort]");
  ths.forEach((th) => {
    if (th.dataset.wired) return;
    th.style.cursor = "pointer";
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (costTableState.sortKey === key) {
        costTableState.sortDir = costTableState.sortDir === "desc" ? "asc" : "desc";
      } else {
        costTableState.sortKey = key;
        // String column: ascending by default, everything else: desc.
        costTableState.sortDir = (key === "username" || key === "status") ? "asc" : "desc";
      }
      renderCostTable();
    });
    th.dataset.wired = "1";
  });
}

function filteredCostRows() {
  const s = costTableState;
  return s.rows.filter((r) => {
    if (s.filterStatus !== "all" && r.status !== s.filterStatus) return false;
    if (s.filterOwner  !== "all" && r.owner_id !== s.filterOwner) return false;
    if (s.filterQuery && !r.username.toLowerCase().includes(s.filterQuery)) return false;
    return true;
  });
}

function sortedCostRows(rows) {
  const { sortKey, sortDir } = costTableState;
  const dir = sortDir === "asc" ? 1 : -1;
  const vg = (r) => {
    if (sortKey === "per_job") {
      return r.jobs_done_24h > 0 ? (r.total_cost_24h / r.jobs_done_24h) : -1;
    }
    return r[sortKey];
  };
  return [...rows].sort((a, b) => {
    const va = vg(a), vb = vg(b);
    if (typeof va === "string" || typeof vb === "string") {
      return dir * String(va || "").localeCompare(String(vb || ""));
    }
    return dir * ((Number(va) || 0) - (Number(vb) || 0));
  });
}

function renderCostTable() {
  const body = document.getElementById("cost-rows");
  if (!body) return;

  const filtered = filteredCostRows();
  const rows = sortedCostRows(filtered);

  // Header indicator: strip old marker, add arrow on active key.
  // ASCII-only -- no Unicode arrow glyphs.
  const ths = document.querySelectorAll(".cost-tbl th[data-sort]");
  ths.forEach((th) => {
    th.dataset.active = (th.dataset.sort === costTableState.sortKey) ? costTableState.sortDir : "";
    const base = th.textContent.replace(/\s*[\^v]$/, "");
    th.textContent = base + (th.dataset.active === "asc" ? " ^"
                           : th.dataset.active === "desc" ? " v" : "");
  });

  const cnt = document.getElementById("cost-f-count");
  if (cnt) {
    cnt.textContent = `${fmtInt(filtered.length)} of ${fmtInt(costTableState.rows.length)} accounts`;
  }

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="9" class="empty">no accounts match</td></tr>`;
    return;
  }

  body.innerHTML = rows.map((r) => {
    const perJob = r.jobs_done_24h > 0 ? (r.total_cost_24h / r.jobs_done_24h) : null;
    return `
      <tr>
        <td>${F.esc(r.username)}</td>
        <td><span class="pill" data-k="${F.esc(r.status)}">${F.esc(r.status || "-")}</span></td>
        <td class="num">${fmtInt(r.jobs_done_24h)}</td>
        <td class="num">${fmtInt(Math.round(r.session_min_24h))}</td>
        <td class="num">${fmtUsd(r.captcha_cost_24h)}</td>
        <td class="num">${r.proxy_gb_24h.toFixed(3)}</td>
        <td class="num">${fmtUsd(r.proxy_cost_24h)}</td>
        <td class="num">${fmtUsd(r.total_cost_24h)}</td>
        <td class="num muted">${perJob == null ? "-" : fmtUsd(perJob)}</td>
      </tr>
    `;
  }).join("");
}

function downloadCostCsv() {
  // Export respects the active filter, not the sort -- a CSV is for
  // further analysis in a spreadsheet where the user re-sorts anyway,
  // but a filter is often an active intent ("just the enabled accounts").
  const rows = filteredCostRows();
  const header = [
    "account_id", "username", "status", "owner_id",
    "jobs_done_24h", "session_min_24h",
    "captcha_cost_24h", "proxy_gb_24h", "proxy_cost_24h",
    "total_cost_24h", "usd_per_job",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    const perJob = r.jobs_done_24h > 0 ? (r.total_cost_24h / r.jobs_done_24h) : 0;
    lines.push([
      csvCell(r.account_id),
      csvCell(r.username),
      csvCell(r.status),
      csvCell(r.owner_id),
      r.jobs_done_24h,
      r.session_min_24h.toFixed(2),
      r.captcha_cost_24h.toFixed(6),
      r.proxy_gb_24h.toFixed(6),
      r.proxy_cost_24h.toFixed(6),
      r.total_cost_24h.toFixed(6),
      perJob.toFixed(6),
    ].join(","));
  }
  // Excel reads UTF-8 cleanly without a BOM here (usernames are ASCII),
  // but we keep text/csv so the browser offers a filename-based save.
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url;
  a.download = "v_cost_rollup_24h.csv";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  if (typeof F.toast === "function") F.toast(`exported ${rows.length} rows`, "ok");
}

function csvCell(v) {
  const s = v == null ? "" : String(v);
  // Quote when the cell contains a comma, a quote, a CR or a LF; double
  // internal quotes per RFC 4180.
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function renderEmpty() {
  setText("m-solves", "-");
  setText("m-okrate", "-");
  setText("m-cost", "-");
  setText("m-devices", "-");
  setText("m-clients", "-");
  setText("m-jobs", "-");
  setText("cb-captcha", "-");
  setText("cb-proxy", "-");
  setText("cb-session", "-");
  setText("cb-total", "-");
  const row = document.getElementById("cost-row");
  if (row) row.innerHTML = `<div class="empty">no data</div>`;
  const body = document.getElementById("drv-rows");
  if (body) body.innerHTML = `<tr><td colspan="7" class="empty">no data</td></tr>`;
  const costBody = document.getElementById("cost-rows");
  if (costBody) costBody.innerHTML = `<tr><td colspan="9" class="empty">no data</td></tr>`;
}

// --- helpers -------------------------------------------------------

// Optional proxy to the worker fleet: GET /api/metrics via server.js shim.
// Returns null (fast) when the shim is not deployed, so the page renders
// with supabase-only data instead of stalling on a 5-second 404.
async function fetchWorkerMetrics() {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 1500);
    const r = await fetch("/api/metrics", {
      headers: { accept: "application/json" },
      signal: ctl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || typeof j !== "object") return null;
    return j;
  } catch (_) {
    return null;
  }
}

function setText(id, v) {
  const el = document.getElementById(id);
  if (el) el.textContent = v;
}

function fmtInt(n) {
  const x = Number(n || 0);
  if (!isFinite(x)) return "0";
  return x.toLocaleString("en-US");
}

function fmtUsd(n) {
  const x = Number(n || 0);
  if (!isFinite(x)) return "$0.00";
  if (x === 0)     return "$0.00";
  if (x < 0.01)    return "$" + x.toFixed(4);
  if (x < 1)       return "$" + x.toFixed(3);
  if (x < 100)     return "$" + x.toFixed(2);
  return "$" + x.toFixed(0);
}

function okRateColor(pct) {
  if (pct == null)  return "";
  if (pct >= 90)    return "var(--green)";
  if (pct >= 70)    return "var(--accent)";
  return "var(--red)";
}

})();
