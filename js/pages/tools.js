(function () {
// Tools — export accounts by tag, bulk credential update, bulk delete,
// and custom trackstats schema authoring.
window.F = window.F || {};
F.pages = F.pages || {};

F.pages.tools = async function (view) {
  view.innerHTML = `
    <h1>Tools</h1>

    <div class="card">
      <div class="card-h">Export Accounts</div>
      <div class="muted" style="font-size:11px;margin-bottom:10px">
        Click a tag to download <code>user:pass:cookie</code> lines for that tag.
      </div>
      <div class="t-pills" id="t-export"><div class="loading">loading…</div></div>
    </div>

    <div class="card">
      <div class="card-h">Update Credentials</div>
      <div class="muted" style="font-size:11px;margin-bottom:8px">
        One per line: <code>user:pass:cookie</code> or <code>user:pass:cookie:privateServer</code>.
        Matches existing accounts by username.
      </div>
      <textarea class="input" id="t-upd-txt" rows="8"
        placeholder="user:pass:cookie&#10;user:pass:cookie:privateServerUrlOrCode"></textarea>
      <div class="t-row" style="margin-top:10px">
        <label class="t-chk"><input type="checkbox" id="t-upd-clear" /> Clear status tags on updated accounts</label>
        <label class="t-chk"><input type="checkbox" id="t-upd-re" /> Re-enable disabled accounts</label>
        <div class="spacer"></div>
        <button class="btn primary" id="t-upd-go">Update</button>
      </div>
    </div>

    <div class="card">
      <div class="card-h">Delete Accounts</div>
      <div class="muted" style="font-size:11px;margin-bottom:8px">
        One per line: <code>user:pass:cookie</code>. Only the username is used for matching.
      </div>
      <textarea class="input" id="t-del-txt" rows="6"
        placeholder="user:pass:cookie"></textarea>
      <div class="t-row" style="margin-top:10px">
        <div class="spacer"></div>
        <button class="btn danger" id="t-del-go">Delete Accounts</button>
      </div>
    </div>

    <div class="card">
      <div class="card-h">
        Custom Trackstats
        <div class="spacer"></div>
        <button class="btn primary" id="t-ts-new">+ New schema</button>
      </div>
      <div class="muted" style="font-size:11px;margin-bottom:10px">
        Author trackstats for any game: write a small Lua reporter in-game that POSTs
        <code>fn_worker_trackstat_push</code> with a flat <code>{ field: number }</code> payload,
        then describe its fields here. Each field needs
        <code>{ kind: "sum"|"last"|"max", label, rarity }</code>.
      </div>
      <table class="tbl">
        <thead><tr><th>Game slug</th><th>Author</th><th>Fields</th><th style="width:140px"></th></tr></thead>
        <tbody id="t-ts-body"><tr><td colspan="4" class="empty">loading…</td></tr></tbody>
      </table>
    </div>
  `;

  await Promise.all([loadExport(view), loadSchemas(view)]);

  view.querySelector("#t-upd-go").addEventListener("click", () => runUpdate(view));
  view.querySelector("#t-del-go").addEventListener("click", () => runDelete(view));
  view.querySelector("#t-ts-new").addEventListener("click", () => openSchema(null, () => loadSchemas(view)));
};

// ------------------- export by tag -------------------
async function loadExport(view) {
  const { data, error } = await F.sbTable("accounts").select("tags").limit(50000);
  if (error) { F.toast(error.message, "err"); return; }
  const counts = {};
  (data || []).forEach((r) => (r.tags || []).forEach((t) => { counts[t] = (counts[t] || 0) + 1; }));
  const tags = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const el = view.querySelector("#t-export");
  if (!tags.length) { el.innerHTML = `<div class="empty">no tags yet</div>`; return; }
  el.innerHTML = tags.map(([t, n]) =>
    `<button class="t-pill" data-tag="${F.esc(t)}">${F.esc(t)} <span class="t-pill-n">${n}</span></button>`
  ).join("");
  el.querySelectorAll("[data-tag]").forEach((b) => b.addEventListener("click", () => exportTag(b.dataset.tag)));
}

async function exportTag(tag) {
  const { data, error } = await F.sbTable("accounts")
    .select("username,password,cookie,private_server")
    .contains("tags", [tag])
    .limit(50000);
  if (error) { F.toast(error.message, "err"); return; }
  const lines = (data || []).map((r) => {
    const base = `${r.username || ""}:${r.password || ""}:${r.cookie || ""}`;
    return r.private_server ? `${base}:${r.private_server}` : base;
  });
  if (!lines.length) { F.toast("no accounts for that tag", "err"); return; }
  const blob = new Blob([lines.join("\n")], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `${tag.replace(/[^a-z0-9._-]+/gi, "_")}.txt`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  F.toast(`${lines.length} exported`);
}

// ------------------- update credentials -------------------
async function runUpdate(view) {
  const lines = view.querySelector("#t-upd-txt").value
    .split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return F.toast("nothing to update", "err");

  const clearTags = view.querySelector("#t-upd-clear").checked;
  const reEnable  = view.querySelector("#t-upd-re").checked;

  const { data: me } = await F.sb.auth.getUser();
  const owner_id = me.user.id;

  const rows = [];
  for (const l of lines) {
    const [u, p, c, srv] = l.split(":");
    if (!u) continue;
    const row = { owner_id, username: u };
    if (p !== undefined) row.password = p || null;
    if (c !== undefined) row.cookie = c || null;
    if (srv !== undefined) row.private_server = srv || null;
    if (clearTags) row.tags = [];
    if (reEnable) row.status = "enabled";
    rows.push(row);
  }
  if (!rows.length) return F.toast("no valid lines", "err");

  let ok = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await F.sbTable("accounts")
      .upsert(chunk, { onConflict: "owner_id,username", ignoreDuplicates: false });
    if (error) { F.toast(`row ${i}: ${error.message}`, "err"); return; }
    ok += chunk.length;
  }
  F.toast(`${ok} updated`);
  view.querySelector("#t-upd-txt").value = "";
}

// ------------------- delete accounts -------------------
async function runDelete(view) {
  const lines = view.querySelector("#t-del-txt").value
    .split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return F.toast("nothing to delete", "err");
  const names = [...new Set(lines.map((l) => l.split(":")[0]).filter(Boolean))];
  if (!names.length) return F.toast("no usernames parsed", "err");
  if (!(await F.confirm(`Delete ${names.length} account(s)? This cannot be undone.`))) return;
  // Belt-and-braces alongside RLS: explicitly scope to the caller's tenant so
  // a future RLS regression can't let one tenant delete another's accounts by
  // username collision. (Long-term this belongs behind a SECURITY DEFINER RPC.)
  const { data: me } = await F.sb.auth.getUser();
  const { error, count } = await F.sbTable("accounts")
    .delete({ count: "exact" })
    .eq("owner_id", me.user.id)
    .in("username", names);
  if (error) return F.toast(error.message, "err");
  F.toast(`${count || 0} deleted`);
  view.querySelector("#t-del-txt").value = "";
}

// ------------------- trackstats schemas -------------------
async function loadSchemas(view) {
  const { data, error } = await F.sbTable("trackstat_schemas")
    .select("id,game_slug,author,fields").order("game_slug");
  if (error) { F.toast(error.message, "err"); return; }
  const rows = data || [];
  const body = view.querySelector("#t-ts-body");
  if (!rows.length) { body.innerHTML = `<tr><td colspan="4" class="empty">no schemas yet</td></tr>`; return; }
  body.innerHTML = rows.map((r) => {
    const n = r.fields ? Object.keys(r.fields).length : 0;
    return `
      <tr>
        <td><code>${F.esc(r.game_slug)}</code></td>
        <td>${F.esc(r.author || "—")}</td>
        <td>${n}</td>
        <td>
          <button class="btn" data-a="edit" data-id="${r.id}">Edit</button>
          <button class="btn danger" data-a="del" data-id="${r.id}">Delete</button>
        </td>
      </tr>`;
  }).join("");
  body.querySelectorAll("[data-a='edit']").forEach((b) =>
    b.addEventListener("click", () => openSchema(rows.find((r) => r.id === b.dataset.id), () => loadSchemas(view)))
  );
  body.querySelectorAll("[data-a='del']").forEach((b) =>
    b.addEventListener("click", async () => {
      const r = rows.find((x) => x.id === b.dataset.id);
      if (!(await F.confirm(`Delete schema "${r.game_slug}"? Rollups stay but become orphaned.`))) return;
      const { error } = await F.sbTable("trackstat_schemas").delete().eq("id", r.id);
      if (error) return F.toast(error.message, "err");
      F.toast("deleted"); loadSchemas(view);
    })
  );
}

function openSchema(row, refresh) {
  const sample = `{
  "bucks":   { "kind": "sum",  "label": "Bucks",          "rarity": "bucks" },
  "potions": { "kind": "sum",  "label": "Potions",        "rarity": "potion" },
  "heart":   { "kind": "sum",  "label": "Heart Pet",      "rarity": "legendary" },
  "ping":    { "kind": "last", "label": "Ping (ms)",      "rarity": "" }
}`;
  const body = F.el(`
    <div class="form">
      <label>Game slug (unique per owner)
        <input class="input" id="s-slug" value="${F.esc(row?.game_slug || "")}" ${row ? "disabled" : ""} placeholder="e.g. adopt_me" />
      </label>
      <label>Author
        <input class="input" id="s-author" value="${F.esc(row?.author || "")}" placeholder="your name / handle" />
      </label>
      <label>Fields (JSON object)
        <textarea class="input t-json" id="s-fields" rows="14">${F.esc(row?.fields ? JSON.stringify(row.fields, null, 2) : sample)}</textarea>
      </label>
      <div class="muted" style="font-size:11px">
        kind: <code>sum</code> adds every push, <code>last</code> replaces, <code>max</code> keeps the largest.
        rarity drives the item pill color and the tile bucket matching (bucks / potion / event / pet).
      </div>
    </div>
  `);
  const foot = F.el(`<div style="display:flex;gap:8px;justify-content:flex-end">
    <button class="btn" data-a="cancel">Cancel</button>
    <button class="btn primary" data-a="save">${row ? "Save" : "Create"}</button>
  </div>`);
  const { close } = F.modal({ title: row ? `Edit ${row.game_slug}` : "New trackstats schema", body, footer: foot, width: 620 });

  foot.querySelector("[data-a='cancel']").addEventListener("click", close);
  foot.querySelector("[data-a='save']").addEventListener("click", async () => {
    const slug   = body.querySelector("#s-slug").value.trim();
    const author = body.querySelector("#s-author").value.trim();
    const raw    = body.querySelector("#s-fields").value;
    if (!slug) return F.toast("game slug required", "err");
    let fields;
    try { fields = JSON.parse(raw); }
    catch (e) { return F.toast("fields: invalid JSON", "err"); }
    if (!fields || typeof fields !== "object" || Array.isArray(fields))
      return F.toast("fields must be an object", "err");
    for (const [k, v] of Object.entries(fields)) {
      if (!v || typeof v !== "object") return F.toast(`${k}: must be an object`, "err");
      if (!["sum", "last", "max"].includes(v.kind)) return F.toast(`${k}: kind must be sum|last|max`, "err");
    }

    const { data: me } = await F.sb.auth.getUser();
    const patch = { owner_id: me.user.id, game_slug: slug, author: author || null, fields };
    let err;
    if (row) ({ error: err } = await F.sbTable("trackstat_schemas").update(patch).eq("id", row.id));
    else     ({ error: err } = await F.sbTable("trackstat_schemas")
                 .upsert(patch, { onConflict: "owner_id,game_slug" }));
    if (err) return F.toast(err.message, "err");
    F.toast(row ? "saved" : "created"); close(); refresh();
  });
}

})();
