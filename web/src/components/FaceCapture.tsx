import { useCallback, useEffect, useRef, useState } from "react"
import {
  enrollFace,
  matchThreshold,
  openCamera,
  stopCamera,
  verifyFaceScore,
} from "@/lib/faceLock"

/* The webcam view, used two ways.

   mode="enroll"  — capture the student's face and save it as the unlock template.
   mode="verify"  — watch the camera and unlock the moment the live face matches.

   The camera stream is opened on mount and always stopped on unmount, so the
   webcam light never lingers. The face sits inside an on-screen oval so framing
   stays consistent between enrolling and unlocking, which is what makes a simple
   faceprint reliable. */

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
  const [hint, setHint] = useState(
    mode === "enroll" ? "Centre your face in the oval." : "Look at the camera…",
  )

  // Open the camera once; tear it down on unmount no matter what.
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
    setHint("Hold still…")
    try {
      await enrollFace(videoRef.current)
      onSuccess()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setHint("Try again.")
    } finally {
      setBusy(false)
    }
  }, [onSuccess])

  // Verify mode: poll the camera until the face matches or the student cancels.
  useEffect(() => {
    if (mode !== "verify" || !ready) return
    let alive = true
    ;(async () => {
      for (let attempt = 0; alive && attempt < 40; attempt++) {
        if (!videoRef.current) break
        let score = 0
        try {
          score = await verifyFaceScore(videoRef.current)
        } catch {
          /* keep trying */
        }
        if (!alive) return
        if (score >= matchThreshold()) {
          onSuccess()
          return
        }
        setHint(
          score > matchThreshold() - 0.08
            ? "Almost — hold still…"
            : "Line your face up with the oval.",
        )
        await new Promise((r) => setTimeout(r, 250))
      }
      if (alive) setHint("Couldn't confirm it's you. Try again, or use the escape below.")
    })()
    return () => {
      alive = false
    }
  }, [mode, ready, onSuccess])

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative h-56 w-56 overflow-hidden rounded-full border-2 border-brand/40 bg-black">
        <video
          ref={videoRef}
          muted
          playsInline
          // mirror, so moving left moves the preview left — what people expect
          className="h-full w-full -scale-x-100 object-cover"
        />
        {!ready && !error && (
          <div className="absolute inset-0 grid place-items-center text-[12px] text-white/70">
            Starting camera…
          </div>
        )}
      </div>

      <p className="min-h-[1.2em] text-[12.5px] text-muted-foreground">
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
            {busy ? "Saving…" : "Save my face"}
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
