(function () {
// Configs page — grid of config tiles + per-config edit view with left sidebar nav.
// Routes: #/configs (grid), #/configs/<id> (edit; sections switched in-page).
window.F = window.F || {};
F.pages = F.pages || {};

// Known games. Badge letters are the user's shorthand.
// DB rows may use dashes (adopt-me) or underscores (adopt_me); normalizeSlug
// folds them to one key so both hit the same badge.
function normalizeSlug(s) { return String(s || "").toLowerCase().replace(/_/g, "-"); }
const _RAW_GAMES = {
  adopt_me:        { label: "Adopt Me!",         badge: "AM", color: "#f5a524" },
  mm2:             { label: "Murder Mystery 2",  badge: "MM", color: "#ff6b6b" },
  blox_fruits:     { label: "Blox Fruits",       badge: "BF", color: "#4ea6ff" },
  aot_revolution:  { label: "AOT: Revolution",   badge: "AR", color: "#b084f0" },
  grow_a_garden:   { label: "Grow a Garden",     badge: "GG", color: "#4ade80" },
};
const GAMES = {};
for (const [k, v] of Object.entries(_RAW_GAMES)) {
  GAMES[k] = v;
  GAMES[normalizeSlug(k)] = v;
}
const GAME_KEYS = Object.keys(_RAW_GAMES);

// Mirror of GAME_PLACE_IDS in games.js so new scripts get bound to the right
// placeId on creation. Keep in sync.
const GAME_PLACE_IDS = {
  adopt_me:        920587237,
  mm2:             142823291,
  blox_fruits:     2753915549,
  aot_revolution:  null,
  grow_a_garden:   null,
};
function placeIdForSlug(slug) {
  const direct = GAME_PLACE_IDS[slug];
  if (direct !== undefined) return direct;
  const norm = normalizeSlug(slug);
  for (const k of Object.keys(GAME_PLACE_IDS)) {
    if (normalizeSlug(k) === norm) return GAME_PLACE_IDS[k];
  }
  return null;
}
const SERVER_MODES = ["public", "private", "user_private", "vip"];

const SECTIONS = [
  { key: "overview",     label: "Overview" },
  { key: "game_server",  label: "Game & Server" },
  { key: "joining",      label: "Joining" },
  { key: "performance",  label: "Performance" },
  { key: "reliability",  label: "Reliability" },
  { key: "scripts",      label: "Scripts" },
  { key: "workspace",    label: "Workspace" },
  { key: "advanced",     label: "Advanced" },
];

F.pages.configs = async function (view) {
  // Parse sub-route: #/configs or #/configs/<uuid>
  const after = location.hash.replace(/^#\/configs\/?/, "");
  const id = after.split("?")[0].split("/")[0] || null;
  if (id) return editView(view, id);
  return gridView(view);
};

// ===================================================================
// Grid view
// ===================================================================
async function gridView(view) {
  view.innerHTML = `
    <h1>Configs</h1>
    <div class="card">
      <div class="card-h">
        <span id="count">0</span> configs
        <div class="spacer"></div>
      </div>
      <div class="cfg-grid" id="grid"><div class="empty">loading…</div></div>
    </div>
  `;

  const [{ data: configs }, { data: scriptCounts }] = await Promise.all([
    F.sbTable("configs").select("id,name,game_slug,server_mode,target_fps,max_joins").order("name"),
    F.sbTable("config_scripts").select("config_id"),
  ]);
  const counts = {};
  (scriptCounts || []).forEach((r) => { counts[r.config_id] = (counts[r.config_id] || 0) + 1; });

  const list = configs || [];
  document.getElementById("count").textContent = list.length;

  const grid = document.getElementById("grid");
  grid.innerHTML =
    `<div class="cfg-tile cfg-tile-new" id="tile-new">
       <div class="cfg-plus">+</div>
       <div class="cfg-new-lbl">New Config</div>
     </div>` +
    list.map((c) => tileHtml(c, counts[c.id] || 0)).join("");

  document.getElementById("tile-new").addEventListener("click", () => openNewConfig(gridRefresh.bind(null, view)));
  grid.querySelectorAll("[data-open]").forEach((el) =>
    el.addEventListener("click", (e) => {
      // Ignore when the kebab menu was clicked.
      if (e.target.closest(".cfg-menu-btn") || e.target.closest(".cfg-menu-pop")) return;
      location.hash = `#/configs/${el.dataset.open}`;
    })
  );
  grid.querySelectorAll(".cfg-menu-btn").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const tile = b.closest(".cfg-tile");
      const pop = tile.querySelector(".cfg-menu-pop");
      document.querySelectorAll(".cfg-menu-pop.open").forEach((p) => { if (p !== pop) p.classList.remove("open"); });
      pop.classList.toggle("open");
    })
  );
  // Click outside closes popovers.
  document.addEventListener("click", () => {
    document.querySelectorAll(".cfg-menu-pop.open").forEach((p) => p.classList.remove("open"));
  }, { once: true });

  grid.querySelectorAll("[data-a]").forEach((b) =>
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = b.dataset.id; const row = list.find((c) => c.id === id);
      const a = b.dataset.a;
      if (a === "edit") location.hash = `#/configs/${id}`;
      if (a === "dup") {
        const name = prompt("Name for the duplicate:", `${row.name} copy`);
        if (!name) return;
        const { data, error } = await F.sb.rpc("fn_duplicate_config", { p_config_id: id, p_new_name: name });
        if (error) return F.toast(error.message, "err");
        F.toast("duplicated"); location.hash = `#/configs/${data}`;
      }
      if (a === "del") {
        if (!(await F.confirm(`Delete config "${row.name}"?`))) return;
        const { error } = await F.sbTable("configs").delete().eq("id", id);
        if (error) return F.toast(error.message, "err");
        F.toast("deleted"); gridRefresh(view);
      }
    })
  );
}

