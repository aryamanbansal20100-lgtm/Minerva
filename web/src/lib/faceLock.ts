/* faceLock.ts — built-in webcam face unlock.

   Why built-in rather than the OS: desktops have a webcam but no fingerprint
   reader, and Windows Hello Face is usually not exposed to the browser. So
   Minerva does the face check itself, entirely in the browser, with no external
   model and nothing sent anywhere.

   How it works, honestly: set-up is like a phone's -- the student turns their
   head while it samples ~16 poses, each cropped to the central face region and
   reduced to a small brightness-normalised grayscale "faceprint". Storing many
   poses is the key: to unlock it grabs one live frame and takes the BEST cosine
   similarity across all enrolled poses, so a slight turn or a lighting change
   lands near one of them instead of failing a single rigid template. Above a
   threshold it opens, and a live ring shows how close you are so it feels smooth
   rather than random.

   What it is NOT: it is a convenience lock, not bank security. It has no
   liveness detection, so a photo can fool it, and the real protection remains
   the Google sign-in underneath. It is the "keep a passer-by out of my notes on
   a shared desktop" lock the student asked for, done in a way that works on a
   plain webcam. */

import { markPassed } from "@/lib/applock"

const FACE_KEY = "minerva.lock.faceprint" // JSON: the enrolled template
const METHOD_KEY = "minerva.lock.method"

const SIZE = 48 // faceprint is SIZE x SIZE grayscale
// Multiple poses are enrolled and unlock matches the CLOSEST one, so a slight
// turn or lighting change no longer sits on a knife-edge. That makes a slightly
// more lenient threshold both reliable and quick.
const MATCH_THRESHOLD = 0.86
const ENROLL_POSES = 16 // faceprints captured across the head-turn sweep

export function faceSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    !!navigator.mediaDevices.getUserMedia &&
    (typeof window === "undefined" || window.isSecureContext)
  )
}

export function faceEnrolled(): boolean {
  try {
    return !!localStorage.getItem(FACE_KEY)
  } catch {
    return false
  }
}

/** Ask for the camera and return its stream. Throws a readable error. */
export async function openCamera(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    })
  } catch (e) {
    const name = e instanceof Error ? e.name : ""
    if (name === "NotAllowedError" || name === "SecurityError") {
      throw new Error(
        "Camera access was blocked. Allow the camera for this site and try again.",
      )
    }
    if (name === "NotFoundError" || name === "OverconstrainedError") {
      throw new Error("No camera was found on this device.")
    }
    throw new Error("Could not open the camera. " + (e instanceof Error ? e.message : ""))
  }
}

export function stopCamera(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop())
}

/* ------------------------------------------------------------- faceprint */

// One offscreen canvas, reused, so this does not allocate on every frame.
let scratch: HTMLCanvasElement | null = null
function canvas(): HTMLCanvasElement {
  if (!scratch) {
    scratch = document.createElement("canvas")
    scratch.width = SIZE
    scratch.height = SIZE
  }
  return scratch
}

/** A brightness-normalised grayscale faceprint from the centre of a video
    frame, or null if the frame is not ready. The centre square is used because
    a centred face fills it, which keeps the background out of the print. */
function frameToPrint(video: HTMLVideoElement): Float32Array | null {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh) return null
  const side = Math.min(vw, vh) * 0.7 // central 70% square: the face region
  const sx = (vw - side) / 2
  const sy = (vh - side) / 2
  const c = canvas()
  const ctx = c.getContext("2d", { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(video, sx, sy, side, side, 0, 0, SIZE, SIZE)
  const { data } = ctx.getImageData(0, 0, SIZE, SIZE)
  const gray = new Float32Array(SIZE * SIZE)
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    // Rec. 601 luma.
    gray[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
  }
  // Normalise to mean 0, unit variance -> tolerant of overall brightness.
  let mean = 0
  for (let i = 0; i < gray.length; i++) mean += gray[i]
  mean /= gray.length
  let variance = 0
  for (let i = 0; i < gray.length; i++) {
    gray[i] -= mean
    variance += gray[i] * gray[i]
  }
  const std = Math.sqrt(variance / gray.length) || 1
  for (let i = 0; i < gray.length; i++) gray[i] /= std
  return gray
}

export function cosineSim(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const d = Math.sqrt(na) * Math.sqrt(nb)
  return d ? dot / d : 0
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

/* ------------------------------------------------------------- enrol / verify */

/** Learn this face across several head positions and make Face the active lock.

    Like a phone's set-up: the student slowly turns their head while this samples
    a spread of poses over ~5 seconds. Storing many poses and matching the
    CLOSEST one at unlock is what makes it reliable -- a slight turn or a change
    in light lands near one of the enrolled poses instead of failing a single
    rigid template. `onProgress` reports 0..1 to drive the setup ring. */
export async function enrollFace(
  video: HTMLVideoElement,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const poses: number[][] = []
  const gap = 5000 / ENROLL_POSES // spread the captures across ~5s of movement
  // A little slack so a couple of unreadable frames don't cut the set short.
  for (let i = 0; i < ENROLL_POSES + 6 && poses.length < ENROLL_POSES; i++) {
    const p = frameToPrint(video)
    if (p) {
      poses.push(Array.from(p, (v) => Math.round(v * 1000) / 1000))
      onProgress?.(poses.length / ENROLL_POSES)
    }
    await sleep(gap)
  }
  if (poses.length < 4) {
    throw new Error("Could not read your face — make sure it is lit and centred.")
  }
  try {
    localStorage.setItem(FACE_KEY, JSON.stringify(poses))
    localStorage.setItem(METHOD_KEY, "face")
    localStorage.removeItem("minerva.lock.credential") // face is the one method now
  } catch {
    throw new Error("Could not save Face unlock on this device.")
  }
  markPassed() // just enrolled on this load; do not immediately lock out
}

/** The enrolled poses as Float32 vectors. Handles the old single-template
    format too, so a face enrolled before this update still works. */
function loadTemplates(): Float32Array[] {
  let raw: string | null
  try {
    raw = localStorage.getItem(FACE_KEY)
  } catch {
    raw = null
  }
  if (!raw) return []
  const parsed = JSON.parse(raw) as number[] | number[][]
  const rows = Array.isArray(parsed[0]) ? (parsed as number[][]) : [parsed as number[]]
  return rows.map((r) => Float32Array.from(r))
}

/** The best similarity of a SINGLE live frame to any enrolled pose (0..1).
    One frame, not an average, so the meter responds immediately as the student
    lines up. Returns 1 when nothing is enrolled, so it never traps anyone. */
export function verifyFaceScore(video: HTMLVideoElement): number {
  const templates = loadTemplates()
  if (!templates.length) return 1
  const live = frameToPrint(video)
  if (!live) return 0
  let best = 0
  for (const t of templates) {
    if (t.length === live.length) best = Math.max(best, cosineSim(t, live))
  }
  return best
}

export function matchThreshold(): number {
  return MATCH_THRESHOLD
}
