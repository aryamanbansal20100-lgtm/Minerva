import { useCallback, useEffect, useState } from "react"
import { lockEnabled, lockPassedThisSession, unlock } from "@/lib/applock"
import MinervaMark from "@/components/MinervaMark"

/* The lock screen. Sits between sign-in and the app: if this device has the
   fingerprint lock on and it has not been passed this session, nothing of the
   app shows until the OS confirms the fingerprint / Face / PIN.

   It prompts once automatically on open, because that is what a locked app
   does; if the prompt is dismissed or fails, a button re-asks rather than
   trapping the student behind a silent wall. */

export default function LockGate({ children }: { children: React.ReactNode }) {
  const [locked, setLocked] = useState(
    () => lockEnabled() && !lockPassedThisSession(),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const tryUnlock = useCallback(async () => {
    setBusy(true)
    setError("")
    try {
      await unlock()
      setLocked(false)
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not confirm your fingerprint.",
      )
    } finally {
      setBusy(false)
    }
  }, [])

  // Prompt automatically the first time the lock screen appears.
  useEffect(() => {
    if (locked) void tryUnlock()
    // once only, on mount
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
            Confirm it's you with your fingerprint, Face or device PIN.
          </div>
        </div>

        <button
          type="button"
          onClick={() => void tryUnlock()}
          disabled={busy}
          className="btn-brand flex items-center gap-2 rounded-lg px-5 py-2.5 text-[14px] font-semibold disabled:opacity-60"
        >
          {/* fingerprint glyph */}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 10a2 2 0 0 1 2 2c0 3-1 5-1 5" />
            <path d="M8 12a4 4 0 0 1 8 0c0 4-1 6-1 6" />
            <path d="M5 12a7 7 0 0 1 14 0c0 1 0 2-.2 3" />
            <path d="M9 20c-.5-1-1-2-1-4a4 4 0 0 1 .3-1.5" />
          </svg>
          {busy ? "Waiting…" : "Unlock"}
        </button>

        {error && <p className="text-[12.5px] text-late">{error}</p>}
      </div>
    </div>
  )
}
