(function () {
// Settings page — update channel, API keys, password change.
window.F = window.F || {};
F.pages = F.pages || {};

const ACCESS_TIERS = ["full", "worker", "complete_early_only"];

F.pages.settings = async function (view) {
  const t = (F.i18n && F.i18n.t) ? F.i18n.t : (k) => k;
  view.innerHTML = `
    <h1>${F.esc(t("settings.title"))}</h1>

    <div class="card set-card" id="sec-channel">
      <div class="card-h">
        ${F.esc(t("settings.channel.title"))}
        <div class="spacer"></div>
        <span class="muted small">${F.esc(t("settings.channel.current"))} <span id="ch-current">—</span></span>
      </div>
      <div id="ch-list"><div class="loading">${F.esc(t("common.loading"))}</div></div>
    </div>

    <div class="card set-card" id="sec-allow">
      <div class="card-h">
        ${F.esc(t("settings.allow.title"))}
        <div class="spacer"></div>
        <button class="btn primary" id="btn-add-allow">${F.esc(t("settings.allow.add"))}</button>
      </div>
      <div class="muted small" style="padding:0 14px 8px">
        ${F.esc(t("settings.allow.help"))}
      </div>
      <table class="tbl">
        <thead><tr>
          <th>${F.esc(t("th.provider"))}</th><th>${F.esc(t("th.id"))}</th><th>${F.esc(t("th.note"))}</th><th>${F.esc(t("th.added"))}</th><th style="width:70px"></th>
        </tr></thead>
        <tbody id="allow-rows"><tr><td colspan="5" class="empty">${F.esc(t("common.loading"))}</td></tr></tbody>
      </table>
    </div>

    <div class="card set-card" id="sec-keys">
      <div class="card-h">
        ${F.esc(t("settings.keys.title"))}
        <div class="spacer"></div>
        <button class="btn" id="btn-docs">${F.esc(t("settings.keys.docs"))}</button>
        <button class="btn primary" id="btn-newkey">${F.esc(t("settings.keys.new"))}</button>
      </div>
      <div id="docs-panel" class="docs-panel" style="display:none"></div>
      <table class="tbl">
        <thead><tr>
          <th>${F.esc(t("th.name"))}</th><th>${F.esc(t("th.prefix"))}</th><th>${F.esc(t("th.access"))}</th>
          <th>${F.esc(t("th.created"))}</th><th>Expires</th><th>${F.esc(t("th.last_used"))}</th><th style="width:70px"></th>
        </tr></thead>
        <tbody id="keys-rows"><tr><td colspan="7" class="empty">${F.esc(t("common.loading"))}</td></tr></tbody>
      </table>
    </div>

    <div class="card set-card" id="sec-pw">
      <div class="card-h">${F.esc(t("settings.pw.title"))}</div>
      <div class="form pw-form">
        <label>${F.esc(t("settings.pw.current"))}
          <input class="input" type="password" id="pw-cur" autocomplete="current-password" />
        </label>
        <label>${F.esc(t("settings.pw.new"))}
          <input class="input" type="password" id="pw-new" autocomplete="new-password" />
        </label>
        <label>${F.esc(t("settings.pw.confirm"))}
          <input class="input" type="password" id="pw-new2" autocomplete="new-password" />
        </label>
        <div class="muted small">
          ${F.esc(t("settings.pw.hint"))}
        </div>
        <div style="display:flex;justify-content:flex-end">
          <button class="btn primary" id="btn-pw">${F.esc(t("settings.pw.submit"))}</button>
        </div>
      </div>
    </div>
  `;

  view.querySelector("#btn-newkey").addEventListener("click", () => openKeyModal(loadKeys));
  view.querySelector("#btn-docs").addEventListener("click", toggleDocs);
  view.querySelector("#btn-pw").addEventListener("click", submitPassword);
  view.querySelector("#btn-add-allow").addEventListener("click", () => openAllowModal(loadAllowlist));

  await Promise.all([loadChannels(), loadKeys(), loadAllowlist()]);
};

// --------------------------- allowlist -----------------------------
async function loadAllowlist() {
  const t = (F.i18n && F.i18n.t) ? F.i18n.t : (k) => k;
  const { data, error } = await F.sb.rpc("fn_allowlist_list");
  const tb = document.getElementById("allow-rows");
  if (error) { tb.innerHTML = `<tr><td colspan="5" class="empty">${F.esc(error.message)}</td></tr>`; return; }
  const rows = data || [];
  if (!rows.length) {
    tb.innerHTML = `<tr><td colspan="5" class="empty">${F.esc(t("settings.allow.empty"))}</td></tr>`;
    return;
  }
  tb.innerHTML = rows.map((r) => `
    <tr>
      <td><span class="pill">${F.esc(r.provider)}</span></td>
      <td><code>${F.esc(r.provider_id)}</code></td>
      <td>${F.esc(r.note || "")}</td>
      <td class="muted small">${fmtDate(r.added_at)}</td>
      <td><button class="btn danger" data-del="${r.id}">${F.esc(t("common.revoke"))}</button></td>
    </tr>`).join("");
  tb.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", async (e) => {
      if (!(await F.confirm(t("settings.allow.revoke_confirm")))) return;
      const { error } = await F.sb.rpc("fn_allowlist_remove", { p_id: e.target.dataset.del });
      if (error) return F.toast(error.message, "err");
      F.toast(t("settings.allow.toast.removed")); loadAllowlist();
    })
  );
}

