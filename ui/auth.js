/* ==========================================================================
   auth.js — Google sign-in, and nothing else.

   Firebase's Web SDK is loaded from Google's CDN as ES modules, so there is
   still no npm and no build step. Sign-in happens entirely in the browser;
   the page then sends the resulting ID token to our server with every request,
   and the server checks it with Google before touching any data.

   No guest accounts. No email/password. If the token is not a real Google
   account, nothing loads.
   ========================================================================== */

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAw8zOGiC3q5lFvGIrJDPlNrHTiUl4KbhQ",
  authDomain: "note-ta.firebaseapp.com",
  projectId: "note-ta",
  storageBucket: "note-ta.firebasestorage.app",
  messagingSenderId: "228941563968",
  appId: "1:228941563968:web:ec995d42358e3c6bfef7a5",
};

const SDK = "https://www.gstatic.com/firebasejs/10.12.2";

window.Evie = window.Evie || {};
window.Evie.auth = { user: null, token: "", ready: false, error: "" };

/* Every fetch carries the ID token. Patching fetch once beats remembering to
   add a header in twenty places and forgetting in the twenty-first. */
const rawFetch = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
  const url = typeof input === "string" ? input : (input && input.url) || "";
  if (url.startsWith("/api/") && window.Evie.auth.token) {
    const headers = { ...(init.headers || {}),
                      Authorization: "Bearer " + window.Evie.auth.token };
    // The mail token rides along only on the request that reads mail, so a
    // stray inbox credential is not attached to every call this app makes.
    if (url.startsWith("/api/notifications")) {
      const mt = sessionStorage.getItem("evie.mail");
      if (mt) headers["X-Mail-Token"] = mt;
    }
    init = { ...init, headers };
  }
  return rawFetch(input, init);
};

function gate(state, message) {
  const el = document.getElementById("gate");
  if (!el) return;
  el.className = "";
  el.innerHTML = `
    <div class="gate-card">
      <div class="gate-mark">E</div>
      <h1>Evie</h1>
      <p class="sub">Notes that write themselves while you sit in class.</p>
      ${state === "loading"
        ? '<p class="muted">Checking your sign-in…</p>'
        : `<button class="btn primary gsi" id="gsi">
             <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true">
               <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.8 6.1C12.3 13.2 17.6 9.5 24 9.5z"/>
               <path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-2.8-.4-4.1H24v7.5h12.7c-.3 2.1-1.6 5.3-4.7 7.4l7.2 5.6c4.3-4 6.9-9.9 6.9-16.4z"/>
               <path fill="#FBBC05" d="M10.4 28.7c-.5-1.5-.8-3-.8-4.7s.3-3.2.8-4.7l-7.8-6.1C1 16.3 0 20 0 24s1 7.7 2.6 10.8l7.8-6.1z"/>
               <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.2-5.6c-2 1.4-4.6 2.4-8.7 2.4-6.4 0-11.7-3.7-13.6-9.8l-7.8 6.1C6.5 42.6 14.6 48 24 48z"/>
             </svg>
             Continue with Google
           </button>
           ${message ? `<p class="gate-err">${message}</p>` : ""}
           <p class="muted gate-note">Google sign-in only — there are no guest
             accounts. Your notes are tied to your account.</p>`}
    </div>`;
  const btn = document.getElementById("gsi");
  if (btn) btn.onclick = () => window.Evie.auth.signIn();
}

