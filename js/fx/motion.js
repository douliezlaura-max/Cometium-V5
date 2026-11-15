// Cometium FX — motion system. Fully automatic; page JS needs no changes.
//   - page enter: staggered fade/slide/blur-in on route change (Web Animations API,
//     fill:"backwards" so nothing can ever be left invisible)
//   - first-fill stagger for table rows / card lists that arrive shortly after mount
//   - count-up for stat numbers (.tile-v / .hero-v); final text is exactly the page's
//   - spotlight glow on card-like containers (one shared overlay, no pseudo on cards)
//   - sliding nav indicator in the sidebar
//   - click sparks on buttons, magnetic .btn.primary
// Exposes window.FX = { refresh, setMode, destroy }.
(function () {
  "use strict";
  if (window.FX && window.FX._motion) return;

  var EASE_OUT = "cubic-bezier(.22, 1, .36, 1)";
  var CARD_SEL = ".card, .tile, .metrics-tile, .set-card, .cfg-tile, .cfg-ovc, .folder-card, .dev-card, .jobs-detail, .auth-box, [data-fx-spot]";
  var GROUP_SEL = ".tiles, .tiles-hero, .metrics-grid, .folder-grid, .filter-grid, [class*='-grid'], [class*='tiles'], [data-fx-stagger]";
  var STAT_SEL = ".tile-v, .hero-v, [data-fx-count]";
  var MAX_ITEMS = 20;
  var MAX_ROWS = 20;
  var FIRST_FILL_WINDOW = 6000;

  var mq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  var reduced = !!(mq && mq.matches);
  var finePointer = window.matchMedia ? window.matchMedia("(hover: hover) and (pointer: fine)").matches : true;
  var canAnimate = typeof Element !== "undefined" && typeof Element.prototype.animate === "function";

  var cleanup = [];
  function on(t, ev, fn, opts) { t.addEventListener(ev, fn, opts); cleanup.push(function () { t.removeEventListener(ev, fn, opts); }); }
  var warned = false;
  function warn(where, e) { if (warned) return; warned = true; try { console.warn("[fx] " + where + ":", e); } catch (_) {} }
  function safe(where, fn) { return function () { try { return fn.apply(this, arguments); } catch (e) { warn(where, e); } }; }

  // ======================================================================
  // Page enter + first-fill stagger
  // ======================================================================
  var view = null;
  var viewObserver = null;
  var enteredToken = -1;
  var enteredAt = 0;
  var filled = new WeakSet();
  var running = [];
  var safetyTimer = 0;

  function routeToken() { return (window.F && typeof F._routeToken === "number") ? F._routeToken : 0; }

  function isLoadingOnly(el) {
    var kids = el.children;
    if (!kids.length) return true;
    for (var i = 0; i < kids.length; i++) {
      if (!kids[i].classList.contains("loading")) return false;
    }
    return true;
  }

  function play(el, frames, opts) {
    if (!canAnimate || reduced) return null;
    var a = el.animate(frames, opts);
    running.push(a);
    return a;
  }

  function cancelRunning() {
    for (var i = 0; i < running.length; i++) { try { running[i].cancel(); } catch (e) {} }
    running = [];
  }

  function armSafety() {
    clearTimeout(safetyTimer);
    // Hard stop: whatever happens to the timeline, by now everything is visible.
    safetyTimer = setTimeout(function () {
      for (var i = 0; i < running.length; i++) { try { running[i].finish(); } catch (e) {} }
      running = [];
    }, 3200);
  }

  function enterFrames(blur, dist) {
    var from = { opacity: 0, transform: "translate3d(0," + dist + "px,0) scale(.985)" };
    var to = { opacity: 1, transform: "none" };
    if (blur) { from.filter = "blur(" + blur + "px)"; to.filter = "blur(0px)"; }
    return [from, to];
  }

  function collectItems(root) {
    var items = [];
    var kids = root.children;
    for (var i = 0; i < kids.length && items.length < MAX_ITEMS + 10; i++) {
      var k = kids[i];
      if (k.classList.contains("loading") || k.tagName === "SCRIPT" || k.tagName === "STYLE") continue;
      if (k.offsetParent === null && getComputedStyle(k).position !== "fixed") continue; // display:none
      var n = k.children.length;
      if (n > 1 && n <= 24 && k.matches(GROUP_SEL)) {
        for (var j = 0; j < n; j++) items.push(k.children[j]);
      } else {
        items.push(k);
      }
    }
    return items;
  }

  function rowsOf(container) {
    var out = [];
    var kids = container.children;
    for (var i = 0; i < kids.length; i++) {
      var r = kids[i];
      if (r.tagName === "TR" && r.querySelector("td.empty") && kids.length === 1) return [];
      out.push(r);
    }
    return out;
  }

  function staggerRows(container, baseDelay) {
    var rows = rowsOf(container);
    if (!rows.length) return false;
    var n = Math.min(rows.length, MAX_ROWS);
    for (var i = 0; i < n; i++) {
      play(rows[i], [
        { opacity: 0, transform: "translate3d(0,8px,0)" },
        { opacity: 1, transform: "none" },
      ], { duration: 460, delay: baseDelay + i * 24, easing: EASE_OUT, fill: "backwards" });
    }
    return true;
  }

  function pageEnter() {
    cancelRunning();
    filled = new WeakSet();
    statMemo = new Map();
    enteredAt = performance.now();
    if (reduced || !canAnimate) { scanStats(view, true); return; }
    var items = collectItems(view);
    var delays = new Map();
    for (var i = 0; i < items.length; i++) {
      var el = items[i];
      if (i >= MAX_ITEMS) break;
      var d = 40 + i * 55;
      delays.set(el, d);
      play(el, enterFrames(i < 8 ? 6 : 0, i === 0 ? 10 : 16), {
        duration: 720, delay: d, easing: EASE_OUT, fill: "backwards",
      });
    }
    // rows already present at mount
    var bodies = view.querySelectorAll("tbody");
    for (var b = 0; b < bodies.length && b < 6; b++) {
      var tb = bodies[b];
      var host = null;
      for (var h = 0; h < items.length; h++) if (items[h].contains(tb)) { host = items[h]; break; }
      var base = (host && delays.get(host)) || 120;
      if (staggerRows(tb, base + 160)) filled.add(tb);
    }
    scanStats(view, true);
    armSafety();
  }

  function firstFill(container) {
    if (filled.has(container)) return;
    if (performance.now() - enteredAt > FIRST_FILL_WINDOW) return;
    if (!view.contains(container)) return;
    var isBody = container.tagName === "TBODY" || container.tagName === "TABLE";
    if (container.tagName === "TABLE") container = container.tBodies[0] || container;
    if (!isBody) {
      // only animate lists of card-like children
      var first = container.firstElementChild;
      if (!first || !first.matches(CARD_SEL)) return;
    }
    if (staggerRows(container, 30)) { filled.add(container); armSafety(); }
  }

  // ======================================================================
  // Count-up (React Bits "CountUp")
  // ======================================================================
  var statMemo = new Map();      // key -> last numeric value (per route)
  var ourWrites = new WeakMap();  // text node -> string we last wrote
  var countAnims = new WeakMap(); // stat element -> {raf}

  function parseNum(s) {
    // returns { pre, num, post, dec, group, decSep } or null
    var m = /^([^\d\-]*?)(-?\d[\d.,   ]*\d|-?\d)([\s\S]*)$/.exec(s);
    if (!m) return null;
    var raw = m[2];
    var group = "", decSep = ".", dec = 0, clean;
    var hasDot = raw.indexOf(".") >= 0, hasComma = raw.indexOf(",") >= 0;
    var spaceGroup = /\d[   ]\d{3}/.test(raw);
    if (/[   ]/.test(raw) && !spaceGroup) return null;
    if (spaceGroup) group = (raw.match(/[   ]/) || [" "])[0];
    if (hasDot && hasComma) {
      var lastDot = raw.lastIndexOf("."), lastComma = raw.lastIndexOf(",");
      decSep = lastDot > lastComma ? "." : ",";
      group = decSep === "." ? "," : ".";
    } else if (hasComma) {
      if (/^-?\d{1,3}(,\d{3})+$/.test(raw)) group = ",";
      else if (/^-?\d+,\d+$/.test(raw)) decSep = ",";
      else return null;
    } else if (hasDot) {
      if (/^-?\d+\.\d+$/.test(raw)) decSep = ".";
      else if (/^-?\d{1,3}(\.\d{3})+$/.test(raw)) group = ".";
      else return null;
    }
    clean = raw;
    if (group) clean = clean.split(group).join("");
    var di = clean.indexOf(decSep);
    if (decSep === "," && di >= 0) clean = clean.replace(",", ".");
    if (di >= 0) dec = clean.length - di - 1;
    var num = parseFloat(clean);
    if (!isFinite(num)) return null;
    return { pre: m[1], num: num, post: m[3], dec: dec, group: group, decSep: decSep };
  }

  function fmt(v, p) {
    var neg = v < 0; v = Math.abs(v);
    var s = v.toFixed(p.dec);
    var parts = s.split(".");
    var int = parts[0];
    if (p.group) int = int.replace(/\B(?=(\d{3})+(?!\d))/g, p.group);
    return (neg ? "-" : "") + int + (parts[1] ? p.decSep + parts[1] : "");
  }

  function numberNode(el) {
    var w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = w.nextNode())) if (/\d/.test(n.data)) return n;
    return null;
  }

  function statKey(el) {
    if (el.id) return "#" + el.id;
    var inner = el.querySelector("[id]");
    if (inner) return "#" + inner.id;
    var tile = el.closest(".tile, .metrics-tile, .card, [class*='tile']");
    var k = tile && tile.querySelector(".tile-k, .k, .card-h");
    if (k) return "k:" + k.textContent.trim();
    // positional fallback
    var path = [], node = el;
    while (node && node !== view && path.length < 6) {
      var i = 0, s = node;
      while ((s = s.previousElementSibling)) i++;
      path.push(i);
      node = node.parentElement;
    }
    return "p:" + path.join(".");
  }

  function countUp(el) {
    var node = numberNode(el);
    var key = statKey(el);
    var prevAnim = countAnims.get(el);
    if (!node) { if (prevAnim) cancelAnimationFrame(prevAnim.raf); return; }
    if (ourWrites.get(node) === node.data) return; // our own frame
    var finalText = node.data;
    var p = parseNum(finalText);
    if (!p) return;
    var from = statMemo.has(key) ? statMemo.get(key) : 0;
    if (prevAnim) { cancelAnimationFrame(prevAnim.raf); if (prevAnim.cur != null) from = prevAnim.cur; }
    statMemo.set(key, p.num);
    if (from === p.num || reduced) return;
    var delta = Math.abs(p.num - from);
    var dur = delta < 2 && p.dec === 0 ? 380 : Math.min(1400, 700 + Math.log10(delta + 1) * 160);
    var t0 = performance.now();
    var st = { raf: 0, cur: from };
    countAnims.set(el, st);
    el.classList.add("fx-counting");
    var tick = function (now) {
      var k = Math.min(1, (now - t0) / dur);
      var e = k === 1 ? 1 : 1 - Math.pow(2, -10 * k); // easeOutExpo
      var v = from + (p.num - from) * e;
      st.cur = v;
      var txt = k === 1 ? finalText : p.pre + fmt(v, p) + p.post;
      if (!node.isConnected) { countAnims.delete(el); el.classList.remove("fx-counting"); return; }
      ourWrites.set(node, txt);
      if (node.data !== txt) node.data = txt;
      if (k < 1) st.raf = requestAnimationFrame(tick);
      else { countAnims.delete(el); el.classList.remove("fx-counting"); }
    };
    tick(t0);
  }

  function scanStats(root) {
    if (!root || !root.querySelectorAll) return;
    var list = root.matches && root.matches(STAT_SEL) ? [root] : [];
    var found = root.querySelectorAll(STAT_SEL);
    for (var i = 0; i < found.length; i++) list.push(found[i]);
    for (var j = 0; j < list.length; j++) {
      // a .hero-v inside a .tile-v (or vice versa): only animate the outermost
      var el = list[j];
      var outer = el.parentElement && el.parentElement.closest(STAT_SEL);
      if (outer && view.contains(outer)) el = outer;
      countUp(el);
    }
  }

  // ======================================================================
  // #view observer
  // ======================================================================
  function onViewMutations(records) {
    var mountHit = false;
    var statTargets = new Set();
    var fillTargets = new Set();
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      var t = r.target;
      if (r.type === "childList" && t === view && r.addedNodes.length) mountHit = true;
      var el = t.nodeType === 3 ? t.parentElement : t;
      if (!el) continue;
      var stat = el.closest ? el.closest(STAT_SEL) : null;
      if (stat) statTargets.add(stat);
      if (r.type === "childList" && r.addedNodes.length) {
        for (var j = 0; j < r.addedNodes.length; j++) {
          var n = r.addedNodes[j];
          if (n.nodeType !== 1) continue;
          if (n.matches(STAT_SEL) || n.querySelector(STAT_SEL)) statTargets.add(n);
          if (t !== view) fillTargets.add(t);
          if (n.tagName === "TABLE" || n.tagName === "TBODY") fillTargets.add(n);
        }
      }
    }
    if (mountHit && !isLoadingOnly(view) && routeToken() !== enteredToken) {
      enteredToken = routeToken();
      pageEnter();
      return;
    }
    if (!reduced && canAnimate) fillTargets.forEach(function (c) { if (c.isConnected) firstFill(c); });
    statTargets.forEach(function (s) { if (s.isConnected) scanStats(s); });
  }

  function mountView() {
    view = document.getElementById("view");
    if (!view) return;
    viewObserver = new MutationObserver(safe("view", onViewMutations));
    viewObserver.observe(view, { childList: true, subtree: true, characterData: true });
    cleanup.push(function () { viewObserver.disconnect(); });
    if (!isLoadingOnly(view)) { enteredToken = routeToken(); pageEnter(); }
  }

  // ======================================================================
  // Spotlight (React Bits "SpotlightCard") — one shared overlay
  // ======================================================================
  var spot = null, spotTarget = null, spotRaf = 0, lastX = 0, lastY = 0, lastMove = 0, lastEvTarget = null;

  function ensureSpot() {
    if (spot) return spot;
    spot = document.createElement("div");
    spot.id = "fx-spot";
    spot.setAttribute("aria-hidden", "true");
    document.body.appendChild(spot);
    return spot;
  }

  function pickTarget(t) {
    if (!t || !t.closest) return null;
    if (t.closest(".dropdown, .menu, [role='menu'], [role='listbox'], select, .modal-back, #fx-spot")) return null;
    var c = t.closest(CARD_SEL);
    if (!c) return null;
    // skip giant containers (full-height tables): the glow reads as a flash there
    return c;
  }

  function spotFrame(now) {
    spotRaf = 0;
    var target = pickTarget(lastEvTarget);
    if (target !== spotTarget) {
      spotTarget = target;
      if (target) {
        var cs = getComputedStyle(target);
        spot.style.borderRadius = cs.borderRadius;
        spot.style.zIndex = target.closest(".auth") ? "101" : "";
      }
      spot.classList.toggle("on", !!target);
    }
    if (spotTarget) {
      if (!spotTarget.isConnected) { spotTarget = null; spot.classList.remove("on"); return; }
      var r = spotTarget.getBoundingClientRect();
      spot.style.width = r.width + "px";
      spot.style.height = r.height + "px";
      spot.style.transform = "translate3d(" + r.left + "px," + r.top + "px,0)";
      spot.style.setProperty("--mx", (lastX - r.left) + "px");
      spot.style.setProperty("--my", (lastY - r.top) + "px");
      // keep tracking briefly after the last move (hover lifts / transitions)
      if (now - lastMove < 450) spotRaf = requestAnimationFrame(spotFrame);
    }
  }

  function onPointerMove(e) {
    if (e.pointerType === "touch") return;
    lastX = e.clientX; lastY = e.clientY; lastEvTarget = e.target; lastMove = performance.now();
    if (!spotRaf) spotRaf = requestAnimationFrame(spotFrame);
  }

  function onScroll() {
    if (spotTarget && !spotRaf) { lastMove = performance.now(); spotRaf = requestAnimationFrame(spotFrame); }
  }

  function mountSpotlight() {
    if (!finePointer) return;
    ensureSpot();
    on(document, "pointermove", onPointerMove, { passive: true });
    on(document, "mouseout", function (e) { if (e.relatedTarget) return; lastEvTarget = null; if (!spotRaf) spotRaf = requestAnimationFrame(spotFrame); }, { passive: true });
    on(window, "scroll", onScroll, { passive: true, capture: true });
    cleanup.push(function () { if (spot) spot.remove(); spot = null; });
  }

  // ======================================================================
  // Sliding nav indicator
  // ======================================================================
  var sidebar = null, indicator = null, indRaf = 0, indPlaced = false, navObserver = null, lastActive = null;
  var narrowMq = window.matchMedia ? window.matchMedia("(max-width: 860px)") : null;

  function placeIndicator() {
    indRaf = 0;
    if (!sidebar || !indicator) return;
    var active = sidebar.querySelector(".nav-item.active");
    if (!active || active.offsetParent === null) { indicator.classList.remove("on"); return; }
    var sr = sidebar.getBoundingClientRect();
    var ar = active.getBoundingClientRect();
    var x = ar.left - sr.left + sidebar.scrollLeft - sidebar.clientLeft;
    var y = ar.top - sr.top + sidebar.scrollTop - sidebar.clientTop;
    if (!indPlaced) indicator.classList.add("fx-instant");
    indicator.style.width = ar.width + "px";
    indicator.style.height = ar.height + "px";
    indicator.style.transform = "translate3d(" + x + "px," + y + "px,0)";
    indicator.classList.add("on");
    if (active !== lastActive) {
      lastActive = active;
      // < 860px the nav is a horizontal strip: keep the active item in view
      if (narrowMq && narrowMq.matches && active.scrollIntoView) {
        try { active.scrollIntoView({ inline: "nearest", block: "nearest", behavior: reduced ? "auto" : "smooth" }); } catch (e) {}
      }
    }
    if (!indPlaced) {
      indPlaced = true;
      void indicator.offsetWidth;
      requestAnimationFrame(function () { indicator && indicator.classList.remove("fx-instant"); });
    }
  }
  function queueIndicator() { if (!indRaf) indRaf = requestAnimationFrame(safe("nav", placeIndicator)); }

  function mountNav() {
    sidebar = document.querySelector(".sidebar");
    if (!sidebar || !sidebar.querySelector(".nav-item")) return;
    indicator = document.createElement("div");
    indicator.className = "nav-indicator";
    indicator.setAttribute("aria-hidden", "true");
    sidebar.insertBefore(indicator, sidebar.firstChild);
    sidebar.classList.add("fx-nav-ready");
    navObserver = new MutationObserver(function (recs) {
      for (var i = 0; i < recs.length; i++) if (recs[i].target !== indicator) { queueIndicator(); return; }
    });
    navObserver.observe(sidebar, { attributes: true, attributeFilter: ["class", "open"], subtree: true, childList: true });
    on(window, "hashchange", queueIndicator, false);
    on(window, "resize", queueIndicator, { passive: true });
    on(document, "locale-changed", queueIndicator, false);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(queueIndicator, function () {});
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(queueIndicator);
      ro.observe(sidebar);
      cleanup.push(function () { ro.disconnect(); });
    }
    cleanup.push(function () {
      navObserver.disconnect();
      if (indicator) indicator.remove();
      indicator = null;
      sidebar.classList.remove("fx-nav-ready");
    });
    placeIndicator();
  }

  // ======================================================================
  // Click spark (React Bits "ClickSpark")
  // ======================================================================
  var sparkCanvas = null, sparkCtx = null, sparks = [], sparkRaf = 0;
  var SPARK_COLORS = ["#5ef0d0", "#7fb8ff", "#9a85ff", "#bfeeff"];

  function ensureSparkCanvas() {
    if (sparkCanvas) return;
    sparkCanvas = document.createElement("canvas");
    sparkCanvas.id = "fx-spark";
    sparkCanvas.setAttribute("aria-hidden", "true");
    document.body.appendChild(sparkCanvas);
    sparkCtx = sparkCanvas.getContext("2d");
  }

  function sizeSpark() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.round(window.innerWidth * dpr), h = Math.round(window.innerHeight * dpr);
    if (sparkCanvas.width !== w || sparkCanvas.height !== h) { sparkCanvas.width = w; sparkCanvas.height = h; }
    sparkCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function sparkFrame(now) {
    sparkRaf = 0;
    var ctx = sparkCtx;
    ctx.clearRect(0, 0, sparkCanvas.width, sparkCanvas.height);
    var alive = [];
    for (var i = 0; i < sparks.length; i++) {
      var s = sparks[i];
      var k = (now - s.t0) / s.dur;
      if (k >= 1) continue;
      alive.push(s);
      if (k < 0) continue;
      var e = 1 - Math.pow(1 - k, 3);
      var d0 = 4 + e * s.r;
      var len = s.len * (1 - e);
      ctx.strokeStyle = s.c;
      ctx.globalAlpha = 1 - k * 0.6;
      ctx.lineWidth = 1.6;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(s.x + s.dx * d0, s.y + s.dy * d0);
      ctx.lineTo(s.x + s.dx * (d0 + len), s.y + s.dy * (d0 + len));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    sparks = alive;
    if (sparks.length) sparkRaf = requestAnimationFrame(sparkFrame);
    else sparkCanvas.classList.remove("on");
  }

  function onPointerDown(e) {
    if (reduced || e.button !== 0) return;
    var b = e.target.closest && e.target.closest(".btn, button, .nav-item, .auth-tab, [data-fx-spark]");
    if (!b || b.disabled) return;
    ensureSparkCanvas();
    sizeSpark();
    sparkCanvas.classList.add("on");
    var n = 9, now = performance.now();
    var danger = b.classList.contains("danger");
    for (var i = 0; i < n; i++) {
      var a = (Math.PI * 2 * i) / n + Math.random() * 0.25;
      sparks.push({
        x: e.clientX, y: e.clientY, dx: Math.cos(a), dy: Math.sin(a),
        r: 16 + Math.random() * 8, len: 9 + Math.random() * 4,
        c: danger ? (i % 3 ? "#ff8a5c" : "#ffd0bf") : SPARK_COLORS[i % SPARK_COLORS.length],
        t0: now, dur: 420 + Math.random() * 120,
      });
    }
    if (!sparkRaf) sparkRaf = requestAnimationFrame(sparkFrame);
  }

  function mountSpark() {
    on(document, "pointerdown", safe("spark", onPointerDown), { passive: true, capture: true });
    cleanup.push(function () { if (sparkCanvas) sparkCanvas.remove(); sparkCanvas = null; });
  }

  // ======================================================================
  // Magnetic primary buttons (uses the independent `translate` property so it
  // composes with whatever `transform` the base button styles use)
  // ======================================================================
  var mag = null, magRaf = 0, magX = 0, magY = 0, magTX = 0, magTY = 0;
  function magFrame() {
    magRaf = 0;
    if (!mag) return;
    magX += (magTX - magX) * 0.22;
    magY += (magTY - magY) * 0.22;
    if (Math.abs(magTX - magX) < 0.05 && Math.abs(magTY - magY) < 0.05) { magX = magTX; magY = magTY; }
    mag.style.translate = magX === 0 && magY === 0 ? "" : magX.toFixed(2) + "px " + magY.toFixed(2) + "px";
    if (magX !== magTX || magY !== magTY) magRaf = requestAnimationFrame(magFrame);
    else if (magTX === 0 && magTY === 0) mag = null;
  }
  function onMagMove(e) {
    if (reduced || e.pointerType === "touch") return;
    var b = e.target.closest && e.target.closest(".btn.primary");
    if (b !== mag && mag) { var old = mag; old.style.translate = ""; mag = null; magX = magY = 0; }
    if (!b || b.disabled) { magTX = magTY = 0; return; }
    mag = b;
    var r = b.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    magTX = Math.max(-3, Math.min(3, (e.clientX - cx) * 0.12));
    magTY = Math.max(-2, Math.min(2, (e.clientY - cy) * 0.18));
    if (!magRaf) magRaf = requestAnimationFrame(magFrame);
  }
  function onMagOut(e) {
    if (!mag) return;
    if (e.relatedTarget && mag.contains(e.relatedTarget)) return;
    if (e.target.closest && e.target.closest(".btn.primary") !== mag) return;
    magTX = magTY = 0;
    if (!magRaf) magRaf = requestAnimationFrame(magFrame);
  }
  function mountMagnetic() {
    if (!finePointer || !("translate" in document.documentElement.style)) return;
    on(document, "pointermove", onMagMove, { passive: true });
    on(document, "pointerout", onMagOut, { passive: true });
  }

  // ======================================================================
  // boot / API
  // ======================================================================
  function boot() {
    document.documentElement.classList.add("fx-on");
    if (reduced) document.documentElement.classList.add("fx-reduced");
    if (mq) {
      var fn = function () { reduced = mq.matches; document.documentElement.classList.toggle("fx-reduced", reduced); };
      if (mq.addEventListener) mq.addEventListener("change", fn); else if (mq.addListener) mq.addListener(fn);
    }
    [["view", mountView], ["spotlight", mountSpotlight], ["nav", mountNav], ["spark", mountSpark], ["magnetic", mountMagnetic]]
      .forEach(function (p) { try { p[1](); } catch (e) { warn(p[0], e); } });
  }

  window.FX = {
    _motion: true,
    refresh: function () {
      try { if (window.FXBG) FXBG.refresh(); } catch (e) { warn("refresh", e); }
      queueIndicator();
      if (view && !isLoadingOnly(view)) { enteredToken = routeToken(); pageEnter(); }
    },
    setMode: function (m) { if (window.FXBG) FXBG.setMode(m); },
    destroy: function () {
      cancelRunning();
      clearTimeout(safetyTimer);
      cleanup.forEach(function (f) { try { f(); } catch (e) {} });
      cleanup = [];
      try { if (window.FXBG) FXBG.destroy(); } catch (e) {}
      document.documentElement.classList.remove("fx-on", "fx-reduced");
      delete window.FX;
    },
  };

  try {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", safe("boot", boot));
    else boot();
  } catch (e) { warn("boot", e); }
})();
