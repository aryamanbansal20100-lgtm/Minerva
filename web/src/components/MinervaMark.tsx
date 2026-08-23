import { cn } from "@/lib/utils"

/* The Minerva mark: a prism.

   A letter said nothing about the product. A prism says all of it — one
   undifferentiated beam goes in, and what leaves the far side is ordered,
   separated and legible. That is the entire job: forty-five minutes of a
   teacher talking goes in, and definitions, formulas, examples and homework
   come out in bands you can actually read.

   Left to right, which is also the order it animates in:

     the beam      one flat grey line arriving — raw sound, nothing sorted yet
     the prism     the thing that does the work
     the spectrum  five bands, cool to warm, separating in order

   Everything is stroked so it survives at 32px. The prism takes the brand
   gradient; the spectrum is genuinely spectral, because a prism splitting light
   into five shades of the same violet would be a poor advertisement for sorting
   things out.

   `animate` runs the opening: the prism turns in edge-on, the beam strikes, the
   spectrum fans, and then the prism keeps turning while the whole mark pushes
   toward the viewer. Without it the mark is static, which is what the sidebar
   and the favicon want. */

type Props = {
  size?: number
  animate?: boolean
  className?: string
  /** Unique id so two marks on one page cannot share gradient definitions. */
  idPrefix?: string
}

/* Cool to warm, each with its own delay so the bands separate in sequence the
   way refraction actually orders them, rather than appearing together. */
const SPECTRUM = [
  { d: "M70 60 L118 34", stroke: "#8b5cf6", delay: 0.95 },
  { d: "M70 60 L118 46", stroke: "#6366f1", delay: 1.03 },
  { d: "M70 60 L118 58", stroke: "#38bdf8", delay: 1.11 },
  { d: "M70 60 L118 70", stroke: "#2dd4bf", delay: 1.19 },
  { d: "M70 60 L118 82", stroke: "#fbbf24", delay: 1.27 },
]

export default function MinervaMark({
  size = 96,
  animate = false,
  className,
  idPrefix = "minerva",
}: Props) {
  const grad = `${idPrefix}-grad`
  const glass = `${idPrefix}-glass`

  return (
    <span
      className={cn("inline-block", className)}
      style={
        /* Perspective belongs on the parent. Without it rotateY reads as a flat
           horizontal squash instead of something turning in space. */
        animate
          ? { perspective: "620px", lineHeight: 0 }
          : { lineHeight: 0 }
      }
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 128 120"
        fill="none"
        role="img"
        aria-label="Minerva"
        style={
          animate
            ? {
                transformStyle: "preserve-3d",
                animation:
                  "prism-enter .85s cubic-bezier(.22,1,.36,1) .05s both, " +
                  "prism-spin 9s linear 1.6s infinite, " +
                  "prism-push 2.6s cubic-bezier(.4,0,.2,1) both",
              }
            : undefined
        }
      >
        <defs>
          <linearGradient id={grad} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--brand)" />
            <stop offset="100%" stopColor="var(--brand-2)" />
          </linearGradient>
          {/* A faint interior, so it reads as glass with something happening
              inside rather than as an empty triangle. */}
          <linearGradient id={glass} x1="0" y1="0" x2="0.7" y2="1">
            <stop offset="0%" stopColor="var(--brand)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--brand-2)" stopOpacity="0.05" />
          </linearGradient>
        </defs>

        {/* 1. THE BEAM — deliberately grey. Nothing has been separated yet. */}
        <path
          d="M2 52 L44 52"
          stroke="currentColor"
          strokeWidth="5"
          strokeLinecap="round"
          opacity="0.5"
          style={
            animate
              ? { animation: "prism-beam .5s cubic-bezier(.4,0,.2,1) .55s both" }
              : undefined
          }
        />

        {/* 2. THE PRISM */}
        <path
          d="M56 22 L88 80 L24 80 Z"
          fill={`url(#${glass})`}
          stroke={`url(#${grad})`}
          strokeWidth="6"
          strokeLinejoin="round"
          strokeDasharray="200"
          style={
            animate
              ? { animation: "prism-draw .95s cubic-bezier(.65,0,.35,1) .1s both" }
              : undefined
          }
        />

        {/* 3. THE SPECTRUM — separated, ordered, readable. */}
        <g strokeWidth="5" strokeLinecap="round" fill="none">
          {SPECTRUM.map((band) => (
            <path
              key={band.d}
              d={band.d}
              stroke={band.stroke}
              strokeDasharray="56"
              style={
                animate
                  ? {
                      animation: `prism-fan .55s cubic-bezier(.22,1,.36,1) ${band.delay}s both`,
                    }
                  : undefined
              }
            />
          ))}
        </g>
      </svg>
    </span>
  )
}

/** Keyframes for the opening sequence. Rendered once by whoever animates. */
export const MARK_KEYFRAMES = `
  @keyframes prism-enter {
    from { opacity: 0; transform: rotateY(-95deg) scale(.72); }
    to   { opacity: 1; transform: rotateY(0deg) scale(1); }
  }
  @keyframes prism-draw {
    from { stroke-dashoffset: 200; }
    to   { stroke-dashoffset: 0; }
  }
  @keyframes prism-beam {
    from { opacity: 0; transform: translateX(-16px); }
    to   { opacity: .5; transform: translateX(0); }
  }
  @keyframes prism-fan {
    from { stroke-dashoffset: 56; opacity: 0; }
    to   { stroke-dashoffset: 0;  opacity: 1; }
  }
  /* Kept turning once it has arrived, so the mark is never quite still — and
     pushed toward the viewer as the splash clears, so the hand-off to the app
     feels like moving through the prism rather than watching it vanish.
     scale is its own property here so it composes with the rotateY on
     transform instead of overwriting it. */
  @keyframes prism-spin {
    from { transform: rotateY(0deg); }
    to   { transform: rotateY(360deg); }
  }
  @keyframes prism-push {
    0%   { scale: 1; }
    58%  { scale: 1.05; }
    100% { scale: 1.6; }
  }
  @media (prefers-reduced-motion: reduce) {
    @keyframes prism-spin { from { transform: none; } to { transform: none; } }
    @keyframes prism-push { from { scale: 1; } to { scale: 1; } }
  }
`
