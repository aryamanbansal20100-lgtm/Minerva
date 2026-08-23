import { cn } from "@/lib/utils"

/* The Minerva mark: speech resolving into writing.

   Four lines, read top to bottom. The first is a waveform — someone talking,
   all peaks and noise. Each line below it is calmer than the last, until the
   fourth is perfectly straight and stops short, the way the last line of a
   written paragraph does. You watch a voice become a page.

   It is deliberately austere. A prism with a rainbow through it said the same
   thing and looked like a school science poster; the restraint is the point.
   Two colours, no fill, no ornament: the top line carries the brand gradient
   because it is sound, the bottom is plain text colour because it is text, and
   the two in between are the transition. Nothing else earns its place.

   `animate` rolls the mark in — a flat rotation in the plane of the screen, not
   a 3D flip — while it settles from oversized down to its true size. The lines
   then draw in top to bottom, so the resolution happens in front of you rather
   than arriving finished. It holds, then recedes and fades as the app takes
   over. Without it the mark is static, which is what the sidebar and the
   favicon want. */

type Props = {
  size?: number
  animate?: boolean
  className?: string
  /** Unique id so two marks on one page cannot share gradient definitions. */
  idPrefix?: string
}

export default function MinervaMark({
  size = 96,
  animate = false,
  className,
  idPrefix = "minerva",
}: Props) {
  const grad = `${idPrefix}-grad`

  /* Each line is calmer than the one above it, and each draws a beat later.
     `len` is the path length rounded up, used as the dash so the stroke can be
     drawn on rather than faded in. */
  const LINES = [
    { d: "M14 30 L27 16 L37 45 L49 21 L59 39 L71 17 L81 44 L92 25 L106 30",
      len: 190, stroke: `url(#${grad})`, opacity: 1, width: 6, delay: 0.46 },
    { d: "M14 57 L29 48 L44 66 L58 50 L73 63 L88 52 L106 57",
      len: 150, stroke: `url(#${grad})`, opacity: 0.72, width: 5.6, delay: 0.64 },
    { d: "M14 82 L34 77 L55 86 L76 78 L106 82",
      len: 120, stroke: "currentColor", opacity: 0.55, width: 5.4, delay: 0.82 },
    { d: "M14 105 L84 105",
      len: 80, stroke: "currentColor", opacity: 0.85, width: 5.4, delay: 1.00 },
  ]

  return (
    <span
      className={cn("inline-block", className)}
      style={{ lineHeight: 0 }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 120 120"
        fill="none"
        role="img"
        aria-label="Minerva"
        style={
          animate
            ? {
                // One timeline for the whole appearance: roll in, hold, recede.
                // Kept as a single animation so the three phases cannot drift
                // apart the way three separately-delayed ones would.
                transformOrigin: "60px 60px",
                animation: "mark-roll 3.3s cubic-bezier(.33,1,.68,1) both",
              }
            : undefined
        }
      >
        <defs>
          <linearGradient id={grad} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--brand)" />
            <stop offset="100%" stopColor="var(--brand-2)" />
          </linearGradient>
        </defs>

        {LINES.map((l) => (
          <path
            key={l.d}
            d={l.d}
            stroke={l.stroke}
            strokeWidth={l.width}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={l.opacity}
            strokeDasharray={animate ? l.len : undefined}
            style={
              animate
                ? {
                    animation: `mark-write .62s cubic-bezier(.33,1,.68,1) ${l.delay}s both`,
                    // Each line settles at its own opacity, so the fade-in has
                    // to know where it is going rather than assuming 1.
                    ["--to" as string]: String(l.opacity),
                    ["--len" as string]: String(l.len),
                  }
                : undefined
            }
          />
        ))}
      </svg>
    </span>
  )
}

/** Keyframes for the opening sequence. Rendered once by whoever animates. */
export const MARK_KEYFRAMES = `
  @keyframes mark-write {
    from { stroke-dashoffset: var(--len, 190); opacity: 0; }
    to   { stroke-dashoffset: 0; opacity: var(--to, 1); }
  }
  /* Rolls in flat -- rotate() about the Z axis, so it turns in the plane of the
     screen rather than flipping through it -- oversized at first and settling to
     true size. Holds while the lines finish resolving, then pulls back and fades
     so the app arrives rather than the splash merely disappearing.
     Percentages of 3.3s: in by 0.92s, held to 2.57s, gone by 3.3s. */
  @keyframes mark-roll {
    0%   { opacity: 0; transform: rotate(-200deg) scale(1.65); }
    28%  { opacity: 1; transform: rotate(0deg)    scale(1); }
    78%  { opacity: 1; transform: rotate(0deg)    scale(1); }
    100% { opacity: 0; transform: rotate(0deg)    scale(.62); }
  }
  @media (prefers-reduced-motion: reduce) {
    @keyframes mark-roll {
      0%, 100% { opacity: 1; transform: none; }
    }
  }
`
