(function () {
// Overview page — status tiles, distribution bar, running games, active accounts, 30d chart.
window.F = window.F || {};
F.pages = F.pages || {};

// Module-level handles so a re-mount of /overview tears down the
// previous realtime subscriptions instead of stacking N listeners.
let _overviewSubs = [];
function teardownOverview() {
  for (const s of _overviewSubs) { try { s.unsubscribe(); } catch (e) { /* no-op */ } }
  _overviewSubs = [];
}

F.pages.overview = async function (view) {
  teardownOverview();
  const t = (F.i18n && F.i18n.t) ? F.i18n.t : (k) => k;
  view.innerHTML = `
    <h1>
      ${esc(t("overview.title"))}
      <span id="warmup-badge" class="badge badge-warmup" style="display:none;margin-left:10px;font-size:12px;padding:3px 8px;border-radius:10px;background:var(--accent,#246dd1);color:#fff;vertical-align:middle;">
        ${esc(warmupBadgeLabel(t))}: <span id="warmup-badge-n">0</span>
      </span>
    </h1>

    <div class="tiles-hero">
      <div class="tile hero hero-primary">
        <div class="tile-k">Farming now</div>
        <div class="tile-v hero-v"><span id="t-active">0</span></div>
        <div class="tile-sub"><span id="t-active-sub">accounts active</span></div>
      </div>
      <div class="tile hero hero-secondary">
        <div class="tile-k">Captcha solved 24h</div>
        <div class="tile-v hero-v"><span id="t-captcha-24h">0</span></div>
        <div class="tile-sub"><span id="t-captcha-bypass-sub">bypass pending…</span></div>
      </div>
      <div class="tile hero hero-tertiary">
        <div class="tile-k">Attached fleet</div>
        <div class="tile-v hero-v"><span id="t-connected">0</span></div>
        <div class="tile-sub">injected via executor</div>
      </div>
    </div>

    <div class="tiles">
      <div class="tile">
        <div class="tile-k">${esc(t("overview.tile.queued"))}</div>
        <div class="tile-v"><span class="dot"></span><span id="t-queued">0</span></div>
        <div class="tile-sub">${esc(t("overview.tile.queued.sub"))}</div>
      </div>
      <div class="tile">
        <div class="tile-k">${esc(t("overview.tile.joining"))}</div>
        <div class="tile-v"><span class="dot"></span><span id="t-joining">0</span></div>
        <div class="tile-sub">${esc(t("overview.tile.joining.sub"))}</div>
      </div>
      <div class="tile" data-tone="unstable">
        <div class="tile-k">${esc(t("overview.tile.unstable"))}</div>
        <div class="tile-v"><span class="dot"></span><span id="t-unstable">0</span></div>
        <div class="tile-sub">${esc(t("overview.tile.unstable.sub"))}</div>
      </div>
    </div>

    <div class="card">
      <div class="card-h">${esc(t("overview.dist.title"))}</div>
      <div class="dist-bar" id="dist"></div>
      <div class="dist-legend" id="dist-legend"></div>
    </div>

    <div class="card">
      <div class="card-h">
        ${esc(t("overview.games.title"))}
        <div class="spacer"></div>
        <span class="link">${esc(t("overview.games.hint"))}</span>
      </div>
      <table class="tbl">
        <thead><tr><th>${esc(t("th.game"))}</th><th>${esc(t("th.farming"))}</th><th>${esc(t("th.accounts"))}</th></tr></thead>
        <tbody id="games-body"><tr><td colspan="3" class="muted">${esc(t("overview.games.empty"))}</td></tr></tbody>
      </table>
    </div>

    <div class="card">
      <div class="card-h">
        ${esc(t("overview.accounts.title"))}
        <div class="spacer"></div>
        <input class="input" id="acc-search" placeholder="${esc(t("overview.accounts.search"))}" style="max-width:220px" />
      </div>
      <table class="tbl">
        <thead><tr><th>${esc(t("th.username"))}</th><th>${esc(t("th.status"))}</th><th>${esc(t("th.device"))}</th><th>${esc(t("th.config"))}</th></tr></thead>
        <tbody id="accs-body"><tr><td colspan="4" class="empty">${esc(t("overview.accounts.empty"))}</td></tr></tbody>
      </table>
    </div>

    <div class="card">
      <div class="card-h">
        ${esc(t("overview.chart.title"))}
        <div class="spacer"></div>
        <select class="input" style="max-width:160px" id="chart-mode">
          <option value="peak">${esc(t("overview.chart.peak"))}</option>
          <option value="avg">${esc(t("overview.chart.avg"))}</option>
        </select>
      </div>
      <div class="chart"><svg id="chart30" viewBox="0 0 600 180" preserveAspectRatio="none"></svg></div>
    </div>
  `;

  if (!F.sb) {
    view.querySelector("#dist").innerHTML = '<div class="dist-seg" data-k="queue" style="width:100%"></div>';
    return;
  }

  // Status tiles.
  // v3.9 — "Farming now" + "Attached fleet" now come from v_fleet_live
  // (real heartbeat data, 90s freshness gate), NOT accounts.status which
  // just says "has credentials". The small tiles below still reflect
  // intent/status counts (queued/joining/unstable) since those are
  // operator-facing goals, not live attachment.
  const live = await fleetLive();
  setText("t-active",    live.attached_now || 0);
  setText("t-connected", live.processes_now || 0);
  setText("t-active-sub",
    (live.live_devices || 0) + " device" + ((live.live_devices === 1) ? "" : "s") + " live");
  const stat = await countsByStatus();
  setText("t-queued",    stat.queued || 0);
  setText("t-joining",   stat.joining || 0);
  setText("t-unstable",  stat.unstable || 0);

  // Hero: Captcha solved in 24h + bypass stats.
  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const r = await F.sbTable("captcha_events")
      .select("id", { count: "exact", head: true })
      .gte("at", since)
      .eq("solved", true);
    setText("t-captcha-24h", r.count || 0);
  } catch (_e) { setText("t-captcha-24h", 0); }
  try {
    // Captcha bypass snapshot — reads v_captcha_bypass_24h if the view
    // exists (worker emits snapshot stats there). Falls back to a
    // placeholder when the view is missing.
    const r = await F.sbTable("v_captcha_bypass_24h").select("rewrites, suspects").limit(1);
    const row = r.data && r.data[0];
    if (row) {
      setText("t-captcha-bypass-sub", (row.rewrites || 0) + " bypass rewrites · " + (row.suspects || 0) + " flagged");
    } else {
      setText("t-captcha-bypass-sub", "bypass registry: idle");
    }
  } catch (_e) { setText("t-captcha-bypass-sub", "bypass registry: idle"); }

  // v34 warmup badge: count of accounts currently in warmup rotation.
  // One-shot HEAD count so the badge is cheap to refresh; realtime
  // subscriptions below rerun this via debouncedRefresh on any
  // accounts-row change. Hidden entirely when the migration has not
  // been applied (RPC 404 / column missing) or when the count is 0.
  await refreshWarmupBadge();

  // Distribution bar.
  const dist = view.querySelector("#dist");
  const legend = view.querySelector("#dist-legend");
  const parts = [
    { k: "queue",     label: t("overview.dist.queue"),     v: stat.queued },
    { k: "joining",   label: t("overview.dist.joining"),   v: stat.joining },
    { k: "connected", label: t("overview.dist.connected"), v: stat.connected },
    { k: "active",    label: t("overview.dist.active"),    v: stat.active },
    { k: "unstable",  label: t("overview.dist.unstable"),  v: stat.unstable },
  ];
  const total = parts.reduce((s, p) => s + (p.v || 0), 0) || 1;
  dist.innerHTML = parts.map((p) =>
    `<div class="dist-seg" data-k="${p.k}" style="width:${((p.v || 0) / total) * 100}%"></div>`
  ).join("");
  legend.innerHTML = parts.map((p) => {
    const c = { queue: "#3b4047", joining: "var(--accent)", connected: "var(--blue)", active: "#246dd1", unstable: "var(--red)" }[p.k];
    return `<span><span class="sw" style="background:${c}"></span>${p.label} ${p.v || 0}</span>`;
  }).join("");

  // Running game stats.
  const games = await runningGames();
  const gBody = view.querySelector("#games-body");
  if (games.length) {
    gBody.innerHTML = games.map((g) =>
      `<tr><td>${esc(g.game)}</td><td>${g.farming}</td><td>${g.accounts}</td></tr>`
    ).join("");
  }

  // Active accounts list.
  const accs = await activeAccounts();
  const aBody = view.querySelector("#accs-body");
  if (accs.length) {
    aBody.innerHTML = accs.map((a) =>
      `<tr>
        <td>${esc(a.username)}</td>
        <td><span class="pill" data-s="${esc(a.status)}"><span class="pill-dot"></span>${esc(a.status)}</span></td>
        <td>${esc(a.device || "—")}</td>
        <td>${esc(a.config || "—")}</td>
      </tr>`
    ).join("");
  }

  // 30-day chart.
  await drawChart(view.querySelector("#chart30"), "peak");
  view.querySelector("#chart-mode").addEventListener("change", (e) => {
    drawChart(view.querySelector("#chart30"), e.target.value);
  });

  // ---- realtime wiring ----
  // Tiles + distribution are server-aggregated HEAD counts, so we can't
  // patch them from a row payload - re-run the whole refresh under a
  // debounce whenever jobs/accounts/devices change. The Active accounts
  // table IS row-shaped: patch its <tr> in place when a row changes,
  // insert it if it just entered the active set, remove it if it left.
  const ownerId = F.ownerId;
  const debouncedRefresh = F.debounce(async () => {
    try {
      const live = await fleetLive();
      setText("t-active",    live.attached_now || 0);
      setText("t-connected", live.processes_now || 0);
      setText("t-active-sub",
        (live.live_devices || 0) + " device" + ((live.live_devices === 1) ? "" : "s") + " live");
      const stat = await countsByStatus();
      setText("t-queued",    stat.queued || 0);
      setText("t-joining",   stat.joining || 0);
      setText("t-unstable",  stat.unstable || 0);
      refreshWarmupBadge();
      const parts = [
        { k: "queue",     v: stat.queued },
        { k: "joining",   v: stat.joining },
        { k: "connected", v: stat.connected },
        { k: "active",    v: stat.active },
        { k: "unstable",  v: stat.unstable },
      ];
      const total = parts.reduce((s, p) => s + (p.v || 0), 0) || 1;
      const distEl = document.getElementById("dist");
      if (distEl) {
        distEl.innerHTML = parts.map((p) =>
          `<div class="dist-seg" data-k="${p.k}" style="width:${((p.v || 0) / total) * 100}%"></div>`
        ).join("");
      }
    } catch (e) { /* no-op */ }
  }, 300);

  const ACTIVE_SET = new Set(["active", "connected", "joining", "enabled"]);

  async function upsertAccountRow(row) {
    const aBody = document.getElementById("accs-body");
    if (!aBody) return;
    // Resolve joined device/config labels. One-shot query keeps the
    // handler cheap; the row isn't rendered without these anyway.
    let device = null, config = null;
    try {
      if (row.device_id) {
        const { data } = await F.sb.from("devices").select("name").eq("id", row.device_id).maybeSingle();
        device = data ? data.name : null;
      }
      if (row.config_id) {
        const { data } = await F.sb.from("configs").select("name,game_slug").eq("id", row.config_id).maybeSingle();
        config = data ? (data.name || data.game_slug) : null;
      }
    } catch (e) { /* no-op */ }
    const html = `
      <td>${esc(row.username || "")}</td>
      <td><span class="pill" data-s="${esc(row.status)}"><span class="pill-dot"></span>${esc(row.status)}</span></td>
      <td>${esc(device || "—")}</td>
      <td>${esc(config || "—")}</td>`;
    const empty = aBody.querySelector("tr > td.empty");
    if (empty) aBody.innerHTML = "";
    let tr = aBody.querySelector(`tr[data-aid="${row.id}"]`);
    if (!tr) {
      tr = document.createElement("tr");
      tr.setAttribute("data-aid", row.id);
      aBody.prepend(tr);
    }
    tr.innerHTML = html;
  }

  function removeAccountRow(id) {
    const aBody = document.getElementById("accs-body");
    if (!aBody) return;
    const tr = aBody.querySelector(`tr[data-aid="${id}"]`);
    if (tr) tr.remove();
    if (!aBody.children.length) {
      const tt = (F.i18n && F.i18n.t) ? F.i18n.t : (k) => k;
      aBody.innerHTML = `<tr><td colspan="4" class="empty">${tt("overview.accounts.empty")}</td></tr>`;
    }
  }

  // Tag each currently-rendered <tr> with its account id so realtime
  // events can find it. We do this by re-querying one lightweight page
  // so we have ids (the initial render only kept usernames).
  try {
    const { data: initial = [] } = await F.sb
      .from("accounts")
      .select("id,username,status,device_id,config_id")
      .in("status", [...ACTIVE_SET])
      .limit(100);
    const aBody = view.querySelector("#accs-body");
    if (aBody && initial.length) aBody.innerHTML = "";
    for (const a of initial) await upsertAccountRow(a);
  } catch (e) { /* no-op */ }

  const ownerFilter = ownerId ? { owner_id: ownerId } : null;

  _overviewSubs.push(F.realtime.subscribe("accounts", ownerFilter,
    (row) => { // INSERT
      if (ACTIVE_SET.has(row.status)) upsertAccountRow(row);
      debouncedRefresh();
    },
    (row, oldRow) => { // UPDATE
      if (ACTIVE_SET.has(row.status)) upsertAccountRow(row);
      else removeAccountRow(row.id);
      debouncedRefresh();
    },
    (oldRow) => { // DELETE
      if (oldRow && oldRow.id) removeAccountRow(oldRow.id);
      debouncedRefresh();
    },
    { onFallback: debouncedRefresh, pollMs: 30000 }
  ));

  _overviewSubs.push(F.realtime.subscribe("jobs", ownerFilter,
    debouncedRefresh, debouncedRefresh, debouncedRefresh,
    { onFallback: debouncedRefresh, pollMs: 30000 }
  ));

  _overviewSubs.push(F.realtime.subscribe("devices", ownerFilter,
    debouncedRefresh, debouncedRefresh, debouncedRefresh,
    { onFallback: debouncedRefresh, pollMs: 60000 }
  ));

  window.addEventListener("hashchange", teardownOverview, { once: true });
};

// v34 warmup badge label. When F.i18n is wired, t returns the key
// itself for missing entries (not null), so a plain `||` fallback
// does not work -- check for the unchanged key and substitute.
function warmupBadgeLabel(t) {
  const key = "overview.badge.warmup";
  const v = t ? t(key) : key;
  return (v && v !== key) ? v : "Warming";
}

// v34 warmup badge. Reads one HEAD count against accounts filtered by
// warmup_state='warming'. Fails open: on any error (migration v34 not
// applied yet, PostgREST 404 on the new column, transient network) the
// badge stays hidden. No RPC: a column that does not exist bubbles up
// as a 400 we swallow here.
async function refreshWarmupBadge() {
  const badge = document.getElementById("warmup-badge");
  const nEl = document.getElementById("warmup-badge-n");
  if (!badge || !nEl || !F.sb) return;
  try {
    const { count, error } = await F.sb
      .from("accounts")
      .select("id", { count: "exact", head: true })
      .eq("warmup_state", "warming");
    if (error) throw error;
    const n = count || 0;
    nEl.textContent = String(n);
    badge.style.display = n > 0 ? "" : "none";
  } catch (_e) {
    // Migration not yet applied, column missing, or RLS said no.
    // Hide silently; a healthy dashboard should not scream at the
    // operator about an optional feature.
    badge.style.display = "none";
  }
}

// Module-level so the "migration missing" warning is only logged once
// per page load even though fleetLive() runs on every realtime refresh.
let _fleetLiveMigrationWarned = false;
async function fleetLive() {
  // v3.9 — reads v_fleet_live (worker heartbeat aggregate, 90s stale gate).
  // Falls back to 0s when the migration hasn't landed or RLS blocks it.
  // PostgREST returns { data: null, error: { code: '42P01' } } for a
  // missing view — no throw — so we also inspect error explicitly. A
  // real network failure DOES throw and is caught below.
  const ZERO = { attached_now: 0, processes_now: 0, unstable_now: 0, live_devices: 0 };
  try {
    const { data, error } = await F.sb.from("v_fleet_live").select("*").limit(1);
    if (error) {
      if (!_fleetLiveMigrationWarned) {
        // 42P01 = relation does not exist. Migration v40 not applied.
        const missing = error.code === "42P01" || /does not exist/i.test(error.message || "");
        console.warn("[overview] v_fleet_live " + (missing ? "missing (apply migration v40)" : "error") +
          ": " + (error.message || error.code || "unknown"));
        _fleetLiveMigrationWarned = true;
      }
      return ZERO;
    }
    // v_fleet_live always has exactly one row (it's a single-row
    // aggregate), but RLS can still filter it to zero if the user's
    // auth.uid() doesn't match any owned device_state. In that case
    // data=[] and we hand back the ZERO defaults, same as before.
    const row = data && data[0];
    if (!row) return ZERO;
    return {
      attached_now:  Number(row.attached_now)  || 0,
      processes_now: Number(row.processes_now) || 0,
      unstable_now:  Number(row.unstable_now)  || 0,
      live_devices:  Number(row.live_devices)  || 0,
    };
  } catch (e) {
    if (!_fleetLiveMigrationWarned) {
      console.warn("[overview] v_fleet_live network error: " + (e && e.message || e));
      _fleetLiveMigrationWarned = true;
    }
    return ZERO;
  }
}

async function countsByStatus() {
  // Perf audit 2026-11-10 (2nd pass): the old `select('status')` pulled
  // every accounts row on every Overview render (~75 KB at 5k accounts,
  // ~750 KB at 50k) just to tally 5 buckets. Fire 5 parallel HEAD counts
  // that return zero row payload instead - ~99% bandwidth reduction and
  // sub-200ms TTI.
  const STATUSES = ["active", "enabled", "connected", "queued", "joining", "unstable"];
  const results = await Promise.all(
    STATUSES.map(async (s) => {
      const { count } = await F.sb
        .from("accounts")
        .select("id", { count: "exact", head: true })
        .eq("status", s);
      return [s, count || 0];
    })
  );
  const out = Object.fromEntries(results);
  return {
    active:    (out.active || 0) + (out.enabled || 0),
    connected: out.connected || 0,
    queued:    out.queued    || 0,
    joining:   out.joining   || 0,
    unstable:  out.unstable  || 0,
  };
}

async function runningGames() {
  // Perf audit 2026-11-10 (2nd pass): the old path pulled 5000 accounts
  // rows just to GROUP BY config_id in JS - ~200 KB/render and silently
  // wrong past the 5k limit. One HEAD count per config scales to the
  // real config count (<50 typical), returns zero row payload, and
  // stays correct at any fleet size.
  const { data: cfgs = [] } = await F.sb
    .from("configs")
    .select("id, game_slug")
    .limit(500);
  const perCfg = await Promise.all(
    cfgs.map(async (c) => {
      const { count } = await F.sb
        .from("accounts")
        .select("id", { count: "exact", head: true })
        .eq("config_id", c.id);
      return { game: c.game_slug, farming: count || 0, accounts: count || 0 };
    })
  );
  const { count: unconfCount } = await F.sb
    .from("accounts")
    .select("id", { count: "exact", head: true })
    .is("config_id", null);
  if (unconfCount) {
    perCfg.push({ game: "(unconfigured)", farming: 0, accounts: unconfCount });
  }
  return perCfg;
}

async function activeAccounts() {
  const { data } = await F.sb
    .from("accounts")
    .select("username, status, device:devices(id,name), config:configs(id,name,game_slug)")
    .in("status", ["active", "connected", "joining", "enabled"])
    .limit(100);
  return (data || []).map((a) => ({
    username: a.username,
    status:   a.status,
    device:   a.device ? a.device.name : null,
    config:   a.config ? (a.config.name || a.config.game_slug) : null,
  }));
}

async function drawChart(svg, mode) {
  const days = 30;
  const { data } = await F.sb
    .from("daily_snapshots")
    .select("day, peak_online, avg_online")
    .order("day", { ascending: true })
    .limit(days);
  const rows = data || [];
  const w = 600, h = 180, bw = w / days;
  if (!rows.length) {
    const y = h / 2;
    const tt = (F.i18n && F.i18n.t) ? F.i18n.t : (k) => k;
    svg.innerHTML = `
      <line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="var(--fg-muted)" stroke-width="1" stroke-dasharray="4 4" opacity="0.6" />
      <text x="${w / 2}" y="${y - 8}" text-anchor="middle" fill="var(--fg-muted)" font-size="12">${tt("overview.chart.empty")}</text>
    `;
    return;
  }
  const max = Math.max(1, ...rows.map((r) => (mode === "avg" ? r.avg_online || 0 : r.peak_online || 0)));
  const todayIdx = rows.length - 1;
  const bars = [];
  for (let i = 0; i < days; i++) {
    const r = rows[i];
    const v = r ? (mode === "avg" ? r.avg_online || 0 : r.peak_online || 0) : 0;
    const bh = (v / max) * (h - 20);
    const x = i * bw + 1, y = h - bh - 2;
    bars.push(`<rect class="bar ${i === todayIdx ? "active" : ""}" x="${x}" y="${y}" width="${bw - 2}" height="${bh}" rx="2" />`);
  }
  svg.innerHTML = bars.join("");
}

function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

})();
