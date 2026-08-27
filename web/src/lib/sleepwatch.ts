/* sleepwatch.ts — tell "the machine slept" apart from "the tab went to the back".

   Both look identical to a naive timer: a long gap between ticks. The first
   attempt used one number for both and got it wrong in both directions — it
   re-locked on a background tab (irritating), and missed a real lid-close
   (useless). The difference is real, and it is measurable:

     THE CLOCK SPLIT.  Date.now() is wall-clock time and keeps counting while a
       laptop is suspended. performance.now() is monotonic and does NOT accrue
       suspended time. So after a genuine sleep the two disagree, and the size of
       that disagreement IS the length of the sleep. Throttling delays a timer
       but advances both clocks equally, so it produces no drift at all. This is
       the signal that cleanly separates the two cases.

     A VISIBLE PAGE IS NEVER THROTTLED.  Chrome only throttles timers in hidden
       tabs. So if the page is visible and a 5-second heartbeat has not fired for
       20 seconds, the CPU stopped — that is sleep, not background throttling.

     HIDDEN TIME IS JUDGED SEPARATELY, by wall clock, against a much longer
       "you walked away" policy. A tab switch or an app switch is seconds; it
       never approaches that, so switching away stays free.

   Waking is also handled properly. A resume often fires no visibility or focus
   event at all (the tab was visible and focused before the lid closed and still
   is afterwards), so this listens to every signal a wake can produce — the
   heartbeat, resume/pageshow/online, and the student's first click or keypress —
   and checks on all of them, so the lock is up before they can touch anything.

   Plain DOM APIs only: no dependencies, no network, nothing the CSP touches. */

/** How often to take the pulse. Short, so a silent wake is caught within
    seconds rather than tens of seconds. While hidden, Chrome throttles this to
    about once a minute by itself, so it costs nothing in the background. */
const BEAT_MS = 5_000

/** A visible page that misses this much heartbeat has had its CPU stopped. */
const VISIBLE_GAP_MS = 20_000

/** Wall-vs-monotonic disagreement that counts as a genuine suspend. */
const DRIFT_MS = 20_000

/** Hidden for this long is "walked away", not "checked another tab". */
const HIDDEN_IDLE_MS = 15 * 60_000

/** A clock that jumps BACKWARDS is a time correction, never a reason to lock. */
const BACKWARDS_MS = -5_000

export type SleepReason = "suspend" | "stalled" | "away"

/**
 * Watch for the machine sleeping. Calls `onSlept` once each time it detects one,
 * and returns a function that stops watching.
 */
export function watchForSleep(onSlept: (reason: SleepReason) => void): () => void {
  let baseWall = Date.now()
  let baseMono = performance.now()
  // When the current stretch has included any hidden time, the visible-gap rule
  // must not fire: the gap legitimately accrued while Chrome was throttling us.
  let hiddenLeg = document.visibilityState !== "visible"
  let hiddenSince: number | null = hiddenLeg ? Date.now() : null
  let stopped = false

  const rebase = (wall: number, mono: number) => {
    baseWall = wall
    baseMono = mono
    if (document.visibilityState === "visible") {
      hiddenSince = null
      hiddenLeg = false
    }
  }

  const evaluate = () => {
    if (stopped) return
    const wall = Date.now()
    const mono = performance.now()
    const wallGap = wall - baseWall
    const drift = wallGap - (mono - baseMono)
    const visible = document.visibilityState === "visible"
    const hiddenFor = hiddenSince == null ? 0 : wall - hiddenSince

    // The clock moved backwards (an NTP correction, or the user changed it).
    // Reset the baseline and do nothing — this is not evidence of anything.
    if (drift < BACKWARDS_MS) {
      rebase(wall, mono)
      return
    }

    let reason: SleepReason | null = null
    if (drift > DRIFT_MS) {
      // Wall clock ran on while the monotonic clock stood still: suspended.
      reason = "suspend"
    } else if (!hiddenLeg && visible && wallGap > VISIBLE_GAP_MS) {
      // Visible pages are never throttled, so a missing heartbeat means the CPU
      // stopped. Catches suspends where the platform advances both clocks.
      reason = "stalled"
    } else if (hiddenFor > HIDDEN_IDLE_MS) {
      reason = "away"
    }

    rebase(wall, mono)
    if (reason) onSlept(reason)
  }

  /* Order matters here. On a Windows resume that lands on the sign-in screen,
     Chrome marks the page hidden at the moment of resume — so re-baselining
     before evaluating would erase the very drift that proves it slept. Always
     evaluate first, then record the new hidden stretch. */
  const onVisibility = () => {
    evaluate()
    if (document.visibilityState !== "visible") {
      hiddenSince = Date.now()
      hiddenLeg = true
    }
  }

  const onHide = () => {
    if (hiddenSince == null) hiddenSince = Date.now()
    hiddenLeg = true
  }

  const beat = window.setInterval(evaluate, BEAT_MS)

  // Every signal a wake can produce. Names the browser does not know are simply
  // never fired, so none of this needs feature detection.
  document.addEventListener("visibilitychange", onVisibility)
  document.addEventListener("resume", evaluate)   // Page Lifecycle: unfrozen
  document.addEventListener("freeze", onHide)     // Page Lifecycle: about to stop
  window.addEventListener("focus", evaluate)
  window.addEventListener("online", evaluate)     // the network often returns first
  window.addEventListener("pageshow", evaluate)
  window.addEventListener("pagehide", onHide)
  // The student's first touch after waking, so the lock is up before they act.
  window.addEventListener("pointerdown", evaluate, true)
  window.addEventListener("keydown", evaluate, true)

  return () => {
    stopped = true
    window.clearInterval(beat)
    document.removeEventListener("visibilitychange", onVisibility)
    document.removeEventListener("resume", evaluate)
    document.removeEventListener("freeze", onHide)
    window.removeEventListener("focus", evaluate)
    window.removeEventListener("online", evaluate)
    window.removeEventListener("pageshow", evaluate)
    window.removeEventListener("pagehide", onHide)
    window.removeEventListener("pointerdown", evaluate, true)
    window.removeEventListener("keydown", evaluate, true)
  }
}

/* Exported so the behaviour can be tested without a real laptop lid: the pure
   decision, given two clock readings and the visibility history. */
export function decideForTest(input: {
  wallGap: number
  monoGap: number
  visible: boolean
  hiddenLeg: boolean
  hiddenFor: number
}): SleepReason | null {
  const drift = input.wallGap - input.monoGap
  if (drift < BACKWARDS_MS) return null
  if (drift > DRIFT_MS) return "suspend"
  if (!input.hiddenLeg && input.visible && input.wallGap > VISIBLE_GAP_MS) return "stalled"
  if (input.hiddenFor > HIDDEN_IDLE_MS) return "away"
  return null
}
