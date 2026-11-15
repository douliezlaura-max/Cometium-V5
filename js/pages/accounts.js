(function () {
// Accounts page — full table with filters, pagination, mass actions, edit modal, bulk import.
window.F = window.F || {};
F.pages = F.pages || {};

const PAGE_SIZES = [25, 50, 100, 250];
const STATUSES = ["enabled", "disabled", "dead", "banned", "captcha", "face_id", "place_ban", "age_verification", "unstable"];

// Module-level handle so a re-mount drops the previous realtime sub.
let _accountsSub = null;
function teardownAccounts() {
  if (_accountsSub) { try { _accountsSub.unsubscribe(); } catch (e) { /* no-op */ } _accountsSub = null; }
}

F.pages.accounts = async function (view) {
  teardownAccounts();
  const s = {
    page: 1, pageSize: 100,
    search: "", status: "", folder: "", device: "", config: "",
    tags: [], total: 0, rows: [],
    folders: [], devices: [], configs: [], autoswaps: [], knownTags: [],
    selected: new Set(),
    // v29: DataImpulse proxy usage per account over the last 24h.
    // Map<account_id, bytes_total_24h>. Populated per-page by load()
    // so the "GB 24h" column renders without blocking the row query.
    usage24h: new Map(),
  };

  view.innerHTML = shellHtml(s);

  await loadContext(s);
  fillSelect("f-folder", s.folders.map((f) => [f.id, f.name]));
  fillSelect("f-device", s.devices.map((d) => [d.id, d.name]));
  fillSelect("f-config", s.configs.map((c) => [c.id, c.name]));
  fillSelect("f-tags",   s.knownTags.map((t) => [t, t]));

  const refresh = () => load(s);
  const debounced = F.debounce(refresh, 250);

  view.querySelector("#f-search").addEventListener("input", (e) => { s.search = e.target.value; s.page = 1; debounced(); });
  view.querySelector("#f-status").addEventListener("change", (e) => { s.status = e.target.value; s.page = 1; refresh(); });
  view.querySelector("#f-folder").addEventListener("change", (e) => { s.folder = e.target.value; s.page = 1; refresh(); });
  view.querySelector("#f-device").addEventListener("change", (e) => { s.device = e.target.value; s.page = 1; refresh(); });
  view.querySelector("#f-config").addEventListener("change", (e) => { s.config = e.target.value; s.page = 1; refresh(); });
  view.querySelector("#f-tags").addEventListener("change", (e) => { s.tags = e.target.value ? [e.target.value] : []; s.page = 1; refresh(); });
  view.querySelector("#f-size").addEventListener("change", (e) => { s.pageSize = Number(e.target.value); s.page = 1; refresh(); });
  view.querySelector("#btn-new").addEventListener("click", () => openEdit(null, refresh, s));
  view.querySelector("#btn-import").addEventListener("click", () => openBulkCookies(refresh, s));
  view.querySelector("#btn-bulk").addEventListener("click", () => openBulkCookies(refresh, s));

  view.querySelector("#m-clear").addEventListener("click", () => { s.selected.clear(); render(s); });
  view.querySelector("#m-del").addEventListener("click", () => massDelete(s, refresh));
  view.querySelector("#m-folder").addEventListener("click", () => massPatch(s, refresh, "folder_id", s.folders));
  view.querySelector("#m-config").addEventListener("click", () => massPatch(s, refresh, "config_id", s.configs));
  view.querySelector("#m-tag").addEventListener("click", () => massTag(s, refresh, "add"));
  view.querySelector("#m-untag").addEventListener("click", () => massTag(s, refresh, "remove"));

  // Deep link: #/accounts?folder=xxx
  const q = new URLSearchParams(location.hash.split("?")[1] || "");
  if (q.get("folder")) { s.folder = q.get("folder"); view.querySelector("#f-folder").value = s.folder; }
  if (q.get("device")) { s.device = q.get("device"); view.querySelector("#f-device").value = s.device; }

  await refresh();

  // ---- realtime wiring ----
  // Accounts page is heavily filtered + paginated server-side, so we
  // can't trust a row-level event to "belong" on the current page --
  // a status change can shove a row past the page cutoff, or a new
  // INSERT could land on page 1 while we're on page 3. We treat events
  // as reconcile hints: if the row is already visible, patch it in
  // place (fast, no flash); otherwise schedule a debounced refresh so
  // filters + ordering + count stay correct.
  const ownerFilter = F.ownerId ? { owner_id: F.ownerId } : null;
  const debouncedReload = F.debounce(() => load(s), 500);

  function patchVisibleRow(row) {
    const tr = document.querySelector(`tr[data-aid="${row.id}"]`);
    if (!tr) return false;
    // Hot fields: status + tags + ban-status pill. Everything else
    // requires a joined lookup and a reload is cheaper than four more
    // RPCs per event. Cell index map (v37): [0]checkbox [1]username
    // [2]status [3]config [4]autoswap [5]device [6]folder [7]tags
    // [8]GB24h [9]BanStatus [10]edit.
    const statusCell = tr.children[2];
    if (statusCell) {
      statusCell.innerHTML =
        `<span class="pill" data-s="${F.esc(row.status)}"><span class="pill-dot"></span>${F.esc(row.status)}</span>`;
    }
    const tagsCell = tr.children[7];
    if (tagsCell) {
      tagsCell.innerHTML = (row.tags || []).map((t) => `<span class="pill">${F.esc(t)}</span>`).join(" ");
    }
    const banCell = tr.children[9];
    if (banCell) {
      banCell.innerHTML = renderBanStatusPill(row);
    }
    // Keep local cache in sync so the next render doesn't clobber it.
    const i = s.rows.findIndex((x) => x.id === row.id);
    if (i >= 0) s.rows[i] = { ...s.rows[i], ...row };
    return true;
  }

  _accountsSub = F.realtime.subscribe("accounts", ownerFilter,
    (row) => { // INSERT: new account entered the workspace. Cannot know if
               // it passes current filters without re-querying; reload.
      debouncedReload();
    },
    (row, oldRow) => { // UPDATE: patch if visible, reload otherwise.
      const patched = patchVisibleRow(row);
      // If a filter would have swapped this row in/out, the patch is
      // incomplete (count + ordering still wrong) -> reload. Cheap
      // heuristic: status/folder/device/config/tags all affect filters.
      const o = oldRow || {};
      const filterTouched =
        o.status !== row.status || o.folder_id !== row.folder_id ||
        o.device_id !== row.device_id || o.config_id !== row.config_id ||
        JSON.stringify(o.tags || []) !== JSON.stringify(row.tags || []);
      if (!patched || filterTouched) debouncedReload();
    },
    (oldRow) => { // DELETE
      const tr = oldRow && oldRow.id ? document.querySelector(`tr[data-aid="${oldRow.id}"]`) : null;
      if (tr) tr.remove();
      debouncedReload();
    },
    { onFallback: () => load(s), pollMs: 30000 }
  );

  window.addEventListener("hashchange", teardownAccounts, { once: true });
};

function shellHtml(s) {
  const t = (F.i18n && F.i18n.t) ? F.i18n.t : (k) => k;
  return `
    <h1>${F.esc(t("accounts.title"))}</h1>

    <div class="card">
      <div class="card-h">
        ${F.esc(t("accounts.filter"))}
        <div class="spacer"></div>
        <button class="btn" id="btn-import">${F.esc(t("accounts.btn.import"))}</button>
        <button class="btn" id="btn-bulk">${F.esc(t("accounts.btn.bulk"))}</button>
        <button class="btn primary" id="btn-new">${F.esc(t("accounts.btn.new"))}</button>
      </div>
      <div class="filter-grid">
        <input class="input" id="f-search" placeholder="${F.esc(t("accounts.search.placeholder"))}" />
        <select class="input" id="f-tags"><option value="">${F.esc(t("accounts.filter.all_tags"))}</option></select>
        <select class="input" id="f-status">
          <option value="">${F.esc(t("accounts.filter.all_status"))}</option>
          ${STATUSES.map((st) => `<option value="${st}">${st}</option>`).join("")}
        </select>
        <select class="input" id="f-device"><option value="">${F.esc(t("accounts.filter.all_devices"))}</option></select>
        <select class="input" id="f-folder"><option value="">${F.esc(t("accounts.filter.all_folders"))}</option></select>
        <select class="input" id="f-config"><option value="">${F.esc(t("accounts.filter.all_configs"))}</option></select>
      </div>
    </div>

    <div class="card" id="mass" style="display:none">
      <div class="card-h">
        <span id="mass-n">${F.esc(t("accounts.mass.selected", { n: 0 }))}</span>
        <div class="spacer"></div>
        <button class="btn" id="m-folder">${F.esc(t("accounts.mass.move_folder"))}</button>
        <button class="btn" id="m-config">${F.esc(t("accounts.mass.assign_config"))}</button>
        <button class="btn" id="m-tag">${F.esc(t("accounts.mass.add_tag"))}</button>
        <button class="btn" id="m-untag">${F.esc(t("accounts.mass.remove_tag"))}</button>
        <button class="btn danger" id="m-del">${F.esc(t("accounts.mass.delete"))}</button>
        <button class="btn" id="m-clear">${F.esc(t("accounts.mass.clear"))}</button>
      </div>
    </div>

    <div class="card">
      <div class="card-h">
        <span id="count">0</span>&nbsp;${F.esc(t("th.accounts"))}
        <div class="spacer"></div>
        <select class="input" id="f-size" style="max-width:120px">
          ${PAGE_SIZES.map((n) => `<option value="${n}" ${n === s.pageSize ? "selected" : ""}>${F.esc(t("accounts.page_size", { n: n }))}</option>`).join("")}
        </select>
      </div>
      <table class="tbl">
        <thead><tr>
          <th style="width:28px"><input type="checkbox" id="sel-all" /></th>
          <th>${F.esc(t("th.username"))}</th><th>${F.esc(t("th.status"))}</th><th>${F.esc(t("th.config"))}</th><th>${F.esc(t("th.autoswap"))}</th>
          <th>${F.esc(t("th.device"))}</th><th>${F.esc(t("th.folder"))}</th><th>${F.esc(t("th.tags"))}</th>
          <th style="width:80px" title="DataImpulse residential bytes (up+down) attributed to this account over the last 24 hours">GB 24h</th>
          <th style="width:110px" title="Last periodic ban-scanner outcome (worker/ban_scanner.js). Terminal states (banned, age-restricted, dead) also mirror into the Status column.">Ban status</th>
          <th style="width:60px"></th>
        </tr></thead>
        <tbody id="rows"><tr><td colspan="11" class="empty">${F.esc(t("accounts.loading"))}</td></tr></tbody>
      </table>
      <div class="pager" id="pager"></div>
    </div>
  `;
}

async function loadContext(s) {
  const [folders, devices, configs, autoswaps, tagRows] = await Promise.all([
    F.sbTable("folders").select("id,name").order("name"),
    F.sbTable("devices").select("id,name").order("name"),
    F.sbTable("configs").select("id,name,game_slug").order("name"),
    F.sbTable("autoswaps").select("id,name").order("name"),
    F.sbTable("accounts").select("tags").limit(2000),
  ]);
  s.folders = folders.data || [];
  s.devices = devices.data || [];
  s.configs = configs.data || [];
  s.autoswaps = autoswaps.data || [];
  const set = new Set();
  (tagRows.data || []).forEach((r) => (r.tags || []).forEach((t) => set.add(t)));
  s.knownTags = [...set].sort();
}

async function load(s) {
  const from = (s.page - 1) * s.pageSize, to = from + s.pageSize - 1;
  let q = F.sbTable("accounts")
    .select("id,username,status,config_id,autoswap_id,device_id,folder_id,tags,last_ban_check_at,last_ban_check_result", { count: "exact" })
    .order("username", { ascending: true })
    .range(from, to);

  if (s.search) {
    const names = s.search.split(",").map((x) => x.trim()).filter(Boolean);
    if (names.length === 1) q = q.ilike("username", `%${names[0]}%`);
    else if (names.length > 1) q = q.in("username", names);
  }
  if (s.status) q = q.eq("status", s.status);
  if (s.folder) q = q.eq("folder_id", s.folder);
  if (s.device) q = q.eq("device_id", s.device);
  if (s.config) q = q.eq("config_id", s.config);
  if (s.tags.length) q = q.contains("tags", s.tags);

  const { data, count, error } = await q;
  if (error) { F.toast(error.message, "err"); return; }
  s.rows = data || [];
  s.total = count || 0;

  // v29: pull GB-24h per account from v_proxy_usage_24h for the rows
  // we're about to render. Fetched in a second round-trip rather than
  // joined server-side so a view outage never blocks the main table
  // (the GB column just falls back to "—"). Scoped to the visible
  // account_ids only -> at most s.pageSize IN() entries.
  s.usage24h = new Map();
  if (s.rows.length) {
    try {
      const ids = s.rows.map((r) => r.id);
      const { data: udata, error: uerr } = await F.sbTable("v_proxy_usage_24h")
        .select("account_id,bytes_total_24h")
        .in("account_id", ids);
      if (!uerr && Array.isArray(udata)) {
        for (const u of udata) s.usage24h.set(u.account_id, Number(u.bytes_total_24h) || 0);
      }
    } catch { /* best effort; the column will show "—" */ }
  }

  render(s);
}

// v37: label + data-key for the "Ban status" pill. Keys mirror the
// CHECK constraint in migration 37 so CSS can colour each one. Null
// rows (never scanned) collapse to an em-dash so the column reads as
// "no signal yet", not "safe". The returned title carries the last
// scan time so hovering reveals staleness without a second column.
function renderBanStatusPill(row) {
  const key = row && row.last_ban_check_result;
  if (!key) return `<span class="muted">—</span>`;
  const labels = {
    healthy:        "healthy",
    banned:         "banned",
    age_restricted: "age-restricted",
    dead_cookie:    "dead cookie",
    rate_limited:   "rate-limited",
    error:          "error",
  };
  const label = labels[key] || key;
  let title = "last ban check: " + (row.last_ban_check_at || "unknown");
  try {
    if (row.last_ban_check_at) {
      const ageMs = Date.now() - new Date(row.last_ban_check_at).getTime();
      if (Number.isFinite(ageMs) && ageMs >= 0) {
        const mins = Math.floor(ageMs / 60000);
        const h = Math.floor(mins / 60);
        const ago = h > 0 ? `${h}h${mins % 60}m` : `${mins}m`;
        title = `last ban check ${ago} ago (${row.last_ban_check_at})`;
      }
    }
  } catch { /* best effort */ }
  return `<span class="pill bs-pill" data-bs="${F.esc(key)}" title="${F.esc(title)}"><span class="pill-dot"></span>${F.esc(label)}</span>`;
}

// v29: pretty bytes for the "GB 24h" column. Scales to KB/MB/GB/TB
// the first time each threshold lands so a worker's first 100 KB
// doesn't read as "0.0001 GB". Returns "—" for null/0/negative to
// match the rest of the table's empty-cell convention.
function formatBytes24h(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  // One decimal above KB, no decimals for raw bytes.
  const s = i === 0 ? String(Math.round(v)) : v.toFixed(v >= 100 ? 0 : 1);
  return `${s} ${units[i]}`;
}

function render(s) {
  const t = (F.i18n && F.i18n.t) ? F.i18n.t : (k) => k;
  document.getElementById("count").textContent = s.total;
  const massEl = document.getElementById("mass");
  massEl.style.display = s.selected.size ? "" : "none";
  document.getElementById("mass-n").textContent = t("accounts.mass.selected", { n: s.selected.size });

  const foldersById   = Object.fromEntries(s.folders.map((f) => [f.id, f.name]));
  const devicesById   = Object.fromEntries(s.devices.map((d) => [d.id, d.name]));
  const configsById   = Object.fromEntries(s.configs.map((c) => [c.id, c.name]));
  const autoswapsById = Object.fromEntries(s.autoswaps.map((a) => [a.id, a.name]));

  const body = document.getElementById("rows");
  if (!s.rows.length) {
    body.innerHTML = `<tr><td colspan="11" class="empty">${F.esc(t("accounts.empty"))}</td></tr>`;
  } else {
    body.innerHTML = s.rows.map((r) => `
      <tr data-aid="${r.id}">
        <td><input type="checkbox" class="sel" data-id="${r.id}" ${s.selected.has(r.id) ? "checked" : ""} /></td>
        <td>${F.esc(r.username)}</td>
        <td><span class="pill" data-s="${F.esc(r.status)}"><span class="pill-dot"></span>${F.esc(r.status)}</span></td>
        <td>${F.esc(configsById[r.config_id] || "—")}</td>
        <td>${F.esc(autoswapsById[r.autoswap_id] || "—")}</td>
        <td>${F.esc(devicesById[r.device_id] || "—")}</td>
        <td>${F.esc(foldersById[r.folder_id] || "—")}</td>
        <td>${(r.tags || []).map((tag) => `<span class="pill">${F.esc(tag)}</span>`).join(" ")}</td>
        <td class="muted" style="white-space:nowrap">${F.esc(formatBytes24h(s.usage24h.get(r.id)))}</td>
        <td style="white-space:nowrap">${renderBanStatusPill(r)}</td>
        <td><button class="btn" data-edit="${r.id}">${F.esc(t("common.edit"))}</button></td>
      </tr>`).join("");
  }

  body.querySelectorAll(".sel").forEach((cb) =>
    cb.addEventListener("change", (e) => {
      const id = e.target.dataset.id;
      e.target.checked ? s.selected.add(id) : s.selected.delete(id);
      render(s);
    })
  );
  body.querySelectorAll("[data-edit]").forEach((b) =>
    b.addEventListener("click", (e) => openEdit(e.target.dataset.edit, () => load(s), s))
  );

  const selAll = document.getElementById("sel-all");
  selAll.checked = s.rows.length > 0 && s.rows.every((r) => s.selected.has(r.id));
  selAll.onchange = (e) => {
    if (e.target.checked) s.rows.forEach((r) => s.selected.add(r.id));
    else s.rows.forEach((r) => s.selected.delete(r.id));
    render(s);
  };

  const pages = Math.max(1, Math.ceil(s.total / s.pageSize));
  const pg = document.getElementById("pager");
  pg.innerHTML = `
    <button class="btn" ${s.page <= 1 ? "disabled" : ""} data-pg="prev">${F.esc(t("common.prev"))}</button>
    <span class="muted">${F.esc(t("common.page", { n: s.page, total: pages }))} · ${F.esc(t("common.total_rows", { n: s.total }))}</span>
    <button class="btn" ${s.page >= pages ? "disabled" : ""} data-pg="next">${F.esc(t("common.next"))}</button>
  `;
  pg.querySelectorAll("[data-pg]").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.pg === "prev") s.page = Math.max(1, s.page - 1);
    else s.page = Math.min(pages, s.page + 1);
    load(s);
  }));
}

