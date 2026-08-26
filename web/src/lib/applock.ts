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
export type LockMethod = "none" | "fingerprint" | "face"

const METHOD_KEY = "minerva.lock.method"
const CRED_KEY = "minerva.lock.credential" // fingerprint: base64 credential id
const SESSION_KEY = "minerva.lock.passed" // set once unlocked this session

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

/** The FAST unlock enrolled on this device (face or fingerprint), if any. */
export function lockMethod(): LockMethod {
  const m = get(METHOD_KEY)
  if (m === "fingerprint" || m === "face") return m
  return "none"
}

export function lockEnabled(): boolean {
  return lockMethod() !== "none"
}

/* ------------------------------------------------- account lock (the PIN) */

/** Does this ACCOUNT require a lock? True on every device once a PIN is set.
    Server-owned, so it follows the student across devices. */
export async function accountLockRequired(): Promise<boolean> {
  try {
    const r = await apiGet<{ required?: boolean }>("/api/lock")
    return !!r.required
  } catch {
    return false // never trap the student behind a failed check
  }
}

/** Set (or change) the account PIN. Hashed and synced server-side. */
export async function setAccountPin(pin: string): Promise<void> {
  const clean = (pin || "").trim()
  if (!/^\d{4,6}$/.test(clean)) throw new Error("Choose a PIN of 4 to 6 digits.")
  await apiPost("/api/lock/set", { pin: clean })
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
  disableLock() // also clear this device's fast method
}

export function lockPassedThisSession(): boolean {
  try {
    return sessionStorage.getItem(SESSION_KEY) === "1"
  } catch {
    return false
  }
}

export function markPassed() {
  try {
    sessionStorage.setItem(SESSION_KEY, "1")
  } catch {
    /* private mode: it simply asks again, which is safe */
  }
}

/** Turn every lock off on this device. The escape hatch, and the "Off" choice. */
export function disableLock() {
  del(METHOD_KEY)
  del(CRED_KEY)
  try {
    sessionStorage.removeItem(SESSION_KEY)
  } catch {
    /* nothing */
  }
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
