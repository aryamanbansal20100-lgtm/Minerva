/* applock.ts — an optional lock over the app, with a method the student picks.

   A DEVICE lock, not a second sign-in: the real identity is still the Google
   account. This adds a "prove it's you on this device" step when Minerva opens.
   Three methods, chosen per device so the student can use whatever their
   hardware actually supports:

     pin          a 4-6 digit code. Works on EVERY device, always. The reliable
                  fallback for laptops whose fingerprint/face the browser can't
                  reach — which is most of them.
     fingerprint  the OS platform authenticator (Touch ID, Windows Hello,
                  Android fingerprint) via WebAuthn. Great when it works; some
                  laptops simply do not expose it to the browser, hence the PIN.

   Everything is stored per-device in localStorage, so a lock on one machine
   never forces it on another, and passing it once holds for the browser
   session rather than re-prompting on every navigation. None of it is a
   server-verified credential; the account stays protected by Google underneath. */

export type LockMethod = "none" | "pin" | "fingerprint" | "face"

const METHOD_KEY = "minerva.lock.method"
const CRED_KEY = "minerva.lock.credential" // fingerprint: base64 credential id
const PIN_KEY = "minerva.lock.pin" // pin: sha-256 hex of the code
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
async function sha256hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest("SHA-256", data)
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
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

export function lockMethod(): LockMethod {
  const m = get(METHOD_KEY)
  if (m === "pin" || m === "fingerprint" || m === "face") return m
  return "none"
}

export function lockEnabled(): boolean {
  return lockMethod() !== "none"
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
  del(PIN_KEY)
  try {
    sessionStorage.removeItem(SESSION_KEY)
  } catch {
    /* nothing */
  }
}

/* ---------------------------------------------------------------- PIN */

/** Set a 4-6 digit PIN and make it the active lock. Works on every device. */
export async function setPin(pin: string): Promise<void> {
  const clean = (pin || "").trim()
  if (!/^\d{4,6}$/.test(clean)) {
    throw new Error("Choose a PIN of 4 to 6 digits.")
  }
  set(PIN_KEY, await sha256hex(clean))
  set(METHOD_KEY, "pin")
  markPassed() // just set it; do not immediately lock the student out
}

/** True if the PIN matches the one stored on this device. */
export async function checkPin(pin: string): Promise<boolean> {
  const stored = get(PIN_KEY)
  if (!stored) return true // no PIN set; do not trap anyone
  const ok = (await sha256hex((pin || "").trim())) === stored
  if (ok) markPassed()
  return ok
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
