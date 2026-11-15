(function () {
// Devices page — grouped workers, CPU/RAM/clients, last-seen, mass configure.
window.F = window.F || {};
F.pages = F.pages || {};

// Module-level handles so re-mounts can tear down the previous realtime
// subscription instead of stacking N listeners (one per re-mount).
let _devicesChannel = null;
let _devicesRefresh = null;
// v2: per-expanded-device channel for device_client_states. Only one
// device is expanded at a time to keep the realtime fanout cheap; opening
// a second device tears the previous channel down. { id, channel } shape
// so hashchange cleanup can reach both.
let _expanded = null; // { id, channel, rows: Map<pid, row>, timer }

F.pages.devices = async function (view) {
  // Drop any previous subscription from an earlier mount of this page.
  if (_devicesChannel) {
    try { F.sb.removeChannel(_devicesChannel); } catch (e) { /* no-op */ }
    _devicesChannel = null;
  }
  // v2: tear down any lingering per-device expansion channel too.
  closeExpansion();

  view.innerHTML = `
    <h1>Devices</h1>
    <div class="card">
      <div class="card-h">
        <span id="count">0</span> devices · <span id="active" class="muted">0 active</span>
        <div class="spacer"></div>
        <button class="btn" id="btn-group">+ New Group</button>
        <button class="btn primary" id="btn-key">+ Worker key</button>
      </div>
      <div id="dev-grid"><div class="loading">loading…</div></div>
    </div>
  `;

  _devicesRefresh = load;
  view.querySelector("#btn-group").addEventListener("click", () => openGroupModal(_devicesRefresh));
  view.querySelector("#btn-key").addEventListener("click", openKeyModal);

  await load();

  // Live refresh via Supabase realtime on device_states.
  _devicesChannel = F.sb.channel("devices")
    .on("postgres_changes", { event: "*", schema: "public", table: "device_states" }, () => load())
    .on("postgres_changes", { event: "*", schema: "public", table: "devices" }, () => load())
    .subscribe();
  // Clean up when navigating away.
  window.addEventListener("hashchange", () => {
    if (_devicesChannel) {
      try { F.sb.removeChannel(_devicesChannel); } catch (e) { /* no-op */ }
      _devicesChannel = null;
    }
    closeExpansion();
  }, { once: true });
};

// -------------------- expansion plumbing --------------------
function closeExpansion() {
  if (!_expanded) return;
  try { if (_expanded.channel) F.sb.removeChannel(_expanded.channel); } catch (_e) { /* no-op */ }
  if (_expanded.timer)  { try { clearInterval(_expanded.timer);  } catch (_e) {} }
  if (_expanded.timer2) { try { clearInterval(_expanded.timer2); } catch (_e) {} }
  _expanded = null;
}

async function load() {
  // v21: device_states is now append-only + monthly-partitioned, so
  // "select *" would return every historical heartbeat. Read the
  // latest-per-device view instead so we keep one row per device_id.
  const [{ data: devs }, { data: states }, { data: groups }] = await Promise.all([
    F.sbTable("devices").select("id,name,code_name,enabled,version_channel,last_seen_at,group_id,accounts_count,config").order("name"),
    F.sbTable("device_states_latest").select("*"),
    F.sbTable("device_groups").select("id,name").order("name"),
  ]);
  const list   = devs || [];
  const stMap  = Object.fromEntries((states || []).map((s) => [s.device_id, s]));
  const grpMap = Object.fromEntries((groups || []).map((g) => [g.id, g.name]));
  const activeN = list.filter((d) => isOnline(d, stMap[d.id])).length;

  document.getElementById("count").textContent = list.length;
  document.getElementById("active").textContent = `${activeN} active`;

  const grid = document.getElementById("dev-grid");
  if (!list.length) {
    grid.innerHTML = `<div class="empty">no devices yet — run the worker agent on a PC and point it at this project</div>`;
    return;
  }

  // Group → device cards.
  const buckets = {};
  list.forEach((d) => {
    const g = d.group_id ? grpMap[d.group_id] || "(unknown group)" : "Ungrouped";
    (buckets[g] ||= []).push(d);
  });

  grid.innerHTML = Object.entries(buckets).map(([group, items]) => `
    <div class="dev-group">
      <div class="dev-group-h">${F.esc(group)} <span class="muted">${items.length}</span></div>
      <div class="dev-cards">
        ${items.map((d) => cardHtml(d, stMap[d.id])).join("")}
      </div>
    </div>
  `).join("");

  grid.querySelectorAll("[data-edit]").forEach((b) =>
    b.addEventListener("click", (e) => openDeviceModal(e.target.dataset.edit, load))
  );
  grid.querySelectorAll("[data-cfg]").forEach((b) =>
    b.addEventListener("click", (e) => openDeviceConfigModal(e.target.dataset.cfg, load))
  );
  grid.querySelectorAll("[data-jump]").forEach((b) =>
    b.addEventListener("click", (e) => { location.hash = `#/accounts?device=${encodeURIComponent(e.target.dataset.jump)}`; })
  );
  // v2: expand/collapse the per-client table.
  grid.querySelectorAll("[data-expand]").forEach((b) =>
    b.addEventListener("click", (e) => {
      const id = e.target.dataset.expand;
      if (_expanded && _expanded.id === id) {
        closeExpansion(); load();
      } else {
        closeExpansion();
        openExpansion(id).catch((err) => F.toast(err.message || String(err), "err"));
      }
    })
  );
  // v2: pause / resume. One RPC per click; realtime on devices updates
  // the pill and the button label on the next load() tick.
  grid.querySelectorAll("[data-pause]").forEach((b) =>
    b.addEventListener("click", async (e) => {
      const id = e.target.dataset.pause;
      const next = !(e.target.dataset.paused === "true");
      e.target.disabled = true;
      const { error } = await F.sb.rpc("fn_device_set_paused", {
        p_device_id: id, p_paused: next,
      });
      e.target.disabled = false;
      if (error) return F.toast(error.message, "err");
      F.toast(next ? "paused" : "resumed");
      load();
    })
  );
  // If a device is currently expanded, (re)hydrate its panel after the
  // top-level re-render clobbered the previous DOM node.
  if (_expanded) renderExpansionPanel();
}

// -------------------- per-client expansion panel --------------------
async function openExpansion(deviceId) {
  _expanded = { id: deviceId, channel: null, rows: new Map(), timer: null };
  // Initial pull: one SELECT with the embedded account username so the
  // table has a usable label the first paint.
  const { data, error } = await F.sbTable("device_client_states")
    .select("device_id,pid,account_id,state,kind,rss_mb,hwnd,game_pid,since_at,updated_at,accounts(username)")
    .eq("device_id", deviceId)
    .order("pid");
  if (error) {
    _expanded = null;
    throw error;
  }
  for (const r of data || []) {
    const username = r.accounts && r.accounts.username ? r.accounts.username : null;
    _expanded.rows.set(r.pid, { ...r, username });
  }
  renderExpansionPanel();
  // Subscribe to realtime changes on this device's rows.
  _expanded.channel = F.sb.channel(`dev-clients-${deviceId}`)
    .on("postgres_changes", {
      event: "*", schema: "public", table: "device_client_states",
      filter: `device_id=eq.${deviceId}`,
    }, (payload) => onClientChange(deviceId, payload))
    .subscribe();
  // Re-render every 2s so since_ms columns tick without a schema push.
  _expanded.timer = setInterval(renderExpansionPanel, 2000);
  // Fallback refresh in case realtime drops: full fetch every 15s.
  _expanded.timer2 = setInterval(() => rehydrateExpansion(deviceId), 15000);
}

async function rehydrateExpansion(deviceId) {
  if (!_expanded || _expanded.id !== deviceId) return;
  const { data } = await F.sbTable("device_client_states")
    .select("device_id,pid,account_id,state,kind,rss_mb,hwnd,game_pid,since_at,updated_at,accounts(username)")
    .eq("device_id", deviceId)
    .order("pid");
  const next = new Map();
  for (const r of data || []) {
    const username = r.accounts && r.accounts.username ? r.accounts.username : null;
    next.set(r.pid, { ...r, username });
  }
  _expanded.rows = next;
  renderExpansionPanel();
}

async function onClientChange(deviceId, payload) {
  if (!_expanded || _expanded.id !== deviceId) return;
  const row = payload.new || payload.old;
  if (!row) return;
  if (payload.eventType === "DELETE") {
    _expanded.rows.delete(row.pid);
    renderExpansionPanel();
    return;
  }
  // Realtime payloads don't carry embedded relations, so look up
  // username lazily. Reuse what we already have when possible.
  const prev = _expanded.rows.get(row.pid);
  let username = prev && prev.username || null;
  if (!username && row.account_id) {
    try {
      const { data: acc } = await F.sbTable("accounts")
        .select("username").eq("id", row.account_id).single();
      if (acc) username = acc.username;
    } catch (_e) { /* best-effort */ }
  }
  _expanded.rows.set(row.pid, { ...row, username });
  renderExpansionPanel();
}

function renderExpansionPanel() {
  if (!_expanded) return;
  const panel = document.querySelector(`[data-expand-panel="${_expanded.id}"]`);
  if (!panel) return;
  const rows = [..._expanded.rows.values()].sort((a, b) => a.pid - b.pid);
  if (!rows.length) {
    panel.innerHTML = `<div class="muted small" style="padding:10px">no live clients on this device</div>`;
    return;
  }
  const now = Date.now();
  panel.innerHTML = `
    <table class="dev-clients" style="width:100%; border-collapse:collapse; font-size:12px; margin-top:6px">
      <thead>
        <tr style="text-align:left; color:var(--muted)">
          <th style="padding:4px 6px">pid</th>
          <th style="padding:4px 6px">account</th>
          <th style="padding:4px 6px">state</th>
          <th style="padding:4px 6px">kind</th>
          <th style="padding:4px 6px">rss</th>
          <th style="padding:4px 6px">since</th>
          <th style="padding:4px 6px"></th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((r) => clientRowHtml(r, now)).join("")}
      </tbody>
    </table>`;
  panel.querySelectorAll("[data-kill]").forEach((b) =>
    b.addEventListener("click", async (e) => {
      const pid = Number(e.target.dataset.kill);
      if (!Number.isFinite(pid)) return;
      if (!(await F.confirm(`Kill pid ${pid} on this device?`))) return;
      e.target.disabled = true;
      const { error } = await F.sb.rpc("fn_worker_kill_client", {
        p_device_id: _expanded.id, p_pid: pid,
      });
      e.target.disabled = false;
      if (error) return F.toast(error.message, "err");
      F.toast(`kill queued for pid ${pid}`);
    })
  );
}

function clientRowHtml(r, now) {
  const since = r.since_at ? new Date(r.since_at).getTime() : null;
  const sinceMs = since ? Math.max(0, now - since) : null;
  const sinceStr = sinceMs != null ? humanMs(sinceMs) : "—";
  const stateColor = {
    joined:   "var(--ok, #2d9c2d)",
    joining:  "var(--warn, #c38a00)",
    spawning: "var(--muted)",
    dead:     "var(--err, #c84040)",
  }[r.state] || "var(--muted)";
  return `
    <tr>
      <td style="padding:4px 6px; font-family:monospace">${F.esc(String(r.pid))}</td>
      <td style="padding:4px 6px">${F.esc(r.username || (r.account_id ? r.account_id.slice(0, 8) : "—"))}</td>
      <td style="padding:4px 6px; color:${stateColor}">${F.esc(r.state || "?")}</td>
      <td style="padding:4px 6px"><span class="muted small">${F.esc(r.kind || "—")}</span></td>
      <td style="padding:4px 6px">${r.rss_mb != null ? r.rss_mb + " MB" : "—"}</td>
      <td style="padding:4px 6px"><span class="muted small">${F.esc(sinceStr)}</span></td>
      <td style="padding:4px 6px; text-align:right">
        <button class="btn danger" data-kill="${r.pid}">Kill</button>
      </td>
    </tr>`;
}

function humanMs(ms) {
  if (!Number.isFinite(ms)) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d`;
}

function isOnline(dev, st) {
  if (!dev.enabled) return false;
  const seen = dev.last_seen_at && new Date(dev.last_seen_at).getTime();
  return seen && Date.now() - seen < 60_000;   // 60s heartbeat tolerance
}

function cardHtml(d, st) {
  const online = isOnline(d, st);
  // Postgres `numeric` is serialised by Supabase as a JSON string, so
  // st.cpu_pct / st.ram_pct arrive as strings and `.toFixed` would throw.
  // Coerce via Number() and only format once we know it's finite.
  const cpuN = st?.cpu_pct != null ? Number(st.cpu_pct) : null;
  const ramN = st?.ram_pct != null ? Number(st.ram_pct) : null;
  const cpu = (cpuN != null && isFinite(cpuN)) ? cpuN.toFixed(1) + "%" : "—";
  const ram = (ramN != null && isFinite(ramN)) ? ramN.toFixed(0) + "%" : (st?.ram_mb ? `${st.ram_mb} MB` : "—");
  const seen = d.last_seen_at ? timeAgo(d.last_seen_at) : "never";
  // v2: paused pill + Pause/Resume button source of truth is
  // devices.config.paused. config comes from the devices row which the
  // top-of-page query includes via the Supabase select (see load()).
  const cfg = d.config || {};
  const paused = !!cfg.paused;
  const isOpen = _expanded && _expanded.id === d.id;
  return `
    <div class="dev-card" data-online="${online}" data-dev="${d.id}">
      <div class="dev-card-h">
        <span class="dev-dot ${online ? "on" : "off"}"></span>
        <span class="dev-name">${F.esc(d.name)}</span>
        ${d.enabled ? "" : '<span class="pill" data-s="disabled">disabled</span>'}
        ${paused ? '<span class="pill" data-s="paused">paused</span>' : ''}
        <div class="spacer"></div>
        <span class="muted small">${F.esc(d.version_channel)}</span>
      </div>
      <div class="dev-code muted small">${F.esc(d.code_name || "")}</div>
      <div class="dev-stats">
        <div><span class="k">Accounts</span><span class="v">${d.accounts_count ?? 0}</span></div>
        <div><span class="k">Active</span>  <span class="v">${st?.active ?? 0}</span></div>
        <div><span class="k">Unstable</span><span class="v">${st?.unstable ?? 0}</span></div>
        <div><span class="k">CPU</span>     <span class="v">${cpu}</span></div>
        <div><span class="k">RAM</span>     <span class="v">${ram}</span></div>
        <div><span class="k">Seen</span>    <span class="v">${seen}</span></div>
      </div>
      <div class="dev-actions">
        <button class="btn" data-expand="${d.id}">${isOpen ? "Hide clients" : "Show clients"}</button>
        <button class="btn" data-pause="${d.id}" data-paused="${paused}">${paused ? "Resume" : "Pause"}</button>
        <button class="btn" data-jump="${d.id}">Open accounts</button>
        <button class="btn" data-cfg="${d.id}" title="Runtime config (micro, max clients)">Settings</button>
        <button class="btn" data-edit="${d.id}">Edit</button>
      </div>
      ${isOpen ? `<div class="dev-expand" data-expand-panel="${d.id}"><div class="muted small" style="padding:8px">loading clients…</div></div>` : ''}
    </div>`;
}

function timeAgo(iso) {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

// -------------------- device edit modal --------------------
async function openDeviceModal(id, refresh) {
  const [{ data: row }, { data: groups }, { data: channels }] = await Promise.all([
    F.sbTable("devices").select("*").eq("id", id).single(),
    F.sbTable("device_groups").select("id,name").order("name"),
    F.sbTable("update_channels").select("name").order("name"),
  ]);
  const chanNames = (channels || []).map((c) => c.name);
  if (row.version_channel && !chanNames.includes(row.version_channel)) chanNames.unshift(row.version_channel);
  const body = F.el(`
    <div class="form">
      <label>Name <input class="input" data-k="name" value="${F.esc(row.name)}" /></label>
      <label>Group
        <select class="input" data-k="group_id">
          <option value="">Ungrouped</option>
          ${(groups || []).map((g) => `<option value="${g.id}" ${row.group_id === g.id ? "selected" : ""}>${F.esc(g.name)}</option>`).join("")}
        </select>
      </label>
      <label>Update channel
        <select class="input" data-k="version_channel">
          ${chanNames.map((n) => `<option ${row.version_channel === n ? "selected" : ""}>${F.esc(n)}</option>`).join("")}
        </select>
      </label>
      <label><input type="checkbox" data-k="enabled" ${row.enabled ? "checked" : ""} /> Enabled</label>
    </div>
  `);
  const foot = F.el(`<div style="display:flex;gap:8px;justify-content:space-between;width:100%">
    <button class="btn danger" data-a="del">Delete</button>
    <div style="display:flex;gap:8px">
      <button class="btn" data-a="cancel">Cancel</button>
      <button class="btn primary" data-a="save">Save</button>
    </div>
  </div>`);
  const { close } = F.modal({ title: `Edit ${row.name}`, body, footer: foot, width: 440 });
  foot.querySelector("[data-a='cancel']").addEventListener("click", close);
  foot.querySelector("[data-a='save']").addEventListener("click", async () => {
    const patch = {};
    body.querySelectorAll("[data-k]").forEach((el) => {
      const k = el.dataset.k;
      patch[k] = el.type === "checkbox" ? el.checked : (el.value || null);
    });
    const { error } = await F.sbTable("devices").update(patch).eq("id", id);
    if (error) return F.toast(error.message, "err");
    F.toast("saved"); close(); refresh();
  });
  foot.querySelector("[data-a='del']").addEventListener("click", async () => {
    if (!(await F.confirm(`Remove ${row.name} from your fleet?`))) return;
    const { error } = await F.sbTable("devices").delete().eq("id", id);
    if (error) return F.toast(error.message, "err");
    F.toast("removed"); close(); refresh();
  });
}

// -------------------- device runtime config modal --------------------
// Per-device { micro_mode, max_clients }. Persisted on devices.config
// jsonb; worker hot-reloads it on the next heartbeat (fn_worker_heartbeat
// returns the row's config). See supabase_v11_device_config.sql.
async function openDeviceConfigModal(id, refresh) {
  const { data: row, error: rowErr } =
    await F.sbTable("devices").select("id,name,config").eq("id", id).single();
  if (rowErr) return F.toast(rowErr.message, "err");
  const cfg = row.config || {};
  const micro = !!cfg.micro_mode;
  const maxC  = Number.isFinite(cfg.max_clients) ? cfg.max_clients : 20;
  const batch   = Number.isFinite(cfg.launch_batch_size) ? cfg.launch_batch_size : 5;
  const batchCd = Number.isFinite(cfg.launch_batch_cooldown_s) ? cfg.launch_batch_cooldown_s : 30;
  const px = cfg.proxy || {};
  const pxEnabled = !!px.enabled;
  const pxLogin   = px.login    || "";
  const pxPass    = px.password || "";
  const pxCountry = px.country  || "us";
  const pxPort    = Number.isFinite(px.port)  ? px.port  : 823;
  const pxCount   = Number.isFinite(px.count) ? px.count : 50;
  // v3.9 — tile + hub knobs.
  const tileOn    = cfg.tile_windows !== false;         // default true
  const tileCols  = Number.isFinite(cfg.tile_cols) ? cfg.tile_cols : 0;
  const tileW     = Number.isFinite(cfg.tile_w)    ? cfg.tile_w    : 320;
  const tileH     = Number.isFinite(cfg.tile_h)    ? cfg.tile_h    : 220;
  const hopOn     = cfg.public_server_hop !== false;    // default true
  const aggrOn    = cfg.aggressive_fflags !== false;    // default true

  const body = F.el(`
    <div class="form">
      <label style="display:flex;align-items:center;gap:8px">
        <input type="checkbox" data-k="micro_mode" ${micro ? "checked" : ""} />
        <span>Micro-mode <span class="muted small">(spawn via launcher, minimize + WS trim)</span></span>
      </label>
      <label>Max clients
        <input class="input" type="number" min="10" max="200" step="1"
               data-k="max_clients" value="${maxC}" />
      </label>
      <label>Launch batch size
        <input class="input" type="number" min="0" max="100" step="1"
               data-k="launch_batch_size" value="${batch}" />
        <div class="muted small">how many accounts can start joining per window — 0 = no throttle</div>
      </label>
      <label>Launch batch cooldown (s)
        <input class="input" type="number" min="1" max="600" step="1"
               data-k="launch_batch_cooldown_s" value="${batchCd}" />
        <div class="muted small">delay between batches, e.g. 5 every 30 s</div>
      </label>
      <hr style="border:0;border-top:1px solid var(--line);margin:12px 0" />
      <div style="font-weight:600;margin-bottom:6px">Proxy (Proxifier / DataImpulse)</div>
      <label style="display:flex;align-items:center;gap:8px">
        <input type="checkbox" data-k="proxy_enabled" ${pxEnabled ? "checked" : ""} />
        <span>Route RobloxPlayerBeta via Proxifier</span>
      </label>
      <label>DataImpulse login
        <input class="input" type="text" data-k="proxy_login" value="${pxLogin}" placeholder="your DataImpulse username" />
      </label>
      <label>DataImpulse password
        <input class="input" type="password" data-k="proxy_password" value="${pxPass}" />
      </label>
      <div style="display:flex;gap:8px">
        <label style="flex:1">Country
          <input class="input" type="text" data-k="proxy_country" value="${pxCountry}" maxlength="4" placeholder="us" />
        </label>
        <label style="flex:1">Port
          <input class="input" type="number" data-k="proxy_port" value="${pxPort}" min="1" max="65535" />
        </label>
        <label style="flex:1">Sticky sessions
          <input class="input" type="number" data-k="proxy_count" value="${pxCount}" min="1" max="1000" />
        </label>
      </div>
      <div class="muted small">
        Cometium regenerates <code>C:\\FarmerV5\\farmer.ppx</code> on save.
        Open it in Proxifier once (Profile → Open), then every RobloxPlayerBeta
        goes through a sticky residential IP.
      </div>
      <div class="muted small">
        Applies live — the worker picks it up on the next heartbeat (≤10 s),
        no restart needed.
      </div>
      <hr style="border:0;border-top:1px solid var(--line);margin:12px 0" />
      <div style="font-weight:600;margin-bottom:6px">Window tiling + hub</div>
      <label style="display:flex;align-items:center;gap:8px">
        <input type="checkbox" data-k="tile_windows" ${tileOn ? "checked" : ""} />
        <span>Arrange Roblox windows in a grid every 60 s</span>
      </label>
      <div style="display:flex;gap:8px">
        <label style="flex:1">Columns (0 = auto)
          <input class="input" type="number" data-k="tile_cols" value="${tileCols}" min="0" max="10" />
        </label>
        <label style="flex:1">Cell width
          <input class="input" type="number" data-k="tile_w" value="${tileW}" min="160" max="800" />
        </label>
        <label style="flex:1">Cell height
          <input class="input" type="number" data-k="tile_h" value="${tileH}" min="120" max="800" />
        </label>
      </div>
      <label style="display:flex;align-items:center;gap:8px;margin-top:8px">
        <input type="checkbox" data-k="public_server_hop" ${hopOn ? "checked" : ""} />
        <span>Hop to a public server on join (per-account anti-correlation)</span>
      </label>
      <label style="display:flex;align-items:center;gap:8px">
        <input type="checkbox" data-k="aggressive_fflags" ${aggrOn ? "checked" : ""} />
        <span>Aggressive FFlags (lower FPS cap, textures, shaders)</span>
      </label>
    </div>
  `);
  const foot = F.el(`<div style="display:flex;gap:8px;justify-content:flex-end;width:100%">
    <button class="btn" data-a="cancel">Cancel</button>
    <button class="btn primary" data-a="save">Save</button>
  </div>`);
  const { close } = F.modal({ title: `Settings — ${row.name}`, body, footer: foot, width: 420 });
  foot.querySelector("[data-a='cancel']").addEventListener("click", close);
  foot.querySelector("[data-a='save']").addEventListener("click", async () => {
    const micEl = body.querySelector("[data-k='micro_mode']");
    const maxEl = body.querySelector("[data-k='max_clients']");
    const batEl = body.querySelector("[data-k='launch_batch_size']");
    const cdEl  = body.querySelector("[data-k='launch_batch_cooldown_s']");
    const maxV  = Math.floor(Number(maxEl.value));
    const batV  = Math.floor(Number(batEl.value));
    const cdV   = Math.floor(Number(cdEl.value));
    if (!Number.isFinite(maxV) || maxV < 10 || maxV > 200) {
      return F.toast("max_clients must be 10..200", "err");
    }
    if (!Number.isFinite(batV) || batV < 0 || batV > 100) {
      return F.toast("launch_batch_size must be 0..100", "err");
    }
    if (!Number.isFinite(cdV) || cdV < 1 || cdV > 600) {
      return F.toast("launch_batch_cooldown_s must be 1..600", "err");
    }
    const patch = {
      micro_mode: micEl.checked,
      max_clients: maxV,
      launch_batch_size: batV,
      launch_batch_cooldown_s: cdV,
      tile_windows:      body.querySelector("[data-k='tile_windows']").checked,
      tile_cols:         Math.floor(Number(body.querySelector("[data-k='tile_cols']").value) || 0),
      tile_w:            Math.floor(Number(body.querySelector("[data-k='tile_w']").value) || 320),
      tile_h:            Math.floor(Number(body.querySelector("[data-k='tile_h']").value) || 220),
      public_server_hop: body.querySelector("[data-k='public_server_hop']").checked,
      aggressive_fflags: body.querySelector("[data-k='aggressive_fflags']").checked,
      proxy: {
        enabled:  body.querySelector("[data-k='proxy_enabled']").checked,
        mode:     "datampulse",
        login:    body.querySelector("[data-k='proxy_login']").value.trim(),
        password: body.querySelector("[data-k='proxy_password']").value,
        country:  (body.querySelector("[data-k='proxy_country']").value.trim() || "us").toLowerCase(),
        port:     Math.floor(Number(body.querySelector("[data-k='proxy_port']").value) || 823),
        count:    Math.floor(Number(body.querySelector("[data-k='proxy_count']").value) || 50),
      },
    };
    const { error } = await F.sb.rpc("fn_device_set_config", {
      p_device_id: id, p_config: patch,
    });
    if (error) return F.toast(error.message, "err");
    F.toast("saved — worker will pick it up"); close(); refresh();
  });
}

// -------------------- new group modal --------------------
function openGroupModal(refresh) {
  const body = F.el(`<div class="form">
    <label>Name <input class="input" id="gname" placeholder="e.g. Home PCs, Cloud VPS" /></label>
  </div>`);
  const foot = F.el(`<div style="display:flex;gap:8px;justify-content:flex-end">
    <button class="btn" data-a="cancel">Cancel</button>
    <button class="btn primary" data-a="save">Create</button>
  </div>`);
  const { close } = F.modal({ title: "New device group", body, footer: foot, width: 380 });
  foot.querySelector("[data-a='cancel']").addEventListener("click", close);
  foot.querySelector("[data-a='save']").addEventListener("click", async () => {
    const name = body.querySelector("#gname").value.trim();
    if (!name) return;
    const { data: me } = await F.sb.auth.getUser();
    const { error } = await F.sbTable("device_groups").insert({ owner_id: me.user.id, name });
    if (error) return F.toast(error.message, "err");
    close();
    // Reload the existing mount (table + bucket re-render) without re-
    // invoking F.pages.devices — that path re-subscribes to realtime and
    // would leak channels on every group creation.
    if (typeof refresh === "function") await refresh();
  });
}

// -------------------- worker API key modal --------------------
function openKeyModal() {
  // v3.9 — lifetime ladder so he can hand out time-boxed worker keys
  // (same semantics as Settings → + New key). "Lifetime (never expires)"
  // keeps the old behavior for his own PCs; the 24h / 7d / 30d options
  // are for giving.
  const LIFETIMES = [
    { h: 0,      label: "Lifetime (never expires)" },
    { h: 24,     label: "24 hours" },
    { h: 24*7,   label: "7 days" },
    { h: 24*30,  label: "30 days" },
    { h: 24*90,  label: "90 days" },
    { h: -1,     label: "Custom…" },
  ];
  const body = F.el(`<div class="form">
    <label>Key name
      <input class="input" id="kname" placeholder="e.g. L19-worker" />
    </label>
    <label>Lifetime
      <select class="input" id="klife">
        ${LIFETIMES.map((L) => `<option value="${L.h}">${L.label}</option>`).join("")}
      </select>
    </label>
    <label id="kcustom-row" style="display:none">Custom hours
      <input class="input" type="number" id="kcustom" min="1" max="87600" step="1" placeholder="e.g. 48" />
      <div class="muted small">1 hour – 10 years</div>
    </label>
    <div class="muted" style="font-size:11px">
      Generates a worker-scoped api key. Stored hashed; shown ONCE. Paste it into
      the worker's <code>config.json</code>.
    </div>
    <div id="kout" style="display:none; padding:10px; background:var(--bg); border-radius:6px; margin-top:8px">
      <div class="muted small">your new key — copy it now</div>
      <code id="ktoken" style="user-select:all; word-break:break-all; display:block; margin-top:6px"></code>
    </div>
  </div>`);
  const foot = F.el(`<div style="display:flex;gap:8px;justify-content:flex-end">
    <button class="btn" data-a="close">Close</button>
    <button class="btn primary" data-a="gen">Generate</button>
  </div>`);
  const { close } = F.modal({ title: "New worker key", body, footer: foot, width: 500 });
  body.querySelector("#klife").addEventListener("change", (e) => {
    body.querySelector("#kcustom-row").style.display = (e.target.value === "-1") ? "" : "none";
  });
  foot.querySelector("[data-a='close']").addEventListener("click", close);
  foot.querySelector("[data-a='gen']").addEventListener("click", async () => {
    const name = body.querySelector("#kname").value.trim(); if (!name) return;
    const lifeSel = Number(body.querySelector("#klife").value);
    let lifetime = lifeSel;
    if (lifeSel === -1) {
      lifetime = Math.floor(Number(body.querySelector("#kcustom").value));
      if (!Number.isFinite(lifetime) || lifetime < 1 || lifetime > 87600) {
        return F.toast("Custom lifetime must be 1 – 87600 hours", "err");
      }
    }
    const params = { p_name: name, p_access: "worker" };
    if (lifetime > 0) params.p_lifetime_hours = lifetime;
    const { data, error } = await F.sb.rpc("fn_create_api_key", params);
    if (error) return F.toast(error.message, "err");
    body.querySelector("#ktoken").textContent = data;
    body.querySelector("#kout").style.display = "";
    foot.querySelector("[data-a='gen']").disabled = true;
    F.toast("key created — copy it now");
  });
}

})();
