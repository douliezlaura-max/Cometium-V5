(function () {
// Hubs — manifest-first view over the scripts table.
// Per-row panel: manifest (version, author, target places, required
// apis, description), size + sha256 short + last-updated + how many
// configs reference it. Buttons: Reload now (bumps scripts.updated_at
// so watchHub() picks it up), Edit source (opens a textarea with full
// source from scripts.source), Delete.
//
// Route: #/hubs. Reuses F.sb / F.sbTable / F.toast / F.esc / F.confirm
// so it inherits the same auth + styling as every other page.
window.F = window.F || {};
F.pages = F.pages || {};

F.pages.hubs = async function (view) {
  view.innerHTML = `
    <h1>Hubs</h1>
    <div class="card">
      <div class="card-h">
        <input class="input" id="hb-filter" placeholder="filter by name / author / api" style="max-width:320px" />
        <div class="spacer"></div>
        <span class="muted" id="hb-count">0 hubs</span>
      </div>
      <table class="tbl">
        <thead>
          <tr>
            <th>Name</th>
            <th>Manifest version</th>
            <th>Author</th>
            <th>Place</th>
            <th>Size</th>
            <th>sha256</th>
            <th>Configs</th>
            <th>Updated</th>
            <th style="width:220px"></th>
          </tr>
        </thead>
        <tbody id="hb-body"><tr><td colspan="9" class="empty">loading...</td></tr></tbody>
      </table>
    </div>
    <div id="hb-detail"></div>
  `;

  const state = {
    rows:   [],
    counts: {},
    filter: "",
  };

  await loadAll(view, state);
  const inp = view.querySelector("#hb-filter");
  if (inp) {
    inp.addEventListener("input", () => {
      state.filter = inp.value.trim().toLowerCase();
      renderList(view, state);
    });
  }
};

async function loadAll(view, state) {
  const [{ data: rows, error }, { data: links }] = await Promise.all([
    F.sbTable("scripts")
      .select("id,name,author,place_id,manifest_json,hash,version,updated_at,source")
      .order("updated_at", { ascending: false })
      .limit(500),
    F.sbTable("config_scripts").select("script_id").limit(5000),
  ]);
  if (error) { F.toast(error.message, "err"); return; }

  const counts = {};
  (links || []).forEach((l) => {
    counts[l.script_id] = (counts[l.script_id] || 0) + 1;
  });

  // Include a derived size_bytes so the table does not hold the full
  // source in the row until the user clicks Edit. Source stays on the
  // state row because the dashboard owner can read it anyway (RLS
  // already gates on owner_id); clearing it would just force a second
  // round-trip on Edit for no privacy win.
  state.rows = (rows || []).map((r) => {
    const m = (r.manifest_json && typeof r.manifest_json === "object") ? r.manifest_json : {};
    return {
      id:          r.id,
      name:        r.name,
      author:      r.author || m.author || "",
      place_id:    r.place_id,
      manifest:    m,
      version:     r.version,
      hash:        r.hash || "",
      size_bytes:  r.source ? r.source.length : 0,
      source:      r.source || "",
      updated_at:  r.updated_at,
    };
  });
  state.counts = counts;
  renderList(view, state);
}

function renderList(view, state) {
  const body  = view.querySelector("#hb-body");
  const count = view.querySelector("#hb-count");
  if (!body) return;

  const f = state.filter;
  const filtered = state.rows.filter((r) => {
    if (!f) return true;
    const apis = (r.manifest && Array.isArray(r.manifest.required_apis))
      ? r.manifest.required_apis.join(" ") : "";
    const hay = `${r.name} ${r.author} ${apis} ${r.manifest.description || ""}`.toLowerCase();
    return hay.includes(f);
  });
  count.textContent = `${filtered.length} hub${filtered.length === 1 ? "" : "s"}`;

  if (!filtered.length) {
    body.innerHTML = `<tr><td colspan="9" class="empty">no hubs match</td></tr>`;
    return;
  }

  body.innerHTML = filtered.map((r) => {
    const mv = (r.manifest && r.manifest.version) ? r.manifest.version : "v0";
    const legacy = r.manifest && r.manifest.legacy === true;
    const sz  = fmtSize(r.size_bytes);
    const sh  = r.hash ? r.hash.slice(0, 10) : "-";
    const upd = r.updated_at ? new Date(r.updated_at).toLocaleString() : "";
    const n   = state.counts[r.id] || 0;
    const pid = r.place_id == null ? '<span class="muted">any</span>' : F.esc(String(r.place_id));
    const vtag = legacy ? '<span class="muted" title="no manifest">legacy</span>' : F.esc(mv);
    return `
      <tr data-id="${F.esc(r.id)}" data-name="${F.esc(r.name)}">
        <td>${F.esc(r.name)}</td>
        <td>${vtag}</td>
        <td>${r.author ? F.esc(r.author) : '<span class="muted">-</span>'}</td>
        <td>${pid}</td>
        <td>${sz}</td>
        <td><code class="muted" title="${F.esc(r.hash || "")}">${F.esc(sh)}</code></td>
        <td>${n}</td>
        <td>${F.esc(upd)}</td>
        <td>
          <button class="btn" data-a="open">Details</button>
          <button class="btn" data-a="reload">Reload now</button>
          <button class="btn danger" data-a="del">Delete</button>
        </td>
      </tr>
    `;
  }).join("");

  body.querySelectorAll("[data-a]").forEach((b) => {
    b.addEventListener("click", async () => {
      const tr = b.closest("tr");
      const id = tr.dataset.id;
      const name = tr.dataset.name;
      const row = state.rows.find((x) => x.id === id);
      if (!row) return;
      const action = b.dataset.a;
      if (action === "reload") return reloadHub(view, state, row);
      if (action === "del")    return deleteHub(view, state, row);
      if (action === "open")   return openDetail(view, state, row);
    });
  });
}

async function reloadHub(view, state, row) {
  const { data, error } = await F.sb.rpc("fn_hub_touch", { p_script_id: row.id });
  if (error) { F.toast(error.message, "err"); return; }
  F.toast(`reloaded · ${new Date(data).toLocaleTimeString()}`);
  await loadAll(view, state);
}

async function deleteHub(view, state, row) {
  if (!(await F.confirm(`Delete hub "${row.name}"?`))) return;
  const { error } = await F.sbTable("scripts").delete().eq("id", row.id);
  if (error) { F.toast(error.message, "err"); return; }
  F.toast("deleted");
  await loadAll(view, state);
}

function openDetail(view, state, row) {
  const host = view.querySelector("#hb-detail");
  const m = row.manifest || {};
  const apis = Array.isArray(m.required_apis) ? m.required_apis : [];
  const bindings = Array.isArray(m.required_cometium_bindings) ? m.required_cometium_bindings : [];
  const places = Array.isArray(m.target_place_ids) ? m.target_place_ids : [];
  const hotReload = m.hot_reload === true;
  const refCount = state.counts[row.id] || 0;
  host.innerHTML = `
    <div class="card">
      <div class="card-h">
        ${F.esc(row.name)}
        <span class="muted" style="margin-left:8px">v${row.version} (manifest ${F.esc(m.version || "v0")})</span>
        <div class="spacer"></div>
        <button class="btn" id="hb-close">Close</button>
      </div>
      <div class="hb-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:12px 0">
        <div>
          <div class="muted" style="font-size:11px">author</div>
          <div>${row.author ? F.esc(row.author) : '<span class="muted">-</span>'}</div>
        </div>
        <div>
          <div class="muted" style="font-size:11px">hash (sha256)</div>
          <div><code>${F.esc(row.hash || "-")}</code></div>
        </div>
        <div>
          <div class="muted" style="font-size:11px">size</div>
          <div>${fmtSize(row.size_bytes)}</div>
        </div>
        <div>
          <div class="muted" style="font-size:11px">attached to configs</div>
          <div>${refCount}</div>
        </div>
        <div>
          <div class="muted" style="font-size:11px">target place ids</div>
          <div>${places.length ? places.map((x) => F.esc(String(x))).join(", ") : '<span class="muted">any</span>'}</div>
        </div>
        <div>
          <div class="muted" style="font-size:11px">hot reload</div>
          <div>${hotReload ? "enabled" : '<span class="muted">off</span>'}</div>
        </div>
        <div>
          <div class="muted" style="font-size:11px">required apis</div>
          <div>${apis.length ? apis.map((x) => `<code>${F.esc(x)}</code>`).join(" ") : '<span class="muted">none</span>'}</div>
        </div>
        <div>
          <div class="muted" style="font-size:11px">required cometium bindings</div>
          <div>${bindings.length ? bindings.map((x) => `<code>${F.esc(x)}</code>`).join(" ") : '<span class="muted">none</span>'}</div>
        </div>
      </div>
      ${m.description ? `<div style="margin-bottom:8px"><div class="muted" style="font-size:11px">description</div><div>${F.esc(m.description)}</div></div>` : ""}
      ${m.changelog   ? `<div style="margin-bottom:8px"><div class="muted" style="font-size:11px">changelog</div><pre class="code" style="white-space:pre-wrap">${F.esc(m.changelog)}</pre></div>` : ""}
      <div>
        <div class="muted" style="font-size:11px">source (${fmtSize(row.size_bytes)})</div>
        <textarea class="input" id="hb-src" rows="14" style="font-family:ui-monospace,monospace;font-size:12px">${F.esc(row.source || "")}</textarea>
        <div class="t-row" style="margin-top:8px">
          <div class="spacer"></div>
          <button class="btn primary" id="hb-save">Save & bump</button>
        </div>
      </div>
    </div>
  `;
  host.querySelector("#hb-close").addEventListener("click", () => { host.innerHTML = ""; });
  host.querySelector("#hb-save").addEventListener("click", async () => {
    const src = host.querySelector("#hb-src").value;
    if (!src) { F.toast("source empty", "err"); return; }
    const { error } = await F.sb.rpc("fn_upsert_script", {
      p_name: row.name,
      p_source: src,
      p_place_id: row.place_id,
      p_manifest: row.manifest || null,
      p_author: row.author || null,
    });
    if (error) { F.toast(error.message, "err"); return; }
    F.toast("saved");
    host.innerHTML = "";
    await loadAll(view, state);
  });
}

function fmtSize(n) {
  n = Number(n || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
})();
