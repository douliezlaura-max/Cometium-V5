// Shared realtime helper. Thin wrapper over supabase-js v2 Realtime so pages
// don't each reinvent channel bookkeeping, filter string building, status
// gauging or polling fallback. One channel per subscribe() call -- channels
// are cheap and this keeps teardown unambiguous.
//
// Usage:
//   const sub = F.realtime.subscribe('jobs', { owner_id: ownerId },
//     onInsert, onUpdate, onDelete, { onFallback, pollMs: 30000 });
//   ...
//   sub.unsubscribe();
//
// Status: F.realtime.status() returns 'connected' | 'connecting' |
// 'disconnected'. A window event 'farmer:realtime-status' fires on every
// transition; the sidebar indicator listens for it.
window.F = window.F || {};

(function () {
  const RT = {
    _channels: new Set(),
    _status: "disconnected",
    _lastEventAt: 0,
    _watchdogTimer: null,
    _watchdogSilenceMs: 60000,
  };

  function setStatus(next) {
    if (RT._status === next) return;
    RT._status = next;
    try {
      window.dispatchEvent(new CustomEvent("farmer:realtime-status", { detail: next }));
    } catch (e) { /* no-op */ }
  }

  function filterString(filter) {
    if (!filter || typeof filter !== "object") return undefined;
    // supabase-js v2 only accepts a single column=op.value filter per
    // listener (no AND/OR). Pick the first provided key; callers with
    // multiple constraints should filter client-side in the handler.
    const keys = Object.keys(filter);
    if (!keys.length) return undefined;
    const k = keys[0];
    const v = filter[k];
    if (v === null || v === undefined) return undefined;
    // Allow pre-formatted "col=op.val" strings as an escape hatch.
    if (typeof v === "string" && v.includes("=") && v.includes(".")) return v.startsWith(k + "=") ? v : `${k}=${v}`;
    return `${k}=eq.${v}`;
  }

  function startWatchdog() {
    if (RT._watchdogTimer) return;
    RT._watchdogTimer = setInterval(() => {
      if (!RT._channels.size) return;
      const silent = Date.now() - RT._lastEventAt;
      if (RT._status === "connected" && silent > RT._watchdogSilenceMs) {
        // Supabase realtime is known to drop silently on tier-free and on
        // suspended tabs. Flip to 'connecting' so the sidebar dot repaints;
        // the next heartbeat or incoming event will clear it. We don't tear
        // channels down -- supabase-js reconnects them automatically.
        setStatus("connecting");
      }
    }, 15000);
  }

  function stopWatchdogIfIdle() {
    if (RT._channels.size) return;
    if (RT._watchdogTimer) { clearInterval(RT._watchdogTimer); RT._watchdogTimer = null; }
    setStatus("disconnected");
  }

  function noop() {}

  // subscribe(table, filter, onInsert, onUpdate, onDelete, opts?)
  //   table      : string (public.<table>)
  //   filter     : { column: value } | null  (single eq filter, server-side)
  //   onInsert   : (row) => void
  //   onUpdate   : (row, oldRow) => void
  //   onDelete   : (oldRow) => void
  //   opts.onFallback : () => Promise<void> | void -- called on subscribe
  //                     failure AND repeatedly on pollMs while degraded
  //   opts.pollMs     : fallback poll interval (default 30000 ms)
  //
  // Returns { unsubscribe(): void, channel(): RealtimeChannel | null,
  //           status(): 'connected'|'connecting'|'disconnected' }.
  function subscribe(table, filter, onInsert, onUpdate, onDelete, opts) {
    onInsert = onInsert || noop;
    onUpdate = onUpdate || noop;
    onDelete = onDelete || noop;
    opts = opts || {};
    if (!F.sb) {
      // No supabase client -- fall straight to polling.
      const pid = opts.onFallback ? setInterval(() => { try { opts.onFallback(); } catch (e) { /* no-op */ } }, opts.pollMs || 30000) : null;
      return { unsubscribe() { if (pid) clearInterval(pid); }, channel() { return null; }, status() { return "disconnected"; } };
    }

    setStatus("connecting");
    startWatchdog();

    let channel = null;
    let pollTimer = null;
    let torn = false;

    function startPolling() {
      if (pollTimer || !opts.onFallback) return;
      pollTimer = setInterval(() => { try { opts.onFallback(); } catch (e) { /* no-op */ } }, opts.pollMs || 30000);
    }
    function stopPolling() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    const chanName = `rt:${table}:${Math.random().toString(36).slice(2, 10)}`;
    const cfg = { event: "*", schema: "public", table };
    const f = filterString(filter);
    if (f) cfg.filter = f;

    try {
      channel = F.sb.channel(chanName)
        .on("postgres_changes", cfg, (payload) => {
          if (torn) return;
          RT._lastEventAt = Date.now();
          if (RT._status !== "connected") setStatus("connected");
          try {
            if (payload.eventType === "INSERT") onInsert(payload.new);
            else if (payload.eventType === "UPDATE") onUpdate(payload.new, payload.old);
            else if (payload.eventType === "DELETE") onDelete(payload.old);
          } catch (e) { console.error("[realtime handler]", table, e); }
        })
        .subscribe((status, err) => {
          if (torn) return;
          // Supabase emits: SUBSCRIBED | TIMED_OUT | CLOSED | CHANNEL_ERROR
          if (status === "SUBSCRIBED") {
            RT._lastEventAt = Date.now();
            setStatus("connected");
            stopPolling();
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            console.warn("[realtime]", table, status, err || "");
            setStatus("connecting");
            startPolling();
            // Fire one immediate reconcile so stale data isn't stuck until pollMs.
            if (opts.onFallback) { try { opts.onFallback(); } catch (e) { /* no-op */ } }
          } else if (status === "CLOSED") {
            setStatus("connecting");
            startPolling();
          }
        });
      RT._channels.add(channel);
    } catch (e) {
      console.warn("[realtime] subscribe threw; polling only:", e);
      channel = null;
      setStatus("disconnected");
      startPolling();
      if (opts.onFallback) { try { opts.onFallback(); } catch (_) { /* no-op */ } }
    }

    return {
      unsubscribe() {
        if (torn) return;
        torn = true;
        stopPolling();
        if (channel) {
          try { F.sb.removeChannel(channel); } catch (e) { /* no-op */ }
          RT._channels.delete(channel);
          channel = null;
        }
        stopWatchdogIfIdle();
      },
      channel() { return channel; },
      status() { return RT._status; },
    };
  }

  // Convenience: tear down everything (used by the router or on sign-out).
  function teardownAll() {
    for (const ch of [...RT._channels]) {
      try { F.sb && F.sb.removeChannel(ch); } catch (e) { /* no-op */ }
      RT._channels.delete(ch);
    }
    if (RT._watchdogTimer) { clearInterval(RT._watchdogTimer); RT._watchdogTimer = null; }
    setStatus("disconnected");
  }

  F.realtime = {
    subscribe,
    teardownAll,
    status() { return RT._status; },
    _internals: RT, // exposed for tests only
  };
})();
