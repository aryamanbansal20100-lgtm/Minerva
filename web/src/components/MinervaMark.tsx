import { cn } from "@/lib/utils"

/* The Minerva mark.

   A plain letter M says nothing about the product. This one is the product in
   one glyph, read left to right — which is also the order it animates in:

     it is captured     the M itself, drawn as one continuous stroke, its middle
                        vertex pulled down into a pen nib — the moment speech
                        becomes writing
     it becomes notes   two ruled lines beneath, written out left to right, the
                        second shorter as a real last line of a paragraph is

   Everything is stroked rather than filled so it stays legible at 32px, and
   every colour comes from currentColor or the brand gradient so it inherits the
   theme instead of carrying baked-in hex.

   `animate` drives the opening sequence. Without it the mark renders static,
   which is what the sidebar and the favicon need. */

type Props = {
  size?: number
  animate?: boolean
  className?: string
  /** Unique id so two marks on one page do not share gradient definitions. */
  idPrefix?: string
}

export default function MinervaMark({
  size = 96,
  animate = false,
  className,
  idPrefix = "minerva",
}: Props) {
  const grad = `${idPrefix}-grad`

  return (
    <svg
      width={size}
      height={size}
      viewBox="21 28 92 92"
      fill="none"
      className={cn(className)}
      role="img"
      aria-label="Minerva"
    >
      <defs>
        <linearGradient id={grad} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--brand)" />
          <stop offset="100%" stopColor="var(--brand-2)" />
        </linearGradient>
      </defs>

      {/* 1. CAPTURED — the M, one continuous stroke. Its middle vertex sits
             lower than a normal M so it reads as a nib coming to a point. */}
      <path
        d="M38 84 L38 36 L64 66 L90 36 L90 84"
        stroke={`url(#${grad})`}
        strokeWidth="7"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray="180"
        style={
          animate
            ? { animation: "mark-draw .9s cubic-bezier(.65,0,.35,1) .1s both" }
            : undefined
        }
      />

      {/* the nib itself: a small solid point at the vertex, where speech
          becomes ink */}
      <circle
        cx="64"
        cy="66"
        r="4.5"
        fill={`url(#${grad})`}
        style={
          animate
            ? { animation: "mark-nib .35s cubic-bezier(.34,1.56,.64,1) .8s both" }
            : undefined
        }
      />

      {/* 2. BECOMING NOTES — ruled lines written out beneath. The second is
             shorter, the way a real last line of a paragraph stops early. */}
      <g stroke="currentColor" strokeWidth="5" strokeLinecap="round" opacity="0.55">
        <path
          d="M38 100 L96 100"
          strokeDasharray="58"
          style={
            animate
              ? { animation: "mark-rule .45s cubic-bezier(.4,0,.2,1) .9s both" }
              : undefined
          }
        />
        <path
          d="M38 112 L74 112"
          strokeDasharray="36"
          style={
            animate
              ? { animation: "mark-rule .45s cubic-bezier(.4,0,.2,1) 1.07s both" }
              : undefined
          }
        />
      </g>
    </svg>
  )
}

/** Keyframes for the opening sequence. Rendered once by whoever animates. */
export const MARK_KEYFRAMES = `
    to   { opacity: var(--wave-opacity, .9); transform: translateX(0); }
  }
  @keyframes mark-draw {
    from { stroke-dashoffset: 180; }
    to   { stroke-dashoffset: 0; }
  }
  @keyframes mark-nib {
    from { opacity: 0; transform: scale(0); transform-origin: 64px 66px; }
    to   { opacity: 1; transform: scale(1); transform-origin: 64px 66px; }
  }
  @keyframes mark-rule {
    from { stroke-dashoffset: 58; opacity: 0; }
    to   { stroke-dashoffset: 0;  opacity: .55; }
  }
`
