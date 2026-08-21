/* ==========================================================================
   StatRow — the dashboard strip that sits at the top of every screen.

   This is the one component the whole app borrows its manners from. It came
   off the Timetable page, which is the only screen the student liked, so the
   geometry here is normative rather than decorative:

     - a small uppercase letterspaced label, in the quietest grey
     - a big monospaced value with tabular numerals, so a 7 and a 1 take the
       same width and the numbers stop twitching as they update
     - a small grey sub-label that says what the number counts

   The value turns red — and only the value — when the number is bad. The card
   never turns red: a bordered red box shouts, a red numeral tells you.

   The row is auto-fit rather than a fixed four-up, so it reflows to two-up and
   one-up on a narrow window with no media query and no breakpoint logic.
   ========================================================================== */

import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/** One card, written out. This is the shape to reach for in new code. */
export type StatFields = {
  /** Small uppercase label, e.g. "Left today". */
  label: string
  /** The big mono value. Numbers and short strings both read well. */
  value: ReactNode
  /** Small grey line under the value, e.g. "periods". */
  sub?: string
  /** Paint the value red. The label and sub stay grey. */
  alert?: boolean
}

/**
 * The k/v/s shorthand carried over from the vanilla `statRow(cards)` helper.
 *
 * Accepted so the screens ported straight from app.js keep working unchanged;
 * `label`/`value`/`sub` is the form to write from here on.
 */
export type StatShorthand = {
  k: string
  v: ReactNode
  s?: string
  alert?: boolean
}

/** Either spelling of a card. */
export type Stat = StatFields | StatShorthand

function normalise(stat: Stat): StatFields {
  return "label" in stat
    ? stat
    : { label: stat.k, value: stat.v, sub: stat.s, alert: stat.alert }
}

/* Cards arrive rather than snapping in, staggered a frame apart. Keyframes
   cannot be expressed as a Tailwind utility, so they ride along as a hoisted
   stylesheet — React dedupes it by `href`, so mounting several rows still
   yields one <style> in the head. */
const RISE_CSS = `
@keyframes evie-rise { from { opacity: 0; transform: translateY(6px); } }
.evie-rise { animation: evie-rise .22s ease both; }
@media (prefers-reduced-motion: reduce) { .evie-rise { animation: none; } }
`

/**
 * The `rise` keyframes, on their own.
 *
 * Exported because the Timetable day columns want the same entrance and
 * should not have to render a StatRow to get it.
 */
export function RiseKeyframes() {
  return (
    <style href="evie-rise" precedence="medium">
      {RISE_CSS}
    </style>
  )
}

/** A single stat card. Exported so a screen can place one on its own. */
export function StatCard(props: Stat & { index?: number }) {
  const { label, value, sub, alert } = normalise(props)
  const index = props.index ?? 0

  return (
    <div
      className={cn(
        "evie-rise rounded-[9px] border bg-card px-4 py-[14px]",
        "shadow-[0_1px_2px_rgba(20,20,26,0.04)]",
        "transition-transform duration-[140ms] ease-out hover:-translate-y-0.5",
      )}
      style={{ animationDelay: `${Math.min(index, 3) * 0.04}s` }}
    >
      <div className="text-[11px] font-bold uppercase tracking-[0.07em] text-muted-foreground">
        {label}
      </div>
      {/* 26px is what gives the card its mass — do not tighten the leading. */}
      <div
        className={cn(
          "mt-[5px] truncate font-mono text-[26px] tabular-nums",
          alert && "text-late",
        )}
      >
        {value}
      </div>
      {sub ? (
        <div className="mt-[2px] truncate text-[12px] text-muted-foreground">{sub}</div>
      ) : null}
    </div>
  )
}

export type StatRowProps = {
  /** The cards, in order. */
  stats?: Stat[]
  /** Alias for `stats`, matching the old `statRow(cards)` call sites. */
  cards?: Stat[]
  className?: string
}

/**
 * A row of stat cards.
 *
 * @example
 * <StatRow stats={[
 *   { label: "Overdue", value: 3, sub: "not handed in", alert: true },
 *   { label: "This week", value: 12, sub: "periods total" },
 * ]} />
 */
export function StatRow({ stats, cards, className }: StatRowProps) {
  const list = stats ?? cards ?? []
  if (!list.length) return null

  return (
    <>
      <RiseKeyframes />
      <div
        className={cn(
          "mb-[22px] grid gap-3",
          "[grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]",
          className,
        )}
      >
        {list.map((stat, i) => (
          <StatCard key={`${i}-${"label" in stat ? stat.label : stat.k}`} index={i} {...stat} />
        ))}
      </div>
    </>
  )
}

export default StatRow
