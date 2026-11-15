// Shared UI helpers: modal, toast, confirm, escape, dropdown.
window.F = window.F || {};

F.esc = function (s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
};

F.el = function (html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstChild;
};

// ------- modal -------
F.modal = function ({ title, body, footer, width = 520 }) {
  const back = F.el(`
    <div class="modal-back">
      <div class="modal" style="width:${width}px">
        <div class="modal-h">${F.esc(title || "")}<span class="modal-x">×</span></div>
        <div class="modal-b"></div>
        <div class="modal-f"></div>
      </div>
    </div>`);
  back.querySelector(".modal-b").append(body);
  if (footer) back.querySelector(".modal-f").append(footer);
  else back.querySelector(".modal-f").remove();
  const close = () => back.remove();
  back.addEventListener("click", (e) => { if (e.target === back) close(); });
  back.querySelector(".modal-x").addEventListener("click", close);
  document.body.append(back);
  return { el: back, close };
};

// ------- toast -------
F.toast = function (msg, kind = "info") {
  let wrap = document.getElementById("toast-wrap");
  if (!wrap) {
    wrap = F.el('<div id="toast-wrap"></div>');
    document.body.append(wrap);
  }
  const t = F.el(`<div class="toast toast-${kind}">${F.esc(msg)}</div>`);
  wrap.append(t);
  setTimeout(() => { t.classList.add("fade"); setTimeout(() => t.remove(), 300); }, 2200);
};

// ------- confirm -------
F.confirm = function (msg) {
  return new Promise((resolve) => {
    const body = F.el(`<div style="padding:4px 4px 10px">${F.esc(msg)}</div>`);
    const foot = F.el(`<div style="display:flex;gap:8px;justify-content:flex-end">
      <button class="btn" data-a="n">Cancel</button>
      <button class="btn danger" data-a="y">Confirm</button>
    </div>`);
    const { close } = F.modal({ title: "Confirm", body, footer: foot, width: 400 });
    foot.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => { close(); resolve(b.dataset.a === "y"); })
    );
  });
};

// ------- query helpers -------
F.sbTable = function (name) {
  if (!F.sb) throw new Error("Supabase not configured");
  return F.sb.from(name);
};

F.debounce = function (fn, ms = 200) {
  let t; return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); };
};
