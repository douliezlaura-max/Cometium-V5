// Supabase client bootstrap.
// Config injected at build time by tools/build.js from .env (SUPABASE_URL + SUPABASE_ANON_KEY).
// In dev the server.js serves /env.js with the same two vars.
window.F = window.F || {};

(function () {
  const url  = (window.ENV && window.ENV.SUPABASE_URL)      || "";
  const anon = (window.ENV && window.ENV.SUPABASE_ANON_KEY) || "";
  if (!url || !anon) {
    console.warn("[farmer] Supabase env missing. Set SUPABASE_URL and SUPABASE_ANON_KEY.");
    F.sb = null;
    return;
  }
  // detectSessionInUrl:true — required so the Supabase client auto-parses the
  // #access_token=... hash fragment after an OAuth provider callback and
  // establishes the session; without it, OAuth sign-in silently does nothing.
  F.sb = supabase.createClient(url, anon, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "implicit" },
  });
})();

F.user = null;

F.requireAuth = async function () {
  if (!F.sb) return null;
  const { data } = await F.sb.auth.getSession();
  F.user = data?.session?.user || null;
  return F.user;
};

F.signIn = async function (email, password) {
  const { data, error } = await F.sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  F.user = data.user;
  // Make sure an owners row exists for this user.
  await F.sb.from("owners").upsert(
    { id: data.user.id, email: data.user.email },
    { onConflict: "id", ignoreDuplicates: true }
  );
  return data.user;
};

F.signUp = async function (email, password) {
  const { data, error } = await F.sb.auth.signUp({ email, password });
  if (error) throw error;
  // Mirror signIn / signInWithCode: materialise an owners row so fn_is_member()
  // returns true the first time this user hits an RLS-protected page. Without
  // it the user is stranded with every list query coming back empty.
  // (If a handle_new_user auth trigger inserts the row server-side this upsert
  // is harmless — onConflict ignores duplicates.)
  if (data.user) {
    await F.sb.from("owners").upsert(
      { id: data.user.id, email: data.user.email },
      { onConflict: "id", ignoreDuplicates: true }
    );
  }
  return data.user;
};

F.signOut = async function () {
  if (F.sb) await F.sb.auth.signOut();
  F.user = null;
  location.hash = "#/overview";
  location.reload();
};

// Login code: a single-use code the admin minted server-side. The code is
// NEVER the account password — the shadow account is provisioned with a long
// random server-side password that the browser never sees. The edge function
// `redeem-login-code` validates the code once and returns a short-lived
// Supabase session which we then adopt via setSession(). The workspace owner
// itself must sign in with a real password + MFA, not a login code.
F.signInWithCode = async function (code) {
  const c = String(code || "").trim().toLowerCase();
  const url = (window.ENV && window.ENV.SUPABASE_URL) || "";
  const anon = (window.ENV && window.ENV.SUPABASE_ANON_KEY) || "";
  const res = await fetch(`${url}/functions/v1/redeem-login-code`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: anon, authorization: `Bearer ${anon}` },
    body: JSON.stringify({ code: c }),
  });
  if (!res.ok) throw new Error("invalid login code");
  const { access_token, refresh_token } = await res.json();
  const { data, error } = await F.sb.auth.setSession({ access_token, refresh_token });
  if (error) throw new Error("invalid login code");
  F.user = data.user;
  await F.sb.from("owners").upsert(
    { id: data.user.id, email: data.user.email },
    { onConflict: "id", ignoreDuplicates: true }
  );
  return data.user;
};

// Discord OAuth. The provider must be enabled in Supabase dashboard
// (Authentication → Providers → Discord). Access is further gated by the
// `allowed_identities` table + the before-insert trigger on auth.users.
F.signInWithDiscord = async function () {
  const { error } = await F.sb.auth.signInWithOAuth({
    provider: "discord",
    options: { redirectTo: location.origin + "/" },
  });
  if (error) throw error;
};