function tileHtml(c, scriptN) {
  const g = GAMES[c.game_slug] || GAMES[normalizeSlug(c.game_slug)] || { label: c.game_slug || "—", badge: "??", color: "#8a8f98" };
  return `
    <div class="cfg-tile" data-open="${c.id}">
      <div class="cfg-tile-head">
        <div class="cfg-badge" style="background:${g.color}">${F.esc(g.badge)}</div>
        <div class="cfg-tile-ttls">
          <div class="cfg-game">${F.esc(g.label)}</div>
          <div class="cfg-name">${F.esc(c.name)}</div>
        </div>
        <button class="cfg-menu-btn" title="menu">⋯</button>
        <div class="cfg-menu-pop">
          <button class="btn" data-a="edit" data-id="${c.id}">Edit</button>
          <button class="btn" data-a="dup"  data-id="${c.id}">Duplicate</button>
          <button class="btn danger" data-a="del" data-id="${c.id}">Delete</button>
        </div>
      </div>
      <div class="cfg-meta">
        ${scriptN} script${scriptN === 1 ? "" : "s"} · ${c.target_fps}fps · ${F.esc(prettyMode(c.server_mode))}
      </div>
    </div>`;
}

function prettyMode(m) {
  return (m || "").split("_").map((w) => w ? w[0].toUpperCase() + w.slice(1) : "").join(" ");
}

function gridRefresh(view) { F.pages.configs(view); }

// ===================================================================
// New config (quick create → opens edit view)
// ===================================================================
function openNewConfig(refresh) {
  const body = F.el(`
    <div class="form">
      <label>Name <input class="input" id="nc-name" placeholder="e.g. adm" /></label>
      <label>Game
        <select class="input" id="nc-game">
          ${GAME_KEYS.map((k) => `<option value="${k}">${F.esc(GAMES[k].label)}</option>`).join("")}
        </select>
      </label>
      <label>Server mode
        <select class="input" id="nc-mode">
          ${SERVER_MODES.map((m) => `<option value="${m}">${F.esc(prettyMode(m))}</option>`).join("")}
        </select>
      </label>
    </div>
  `);
  const foot = F.el(`<div style="display:flex;gap:8px;justify-content:flex-end">
    <button class="btn" data-a="cancel">Cancel</button>
    <button class="btn primary" data-a="save">Create</button>
  </div>`);
  const { close } = F.modal({ title: "New config", body, footer: foot, width: 440 });
  foot.querySelector("[data-a='cancel']").addEventListener("click", close);
  foot.querySelector("[data-a='save']").addEventListener("click", async () => {
    const name = body.querySelector("#nc-name").value.trim();
    if (!name) return F.toast("name required", "err");
    const { data: me } = await F.sb.auth.getUser();
    const { data, error } = await F.sbTable("configs").insert({
      owner_id:    me.user.id,
      name,
      game_slug:   body.querySelector("#nc-game").value,
      server_mode: body.querySelector("#nc-mode").value,
    }).select("id").single();
    if (error) return F.toast(error.message, "err");
    close(); location.hash = `#/configs/${data.id}`;
  });
}

