/* faceLock.ts — built-in webcam face unlock.

   Why built-in rather than the OS: desktops have a webcam but no fingerprint
   reader, and Windows Hello Face is usually not exposed to the browser. So
   Minerva does the face check itself, entirely in the browser, with no external
   model and nothing sent anywhere.

   How it works, honestly: on set-up it captures several frames, crops the
   central face region, reduces each to a small brightness-normalised grayscale
   "faceprint", and averages them into one template stored on this device. To
   unlock it captures again and measures how similar the new faceprint is (cosine
   similarity); above a threshold, it opens. Brightness normalisation makes it
   tolerant of lighting; centring your face in the on-screen oval keeps framing
   consistent.

   What it is NOT: it is a convenience lock, not bank security. It has no
   liveness detection, so a photo can fool it, and the real protection remains
   the Google sign-in underneath. It is the "keep a passer-by out of my notes on
   a shared desktop" lock the student asked for, done in a way that works on a
   plain webcam. */

const FACE_KEY = "minerva.lock.faceprint" // JSON: the enrolled template
const METHOD_KEY = "minerva.lock.method"
const SESSION_KEY = "minerva.lock.passed"

const SIZE = 48 // faceprint is SIZE x SIZE grayscale
const MATCH_THRESHOLD = 0.86 // cosine similarity to accept an unlock

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

/** Average several faceprints into one steadier template. */
async function captureAveraged(
  video: HTMLVideoElement,
  frames: number,
): Promise<Float32Array | null> {
  const prints: Float32Array[] = []
  for (let i = 0; i < frames * 2 && prints.length < frames; i++) {
    const p = frameToPrint(video)
    if (p) prints.push(p)
    await new Promise((r) => setTimeout(r, 120))
  }
  if (!prints.length) return null
  const avg = new Float32Array(SIZE * SIZE)
  for (const p of prints) for (let i = 0; i < avg.length; i++) avg[i] += p[i]
  for (let i = 0; i < avg.length; i++) avg[i] /= prints.length
  return avg
}

/* ------------------------------------------------------------- enrol / verify */

/** Learn this face from the live video and make face the active lock. */
export async function enrollFace(video: HTMLVideoElement): Promise<void> {
  const template = await captureAveraged(video, 8)
  if (!template) {
    throw new Error("Could not read your face — make sure it is lit and centred.")
  }
  try {
    // Round to 3 dp to keep the stored template small.
    localStorage.setItem(
      FACE_KEY,
      JSON.stringify(Array.from(template, (v) => Math.round(v * 1000) / 1000)),
    )
    localStorage.setItem(METHOD_KEY, "face")
    localStorage.removeItem("minerva.lock.credential") // face is the one method now
    sessionStorage.setItem(SESSION_KEY, "1") // just enrolled; do not lock out
  } catch {
    throw new Error("Could not save Face unlock on this device.")
  }
}

/** Measure the best similarity of the live face to the enrolled template.
    Returns the similarity (0..1); the caller compares it to matchThreshold(). */
export async function verifyFaceScore(video: HTMLVideoElement): Promise<number> {
  let storedRaw: string | null
  try {
    storedRaw = localStorage.getItem(FACE_KEY)
  } catch {
    storedRaw = null
  }
  if (!storedRaw) return 1 // no template; do not trap the user
  const stored = Float32Array.from(JSON.parse(storedRaw) as number[])
  const live = await captureAveraged(video, 4)
  if (!live) return 0
  return cosineSim(stored, live)
}

export function matchThreshold(): number {
  return MATCH_THRESHOLD
}
