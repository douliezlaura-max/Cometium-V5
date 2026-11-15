(function () {
// Templates - presets for the jobs.payload jsonb.
// Route: #/templates. Full CRUD (round 5):
//   - list rows owned by auth.uid() (RLS-scoped, realtime-synced across operators)
//   - "+ New Template" at the top opens an F.modal editor
//   - each row has Preview / Edit / Delete / Push to all buttons
//   - Save -> fn_upsert_job_template RPC (insert or update)
//   - Delete -> direct DELETE via supabase-js (RLS enforces ownership)
//   - Preview renders fn_jt_substitute's client-side mirror against an
//     enabled sample account (unchanged from round 4)
//
// Realtime: F.realtime.subscribe('job_templates', {owner_id: F.ownerId}, ...)
// Falls back to a 30 s poll via the shared helper's onFallback.
window.F = window.F || {};
F.pages = F.pages || {};

// Module-level handle so a re-mount drops the previous realtime sub.
let _templatesSub = null;
function teardownTemplates() {
  if (_templatesSub) {
    try { _templatesSub.unsubscribe(); } catch (e) { /* no-op */ }
    _templatesSub = null;
  }
}

// name slug: lowercase ASCII letters/digits/underscore/dash, 1-64 chars.
// Mirrors the regex inside fn_upsert_job_template (v35) so the server
// error path is only reached on a bypassed UI.
const NAME_RE = /^[a-z0-9_\-]{1,64}$/;

F.pages.templates = async function (view) {
  teardownTemplates();

  const s = {
    templates: [],
    accounts:  [],           // {id, username, status}
    selected:  null,         // template id or null (preview panel)
    busy:      false,        // true while a Push-to-all fan-out runs
  };

  view.innerHTML = shellHtml();

  const reloadTemplates = async () => { await loadTemplates(s); render(view, s); };
  const refresh = () => Promise.all([loadTemplates(s), loadAccounts(s)])
                               .then(() => render(view, s));

  view.querySelector("#tpl-refresh").addEventListener("click", refresh);
  view.querySelector("#tpl-new").addEventListener("click",
    () => openEdit(null, s, reloadTemplates));

  await refresh();

  // ---- realtime: job_templates, owner-scoped ----
  // v27 added job_templates to supabase_realtime; this subscribe keeps
  // another operator's edits in sync without a reload. The helper
  // falls back to polling via onFallback when the socket is degraded.
  const ownerFilter = F.ownerId ? { owner_id: F.ownerId } : null;
  _templatesSub = F.realtime.subscribe("job_templates", ownerFilter,
    (row) => {
      // INSERT: splice into the local list (keep name-sorted), repaint.
      const i = s.templates.findIndex((t) => t.id === row.id);
      if (i === -1) s.templates.push(row);
      sortTemplates(s);
      render(view, s);
    },
    (row) => {
      // UPDATE: patch in place; name may have changed so re-sort.
      const i = s.templates.findIndex((t) => t.id === row.id);
      if (i >= 0) s.templates[i] = row; else s.templates.push(row);
      sortTemplates(s);
      render(view, s);
    },
    (oldRow) => {
      // DELETE: drop locally; close the preview if this row was open.
      if (!oldRow) return;
      s.templates = s.templates.filter((t) => t.id !== oldRow.id);
      if (s.selected === oldRow.id) s.selected = null;
      render(view, s);
    },
    { onFallback: () => reloadTemplates(), pollMs: 30000 }
  );

  window.addEventListener("hashchange", teardownTemplates, { once: true });
};

function sortTemplates(s) {
  s.templates.sort((a, b) =>
    String(a.name || "").localeCompare(String(b.name || "")));
}

function shellHtml() {
  return `
    <h1>Job Templates</h1>

    <div class="card">
      <div class="card-h">
        Presets
        <div class="spacer"></div>
        <button class="btn" id="tpl-refresh">Refresh</button>
        <button class="btn primary" id="tpl-new">+ New Template</button>
      </div>
      <div class="muted" style="font-size:12px;margin-bottom:10px">
        A template is a payload preset keyed by name. Pick one, click
        <b>Push to all</b> and every <code>enabled</code> account in
        this workspace gets a <code>join</code> job queued through
        <code>fn_enqueue_from_template</code>. Substitution tokens
        inside a payload are resolved server-side against the target
        account row (so the cookie never crosses the wire).
      </div>
      <table class="tbl">
        <thead>
          <tr>
            <th>Name</th>
            <th>Game</th>
            <th>Place</th>
            <th>Priority</th>
            <th>Tags</th>
            <th>Updated</th>
            <th style="width:360px"></th>
          </tr>
        </thead>
        <tbody id="tpl-body"><tr><td colspan="7" class="empty">loading...</td></tr></tbody>
      </table>
    </div>

    <div id="tpl-detail"></div>
  `;
}

async function loadTemplates(s) {
  const { data, error } = await F.sbTable("job_templates")
    .select("id,name,game_slug,default_place_id,payload_template,default_priority,default_tags,default_max_attempts,updated_at")
    .order("name", { ascending: true })
    .limit(500);
  if (error) { F.toast(error.message, "err"); s.templates = []; return; }
  s.templates = data || [];
}

async function loadAccounts(s) {
  const { data, error } = await F.sbTable("accounts")
    .select("id,username,status,private_server,owner_id,device_id")
    .order("username", { ascending: true })
    .limit(5000);
  if (error) { F.toast(error.message, "err"); s.accounts = []; return; }
  s.accounts = data || [];
}

function render(view, s) {
  const body = view.querySelector("#tpl-body");
  if (!body) return;

  if (!s.templates.length) {
    body.innerHTML = `<tr><td colspan="7" class="empty">no templates. click <b>+ New Template</b> to create one.</td></tr>`;
    paintDetail(view, s);
    return;
  }

  body.innerHTML = s.templates.map((t) => {
    const tags = Array.isArray(t.default_tags) ? t.default_tags : [];
    return `
      <tr data-id="${F.esc(t.id)}">
        <td><code>${F.esc(t.name)}</code></td>
        <td>${F.esc(t.game_slug || "-")}</td>
        <td>${t.default_place_id != null ? F.esc(String(t.default_place_id)) : "-"}</td>
        <td>${F.esc(String(t.default_priority ?? 5))}</td>
        <td>${tags.map((x) => `<span class="pill">${F.esc(x)}</span>`).join(" ") || "-"}</td>
        <td class="muted">${F.esc(fmtAgo(t.updated_at))}</td>
        <td>
          <button class="btn"         data-a="preview"  data-id="${F.esc(t.id)}">Preview</button>
          <button class="btn"         data-a="edit"     data-id="${F.esc(t.id)}">Edit</button>
          <button class="btn danger"  data-a="delete"   data-id="${F.esc(t.id)}">Delete</button>
          <button class="btn primary" data-a="push-all" data-id="${F.esc(t.id)}">Push to all</button>
        </td>
      </tr>
    `;
  }).join("");

  body.querySelectorAll("button[data-a]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      const id = ev.currentTarget.dataset.id;
      const a  = ev.currentTarget.dataset.a;
      const t  = s.templates.find((x) => x.id === id);
      if (!t) return;
      if (a === "preview")  { s.selected = id; paintDetail(view, s); }
      if (a === "edit")     { openEdit(t, s, async () => { await loadTemplates(s); render(view, s); }); }
      if (a === "delete")   { deleteTemplate(view, s, t); }
      if (a === "push-all") { pushAll(view, s, t); }
    });
  });

  paintDetail(view, s);
}