// ===================================================================
// Edit view — left sidebar + section panel
// ===================================================================
async function editView(view, id) {
  const { data: cfg, error } = await F.sbTable("configs").select("*").eq("id", id).single();
  if (error || !cfg) {
    view.innerHTML = `<h1>Config</h1><div class="empty">not found</div>`;
    return;
  }
  const s = { cfg, section: "overview", scripts: [], attachable: [] };

  view.innerHTML = `
    <div class="cfg-edit-head">
      <a class="cfg-back" href="#/configs">← Configs</a>
      <h1 style="margin:0">${F.esc(cfg.name)}</h1>
    </div>
    <div class="cfg-edit">
      <aside class="cfg-edit-nav" id="nav">
        ${SECTIONS.map((sec) => `
          <a class="cfg-nav-item ${sec.key === s.section ? "active" : ""}" data-sec="${sec.key}">${sec.label}</a>
        `).join("")}
        <div class="cfg-edit-nav-foot">
          <button class="btn" id="btn-back-grid">All configs</button>
        </div>
      </aside>
      <section class="cfg-edit-panel card" id="panel"></section>
    </div>
  `;

  view.querySelector("#btn-back-grid").addEventListener("click", () => { location.hash = "#/configs"; });
  view.querySelectorAll(".cfg-nav-item").forEach((a) =>
    a.addEventListener("click", () => {
      s.section = a.dataset.sec;
      view.querySelectorAll(".cfg-nav-item").forEach((n) => n.classList.toggle("active", n.dataset.sec === s.section));
      renderPanel(s);
    })
  );

  await loadScripts(s);
  renderPanel(s);
}

async function loadScripts(s) {
  const [{ data: cs }, { data: all }] = await Promise.all([
    F.sbTable("config_scripts").select("script_id,priority").eq("config_id", s.cfg.id),
    F.sbTable("scripts").select("id,name,source").order("name"),
  ]);
  const byId = Object.fromEntries((all || []).map((x) => [x.id, x]));
  s.scripts = (cs || [])
    .map((r) => ({ id: r.script_id, name: byId[r.script_id]?.name || "(deleted)", priority: r.priority }))
    .sort((a, b) => b.priority - a.priority);
  const attached = new Set(s.scripts.map((x) => x.id));
  s.attachable = (all || []).filter((x) => !attached.has(x.id));
}

function renderPanel(s) {
  const el = document.getElementById("panel");
  const fns = {
    overview:    renderOverview,
    game_server: renderGameServer,
    joining:     renderJoining,
    performance: renderPerformance,
    reliability: renderReliability,
    scripts:     renderScripts,
    workspace:   renderWorkspace,
    advanced:    renderAdvanced,
  };
  el.innerHTML = "";
  fns[s.section](el, s);
}

// Each panel builds its own DOM directly into `el`.

