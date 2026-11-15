// i18n module. Keys live in /i18n/<locale>.json, loaded once at boot.
// Current locale persists in localStorage. Changes fire a 'locale-changed'
// CustomEvent on document so pages re-render without reloading.
window.F = window.F || {};

(function () {
  var LS_KEY = "farmerv5_locale";
  var DEFAULT = "en";
  var SUPPORTED = ["en", "fr"];

  var state = {
    locale: DEFAULT,
    dicts: { en: {}, fr: {} },
    ready: false,
  };

  function readStored() {
    try {
      var v = localStorage.getItem(LS_KEY);
      if (v && SUPPORTED.indexOf(v) !== -1) return v;
    } catch (e) { /* no-op */ }
    return DEFAULT;
  }

  function fmt(str, params) {
    if (!params) return str;
    return String(str).replace(/\{(\w+)\}/g, function (m, k) {
      return params[k] == null ? m : String(params[k]);
    });
  }

  function t(key, params) {
    var d = state.dicts[state.locale] || {};
    var v = d[key];
    if (v == null) {
      // Fallback to English.
      v = (state.dicts.en || {})[key];
    }
    if (v == null) return key;
    return fmt(v, params);
  }

  function getLocale() { return state.locale; }

  function setLocale(locale) {
    if (SUPPORTED.indexOf(locale) === -1) return false;
    if (state.locale === locale) return true;
    state.locale = locale;
    try { localStorage.setItem(LS_KEY, locale); } catch (e) { /* no-op */ }
    try { document.documentElement.setAttribute("lang", locale); } catch (e) { /* no-op */ }
    try {
      document.dispatchEvent(new CustomEvent("locale-changed", { detail: { locale: locale } }));
    } catch (e) { /* no-op */ }
    return true;
  }

  async function loadDict(locale) {
    try {
      var r = await fetch("/i18n/" + locale + ".json", { cache: "no-cache" });
      if (!r.ok) return {};
      return await r.json();
    } catch (e) {
      // Fall back to a relative path in case /i18n isn't served from root.
      try {
        var r2 = await fetch("i18n/" + locale + ".json", { cache: "no-cache" });
        if (!r2.ok) return {};
        return await r2.json();
      } catch (e2) { return {}; }
    }
  }

  async function init() {
    state.locale = readStored();
    try { document.documentElement.setAttribute("lang", state.locale); } catch (e) { /* no-op */ }
    var results = await Promise.all(SUPPORTED.map(loadDict));
    for (var i = 0; i < SUPPORTED.length; i++) {
      state.dicts[SUPPORTED[i]] = results[i] || {};
    }
    state.ready = true;
    return state;
  }

  F.i18n = {
    t: t,
    setLocale: setLocale,
    getLocale: getLocale,
    init: init,
    supported: SUPPORTED.slice(),
    _dicts: state.dicts, // expose for debug / dynamic edits
    isReady: function () { return state.ready; },
  };
})();
