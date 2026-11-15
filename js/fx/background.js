// Cometium FX — animated background ("ion trail").
// One fixed WebGL canvas (#fx-bg) behind the glass shell.
//   app  mode: calm aurora ribbons near the top + faint star dust (30fps, low res)
//   auth mode: galaxy starfield zoom + comet streaks + stronger aurora, mouse parallax
// Mode follows the DOM automatically (.auth on <body> => auth). Falls back to CSS
// gradients (class fx-bg--fallback) when WebGL is unavailable.
// Exposes window.FXBG = { refresh, setMode, destroy, state }.
(function () {
  "use strict";
  if (window.FXBG) return;

  var VERT =
    "attribute vec2 a_pos;" +
    "void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); }";

  var FRAG = [
    "#ifdef GL_FRAGMENT_PRECISION_HIGH",
    "precision highp float;",
    "#else",
    "precision mediump float;",
    "#endif",
    "uniform vec2  u_res;",
    "uniform float u_time;",
    "uniform float u_auth;",   // 0 = app, 1 = auth (cross-fades)
    "uniform vec2  u_mouse;",  // smoothed, -1..1
    "const vec3 BG    = vec3(0.024, 0.027, 0.043);",
    "const vec3 ION   = vec3(0.369, 0.941, 0.816);",
    "const vec3 SKY   = vec3(0.498, 0.722, 1.000);",
    "const vec3 NOVA  = vec3(0.604, 0.522, 1.000);",
    "const vec3 FLARE = vec3(1.000, 0.541, 0.361);",
    "float hash21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }",
    "float noise(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);",
    "  float a = hash21(i), b = hash21(i+vec2(1.0,0.0)), c = hash21(i+vec2(0.0,1.0)), d = hash21(i+vec2(1.0,1.0));",
    "  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y); }",
    "float fbm(vec2 p){ float v = 0.0, a = 0.5; for(int i=0;i<3;i++){ v += a*noise(p); p = p*2.03 + 17.1; a *= 0.5; } return v; }",
    "vec3 brand(float k){ k = clamp(k, 0.0, 1.0); return mix(mix(ION, SKY, smoothstep(0.0, 0.5, k)), NOVA, smoothstep(0.5, 1.0, k)); }",
    "vec2 rot(vec2 p, float a){ float c = cos(a), s = sin(a); return mat2(c, -s, s, c)*p; }",

    // Aurora: a few ribbons with a bright lower edge and ray curtains rising above it.
    "vec3 aurora(vec2 uv, float aspect, float t, float yBase, float spread){",
    "  vec3 col = vec3(0.0);",
    "  for(int i=0;i<3;i++){",
    "    float fi = float(i);",
    "    float x = uv.x;",
    "    float wave = sin(x*1.25 + t*0.11 + fi*2.1)*0.055 + sin(x*2.9 - t*0.075 + fi*1.3)*0.025;",
    "    float n = fbm(vec2(x*0.85 + fi*3.7, t*0.035 + fi*1.9));",
    "    float yc = yBase - fi*spread + wave + (n-0.5)*0.14;",
    "    float dy = uv.y - yc;",
    "    float core = exp(-dy*dy*900.0);",
    "    float rays = noise(vec2(x*16.0 + fi*11.0 + n*3.0, t*0.12 + fi));",
    "    rays = 0.35 + 0.65*rays*rays;",
    "    float curtain = (dy > 0.0 ? exp(-dy*7.0) : exp(dy*55.0)) * rays;",
    "    float k = fract(x/aspect*0.75 + fi*0.21 + t*0.012);",
    "    k = abs(k*2.0 - 1.0);",
    "    float lane = 0.55 + 0.45*sin(x*0.7 + t*0.05 + fi*2.4);",
    "    col += brand(k) * (core*0.55 + curtain*0.75) * lane * (1.0 - fi*0.22);",
    "  }",
    "  return col;",
    "}",

    // Galaxy star layer (one cell lookup; glow clipped inside the cell).
    "vec3 starLayer(vec2 p, float seed, float t){",
    "  vec2 id = floor(p); vec2 gv = fract(p) - 0.5;",
    "  float h = hash21(id + seed*31.7);",
    "  if(h < 0.55) return vec3(0.0);",
    "  vec2 off = vec2(h, fract(h*34.71)) - 0.5;",
    "  vec2 d2 = gv - off*0.6;",
    "  float d = length(d2);",
    "  float size = fract(h*345.32);",
    "  float m = 0.018*size / max(d, 0.002);",
    "  float rays = max(0.0, 1.0 - abs(d2.x*d2.y*900.0));",
    "  m += rays*0.25*smoothstep(0.85, 1.0, size);",
    "  m *= smoothstep(0.45, 0.12, d);",
    "  float tw = 0.65 + 0.35*sin(t*(1.5 + size*2.0) + h*60.0);",
    "  vec3 c = mix(vec3(1.0), brand(fract(h*7.31)), 0.55);",
    "  return c * m * tw;",
    "}",

    // Comets: bright head + tapered tail, a few staggered, fade in/out.
    "vec3 comets(vec2 uv, float aspect, float t){",
    "  vec3 col = vec3(0.0);",
    "  for(int k=0;k<3;k++){",
    "    float fk = float(k);",
    "    float period = 7.0 + fk*3.3;",
    "    float ph = t + fk*3.1;",
    "    float cyc = floor(ph/period);",
    "    float tt = ph - cyc*period;",
    "    float life = 2.4 + fk*0.4;",
    "    if(tt < life){",
    "      float r = hash21(vec2(cyc, fk + 3.0));",
    "      vec2 dir = normalize(vec2(-1.0, -0.28 - r*0.35));",
    "      vec2 start = vec2(aspect*(0.45 + r*0.65), 1.08 + r*0.15);",
    "      float p = tt/life;",
    "      vec2 head = start + dir*p*(aspect*1.25);",
    "      vec2 rel = uv - head;",
    "      float along = dot(rel, -dir);",
    "      float perp = dot(rel, vec2(-dir.y, dir.x));",
    "      float tailLen = 0.42;",
    "      float w = 0.0014 + max(along, 0.0)*0.012;",
    "      float tail = step(0.0, along) * pow(max(1.0 - along/tailLen, 0.0), 2.2) * exp(-perp*perp/(w*w));",
    "      float glow = 0.00012 / (dot(rel, rel) + 0.00012);",
    "      float fade = sin(3.14159*p);",
    "      vec3 tint = k == 2 ? mix(FLARE, vec3(1.0), 0.35) : mix(ION, vec3(1.0), 0.4);",
    "      col += tint * (tail*0.9 + glow*1.2) * fade;",
    "    }",
    "  }",
    "  return col;",
    "}",

    "void main(){",
    "  vec2 frag = gl_FragCoord.xy;",
    "  float aspect = u_res.x / u_res.y;",
    "  vec2 uv = frag / u_res.y;",                // x: 0..aspect, y: 0..1 (up)
    "  float t = u_time;",
    "  float A = u_auth;",
    "  vec3 col = BG;",
    // soft ambient glows (both modes)
    "  vec2 q = frag / u_res;",
    "  col += ION  * 0.035 * smoothstep(0.9, 0.0, length((q - vec2(0.08, 1.05))*vec2(1.0, 1.4)));",
    "  col += NOVA * 0.040 * smoothstep(1.0, 0.0, length((q - vec2(1.02, 0.85))*vec2(1.0, 1.3)));",
    // ---- app: calm aurora high up + faint dust ----
    "  if(A < 0.999){",
    "    vec2 auv = uv + vec2(u_mouse.x*0.025, 0.0);",
    "    vec3 a = aurora(auv, aspect, t, 0.90, 0.055);",
    "    float topMask = smoothstep(0.35, 1.0, q.y);",
    "    vec3 app = a * 0.2 * topMask;",
    "    vec2 cell = floor(frag / 7.0);",
    "    vec2 f = fract(frag / 7.0) * 7.0;",
    "    float dh = hash21(cell);",
    "    vec2 sp = vec2(hash21(cell + 3.1), hash21(cell + 7.7)) * 5.0 + 1.0;",
    "    float dust = step(0.985, dh) * smoothstep(1.2, 0.0, length(f - sp)) * (0.45 + 0.55*sin(t*0.6 + dh*500.0));",
    "    app += vec3(0.75, 0.82, 1.0) * dust * 0.3;",
    "    col += app * (1.0 - A);",
    "  }",
    // ---- auth: galaxy + comets + bright aurora ----
    "  if(A > 0.001){",
    "    vec2 c = (frag - 0.5*u_res) / u_res.y;",
    "    vec3 g = vec3(0.0);",
    "    vec2 cr = rot(c, t*0.012);",
    "    for(int i=0;i<4;i++){",
    "      float fi = float(i)/4.0;",
    "      float depth = fract(fi + t*0.018);",
    "      float scale = mix(22.0, 1.2, depth);",
    "      float fade = depth * smoothstep(1.0, 0.82, depth);",
    "      vec2 sp = cr*scale + fi*453.2 - u_mouse*depth*1.6;",
    "      g += starLayer(sp, fi*7.0 + 1.0, t) * fade;",
    "    }",
    "    vec2 nuv = c*1.4 + u_mouse*0.06;",
    "    float neb = fbm(nuv*1.6 + vec2(t*0.012, -t*0.008));",
    "    float neb2 = fbm(nuv*2.3 - vec2(t*0.01, 0.0) + 5.0);",
    "    vec3 nebula = mix(NOVA, ION, neb2) * pow(neb, 2.6) * 0.42;",
    "    nebula *= smoothstep(1.25, 0.1, length(c*vec2(0.8, 1.2)));",
    "    vec2 auv = uv + vec2(u_mouse.x*0.06, u_mouse.y*0.02);",
    "    vec3 au = aurora(auv, aspect, t*1.4, 0.80, 0.07) * 0.42 * smoothstep(0.2, 0.95, q.y);",
    "    vec3 cm = comets(uv + u_mouse*0.03, aspect, t);",
    "    float vig = smoothstep(1.4, 0.35, length(c));",
    "    col += (g + nebula + au + cm) * A * mix(0.6, 1.0, vig);",
    "  }",
    // dithering against banding
    "  col += (hash21(frag + fract(t)*91.0) - 0.5) / 255.0;",
    "  gl_FragColor = vec4(col, 1.0);",
    "}",
  ].join("\n");

  var state = {
    canvas: null, gl: null, prog: null, buf: null, uni: {},
    raf: 0, running: false, failed: false, lost: false,
    mode: "app", forced: null, authMix: 0,
    time: 8.0, last: 0, frameSkip: 0,
    mouse: [0, 0], mouseT: [0, 0],
    w: 0, h: 0, scale: 1,
    reduced: false, observer: null, listeners: [],
  };
  var mqReduced = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  state.reduced = !!(mqReduced && mqReduced.matches);

  function on(target, ev, fn, opts) {
    target.addEventListener(ev, fn, opts);
    state.listeners.push([target, ev, fn, opts]);
  }

  // ---------- GL setup ----------
  function compile(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      var log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error("shader: " + log);
    }
    return s;
  }

  function initGL() {
    var c = state.canvas;
    var gl = null;
    var attrs = { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: "low-power" };
    try { gl = c.getContext("webgl", attrs) || c.getContext("experimental-webgl", attrs); } catch (e) { gl = null; }
    if (!gl) throw new Error("webgl unavailable");
    var vs = compile(gl, gl.VERTEX_SHADER, VERT);
    var fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    var p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs);
    gl.bindAttribLocation(p, 0, "a_pos");
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error("link: " + gl.getProgramInfoLog(p));
    gl.useProgram(p);
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    state.gl = gl; state.prog = p; state.buf = buf;
    state.uni = {
      res: gl.getUniformLocation(p, "u_res"),
      time: gl.getUniformLocation(p, "u_time"),
      auth: gl.getUniformLocation(p, "u_auth"),
      mouse: gl.getUniformLocation(p, "u_mouse"),
    };
    state.w = state.h = 0; // force resize
  }

  function fallback(reason) {
    if (state.failed) return;
    state.failed = true;
    stop();
    if (state.canvas) state.canvas.classList.add("fx-bg--fallback");
    document.documentElement.classList.add("fx-no-webgl");
    try { console.info("[fx] background fallback:", reason && reason.message ? reason.message : reason); } catch (e) {}
  }

  // ---------- sizing ----------
  function targetScale() {
    var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    // aurora is soft; the starfield wants a bit more resolution
    var k = state.authMix > 0.5 ? 0.75 : 0.5;
    var area = window.innerWidth * window.innerHeight;
    if (area > 2560 * 1440) k *= 0.8;
    return dpr * k;
  }

  function resize() {
    if (!state.gl) return;
    var s = targetScale();
    var w = Math.max(1, Math.round(window.innerWidth * s));
    var h = Math.max(1, Math.round(window.innerHeight * s));
    if (w === state.w && h === state.h) return;
    state.w = w; state.h = h; state.scale = s;
    state.canvas.width = w; state.canvas.height = h;
    state.gl.viewport(0, 0, w, h);
  }

  // ---------- render ----------
  function draw() {
    var gl = state.gl;
    if (!gl || state.lost) return;
    resize();
    gl.uniform2f(state.uni.res, state.w, state.h);
    gl.uniform1f(state.uni.time, state.time);
    gl.uniform1f(state.uni.auth, state.authMix);
    gl.uniform2f(state.uni.mouse, state.mouse[0], state.mouse[1]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function frame(now) {
    state.raf = 0;
    if (!state.running) return;
    state.raf = requestAnimationFrame(frame);
    var dt = state.last ? Math.min((now - state.last) / 1000, 0.1) : 0.016;
    state.last = now;
    // ease the mode cross-fade + mouse parallax
    var target = state.mode === "auth" ? 1 : 0;
    var prevMix = state.authMix;
    state.authMix += (target - state.authMix) * Math.min(1, dt * 2.2);
    if (Math.abs(target - state.authMix) < 0.002) state.authMix = target;
    var mk = Math.min(1, dt * 2.5);
    state.mouse[0] += (state.mouseT[0] - state.mouse[0]) * mk;
    state.mouse[1] += (state.mouseT[1] - state.mouse[1]) * mk;
    state.time += dt;
    // app shell is slow and quiet: 30fps is plenty and halves the GPU cost
    var transitioning = state.authMix !== prevMix;
    if (state.authMix < 0.01 && !transitioning) {
      state.frameSkip ^= 1;
      if (state.frameSkip) return;
    }
    draw();
  }

  function start() {
    if (state.failed || state.lost || !state.gl) return;
    if (state.reduced) { state.authMix = state.mode === "auth" ? 1 : 0; draw(); return; }
    if (document.hidden) return;
    if (state.running) return;
    state.running = true;
    state.last = 0;
    state.raf = requestAnimationFrame(frame);
  }

  function stop() {
    state.running = false;
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = 0;
  }

  // ---------- mode detection ----------
  function detectMode() {
    if (state.forced) return state.forced;
    return document.querySelector("body > .auth") ? "auth" : "app";
  }

  function place() {
    var c = state.canvas;
    if (!c) return;
    var auth = document.querySelector("body > .auth");
    // The sign-in overlay is an opaque fixed layer (z-index 100); live inside it
    // with z-index:-1 so the stars paint above its background but under the box.
    var host = auth || document.body;
    if (c.parentNode !== host) host.insertBefore(c, host.firstChild);
    c.classList.toggle("fx-bg--in-auth", !!auth);
    document.documentElement.classList.toggle("fx-mode-auth", state.mode === "auth");
  }

  function sync() {
    var m = detectMode();
    var changed = m !== state.mode;
    state.mode = m;
    place();
    if (state.reduced) { state.authMix = m === "auth" ? 1 : 0; state.w = 0; draw(); }
    else if (changed) state.w = 0; // re-pick internal resolution
    return changed;
  }

  // ---------- events ----------
  function onPointer(e) {
    if (e.pointerType === "touch") return;
    state.mouseT[0] = (e.clientX / window.innerWidth) * 2 - 1;
    state.mouseT[1] = -((e.clientY / window.innerHeight) * 2 - 1);
  }

  var resizeQueued = 0;
  function onResize() {
    if (resizeQueued) return;
    resizeQueued = requestAnimationFrame(function () {
      resizeQueued = 0;
      state.w = 0;
      if (!state.running) draw();
    });
  }

  function onVisibility() {
    if (document.hidden) stop(); else start();
  }

  function onLost(e) {
    e.preventDefault();
    state.lost = true;
    stop();
  }

  function onRestored() {
    state.lost = false;
    try { initGL(); sync(); start(); } catch (err) { fallback(err); }
  }

  function boot() {
    var c = document.getElementById("fx-bg");
    if (!c) {
      c = document.createElement("canvas");
      c.id = "fx-bg";
      c.setAttribute("aria-hidden", "true");
    }
    state.canvas = c;
    state.mode = detectMode();
    place();
    on(c, "webglcontextlost", onLost, false);
    on(c, "webglcontextrestored", onRestored, false);
    on(window, "pointermove", onPointer, { passive: true });
    on(window, "resize", onResize, { passive: true });
    on(document, "visibilitychange", onVisibility, false);
    if (mqReduced) {
      var mqFn = function () { state.reduced = mqReduced.matches; if (state.reduced) { stop(); draw(); } else start(); };
      if (mqReduced.addEventListener) mqReduced.addEventListener("change", mqFn);
      else if (mqReduced.addListener) mqReduced.addListener(mqFn);
    }
    state.observer = new MutationObserver(function () { sync(); });
    state.observer.observe(document.body, { childList: true });
    try {
      initGL();
      state.authMix = state.mode === "auth" ? 1 : 0;
      draw();
      c.classList.add("fx-bg--ready");
      start();
    } catch (err) {
      fallback(err);
    }
  }

  window.FXBG = {
    state: state,
    refresh: function () {
      state.forced = null;
      sync();
      state.w = 0;
      if (state.failed) return;
      if (state.running) return;
      draw(); start();
    },
    setMode: function (m) {
      if (m !== "app" && m !== "auth") return;
      state.forced = m;
      sync();
      if (!state.running) draw();
    },
    destroy: function () {
      stop();
      if (state.observer) state.observer.disconnect();
      state.listeners.forEach(function (l) { l[0].removeEventListener(l[1], l[2], l[3]); });
      state.listeners = [];
      try {
        var ext = state.gl && state.gl.getExtension("WEBGL_lose_context");
        if (ext) ext.loseContext();
      } catch (e) {}
      state.gl = null;
      if (state.canvas && state.canvas.parentNode) state.canvas.parentNode.removeChild(state.canvas);
      document.documentElement.classList.remove("fx-mode-auth", "fx-no-webgl");
      delete window.FXBG;
    },
  };

  try {
    if (document.body) boot();
    else document.addEventListener("DOMContentLoaded", function () { try { boot(); } catch (e) { console.warn("[fx] background:", e); } });
  } catch (e) {
    try { console.warn("[fx] background:", e); } catch (_) {}
  }
})();
