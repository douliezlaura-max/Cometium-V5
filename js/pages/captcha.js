(function () {
// Captcha dashboard — per-account solve stats + recent solve log.
// Data source: captcha_events (owner-scoped by RLS) joined client-side to
// accounts.username. No v_captcha_solves_by_account view exists yet; this
// page aggregates on the client. Shape of captcha_events today:
//   {id, owner_id, account_id, device_id, provider, solved, at}.
// Columns that would need DB work to populate (kind, ms, error) are rendered
// from the row's provider+solved fields and shown as "-" when unavailable.
window.F = window.F || {};
F.pages = F.pages || {};

const PERIODS = [
  ["24h", "Last 24h",  24 * 3600 * 1000],
  ["7d",  "Last 7d",    7 * 86400 * 1000],
  ["30d", "Last 30d",  30 * 86400 * 1000],
];

const DRIVER_KEYS = ["webview", "yescaptcha", "capsolver"];

// Map a provider label (free text from captcha_webhooks.label) onto one of
// the known driver buckets. Falls back to "none" when the event never got a
// provider stamped (i.e. still unsolved) and to "other" when the label does
// not contain a known keyword.
function driverBucket(provider) {
  if (!provider) return "none";
  const p = String(provider).toLowerCase();
  for (const k of DRIVER_KEYS) if (p.includes(k)) return k;
  return "other";
}

F.pages.captcha = async function (view) {
  const s = {
    driver: "",
    period: "24h",
    search: "",
    rows: [],            // aggregated per-account rows
    recent: [],          // last 20 raw events
    accountsById: {},    // id -> {username, status}
    sinceMs: Date.now() - 24 * 3600 * 1000,
    totalEvents: 0,
    tableFiltered: [],   // view after driver+search
  };

  view.innerHTML = shellHtml(s);

  view.querySelector("#f-driver").addEventListener("change", (e) => {
    s.driver = e.target.value; renderTable(s);
  });
  view.querySelector("#f-period").addEventListener("change", (e) => {
    s.period = e.target.value; load(s);
  });
  const debounced = F.debounce(() => renderTable(s), 200);
  view.querySelector("#f-search").addEventListener("input", (e) => {
    s.search = e.target.value.trim().toLowerCase(); debounced();
  });

  await load(s);
};

function shellHtml(s) {
  const periodOpts = PERIODS.map(
    ([v, l]) => `<option value="${v}" ${s.period === v ? "selected" : ""}>${l}</option>`
  ).join("");
  const driverOpts = ["", ...DRIVER_KEYS, "other", "none"].map((v) => {
    const label = v === "" ? "All drivers" : (v === "none" ? "none (unsolved)" : v);
    return `<option value="${v}">${F.esc(label)}</option>`;
  }).join("");
  return `
    <h1>Captcha</h1>

    <div class="tiles" id="cap-tiles">
      <div class="tile"><div class="tile-k">Accounts hit</div><div class="tile-v" id="t-accounts">0</div><div class="tile-sub" id="t-accounts-sub">in window</div></div>
      <div class="tile"><div class="tile-k">Solves</div><div class="tile-v" id="t-solves">0</div><div class="tile-sub" id="t-solves-sub">0 solved / 0 pending</div></div>
      <div class="tile"><div class="tile-k">Success</div><div class="tile-v" id="t-success">-</div><div class="tile-sub">overall</div></div>
      <div class="tile"><div class="tile-k">Last solve</div><div class="tile-v" id="t-last">-</div><div class="tile-sub" id="t-last-sub">-</div></div>
      <div class="tile"><div class="tile-k">Top driver</div><div class="tile-v" id="t-driver">-</div><div class="tile-sub" id="t-driver-sub">-</div></div>
    </div>

    <div class="card">
      <div class="card-h">
        Filter
        <div class="spacer"></div>
        <a href="#/captcha-settings" class="link">Webhook settings &rsaquo;</a>
      </div>
      <div class="filter-grid cap-filters">
        <input class="input" id="f-search" placeholder="Search usernames..." />
        <select class="input" id="f-driver">${driverOpts}</select>
        <select class="input" id="f-period">${periodOpts}</select>
      </div>
    </div>

    <div id="cap-banner"></div>

    <div class="card">
      <div class="card-h">
        <span id="count">0</span> accounts
        <div class="spacer"></div>
        <span class="muted" id="cap-window">-</span>
      </div>
      <table class="tbl cap-tbl">
        <thead><tr>
          <th>Account</th>
          <th>Solves today</th>
          <th>Success</th>
          <th>Avg time</th>
          <th>Last solve</th>
          <th>Status</th>
          <th>Driver</th>
        </tr></thead>
        <tbody id="rows"><tr><td colspan="7" class="empty">loading...</td></tr></tbody>
      </table>
    </div>

    <div class="card">
      <div class="card-h">
        Last 20 solves
        <div class="spacer"></div>
        <span class="muted" id="recent-count">0 events</span>
      </div>
      <div class="cap-log" id="recent">
        <div class="empty">loading...</div>
      </div>
    </div>
  `;
}

async function load(s) {
  const periodMs = (PERIODS.find((p) => p[0] === s.period) || PERIODS[0])[2];
  s.sinceMs = Date.now() - periodMs;
  const sinceIso = new Date(s.sinceMs).toISOString();

  // Worker telemetry lives in captcha_solves (shape: solver / status / kind /
  // ms / created_at). Normalise to the legacy {provider, solved, at} shape
  // the rest of the page expects — one less rewrite for the same display.
  const [evQ, accQ] = await Promise.all([
    F.sbTable("captcha_solves")
      .select("id,account_id,device_id,solver,status,kind,ms,created_at")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(5000),
    F.sbTable("accounts").select("id,username,status").limit(5000),
  ]);

  if (evQ.error) { F.toast(evQ.error.message, "err"); return; }
  if (accQ.error) { F.toast(accQ.error.message, "err"); return; }

  const events = (evQ.data || []).map((r) => ({
    id: r.id,
    account_id: r.account_id,
    device_id: r.device_id,
    provider: r.solver,
    solved: r.status === "ok",
    at: r.created_at,
    kind: r.kind,
    ms: r.ms,
  }));
  s.totalEvents = events.length;
  s.accountsById = Object.fromEntries((accQ.data || []).map((a) => [a.id, a]));
  s.recent = events.slice(0, 20);

  // Group events per account.
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const byAcc = {};
  for (const e of events) {
    const aid = e.account_id;
    const a = byAcc[aid] || (byAcc[aid] = {
      account_id: aid,
      count: 0, solved: 0, failed: 0,
      solvesToday: 0,
      lastAt: null, lastProvider: null, lastSolved: null,
      providers: {},
    });
    a.count++;
    if (e.solved) a.solved++; else a.failed++;
    if (new Date(e.at) >= todayStart) a.solvesToday++;
    if (!a.lastAt || new Date(e.at) > new Date(a.lastAt)) {
      a.lastAt = e.at; a.lastProvider = e.provider || null; a.lastSolved = e.solved;
    }
    const b = driverBucket(e.provider);
    a.providers[b] = (a.providers[b] || 0) + 1;
  }
  s.rows = Object.values(byAcc).sort((x, y) =>
    (y.lastAt || "").localeCompare(x.lastAt || "")
  );

  renderTiles(s);
  renderBanner(s);
  renderTable(s);
  renderRecent(s);
}

function renderTiles(s) {
  const totalSolved = s.rows.reduce((n, r) => n + r.solved, 0);
  const totalFailed = s.rows.reduce((n, r) => n + r.failed, 0);
  const total = totalSolved + totalFailed;
  const pct = total ? Math.round((totalSolved * 100) / total) : null;

  document.getElementById("t-accounts").textContent = s.rows.length;
  document.getElementById("t-accounts-sub").textContent = `in ${s.period}`;

  document.getElementById("t-solves").textContent = total;
  document.getElementById("t-solves-sub").textContent =
    `${totalSolved} solved / ${totalFailed} pending`;

  const succEl = document.getElementById("t-success");
  succEl.textContent = pct === null ? "-" : `${pct}%`;
  succEl.style.color = pct === null ? "" : successColor(pct);

  const lastEv = s.recent[0];
  document.getElementById("t-last").textContent = lastEv ? ago(lastEv.at) : "-";
  document.getElementById("t-last-sub").textContent = lastEv
    ? (s.accountsById[lastEv.account_id]?.username || "-")
    : "-";

  // Driver tally across all events in window.
  const tally = {};
  for (const r of s.rows) {
    for (const [k, n] of Object.entries(r.providers)) tally[k] = (tally[k] || 0) + n;
  }
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  document.getElementById("t-driver").textContent = top ? top[0] : "-";
  document.getElementById("t-driver-sub").textContent = top ? `${top[1]} events` : "-";

  const w = document.getElementById("cap-window");
  if (w) w.textContent = `since ${new Date(s.sinceMs).toLocaleString()}`;
}

function renderBanner(s) {
  const el = document.getElementById("cap-banner");
  if (!el) return;
  if (s.totalEvents === 0) {
    el.innerHTML = `
      <div class="card cap-empty-banner">
        <div class="cap-empty-h">NO DATA YET - captcha_events is empty for this window</div>
        <div class="cap-empty-b">
          Nothing landed in the last ${PERIODS.find((p) => p[0] === s.period)[1].toLowerCase()}.
          Workers log a row every time an account hits a captcha
          (<code>fn_worker_captcha_notify</code>) and flip it solved when the solver
          returns (<code>fn_worker_captcha_solved</code>). Wire a webhook at
          <a href="#/captcha-settings" class="link">Webhook settings</a>, or widen the
          period filter above.
        </div>
      </div>
    `;
  } else {
    el.innerHTML = "";
  }
}

function renderTable(s) {
  // Apply driver + search filter.
  const q = s.search;
  const rows = s.rows.filter((r) => {
    if (s.driver) {
      if (s.driver === "none" && (r.providers.none || 0) === 0) return false;
      else if (s.driver !== "none") {
        const topDriver = Object.entries(r.providers).sort((a, b) => b[1] - a[1])[0];
        if (!topDriver || topDriver[0] !== s.driver) return false;
      }
    }
    if (q) {
      const u = (s.accountsById[r.account_id]?.username || "").toLowerCase();
      if (!u.includes(q)) return false;
    }
    return true;
  });
  s.tableFiltered = rows;

  document.getElementById("count").textContent = rows.length;
  const body = document.getElementById("rows");

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="7" class="empty">no accounts match the filter</td></tr>`;
    return;
  }

  body.innerHTML = rows.map((r) => {
    const acc = s.accountsById[r.account_id] || { username: "(unknown)", status: "disabled" };
    const pct = (r.solved + r.failed) ? Math.round((r.solved * 100) / (r.solved + r.failed)) : null;
    const topDriver = Object.entries(r.providers).sort((a, b) => b[1] - a[1])[0];
    const driver = topDriver ? topDriver[0] : "none";
    const statusKind = r.lastSolved === null ? "pending" : (r.lastSolved ? "ok" : "fail");

    return `
      <tr>
        <td>
          <div class="cap-acc">
            <span class="cap-avatar" style="background:${initialColor(acc.username)}">${F.esc(initial(acc.username))}</span>
            <div class="cap-acc-txt">
              <div class="cap-acc-n">${F.esc(acc.username)}</div>
              <div class="cap-acc-s muted">${F.esc(acc.status || "")}</div>
            </div>
          </div>
        </td>
        <td><span class="pill cap-pill-teal">Solves today: ${r.solvesToday}</span></td>
        <td>${pct === null ? '<span class="pill">-</span>' : `<span class="pill" style="color:${successColor(pct)};background:${successBg(pct)}">Success: ${pct}%</span>`}</td>
        <td><span class="pill">Avg: -</span></td>
        <td><span class="pill">Last: ${F.esc(ago(r.lastAt))}</span></td>
        <td><span class="pill cap-status" data-k="${statusKind}"><span class="pill-dot"></span>${statusKind}</span></td>
        <td><span class="pill cap-driver" data-k="${F.esc(driver)}">${F.esc(driver)}</span></td>
      </tr>
    `;
  }).join("");
}

function renderRecent(s) {
  const el = document.getElementById("recent");
  const cEl = document.getElementById("recent-count");
  if (cEl) cEl.textContent = `${s.totalEvents} events in window`;
  if (!s.recent.length) {
    el.innerHTML = `<div class="empty">no events</div>`;
    return;
  }
  el.innerHTML = `
    <table class="tbl cap-log-tbl">
      <thead><tr>
        <th style="width:150px">Timestamp</th>
        <th>Account</th>
        <th style="width:90px">Kind</th>
        <th style="width:130px">Solver</th>
        <th style="width:100px">Status</th>
        <th style="width:60px">ms</th>
        <th>Error</th>
      </tr></thead>
      <tbody>
        ${s.recent.map((e) => {
          const acc = s.accountsById[e.account_id] || { username: "(unknown)" };
          const status = e.solved ? "ok" : "pending";
          const driver = driverBucket(e.provider);
          return `
            <tr>
              <td class="muted">${F.esc(new Date(e.at).toLocaleString())}</td>
              <td>${F.esc(acc.username)}</td>
              <td><span class="pill">captcha</span></td>
              <td><span class="pill cap-driver" data-k="${F.esc(driver)}">${F.esc(e.provider || driver)}</span></td>
              <td><span class="pill cap-status" data-k="${status}"><span class="pill-dot"></span>${status}</span></td>
              <td class="muted">-</td>
              <td class="muted">-</td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;
}

// ------------------- helpers -------------------
function successColor(pct) {
  if (pct >= 90) return "var(--green)";
  if (pct >= 70) return "var(--accent)";
  return "var(--red)";
}
function successBg(pct) {
  if (pct >= 90) return "color-mix(in oklab, var(--green) 18%, transparent)";
  if (pct >= 70) return "color-mix(in oklab, var(--accent) 18%, transparent)";
  return "color-mix(in oklab, var(--red) 18%, transparent)";
}
function ago(iso) {
  if (!iso) return "-";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000)     return `${Math.max(1, Math.floor(diff / 1000))}s ago`;
  if (diff < 3_600_000)  return `${Math.floor(diff / 60_000)}min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
function initial(name) {
  const s = String(name || "?").trim();
  return s ? s[0].toUpperCase() : "?";
}
function initialColor(name) {
  // Deterministic HSL from the username -> a muted dark accent circle.
  let h = 0;
  const s = String(name || "");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffffffff;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 55%, 30%)`;
}

})();
