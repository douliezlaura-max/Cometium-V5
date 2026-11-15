(function () {
// Autoswap page — table of rulesets with inline edit + per-rule paused pills.
window.F = window.F || {};
F.pages = F.pages || {};

const RULES = [
  { key: "face",             label: "Face" },
  { key: "banned",           label: "Banned" },
  { key: "dead",             label: "Dead" },
  { key: "place_ban",        label: "Place Ban" },
  { key: "age_verification", label: "Age Verification" },
];

const GAME_OPTS = [
  { v: "",                label: "Any" },
  { v: "adopt_me",        label: "Adopt Me!" },
  { v: "mm2",             label: "Murder Mystery 2" },
  { v: "blox_fruits",     label: "Blox Fruits" },
  { v: "aot_revolution",  label: "AOT: Revolution" },
  { v: "grow_a_garden",   label: "Grow a Garden" },
];

F.pages.autoswap = async function (view) {
  view.innerHTML = `
    <h1>Autoswap</h1>
    <div class="card">
      <div class="card-h">
        <span id="count">0</span> rulesets
        <div class="spacer"></div>
        <button class="btn primary" id="btn-new">+ New Config</button>
      </div>
      <table class="tbl as-tbl">
        <thead><tr>
          <th>Name</th><th>Game</th><th>Rules</th><th style="width:120px">Accounts</th><th style="width:170px"></th>
        </tr></thead>
        <tbody id="rows"><tr><td colspan="5" class="empty">loading…</td></tr></tbody>
      </table>
    </div>
  `;

  view.querySelector("#btn-new").addEventListener("click", () => openEdit(null, () => load(view)));
  await load(view);
};

async function load(view) {
  const { data: rows } = await F.sbTable("autoswaps")
    .select("id,name,game_slug,rules,paused_rules").order("name");
  const list = rows || [];
  // Count accounts per autoswap in one lookup (small lists, head/count ok).
  const counts = {};
  await Promise.all(list.map(async (a) => {
    const { count } = await F.sbTable("accounts")
      .select("id", { count: "exact", head: true }).eq("autoswap_id", a.id);
    counts[a.id] = count || 0;
  }));

  document.getElementById("count").textContent = list.length;
  const body = document.getElementById("rows");
  if (!list.length) { body.innerHTML = `<tr><td colspan="5" class="empty">no autoswap rules yet</td></tr>`; return; }

  body.innerHTML = list.map((a) => {
    const rules = a.rules || {};
    const paused = new Set(a.paused_rules || []);
    const pills = RULES.filter((r) => rules[r.key]).map((r) =>
      `<span class="as-pill-rule ${paused.has(r.key) ? "paused" : ""}">${F.esc(r.label)}${paused.has(r.key) ? " · Paused" : ""}</span>`
    ).join(" ");
    return `
      <tr>
        <td>${F.esc(a.name)}</td>
        <td>${F.esc(gameLabel(a.game_slug))}</td>
        <td>${pills || '<span class="muted">—</span>'}</td>
        <td>${counts[a.id] ?? 0}</td>
        <td>
          <button class="btn" data-a="edit" data-id="${a.id}">Edit</button>
          <button class="btn danger" data-a="del" data-id="${a.id}">Delete</button>
        </td>
      </tr>`;
  }).join("");

  body.querySelectorAll("[data-a='edit']").forEach((b) =>
    b.addEventListener("click", () => openEdit(list.find((x) => x.id === b.dataset.id), () => load(view)))
  );
  body.querySelectorAll("[data-a='del']").forEach((b) =>
    b.addEventListener("click", async () => {
      const row = list.find((x) => x.id === b.dataset.id);
      if (!(await F.confirm(`Delete autoswap "${row.name}"? Accounts stay but lose the rule.`))) return;
      const { error } = await F.sbTable("autoswaps").delete().eq("id", row.id);
      if (error) return F.toast(error.message, "err");
      F.toast("deleted"); load(view);
    })
  );
}

function gameLabel(slug) {
  const o = GAME_OPTS.find((g) => g.v === (slug || ""));
  return o ? o.label : slug || "Any";
}

function openEdit(row, refresh) {
  const rules  = (row && row.rules)  || {};
  const paused = new Set((row && row.paused_rules) || []);
  const body = F.el(`
    <div class="form">
      <label>Name <input class="input" id="e-name" value="${F.esc(row?.name || "")}" placeholder="e.g. adm-rotate" /></label>
      <label>Game (optional)
        <select class="input" id="e-game">
          ${GAME_OPTS.map((g) => `<option value="${g.v}" ${g.v === (row?.game_slug || "") ? "selected" : ""}>${F.esc(g.label)}</option>`).join("")}
        </select>
      </label>
      <div class="as-rule-list">
        ${RULES.map((r) => `
          <div class="as-rule-row">
            <label class="as-rule-main">
              <input type="checkbox" data-r="${r.key}" ${rules[r.key] ? "checked" : ""} />
              <span>${F.esc(r.label)}</span>
            </label>
            <label class="as-rule-pause">
              <input type="checkbox" data-p="${r.key}" ${paused.has(r.key) ? "checked" : ""} />
              <span>Paused</span>
            </label>
          </div>
        `).join("")}
      </div>
    </div>
  `);
  const foot = F.el(`<div style="display:flex;gap:8px;justify-content:flex-end">
    <button class="btn" data-a="cancel">Cancel</button>
    <button class="btn primary" data-a="save">${row ? "Save" : "Create"}</button>
  </div>`);
  const { close } = F.modal({ title: row ? `Edit ${row.name}` : "New autoswap", body, footer: foot, width: 520 });

  foot.querySelector("[data-a='cancel']").addEventListener("click", close);
  foot.querySelector("[data-a='save']").addEventListener("click", async () => {
    const name = body.querySelector("#e-name").value.trim();
    if (!name) return F.toast("name required", "err");
    const game = body.querySelector("#e-game").value || null;
    const nextRules = {}; const pausedArr = [];
    RULES.forEach((r) => {
      const on = body.querySelector(`[data-r='${r.key}']`).checked;
      nextRules[r.key] = on;
      if (on && body.querySelector(`[data-p='${r.key}']`).checked) pausedArr.push(r.key);
    });
    const patch = { name, game_slug: game, rules: nextRules, paused_rules: pausedArr };
    let err;
    if (row) ({ error: err } = await F.sbTable("autoswaps").update(patch).eq("id", row.id));
    else {
      const { data: me } = await F.sb.auth.getUser();
      ({ error: err } = await F.sbTable("autoswaps").insert({ owner_id: me.user.id, ...patch }));
    }
    if (err) return F.toast(err.message, "err");
    F.toast(row ? "saved" : "created"); close(); refresh();
  });
}

})();