function fillSelect(id, pairs) {
  const el = document.getElementById(id); if (!el) return;
  const cur = el.value;
  const first = el.querySelector("option");
  el.innerHTML = "";
  if (first) el.append(first);
  pairs.forEach(([v, l]) => {
    const o = document.createElement("option"); o.value = v; o.textContent = l;
    el.append(o);
  });
  el.value = cur;
}

// ------------------- edit modal -------------------
async function openEdit(id, refresh, s) {
  const t = (F.i18n && F.i18n.t) ? F.i18n.t : (k) => k;
  let row = { username: "", password: "", cookie: "", status: "enabled", tags: [], private_server: "", notes: "" };
  if (id) {
    const { data } = await F.sbTable("accounts").select("*").eq("id", id).single();
    if (data) row = data;
  }
  const body = F.el(`
    <div class="form">
      <label>${F.esc(t("th.username"))} <input class="input" data-k="username" value="${F.esc(row.username)}" ${id ? "disabled" : ""} /></label>
      <label>Password <input class="input" data-k="password" value="${F.esc(row.password || "")}" /></label>
      <label>Cookie (.ROBLOSECURITY) <textarea class="input" rows="3" data-k="cookie">${F.esc(row.cookie || "")}</textarea></label>
      <label>${F.esc(t("th.status"))}
        <select class="input" data-k="status">
          ${STATUSES.map((st) => `<option value="${st}" ${row.status === st ? "selected" : ""}>${st}</option>`).join("")}
        </select>
      </label>
      <div class="form-row">
        <label>${F.esc(t("th.folder"))}
          <select class="input" data-k="folder_id">
            <option value="">—</option>
            ${s.folders.map((f) => `<option value="${f.id}" ${row.folder_id === f.id ? "selected" : ""}>${F.esc(f.name)}</option>`).join("")}
          </select>
        </label>
        <label>${F.esc(t("th.config"))}
          <select class="input" data-k="config_id">
            <option value="">—</option>
            ${s.configs.map((c) => `<option value="${c.id}" ${row.config_id === c.id ? "selected" : ""}>${F.esc(c.name)}</option>`).join("")}
          </select>
        </label>
      </div>
      <div class="form-row">
        <label>${F.esc(t("th.device"))}
          <select class="input" data-k="device_id">
            <option value="">—</option>
            ${s.devices.map((d) => `<option value="${d.id}" ${row.device_id === d.id ? "selected" : ""}>${F.esc(d.name)}</option>`).join("")}
          </select>
        </label>
        <label>${F.esc(t("th.autoswap"))}
          <select class="input" data-k="autoswap_id">
            <option value="">—</option>
            ${s.autoswaps.map((a) => `<option value="${a.id}" ${row.autoswap_id === a.id ? "selected" : ""}>${F.esc(a.name)}</option>`).join("")}
          </select>
        </label>
      </div>
      <label>${F.esc(t("th.tags"))} <input class="input" data-k="tags" value="${F.esc((row.tags || []).join(", "))}" /></label>
      <label>Private server URL / linkcode <input class="input" data-k="private_server" value="${F.esc(row.private_server || "")}" /></label>
      <label>Notes <textarea class="input" rows="2" data-k="notes">${F.esc(row.notes || "")}</textarea></label>
    </div>
  `);
  const foot = F.el(`<div style="display:flex;gap:8px;justify-content:space-between;width:100%">
    <button class="btn danger" data-a="del" ${id ? "" : "style='visibility:hidden'"}>${F.esc(t("common.delete"))}</button>
    <div style="display:flex;gap:8px">
      <button class="btn" data-a="cancel">${F.esc(t("common.cancel"))}</button>
      <button class="btn primary" data-a="save">${id ? F.esc(t("common.save")) : F.esc(t("common.create"))}</button>
    </div>
  </div>`);
  const { close } = F.modal({ title: id ? `Edit ${row.username}` : "New account", body, footer: foot, width: 560 });

  foot.querySelector("[data-a='cancel']").addEventListener("click", close);
  foot.querySelector("[data-a='save']").addEventListener("click", async () => {
    const patch = {};
    body.querySelectorAll("[data-k]").forEach((el) => {
      const k = el.dataset.k; let v = el.value;
      if (k === "tags") v = v.split(",").map((t) => t.trim()).filter(Boolean);
      if (["folder_id", "config_id", "device_id", "autoswap_id"].includes(k) && v === "") v = null;
      patch[k] = v;
    });
    // Only stamp owner_id on INSERT. On UPDATE, leave it alone — overwriting
     // owner_id of an existing row corrupts ownership in shared workspaces.
    let err;
    if (id) {
      ({ error: err } = await F.sbTable("accounts").update(patch).eq("id", id));
    } else {
      const { data: me } = await F.sb.auth.getUser();
      patch.owner_id = me.user.id;
      ({ error: err } = await F.sbTable("accounts").insert(patch));
    }
    if (err) return F.toast(err.message, "err");
    const tt = (F.i18n && F.i18n.t) ? F.i18n.t : (k) => k;
    F.toast(id ? tt("accounts.toast.saved") : tt("accounts.toast.created")); close(); refresh();
  });
  if (id) foot.querySelector("[data-a='del']").addEventListener("click", async () => {
    const tt = (F.i18n && F.i18n.t) ? F.i18n.t : (k) => k;
    if (!(await F.confirm(tt("accounts.delete_confirm", { name: row.username })))) return;
    const { error: err } = await F.sbTable("accounts").delete().eq("id", id);
    if (err) return F.toast(err.message, "err");
    F.toast(tt("accounts.toast.deleted")); close(); refresh();
  });
}

