(function () {
// Captcha Solver settings — list of webhooks the worker POSTs {username,cookie,custom_field} to.
window.F = window.F || {};
F.pages = F.pages || {};

const SENDS_OPTIONS = [
  ["account_on_device", "Account on the device"],
  ["all",               "All enabled webhooks"],
];

const EXAMPLE_PAYLOAD = JSON.stringify({ username: "example_user", cookie: "_|WARNING:-DO-NOT-SHARE-THIS...", custom_field: "your value" }, null, 2);

F.pages["captcha-settings"] = async function (view) {
  // v3.11 — master switch now persists server-side in key_value_store
  // (workspace-scoped). Pre-v3.11 only touched localStorage so toggling
  // on the dashboard didn't actually stop workers from solving — the
  // operator thought they'd turned it off, yescaptcha spend kept going.
  // localStorage still holds a mirror for first-paint responsiveness.
  const s = { hooks: [], masterOn: localStorage.getItem("captcha_master") !== "0" };

  view.innerHTML = shellHtml(s);
  const masterEl = view.querySelector("#cap-master");

  // Pull server-side master state and sync the checkbox.
  (async () => {
    try {
      const { data } = await F.sbTable("key_value_store")
        .select("value")
        .eq("owner_id", F.ownerId)
        .eq("key", "captcha_master")
        .maybeSingle();
      if (data && data.value != null) {
        s.masterOn = data.value !== false && data.value !== "0";
        masterEl.checked = s.masterOn;
        localStorage.setItem("captcha_master", s.masterOn ? "1" : "0");
      }
    } catch (_e) { /* server-side state optional; keep local */ }
  })();

  masterEl.addEventListener("change", async (e) => {
    s.masterOn = e.target.checked;
    localStorage.setItem("captcha_master", s.masterOn ? "1" : "0");
    try {
      await F.sbTable("key_value_store").upsert({
        owner_id: F.ownerId,
        key:      "captcha_master",
        value:    s.masterOn,
        updated_at: new Date().toISOString(),
      }, { onConflict: "owner_id,key" });
      F.toast(s.masterOn ? "solver on" : "solver off");
    } catch (err) {
      F.toast("saved locally — server write failed: " + (err && err.message || err), "err");
    }
  });
  view.querySelector("#cap-add").addEventListener("click", () => openEdit(null, () => load(s)));

  await load(s);
};

function shellHtml(s) {
  return `
    <h1>Captcha Solver</h1>

    <div class="card">
      <div class="card-h">
        Solver
        <div class="spacer"></div>
        <label class="cap-switch">
          <input type="checkbox" id="cap-master" ${s.masterOn ? "checked" : ""} />
          <span>Master switch</span>
        </label>
        <button class="btn primary" id="cap-add">+ Add webhook</button>
      </div>
      <div class="muted" style="font-size:12px;margin-bottom:10px">
        When an account hits a captcha the worker POSTs this JSON to every enabled webhook,
        then waits for the solver to return a token out of band.
      </div>
      <pre class="cap-payload"><code>${F.esc(EXAMPLE_PAYLOAD)}</code></pre>
    </div>

    <div class="card">
      <div class="card-h">Webhooks<div class="spacer"></div></div>
      <div id="cap-list"><div class="empty">loading…</div></div>
    </div>
  `;
}

async function load(s) {
  const { data, error } = await F.sbTable("captcha_webhooks")
    .select("id,label,url,sends,cooldown_min,custom_field_name,custom_field_value,enabled,created_at")
    .order("created_at");
  if (error) { F.toast(error.message, "err"); return; }
  s.hooks = data || [];
  renderStats(s);
}

async function renderStats(s) {
  const list = document.getElementById("cap-list");
  if (!s.hooks.length) {
    list.innerHTML = `<div class="empty">No webhooks yet. Click Add webhook to make one.</div>`;
    return;
  }

  // Pull last-sent time per webhook, keyed by webhook_id (stable). The old
  // label-based join wiped a webhook's "Last sent" history whenever its label
  // was renamed, and collided between two webhooks sharing the same label.
  const byId = {};
  const ids = s.hooks.map((h) => h.id).filter(Boolean);
  if (ids.length) {
    const { data: evs } = await F.sbTable("captcha_events")
      .select("webhook_id, at")
      .in("webhook_id", ids)
      .order("at", { ascending: false })
      .limit(500);
    (evs || []).forEach((e) => { if (!byId[e.webhook_id]) byId[e.webhook_id] = e.at; });
  }

  list.innerHTML = s.hooks.map((h) => cardHtml(h, byId[h.id])).join("");
  s.hooks.forEach((h) => wireCard(h, s));
}

function cardHtml(h, lastAt) {
  const shortUrl = h.url.length > 48 ? h.url.slice(0, 45) + "…" : h.url;
  return `
    <div class="cap-card" data-id="${F.esc(h.id)}">
      <div class="cap-head">
        <input class="input cap-label" data-k="label" value="${F.esc(h.label)}" placeholder="label" />
        <label class="cap-switch" title="Enabled">
          <input type="checkbox" data-k="enabled" ${h.enabled ? "checked" : ""} />
          <span>Enabled</span>
        </label>
        <div class="spacer" style="flex:1"></div>
        <button class="btn" data-a="save">Save</button>
        <button class="btn danger" data-a="del">Delete</button>
      </div>
      <div class="cap-row">
        <label>URL <input class="input" data-k="url" value="${F.esc(h.url)}" title="${F.esc(h.url)}" /></label>
      </div>
      <div class="cap-row cap-row-3">
        <label>Sends
          <select class="input" data-k="sends">
            ${SENDS_OPTIONS.map(([v, l]) => `<option value="${v}" ${h.sends === v ? "selected" : ""}>${l}</option>`).join("")}
          </select>
        </label>
        <label>Cooldown (min) <input class="input" type="number" min="0" data-k="cooldown_min" value="${Number(h.cooldown_min || 0)}" /></label>
        <label>Last sent <span class="cap-last">${lastAt ? new Date(lastAt).toLocaleString() : "—"}</span></label>
      </div>
      <div class="cap-row cap-row-2">
        <label>Custom field name <input class="input" data-k="custom_field_name" value="${F.esc(h.custom_field_name || "")}" placeholder="e.g. secret" /></label>
        <label>Custom field value <input class="input" data-k="custom_field_value" value="${F.esc(h.custom_field_value || "")}" placeholder="e.g. abcd1234" /></label>
      </div>
      <div class="muted" style="font-size:11px">URL: <code>${F.esc(shortUrl)}</code></div>
    </div>
  `;
}

function wireCard(h, s) {
  const card = document.querySelector(`.cap-card[data-id="${CSS.escape(h.id)}"]`);
  if (!card) return;
  card.querySelector('[data-a="save"]').addEventListener("click", async () => {
    const patch = {};
    card.querySelectorAll("[data-k]").forEach((el) => {
      const k = el.dataset.k;
      if (el.type === "checkbox") patch[k] = el.checked;
      else if (k === "cooldown_min") patch[k] = Number(el.value) || 0;
      else patch[k] = el.value || null;
    });
    const { error } = await F.sbTable("captcha_webhooks").update(patch).eq("id", h.id);
    if (error) return F.toast(error.message, "err");
    F.toast("saved"); load(s);
  });
  card.querySelector('[data-a="del"]').addEventListener("click", async () => {
    if (!(await F.confirm(`Delete webhook "${h.label}"?`))) return;
    const { error } = await F.sbTable("captcha_webhooks").delete().eq("id", h.id);
    if (error) return F.toast(error.message, "err");
    F.toast("deleted"); load(s);
  });
}

// ------------------- add webhook modal -------------------
function openEdit(_unused, refresh) {
  const row = { label: "", url: "", sends: "account_on_device", cooldown_min: 10, custom_field_name: "", custom_field_value: "", enabled: true };
  const body = F.el(`
    <div class="form">
      <label>Label <input class="input" data-k="label" placeholder="e.g. 2captcha main" /></label>
      <label>Webhook URL <input class="input" data-k="url" placeholder="https://your-solver.example/incoming" /></label>
      <div class="form-row">
        <label>Sends
          <select class="input" data-k="sends">
            ${SENDS_OPTIONS.map(([v, l]) => `<option value="${v}" ${row.sends === v ? "selected" : ""}>${l}</option>`).join("")}
          </select>
        </label>
        <label>Cooldown (min) <input class="input" type="number" min="0" data-k="cooldown_min" value="${row.cooldown_min}" /></label>
      </div>
      <div class="form-row">
        <label>Custom field name <input class="input" data-k="custom_field_name" placeholder="optional" /></label>
        <label>Custom field value <input class="input" data-k="custom_field_value" placeholder="optional" /></label>
      </div>
      <label style="flex-direction:row;align-items:center;gap:6px">
        <input type="checkbox" data-k="enabled" checked />
        <span>Enabled</span>
      </label>
    </div>
  `);
  const foot = F.el(`<div style="display:flex;gap:8px;justify-content:flex-end">
    <button class="btn" data-a="cancel">Cancel</button>
    <button class="btn primary" data-a="go">Create</button>
  </div>`);
  const { close } = F.modal({ title: "New captcha webhook", body, footer: foot, width: 520 });

  foot.querySelector('[data-a="cancel"]').addEventListener("click", close);
  foot.querySelector('[data-a="go"]').addEventListener("click", async () => {
    const patch = {};
    body.querySelectorAll("[data-k]").forEach((el) => {
      const k = el.dataset.k;
      if (el.type === "checkbox") patch[k] = el.checked;
      else if (k === "cooldown_min") patch[k] = Number(el.value) || 0;
      else patch[k] = el.value || null;
    });
    if (!patch.label || !patch.url) return F.toast("label + url required", "err");
    const { data: me } = await F.sb.auth.getUser();
    patch.owner_id = me.user.id;
    const { error } = await F.sbTable("captcha_webhooks").insert(patch);
    if (error) return F.toast(error.message, "err");
    F.toast("created"); close(); refresh();
  });
}

})();
