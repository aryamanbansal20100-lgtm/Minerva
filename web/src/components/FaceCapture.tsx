import { useCallback, useEffect, useRef, useState } from "react"
import {
  enrollFace,
  matchThreshold,
  openCamera,
  readFace,
  stopCamera,
} from "@/lib/faceLock"

/* The webcam view, used two ways, both with a live ring so it never feels like
   a guessing game.

   mode="enroll" — the student slowly turns their head while a ring fills; this
     samples a spread of poses so unlocking is reliable from any slight angle.
   mode="verify" — the ring fills with how close the live face is to the enrolled
     poses, and it unlocks the instant it's a match. Seeing the ring rise is what
     makes it feel smooth: you can tell you're nearly there and hold still.

   The camera opens on mount and is always stopped on unmount, so the webcam
   light never lingers. */

const RING = 2 * Math.PI * 108 // circumference of the r=108 progress ring

export default function FaceCapture({
  mode,
  onSuccess,
  onCancel,
}: {
  mode: "enroll" | "verify"
  onSuccess: () => void
  onCancel: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const stopped = useRef(false)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [progress, setProgress] = useState(0) // 0..1, drives the ring
  const [hint, setHint] = useState(
    mode === "enroll"
      ? "Centre your face, then press Start."
      : "Line your face up with the circle…",
  )

  useEffect(() => {
    stopped.current = false
    openCamera()
      .then((stream) => {
        if (stopped.current) {
          stopCamera(stream)
          return
        }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          void videoRef.current.play()
        }
        setReady(true)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
    return () => {
      stopped.current = true
      stopCamera(streamRef.current)
      streamRef.current = null
    }
  }, [])

  const doEnroll = useCallback(async () => {
    if (!videoRef.current) return
    setBusy(true)
    setError("")
    setProgress(0)
    setHint("Turn your head slowly left and right — then lean in a little, and back.")
    try {
      await enrollFace(videoRef.current, (f) => setProgress(f))
      setHint("Got it!")
      onSuccess()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setHint("Try again — good light, face centred.")
      setProgress(0)
    } finally {
      setBusy(false)
    }
  }, [onSuccess])

  /* Verify: poll fast, show the live match on the ring, unlock at the threshold.

     Two frames in a row must clear the bar before it opens. A single frame can
     spike on a blur or an odd angle, and one lucky frame should not be the whole
     security check — two consecutive readings cost about a fifth of a second and
     remove that entirely. The hint distinguishes "I cannot see a face" from
     "I can see one but it isn't you", which is the difference between the
     student adjusting the laptop and giving up. */
  useEffect(() => {
    if (mode !== "verify" || !ready) return
    let alive = true
    let streak = 0
    const th = matchThreshold()
    const tick = () => {
      if (!alive || !videoRef.current) return
      const { score, faceFound } = readFace(videoRef.current)

      if (!faceFound) {
        streak = 0
        setProgress(0)
        setHint("Move into the frame — make sure your face is lit from the front.")
        window.setTimeout(tick, 160)
        return
      }

      setProgress(Math.max(0, Math.min(1, score / th)))
      if (score >= th) {
        streak += 1
        if (streak >= 2) {
          onSuccess()
          return
        }
        setHint("Hold still…")
      } else {
        streak = 0
        setHint(
          score > th - 0.08
            ? "Almost — hold still…"
            : "Line your face up with the circle…",
        )
      }
      window.setTimeout(tick, 160)
    }
    const id = window.setTimeout(tick, 400) // let the camera settle first
    return () => {
      alive = false
      window.clearTimeout(id)
    }
  }, [mode, ready, onSuccess])

  const pct = Math.round(progress * 100)

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative h-60 w-60">
        {/* progress ring */}
        <svg className="absolute inset-0 h-full w-full -rotate-90" viewBox="0 0 240 240">
          <circle cx="120" cy="120" r="108" fill="none" stroke="var(--muted)" strokeWidth="6" />
          <circle
            cx="120"
            cy="120"
            r="108"
            fill="none"
            stroke="var(--brand)"
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={RING}
            strokeDashoffset={RING * (1 - progress)}
            style={{ transition: "stroke-dashoffset 120ms linear" }}
          />
        </svg>
        <div className="absolute inset-[12px] overflow-hidden rounded-full bg-black">
          <video
            ref={videoRef}
            muted
            playsInline
            className="h-full w-full -scale-x-100 object-cover"
          />
          {!ready && !error && (
            <div className="absolute inset-0 grid place-items-center text-[12px] text-white/70">
              Starting camera…
            </div>
          )}
          {(busy || mode === "verify") && ready && (
            <div className="absolute inset-x-0 bottom-2 text-center font-mono text-[11px] text-white/80">
              {pct}%
            </div>
          )}
        </div>
      </div>

      <p className="min-h-[1.2em] text-center text-[12.5px] text-muted-foreground">
        {error || hint}
      </p>

      <div className="flex gap-2">
        {mode === "enroll" && (
          <button
            type="button"
            onClick={() => void doEnroll()}
            disabled={!ready || busy}
            className="btn-brand rounded-lg px-4 py-2 text-[13px] font-semibold disabled:opacity-55"
          >
            {busy ? "Keep turning…" : "Start scan"}
          </button>
        )}
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border px-4 py-2 text-[13px] transition-colors hover:bg-muted"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