function paintDetail(view, s) {
  const slot = view.querySelector("#tpl-detail");
  if (!slot) return;
  if (!s.selected) { slot.innerHTML = ""; return; }

  const t = s.templates.find((x) => x.id === s.selected);
  if (!t) { slot.innerHTML = ""; return; }

  const sample = s.accounts.find((a) => (a.status || "").toLowerCase() === "enabled")
              || s.accounts[0] || null;

  const tpl = (t.payload_template && typeof t.payload_template === "object") ? t.payload_template : {};
  const resolved = sample ? resolvePayloadClient(t, sample) : null;

  slot.innerHTML = `
    <div class="card">
      <div class="card-h">
        Preview - <code>${F.esc(t.name)}</code>
        <div class="spacer"></div>
        <button class="btn" id="tpl-close">Close</button>
      </div>
      <div class="muted" style="font-size:12px;margin-bottom:8px">
        Tokens left as <code>{{cookie}}</code> below are filled server-side
        at enqueue time; the browser never sees the cookie.
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div>
          <div class="muted" style="font-size:11px;margin-bottom:4px">payload_template</div>
          <pre class="codebox" style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:10px;font-family:var(--mono);font-size:12px;overflow:auto;max-height:420px">${F.esc(JSON.stringify(tpl, null, 2))}</pre>
        </div>
        <div>
          <div class="muted" style="font-size:11px;margin-bottom:4px">
            resolved for <code>${F.esc(sample ? sample.username : "(no account)")}</code>
          </div>
          <pre class="codebox" style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:10px;font-family:var(--mono);font-size:12px;overflow:auto;max-height:420px">${F.esc(resolved ? JSON.stringify(resolved, null, 2) : "(no account to preview against)")}</pre>
        </div>
      </div>

      <div style="margin-top:12px;display:flex;gap:8px;align-items:center">
        <span class="muted" style="font-size:11.5px">
          ${enabledCount(s)} enabled / ${s.accounts.length} total
        </span>
        <div class="spacer"></div>
        <button class="btn primary" id="tpl-push-all">Push to all enabled accounts</button>
      </div>
    </div>
  `;

  slot.querySelector("#tpl-close").addEventListener("click", () => {
    s.selected = null;
    paintDetail(view, s);
  });
  slot.querySelector("#tpl-push-all").addEventListener("click", () => pushAll(view, s, t));
}

