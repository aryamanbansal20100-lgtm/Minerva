/* faceLock.ts — webcam face unlock that survives a change of scenery.

   WHY THE FIRST VERSION WAS BRITTLE. It took the middle 70% of the frame,
   shrank it to 48x48 grey pixels, and compared those pixels. That square is
   mostly NOT face: it is wall, curtain, doorway, hair, shoulders, hoodie. So the
   "faceprint" was really a fingerprint of the whole scene, and it only matched
   when the student sat in the same chair, in the same light, with the same hair.
   Exactly the complaint. Raw pixels are also hostage to brightness — turn on a
   lamp and every number in the vector shifts.

   THE FIX, in two halves.

   1. FIND THE FACE FIRST, and throw the rest away. Skin is easy to isolate in
      YCbCr, because melanin mostly moves LUMA (Y) while the chroma channels
      (Cb, Cr) stay in a narrow band across the whole range of human skin tones —
      which is why this works for dark and light skin alike, where an RGB rule
      would not. The largest skin region in the frame is the face; everything
      outside its box is discarded before anything is measured. Hair is not skin,
      so hair stops counting. The wall behind you stops counting.

   2. DESCRIBE IT BY SHAPE, NOT BY BRIGHTNESS. The cropped face becomes a
      histogram-of-oriented-gradients descriptor: the image is split into cells,
      and each cell records the DIRECTIONS its edges run in, not how bright it
      is. Add light to the room and every pixel changes while the directions of
      the edges — the line of the nose, the arc of the brows — do not. Each cell
      is normalised on its own, so even uneven lighting across the face is
      absorbed. That is what makes it tolerant instead of fussy.

   What it is NOT: a bank-grade biometric. There is no liveness check, so a photo
   can defeat it, and the real protection underneath is the Google sign-in. It is
   the "keep a passer-by out of my notes" lock, done properly. Nothing ever
   leaves the device: enrolment lives in this browser's localStorage. */

import { markPassed } from "@/lib/applock"

const FACE_KEY = "minerva.lock.faceprint"
const METHOD_KEY = "minerva.lock.method"

/* ---- tuning ------------------------------------------------------------- */

const MASK_W = 64          // resolution the skin mask is computed at (cheap)
const MASK_H = 48
const FACE_PX = 64         // the face crop is normalised to FACE_PX square
const CELL = 8             // HOG cell size -> 8x8 = 64 cells
const BINS = 9             // orientation bins over 0..180 degrees
const ENROLL_POSES = 14    // samples captured across the head-turn sweep
/* Bump whenever anything that changes what a descriptor MEANS changes — the
   crop, the cell size, the bins, how the face is located. An enrolment made by
   an older version describes a different region of the picture, so comparing
   against it silently never matches and the student is left with a camera that
   simply refuses them. Versioning turns that into an honest "set Face up again"
   instead of a mystery. */
const ENROL_VERSION = 2
/* An honest number, and an honest limitation.

   Benched against the same face at six distances, in changed light, against a
   changed background and with changed hair, and against other faces at several
   distances, the two score ranges OVERLAP. Refusing every impostor needs about
   0.88, and at 0.88 the real student is turned away more often than not; letting
   the real student in reliably needs about 0.75, and at 0.75 some other faces
   also get in. There is no setting that does both.

   That is a property of the method, not of the tuning. Doing this properly means
   a trained face-embedding network, and its weights are exactly the kind of
   megabyte dependency this project does not have and its Content-Security-Policy
   would not load. So rather than pretend, Face here is positioned as a
   CONVENIENCE unlock: it is tuned toward letting the student in, because being
   locked out of your own notes by your own laptop is the failure that actually
   hurts, and the account PIN underneath is the credential that really guards the
   account. The Settings copy says so plainly. */
const MATCH_THRESHOLD = 0.72
/* The bar EASES DOWN while it can see a face, instead of being one fixed number.

   A single threshold has to be wrong somewhere: high enough to refuse a stranger
   at a glance is high enough to refuse the real student on a bad-hair, bad-light
   day, and that failure — locked out of your own notes by your own laptop — is
   the one that actually hurts. A phone feels forgiving because it keeps looking
   and keeps trying, not because its bar is low.

   So: a face in frame for a moment must clear MATCH_THRESHOLD, and if it keeps
   sitting there the bar slides toward RELAX_FLOOR over RELAX_MS. A stranger
   glancing at the camera is gone long before the floor; the real student, who
   waits because it is their laptop, is in within a few seconds. The account PIN
   underneath remains the credential that actually guards the account. */
