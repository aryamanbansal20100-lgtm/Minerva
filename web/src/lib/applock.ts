/* applock.ts — an optional lock over the app, with a method the student picks.

   Not a second sign-in: the real identity is still the Google account. This
   adds a "prove it's you" step when Minerva opens. Two layers:

     account PIN  a 4-6 digit code, hashed and stored on the SERVER and synced,
                  so once it is set the lock is required on EVERY device the
                  student signs in on. This is the cross-device lock, and the
                  one credential that always travels with the account.
     device fast  face (faceLock.ts) or the OS fingerprint (WebAuthn), enrolled
                  per device in localStorage as a quicker way past the same lock
                  on a machine that has them. Optional; the PIN is always the
                  fallback.

   The PIN hash never reaches the browser -- checks happen server-side -- so a
   brand-new device with no local enrolment can still be unlocked. */

import { apiGet, apiPost } from "@/lib/api"

// A device method is a FAST unlock stored on this device (face/fingerprint).
// The PIN is ACCOUNT-level: it lives on the server, synced, so the lock appears
// on every device the student signs in on. "pin" as a device method therefore
// no longer exists — PIN is always the account lock below.
export type LockMethod = "none" | "pin" | "fingerprint" | "face"

const METHOD_KEY = "minerva.lock.method"
const CRED_KEY = "minerva.lock.credential" // fingerprint: base64 credential id
const FACE_KEY = "minerva.lock.faceprint" // face: enrolled template (mirrors faceLock)
// Whether a lock is required lives in localStorage so a reload knows to lock
// straight away, with no flash of the app before the server confirms it.
const ACCOUNT_CACHE = "minerva.lock.accountRequired"

/* Whether the lock has been passed THIS PAGE LOAD.

   Deliberately a plain variable, not sessionStorage: sessionStorage survives a
   refresh, which meant a reload kept you inside a locked app — the whole point
   of a lock defeated by pressing F5. An in-memory flag resets on every full
   load, so a refresh (and a browser reload after the laptop wakes) always shows
   the lock again. It still survives tab and app switches, because those do not
   reload the page — which is exactly the line we want. */
let passedThisLoad = false

/* ---------------------------------------------------------------- helpers */

