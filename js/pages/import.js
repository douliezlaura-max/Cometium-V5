(function () {
// Bulk cookie import page -- paste a textarea of cookie lines, click Import.
// Uses fn_bulk_insert_accounts under the hood (same RPC the Accounts page's
// Bulk-upload modal uses) so cookies are encrypted server-side by _enc_secret
// before they hit the accounts table. Per-row status so a 400-line paste is
// auditable at a glance.
//
// Line formats accepted (first match wins, blank + '#' lines skipped):
//   1. raw           -> _|WARNING:-DO-NOT-SHARE-...|_<blob>        (username = pending placeholder)
//   2. username:cookie (any token with a ':' that is not a json line)
//   3. json          -> {"cookie":"...","username":"..."}
//
// Duplicate usernames inside the paste are flagged; duplicates against the
// db get merged by the (owner_id, username) upsert in fn_bulk_insert_accounts.
window.F = window.F || {};
F.pages = F.pages || {};

const CHUNK = 25;
const RAW_RE = /^_\|WARNING:-DO-NOT-SHARE-[^|]*\|_[A-Z0-9_\-]+/i;

function pendingName() {
  return `pending_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}
function stripPrefix(v) {
  const m = v.match(/^\.?ROBLOSECURITY=/i);
  return m ? v.slice(m[0].length) : v;
}
function stripQuotes(v) {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}
function cookiePrefix(c) {
  if (!c) return "-";
  const s = String(c);
  return s.length <= 24 ? s : s.slice(0, 20) + "...(" + s.length + "b)";
}

// Returns { username, cookie, pending?, error? } or null (skip the line).
function parseLine(raw) {
  const line = (raw || "").trim();
  if (!line || line.startsWith("#")) return null;

  // 1. JSON
  if (line.startsWith("{") && line.endsWith("}")) {
    let o;
    try { o = JSON.parse(line); }
    catch { return { error: "invalid json" }; }
    const cookie = stripQuotes(stripPrefix(String(o.cookie || "").trim()));
    const username = String(o.username || "").trim();
    if (!cookie) return { error: "json missing cookie" };
    return { username: username || pendingName(), cookie, pending: !username };
  }

  // 2. raw cookie (no delimiters)
  if (RAW_RE.test(line)) {
    return { username: pendingName(), cookie: stripQuotes(stripPrefix(line)), pending: true };
  }
  const prefixStripped = stripQuotes(stripPrefix(line));
  if (RAW_RE.test(prefixStripped)) {
    return { username: pendingName(), cookie: prefixStripped, pending: true };
  }

  // 3. username:cookie
  const colon = line.indexOf(":");
  if (colon > 0) {
    const u = line.slice(0, colon).trim();
    const c = stripQuotes(stripPrefix(line.slice(colon + 1).trim()));
    if (u && c) return { username: u, cookie: c };
  }

  return { error: "unrecognized line format" };
}

F.pages.import = async function (view) {
  view.innerHTML = `
    <h1>Bulk cookie import</h1>
    <div class="card">
      <div class="card-h">Paste cookies <span class="muted" style="margin-left:8px">one per line</span></div>
      <div class="form bulk-wrap">
        <label>
          <textarea class="input bulk-ta" id="imp-txt" rows="14"
            placeholder="_|WARNING:-DO-NOT-SHARE...                                           (bare cookie, username = pending)
username:_|WARNING:...                                               (username + cookie)
{&quot;cookie&quot;:&quot;_|WARNING:...&quot;,&quot;username&quot;:&quot;u&quot;}                (json)"></textarea>
        </label>
        <div class="form-row">
          <label>Folder
            <select class="input" id="imp-folder"><option value="">-</option></select>
          </label>
          <label>Tags (comma-separated)
            <input class="input" id="imp-tags" placeholder="e.g. bulk, fresh" />
          </label>
        </div>
        <div class="muted bulk-help">
          Accepted: <code>_|WARNING:...</code> (raw), <code>username:cookie</code>,
          <code>{"cookie":"...","username":"..."}</code>. Lines starting with <code>#</code>
          or blank are skipped. A bare cookie gets a <code>pending_*</code> username placeholder.
          Cookies are encrypted server-side before storage. Dedupe is by
          <code>(workspace, username)</code>.
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button class="btn" id="imp-preview">Preview</button>
          <button class="btn primary" id="imp-go" disabled>Import</button>
        </div>
      </div>
    </div>

    <div class="card" id="imp-preview-card" style="display:none">
      <div class="card-h">Preview <span class="muted" id="imp-preview-info" style="margin-left:8px"></span></div>
      <div id="imp-preview-body"></div>
    </div>

    <div class="card" id="imp-progress-card" style="display:none">
      <div class="card-h">Import progress</div>
      <div class="bulk-progress" style="display:block">
        <div class="bulk-progress-bar"><div class="bulk-progress-fill" id="imp-fill"></div></div>
        <div class="muted" id="imp-prog-text">0 / 0</div>
      </div>
    </div>

    <div class="card" id="imp-results-card" style="display:none">
      <div class="card-h">Results</div>
      <div id="imp-results-body"></div>
    </div>
  `;

  // Load folders dropdown.
  const folderSel = view.querySelector("#imp-folder");
  try {
    const { data: folders } = await F.sbTable("folders").select("id,name").order("name");
    (folders || []).forEach((f) => {
      const o = document.createElement("option");
      o.value = f.id; o.textContent = f.name;
      folderSel.appendChild(o);
    });
  } catch {}

  const txt = view.querySelector("#imp-txt");
  const previewBtn = view.querySelector("#imp-preview");
  const goBtn = view.querySelector("#imp-go");
  const previewCard = view.querySelector("#imp-preview-card");
  const previewBody = view.querySelector("#imp-preview-body");
  const previewInfo = view.querySelector("#imp-preview-info");
  const progressCard = view.querySelector("#imp-progress-card");
  const fillEl = view.querySelector("#imp-fill");
  const progTextEl = view.querySelector("#imp-prog-text");
  const resultsCard = view.querySelector("#imp-results-card");
  const resultsBody = view.querySelector("#imp-results-body");

  let parsed = [];

  previewBtn.addEventListener("click", () => {
    const text = txt.value || "";
    const lines = text.split(/\r?\n/);
    const seen = new Set();
    parsed = [];
    lines.forEach((raw, idx) => {
      const r = parseLine(raw);
      if (r === null) return;
      r._line = idx + 1;
      if (r.error) { r._status = "error"; parsed.push(r); return; }
      const key = String(r.username).toLowerCase();
      if (seen.has(key)) { r._status = "dupe"; r.error = "duplicate username in paste"; parsed.push(r); return; }
      seen.add(key);
      r._status = r.pending ? "pending" : "ready";
      parsed.push(r);
    });

    if (!parsed.length) {
      previewCard.style.display = "none";
      goBtn.disabled = true;
      return F.toast("nothing to import", "err");
    }

    const okCount = parsed.filter((r) => !r.error).length;
    const errCount = parsed.length - okCount;
    previewInfo.textContent = `${okCount} ready, ${errCount} skipped`;
    previewCard.style.display = "";
    previewBody.innerHTML = `
      <table class="tbl bulk-tbl">
        <thead><tr><th>#</th><th>Username</th><th>Cookie</th><th>Status</th></tr></thead>
        <tbody>${parsed.map((r) => `
          <tr class="bulk-row bulk-row-${r._status}">
            <td class="muted">${r._line}</td>
            <td>${F.esc(r.username || "-")}</td>
            <td class="bulk-cookie">${F.esc(cookiePrefix(r.cookie))}</td>
            <td>${F.esc(r.error ? r.error : (r._status === "pending" ? "pending username" : "ready"))}</td>
          </tr>`).join("")}</tbody>
      </table>
    `;
    goBtn.disabled = okCount === 0;
    resultsCard.style.display = "none";
  });

  goBtn.addEventListener("click", async () => {
    const ready = parsed.filter((r) => !r.error);
    if (!ready.length) return F.toast("nothing to import", "err");

    const folderId = view.querySelector("#imp-folder").value || null;
    const tagsExtra = view.querySelector("#imp-tags").value
      .split(",").map((t) => t.trim()).filter(Boolean);
    const rows = ready.map((r) => ({
      username: r.username,
      cookie: r.cookie,
      folder_id: folderId,
      tags: tagsExtra,
    }));

    goBtn.disabled = true;
    previewBtn.disabled = true;
    progressCard.style.display = "";
    resultsCard.style.display = "none";
    fillEl.style.width = "0%";
    progTextEl.textContent = `0 / ${rows.length}`;

    const total = rows.length;
    const allResults = [];
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      let chunkResults = [];
      try {
        const { data, error } = await F.sb.rpc("fn_bulk_insert_accounts", { p_rows: chunk });
        if (error) throw error;
        chunkResults = Array.isArray(data) ? data : [];
        // Pad missing rows so row-order alignment survives.
        for (let k = chunkResults.length; k < chunk.length; k++) {
          chunkResults.push({ ok: false, username: chunk[k].username, error: "no row returned" });
        }
      } catch (e) {
        chunkResults = chunk.map((row) => ({ ok: false, username: row.username, error: e.message || String(e) }));
      }
      allResults.push(...chunkResults);
      const done = Math.min(total, i + chunk.length);
      fillEl.style.width = `${Math.round((done / total) * 100)}%`;
      progTextEl.textContent = `${done} / ${total}`;
    }

    // Build the per-row status table. We re-align by row index (ready[i]
    // corresponds to allResults[i]) and overlay each ready row's status
    // from the RPC. Parse-errored + dupe rows stay as they were.
    const byIndex = new Map();
    for (let i = 0; i < ready.length; i++) byIndex.set(ready[i]._line, allResults[i]);

    const okRows = allResults.filter((r) => r.ok);
    const insertedCount = okRows.filter((r) => r.inserted).length;
    const updatedCount = okRows.length - insertedCount;
    const failRows = allResults.filter((r) => !r.ok);
    const skippedCount = parsed.filter((r) => r.error).length;

    resultsCard.style.display = "";
    resultsBody.innerHTML = `
      <div class="bulk-summary" style="padding:4px 0 12px">
        <span class="pill bulk-pill-ok">${insertedCount} inserted</span>
        <span class="pill bulk-pill-upd">${updatedCount} updated</span>
        <span class="pill bulk-pill-err">${failRows.length} failed</span>
        ${skippedCount ? `<span class="pill bulk-pill-err">${skippedCount} skipped</span>` : ""}
      </div>
      <table class="tbl bulk-tbl">
        <thead><tr><th>#</th><th>Username</th><th>Cookie</th><th>Status</th></tr></thead>
        <tbody>${parsed.map((r) => {
          const rpc = byIndex.get(r._line);
          let statusClass, statusText;
          if (r.error) { statusClass = "error"; statusText = r.error; }
          else if (!rpc) { statusClass = "error"; statusText = "no rpc result"; }
          else if (!rpc.ok) { statusClass = "error"; statusText = rpc.error || "unknown error"; }
          else if (rpc.inserted) { statusClass = "ready"; statusText = "inserted"; }
          else { statusClass = "pending"; statusText = "updated"; }
          return `
            <tr class="bulk-row bulk-row-${statusClass}">
              <td class="muted">${r._line}</td>
              <td>${F.esc(r.username || "-")}</td>
              <td class="bulk-cookie">${F.esc(cookiePrefix(r.cookie))}</td>
              <td>${F.esc(statusText)}</td>
            </tr>`;
        }).join("")}</tbody>
      </table>
    `;

    if (okRows.length) F.toast(`${okRows.length} account(s) saved`);
    if (failRows.length && !okRows.length) F.toast(`all ${failRows.length} row(s) failed`, "err");

    progressCard.style.display = "none";
    previewBtn.disabled = false;
    goBtn.disabled = false;
  });
};

})();