function enabledCount(s) {
  return s.accounts.filter((a) => (a.status || "").toLowerCase() === "enabled").length;
}

// ---------------------------------------------------------------------
// Editor modal (create + edit).
//
// On Save: calls fn_upsert_job_template. NULL template id = INSERT,
// non-NULL = UPDATE. Validation mirrors the RPC's server-side guard so
// most errors surface as toasts before the round trip.
// ---------------------------------------------------------------------
function openEdit(row, s, refresh) {
  const isEdit     = !!row;
  const tagsInit   = Array.isArray(row?.default_tags) ? row.default_tags.join(", ") : "";
  const payloadObj = (row?.payload_template && typeof row.payload_template === "object")
                      ? row.payload_template : {};
  const payloadInit = JSON.stringify(payloadObj, null, 2);

  const body = F.el(`
    <div class="form">
      <label>Name
        <input class="input" id="te-name" value="${F.esc(row?.name || "")}"
               placeholder="e.g. adopt_me_daily_spin" maxlength="64"
               spellcheck="false" autocapitalize="off" autocomplete="off" />
      </label>
      <div class="form-row">
        <label>Game slug (optional)
          <input class="input" id="te-game" value="${F.esc(row?.game_slug || "")}"
                 placeholder="e.g. adopt_me"
                 spellcheck="false" autocapitalize="off" autocomplete="off" />
        </label>
        <label>Default place id (optional)
          <input class="input" id="te-place" type="number" step="1" min="0"
                 value="${row?.default_place_id != null ? F.esc(String(row.default_place_id)) : ""}"
                 placeholder="e.g. 920587237" />
        </label>
      </div>
      <div class="form-row">
        <label>Priority (0-10)
          <input class="input" id="te-prio" type="number" min="0" max="10" step="1"
                 value="${F.esc(String(row?.default_priority ?? 5))}" />
        </label>
        <label>Max attempts (&gt; 0)
          <input class="input" id="te-max" type="number" min="1" step="1"
                 value="${F.esc(String(row?.default_max_attempts ?? 3))}" />
        </label>
      </div>
      <label>Tags (comma-separated)
        <input class="input" id="te-tags" value="${F.esc(tagsInit)}"
               placeholder="template, adopt_me"
               spellcheck="false" autocapitalize="off" autocomplete="off" />
      </label>
      <label>payload_template (JSON object)
        <textarea class="input cfg-json" id="te-payload" rows="14"
                  spellcheck="false" autocapitalize="off" autocomplete="off">${F.esc(payloadInit)}</textarea>
      </label>
      <div id="te-json-status" style="font-size:11px;min-height:14px"></div>
      <div class="muted" style="font-size:11px">
        Supported tokens inside string values:
        <code>{{account_id}}</code>, <code>{{account_username}}</code>,
        <code>{{cookie}}</code>, <code>{{private_server}}</code>,
        <code>{{owner_id}}</code>, <code>{{place_id}}</code>,
        <code>{{random_server}}</code>.
      </div>
    </div>
  `);

  const foot = F.el(`<div style="display:flex;gap:8px;justify-content:flex-end">
    <button class="btn" data-a="cancel">Cancel</button>
    <button class="btn primary" data-a="save">${isEdit ? "Save" : "Create"}</button>
  </div>`);

  const { close } = F.modal({
    title: isEdit ? `Edit ${row.name}` : "New template",
    body, footer: foot, width: 720,
  });

  const payloadEl = body.querySelector("#te-payload");
  const statusEl  = body.querySelector("#te-json-status");

  // Validate the JSON textarea on blur. Returns the parsed object on
  // success, or null and paints the status line on failure. We also
  // kick it once at mount so the user sees "JSON ok" right away for
  // existing seed rows.
  const validateJson = () => {
    const raw = payloadEl.value;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        statusEl.textContent = "payload_template must be a JSON object";
        statusEl.style.color = "var(--red)";
        return null;
      }
      statusEl.textContent = "JSON ok";
      statusEl.style.color = "var(--green)";
      return parsed;
    } catch (e) {
      statusEl.textContent = "JSON: " + e.message;
      statusEl.style.color = "var(--red)";
      return null;
    }
  };
  payloadEl.addEventListener("blur", validateJson);
  validateJson();

  foot.querySelector("[data-a='cancel']").addEventListener("click", close);
  foot.querySelector("[data-a='save']").addEventListener("click", async () => {
    // ---- client-side validation ----
    const name = body.querySelector("#te-name").value.trim();
    if (!NAME_RE.test(name)) {
      F.toast("name must be 1-64 chars: lowercase letters, digits, underscore, dash", "err");
      return;
    }

    const game = body.querySelector("#te-game").value.trim() || null;

    const placeRaw = body.querySelector("#te-place").value.trim();
    let placeId = null;
    if (placeRaw.length) {
      const n = Number(placeRaw);
      if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n) {
        F.toast("place id must be a non-negative integer", "err");
        return;
      }
      placeId = n;
    }

    const prio = Number(body.querySelector("#te-prio").value);
    if (!Number.isFinite(prio) || prio < 0 || prio > 10 || Math.floor(prio) !== prio) {
      F.toast("priority must be an integer between 0 and 10", "err");
      return;
    }

    const maxAttempts = Number(body.querySelector("#te-max").value);
    if (!Number.isFinite(maxAttempts) || maxAttempts <= 0 || Math.floor(maxAttempts) !== maxAttempts) {
      F.toast("max attempts must be a positive integer", "err");
      return;
    }

    const tagsArr = body.querySelector("#te-tags").value
      .split(",").map((x) => x.trim()).filter(Boolean);

    const payload = validateJson();
    if (payload == null) {
      F.toast("payload_template is not valid JSON", "err");
      return;
    }

    // ---- RPC ----
    const btn = foot.querySelector("[data-a='save']");
    btn.disabled = true;
    try {
      const { data: newId, error } = await F.sb.rpc("fn_upsert_job_template", {
        p_token:                "",
        p_template_id:          isEdit ? row.id : null,
        p_name:                 name,
        p_game_slug:            game,
        p_default_place_id:     placeId,
        p_payload_template:     payload,
        p_default_priority:     prio,
        p_default_tags:         tagsArr,
        p_default_max_attempts: maxAttempts,
      });
      if (error) {
        F.toast(error.message, "err");
        btn.disabled = false;
        return;
      }
      F.toast(isEdit ? "saved" : "created");
      close();
      if (refresh) await refresh();
    } catch (e) {
      F.toast(e.message || String(e), "err");
      btn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------
// Delete: direct DELETE through supabase-js. RLS on job_templates is
// `for all using (owner_id = auth.uid())` so the server refuses a row
// owned by someone else; no RPC needed. Realtime will fire a DELETE
// event too, but the optimistic local splice keeps the UI snappy in
// case the socket is in fallback mode.
// ---------------------------------------------------------------------
async function deleteTemplate(view, s, t) {
  const ok = await F.confirm(`Delete template "${t.name}"? This cannot be undone.`);
  if (!ok) return;

  const { error } = await F.sbTable("job_templates").delete().eq("id", t.id);
  if (error) { F.toast(error.message, "err"); return; }

  s.templates = s.templates.filter((x) => x.id !== t.id);
  if (s.selected === t.id) s.selected = null;
  render(view, s);
  F.toast("deleted");
}

// ---------------------------------------------------------------------
// Preview substitution: a client-side mirror of fn_jt_substitute. The
// browser pastes this into a <pre> for a human sanity-check only; the
// real substitution runs in Postgres when fn_enqueue_from_template
// fires, which is why {{cookie}} is kept as a literal here.
// ---------------------------------------------------------------------
function resolvePayloadClient(templateRow, accountRow) {
  const vars = {
    account_id:       String(accountRow.id || ""),
    account_username: String(accountRow.username || ""),
    cookie:           "{{cookie}}",                 // never leaks into the browser
    private_server:   String(accountRow.private_server || ""),
    owner_id:         String(accountRow.owner_id || ""),
    place_id:         String(templateRow.default_place_id || ""),
    random_server:    "{{random_server}}",          // server generates each time
  };
  const tpl = (templateRow.payload_template && typeof templateRow.payload_template === "object")
    ? templateRow.payload_template
    : {};
  return walk(tpl, vars);
}

function walk(v, vars) {
  if (v == null) return v;
  if (typeof v === "string") {
    let out = v;
    for (const k of Object.keys(vars)) {
      const needle = "{{" + k + "}}";
      if (out.indexOf(needle) === -1) continue;
      out = out.split(needle).join(vars[k]);
    }
    return out;
  }
  if (Array.isArray(v)) return v.map((x) => walk(x, vars));
  if (typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v)) out[k] = walk(v[k], vars);
    return out;
  }
  return v;
}