const RELAX_FLOOR = 0.62
const RELAX_MS = 4500

/** The bar to beat after a face has been continuously visible for `ms`. */
export function thresholdAfter(ms: number): number {
  const k = Math.max(0, Math.min(1, ms / RELAX_MS))
  return MATCH_THRESHOLD - (MATCH_THRESHOLD - RELAX_FLOOR) * k
}

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

/* ---- scratch canvases, reused so frames do not allocate ------------------ */

let maskCanvas: HTMLCanvasElement | null = null
let faceCanvas: HTMLCanvasElement | null = null

function canvasOf(which: "mask" | "face"): HTMLCanvasElement {
  if (which === "mask") {
    if (!maskCanvas) {
      maskCanvas = document.createElement("canvas")
      maskCanvas.width = MASK_W
      maskCanvas.height = MASK_H
    }
    return maskCanvas
  }
  if (!faceCanvas) {
    faceCanvas = document.createElement("canvas")
    faceCanvas.width = FACE_PX
    faceCanvas.height = FACE_PX
  }
  return faceCanvas
}

/* ---- 1. find the face --------------------------------------------------- */

export interface FaceBox {
  x: number
  y: number
  size: number
  /** Share of the frame that looked like skin — drives the "no face" message. */
  coverage: number
}

/** Is this pixel plausibly skin? Tested in YCbCr, where the chroma window is
    nearly the same for every skin tone; only Y (brightness) really varies.

    The window is deliberately generous. A tight one looks precise and then
    fails the moment the room is lit by a cool bulb or a blue-ish screen, which
    shifts every pixel enough to fall outside it — and a face the detector cannot
    find is a lock that will not open. Being over-inclusive here is safe, because
    the largest-region step below throws away stray patches anyway, and the real
    identity decision is made later by the descriptor. */
function isSkin(r: number, g: number, b: number): boolean {
  const y = 0.299 * r + 0.587 * g + 0.114 * b
  // Near-black pixels carry no reliable colour information at all.
  if (y < 25) return false
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b
  if (cb < 70 || cb > 140 || cr < 128 || cr > 190) return false
  /* Skin is red-dominant — haemoglobin and melanin both push it that way, at
     every skin tone. Without this a dark blue-grey wall lands inside the chroma
     window, the whole frame reads as one enormous "face", and detection fails on
     a picture that has a perfectly good face in it. The slack on blue keeps it
     true under a cool bulb or screen-light, which pushes skin bluer. */
  return r > g && r >= b - 8
}

/**
 * Locate the face as a square box in video coordinates, or null if nothing
 * face-like is in frame.
 *
 * Works on a 64x48 thumbnail, so the whole search costs a few thousand
 * comparisons: the skin mask is built, its largest connected region is found by
 * flood fill, and that region's bounding box becomes the face. Taking the
 * LARGEST region rather than every skin pixel is what stops a hand, a wooden
 * door or a warm-painted wall from dragging the box off the face.
 */
