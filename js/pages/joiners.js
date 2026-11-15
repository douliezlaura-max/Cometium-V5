(function () {
// Joiner Accounts page — spare accounts the workers burn to get past captchas.
window.F = window.F || {};
F.pages = F.pages || {};

F.pages.joiners = async function (view) {
  const s = {
    pools: [],
    batch: {
      accounts: [],          // [{id, username, status, device_id}]
      scripts: [],           // [{id, name, version, game_slug}]
      devices: [],           // [{id, name}]
      selected: new Set(),   // account ids
      filter: "",
      game_slug: "adopt_me", // drives place_id dropdown + script filter
      place_id: 920587237,   // Adopt Me by default
      script_id: "",         // empty = no script
      device_id: "",         // empty = round-robin by RPC
    },
  };

  view.innerHTML = shellHtml();

  const refresh = () => Promise.all([load(s), loadBatchCtx(s)]).then(() => renderBatch(s));

  view.querySelector("#btn-new-pool").addEventListener("click", () => openNew(refresh));
  view.querySelector("#btn-del-pool").addEventListener("click", () => openDeletePicker(s, refresh));

  wireBatch(view, s);

  await refresh();
};

function shellHtml() {
  return `
    <h1>Joiner Accounts</h1>

    <div class="card">
      <div class="card-h">
        New batch — mass join
        <div class="spacer"></div>
        <span class="muted" style="font-size:11.5px">pick accounts, pick a game, submit one RPC</span>
      </div>

      <div class="batch-grid">
        <label>Game
          <select class="input" id="bt-game">
            <option value="adopt_me|920587237">Adopt Me — 920587237</option>
            <option value="mm2|142823291">Murder Mystery 2 — 142823291</option>
            <option value="blox_fruits|2753915549">Blox Fruits — 2753915549</option>
            <option value="steal_an_egg|109983668079237">Steal an Egg — 109983668079237</option>
            <option value="steal_an_animal|109090601314112">Steal an Animal — 109090601314112</option>
            <option value="fisch|16732694052">Fisch — 16732694052</option>
            <option value="custom|">custom place_id…</option>
          </select>
        </label>
        <label>place_id
          <input class="input" id="bt-place" type="number" min="1" step="1" value="920587237" />
        </label>
        <label>Script
          <select class="input" id="bt-script"><option value="">— none —</option></select>
        </label>
        <label>Target device
          <select class="input" id="bt-device"><option value="">auto (round-robin)</option></select>
        </label>
      </div>

      <div class="batch-accounts">
        <div class="batch-acc-h">
          <input class="input" id="bt-filter" placeholder="filter by username…" />
          <label class="batch-chk">
            <input type="checkbox" id="bt-all" /> select all
          </label>
          <span class="spacer"></span>
          <span class="muted" style="font-size:11.5px">
            <span id="bt-count">0</span> / <span id="bt-total">0</span> picked
          </span>
          <button class="btn primary" id="bt-submit">Launch batch</button>
        </div>
        <div class="batch-list" id="bt-list"><div class="empty">loading accounts…</div></div>
        <div id="bt-result" class="batch-result"></div>
      </div>
    </div>

    <div class="card">
      <div class="card-h">
        Pools
        <div class="spacer"></div>
        <button class="btn" id="btn-del-pool">Delete pool</button>
        <button class="btn primary" id="btn-new-pool">+ New pool</button>
      </div>
      <div class="muted" style="font-size:12px;margin-bottom:10px">
        Spare accounts used to get past captchas. Make a pool, paste accounts into it, then point a config at the pool.
      </div>
      <div id="pool-grid"><div class="empty">loading…</div></div>
    </div>
  `;
}

// ------------------- new batch (mass join) -------------------
async function loadBatchCtx(s) {
  const b = s.batch;
  const [accs, scripts, devs] = await Promise.all([
    F.sbTable("accounts")
      .select("id,username,status,device_id")
      .order("username", { ascending: true })
      .limit(2000),
    F.sb.rpc("fn_list_scripts", { p_game_slug: b.game_slug }),
    F.sbTable("devices").select("id,name").order("name"),
  ]);
  b.accounts = accs.data || [];
  // RPC may 404 on an unmigrated DB — fall back to a direct select.
  if (scripts.error) {
    const fb = await F.sbTable("scripts").select("id,name,version").order("name");
    b.scripts = (fb.data || []).map((r) => ({ ...r, game_slug: null }));
  } else {
    b.scripts = scripts.data || [];
  }
  b.devices = devs.data || [];
}

function wireBatch(view, s) {
  const b = s.batch;

  view.querySelector("#bt-game").addEventListener("change", async (ev) => {
    const [slug, pid] = ev.target.value.split("|");
    b.game_slug = slug || "custom";
    const placeInput = view.querySelector("#bt-place");
    if (pid) { b.place_id = Number(pid); placeInput.value = pid; placeInput.disabled = false; }
    else     { b.place_id = 0;           placeInput.value = "";  placeInput.disabled = false; placeInput.focus(); }
    // re-fetch scripts filtered by the new slug
    const r = await F.sb.rpc("fn_list_scripts", { p_game_slug: b.game_slug });
    b.scripts = r.error ? b.scripts : (r.data || []);
    b.script_id = "";
    paintBatchDropdowns(s);
  });

  view.querySelector("#bt-place").addEventListener("input", (ev) => {
    b.place_id = Number(ev.target.value) || 0;
  });
  view.querySelector("#bt-script").addEventListener("change", (ev) => { b.script_id = ev.target.value; });
  view.querySelector("#bt-device").addEventListener("change", (ev) => { b.device_id = ev.target.value; });

  view.querySelector("#bt-filter").addEventListener("input", (ev) => {
    b.filter = ev.target.value.trim().toLowerCase();
    paintBatchList(s);
  });

  view.querySelector("#bt-all").addEventListener("change", (ev) => {
    const rows = visibleBatch(s);
    if (ev.target.checked) rows.forEach((r) => b.selected.add(r.id));
    else                   rows.forEach((r) => b.selected.delete(r.id));
    paintBatchList(s);
  });

  view.querySelector("#bt-submit").addEventListener("click", () => submitBatch(s));
}

function renderBatch(s) {
  paintBatchDropdowns(s);
  paintBatchList(s);
}

function paintBatchDropdowns(s) {
  const b = s.batch;
  const sc = document.getElementById("bt-script");
  if (sc) {
    sc.innerHTML = `<option value="">— none —</option>` + b.scripts.map((x) =>
      `<option value="${F.esc(x.id)}" ${x.id === b.script_id ? "selected" : ""}>${F.esc(x.name)}${x.version ? ` · v${x.version}` : ""}${x.game_slug ? ` · ${F.esc(x.game_slug)}` : ""}</option>`
    ).join("");
  }
  const dv = document.getElementById("bt-device");
  if (dv) {
    dv.innerHTML = `<option value="">auto (round-robin)</option>` + b.devices.map((x) =>
      `<option value="${F.esc(x.id)}" ${x.id === b.device_id ? "selected" : ""}>${F.esc(x.name)}</option>`
    ).join("");
  }
}

function visibleBatch(s) {
  const q = s.batch.filter;
  return !q ? s.batch.accounts : s.batch.accounts.filter((a) => a.username.toLowerCase().includes(q));
}

function paintBatchList(s) {
  const list = document.getElementById("bt-list");
  const b = s.batch;
  const rows = visibleBatch(s);

  document.getElementById("bt-total").textContent = rows.length;
  document.getElementById("bt-count").textContent = b.selected.size;

  if (!rows.length) {
    list.innerHTML = `<div class="empty">no accounts match</div>`;
    return;
  }
  list.innerHTML = rows.map((a) => `
    <label class="batch-row">
      <input type="checkbox" data-id="${F.esc(a.id)}" ${b.selected.has(a.id) ? "checked" : ""} />
      <span class="bt-user">${F.esc(a.username)}</span>
      <span class="bt-status status-${F.esc(a.status || "unknown")}">${F.esc(a.status || "—")}</span>
    </label>
  `).join("");

  list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener("change", (ev) => {
      const id = ev.target.dataset.id;
      ev.target.checked ? b.selected.add(id) : b.selected.delete(id);
      document.getElementById("bt-count").textContent = b.selected.size;
      // keep "select all" in sync with the visible subset
      const vis = visibleBatch(s);
      document.getElementById("bt-all").checked = vis.length > 0 && vis.every((r) => b.selected.has(r.id));
    });
  });

  // "select all" reflects the current visible subset
  document.getElementById("bt-all").checked = rows.length > 0 && rows.every((r) => b.selected.has(r.id));
}