function renderOverview(el, s) {
  const g = GAMES[s.cfg.game_slug] || GAMES[normalizeSlug(s.cfg.game_slug)] || { label: s.cfg.game_slug };
  el.append(F.el(`
    <div>
      <div class="card-h">Overview</div>
      <div class="cfg-chips">
        <div class="cfg-chip"><div class="k">Game</div><div class="v">${F.esc(g.label)}</div></div>
        <div class="cfg-chip"><div class="k">Server Mode</div><div class="v">${F.esc(prettyMode(s.cfg.server_mode))}</div></div>
        <div class="cfg-chip"><div class="k">Target FPS</div><div class="v">${s.cfg.target_fps}</div></div>
        <div class="cfg-chip"><div class="k">Max Joins</div><div class="v">${s.cfg.max_joins}</div></div>
      </div>

      <div class="cfg-overview-cards">
        <div class="cfg-ovc">
          <div class="cfg-ovc-h">Scripts</div>
          <div class="cfg-ovc-b">${s.scripts.length} script${s.scripts.length === 1 ? "" : "s"} will run on each account.</div>
          <div class="cfg-ovc-f"><button class="btn" data-go="scripts">Manage Scripts</button></div>
        </div>
        <div class="cfg-ovc">
          <div class="cfg-ovc-h">Workspace</div>
          <div class="cfg-ovc-b">Using the built-in empty Workspace folder.</div>
          <div class="cfg-ovc-f"><button class="btn" data-go="workspace">Manage Workspace</button></div>
        </div>
      </div>

      <div class="card-h" style="margin-top:14px">Quick Actions</div>
      <div style="display:flex;gap:8px">
        <button class="btn" id="qa-dup">Duplicate Config</button>
      </div>
    </div>
  `));
  el.querySelectorAll("[data-go]").forEach((b) =>
    b.addEventListener("click", () => {
      s.section = b.dataset.go;
      document.querySelectorAll(".cfg-nav-item").forEach((n) => n.classList.toggle("active", n.dataset.sec === s.section));
      renderPanel(s);
    })
  );
  el.querySelector("#qa-dup").addEventListener("click", async () => {
    const name = prompt("Name for the duplicate:", `${s.cfg.name} copy`);
    if (!name) return;
    const { data, error } = await F.sb.rpc("fn_duplicate_config", { p_config_id: s.cfg.id, p_new_name: name });
    if (error) return F.toast(error.message, "err");
    F.toast("duplicated"); location.hash = `#/configs/${data}`;
  });
}

function renderGameServer(el, s) {
  const form = F.el(`
    <div>
      <div class="card-h">Game &amp; Server</div>
      <div class="form">
        <label>Game
          <select class="input" data-k="game_slug">
            ${GAME_KEYS.map((k) => `<option value="${k}" ${k === s.cfg.game_slug ? "selected" : ""}>${F.esc(GAMES[k].label)}</option>`).join("")}
          </select>
        </label>
        <label>Server Mode
          <select class="input" data-k="server_mode">
            ${SERVER_MODES.map((m) => `<option value="${m}" ${m === s.cfg.server_mode ? "selected" : ""}>${F.esc(prettyMode(m))}</option>`).join("")}
          </select>
        </label>
        <label>Config Name <input class="input" data-k="name" value="${F.esc(s.cfg.name)}" /></label>
        <div><button class="btn primary" id="gs-save">Save</button></div>
      </div>
    </div>
  `);
  el.append(form);
  form.querySelector("#gs-save").addEventListener("click", () => savePatch(s, patchFromForm(form)));
}

