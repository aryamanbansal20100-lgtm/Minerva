/* ==========================================================================
   firebase.ts — the single place the Firebase app exists.

   Sign-in happens entirely in the browser. The page then sends the resulting
   ID token to our own Python server with every request, and that server checks
   it with Google before touching any data. No guest accounts, no
   email/password: if the token is not a real Google account, nothing loads.

   The config values below are public client identifiers, not secrets, and they
   stay hard-coded on purpose. The Python server verifies tokens independently
   using FIREBASE_API_KEY from its own .env; putting the same values behind
   import.meta.env here would only add a way for the two halves to drift apart
   and start rejecting each other's tokens.
   ========================================================================== */

import { initializeApp } from "firebase/app";
import {
  browserLocalPersistence,
  getAuth,
  getRedirectResult,
  GoogleAuthProvider,
  setPersistence,
} from "firebase/auth";
import type { Auth } from "firebase/auth";

/* projectId must match the server's FIREBASE_PROJECT, and apiKey is the same
   Web API key the server holds as FIREBASE_API_KEY — a token minted by this
   config is the only kind identitytoolkit accounts:lookup will accept.
   Six keys, no measurementId, no Analytics. */
const FIREBASE_CONFIG = Object.freeze({
  apiKey: "AIzaSyAw8zOGiC3q5lFvGIrJDPlNrHTiUl4KbhQ",
  authDomain: "note-ta.firebaseapp.com",
  projectId: "note-ta",
  storageBucket: "note-ta.firebasestorage.app",
  messagingSenderId: "228941563968",
  appId: "1:228941563968:web:ec995d42358e3c6bfef7a5",
});

export const auth: Auth = getAuth(initializeApp(FIREBASE_CONFIG));

/* Built once and reused. "select_account" so a student on a shared laptop is
   always shown the chooser rather than being dropped into whoever was last. */
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

/* Read-only inbox access, requested separately from sign-in — see connectMail
   in auth.tsx for why the two must never be merged. */
export const MAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

/* The mail token, stored WITH its expiry.

   It used to live in sessionStorage, which dies the instant the tab closes — so
   every time the student reopened Evie they had to reconnect, which reads as
   "it keeps expiring." Now it lives in localStorage alongside the moment it
   stops being valid, so:

     - it survives a reload and a tab close (the common case), and
     - it still SELF-EXPIRES: once Google's ~1-hour token is past its time,
       readMailToken returns "" and the UI cleanly offers "reconnect" instead
       of firing a dead token at the server and showing a confusing error.

   It is still never sent to our database and is revocable any time at
   myaccount.google.com/permissions — the privacy stance is intact; only the
   nagging is gone. */
export const MAIL_STORAGE_KEY = "evie.mail";

// Google access tokens last 3600s; treat as good for 55 min to leave a margin.
const MAIL_TTL_MS = 55 * 60 * 1000;

type StoredMail = { token: string; exp: number };

function readStored(): StoredMail | null {
  try {
    const raw = localStorage.getItem(MAIL_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredMail;
    if (!parsed || typeof parsed.token !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** The school-mail access token, or "" if there is none or it has expired. */
export function readMailToken(): string {
  const stored = readStored();
  if (!stored) return "";
  if (Date.now() >= stored.exp) {
    clearMailToken();
    return "";
  }
  return stored.token;
}

/** Milliseconds until the current token expires, or 0 if none/expired. */
export function mailTokenTtl(): number {
  const stored = readStored();
  if (!stored) return 0;
  return Math.max(0, stored.exp - Date.now());
}

export function writeMailToken(token: string): void {
  try {
    localStorage.setItem(
      MAIL_STORAGE_KEY,
      JSON.stringify({ token, exp: Date.now() + MAIL_TTL_MS }),
    );
  } catch {
    /* Without storage the connection simply will not persist; not fatal. */
  }
}

export function clearMailToken(): void {
  try {
    localStorage.removeItem(MAIL_STORAGE_KEY);
    // Clean up the old sessionStorage key from before this change.
    sessionStorage.removeItem(MAIL_STORAGE_KEY);
  } catch {
    /* Nothing to clear if storage was never available. */
  }
}

/* Firebase throws FirebaseError, which is a plain object shape as far as a
   catch block is concerned. These two narrow it without reaching for `any`. */

/** The `auth/...` code on a Firebase error, or "" for anything else. */
export function authErrorCode(err: unknown): string {
  if (typeof err === "object" && err !== null && "code" in err) {
    return String((err as { code: unknown }).code || "");
  }
  return "";
}

/** A human-readable message for any thrown value. */
export function authErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as { message: unknown }).message || "");
  }
  return String(err);
}

/* --------------------------------------------------------------------------
   Initialisation.

   Order matters and is not interchangeable:
     1. persistence is set BEFORE any sign-in call and before the auth-state
        listener is attached. browserLocalPersistence (IndexedDB) survives the
        tab closing and the browser restarting, which is what keeps a student
        signed in between lessons.
     2. getRedirectResult runs so a popup-blocked sign-in that fell back to a
        full-page redirect can finish. On a normal first load it resolves to
        null or throws; neither is an error condition, so it is swallowed.

   The old CDN build could fail here entirely when a school firewall blocked
   gstatic.com. Bundled through Vite that particular failure is gone, but the
   student still needs to be told something rather than stare at a dead button,
   so this resolves to an error string instead of throwing.
   -------------------------------------------------------------------------- */

let initPromise: Promise<string> | null = null;

async function runInit(): Promise<string> {
  try {
    await setPersistence(auth, browserLocalPersistence);
  } catch (err: unknown) {
    const detail = authErrorMessage(err);
    return (
      "Could not start Google sign-in — check the connection, then reload " +
      "this page." + (detail ? ` (${detail})` : "")
    );
  }
  try {
    await getRedirectResult(auth);
  } catch {
    /* First load with nothing pending. Fine. */
  }
  return "";
}

/**
 * Prepare auth. Resolves to "" on success or to a sentence for the gate.
 * Memoised, so React's StrictMode double-mount runs it exactly once.
 */
export function initAuth(): Promise<string> {
  if (!initPromise) initPromise = runInit();
  return initPromise;
}
