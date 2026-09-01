import { useCallback, useEffect, useState } from "react"
import {
  accountLockCached,
  accountLockRequired,
  checkAccountPin,
  clearPassed,
  disableLock,
  lockMethod,
  lockPassedThisSession,
  markPassed,
  unlockFingerprint,
} from "@/lib/applock"
import { isRecording } from "@/lib/recordingState"
import { useAuth } from "@/lib/auth"
import { watchForSleep } from "@/lib/sleepwatch"
import MinervaMark from "@/components/MinervaMark"
import FaceCapture from "@/components/FaceCapture"

/* The lock screen. Sits between sign-in and the app.

   Two independent things can require it:
     • a FAST device method (face/fingerprint) enrolled on THIS machine, and
     • the ACCOUNT lock (a PIN), which the student set on some device and which,
       being synced, is required on EVERY device they sign in on.

   So on your own laptop with Face set up you look at the camera; sign in on a
   library desktop that has never seen your face and the same account still
   demands its PIN. The PIN is always offered as the way in, because it is the
   one credential that travels with the account. There is always a "Sign out"
   escape so a broken camera or a machine you don't trust never traps you — you
   simply return to Google sign-in, which is the real security underneath. */

export default function LockGate({ children }: { children: React.ReactNode }) {
  const { signOut } = useAuth()
  const device = lockMethod() // "face" | "fingerprint" | "none" on THIS device
  const [required, setRequired] = useState<boolean | null>(
    // Lock straight away, before the server answers, whenever we already know a
    // lock applies: a fast method is set on this device, or the last check said
    // the account requires one. This is what makes a refresh re-lock instantly
    // with no flash of the app in between.
    device !== "none" || accountLockCached() ? true : null,
  )
  const [passed, setPassed] = useState(lockPassedThisSession())
  const [usePin, setUsePin] = useState(false)
  const [pin, setPin] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  // Ask the server whether the ACCOUNT requires a lock (it does once a PIN is
  // set anywhere). This is what makes the lock appear on a brand-new device.
  useEffect(() => {
    let live = true
    accountLockRequired().then((req) => {
      if (!live) return
      // A fast method on this device always locks it. Otherwise the account's
      // answer is authoritative — so turning the lock off on another device
      // unlocks here on the next check, rather than stranding the student at a
      // PIN screen for a PIN that no longer exists.
      setRequired(device !== "none" ? true : req)
      // A device with no fast method but an account PIN goes straight to PIN.
      if (req && device === "none") setUsePin(true)
    })
    return () => {
      live = false
    }
  }, [device])

  /* FAIL CLOSED. `required` is null until the server answers, and treating that
     unknown as "not locked" is what let anyone open /#/settings — or any route —
     and see the whole app while the check was still in flight, or for ever if the
     check failed. An unknown answer is now treated as locked: nothing below this
     gate renders until the server has actually said there is no lock. */
  const locked = required !== false && !passed
  const showFace = device === "face" && !usePin
  const showFingerprint = device === "fingerprint" && !usePin

  const tryFingerprint = useCallback(async () => {
    setBusy(true)
    setError("")
    try {
      await unlockFingerprint()
      setPassed(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not confirm it's you.")
    } finally {
      setBusy(false)
    }
  }, [])

  const submitPin = useCallback(async () => {
    setBusy(true)
    setError("")
    try {
      if (await checkAccountPin(pin)) {
        setPassed(true)
      } else {
        setError("Wrong PIN.")
        setPin("")
      }
    } finally {
      setBusy(false)
    }
  }, [pin])

  /* Re-lock after the machine sleeps, but never on a tab or app switch.

     The detection lives in sleepwatch.ts, which distinguishes the two properly:
     a suspend makes the wall clock and the monotonic clock disagree, while a
     backgrounded tab merely gets its timers throttled and both clocks advance
     together. Switching tabs therefore costs nothing, and closing the lid — even
     for half a minute, even when waking fires no events at all — brings the lock
     straight back. */
  useEffect(() => {
    // Only meaningful once something actually locks this app.
    if (required !== true && device === "none") return
    return watchForSleep(() => {
      /* Never mid-lesson. Locking unmounts the app, which tears down the
         microphone and loses the recording — so a lesson in progress wins over
         an automatic re-lock. A manual lock and a fresh page load still lock. */
      if (isRecording()) return
      clearPassed()
      setPassed(false)
      setUsePin(device === "none")
      setPin("")
      setError("")
    })
  }, [required, device])

  // When the lock screen leaves the tree — which happens on sign-out — drop the
  // pass, so signing back in (as anyone) starts locked rather than inheriting
  // the last person's unlock.
  useEffect(() => () => clearPassed(), [])

  // Fingerprint prompts itself once when it's the shown method.
  useEffect(() => {
    if (locked && showFingerprint) void tryFingerprint()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked, showFingerprint])

  if (!locked) return <>{children}</>

  /* Still waiting on the server. Neither the app (that is the hole we just
     closed) nor a PIN box (wrong, and alarming, for an account with no lock) —
     just a quiet holding screen for the moment it takes to find out. */
  if (required === null) {
    return (
      <div className="fixed inset-0 z-[90] grid place-items-center bg-background text-foreground">
        <div className="flex items-center gap-2.5">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" />
          <span className="font-mono text-[13px] text-muted-foreground">Checking…</span>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-background px-6 text-foreground">
      <div className="flex w-full max-w-[320px] flex-col items-center gap-5 text-center">
        <MinervaMark size={52} className="text-foreground" idPrefix="lock" />
        <div>
          <div className="font-display text-[18px] font-semibold tracking-tight">
            Minerva is locked
          </div>
          <div className="mt-1 text-[13px] text-muted-foreground">
            {showFace
              ? "Look at the camera to unlock."
              : showFingerprint
                ? "Confirm with your fingerprint or device unlock."
                : "Enter your PIN to continue."}
          </div>
        </div>

        {showFace ? (
          <FaceCapture
            mode="verify"
            onSuccess={() => {
              markPassed()
              setPassed(true)
            }}
            onCancel={() => setUsePin(true)}
          />
        ) : showFingerprint ? (
          <button
            type="button"
            onClick={() => void tryFingerprint()}
            disabled={busy}
            className="btn-brand flex items-center gap-2 rounded-lg px-5 py-2.5 text-[14px] font-semibold disabled:opacity-60"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 10a2 2 0 0 1 2 2c0 3-1 5-1 5" />
              <path d="M8 12a4 4 0 0 1 8 0c0 4-1 6-1 6" />
              <path d="M5 12a7 7 0 0 1 14 0c0 1 0 2-.2 3" />
              <path d="M9 20c-.5-1-1-2-1-4a4 4 0 0 1 .3-1.5" />
            </svg>
            {busy ? "Waiting…" : "Unlock"}
          </button>
        ) : (
          <form
            className="flex w-full flex-col items-center gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              void submitPin()
            }}
          >
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              autoFocus
              value={pin}
              onChange={(e) =>
                setPin(e.target.value.replace(/\D/g, "").slice(0, 6))
              }
              placeholder="••••"
              className="w-40 rounded-lg border bg-card px-3 py-2.5 text-center font-mono text-[20px] tracking-[0.3em] outline-none focus-visible:ring-2 focus-visible:ring-brand-ring"
            />
            <button
              type="submit"
              disabled={busy || pin.length < 4}
              className="btn-brand w-40 rounded-lg px-4 py-2.5 text-[14px] font-semibold disabled:opacity-55"
            >
              {busy ? "Checking…" : "Unlock"}
            </button>
          </form>
        )}

        {error && <p className="text-[12.5px] text-late">{error}</p>}

        {/* Fall back to the account PIN from a device method, when it's set. */}
        {(showFace || showFingerprint) && (
          <button
            type="button"
            onClick={() => setUsePin(true)}
            className="text-[12px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Use PIN instead
          </button>
        )}

        {/* The escape: return to Google sign-in. Never reveals the notes, and
            never traps anyone behind a broken sensor or a forgotten PIN. */}
        <button
          type="button"
          onClick={() => {
            disableLock() // drop this device's fast method; account PIN stays
            void signOut()
          }}
          className="mt-1 text-[12px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          Sign out instead
        </button>
      </div>
    </div>
  )
}