function openAllowModal(refresh) {
  const t = (F.i18n && F.i18n.t) ? F.i18n.t : (k) => k;
  const body = F.el(`<div class="form">
    <label>${F.esc(t("settings.allow.provider"))}
      <select class="input" id="al-prov">
        <option value="discord" selected>discord</option>
        <option value="google">google</option>
        <option value="github">github</option>
        <option value="twitter">twitter</option>
      </select>
    </label>
    <label>${F.esc(t("settings.allow.user_id"))}
      <input class="input" id="al-id" placeholder="${F.esc(t("settings.allow.user_id.placeholder"))}" autocomplete="off" />
    </label>
    <label>${F.esc(t("settings.allow.note"))}
      <input class="input" id="al-note" placeholder="${F.esc(t("settings.allow.note.placeholder"))}" />
    </label>
  </div>`);
  const foot = F.el(`<div style="display:flex;gap:8px;justify-content:flex-end">
    <button class="btn" data-a="close">${F.esc(t("common.close"))}</button>
    <button class="btn primary" data-a="add">${F.esc(t("settings.allow.btn.allow"))}</button>
  </div>`);
  const { close } = F.modal({ title: t("settings.allow.modal.title"), body, footer: foot, width: 500 });
  foot.querySelector("[data-a='close']").addEventListener("click", close);
  foot.querySelector("[data-a='add']").addEventListener("click", async () => {
    const provider    = body.querySelector("#al-prov").value;
    const provider_id = body.querySelector("#al-id").value.trim();
    const note        = body.querySelector("#al-note").value.trim() || null;
    if (!provider_id) return F.toast(t("settings.allow.err.id_required"), "err");
    if (!/^\d{5,25}$/.test(provider_id) && provider === "discord") {
      return F.toast(t("settings.allow.err.discord_fmt"), "err");
    }
    const { error } = await F.sb.rpc("fn_allowlist_add", { p_provider: provider, p_provider_id: provider_id, p_note: note });
    if (error) return F.toast(error.message, "err");
    F.toast(t("settings.allow.toast.allowed"));
    close();
    refresh && refresh();
  });
}

// ------------------------- update channels -------------------------
async function loadChannels() {
  const t = (F.i18n && F.i18n.t) ? F.i18n.t : (k) => k;
  const [{ data: channels }, { data: devs }] = await Promise.all([
    F.sbTable("update_channels").select("id,name,note,is_default").order("name"),
    F.sbTable("devices").select("version_channel"),
  ]);
  const list = channels || [];
  // "Current" = the channel most of this owner's devices use; fall back to the default row.
  const counts = {};
  (devs || []).forEach((d) => { if (d.version_channel) counts[d.version_channel] = (counts[d.version_channel] || 0) + 1; });
  const current =
    Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ||
    list.find((c) => c.is_default)?.name ||
    list[0]?.name || "—";

  document.getElementById("ch-current").textContent = current;

  const el = document.getElementById("ch-list");
  if (!list.length) {
    el.innerHTML = `<div class="empty">${F.esc(t("settings.channel.empty"))}</div>`;
    return;
  }
  el.innerHTML = list.map((c) => {
    const sel = c.name === current;
    return `
      <div class="ch-row" data-sel="${sel}">
        <div class="ch-meta">
          <div class="ch-name">${F.esc(c.name)}${c.is_default ? ` <span class="muted small">${F.esc(t("settings.channel.default"))}</span>` : ""}</div>
          ${c.note ? `<div class="muted small">${F.esc(c.note)}</div>` : ""}
        </div>
        <div class="ch-act">
          ${sel ? `<span class="ch-tag">${F.esc(t("settings.channel.selected"))}</span>`
                : `<button class="btn" data-pick="${F.esc(c.name)}">${F.esc(t("settings.channel.select"))}</button>`}
        </div>
      </div>`;
  }).join("");

  el.querySelectorAll("[data-pick]").forEach((b) =>
    b.addEventListener("click", async (e) => {
      const name = e.target.dataset.pick;
      if (!(await F.confirm(t("settings.channel.confirm", { name: name })))) return;
      const { data, error } = await F.sb.rpc("fn_set_update_channel", { p_channel: name });
      if (error) return F.toast(error.message, "err");
      F.toast(t("settings.channel.switched", { n: data || 0, name: name }));
      loadChannels();
    })
  );
}

