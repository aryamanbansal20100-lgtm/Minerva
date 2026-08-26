import { useCallback, useEffect, useState } from "react"
import {
  checkPin,
  disableLock,
  lockEnabled,
  lockMethod,
  lockPassedThisSession,
  unlockFingerprint,
} from "@/lib/applock"
import MinervaMark from "@/components/MinervaMark"
import FaceCapture from "@/components/FaceCapture"
import { markPassed } from "@/lib/applock"

/* The lock screen. Sits between sign-in and the app: if this device has a lock
   set and it has not been passed this session, nothing of the app shows until
   the chosen method confirms it's you.

   It never traps anyone: whatever the method, there is a "Can't unlock? Turn the
   lock off" escape, because the real security is the Google sign-in behind
   this, and a broken sensor or forgotten PIN must not lock a student out of
   their own account before an exam. */

export default function LockGate({ children }: { children: React.ReactNode }) {
  const [locked, setLocked] = useState(
    () => lockEnabled() && !lockPassedThisSession(),
  )
  const method = lockMethod()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [pin, setPin] = useState("")

  const tryFingerprint = useCallback(async () => {
    setBusy(true)
    setError("")
    try {
      await unlockFingerprint()
      setLocked(false)
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
      if (await checkPin(pin)) {
        setLocked(false)
      } else {
        setError("Wrong PIN.")
        setPin("")
      }
    } finally {
      setBusy(false)
    }
  }, [pin])

  // Fingerprint prompts automatically the first time the lock screen appears;
  // PIN waits for the student to type.
  useEffect(() => {
    if (locked && method === "fingerprint") void tryFingerprint()
    // once, on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!locked) return <>{children}</>

  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-background px-6 text-foreground">
      <div className="flex w-full max-w-[320px] flex-col items-center gap-5 text-center">
        <MinervaMark size={52} className="text-foreground" idPrefix="lock" />
        <div>
          <div className="font-display text-[18px] font-semibold tracking-tight">
            Minerva is locked
          </div>
          <div className="mt-1 text-[13px] text-muted-foreground">
            {method === "pin"
              ? "Enter your PIN to continue."
              : method === "face"
                ? "Look at the camera to unlock."
                : "Confirm it's you with your fingerprint, Face or device PIN."}
          </div>
        </div>

        {method === "face" ? (
          <FaceCapture
            mode="verify"
            onSuccess={() => {
              markPassed()
              setLocked(false)
            }}
            onCancel={() => setError("Cancelled. Try again, or use the escape below.")}
          />
        ) : method === "pin" ? (
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
        ) : (
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
        )}

        {error && <p className="text-[12.5px] text-late">{error}</p>}

        <button
          type="button"
          onClick={() => {
            disableLock()
            setLocked(false)
          }}
          className="mt-1 text-[12px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          Can't unlock? Turn the lock off
        </button>
      </div>
    </div>
  )
}