async function submitBatch(s) {
  const b = s.batch;
  const ids = [...b.selected];
  const out = document.getElementById("bt-result");
  out.innerHTML = "";

  if (!ids.length)         return F.toast("pick at least one account", "err");
  if (!b.place_id || b.place_id < 1) return F.toast("place_id required", "err");

  const btn = document.getElementById("bt-submit");
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = `queuing ${ids.length}…`;

  const payload = {
    place_id:  b.place_id,
    script_id: b.script_id || null,
  };

  const { data, error } = await F.sb.rpc("fn_bulk_create_join_jobs", {
    p_account_ids: ids,
    p_payload:     payload,
    p_device_id:   b.device_id || null,
  });

  btn.disabled = false;
  btn.textContent = prev;

  if (error) {
    F.toast(error.message, "err");
    out.innerHTML = `<div class="batch-err">${F.esc(error.message)}</div>`;
    return;
  }

  const jobIds = (data || []).filter((x) => x && x !== 0);
  const skipped = (data || []).length - jobIds.length;
  F.toast(`queued ${jobIds.length} join job${jobIds.length === 1 ? "" : "s"}${skipped ? ` · ${skipped} skipped (no cookie)` : ""}`);

  out.innerHTML = `
    <div class="batch-ok">
      <div class="batch-ok-h">queued ${jobIds.length} job${jobIds.length === 1 ? "" : "s"}${skipped ? ` · ${skipped} skipped` : ""}</div>
      <div class="batch-ids">${jobIds.map((j) => `<code>#${j}</code>`).join(" ")}</div>
    </div>
  `;
  b.selected.clear();
  paintBatchList(s);
}


async function load(s) {
  const { data, error } = await F.sbTable("joiner_pools")
    .select("id,name,entries,updated_at")
    .order("name");
  if (error) { F.toast(error.message, "err"); return; }
  s.pools = data || [];
  render(s);
}

function render(s) {
  const grid = document.getElementById("pool-grid");
  if (!s.pools.length) {
    grid.className = "";
    grid.innerHTML = `<div class="empty">No pools yet. Click New pool to make one.</div>`;
    return;
  }
  grid.className = "pool-grid";
  grid.innerHTML = s.pools.map((p) => {
    const entries = Array.isArray(p.entries) ? p.entries : [];
    const bad = entries.filter((e) => e && e.bad).length;
    const good = entries.length - bad;
    return `
      <div class="pool-card" data-id="${F.esc(p.id)}">
        <div class="pool-name">${F.esc(p.name)}</div>
        <div class="pool-stats">
          <div><span class="k">entries</span><span class="v">${entries.length}</span></div>
          <div><span class="k">good</span><span class="v" style="color:var(--green)">${good}</span></div>
          <div><span class="k">bad</span><span class="v" style="color:var(--red)">${bad}</span></div>
        </div>
        <div class="pool-actions">
          <button class="btn" data-a="open">Open</button>
          <button class="btn" data-a="clear">Clear bad</button>
          <button class="btn danger" data-a="del">Delete</button>
        </div>
      </div>
    `;
  }).join("");

  grid.querySelectorAll(".pool-card").forEach((card) => {
    const id = card.dataset.id;
    card.querySelector('[data-a="open"]').addEventListener("click",  () => openPool(id, s));
    card.querySelector('[data-a="clear"]').addEventListener("click", () => clearBad(id, s));
    card.querySelector('[data-a="del"]').addEventListener("click",   () => deletePool(id, s));
  });
}

// ------------------- new pool -------------------
function openNew(refresh) {
  const body = F.el(`
    <div class="form">
      <label>Pool name <input class="input" id="np-name" placeholder="e.g. mm2 joiners" /></label>
      <label>Accounts, one per line (<code>user:pass:cookie</code>)
        <textarea class="input" id="np-txt" rows="10" placeholder="alice:hunter2:AAAAAA...&#10;bob:password1:BBBBB..."></textarea>
      </label>
      <div class="muted" style="font-size:11px">Cookie may be empty; lines that split into less than 2 parts are skipped.</div>
    </div>
  `);
  const foot = F.el(`<div style="display:flex;gap:8px;justify-content:flex-end">
    <button class="btn" data-a="cancel">Cancel</button>
    <button class="btn primary" data-a="go">Create</button>
  </div>`);
  const { close } = F.modal({ title: "New joiner pool", body, footer: foot, width: 520 });

  foot.querySelector('[data-a="cancel"]').addEventListener("click", close);
  foot.querySelector('[data-a="go"]').addEventListener("click", async () => {
    const name = body.querySelector("#np-name").value.trim();
    if (!name) return F.toast("name required", "err");
    const lines = body.querySelector("#np-txt").value.split("\n").map((l) => l.trim()).filter(Boolean);
    const entries = lines.map(parseLine).filter(Boolean);

    const { data: me } = await F.sb.auth.getUser();
    const { error } = await F.sbTable("joiner_pools").insert({
      owner_id: me.user.id,
      name,
      entries,
    });
    if (error) return F.toast(error.message, "err");
    F.toast(`pool created (${entries.length} entries)`); close(); refresh();
  });
}

function parseLine(line) {
  // Roblox cookies (.ROBLOSECURITY) embed a "_|WARNING:-DO-NOT-SHARE-THIS…"
  // prefix that contains colons, so destructuring on split(":") truncates
  // the cookie. Split only on the FIRST two colons and keep everything after
  // the second colon as the cookie.
  if (!line || line.indexOf(":") < 0) return null;
  const firstColon  = line.indexOf(":");
  const secondColon = line.indexOf(":", firstColon + 1);
  const user   = line.slice(0, firstColon);
  const pass   = secondColon === -1 ? line.slice(firstColon + 1) : line.slice(firstColon + 1, secondColon);
  const cookie = secondColon === -1 ? "" : line.slice(secondColon + 1);
  if (!user) return null;
  return { user, pass: pass || "", cookie: cookie || "", bad: false, last_used_at: null };
}

// ------------------- delete pool picker -------------------
async function openDeletePicker(s, refresh) {
  if (!s.pools.length) return F.toast("no pools", "err");
  const body = F.el(`
    <div class="form">
      <label>Pool to delete
        <select class="input" id="dp-id">
          ${s.pools.map((p) => `<option value="${p.id}">${F.esc(p.name)}</option>`).join("")}
        </select>
      </label>
    </div>
  `);
  const foot = F.el(`<div style="display:flex;gap:8px;justify-content:flex-end">
    <button class="btn" data-a="cancel">Cancel</button>
    <button class="btn danger" data-a="go">Delete</button>
  </div>`);
  const { close } = F.modal({ title: "Delete pool", body, footer: foot, width: 420 });
  foot.querySelector('[data-a="cancel"]').addEventListener("click", close);
  foot.querySelector('[data-a="go"]').addEventListener("click", async () => {
    const id = body.querySelector("#dp-id").value;
    close();
    await deletePool(id, s);
  });
}

async function deletePool(id, s) {
  const p = s.pools.find((x) => x.id === id);
  if (!(await F.confirm(`Delete pool "${p?.name ?? id}"? This drops every entry.`))) return;
  const { error } = await F.sbTable("joiner_pools").delete().eq("id", id);
  if (error) return F.toast(error.message, "err");
  F.toast("deleted"); await load(s);
}

async function clearBad(id, s) {
  const p = s.pools.find((x) => x.id === id);
  if (!p) return;
  const entries = (p.entries || []).filter((e) => !e.bad);
  const removed = (p.entries || []).length - entries.length;
  if (!removed) return F.toast("nothing to clear");
  const { error } = await F.sbTable("joiner_pools").update({ entries, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) return F.toast(error.message, "err");
  F.toast(`${removed} bad removed`); await load(s);
}

// ------------------- open pool (list + checkboxes + export) -------------------
async function openPool(id, s) {
  const pool = s.pools.find((x) => x.id === id);
  if (!pool) return;
  // Clone so edits in the modal don't mutate the cached list until we save.
  let entries = JSON.parse(JSON.stringify(pool.entries || []));
  const selected = new Set();

  const body = F.el(`
    <div class="form">
      <div class="muted" style="font-size:11.5px">
        <span id="po-count">0</span> entries, <span id="po-bad" style="color:var(--red)">0</span> bad.
      </div>
      <div class="pool-list" id="po-list"></div>
      <div style="display:flex;gap:8px;align-items:center">
        <input type="checkbox" id="po-all" />
        <label for="po-all" style="font-size:11.5px;color:var(--fg-muted);flex-direction:row">Select all</label>
        <div class="spacer" style="flex:1"></div>
        <button class="btn" data-a="mark-bad">Flag selected bad</button>
        <button class="btn" data-a="clear-bad">Clear bad</button>
        <button class="btn" data-a="dl">Download .txt</button>
      </div>
    </div>
  `);
  const foot = F.el(`<div style="display:flex;gap:8px;justify-content:flex-end">
    <button class="btn" data-a="close">Close</button>
    <button class="btn primary" data-a="save">Save</button>
  </div>`);
  const { close } = F.modal({ title: `Pool · ${pool.name}`, body, footer: foot, width: 640 });

  function paint() {
    const list = body.querySelector("#po-list");
    const bad = entries.filter((e) => e.bad).length;
    body.querySelector("#po-count").textContent = entries.length;
    body.querySelector("#po-bad").textContent = bad;

    if (!entries.length) {
      list.innerHTML = `<div class="empty">empty pool</div>`;
      return;
    }
    list.innerHTML = entries.map((e, i) => `
      <div class="pool-row${e.bad ? " bad" : ""}">
        <input type="checkbox" class="po-sel" data-i="${i}" ${selected.has(i) ? "checked" : ""} />
        <span class="po-user">${F.esc(e.user)}</span>
        <span class="po-pass">${F.esc(e.pass || "—")}</span>
        <span class="po-cookie">${e.cookie ? F.esc(e.cookie.slice(0, 18)) + "…" : "—"}</span>
        <span class="po-last">${e.last_used_at ? new Date(e.last_used_at).toLocaleString() : "never"}</span>
        <span class="po-flag">${e.bad ? "BAD" : ""}</span>
      </div>
    `).join("");

    list.querySelectorAll(".po-sel").forEach((cb) =>
      cb.addEventListener("change", (ev) => {
        const i = Number(ev.target.dataset.i);
        ev.target.checked ? selected.add(i) : selected.delete(i);
      })
    );
    body.querySelector("#po-all").checked = selected.size === entries.length && entries.length > 0;
  }
  paint();

  body.querySelector("#po-all").addEventListener("change", (ev) => {
    selected.clear();
    if (ev.target.checked) entries.forEach((_, i) => selected.add(i));
    paint();
  });

  body.querySelector('[data-a="mark-bad"]').addEventListener("click", () => {
    if (!selected.size) return F.toast("nothing selected", "err");
    [...selected].forEach((i) => { if (entries[i]) entries[i].bad = true; });
    selected.clear();
    paint();
  });

  body.querySelector('[data-a="clear-bad"]').addEventListener("click", () => {
    entries = entries.filter((e) => !e.bad);
    selected.clear();
    paint();
  });

  body.querySelector('[data-a="dl"]').addEventListener("click", () => {
    const text = entries.map((e) => `${e.user}:${e.pass || ""}:${e.cookie || ""}`).join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${pool.name.replace(/[^\w.-]+/g, "_")}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  foot.querySelector('[data-a="close"]').addEventListener("click", close);
  foot.querySelector('[data-a="save"]').addEventListener("click", async () => {
    const { error } = await F.sbTable("joiner_pools")
      .update({ entries, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) return F.toast(error.message, "err");
    F.toast("saved"); close(); await load(s);
  });
}

})();