// --------------------------- API keys -----------------------------
async function loadKeys() {
  const t = (F.i18n && F.i18n.t) ? F.i18n.t : (k) => k;
  const { data, error } = await F.sbTable("api_keys")
    .select("id,name,prefix,access,created_at,last_used_at,expires_at")
    .order("created_at", { ascending: false });
  const tb = document.getElementById("keys-rows");
  if (error) { tb.innerHTML = `<tr><td colspan="7" class="empty">${F.esc(error.message)}</td></tr>`; return; }
  const rows = data || [];
  if (!rows.length) {
    tb.innerHTML = `<tr><td colspan="7" class="empty">${F.esc(t("settings.keys.empty"))}</td></tr>`;
    return;
  }
  const now = Date.now();
  tb.innerHTML = rows.map((r) => {
    let exp = "<span class=\"muted small\">lifetime</span>";
    if (r.expires_at) {
      const t0 = new Date(r.expires_at).getTime();
      if (t0 < now) exp = "<span class=\"pill\" style=\"background:rgba(255,100,100,.15);color:#ff6b6b\">expired</span>";
      else {
        const hoursLeft = Math.round((t0 - now) / 3_600_000);
        const label = hoursLeft < 24 ? (hoursLeft + "h") : (Math.round(hoursLeft / 24) + "d");
        exp = "<span class=\"muted small\">in " + label + " · " + fmtDate(r.expires_at) + "</span>";
      }
    }
    return `
    <tr>
      <td>${F.esc(r.name)}</td>
      <td><code>${F.esc(r.prefix)}…</code></td>
      <td><span class="pill">${F.esc(r.access)}</span></td>
      <td class="muted small">${fmtDate(r.created_at)}</td>
      <td>${exp}</td>
      <td class="muted small">${r.last_used_at ? fmtDate(r.last_used_at) : F.esc(t("common.never"))}</td>
      <td><button class="btn danger" data-del="${r.id}" data-name="${F.esc(r.name)}">${F.esc(t("common.delete"))}</button></td>
    </tr>`;
  }).join("");

  tb.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", async (e) => {
      const id = e.target.dataset.del, name = e.target.dataset.name;
      if (!(await F.confirm(t("settings.keys.revoke_confirm", { name: name })))) return;
      const { error } = await F.sb.rpc("fn_revoke_api_key", { p_key_id: id });
      if (error) return F.toast(error.message, "err");
      F.toast(t("settings.keys.toast.revoked")); loadKeys();
    })
  );
}

function openKeyModal(refresh) {
  const t = (F.i18n && F.i18n.t) ? F.i18n.t : (k) => k;
  // v3.9 — lifetime picker. "0" is the sentinel for "never expires";
  // everything else is sent to the fn as p_lifetime_hours and clamped
  // server-side. Giving the user a short ladder (24h / 7d / 30d / 90d /
  // lifetime) plus a Custom input covers the common grant shapes.
  const LIFETIMES = [
    { h: 0,      label: "Lifetime (never expires)" },
    { h: 24,     label: "24 hours" },
    { h: 24*7,   label: "7 days" },
    { h: 24*30,  label: "30 days" },
    { h: 24*90,  label: "90 days" },
    { h: -1,     label: "Custom…" },
  ];
  const body = F.el(`<div class="form">
    <label>${F.esc(t("settings.keys.modal.name"))}
      <input class="input" id="kname" placeholder="${F.esc(t("settings.keys.modal.name.placeholder"))}" />
    </label>
    <label>${F.esc(t("settings.keys.modal.access"))}
      <select class="input" id="kaccess">
        ${ACCESS_TIERS.map((a) => `<option value="${a}">${a}</option>`).join("")}
      </select>
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
    <div class="muted small">
      ${F.esc(t("settings.keys.modal.hint"))}
    </div>
    <div id="kout" class="key-out" style="display:none">
      <div class="muted small">${F.esc(t("settings.keys.modal.yourkey"))}</div>
      <code id="ktoken"></code>
      <button class="btn" id="kcopy" style="margin-top:8px">${F.esc(t("settings.keys.modal.copy"))}</button>
    </div>
  </div>`);
  const foot = F.el(`<div style="display:flex;gap:8px;justify-content:flex-end">
    <button class="btn" data-a="close">${F.esc(t("common.close"))}</button>
    <button class="btn primary" data-a="gen">${F.esc(t("settings.keys.new").replace(/^\+\s*/, ""))}</button>
  </div>`);
  const { close } = F.modal({ title: t("settings.keys.modal.title"), body, footer: foot, width: 520 });

  body.querySelector("#klife").addEventListener("change", (e) => {
    body.querySelector("#kcustom-row").style.display = (e.target.value === "-1") ? "" : "none";
  });

  foot.querySelector("[data-a='close']").addEventListener("click", () => { close(); refresh && refresh(); });
  foot.querySelector("[data-a='gen']").addEventListener("click", async () => {
    const name = body.querySelector("#kname").value.trim();
    const access = body.querySelector("#kaccess").value;
    if (!name) return F.toast("name required", "err");
    const lifeSel = Number(body.querySelector("#klife").value);
    let lifetime = lifeSel;
    if (lifeSel === -1) {
      lifetime = Math.floor(Number(body.querySelector("#kcustom").value));
      if (!Number.isFinite(lifetime) || lifetime < 1 || lifetime > 87600) {
        return F.toast("Custom lifetime must be 1 – 87600 hours", "err");
      }
    }
    // 0 → null (lifetime key). >0 → hours.
    const params = { p_name: name, p_access: access };
    if (lifetime > 0) params.p_lifetime_hours = lifetime;
    const { data, error } = await F.sb.rpc("fn_create_api_key", params);
    if (error) return F.toast(error.message, "err");
    body.querySelector("#ktoken").textContent = data;
    body.querySelector("#kout").style.display = "";
    foot.querySelector("[data-a='gen']").disabled = true;
    body.querySelector("#kname").disabled = true;
    body.querySelector("#kaccess").disabled = true;
    body.querySelector("#klife").disabled = true;
    body.querySelector("#kcustom").disabled = true;
    body.querySelector("#kcopy").addEventListener("click", () => copyText(data));
    F.toast(t("settings.keys.toast.created"));
  });
}

