import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"

/* The opening animation.

   Two rules keep a splash screen from becoming the thing people hate:

   1. It must never delay the app. This overlays a page that is already
      mounted and loading behind it, so the animation and the first data fetch
      happen at the same time. It is not a loading screen wearing a costume.
   2. It must not play every time you glance at the app. Once per session is
      the whole charm; on the fourth reload it is an obstacle. sessionStorage
      remembers, so a refresh mid-lesson goes straight in.

   The mark draws itself: a stroked circle whose dash offset animates to zero,
   so the ring is written rather than faded in — the same idea as the product,
   something being taken down as it happens. Then the letter lifts in, the
   wordmark follows, and the whole thing scales up and out of the way.

   To use a real logo later: replace the <svg> inside .mark with the exported
   Canva SVG. Everything else — timing, fade, the once-per-session rule —
   keeps working untouched. */

const SEEN_KEY = "minerva.splash.seen"
const TOTAL_MS = 2100

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
        phase === "out" ? "scale-[1.06] opacity-0" : "scale-100 opacity-100",
      )}
      style={{ pointerEvents: phase === "out" ? "none" : "auto" }}
    >
      <style>{`
        @keyframes minerva-ring {
          from { stroke-dashoffset: 302; }
          to   { stroke-dashoffset: 0; }
        }
        @keyframes minerva-letter {
          0%   { opacity: 0; transform: translateY(9px) scale(.86); }
          60%  { opacity: 1; transform: translateY(-2px) scale(1.03); }
          100% { opacity: 1; transform: translateY(0) scale(1); }
        }
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
          style={{ animation: "minerva-glow 2.1s ease-in-out" }}
        />

        <div className="relative grid place-items-center">
          {/* THE MARK — swap this svg for the exported Canva logo */}
          <svg width="96" height="96" viewBox="0 0 104 104" fill="none">
            <defs>
              <linearGradient id="minerva-stroke" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="var(--brand)" />
                <stop offset="100%" stopColor="var(--brand-2)" />
              </linearGradient>
            </defs>
            <circle
              cx="52" cy="52" r="48"
              stroke="url(#minerva-stroke)"
              strokeWidth="3.5"
              strokeLinecap="round"
              strokeDasharray="302"
              style={{
                animation: "minerva-ring 1.15s cubic-bezier(.65,0,.35,1) forwards",
                transform: "rotate(-90deg)",
                transformOrigin: "52px 52px",
              }}
            />
          </svg>

          <span
            className="brand-gradient absolute bg-clip-text font-display text-[42px] font-[650] text-transparent"
            style={{
              animation: "minerva-letter .6s cubic-bezier(.34,1.56,.64,1) .5s both",
            }}
          >
            M
          </span>
        </div>

        <div
          className="mt-5 font-display text-[26px] font-[650] tracking-tight"
          style={{ animation: "minerva-word .55s cubic-bezier(.4,0,.2,1) .85s both" }}
        >
          Minerva
        </div>
        <div
          className="mt-1 font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground"
          style={{ animation: "minerva-word .55s cubic-bezier(.4,0,.2,1) 1.05s both" }}
        >
          notes that write themselves
        </div>
      </div>
    </div>
  )
}