function b64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
}
function unb64(s: string): BufferSource {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) as BufferSource
}
function randomBytes(n: number): BufferSource {
  const a = new Uint8Array(new ArrayBuffer(n))
  crypto.getRandomValues(a)
  return a as BufferSource
}
function get(k: string): string | null {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
function set(k: string, v: string) {
  try {
    localStorage.setItem(k, v)
  } catch {
    /* private mode: the lock just will not persist, which is safe */
  }
}
function del(k: string) {
  try {
    localStorage.removeItem(k)
  } catch {
    /* nothing to remove */
  }
}

/* ---------------------------------------------------------------- state */

/** The unlock method chosen on THIS device. One at a time: choosing one clears
    the others, so setting a PIN never leaves a stale fingerprint that would open
    Windows Hello instead. */
export function lockMethod(): LockMethod {
  const m = get(METHOD_KEY)
  if (m === "pin" || m === "fingerprint" || m === "face") return m
  return "none"
}

export function lockEnabled(): boolean {
  return lockMethod() !== "none"
}

/** Wipe every device method, so exactly one is ever active. */
function clearDeviceMethods() {
  del(METHOD_KEY)
  del(CRED_KEY)
  del(FACE_KEY)
}

/** Drop the pass and reload, so the lock screen appears now — the "Lock now /
    test it" button in Settings. A reload alone would re-lock (the pass is not
    persisted), but reloading also re-reads the freshly-chosen method. */
export function relock() {
  passedThisLoad = false
  location.reload()
}

/* ------------------------------------------------- account lock (the PIN) */

/** Was a lock required as of this device's last successful check? Read straight
    from localStorage so a reload can lock instantly, before the server answers —
    no flash of the app for a split second on a locked account. */
export function accountLockCached(): boolean {
  try {
    return localStorage.getItem(ACCOUNT_CACHE) === "1"
  } catch {
    return false
  }
}

/** Does this ACCOUNT require a lock? True on every device once a PIN is set.
    Server-owned, so it follows the student across devices. The answer is cached
    so the next reload locks without waiting; if the check itself fails (offline),
    we fall back to that cache rather than unlocking — a dropped network must
    never be a way past the lock. */
export async function accountLockRequired(): Promise<boolean> {
  try {
    const r = await apiGet<{ required?: boolean }>("/api/lock")
    const req = !!r.required
    try {
      if (req) localStorage.setItem(ACCOUNT_CACHE, "1")
      else localStorage.removeItem(ACCOUNT_CACHE)
    } catch {
      /* private mode: the in-memory result still drives this load */
    }
    return req
  } catch {
    return accountLockCached() // offline: trust what we last knew
  }
}

/** Set (or change) the account PIN, and make PIN the way in on THIS device too.
    Clears any face/fingerprint so the PIN screen — not Windows Hello — is what
    opens here. */
export async function setAccountPin(pin: string): Promise<void> {
  const clean = (pin || "").trim()
  if (!/^\d{4,6}$/.test(clean)) throw new Error("Choose a PIN of 4 to 6 digits.")
  await apiPost("/api/lock/set", { pin: clean })
  clearDeviceMethods()
  set(METHOD_KEY, "pin")
  try {
    localStorage.setItem(ACCOUNT_CACHE, "1") // a reload now locks immediately
  } catch {
    /* nothing */
  }
  markPassed()
}

/** Check a PIN against the account. The hash never leaves the server, so this
    works on a device that has never enrolled anything. */
export async function checkAccountPin(pin: string): Promise<boolean> {
  try {
    const r = await apiPost<{ ok?: boolean }>("/api/lock/check", {
      pin: (pin || "").trim(),
    })
    if (r.ok) markPassed()
    return !!r.ok
  } catch {
    return false
  }
}

/** Turn the whole account lock off, everywhere. */
export async function clearAccountLock(): Promise<void> {
  await apiPost("/api/lock/off", {})
  try {
    localStorage.removeItem(ACCOUNT_CACHE) // so a reload does not re-lock
  } catch {
    /* nothing */
  }
  disableLock() // also clear this device's fast method
}

/** Has the lock been passed on THIS page load? Resets on every reload. */
export function lockPassedThisSession(): boolean {
  return passedThisLoad
}

export function markPassed() {
  passedThisLoad = true
}

/** Drop the pass, so the lock screen returns without a reload — used by the
    sleep detector when the machine has been asleep. */
export function clearPassed() {
  passedThisLoad = false
}

/** Turn every lock off on this device. The escape hatch, and the "Off" choice. */
export function disableLock() {
  clearDeviceMethods()
  passedThisLoad = false
}

/* ---------------------------------------------------------------- fingerprint */

/** Is a platform authenticator (fingerprint/Face/Hello) usable in this browser?
    False on http (WebAuthn needs a secure context) and where there is no
    biometric the browser can reach — so the Settings toggle can explain rather
    than silently fail. */
export async function fingerprintSupported(): Promise<boolean> {
  try {
    if (
      typeof window === "undefined" ||
      !window.PublicKeyCredential ||
      !window.isSecureContext
    ) {
      return false
    }
    return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
  } catch {
    return false
  }
}

function friendlyWebauthnError(e: unknown): Error {
  const name = e instanceof Error ? e.name : ""
  if (name === "NotAllowedError" || name === "AbortError") {
    return new Error(
      "The prompt was cancelled or timed out. Try again, and confirm with your fingerprint, Face or PIN when your device asks.",
    )
  }
  if (name === "InvalidStateError") {
    return new Error("This device is already set up. The lock is on.")
  }
  if (name === "NotSupportedError" || name === "SecurityError") {
    return new Error(
      "This device or browser can't use the device unlock here — try the PIN instead.",
    )
  }
  return e instanceof Error ? e : new Error(String(e))
}

export async function enableFingerprint(userLabel: string): Promise<void> {
  if (!(await fingerprintSupported())) {
    throw new Error(
      "This device has no fingerprint/Face the browser can use. Use a PIN instead.",
    )
  }
  let cred: PublicKeyCredential | null
  try {
    cred = (await navigator.credentials.create({
      publicKey: {
        challenge: randomBytes(32),
        rp: { name: "Minerva", id: location.hostname },
        user: {
          id: randomBytes(16),
          name: userLabel || "student",
          displayName: userLabel || "Minerva student",
        },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          userVerification: "required",
          residentKey: "preferred",
        },
        timeout: 60000,
      },
    })) as PublicKeyCredential | null
  } catch (e) {
    throw friendlyWebauthnError(e)
  }
  if (!cred) throw new Error("Setup was cancelled.")
  del(FACE_KEY)                       // fingerprint is now the one method here
  set(CRED_KEY, b64(cred.rawId))
  set(METHOD_KEY, "fingerprint")
  markPassed()
}

export async function unlockFingerprint(): Promise<boolean> {
  const id = get(CRED_KEY)
  if (!id) return true
  let assertion: PublicKeyCredential | null
  try {
    assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        allowCredentials: [{ type: "public-key", id: unb64(id) }],
        userVerification: "required",
        timeout: 60000,
      },
    })) as PublicKeyCredential | null
  } catch (e) {
    throw friendlyWebauthnError(e)
  }
  if (!assertion) throw new Error("Unlock was cancelled.")
  markPassed()
  return true
}