function toggleDocs() {
  const el = document.getElementById("docs-panel");
  if (el.style.display === "") { el.style.display = "none"; return; }
  // Fill once.
  if (!el.dataset.filled) {
    el.innerHTML = `
      <div class="docs-sec">
        <div class="docs-h">Authentication headers</div>
        <div class="muted small">Send the raw token (shown once at creation) in either header:</div>
        <pre><code>Authorization: Bearer &lt;token&gt;</code></pre>
        <pre><code>X-Api-Key: &lt;token&gt;</code></pre>
      </div>
      <div class="docs-sec">
        <div class="docs-h">Example — register a worker</div>
        <pre><code>curl -X POST \\
  'https://&lt;project&gt;.supabase.co/rest/v1/rpc/fn_worker_register' \\
  -H 'apikey: &lt;SUPABASE_ANON_KEY&gt;' \\
  -H 'Authorization: Bearer &lt;YOUR_API_KEY&gt;' \\
  -H 'Content-Type: application/json' \\
  -d '{"p_token":"&lt;YOUR_API_KEY&gt;","p_name":"PC-01","p_code_name":"home-01","p_version":"0.1.0"}'</code></pre>
      </div>
      <div class="muted small">Access tiers: <code>full</code> (all RPCs) · <code>worker</code> (worker heartbeat/jobs/logs) · <code>complete_early_only</code> (autoswap completion only).</div>
    `;
    el.dataset.filled = "1";
  }
  el.style.display = "";
}

// ------------------------- password ---------------------------------
async function submitPassword() {
  const t = (F.i18n && F.i18n.t) ? F.i18n.t : (k) => k;
  const cur = document.getElementById("pw-cur").value;
  const neu = document.getElementById("pw-new").value;
  const neu2 = document.getElementById("pw-new2").value;
  // "cur" is intentionally not sent — Supabase's updateUser doesn't verify it.
  void cur;
  if (neu.length < 8) return F.toast(t("settings.pw.err.min"), "err");
  if (neu !== neu2) return F.toast(t("settings.pw.err.mismatch"), "err");
  const btn = document.getElementById("btn-pw");
  btn.disabled = true;
  const { error } = await F.sb.auth.updateUser({ password: neu });
  btn.disabled = false;
  if (error) return F.toast(error.message, "err");
  F.toast(t("settings.pw.toast.updated"));
  document.getElementById("pw-cur").value = "";
  document.getElementById("pw-new").value = "";
  document.getElementById("pw-new2").value = "";
}

// ------------------------- utils ------------------------------------
function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 16).replace("T", " ");
}

function copyText(txt) {
  const t = (F.i18n && F.i18n.t) ? F.i18n.t : (k) => k;
  const done = () => F.toast(t("settings.keys.toast.copied"));
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(txt).then(done, () => fallback());
  } else fallback();
  function fallback() {
    const ta = document.createElement("textarea");
    ta.value = txt; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.append(ta); ta.select();
    try { document.execCommand("copy"); done(); } catch { F.toast(t("settings.keys.toast.copy_failed"), "err"); }
    ta.remove();
  }
}

})();
