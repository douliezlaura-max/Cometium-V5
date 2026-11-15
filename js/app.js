// Bootstrap: gate on auth, render.
// /env.js is already loaded synchronously by index.html before this script, so
// window.ENV is in scope and supabase.js has already built F.sb. Do not re-create
// the client — that produces the "Multiple GoTrueClient instances" warning and
// a second anonymous session that interferes with sign-up.
(async function () {
  if (!F.sb) return mountAuth("Supabase client unavailable — check SUPABASE_URL / SUPABASE_ANON_KEY");
  // Load dictionaries before auth UI so sign-in mounts localized text too.
  if (F.i18n && F.i18n.init) { try { await F.i18n.init(); } catch (e) { /* no-op */ } }
  const user = await F.requireAuth();
  if (!user) return mountAuth();
  document.getElementById("who").textContent = user.email || "owner";
  // Expose the signed-in owner id so page subscriptions can filter by it
  // without re-awaiting getUser() on every mount.
  F.ownerId = user.id;
  mountRealtimeIndicator();
  applyLocaleToSidebar();
  mountLanguageToggle();
  document.addEventListener("locale-changed", () => {
    applyLocaleToSidebar();
    // Re-render the current page so its strings swap too.
    try { F.route(); } catch (e) { /* no-op */ }
  });
  F.route();
})();

// Walk sidebar and swap every known text node to the current locale.
function applyLocaleToSidebar() {
  if (!F.i18n) return;
  const t = F.i18n.t;
  // Nav items: keyed by data-route. The icon lives in .nav-ico, the
  // label is a trailing text node - rebuild the label span.
  const NAV = {
    overview: "nav.overview",
    games:    "nav.games",
    accounts: "nav.accounts",
    folders:  "nav.folders",
    joiners:  "nav.joiners",
    configs:  "nav.configs",
    hubs:     "nav.hubs",
    autoswap: "nav.autoswap",
    devices:  "nav.devices",
    logs:     "nav.logs",
    tools:    "nav.tools",
    captcha:  "nav.captcha",
    metrics:  "nav.metrics",
    settings: "nav.settings",
  };
  document.querySelectorAll(".nav-item").forEach((a) => {
    const route = a.dataset.route;
    const key = NAV[route];
    if (!key) return;
    const ico = a.querySelector(".nav-ico");
    const label = t(key);
    // Preserve icon; replace the rest with a single text node.
    a.innerHTML = "";
    if (ico) a.appendChild(ico);
    a.appendChild(document.createTextNode(" " + label));
  });

  // Nav section separators: by document order they map to accounts/configs/infra.
  const seps = document.querySelectorAll(".nav .nav-sep");
  const SEP_KEYS = ["nav.section.accounts", "nav.section.configs", "nav.section.infra"];
  seps.forEach((s, i) => { if (SEP_KEYS[i]) s.textContent = t(SEP_KEYS[i]); });

  // Realtime status label (only when disconnected/connecting text is visible).
  const rtLbl = document.getElementById("realtime-status-lbl");
  const dot = document.getElementById("realtime-status");
  if (rtLbl && dot) {
    const s = dot.dataset.s || "disconnected";
    rtLbl.textContent = s === "connected"
      ? t("sidebar.realtime.connected")
      : s === "connecting"
        ? t("sidebar.realtime.connecting")
        : t("sidebar.realtime.disconnected");
  }

  // "signed in as" line — the first .muted inside .sidebar-foot that isn't the rt label.
  document.querySelectorAll(".sidebar-foot .muted").forEach((el) => {
    if (el.id === "realtime-status-lbl") return;
    el.textContent = t("sidebar.signed_in_as");
  });
}

function mountLanguageToggle() {
  if (!F.i18n) return;
  const foot = document.querySelector(".sidebar-foot");
  if (!foot || foot.querySelector(".lang-row")) return;
  const row = document.createElement("div");
  row.className = "lang-row";
  row.style.cssText = "display:flex;gap:4px;margin-top:10px;padding-top:8px;border-top:1px dashed var(--border-soft);";
  const cur = F.i18n.getLocale();
  ["en", "fr"].forEach((loc) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = loc.toUpperCase();
    b.dataset.loc = loc;
    b.style.cssText = [
      "flex:1", "padding:4px 0", "font-size:10.5px", "letter-spacing:.08em",
      "cursor:pointer", "border-radius:4px",
      "border:1px solid " + (loc === cur ? "var(--accent)" : "var(--border)"),
      "background:" + (loc === cur ? "color-mix(in oklab, var(--accent) 18%, transparent)" : "transparent"),
      "color:" + (loc === cur ? "var(--accent)" : "var(--fg-muted)"),
    ].join(";");
    b.addEventListener("click", () => {
      F.i18n.setLocale(loc);
      // Repaint toggle buttons.
      row.querySelectorAll("button").forEach((x) => {
        const sel = x.dataset.loc === loc;
        x.style.borderColor = sel ? "var(--accent)" : "var(--border)";
        x.style.background = sel ? "color-mix(in oklab, var(--accent) 18%, transparent)" : "transparent";
        x.style.color = sel ? "var(--accent)" : "var(--fg-muted)";
      });
    });
    row.appendChild(b);
  });
  foot.appendChild(row);
}

