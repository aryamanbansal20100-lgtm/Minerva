/* applock.ts — an optional fingerprint / passkey lock over the whole app.

   This is a DEVICE lock, not a second sign-in. The real identity is still the
   Google account; this adds a "prove it's you on this device" step when Minerva
   opens, using the platform authenticator the OS already has — Touch ID on a
   Mac, Windows Hello, the fingerprint sensor on a phone. The same WebAuthn API
   backs all of them, so one implementation covers every platform Minerva will
   ship on.

   Honest about what it is: the unlock succeeds when the OS confirms the
   fingerprint/PIN, checked on the device. It is a lock screen, the way a notes
   app locks with Face ID — it keeps a shoulder-surfer or a shared-laptop
   classmate out, and it is not a server-verified credential. The account itself
   is still protected by Google sign-in underneath.

   Everything is stored per-device in localStorage, keyed by the signed-in user,
   so enabling the lock on your laptop does not force it on the library computer,
   and one person's lock on a shared machine is not another's. */

const CRED_KEY = "minerva.lock.credential" // base64 credential id, per user
const ON_KEY = "minerva.lock.on" // "1" when the lock is enabled here
const SESSION_KEY = "minerva.lock.passed" // set once unlocked this session

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

/** Is a platform authenticator (fingerprint/Face/Hello) usable in this browser?
    False on http (WebAuthn needs a secure context) and on machines with no
    biometric hardware, so the Settings toggle can explain rather than fail. */
export async function lockSupported(): Promise<boolean> {
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

export function lockEnabled(): boolean {
  try {
    return localStorage.getItem(ON_KEY) === "1" && !!localStorage.getItem(CRED_KEY)
  } catch {
    return false
  }
}

/** True once the fingerprint has been passed this browser session, so switching
    tabs or navigating does not re-prompt every time. */
export function lockPassedThisSession(): boolean {
  try {
    return sessionStorage.getItem(SESSION_KEY) === "1"
  } catch {
    return false
  }
}

function markPassed() {
  try {
    sessionStorage.setItem(SESSION_KEY, "1")
  } catch {
    /* private mode: it will simply ask again, which is safe */
  }
}

/** Register the device's fingerprint/passkey and turn the lock on.
    Returns true on success; throws with a readable message on failure. */
export async function enableLock(userLabel: string): Promise<boolean> {
  if (!(await lockSupported())) {
    throw new Error(
      "This device has no fingerprint, Face or PIN unlock available to the browser.",
    )
  }
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: randomBytes(32),
      rp: { name: "Minerva", id: location.hostname },
      user: {
        id: randomBytes(16),
        name: userLabel || "student",
        displayName: userLabel || "Minerva student",
      },
      // ES256 and RS256 — every platform authenticator supports one of them.
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
  if (!cred) throw new Error("Setup was cancelled.")
  try {
    localStorage.setItem(CRED_KEY, b64(cred.rawId))
    localStorage.setItem(ON_KEY, "1")
    markPassed() // just proved it; do not immediately lock them out
  } catch {
    throw new Error("Could not save the lock on this device.")
  }
  return true
}

export function disableLock() {
  try {
    localStorage.removeItem(ON_KEY)
    localStorage.removeItem(CRED_KEY)
    sessionStorage.removeItem(SESSION_KEY)
  } catch {
    /* nothing to clear */
  }
}

/** Prompt for the fingerprint/passkey and, on success, unlock for this session.
    Returns true when the OS confirmed the user; false/throws otherwise. */
export async function unlock(): Promise<boolean> {
  const id = (() => {
    try {
      return localStorage.getItem(CRED_KEY)
    } catch {
      return null
    }
  })()
  if (!id) return true // lock not really set up; do not trap the user

  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32),
      allowCredentials: [{ type: "public-key", id: unb64(id) }],
      userVerification: "required",
      timeout: 60000,
    },
  })) as PublicKeyCredential | null

  if (!assertion) throw new Error("Unlock was cancelled.")
  markPassed()
  return true
}
