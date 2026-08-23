import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"
import MinervaMark, { MARK_KEYFRAMES } from "@/components/MinervaMark"

/* The opening animation.

   Two rules keep a splash screen from becoming the thing people hate:

   1. It must never delay the app. This overlays a page that is already
      mounted and loading behind it, so the animation and the first data fetch
      happen at the same time. It is not a loading screen wearing a costume.
   2. It must not play every time you glance at the app. Once per session is
      the whole charm; on the fourth reload it is an obstacle. sessionStorage
      remembers, so a refresh mid-lesson goes straight in.

   The prism turns in edge-on, a flat grey beam strikes it, and five bands
   separate out in order. It then keeps rotating while pushing toward the
   viewer, so handing over to the app reads as moving through the prism rather
   than watching it disappear. The wordmark arrives once the spectrum has
   finished separating, not before — the point of the mark is the separation,
   and talking over it would waste it. */

const SEEN_KEY = "minerva.splash.seen"
const TOTAL_MS = 3300

export default function SplashLogo() {
  const [phase, setPhase] = useState<"hidden" | "in" | "out">(() => {
    try {
      if (sessionStorage.getItem(SEEN_KEY)) return "hidden"
    } catch {
      /* private mode: just play it */
    }
    if (typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return "hidden"
    }
    return "in"
  })

  useEffect(() => {
    if (phase !== "in") return
    try {
      sessionStorage.setItem(SEEN_KEY, "1")
    } catch {
      /* nothing to remember it with; it will simply play again */
    }
    const leave = setTimeout(() => setPhase("out"), TOTAL_MS - 450)
    const gone = setTimeout(() => setPhase("hidden"), TOTAL_MS)
    return () => {
      clearTimeout(leave)
      clearTimeout(gone)
    }
    /* Deliberately empty deps: this schedules the whole sequence once, on
       mount. Keyed on `phase` it looked right and was not — the moment the
       first timer flipped phase to "out", the effect re-ran and its cleanup
       cancelled the second timer, so the splash faded to 0 and then sat on
       screen for ever with the app unreachable behind it. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (phase === "hidden") return null

  return (
    <div
      aria-hidden
      className={cn(
        "fixed inset-0 z-[100] grid place-items-center bg-background",
        "transition-[opacity,transform] duration-[450ms] ease-[cubic-bezier(.4,0,.2,1)]",
        phase === "out" ? "scale-[1.02] opacity-0" : "scale-100 opacity-100",
      )}
      style={{ pointerEvents: phase === "out" ? "none" : "auto" }}
    >
      <style>{`
        ${MARK_KEYFRAMES}
        @keyframes minerva-word {
          from { opacity: 0; transform: translateY(7px); letter-spacing: .12em; }
          to   { opacity: 1; transform: translateY(0);  letter-spacing: -.02em; }
        }
        @keyframes minerva-glow {
          0%, 100% { opacity: .18; }
          50%      { opacity: .42; }
        }
      `}</style>

      <div className="relative grid place-items-center">
        {/* the brand glow, breathing once behind the mark */}
        <div
          className="brand-gradient pointer-events-none absolute h-40 w-40 rounded-full blur-3xl"
          style={{ animation: "minerva-glow 3.3s ease-in-out" }}
        />

        <div className="relative grid place-items-center">
          {/* The mark tells the story on its own: sound arriving, captured at
              the nib, becoming written lines. */}
          <MinervaMark size={120} animate idPrefix="splash" />
        </div>

        <div
          className="mt-5 font-display text-[26px] font-[650] tracking-tight"
          style={{ animation: "minerva-word .55s cubic-bezier(.4,0,.2,1) 1.95s both" }}
        >
          Minerva
        </div>
        <div
          className="mt-1 font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground"
          style={{ animation: "minerva-word .55s cubic-bezier(.4,0,.2,1) 2.15s both" }}
        >
          notes that write themselves
        </div>
      </div>
    </div>
  )
}
