(function () {
// The real pages live in their own files; this one only owns the 404 fallback.
window.F = window.F || {};
F.pages = F.pages || {};

// Historical alias removed: #/captcha is now the per-account solve dashboard
// (js/pages/captcha.js). The webhook config page still lives at
// #/captcha-settings — reach it by typing the hash directly.

F.pages._404 = async (view) => {
  view.innerHTML = `<h1>404</h1><div class="empty">no such page, dipshit</div>`;
};

})();