async function renderJoining(el, s) {
  const j = Object.assign({
    join_low_player: false, joiner_pool_id: null, follow_enabled: false,
    follow_ids: "", follow_only_captcha: true, accounts_per_user: 1,
    use_socks5: false, socks5_list: "",
  }, s.cfg.joining || {});

  const { data: pools } = await F.sbTable("joiner_pools").select("id,name").order("name");
  const poolOpts = `<option value="">None</option>` +
    (pools || []).map((p) => `<option value="${p.id}" ${j.joiner_pool_id === p.id ? "selected" : ""}>${F.esc(p.name)}</option>`).join("");

  const form = F.el(`
    <div>
      <div class="card-h">Joining</div>
      <div class="muted small" style="margin-bottom:12px">
        Set Server Mode to <b>Public servers</b> and leave the follow box empty to join past captchas on public servers.
        Private servers aren't supported. Use channel <b>roblox744</b>.
      </div>
      <div class="form">
        <label>Server Mode
          <select class="input" data-k="server_mode">
            <option value="public"       ${s.cfg.server_mode === "public" ? "selected" : ""}>Public servers</option>
            <option value="private"      ${s.cfg.server_mode === "private" ? "selected" : ""}>Private server (link)</option>
            <option value="user_private" ${s.cfg.server_mode === "user_private" ? "selected" : ""}>User private</option>
            <option value="vip"          ${s.cfg.server_mode === "vip" ? "selected" : ""}>VIP</option>
          </select>
        </label>

        <label class="cfg-check">
          <input type="checkbox" data-jk="join_low_player" ${j.join_low_player ? "checked" : ""} />
          <span>Join low player servers</span>
        </label>

        <label>Joiner Pool (captcha bypass)
          <select class="input" data-jk="joiner_pool_id">${poolOpts}</select>
        </label>

        <label class="cfg-check">
          <input type="checkbox" data-jk="follow_enabled" id="jn-follow" ${j.follow_enabled ? "checked" : ""} />
          <span>Follow users from a list</span>
        </label>

        <div id="jn-follow-box" class="cfg-indent" style="${j.follow_enabled ? "" : "opacity:.45;pointer-events:none"}">
          <label>One Roblox user id per line
            <textarea class="input" rows="5" data-jk="follow_ids" placeholder="123456789&#10;987654321">${F.esc(j.follow_ids || "")}</textarea>
          </label>
          <label class="cfg-check">
            <input type="checkbox" data-jk="follow_only_captcha" ${j.follow_only_captcha ? "checked" : ""} />
            <span>Only follow for accounts with a captcha</span>
          </label>
          <label>Accounts per user
            <input class="input" type="number" min="1" max="50" style="max-width:120px" data-jk="accounts_per_user" value="${Number(j.accounts_per_user) || 1}" />
          </label>
          <div class="muted small">It will attempt to join N accounts each loop per id.</div>
        </div>

        <label class="cfg-check">
          <input type="checkbox" data-jk="use_socks5" id="jn-socks" ${j.use_socks5 ? "checked" : ""} />
          <span>Use SOCKS5 proxies</span>
        </label>
        <div id="jn-socks-box" class="cfg-indent" style="${j.use_socks5 ? "" : "opacity:.45;pointer-events:none"}">
          <label>One proxy per line (host:port or host:port:user:pass)
            <textarea class="input" rows="4" data-jk="socks5_list" placeholder="127.0.0.1:1080&#10;proxy.example:1080:user:pass">${F.esc(j.socks5_list || "")}</textarea>
          </label>
        </div>

        <div><button class="btn primary" id="jn-save">Save</button></div>
      </div>
    </div>
  `);
  el.append(form);

  // Enable/disable the sub-boxes live.
  const toggle = (cbId, boxId) => {
    const cb = form.querySelector(cbId), box = form.querySelector(boxId);
    cb.addEventListener("change", () => {
      box.style.opacity = cb.checked ? "" : ".45";
      box.style.pointerEvents = cb.checked ? "" : "none";
    });
  };
  toggle("#jn-follow", "#jn-follow-box");
  toggle("#jn-socks", "#jn-socks-box");

  form.querySelector("#jn-save").addEventListener("click", async () => {
    const joining = {};
    form.querySelectorAll("[data-jk]").forEach((elm) => {
      const k = elm.dataset.jk;
      if (elm.type === "checkbox") joining[k] = elm.checked;
      else if (k === "accounts_per_user") joining[k] = Number(elm.value) || 1;
      else if (k === "joiner_pool_id") joining[k] = elm.value || null;
      else joining[k] = elm.value;
    });
    const server_mode = form.querySelector('[data-k="server_mode"]').value;
    await savePatch(s, { joining, server_mode });
  });
}

function renderPerformance(el, s) {
  const fps = s.cfg.target_fps || 3;
  const form = F.el(`
    <div>
      <div class="card-h">Performance</div>
      <div class="form">
        <label>Target FPS: <span id="fps-v">${fps}</span>
          <input type="range" min="1" max="60" step="1" value="${fps}" data-k="target_fps" id="fps" />
        </label>
        <label>Max Joins <input class="input" type="number" min="1" data-k="max_joins" value="${s.cfg.max_joins}" /></label>
        <label>Performance JSON (free-form)
          <textarea class="input cfg-json" rows="8" data-k="performance">${F.esc(JSON.stringify(s.cfg.performance || {}, null, 2))}</textarea>
        </label>
        <div><button class="btn primary" id="perf-save">Save</button></div>
      </div>
    </div>
  `);
  el.append(form);
  form.querySelector("#fps").addEventListener("input", (e) => { form.querySelector("#fps-v").textContent = e.target.value; });
  form.querySelector("#perf-save").addEventListener("click", () => {
    const patch = patchFromForm(form);
    if (!parseJsonInto(patch, "performance")) return;
    patch.target_fps = Number(patch.target_fps);
    patch.max_joins = Number(patch.max_joins);
    savePatch(s, patch);
  });
}