(async function initAuth() {
  gate("loading");
  let app, auth, mod;
  try {
    const appMod = await import(`${SDK}/firebase-app.js`);
    mod = await import(`${SDK}/firebase-auth.js`);
    app = appMod.initializeApp(FIREBASE_CONFIG);
    auth = mod.getAuth(app);
    await mod.setPersistence(auth, mod.browserLocalPersistence);
  } catch (err) {
    // Offline, or the school firewall blocks gstatic. Say so plainly.
    window.Evie.auth.error = String(err.message || err);
    gate("out", "Could not load Google sign-in — " +
      "check the connection, or that gstatic.com is not blocked here.");
    return;
  }

  const provider = new mod.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });


  /* Connect the school inbox — read-only, and without a password.

     Deliberately a SEPARATE action from signing in. Asking for inbox access at
     sign-in would make everyone hand over mail permission just to take notes.
     This runs only when the student presses the button in Notifications.

     What happens: Google is asked for one extra scope, gmail.readonly. It
     returns a short-lived OAuth access token to this page. The token is held in
     sessionStorage — it dies when the tab closes — and sent to our own server
     on the requests that read mail. No password is involved at any point, and
     the permission can be revoked at myaccount.google.com/permissions.

     The token is NOT written to disk and NOT stored on the server, because a
     long-lived credential to a school inbox is not something this app should
     be holding. It lasts about an hour, then the student reconnects. */
  const MAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

  window.Evie.mail = {
    token: () => sessionStorage.getItem("evie.mail") || "",
    forget: () => sessionStorage.removeItem("evie.mail"),
    connect: async () => {
      /* DANGER, handled here: signInWithPopup does not just fetch a scope, it
         signs the app in as whichever account is chosen. Notes are stored per
         account, so picking a different mailbox would swap the whole identity
         and every note would appear to vanish. That is the "everything resets"
         failure from before, and it must not happen by accident.

         So: pin the popup to the account already signed in, and if Google
         hands back a different one anyway, undo it rather than keep it. */
      const before = auth.currentUser;
      if (!before) {
        return { ok: false, error: "sign in first, then connect mail" };
      }
      const p = new mod.GoogleAuthProvider();
      p.addScope(MAIL_SCOPE);
      p.setCustomParameters({ prompt: "consent", login_hint: before.email || "" });

      let result;
      try {
        result = await mod.signInWithPopup(auth, p);
      } catch (err) {
        const code = (err && err.code) || "";
        if (code === "auth/popup-closed-by-user" ||
            code === "auth/cancelled-popup-request") return { ok: false, cancelled: true };
        if (code === "auth/popup-blocked") {
          return { ok: false, error: "your browser blocked the Google popup — allow popups for this page and try again" };
        }
        return { ok: false, error: (err && err.message) || String(err) };
      }

      if (result.user && result.user.uid !== before.uid) {
        // Wrong account chosen. Get back to the original one immediately —
        // leaving it switched would hide every note the student has made.
        sessionStorage.removeItem("evie.mail");
        try { await mod.signOut(auth); } catch (e) { /* fall through */ }
        return { ok: false, error:
          "that is a different Google account (" + (result.user.email || "") +
          "). Your notes live under " + (before.email || "your school account") +
          ", so I signed out rather than switch you. Sign back in with that " +
          "account. Reading a second mailbox needs a separate connection I " +
          "have not built yet — tell me and I will." };
      }

      const cred = mod.GoogleAuthProvider.credentialFromResult(result);
      const token = cred && cred.accessToken;
      if (!token) {
        return { ok: false, error: "Google did not grant mail access. Make sure you tick the permission it asks for." };
      }
      sessionStorage.setItem("evie.mail", token);
      return { ok: true };
    },
  };

  window.Evie.auth.signIn = async () => {
    try {
      await mod.signInWithPopup(auth, provider);
    } catch (err) {
      const code = err && err.code ? err.code : "";
      if (code === "auth/popup-blocked") {
        // Popups are blocked often enough that a redirect fallback is the
        // difference between "works" and "does nothing when I click it".
        return mod.signInWithRedirect(auth, provider);
      }
      if (code === "auth/popup-closed-by-user" ||
          code === "auth/cancelled-popup-request") return;
      gate("out", `Sign-in failed — ${code || err.message}`);
    }
  };
  window.Evie.auth.signOut = () => mod.signOut(auth);

  try { await mod.getRedirectResult(auth); } catch { /* first load, fine */ }

  mod.onAuthStateChanged(auth, async user => {
    window.Evie.auth.user = user;
    window.Evie.auth.ready = true;
    if (!user) {
      window.Evie.auth.token = "";
      gate("out", "");
      document.getElementById("app")?.classList.add("hide");
      document.getElementById("onboard")?.classList.add("hide");
      return;
    }
    window.Evie.auth.token = await user.getIdToken();
    document.getElementById("gate").className = "hide";

    // Tokens last an hour; refresh well before that so a long lesson never
    // dies mid-recording with a 401.
    setInterval(async () => {
      try { window.Evie.auth.token = await user.getIdToken(true); } catch {}
    }, 30 * 60 * 1000);

    if (typeof boot === "function") boot();
  });
})();
