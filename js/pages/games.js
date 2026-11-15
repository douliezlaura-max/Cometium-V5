(function () {
// Running Game Stats — tabs per game_slug, 4 category tiles, time-window
// grid, rarity-filtered + searchable item cards. Reads trackstat_schemas
// + trackstat_rollups + trackstat_rows via the RPCs in supabase_v4_trackstats.sql.
window.F = window.F || {};
F.pages = F.pages || {};

// Category -> matcher. First hit wins; tests field name, label, rarity (lowercased).
// A schema can assign a field to a specific tile by setting rarity:"bucks" etc.
const TILES = [
  { key: "bucks",   label: "Total Bucks",          rx: /\b(buck|coin|cash|money|gold|gem|diamond|currency)\b/ },
  { key: "potions", label: "Total Potions",        rx: /\b(potion|boost|elixir|buff)\b/ },
  { key: "event",   label: "Total Event Currency", rx: /\b(event|token|candy|ticket|shard)\b/ },
  { key: "pets",    label: "Total Pets",           rx: /\b(pet|egg|mount|companion)\b/ },
];

// game_slug -> default Roblox place_id. Prefilled in the Scripts form;
// user can still override per upload. Extend as he brings new games on.
const GAME_PLACE_IDS = {
  adopt_me:        920587237,
  mm2:             142823291,
  blox_fruits:     2753915549,
  aot_revolution:  null,
  grow_a_garden:   null,
};

// Rarity -> color (fallback to muted). Only used for pill tint.
const RARITY_TONES = {
  common:      "#9aa3ad",
  uncommon:    "#4ade80",
  rare:        "#4ea6ff",
  ultra_rare:  "#b084f0",
  legendary:   "#f5a524",
  mythic:      "#ff6b6b",
  bucks:       "#f5a524",
  potion:      "#4ea6ff",
  event:       "#b084f0",
  pet:         "#4ade80",
};

F.pages.games = async function (view) {
  const s = {
    games: [],                 // [{game_slug, author, fields}]
    active: null,              // game_slug
    schema: null,              // fields jsonb
    tiles: {},                 // { bucks:{value,accounts}, ... }
    windows: {},               // { 1: [{field, value, label, rarity, kind}], 24: [...], ... }
    items: [],                 // [{field, label, rarity, kind, value, accounts}]
    rarityFilter: "",
    search: "",
  };

  view.innerHTML = shellHtml();

  const { data: schemas, error } = await F.sbTable("trackstat_schemas")
    .select("game_slug,author,fields")
    .order("game_slug");
  if (error) { F.toast(error.message, "err"); return; }
  const schemaRows = schemas || [];
  const bySlug = new Map();
  schemaRows.forEach((g) => bySlug.set(g.game_slug, g));
  // Union schemas with every known game so Scripts UI is reachable even
  // with no trackstat_schemas rows.
  for (const slug of Object.keys(GAME_PLACE_IDS)) {
    if (!bySlug.has(slug)) bySlug.set(slug, { game_slug: slug, author: null, fields: null });
  }
  s.games = Array.from(bySlug.values()).sort((a, b) => a.game_slug.localeCompare(b.game_slug));

  renderTabs(view, s);

  if (!s.games.length) {
    view.querySelector("#g-body").innerHTML =
      `<div class="empty">No games configured. Add one in GAME_PLACE_IDS or create a trackstat schema.</div>`;
    return;
  }

  s.active = s.games[0].game_slug;
  await loadGame(view, s);

  view.querySelector("#g-tabs").addEventListener("click", async (e) => {
    const t = e.target.closest("[data-tab]");
    if (!t) return;
    s.active = t.dataset.tab;
    renderTabs(view, s);
    await loadGame(view, s);
  });
};

function shellHtml() {
  return `
    <h1>Running Game Stats</h1>
    <div class="g-tabs" id="g-tabs"></div>
    <div id="g-body"><div class="loading">loading…</div></div>
  `;
}

function renderTabs(view, s) {
  view.querySelector("#g-tabs").innerHTML = s.games.map((g) => `
    <button class="g-tab ${s.active === g.game_slug ? "on" : ""}" data-tab="${F.esc(g.game_slug)}">
      ${F.esc(prettyGame(g.game_slug))}
    </button>
  `).join("") || "";
}

async function loadGame(view, s) {
  view.querySelector("#g-body").innerHTML = `<div class="loading">loading ${F.esc(prettyGame(s.active))}…</div>`;

  const gameRow = s.games.find((g) => g.game_slug === s.active) || {};
  s.schema = gameRow.fields || null;
  s.hasSchema = !!(gameRow.fields && Object.keys(gameRow.fields || {}).length);

  // TrackStat RPCs only when a schema exists — otherwise they return nothing
  // of value and some return errors for an unknown slug.
  let w1 = [], w24 = [], w168 = [], w720 = [], items = [];
  if (s.hasSchema) {
    [w1, w24, w168, w720, items] = await Promise.all([
      rpcWindow(s.active, 1),
      rpcWindow(s.active, 24),
      rpcWindow(s.active, 24 * 7),
      rpcWindow(s.active, 24 * 30),
      rpcItems(s.active),
    ]);
  }

  s.windows = { 1: w1, 24: w24, 168: w168, 720: w720 };
  s.items = items;

  // Skip fn_list_scripts entirely when no place_id is configured — the
  // bigint overload treats null as a wildcard and returns unrelated rows.
  const placeId = GAME_PLACE_IDS[s.active];
  if (placeId == null) {
    s.scripts = null; // sentinel: "panel unavailable"
  } else {
    s.scripts = await rpcListScripts(placeId);
  }

  s.tiles = {};
  for (const t of TILES) {
    const matched = items.filter((it) => matchCategory(it, t));
    const value = matched.reduce((n, it) => n + Number(it.value || 0), 0);
    const accounts = matched.reduce((n, it) => Math.max(n, it.accounts || 0), 0);
    s.tiles[t.key] = { value, accounts, count: matched.length };
  }

  renderBody(view, s);
}

function renderBody(view, s) {
  const trackstatBlock = s.hasSchema ? `
    <div class="g-tiles">
      ${TILES.map((t) => tileHtml(t, s.tiles[t.key])).join("")}
    </div>

    <div class="card">
      <div class="card-h">Total Farm Statistics</div>
      <div class="g-windows">
        ${windowHtml("Last Hour", s.windows[1])}
        ${windowHtml("Last 24h",  s.windows[24])}
        ${windowHtml("Last 7d",   s.windows[168])}
        ${windowHtml("Last 30d",  s.windows[720])}
      </div>
    </div>

    <div class="card">
      <div class="card-h">
        Tracked Items
        <div class="spacer"></div>
        <input class="input" id="g-search" placeholder="Search by name…" style="max-width:220px" />
      </div>
      <div class="g-rarities" id="g-rarities"></div>
      <div class="g-grid" id="g-grid"></div>
    </div>
  ` : `
    <div class="card">
      <div class="card-h">TrackStat</div>
      <div class="empty">No schemas yet for ${F.esc(prettyGame(s.active))}. Create one on the Tools page to see tiles, windows and tracked items.</div>
    </div>
  `;

  view.querySelector("#g-body").innerHTML = `
    ${trackstatBlock}

    <div class="card">
      <div class="card-h">
        Scripts for ${F.esc(prettyGame(s.active))}
        <div class="spacer"></div>
        <span class="muted small" id="g-script-count">0</span>
      </div>
      <div class="muted small" style="margin-bottom:10px">
        Upload a .lua / .luau file or paste Luau source. Bind it to a Roblox placeId so the
        Joiners page can pick it by name when it fans out a join.
      </div>
      <div class="form" id="g-script-form">
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <label style="flex:1;min-width:200px">Name
            <input class="input" id="gs-name" placeholder="e.g. Adopt Me Kaitun v4" />
          </label>
          <label style="width:200px">Place ID
            <input class="input" id="gs-place" type="number" inputmode="numeric"
                   placeholder="920587237" value="${GAME_PLACE_IDS[s.active] || ""}" />
          </label>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <input type="file" id="gs-file" accept=".lua,.luau,text/plain" style="display:none" />
          <button class="btn" id="gs-pick">Choose .lua/.luau file…</button>
          <span class="muted small" id="gs-file-lbl">no file selected</span>
        </div>
        <label>Luau source
          <textarea class="input cfg-code" id="gs-src" rows="12"
                    placeholder="-- paste Luau here, or pick a file above"></textarea>
        </label>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn primary" id="gs-save">Upload / Save</button>
          <button class="btn" id="gs-clear">Clear</button>
          <span class="spacer"></span>
          <span class="muted small">Upsert by name: same name overwrites and bumps version.</span>
        </div>
      </div>

      <table class="tbl" style="margin-top:14px">
        <thead>
          <tr>
            <th>Name</th>
            <th style="width:120px">Place ID</th>
            <th style="width:80px">Version</th>
            <th style="width:90px">Size</th>
            <th style="width:160px">Updated</th>
            <th style="width:180px"></th>
          </tr>
        </thead>
        <tbody id="gs-body"></tbody>
      </table>
    </div>
  `;

  if (s.hasSchema) {
    renderRarities(view, s);
    renderItems(view, s);
    view.querySelector("#g-rarities").addEventListener("click", (e) => {
      const b = e.target.closest("[data-rarity]"); if (!b) return;
      s.rarityFilter = b.dataset.rarity === s.rarityFilter ? "" : b.dataset.rarity;
      renderRarities(view, s); renderItems(view, s);
    });
    view.querySelector("#g-search").addEventListener("input", F.debounce((e) => {
      s.search = e.target.value.trim().toLowerCase();
      renderItems(view, s);
    }, 150));
  }
  renderScripts(view, s);
  wireScriptForm(view, s);
}

function renderRarities(view, s) {
  const el = view.querySelector("#g-rarities");
  const counts = {};
  s.items.forEach((it) => {
    const r = (it.rarity || "").trim();
    if (!r) return;
    counts[r] = (counts[r] || 0) + 1;
  });
  const pills = [`<button class="g-pill ${s.rarityFilter === "" ? "on" : ""}" data-rarity="">${s.items.length} Tracked</button>`];
  Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([r, n]) => {
    const tone = RARITY_TONES[r] || "var(--fg-muted)";
    pills.push(`<button class="g-pill ${s.rarityFilter === r ? "on" : ""}" data-rarity="${F.esc(r)}" style="--pt:${tone}">${n} ${F.esc(r)}</button>`);
  });
  el.innerHTML = pills.join("");
}

function renderItems(view, s) {
  const grid = view.querySelector("#g-grid");
  const list = s.items.filter((it) => {
    if (s.rarityFilter && (it.rarity || "") !== s.rarityFilter) return false;
    if (s.search) {
      const hay = `${it.field} ${it.label || ""} ${it.rarity || ""}`.toLowerCase();
      if (!hay.includes(s.search)) return false;
    }
    return true;
  }).sort((a, b) => Number(b.value || 0) - Number(a.value || 0));

  if (!list.length) { grid.innerHTML = `<div class="empty">no items yet</div>`; return; }

  grid.innerHTML = list.map((it) => {
    const tone = RARITY_TONES[it.rarity] || "var(--fg-muted)";
    return `
      <div class="g-item">
        <div class="g-item-h">
          <div class="g-item-ico" style="--pt:${tone}">${glyph(it)}</div>
          <div class="g-item-name" title="${F.esc(it.field)}">${F.esc(it.label || it.field)}</div>
        </div>
        <div class="g-item-v">${fmt(it.value)}</div>
        <div class="g-item-f">
          ${it.rarity ? `<span class="g-pill-mini" style="--pt:${tone}">${F.esc(it.rarity)}</span>` : ""}
          <span class="muted">👥 ${it.accounts || 0}</span>
        </div>
      </div>`;
  }).join("");
}

// ------------------- helpers -------------------
function tileHtml(t, v) {
  v = v || { value: 0, accounts: 0, count: 0 };
  const isBucks = t.key === "bucks";
  return `
    <div class="g-tile" data-cat="${t.key}">
      <div class="g-tile-k">${t.label}</div>
      <div class="g-tile-v">${isBucks ? "$" : ""}${fmt(v.value)}</div>
      <div class="g-tile-sub">${v.accounts ? fmt(v.accounts) + " accounts" : v.count + " fields"}</div>
    </div>`;
}

function windowHtml(label, rows) {
  const by = { bucks: 0, potions: 0, event: 0, pets: 0 };
  (rows || []).forEach((r) => {
    const t = TILES.find((x) => matchCategory(r, x));
    if (t) by[t.key] += Number(r.value || 0);
  });
  return `
    <div class="g-win">
      <div class="g-win-h">${F.esc(label)}</div>
      <div class="g-win-row"><span class="muted">potions</span><span>${fmt(by.potions)}</span></div>
      <div class="g-win-row"><span class="muted">bucks</span><span>$${fmt(by.bucks)}</span></div>
      <div class="g-win-row"><span class="muted">event</span><span>${fmt(by.event)}</span></div>
      <div class="g-win-row"><span class="muted">pets</span><span>${fmt(by.pets)}</span></div>
    </div>`;
}

function matchCategory(it, tile) {
  const hay = `${it.field || ""} ${it.label || ""} ${it.rarity || ""}`.toLowerCase();
  return tile.rx.test(hay);
}

async function rpcWindow(slug, hours) {
  const { data, error } = await F.sb.rpc("fn_trackstat_window", { p_game_slug: slug, p_hours: hours });
  if (error) { F.toast(error.message, "err"); return []; }
  return data || [];
}

async function rpcItems(slug) {
  const { data, error } = await F.sb.rpc("fn_trackstat_tracked_items", { p_game_slug: slug });
  if (error) { F.toast(error.message, "err"); return []; }
  return data || [];
}

async function rpcListScripts(placeId) {
  const { data, error } = await F.sb.rpc("fn_list_scripts", { p_place_id: placeId });
  if (error) { F.toast(error.message, "err"); return []; }
  return data || [];
}

// ------------------- scripts section -------------------
function renderScripts(view, s) {
  const body = view.querySelector("#gs-body");
  const count = view.querySelector("#g-script-count");
  if (s.scripts === null) {
    count.textContent = `unavailable`;
    body.innerHTML = `<tr><td colspan="6" class="empty">Scripts panel unavailable: place_id not configured for ${F.esc(prettyGame(s.active))}.</td></tr>`;
    return;
  }
  const list = s.scripts || [];
  count.textContent = `${list.length} script${list.length === 1 ? "" : "s"}`;
  if (!list.length) {
    body.innerHTML = `<tr><td colspan="6" class="empty">no scripts for this game yet</td></tr>`;
    return;
  }
  body.innerHTML = list.map((r) => `
    <tr data-id="${F.esc(r.id)}" data-name="${F.esc(r.name)}">
      <td>${F.esc(r.name)}</td>
      <td>${r.place_id == null ? '<span class="muted">any</span>' : F.esc(String(r.place_id))}</td>
      <td>v${r.version}</td>
      <td>${fmtSize(r.size_bytes)}</td>
      <td>${r.updated_at ? new Date(r.updated_at).toLocaleString() : ""}</td>
      <td>
        <button class="btn" data-a="edit">Edit</button>
        <button class="btn danger" data-a="del">Delete</button>
      </td>
    </tr>
  `).join("");

  body.querySelectorAll("[data-a='edit']").forEach((b) =>
    b.addEventListener("click", async () => {
      const tr = b.closest("tr");
      const id = tr.dataset.id;
      const row = (s.scripts || []).find((x) => x.id === id);
      if (!row) return;
      // Fetch the full source — fn_list_scripts omits it to keep payloads small.
      const { data, error } = await F.sbTable("scripts")
        .select("source,place_id").eq("id", id).single();
      if (error) return F.toast(error.message, "err");
      view.querySelector("#gs-name").value  = row.name;
      view.querySelector("#gs-place").value = data.place_id ?? "";
      view.querySelector("#gs-src").value   = data.source || "";
      view.querySelector("#gs-file-lbl").textContent = "no file selected";
      view.querySelector("#gs-name").scrollIntoView({ behavior: "smooth", block: "center" });
    })
  );
  body.querySelectorAll("[data-a='del']").forEach((b) =>
    b.addEventListener("click", async () => {
      const tr = b.closest("tr");
      if (!(await F.confirm(`Delete script "${tr.dataset.name}"?`))) return;
      const { error } = await F.sbTable("scripts").delete().eq("id", tr.dataset.id);
      if (error) return F.toast(error.message, "err");
      F.toast("deleted");
      const pid = GAME_PLACE_IDS[s.active];
      s.scripts = pid == null ? null : await rpcListScripts(pid);
      renderScripts(view, s);
    })
  );
}

function wireScriptForm(view, s) {
  const fileInput = view.querySelector("#gs-file");
  const fileLbl   = view.querySelector("#gs-file-lbl");
  const nameEl    = view.querySelector("#gs-name");
  const placeEl   = view.querySelector("#gs-place");
  const srcEl     = view.querySelector("#gs-src");

  view.querySelector("#gs-pick").addEventListener("click", (e) => {
    e.preventDefault(); fileInput.click();
  });
  fileInput.addEventListener("change", async () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) { fileLbl.textContent = "no file selected"; return; }
    if (f.size > 4 * 1024 * 1024) { // 4 MB guard — scripts >4MB are either dumps or wrong file.
      F.toast("file is larger than 4 MB, aborting", "err"); fileInput.value = ""; return;
    }
    try {
      const text = await f.text();
      srcEl.value = text;
      fileLbl.textContent = `${f.name} (${fmtSize(f.size)})`;
      if (!nameEl.value.trim()) {
        // Auto-fill name from filename minus extension, prettified.
        nameEl.value = f.name.replace(/\.(lua|luau|txt)$/i, "");
      }
    } catch (e) { F.toast(`read failed: ${e.message}`, "err"); }
  });

  view.querySelector("#gs-clear").addEventListener("click", () => {
    nameEl.value = "";
    srcEl.value = "";
    placeEl.value = GAME_PLACE_IDS[s.active] || "";
    fileInput.value = "";
    fileLbl.textContent = "no file selected";
  });

  view.querySelector("#gs-save").addEventListener("click", async () => {
    const name   = nameEl.value.trim();
    const source = srcEl.value;
    const placeRaw = placeEl.value.trim();
    const place_id = placeRaw ? Number(placeRaw) : null;
    if (!name)   return F.toast("name required", "err");
    if (!source) return F.toast("source empty (paste or pick a file)", "err");
    if (placeRaw && (!Number.isFinite(place_id) || place_id <= 0)) {
      return F.toast("place_id must be a positive number", "err");
    }
    const { data, error } = await F.sb.rpc("fn_upsert_script", {
      p_name: name, p_source: source, p_place_id: place_id,
    });
    if (error) return F.toast(error.message, "err");
    F.toast(`saved · id ${String(data).slice(0, 8)}`);
    const pid = GAME_PLACE_IDS[s.active];
    s.scripts = pid == null ? null : await rpcListScripts(pid);
    renderScripts(view, s);
  });
}

function fmtSize(n) {
  n = Number(n || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function fmt(n) {
  n = Number(n || 0);
  if (!isFinite(n)) return "0";
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function glyph(it) {
  const c = (it.label || it.field || "?").trim().charAt(0).toUpperCase();
  return F.esc(c);
}

function prettyGame(slug) {
  return String(slug || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

})();