function renderReliability(el, s) {
  const form = F.el(`
    <div>
      <div class="card-h">Reliability</div>
      <div class="form">
        <label>reliability (JSON)
          <textarea class="input cfg-json" rows="18" data-k="reliability">${F.esc(JSON.stringify(s.cfg.reliability || {}, null, 2))}</textarea>
        </label>
        <div class="muted" style="font-size:11px">
          Suggested keys: <code>restart_on_crash</code>, <code>max_memory_mb</code>, <code>kick_on_lag_seconds</code>.
        </div>
        <div><button class="btn primary" id="rel-save">Save</button></div>
      </div>
    </div>
  `);
  el.append(form);
  form.querySelector("#rel-save").addEventListener("click", () => {
    const patch = patchFromForm(form);
    if (!parseJsonInto(patch, "reliability")) return;
    savePatch(s, patch);
  });
}

function renderScripts(el, s) {
  const wrap = F.el(`
    <div>
      <div class="card-h">
        Scripts
        <div class="spacer"></div>
        <button class="btn" id="btn-attach">+ Attach existing</button>
        <button class="btn primary" id="btn-newscript">+ New script</button>
      </div>
      <table class="tbl">
        <thead><tr><th>Name</th><th style="width:120px">Priority</th><th style="width:80px"></th></tr></thead>
        <tbody id="s-body">
          ${s.scripts.length ? "" : `<tr><td colspan="3" class="empty">no scripts attached</td></tr>`}
          ${s.scripts.map((sc) => `
            <tr>
              <td>${F.esc(sc.name)}</td>
              <td><input class="input" type="number" value="${sc.priority}" data-sid="${sc.id}" style="max-width:100px"/></td>
              <td><button class="btn danger" data-rm="${sc.id}">Remove</button></td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>
  `);
  el.append(wrap);

  wrap.querySelectorAll("[data-sid]").forEach((inp) =>
    inp.addEventListener("change", async () => {
      const { error } = await F.sbTable("config_scripts")
        .update({ priority: Number(inp.value) || 0 })
        .eq("config_id", s.cfg.id).eq("script_id", inp.dataset.sid);
      if (error) F.toast(error.message, "err"); else F.toast("priority saved");
    })
  );
  wrap.querySelectorAll("[data-rm]").forEach((b) =>
    b.addEventListener("click", async () => {
      const sid = b.dataset.rm;
      const { error } = await F.sbTable("config_scripts").delete()
        .eq("config_id", s.cfg.id).eq("script_id", sid);
      if (error) return F.toast(error.message, "err");
      F.toast("detached"); await loadScripts(s); renderPanel(s);
    })
  );

  wrap.querySelector("#btn-attach").addEventListener("click", () => openAttachModal(s));
  wrap.querySelector("#btn-newscript").addEventListener("click", () => openNewScriptModal(s));
}

function renderWorkspace(el, s) {
  el.append(F.el(`
    <div>
      <div class="card-h">Workspace</div>
      <div class="empty" style="padding:30px">
        Workspace bundles land in a later module.
        <div class="muted" style="margin-top:6px">For now each account gets the built-in empty Workspace folder.</div>
      </div>
    </div>
  `));
}

function renderAdvanced(el, s) {
  const form = F.el(`
    <div>
      <div class="card-h">Advanced</div>
      <div class="form">
        <label>advanced (JSON)
          <textarea class="input cfg-json" rows="18" data-k="advanced">${F.esc(JSON.stringify(s.cfg.advanced || {}, null, 2))}</textarea>
        </label>
        <div><button class="btn primary" id="adv-save">Save</button></div>
      </div>
    </div>
  `);
  el.append(form);
  form.querySelector("#adv-save").addEventListener("click", () => {
    const patch = patchFromForm(form);
    if (!parseJsonInto(patch, "advanced")) return;
    savePatch(s, patch);
  });
}

// ---- panel helpers ----
function patchFromForm(root) {
  const patch = {};
  root.querySelectorAll("[data-k]").forEach((el) => { patch[el.dataset.k] = el.value; });
  return patch;
}
function parseJsonInto(patch, key) {
  try { patch[key] = JSON.parse(patch[key] || "{}"); return true; }
  catch (e) { F.toast(`${key}: ${e.message}`, "err"); return false; }
}
async function savePatch(s, patch) {
  const { error } = await F.sbTable("configs").update(patch).eq("id", s.cfg.id);
  if (error) return F.toast(error.message, "err");
  F.toast("saved");
  Object.assign(s.cfg, patch);
}

// ---- script modals ----
function openAttachModal(s) {
  if (!s.attachable.length) return F.toast("no more scripts to attach", "err");
  const body = F.el(`
    <div class="form">
      <label>Script
        <select class="input" id="at-s">
          ${s.attachable.map((x) => `<option value="${x.id}">${F.esc(x.name)}</option>`).join("")}
        </select>
      </label>
      <label>Priority (higher runs first) <input class="input" type="number" id="at-p" value="0" /></label>
    </div>
  `);
  const foot = F.el(`<div style="display:flex;gap:8px;justify-content:flex-end">
    <button class="btn" data-a="cancel">Cancel</button>
    <button class="btn primary" data-a="go">Attach</button>
  </div>`);
  const { close } = F.modal({ title: "Attach script", body, footer: foot, width: 440 });
  foot.querySelector("[data-a='cancel']").addEventListener("click", close);
  foot.querySelector("[data-a='go']").addEventListener("click", async () => {
    const script_id = body.querySelector("#at-s").value;
    const priority  = Number(body.querySelector("#at-p").value) || 0;
    const { error } = await F.sbTable("config_scripts").insert({ config_id: s.cfg.id, script_id, priority });
    if (error) return F.toast(error.message, "err");
    F.toast("attached"); close(); await loadScripts(s); renderPanel(s);
  });
}

function openNewScriptModal(s) {
  const body = F.el(`
    <div class="form">
      <label>Name <input class="input" id="ns-name" placeholder="e.g. adm-afk" /></label>
      <label>Luau source
        <textarea class="input cfg-code" id="ns-src" rows="16" placeholder="-- your Luau here\nprint('hello')"></textarea>
      </label>
      <label>Priority <input class="input" type="number" id="ns-p" value="0" /></label>
    </div>
  `);
  const foot = F.el(`<div style="display:flex;gap:8px;justify-content:flex-end">
    <button class="btn" data-a="cancel">Cancel</button>
    <button class="btn primary" data-a="go">Create &amp; attach</button>
  </div>`);
  const { close } = F.modal({ title: "New script", body, footer: foot, width: 720 });
  foot.querySelector("[data-a='cancel']").addEventListener("click", close);
  foot.querySelector("[data-a='go']").addEventListener("click", async () => {
    const name = body.querySelector("#ns-name").value.trim();
    const source = body.querySelector("#ns-src").value;
    if (!name) return F.toast("name required", "err");
    // Route through fn_upsert_script so the script is bound to the config's
    // game placeId — same behaviour as the Games page uploader. The RPC
    // returns the script id (bigint/uuid as text); fall back to the
    // raw-insert path only if the RPC is missing on this DB.
    const place_id = placeIdForSlug(s.cfg.game_slug);
    let scriptId = null;
    const { data: rpcId, error: eRpc } = await F.sb.rpc("fn_upsert_script", {
      p_name: name, p_source: source, p_place_id: place_id,
    });
    if (eRpc) {
      const { data: me } = await F.sb.auth.getUser();
      const { data: ins, error: e1 } = await F.sbTable("scripts")
        .insert({ owner_id: me.user.id, name, source, place_id }).select("id").single();
      if (e1) return F.toast(e1.message, "err");
      scriptId = ins.id;
    } else {
      scriptId = rpcId;
    }
    const priority = Number(body.querySelector("#ns-p").value) || 0;
    const { error: e2 } = await F.sbTable("config_scripts")
      .insert({ config_id: s.cfg.id, script_id: scriptId, priority });
    if (e2) return F.toast(e2.message, "err");
    F.toast("created"); close(); await loadScripts(s); renderPanel(s);
  });
}

})();