// ------------------- bulk import (DEPRECATED — redirects to RPC-based openBulkCookies) -------------------
function openImport(refresh, s) { return openBulkCookies(refresh, s); }
function openImport_DEPRECATED(refresh, s) {
  const body = F.el(`
    <div class="form">
      <label>Paste accounts, one per line
        <textarea class="input" id="imp-txt" rows="10" placeholder="username:password:cookie&#10;username:password:cookie:privateServerUrlOrCode&#10;cookie_only_value"></textarea>
      </label>
      <label>Default folder
        <select class="input" id="imp-folder">
          <option value="">—</option>
          ${s.folders.map((f) => `<option value="${f.id}">${F.esc(f.name)}</option>`).join("")}
        </select>
      </label>
      <label>Default tags (comma-separated)
        <input class="input" id="imp-tags" placeholder="e.g. imported, buck 1m+" />
      </label>
      <div class="muted" style="font-size:11px">
        Format matches the reference tool: user:pass:cookie, user:pass:cookie:privateServer, or a bare cookie.
        Duplicates (same owner + username) are updated in place.
      </div>
    </div>
  `);
  const foot = F.el(`<div style="display:flex;gap:8px;justify-content:flex-end">
    <button class="btn" data-a="cancel">Cancel</button>
    <button class="btn primary" data-a="run">Import</button>
  </div>`);
  const { close } = F.modal({ title: "Import accounts", body, footer: foot, width: 560 });

  foot.querySelector("[data-a='cancel']").addEventListener("click", close);
  foot.querySelector("[data-a='run']").addEventListener("click", async () => {
    const lines = body.querySelector("#imp-txt").value.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return F.toast("nothing to import", "err");
    const folder = body.querySelector("#imp-folder").value || null;
    const tags = body.querySelector("#imp-tags").value.split(",").map((t) => t.trim()).filter(Boolean);
    const { data: me } = await F.sb.auth.getUser();
    const owner_id = me.user.id;

    const rows = lines.map((l) => {
      const parts = l.split(":");
      if (parts.length === 1) {
        return { owner_id, username: `cookie_${Date.now()}_${Math.floor(Math.random() * 1e5)}`,
                 cookie: parts[0], tags, folder_id: folder };
      }
      const [u, p, c, srv] = parts;
      return { owner_id, username: u, password: p || null, cookie: c || null,
               private_server: srv || null, tags, folder_id: folder };
    });

    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error } = await F.sbTable("accounts").upsert(chunk, { onConflict: "owner_id,username" });
      if (error) { F.toast(`row ${i}: ${error.message}`, "err"); return; }
    }
    F.toast(`${rows.length} accounts imported`); close(); refresh();
  });
}