function mountRealtimeIndicator() {
  const dot = document.getElementById("realtime-status");
  const lbl = document.getElementById("realtime-status-lbl");
  if (!dot) return;
  const apply = (s) => {
    dot.dataset.s = s;
    dot.title = `realtime: ${s}`;
    if (lbl) {
      const t = (F.i18n && F.i18n.t) ? F.i18n.t : (k) => k;
      lbl.textContent = s === "connected"
        ? t("sidebar.realtime.connected")
        : s === "connecting"
          ? t("sidebar.realtime.connecting")
          : t("sidebar.realtime.disconnected");
    }
  };
  if (F.realtime) apply(F.realtime.status());
  window.addEventListener("farmer:realtime-status", (e) => apply(e.detail));
}

function mountAuth(topError = "") {
  const el = document.createElement("div");
  el.className = "auth";
  el.innerHTML = `
    <div class="auth-box">
      <h2>Cometium</h2>
      <div class="auth-tabs">
        <button class="auth-tab active" data-tab="pwd">Email</button>
        <button class="auth-tab"        data-tab="code">Login code</button>
      </div>

      <div class="auth-pane" data-pane="pwd">
        <input class="input" id="a-email" type="email"    placeholder="email"    autocomplete="email" />
        <input class="input" id="a-pwd"   type="password" placeholder="password" autocomplete="current-password" />
        <div class="auth-row">
          <button class="btn primary" id="a-in">Sign in</button>
          <button class="btn"         id="a-up">Sign up</button>
        </div>
      </div>

      <div class="auth-pane hidden" data-pane="code">
        <input class="input mono" id="a-code" type="text" placeholder="login code" autocomplete="off" autocapitalize="off" spellcheck="false" />
        <div class="auth-row">
          <button class="btn primary" id="a-code-in">Enter</button>
        </div>
        <div class="muted small">provisioned with: <code>node tools/create_login_code.js &lt;code&gt;</code></div>
      </div>

      <div class="auth-sep"><span>or</span></div>
      <button class="btn discord" id="a-discord">
        <span class="discord-logo"><svg viewBox="0 0 71 55" fill="currentColor" aria-hidden="true"><path d="M60.1 4.9A58.6 58.6 0 0 0 45.6.4a40.5 40.5 0 0 0-1.9 3.8 54.1 54.1 0 0 0-16.3 0A40 40 0 0 0 25.5.4a58.4 58.4 0 0 0-14.6 4.5C1.6 18.7-1 32.1.3 45.3a58.9 58.9 0 0 0 17.9 9.1 43.3 43.3 0 0 0 3.8-6.2 37.9 37.9 0 0 1-6-2.9c.5-.4 1-.8 1.5-1.2 11.5 5.3 23.9 5.3 35.2 0 .5.4 1 .8 1.5 1.2a37.9 37.9 0 0 1-6 2.9 43.3 43.3 0 0 0 3.8 6.2 58.9 58.9 0 0 0 18-9.1c1.5-15.3-2.5-28.6-9.9-40.4ZM23.7 37.3c-3.5 0-6.4-3.3-6.4-7.3s2.8-7.3 6.4-7.3c3.6 0 6.5 3.3 6.4 7.3 0 4-2.8 7.3-6.4 7.3Zm23.7 0c-3.5 0-6.4-3.3-6.4-7.3s2.8-7.3 6.4-7.3c3.6 0 6.5 3.3 6.4 7.3 0 4-2.8 7.3-6.4 7.3Z"/></svg></span>
        <span>Continue with Discord</span>
      </button>
      <div class="muted small" style="text-align:center;margin-top:6px">
        allowlisted Discord accounts only
      </div>

      <div class="auth-err" id="a-err">${topError || ""}</div>
    </div>`;
  document.body.appendChild(el);
  const err = el.querySelector("#a-err");

  el.querySelectorAll(".auth-tab").forEach(t => t.addEventListener("click", () => {
    el.querySelectorAll(".auth-tab").forEach(x => x.classList.toggle("active", x === t));
    el.querySelectorAll(".auth-pane").forEach(p => p.classList.toggle("hidden", p.dataset.pane !== t.dataset.tab));
    err.textContent = "";
  }));

  const go = async (fn, ...args) => {
    err.textContent = "";
    try { await fn(...args); location.reload(); }
    catch (e) { err.textContent = (e && e.message) || String(e); }
  };

  el.querySelector("#a-in").addEventListener("click", () => {
    const email = el.querySelector("#a-email").value.trim();
    const pwd   = el.querySelector("#a-pwd").value;
    if (!email || !pwd) { err.textContent = "email and password required"; return; }
    go(F.signIn, email, pwd);
  });
  el.querySelector("#a-up").addEventListener("click", () => {
    const email = el.querySelector("#a-email").value.trim();
    const pwd   = el.querySelector("#a-pwd").value;
    if (!email || !pwd) { err.textContent = "email and password required"; return; }
    if (pwd.length < 6) { err.textContent = "password must be at least 6 chars"; return; }
    go(F.signUp, email, pwd);
  });
  el.querySelector("#a-code-in").addEventListener("click", () => {
    const code = el.querySelector("#a-code").value.trim();
    if (!code) { err.textContent = "login code required"; return; }
    go(F.signInWithCode, code);
  });
  el.querySelector("#a-code").addEventListener("keydown", (e) => {
    if (e.key === "Enter") el.querySelector("#a-code-in").click();
  });
  el.querySelector("#a-discord").addEventListener("click", () => {
    err.textContent = "";
    F.signInWithDiscord().catch((e) => { err.textContent = e.message || String(e); });
  });
}
