/* ==========================================================================
   api.ts — the only thing in this app that calls fetch.

   The old build monkey-patched window.fetch so it could not forget the auth
   header. This does the same job honestly: every request goes through here, so
   there is one place that knows about the ID token, the mail token, retries
   and error copy.

   Paths stay relative. Vite proxies /api to the Python server on :7400, which
   is the only thing this app ever talks to — no Groq, no Gemini, no API key
   anywhere in the browser.
   ========================================================================== */

import { auth, readMailToken } from "./firebase";

/* The ID token lives here rather than in React state on purpose. It refreshes
   every 30 minutes, and putting it in a context value would re-render the
   whole tree each time and force it into the dependency array of every
   consumer, for a value none of them actually read. */
let idToken = "";

/** Called by the auth provider whenever the signed-in identity changes. */
export function setIdToken(token: string): void {
  idToken = token;
}

/** The current Firebase ID token, or "" when signed out. */
export function currentIdToken(): string {
  return idToken;
}

/** Shown when the connection dropped rather than the server refusing. */
export const CONNECTION_LOST =
  "lost the connection to Minerva. Nothing was lost — check it is still " +
  "running, then try again.";

/** Shown when even a forced token refresh could not satisfy the server. */
export const SIGN_IN_EXPIRED = "your sign-in expired — sign in again";

const RETRY_PAUSE_MS = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function headersFor(
  path: string,
  extra?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (idToken && path.startsWith("/api/")) {
    headers.Authorization = `Bearer ${idToken}`;
  }
  /* The mail credential rides only on the request that reads mail, so a stray
     inbox token is not attached to every call the app makes. */
  if (path.startsWith("/api/notifications")) {
    const mailToken = readMailToken();
    if (mailToken) headers["X-Mail-Token"] = mailToken;
  }
  return headers;
}

/** Force-mint a fresh ID token. Returns false when there is nobody signed in.

    Exported as `forceRefreshToken` below, because the automatic path only fires
    when OUR server answers 401 — and the failure that actually bit was Firestore
    answering 401 deep inside a request, where the browser never sees it and so
    never refreshes. Anything that makes the server talk to Firestore on our
    behalf should mint a fresh token first. */
async function refreshIdToken(): Promise<boolean> {
  const user = auth.currentUser;
  if (!user) return false;
  try {
    idToken = await user.getIdToken(true);
    return true;
  } catch {
    return false;
  }
}

/* The server puts a human sentence in { "error": ... }; that is what the toast
   should show, not "500". */