// ------------------- bulk cookies -------------------
// Parse one line of the bulk-cookies textarea. Accepts:
//   username,cookie            (CSV)
//   username:cookie            (colon with cookie starting at _|WARNING)
//   username<TAB>cookie        (TSV)
//   user:pass:cookie[:srv]     (legacy 3+ part)
//   _|WARNING:... (bare .ROBLOSECURITY — username becomes a pending placeholder)
// Returns { username, cookie, password?, private_server?, pending?, error? }.
function parseBulkCookieLine(raw) {
  const l = (raw || "").trim();
  if (!l) return null;
  const pending = () => `pending_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;

  // Bare cookie, no delimiters.
  if (/^_\|WARNING/i.test(l) && !/[,\t]/.test(l)) {
    return { username: pending(), cookie: l, pending: true };
  }

  // CSV -- split on first comma.
  const commaIdx = l.indexOf(",");
  if (commaIdx > 0) {
    const u = l.slice(0, commaIdx).trim();
    const c = l.slice(commaIdx + 1).trim();
    if (u && c) return { username: u, cookie: c };
  }

  // TSV -- split on first tab.
  const tabIdx = l.indexOf("\t");
  if (tabIdx > 0) {
    const u = l.slice(0, tabIdx).trim();
    const c = l.slice(tabIdx + 1).trim();
    if (u && c) return { username: u, cookie: c };
  }

  // Colon-delimited. If a _|WARNING token is present, split at its position
  // and read the segments before it as username[:password].
  const widx = l.indexOf("_|WARNING");
  if (widx > 0) {
    const before = l.slice(0, widx).replace(/:$/, "");
    const cookie = l.slice(widx);
    const parts = before.split(":").map((p) => p.trim()).filter(Boolean);
    if (parts.length === 1) return { username: parts[0], cookie };
    if (parts.length === 2) return { username: parts[0], password: parts[1], cookie };
    if (parts.length >= 3) return { username: parts[0], password: parts[1], cookie, private_server: parts.slice(2).join(":") };
  }

  // No warning marker -- fall back to a tolerant "user<delim>cookie" match.
  const m = l.match(/^([A-Za-z0-9_.\-]{2,64})[,:\t](.+)$/);
  if (m) return { username: m[1], cookie: m[2].trim() };

  return { error: "unrecognized format" };
}

function openBulkCookies(refresh, s) {
  const body = F.el(`
    <div class="form bulk-wrap">
      <label>Paste one line per cookie
        <textarea class="input bulk-ta" id="bk-txt" rows="12"
          placeholder="username,_|WARNING:-DO-NOT-SHARE...&#10;username:_|WARNING:...&#10;username&#9;_|WARNING:...&#10;user:pass:_|WARNING:...&#10;_|WARNING:...   (bare cookie, username = pending)"></textarea>
      </label>
      <div class="form-row">
        <label>Default folder
          <select class="input" id="bk-folder">
            <option value="">—</option>
            ${s.folders.map((f) => `<option value="${f.id}">${F.esc(f.name)}</option>`).join("")}
          </select>
        </label>
        <label>Default tags (comma-separated)
          <input class="input" id="bk-tags" placeholder="e.g. bulk, fresh" />
        </label>
      </div>
      <div class="muted bulk-help">
        Accepted: <code>username,cookie</code>, <code>username:cookie</code>,
        <code>username&#9;cookie</code>, one raw <code>_|WARNING:...</code> per line.
        Legacy <code>user:pass:cookie[:privateServer]</code> is also accepted.
        A bare cookie gets a <code>pending_*</code> username placeholder — rename it
        later from the row's Edit modal.
        Cookies are encrypted server-side before storage (pgcrypto). Dedupe by
        (workspace, username).
      </div>
      <div class="bulk-preview" id="bk-preview" style="display:none"></div>
      <div class="bulk-progress" id="bk-progress" style="display:none">
        <div class="bulk-progress-bar"><div class="bulk-progress-fill" id="bk-fill"></div></div>
        <div class="muted" id="bk-prog-text">0 / 0</div>
      </div>
      <div class="bulk-results" id="bk-results" style="display:none"></div>
    </div>
  `);
  const foot = F.el(`<div style="display:flex;gap:8px;justify-content:flex-end;width:100%">
    <button class="btn" data-a="cancel">Cancel</button>
    <button class="btn" data-a="preview">Preview</button>
    <button class="btn primary" data-a="upload" disabled>Upload</button>
  </div>`);
  const { close } = F.modal({ title: "Bulk cookie upload", body, footer: foot, width: 640 });

  const previewEl = body.querySelector("#bk-preview");
  const progressEl = body.querySelector("#bk-progress");
  const fillEl = body.querySelector("#bk-fill");
  const progTextEl = body.querySelector("#bk-prog-text");
  const resultsEl = body.querySelector("#bk-results");
  const uploadBtn = foot.querySelector("[data-a='upload']");
  let parsed = [];

  foot.querySelector("[data-a='cancel']").addEventListener("click", close);

  foot.querySelector("[data-a='preview']").addEventListener("click", () => {
    const text = body.querySelector("#bk-txt").value || "";
    const lines = text.split(/\r?\n/);
    const seen = new Set();
    parsed = lines.map((raw, idx) => {
      const r = parseBulkCookieLine(raw);
      if (r === null) return null;
      r._line = idx + 1;
      r._raw = raw;
      if (r.error) { r._status = "error"; return r; }
      if (seen.has(r.username.toLowerCase())) { r._status = "dupe"; r.error = "duplicate username in paste"; return r; }
      seen.add(r.username.toLowerCase());
      r._status = r.pending ? "pending" : "ready";
      return r;
    }).filter(Boolean);

    if (!parsed.length) { previewEl.style.display = "none"; uploadBtn.disabled = true; return F.toast("nothing to import", "err"); }

    previewEl.style.display = "";
    previewEl.innerHTML = `
      <table class="tbl bulk-tbl">
        <thead><tr><th>#</th><th>Username</th><th>Cookie</th><th>Status</th></tr></thead>
        <tbody>${parsed.map((r) => `
          <tr class="bulk-row bulk-row-${r._status}">
            <td class="muted">${r._line}</td>
            <td>${F.esc(r.username || "—")}</td>
            <td class="bulk-cookie">${F.esc(cookiePrefix(r.cookie))}</td>
            <td>${F.esc(r.error ? r.error : (r._status === "pending" ? "pending username" : "ready"))}</td>
          </tr>`).join("")}</tbody>
      </table>
      <div class="muted bulk-help">${parsed.filter((r) => !r.error).length} ready, ${parsed.filter((r) => r.error).length} skipped.</div>
    `;
    uploadBtn.disabled = parsed.every((r) => r.error);
  });

  uploadBtn.addEventListener("click", async () => {
    const ready = parsed.filter((r) => !r.error);
    if (!ready.length) return F.toast("nothing to upload", "err");

    const folder = body.querySelector("#bk-folder").value || null;
    const tagsExtra = body.querySelector("#bk-tags").value.split(",").map((t) => t.trim()).filter(Boolean);
    const rows = ready.map((r) => ({
      username: r.username,
      cookie: r.cookie,
      password: r.password || null,
      private_server: r.private_server || null,
      folder_id: folder,
      tags: tagsExtra,
    }));

    uploadBtn.disabled = true;
    progressEl.style.display = "";
    resultsEl.style.display = "none";

    const CHUNK = 25;
    const total = rows.length;
    const allResults = [];
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      let chunkResults = [];
      try {
        const { data, error } = await F.sb.rpc("fn_bulk_insert_accounts", { p_rows: chunk });
        if (error) throw error;
        chunkResults = Array.isArray(data) ? data : [];
        if (chunkResults.length < chunk.length) {
          // Pad with generic failures so row alignment survives.
          for (let k = chunkResults.length; k < chunk.length; k++) {
            chunkResults.push({ ok: false, username: chunk[k].username, error: "no row returned" });
          }
        }
      } catch (e) {
        chunkResults = chunk.map((row) => ({ ok: false, username: row.username, error: e.message || String(e) }));
      }
      allResults.push(...chunkResults);
      const done = Math.min(total, i + chunk.length);
      fillEl.style.width = `${Math.round((done / total) * 100)}%`;
      progTextEl.textContent = `${done} / ${total}`;
    }

    const okRows = allResults.filter((r) => r.ok);
    const failRows = allResults.filter((r) => !r.ok);
    const inserted = okRows.filter((r) => r.inserted).length;
    const updated = okRows.length - inserted;

    resultsEl.style.display = "";
    resultsEl.innerHTML = `
      <div class="bulk-summary">
        <span class="pill bulk-pill-ok">${inserted} inserted</span>
        <span class="pill bulk-pill-upd">${updated} updated</span>
        <span class="pill bulk-pill-err">${failRows.length} failed</span>
      </div>
      ${failRows.length ? `
      <table class="tbl bulk-tbl">
        <thead><tr><th>Username</th><th>Error</th></tr></thead>
        <tbody>${failRows.map((r) => `
          <tr class="bulk-row bulk-row-error">
            <td>${F.esc(r.username || "—")}</td>
            <td>${F.esc(r.error || "unknown")}</td>
          </tr>`).join("")}</tbody>
      </table>` : ""}
    `;

    if (okRows.length) F.toast(`${okRows.length} account(s) saved`);
    if (failRows.length && !okRows.length) F.toast(`all ${failRows.length} row(s) failed`, "err");
    uploadBtn.disabled = false;
    refresh();
  });
}

function cookiePrefix(c) {
  if (!c) return "—";
  const s = String(c);
  if (s.length <= 24) return s;
  return s.slice(0, 20) + "…(" + s.length + "b)";
}

// ------------------- mass actions -------------------
async function massDelete(s, refresh) {
  const ids = [...s.selected];
  if (!ids.length) return;
  if (!(await F.confirm(`Delete ${ids.length} account(s)? This cannot be undone.`))) return;
  const { error } = await F.sbTable("accounts").delete().in("id", ids);
  if (error) return F.toast(error.message, "err");
  s.selected.clear(); F.toast(`${ids.length} deleted`); refresh();
}

async function massPatch(s, refresh, field, options) {
  const ids = [...s.selected]; if (!ids.length) return;
  const label = field === "folder_id" ? "Folder" : "Config";
  const body = F.el(`
    <div class="form">
      <label>${label}
        <select class="input" id="mp-v">
          <option value="">— unassign —</option>
          ${options.map((o) => `<option value="${o.id}">${F.esc(o.name)}</option>`).join("")}
        </select>
      </label>
    </div>
  `);
  const foot = F.el(`<div style="display:flex;gap:8px;justify-content:flex-end">
    <button class="btn" data-a="cancel">Cancel</button>
    <button class="btn primary" data-a="go">Apply to ${ids.length}</button>
  </div>`);
  const { close } = F.modal({ title: `Mass ${label.toLowerCase()}`, body, footer: foot, width: 420 });
  foot.querySelector("[data-a='cancel']").addEventListener("click", close);
  foot.querySelector("[data-a='go']").addEventListener("click", async () => {
    const v = body.querySelector("#mp-v").value || null;
    const { error } = await F.sbTable("accounts").update({ [field]: v }).in("id", ids);
    if (error) return F.toast(error.message, "err");
    F.toast(`${ids.length} updated`); close(); s.selected.clear(); refresh();
  });
}

async function massTag(s, refresh, mode) {
  const ids = [...s.selected]; if (!ids.length) return;
  const body = F.el(`
    <div class="form">
      <label>Tag <input class="input" id="mt-v" placeholder="e.g. buck 1m+" /></label>
    </div>
  `);
  const foot = F.el(`<div style="display:flex;gap:8px;justify-content:flex-end">
    <button class="btn" data-a="cancel">Cancel</button>
    <button class="btn primary" data-a="go">${mode === "add" ? "Add" : "Remove"} tag on ${ids.length}</button>
  </div>`);
  const { close } = F.modal({ title: `Mass ${mode} tag`, body, footer: foot, width: 420 });
  foot.querySelector("[data-a='cancel']").addEventListener("click", close);
  foot.querySelector("[data-a='go']").addEventListener("click", async () => {
    const tag = body.querySelector("#mt-v").value.trim(); if (!tag) return;
    const progressToast = F.toast(`${mode === "add" ? "tagging" : "untagging"} ${ids.length}…`);
    // Prefer the single-RPC bulk path; fall back to a per-row loop when the
    // RPC is missing on this DB.
    const { error: rpcErr } = await F.sb.rpc("fn_bulk_tag_accounts", {
      p_ids: ids,
      p_add:    mode === "add"    ? [tag] : [],
      p_remove: mode === "remove" ? [tag] : [],
    });
    if (rpcErr) {
      const { data: rows } = await F.sbTable("accounts").select("id,tags").in("id", ids);
      for (const r of rows || []) {
        const t = new Set(r.tags || []);
        mode === "add" ? t.add(tag) : t.delete(tag);
        await F.sbTable("accounts").update({ tags: [...t] }).eq("id", r.id);
      }
    }
    F.toast(`${ids.length} ${mode === "add" ? "tagged" : "untagged"}`);
    close(); s.selected.clear(); refresh();
  });
}

})();
