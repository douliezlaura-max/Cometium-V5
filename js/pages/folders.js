(function () {
// Folders page — card grid with input/output counts, create/rename/delete, click to filter accounts.
window.F = window.F || {};
F.pages = F.pages || {};

F.pages.folders = async function (view) {
  view.innerHTML = `
    <h1>Folders</h1>
    <div class="card">
      <div class="card-h">
        <span id="count">0</span> folders
        <div class="spacer"></div>
        <button class="btn primary" id="btn-new">+ Create Folder</button>
      </div>
      <div class="folder-grid" id="grid"><div class="empty">loading…</div></div>
    </div>
  `;

  view.querySelector("#btn-new").addEventListener("click", () => openEdit(null, () => load()));

  await load();

  async function load() {
    const { data: folders } = await F.sbTable("folders").select("id,name,kind").order("name");
    const list = folders || [];
    document.getElementById("count").textContent = list.length;

    // Pull per-folder counts in one query, split by "kind" convention:
    //   tag "[input]" on folder name → input bucket
    //   tag "[output]" on folder name → output bucket
    // Simpler: just count total accounts per folder.
    const counts = {};
    if (list.length) {
      const ids = list.map((f) => f.id);
      const { data: rows } = await F.sbTable("accounts")
        .select("folder_id")
        .in("folder_id", ids)
        .limit(50000);
      (rows || []).forEach((r) => { counts[r.folder_id] = (counts[r.folder_id] || 0) + 1; });
    }

    const grid = document.getElementById("grid");
    if (!list.length) { grid.innerHTML = `<div class="empty">no folders yet</div>`; return; }
    grid.innerHTML = list.map((f) => {
      const n = counts[f.id] || 0;
      const isInput  = /\[input\]/i.test(f.name);
      const isOutput = /\[output\]/i.test(f.name);
      return `
        <div class="folder-card" data-id="${f.id}">
          <div class="folder-name">${F.esc(f.name)}</div>
          <div class="folder-stats">
            <div><span class="muted">${isOutput ? "Output" : "Input"}:</span> ${isOutput ? 0 : n}</div>
            <div><span class="muted">${isOutput ? "Input" : "Output"}:</span> ${isOutput ? n : 0}</div>
          </div>
          <div class="folder-actions">
            <button class="btn" data-a="open" data-id="${f.id}">Open</button>
            <button class="btn" data-a="edit" data-id="${f.id}">Rename</button>
            <button class="btn danger" data-a="del" data-id="${f.id}">Delete</button>
          </div>
        </div>`;
    }).join("");

    grid.querySelectorAll("[data-a='open']").forEach((b) =>
      b.addEventListener("click", (e) => {
        location.hash = `#/accounts?folder=${encodeURIComponent(e.target.dataset.id)}`;
      })
    );
    grid.querySelectorAll("[data-a='edit']").forEach((b) =>
      b.addEventListener("click", (e) => {
        const row = list.find((f) => f.id === e.target.dataset.id);
        openEdit(row, load);
      })
    );
    grid.querySelectorAll("[data-a='del']").forEach((b) =>
      b.addEventListener("click", async (e) => {
        const row = list.find((f) => f.id === e.target.dataset.id);
        if (!(await F.confirm(`Delete folder "${row.name}"? Accounts stay but lose their folder.`))) return;
        const { error } = await F.sbTable("folders").delete().eq("id", row.id);
        if (error) return F.toast(error.message, "err");
        F.toast("folder deleted"); load();
      })
    );
  }
};

function openEdit(row, refresh) {
  const body = F.el(`
    <div class="form">
      <label>Name
        <input class="input" id="fname" value="${F.esc(row?.name || "")}"
               placeholder="e.g. adm dead accs [input]" />
      </label>
      <div class="muted" style="font-size:11px">
        Tip: append <code>[input]</code> or <code>[output]</code> to the name to tag the folder as a source
        or a destination for autoswap. The dashboard reads those tags.
      </div>
    </div>
  `);
  const foot = F.el(`<div style="display:flex;gap:8px;justify-content:flex-end">
    <button class="btn" data-a="cancel">Cancel</button>
    <button class="btn primary" data-a="save">${row ? "Save" : "Create"}</button>
  </div>`);
  const { close } = F.modal({ title: row ? "Rename folder" : "New folder", body, footer: foot, width: 440 });
  foot.querySelector("[data-a='cancel']").addEventListener("click", close);
  foot.querySelector("[data-a='save']").addEventListener("click", async () => {
    const name = body.querySelector("#fname").value.trim();
    if (!name) return F.toast("name required", "err");
    const { data: me } = await F.sb.auth.getUser();
    let err;
    if (row) ({ error: err } = await F.sbTable("folders").update({ name }).eq("id", row.id));
    else     ({ error: err } = await F.sbTable("folders").insert({ owner_id: me.user.id, name }));
    if (err) return F.toast(err.message, "err");
    F.toast(row ? "saved" : "created"); close(); refresh();
  });
}

})();