export function locateFace(video: HTMLVideoElement): FaceBox | null {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh) return null

  const c = canvasOf("mask")
  const ctx = c.getContext("2d", { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(video, 0, 0, MASK_W, MASK_H)
  const { data } = ctx.getImageData(0, 0, MASK_W, MASK_H)

  const skin = new Uint8Array(MASK_W * MASK_H)
  let skinCount = 0
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    if (isSkin(data[i], data[i + 1], data[i + 2])) {
      skin[p] = 1
      skinCount++
    }
  }
  const coverage = skinCount / skin.length
  if (skinCount < 40) return null // nothing skin-like at all

  /* Find every skin-coloured region, then pick the one that looks like a FACE —
     not simply the biggest one.

     "Biggest" is what made this fail when the room changed. A wooden door, a
     warm-painted wall, a desk in evening light or a bare arm are all skin-
     coloured and all bigger than a head, so in one room the face won and in the
     next room the furniture did. The crop then described a wall, and no amount
     of threshold tuning could rescue that — which is exactly the "works here,
     fails there" the student kept hitting.

     A face is distinguishable from furniture by shape and placement, so score
     each region on the things that are actually true of a head: roughly as tall
     as it is wide, a sensible fraction of the frame, near the middle (the ring
     on screen puts it there), and not bleeding off several edges the way a wall
     does. Highest score wins. */
  const seen = new Uint8Array(skin.length)
  const stack = new Int32Array(skin.length)
  let best: { n: number; x0: number; y0: number; x1: number; y1: number } | null = null
  let bestScore = -1

  for (let start = 0; start < skin.length; start++) {
    if (!skin[start] || seen[start]) continue
    let top = 0
    stack[top++] = start
    seen[start] = 1
    let n = 0
    let x0 = MASK_W
    let y0 = MASK_H
    let x1 = 0
    let y1 = 0
    while (top > 0) {
      const p = stack[--top]
      const px = p % MASK_W
      const py = (p / MASK_W) | 0
      n++
      if (px < x0) x0 = px
      if (px > x1) x1 = px
      if (py < y0) y0 = py
      if (py > y1) y1 = py
      // 4-connected neighbours
      if (px > 0 && skin[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[top++] = p - 1 }
      if (px < MASK_W - 1 && skin[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[top++] = p + 1 }
      if (py > 0 && skin[p - MASK_W] && !seen[p - MASK_W]) { seen[p - MASK_W] = 1; stack[top++] = p - MASK_W }
      if (py < MASK_H - 1 && skin[p + MASK_W] && !seen[p + MASK_W]) { seen[p + MASK_W] = 1; stack[top++] = p + MASK_W }
    }

    const w = x1 - x0 + 1
    const h = y1 - y0 + 1
    const area = n / skin.length
    if (n < 25 || area > 0.82) continue          // too small to be a head, or the whole room

    // Shape: a head is roughly 0.75 as wide as it is tall. Score 1 at that
    // ratio, falling off either side, so a long wall or a wide desk loses.
    const ratio = w / Math.max(1, h)
    const shape = Math.max(0, 1 - Math.abs(ratio - 0.78) * 1.6)

    // Fill: a head fills most of its bounding box; a scattered wall texture
    // covers a box far larger than its own pixel count.
    const fill = n / Math.max(1, w * h)

    // Placement: the student lines up with the ring, so the face is central.
    const cx = (x0 + x1) / 2 / MASK_W
    const cy = (y0 + y1) / 2 / MASK_H
    const centred = Math.max(0, 1 - (Math.abs(cx - 0.5) + Math.abs(cy - 0.45)) * 1.5)

    // Edges: a face rarely runs off three sides of the frame; a wall does.
    let edges = 0
    if (x0 <= 0) edges++
    if (y0 <= 0) edges++
    if (x1 >= MASK_W - 1) edges++
    if (y1 >= MASK_H - 1) edges++
    const edgePenalty = edges >= 3 ? 0.25 : edges === 2 ? 0.7 : 1

    // Size: prefer a plausible head, without letting sheer size decide.
    const sizeFit = area < 0.02 ? 0.5 : area > 0.55 ? 0.5 : 1

    const score = shape * 1.4 + fill * 1.1 + centred * 1.5 + sizeFit
    const total = score * edgePenalty
    if (total > bestScore) {
      bestScore = total
      best = { n, x0, y0, x1, y1 }
    }
  }
  if (!best) return null

  const bw = best.x1 - best.x0 + 1
  const bh = best.y1 - best.y0 + 1
  // The blob usually runs face + neck; the face is its upper part. Bias the
  // square upward and size it on the width, which is the steadier dimension.
  const sizeMask = Math.max(bw, bh * 0.72)
  const cxMask = best.x0 + bw / 2
  const cyMask = best.y0 + Math.min(bh, sizeMask) / 2

  // Back to video pixels.
  const sx = vw / MASK_W
  const sy = vh / MASK_H
  const size = sizeMask * sx * 1.08 // a little air around the face
  const x = cxMask * sx - size / 2
  const y = cyMask * sy - size / 2

  // Keep the square inside the frame.
  const clamped = Math.min(size, vw, vh)
  return {
    x: Math.max(0, Math.min(x, vw - clamped)),
    y: Math.max(0, Math.min(y, vh - clamped)),
    size: clamped,
    coverage,
  }
}

/* ---- 2. describe it by shape -------------------------------------------- */

/**
 * A histogram-of-oriented-gradients descriptor of the located face.
 *
 * Each 8x8 cell contributes a 9-bin histogram of edge DIRECTIONS, weighted by
 * edge strength, and is normalised on its own. Directions survive a change of
 * lighting; brightness does not, which is the entire point.
 */
/** A centred square, used when the skin search finds nothing.

    Refusing outright when detection fails is what made this feel unusable: an
    unlucky light, a mask of shadow, and the lock simply would not engage. A
    centred square is what the student is lined up with anyway — the ring on
    screen shows them exactly where to sit — so it is a reasonable guess, and it
    is used for BOTH enrolling and unlocking, so the two always describe the
    same region and stay comparable. */
function centreBox(video: HTMLVideoElement): FaceBox | null {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh) return null
  const size = Math.min(vw, vh) * 0.55
  return { x: (vw - size) / 2, y: (vh - size) / 2, size, coverage: 0 }
}

/** The box the last descriptor was taken from, so the UI can draw exactly what
    the matcher looked at. Diagnosing "it will not recognise me" is guesswork
    without this: the student cannot tell whether the camera found their face at
    all or found it and disagreed, and those need opposite fixes. */
let lastBox: FaceBox | null = null
let lastBoxWasGuess = false
let lastDescriptor: Float32Array | null = null

export function lastFaceBox(): { box: FaceBox | null; guessed: boolean } {
  return { box: lastBox, guessed: lastBoxWasGuess }
}

export function faceDescriptor(video: HTMLVideoElement): Float32Array | null {
  const found = locateFace(video)
  const box = found || centreBox(video)
  lastBox = box
  lastBoxWasGuess = !found
  if (!box) { lastDescriptor = null; return null }

  const c = canvasOf("face")
  const ctx = c.getContext("2d", { willReadFrequently: true })
  if (!ctx) return null
  // Crop ONLY the face box, scaled to a fixed square — so a face near or far
  // from the camera produces the same descriptor.
  ctx.drawImage(video, box.x, box.y, box.size, box.size, 0, 0, FACE_PX, FACE_PX)
  const { data } = ctx.getImageData(0, 0, FACE_PX, FACE_PX)

  const gray = new Float32Array(FACE_PX * FACE_PX)
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
  }

  const cells = FACE_PX / CELL // 8
  const desc = new Float32Array(cells * cells * BINS)

  for (let y = 1; y < FACE_PX - 1; y++) {
    for (let x = 1; x < FACE_PX - 1; x++) {
      const gx = gray[y * FACE_PX + x + 1] - gray[y * FACE_PX + x - 1]
      const gy = gray[(y + 1) * FACE_PX + x] - gray[(y - 1) * FACE_PX + x]
      const mag = Math.hypot(gx, gy)
      if (mag < 1e-3) continue
      // Unsigned orientation: an edge and its opposite are the same edge.
      let ang = (Math.atan2(gy, gx) * 180) / Math.PI
      if (ang < 0) ang += 180
      if (ang >= 180) ang -= 180
      const bin = Math.min(BINS - 1, (ang / (180 / BINS)) | 0)
      const cell = ((y / CELL) | 0) * cells + ((x / CELL) | 0)
      desc[cell * BINS + bin] += mag
    }
  }

  // Per-cell L2 normalisation: uneven light across the face cannot let one
  // bright region dominate the descriptor.
  for (let cell = 0; cell < cells * cells; cell++) {
    let sum = 0
    for (let b = 0; b < BINS; b++) {
      const v = desc[cell * BINS + b]
      sum += v * v
    }
    const norm = Math.sqrt(sum) || 1
    for (let b = 0; b < BINS; b++) desc[cell * BINS + b] /= norm
  }
  lastDescriptor = desc
  return desc
}

