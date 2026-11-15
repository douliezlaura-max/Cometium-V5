(function () {
// Logs page — live log viewer, device + account filter, channel pills.
window.F = window.F || {};
F.pages = F.pages || {};

const CHANNELS = ["info", "warn", "error", "other", "system"];

F.pages.logs = async function (view) {
  const s = {
    device: "", account: "",
    channels: new Set(["info", "warn", "error", "other"]),
    live: true, rows: [],
  };

  view.innerHTML = `
    <h1>Logs</h1>
    <div class="card">
      <div class="card-h">
        <select class="input" id="f-dev" style="max-width:220px"><option value="">— device —</option></select>
        <select class="input" id="f-acc" style="max-width:220px"><option value="">— account —</option></select>
        <div class="log-chans">
          ${CHANNELS.map((c) => `<label class="log-chan" data-c="${c}">
            <input type="checkbox" ${c === "system" ? "" : "checked"} data-c="${c}" /> ${c}
          </label>`).join("")}
        </div>
        <div class="spacer"></div>
        <label><input type="checkbox" id="f-live" checked /> Auto-refresh</label>
        <button class="btn" id="btn-clear">Clear view</button>
      </div>
      <div class="log-view" id="log"><div class="muted" style="padding:20px">select a device or account</div></div>
    </div>
  `;

  const [{ data: devs }, { data: accs }] = await Promise.all([
    F.sbTable("devices").select("id,name").order("name"),
    F.sbTable("accounts").select("id,username").order("username").limit(500),
  ]);
  fill("f-dev", (devs || []).map((d) => [d.id, d.name]));
  fill("f-acc", (accs || []).map((a) => [a.id, a.username]));

  const refresh = F.debounce(() => load(s), 200);
  view.querySelector("#f-dev").addEventListener("change", (e) => { s.device = e.target.value; refresh(); });
  view.querySelector("#f-acc").addEventListener("change", (e) => { s.account = e.target.value; refresh(); });
  view.querySelectorAll(".log-chan input").forEach((cb) =>
    cb.addEventListener("change", (e) => {
      e.target.checked ? s.channels.add(e.target.dataset.c) : s.channels.delete(e.target.dataset.c);
      refresh();
    })
  );
  view.querySelector("#f-live").addEventListener("change", (e) => { s.live = e.target.checked; });
  view.querySelector("#btn-clear").addEventListener("click", () => { s.rows = []; render(s); });

  // Realtime subscription.
  const sub = F.sb.channel("logs")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "logs" }, (p) => {
      if (!s.live) return;
      const r = p.new;
      if (s.device && r.device_id !== s.device) return;
      if (s.account && r.account_id !== s.account) return;
      if (!s.channels.has(r.channel)) return;
      s.rows.push(r);
      if (s.rows.length > 500) s.rows.shift();
      render(s);
    })
    .subscribe();
  window.addEventListener("hashchange", () => F.sb.removeChannel(sub), { once: true });
};

async function load(s) {
  if (!s.device && !s.account) return render(s);
  let q = F.sbTable("logs")
    .select("id, device_id, account_id, channel, text, at")
    .order("at", { ascending: false })
    .limit(300);
  if (s.device)  q = q.eq("device_id", s.device);
  if (s.account) q = q.eq("account_id", s.account);
  if (s.channels.size) q = q.in("channel", [...s.channels]);
  const { data, error } = await q;
  if (error) { F.toast(error.message, "err"); return; }
  s.rows = (data || []).reverse();
  render(s);
}

function render(s) {
  const el = document.getElementById("log");
  if (!s.rows.length) {
    el.innerHTML = `<div class="muted" style="padding:20px">no entries</div>`;
    return;
  }
  el.innerHTML = s.rows.map((r) => {
    // Guard against bad timestamps (year 179382, NaN, missing). The browser
    // happily parses nonsense dates but renders "Invalid Date" or a
    // year-200000 string that breaks row layout.
    const d = new Date(r.at);
    const yr = d.getFullYear();
    const ts = (!r.at || isNaN(d.getTime()) || yr < 2000 || yr > 9999)
      ? "—"
      : d.toLocaleTimeString();
    const badTs = ts === "—";
    return `
    <div class="log-row" data-c="${r.channel}">
      <span class="log-t${badTs ? " muted" : ""}" title="${badTs ? F.esc(String(r.at || "")) : ""}">${ts}</span>
      <span class="log-c log-c-${r.channel}">${r.channel.padEnd(5)}</span>
      <span class="log-m">${F.esc(r.text)}</span>
    </div>
  `;
  }).join("");
  el.scrollTop = el.scrollHeight;
}

function fill(id, pairs) {
  const el = document.getElementById(id); if (!el) return;
  const first = el.querySelector("option");
  el.innerHTML = "";
  if (first) el.append(first);
  pairs.forEach(([v, l]) => {
    const o = document.createElement("option"); o.value = v; o.textContent = l;
    el.append(o);
  });
}

})();