async function pushAll(view, s, template) {
  if (s.busy) return;
  const enabled = s.accounts.filter((a) => (a.status || "").toLowerCase() === "enabled");
  if (!enabled.length) { F.toast("no enabled accounts", "err"); return; }

  const ok = await F.confirm(
    `Push "${template.name}" as a join job to ${enabled.length} enabled account${enabled.length === 1 ? "" : "s"}?`
  );
  if (!ok) return;

  s.busy = true;
  const pushBtns = view.querySelectorAll('button[data-a="push-all"], #tpl-push-all');
  pushBtns.forEach((b) => { b.disabled = true; });

  let ok_n = 0, fail_n = 0;
  const failures = [];

  // Fire one RPC per account. The RPC enqueues a single job - we do
  // not have a server-side bulk variant yet, and a Promise.all across
  // hundreds of accounts would stampede the REST endpoint. Serialise
  // with a small batch size to keep the dashboard responsive.
  const BATCH = 8;
  for (let i = 0; i < enabled.length; i += BATCH) {
    const slice = enabled.slice(i, i + BATCH);
    // eslint-disable-next-line no-await-in-loop
    const results = await Promise.all(slice.map((a) =>
      F.sb.rpc("fn_enqueue_from_template", {
        p_token:       "",
        p_template_id: template.id,
        p_account_id:  a.id,
      }).then((r) => ({ a, r }))
    ));
    for (const { a, r } of results) {
      if (r.error) { fail_n++; failures.push(`${a.username}: ${r.error.message}`); }
      else ok_n++;
    }
  }

  pushBtns.forEach((b) => { b.disabled = false; });
  s.busy = false;

  if (fail_n === 0) {
    F.toast(`queued ${ok_n} job${ok_n === 1 ? "" : "s"}`);
  } else {
    F.toast(`queued ${ok_n}, ${fail_n} failed`, "err");
    console.warn("[templates] failures:", failures);
  }
}

function fmtAgo(iso) {
  if (!iso) return "-";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "-";
  const d = Math.max(0, (Date.now() - t) / 1000);
  if (d < 60)       return `${Math.floor(d)}s ago`;
  if (d < 3600)     return `${Math.floor(d / 60)}m ago`;
  if (d < 86400)    return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

})();