async function serverError(response: Response, path: string): Promise<Error> {
  let message = `${path} → ${response.status}`;
  try {
    const body = (await response.json()) as { error?: unknown };
    if (body && typeof body.error === "string" && body.error) {
      message = body.error;
    }
  } catch {
    /* Not JSON — keep the status line. */
  }
  return new Error(message);
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

/**
 * One request, with the headers attached and a single retry on 401.
 *
 * The 30-minute refresh timer covers a long lesson, but a laptop that slept
 * through lunch wakes with a dead token and no timer tick to fix it. One
 * forced refresh here turns that from a logout into a hiccup.
 */
/* Where the API lives.

   Running locally, the Python server serves this app AND the API from the same
   origin, so a bare "/api/..." is correct and nothing needs configuring.

   Hosted, the two are split: the static app can sit on Netlify, but the Python
   backend — a long-running process with SQLite and the API keys — cannot, so it
   is hosted separately. Set VITE_API_BASE at build time to point at it, e.g.
   VITE_API_BASE=https://minerva-api.onrender.com  */
const CONFIGURED_API = (import.meta.env.VITE_API_BASE || "").replace(/\/$/, "");

/* Decided at RUNTIME, not at build time, so one build works everywhere.

   Three places this same bundle runs, and each needs a different answer:

     localhost          the Python server serves both -> relative "/api/..."
     the API's own host  same -> relative, never a pointless round trip
     Netlify             the app is static here and the API is elsewhere ->
                         absolute, so calls reach the Python service

   Baking the choice in at build time meant the file that worked on Netlify
   broke on the laptop, and vice versa. */
function resolveApiBase(): string {
  if (!CONFIGURED_API) return "";
  if (typeof window === "undefined") return "";
  const { hostname, origin } = window.location;
  const local = hostname === "localhost" || hostname === "127.0.0.1";
  if (local) return "";                       // served by the Python process
  if (origin === CONFIGURED_API) return "";   // we ARE the API host
  return CONFIGURED_API;                      // static host: call out to the API
}

const API_BASE = resolveApiBase();

/* The origin that serves the Python backend — "" when it is the same origin the
   app is served from. Share links point at this, because the public /s/<token>
   pages and /share-open.js are served ONLY by the Python server, never by a
   static host like Netlify. */
export function apiBase(): string {
  return API_BASE;
}

function apiUrl(path: string): string {
  return API_BASE && path.startsWith("/api/") ? API_BASE + path : path;
}

async function send(
  path: string,
  init: RequestInit,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  const url = apiUrl(path);
  // Cookies are not used for auth (the Firebase ID token is), but a
  // cross-origin API still needs CORS to be enabled on the server side.
  let response = await fetch(url, {
    ...init,
    headers: headersFor(path, extraHeaders),
  });
  if (response.status === 401 && (await refreshIdToken())) {
    response = await fetch(url, {
      ...init,
      headers: headersFor(path, extraHeaders),
    });
  }
  if (response.status === 401) throw new Error(SIGN_IN_EXPIRED);
  return response;
}

/* A dropped connection is the only failure worth retrying. A real error from
   the server will fail again the same way, and note-writing takes 30-60
   seconds — repeating that for nothing is expensive. */
function isDroppedConnection(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /failed to fetch|network|load failed/i.test(message);
}

/** GET a JSON endpoint. */
export async function apiGet<T>(path: string): Promise<T> {
  let response: Response;
  try {
    response = await send(path, { method: "GET" });
  } catch (err: unknown) {
    if (isDroppedConnection(err)) throw new Error(CONNECTION_LOST);
    throw err;
  }
  if (!response.ok) throw await serverError(response, path);
  return readJson<T>(response);
}

/**
 * POST JSON, with exactly one silent retry when the connection dropped.
 *
 * Writing a note takes 30-60 seconds. Anything that interrupts the connection
 * in that window — the server restarting, wifi dropping as you walk out of
 * class, the laptop sleeping — used to surface as the browser's raw "Failed to
 * fetch", which tells a student nothing and reads like their work was lost.
 * Saving is idempotent on the server, which is what makes the retry safe and
 * what makes "Nothing was lost" a true statement.
 */
export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return attemptPost<T>(
    path,
    body === undefined ? "{}" : JSON.stringify(body),
    { "Content-Type": "application/json" },
  );
}

/**
 * POST a raw body — used by /api/record/chunk, which sends audio bytes with
 * X-Recording / X-Note / X-Chunk / X-Filename and no JSON content type. It
 * still needs the Authorization header, and it wants the retry even more than
 * the JSON path does: a chunk lost mid-lesson is audio nobody gets back.
 */
export async function apiPostRaw<T>(
  path: string,
  body: BodyInit,
  headers: Record<string, string>,
): Promise<T> {
  return attemptPost<T>(path, body, headers);
}

async function attemptPost<T>(
  path: string,
  body: BodyInit,
  headers: Record<string, string>,
): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await send(path, { method: "POST", body }, headers);
      if (!response.ok) throw await serverError(response, path);
      return await readJson<T>(response);
    } catch (err: unknown) {
      lastError = err;
      if (!isDroppedConnection(err)) throw err;
      if (attempt === 0) await sleep(RETRY_PAUSE_MS);
    }
  }
  throw isDroppedConnection(lastError)
    ? new Error(CONNECTION_LOST)
    : new Error(lastError instanceof Error ? lastError.message : String(lastError));
}

/**
 * GET raw bytes — /api/document?id= returns the uploaded file itself, not
 * JSON, and still needs the Authorization header.
 */
export async function apiBlob(path: string): Promise<Blob> {
  let response: Response;
  try {
    response = await send(path, { method: "GET" });
  } catch (err: unknown) {
    if (isDroppedConnection(err)) throw new Error(CONNECTION_LOST);
    throw err;
  }
  if (!response.ok) throw await serverError(response, path);
  return response.blob();
}

/** Grouped form, for call sites that read better as api.get / api.post. */
/** Guarantee the next call carries a freshly minted ID token. */
export async function forceRefreshToken(): Promise<boolean> {
  return refreshIdToken();
}

export const api = {
  get: apiGet,
  post: apiPost,
  postRaw: apiPostRaw,
  blob: apiBlob,
  setIdToken,
  token: currentIdToken,
};
