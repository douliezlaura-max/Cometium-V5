// Hash router. Pages register themselves as F.pages[name] = async function (view) { ... }.
window.F = window.F || {};
F.pages = F.pages || {};

F._routeToken = 0;

F.route = function () {
  const myToken = ++F._routeToken;
  const hash = location.hash || "#/overview";
  const name = hash.replace(/^#\//, "").split("/")[0] || "overview";
  const page = F.pages[name] || F.pages._404;
  document.querySelectorAll(".nav-item").forEach((a) => {
    a.classList.toggle("active", a.dataset.route === name);
  });
  const view = document.getElementById("view");
  view.innerHTML = '<div class="loading">loading…</div>';
  Promise.resolve(page(view)).catch((err) => {
    // If the user navigated away while this page was still loading (its DB
    // await outran the click), the error is for a stale route — ignore it so a
    // late rejection can't clobber the page the user is actually on.
    if (myToken !== F._routeToken) return;
    console.error(err);
    view.innerHTML = `<div class="empty">page error: ${String(err?.message || err)}</div>`;
  });
};

window.addEventListener("hashchange", () => F.route());