/* LEARN THE FACE IT JUST LET IN.

   A phone gets easier to unlock the more you use it, because every successful
   unlock is another example of what you look like NOW — this haircut, this
   room, this lamp. Enrolment alone is a single moment frozen in time, and the
   student drifts away from it within days, which is what "it worked yesterday"
   really means.

   So each accepted unlock is appended as an extra template, newest kept and
   oldest adaptive ones discarded. The original enrolment poses are never
   dropped, so the set cannot drift away from the person who set it up. */
const MAX_LEARNED = 10

export function learnFromUnlock(): void {
  if (!lastDescriptor) return
  try {
    const raw = localStorage.getItem(FACE_KEY)
    if (!raw) return
    const box = JSON.parse(raw) as { v?: number; poses?: number[][]; learned?: number[][] }
    if (!box || box.v !== ENROL_VERSION || !Array.isArray(box.poses)) return
    const learned = Array.isArray(box.learned) ? box.learned : []
    learned.push(Array.from(lastDescriptor, (v) => Math.round(v * 1000) / 1000))
    while (learned.length > MAX_LEARNED) learned.shift()
    localStorage.setItem(FACE_KEY, JSON.stringify({ ...box, learned }))
  } catch {
    /* storage full or unavailable: unlocking still worked, it just will not adapt */
  }
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

/* ---- enrol / verify ------------------------------------------------------ */

/**
 * Learn this face across several head positions.
 *
 * Frames where no face can be found are skipped rather than stored, so a moment
 * of looking away cannot poison the enrolment with a picture of the wall.
 * `onProgress` reports 0..1 for the setup ring.
 */
export async function enrollFace(
  video: HTMLVideoElement,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const poses: number[][] = []
  const gap = 5200 / ENROLL_POSES
  // Generous slack: unreadable frames are common and must not cut it short.
  for (let i = 0; i < ENROLL_POSES * 3 && poses.length < ENROLL_POSES; i++) {
    const d = faceDescriptor(video)
    if (d) {
      poses.push(Array.from(d, (v) => Math.round(v * 1000) / 1000))
      onProgress?.(poses.length / ENROLL_POSES)
    }
    await sleep(gap)
  }
  if (poses.length < 5) {
    throw new Error(
      "Could not see your face clearly — make sure it is lit from the front and centred, then try again.",
    )
  }
  try {
    localStorage.setItem(FACE_KEY, JSON.stringify({ v: ENROL_VERSION, poses }))
    localStorage.setItem(METHOD_KEY, "face")
    localStorage.removeItem("minerva.lock.credential")
  } catch {
    throw new Error("Could not save Face unlock on this device.")
  }
  markPassed() // just enrolled on this page load; do not lock the student out
}

/** Wipe an enrolment this build cannot read, and stop Face being the method.

    Faceprints saved by the old pixel-based version are a different length and
    are meaningless here. Leaving them in place would be dangerous rather than
    merely broken: with no readable template, a matcher has nothing to compare
    against, and "no template" is treated as "nothing enrolled, do not trap the
    student" — which would quietly turn the lock into a door that opens for
    anybody. So a stale enrolment is deleted and the device method is cleared,
    which drops this device back to the account PIN — still locked, and Settings
    shows Face as not set up so it can be enrolled again in half a minute. */
function discardStaleEnrolment() {
  try {
    localStorage.removeItem(FACE_KEY)
    if (localStorage.getItem(METHOD_KEY) === "face") {
      localStorage.removeItem(METHOD_KEY)
    }
  } catch {
    /* private mode: nothing was persisted in the first place */
  }
}

/** The enrolled descriptors for THIS build, or [] if there are none. */
function loadTemplates(): Float32Array[] {
  let raw: string | null
  try {
    raw = localStorage.getItem(FACE_KEY)
  } catch {
    raw = null
  }
  if (!raw) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    discardStaleEnrolment()
    return []
  }
  // Current format is {v, poses}; anything else is from an older build.
  const box = parsed as { v?: number; poses?: number[][]; learned?: number[][] }
  if (!box || typeof box !== "object" || box.v !== ENROL_VERSION
      || !Array.isArray(box.poses) || !Array.isArray(box.poses[0])) {
    discardStaleEnrolment()
    return []
  }
  const want = (FACE_PX / CELL) * (FACE_PX / CELL) * BINS
  const rows = ([...box.poses, ...(Array.isArray(box.learned) ? box.learned : [])] as number[][])
    .filter((r) => Array.isArray(r) && r.length === want)
    .map((r) => Float32Array.from(r))
  // Something was stored, but none of it is usable by this build.
  if (!rows.length) discardStaleEnrolment()
  return rows
}

export interface FaceReading {
  /** Best similarity to any enrolled pose, 0..1. */
  score: number
  /** False when no face could be found in the frame at all. */
  faceFound: boolean
  /** Where it looked, so the screen can draw it. */
  box: FaceBox | null
  /** True when detection failed and a centred guess was used instead. */
  guessed: boolean
}

/**
 * Read one live frame. Returns both the score and whether a face was even
 * visible, so the interface can say "move into the frame" instead of leaving
 * the student staring at a meter that will not move.
 */
export function readFace(video: HTMLVideoElement): FaceReading {
  const templates = loadTemplates()
  const live = faceDescriptor(video)
  const { box, guessed } = lastFaceBox()
  if (!live) return { score: 0, faceFound: false, box: null, guessed: true }
  if (!templates.length) return { score: 1, faceFound: true, box, guessed }
  let best = 0
  for (const t of templates) best = Math.max(best, cosineSim(t, live))
  return { score: best, faceFound: !guessed, box, guessed }
}

/** Kept for callers that only want the number. */
export function verifyFaceScore(video: HTMLVideoElement): number {
  return readFace(video).score
}

export function matchThreshold(): number {
  return MATCH_THRESHOLD
}
