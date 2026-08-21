/* ==========================================================================
   shapes.ts — the geometry behind the seven diagram shapes.

   Ported from ui/diagram.js. Everything here is pure: a spec goes in, a set of
   positioned primitives comes out. React does nothing but paint them, which
   keeps the layout maths readable and lets the same numbers be reasoned about
   without a browser.

     flow       a process with arrows
     cycle      a loop that comes back round
     mindmap    a centre with branches
     hierarchy  a tree
     timeline   dated points along a line
     compare    two columns against shared aspects
     graph      labelled axes with lines or curves

   Two things the original was careful about and this keeps:

   1. Text wrapping is MEASURED, not guessed. The old file approximated 6.9px
      per character; here a canvas measures the real string in the real font, so
      "Aggregate demand" and "Illlll" no longer claim the same width. Boxes are
      then sized from the wrapped result, so a label can never overflow one.

   2. Labels never overlap. Where the original could collide — a cycle of eight
      steps, a mindmap branch with six children, two graph curves ending at the
      same point — the radius, row advance or label y is solved for instead of
      hard-coded. Under the counts the original handled well the numbers come
      out identical to the original's.
   ========================================================================== */

/* --------------------------------------------------------------- the spec */

export type FlowNode = { id?: string; label?: string }
export type FlowEdge = { from?: string; to?: string; label?: string }
export type FlowSpec = {
  kind: "flow"
  title?: string
  nodes?: FlowNode[]
  edges?: FlowEdge[]
}

export type CycleSpec = {
  kind: "cycle"
  title?: string
  steps?: (string | { label?: string })[]
}

export type Branch = { label?: string; children?: string[] }
export type MindmapSpec = {
  kind: "mindmap"
  title?: string
  centre?: string
  center?: string
  branches?: Branch[]
}

export type HierarchySpec = {
  kind: "hierarchy"
  title?: string
  root?: string
  children?: Branch[]
}

export type TimelinePoint = { when?: string; what?: string }
export type TimelineSpec = { kind: "timeline"; title?: string; points?: TimelinePoint[] }

export type CompareRow = { aspect?: string; left?: string; right?: string }
export type CompareSpec = {
  kind: "compare"
  title?: string
  columns?: string[]
  rows?: CompareRow[]
}

/** Points are [x, y] on a 0-100 scale in both directions — the model never has
 *  to think in pixels, and y is flipped here because SVG counts downwards. */
export type GraphPoint = [number, number] | { x?: number; y?: number }
export type GraphLine = { label?: string; dashed?: boolean; points?: GraphPoint[] }
export type GraphSpec = {
  kind: "graph"
  title?: string
  x?: string
  y?: string
  note?: string
  lines?: GraphLine[]
}

export type DiagramSpec =
  | FlowSpec
  | CycleSpec
  | MindmapSpec
  | HierarchySpec
  | TimelineSpec
  | CompareSpec
  | GraphSpec

/** What actually arrives from /api: JSON of uncertain quality. Every reader
 *  below coerces rather than trusts, which is why a spec is read as this. */
export type AnySpec = Record<string, unknown>

export const DIAGRAM_KINDS = [
  "flow",
  "cycle",
  "mindmap",
  "hierarchy",
  "timeline",
  "compare",
  "graph",
] as const
export type DiagramKind = (typeof DIAGRAM_KINDS)[number]

/* ------------------------------------------------------------- the palette

   Every colour is a theme token, so light and dark both work with no second
   set of values here. The old file's four ink levels collapse to two: the new
   theme is near-monochrome and a third grey would only muddy it. */

export const COLOR = {
  ink: "var(--color-foreground)",
  inkSoft: "var(--color-muted-foreground)",
  card: "var(--color-card)",
  sunk: "var(--color-muted)",
  line: "var(--color-border)",
  lineStrong: "var(--color-input)",
  /* Near-black in light, near-white in dark — the same weight as a primary
     button, never a pastel fill. */
  fill: "var(--color-primary)",
  onFill: "var(--color-primary-foreground)",
  /* Curves are keyed by colour, in the old file's order. */
  series: [
    "var(--color-ok)",
    "var(--color-info)",
    "var(--color-warn)",
    "var(--color-late)",
  ],
} as const

/* ---------------------------------------------------------------- reading */

const str = (v: unknown): string =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : ""

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

const rec = (v: unknown): AnySpec =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as AnySpec) : {}

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const first = (o: AnySpec, ...keys: string[]): string => {
  for (const k of keys) {
    const s = str(o[k]).trim()
    if (s) return s
  }
  return ""
}

/** A step, branch or child may be a bare string or an object around one. */
const labelOf = (v: unknown): string =>
  typeof v === "string" || typeof v === "number"
    ? str(v)
    : first(rec(v), "label", "text", "name", "title", "step", "what", "id")

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`

/* ------------------------------------------------------------- measuring */

const SANS = 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
const MONO = 'ui-monospace, "Cascadia Mono", Consolas, monospace'
const CHAR_W = 6.9 // fallback: approx px per character at 12.5px sans

let ctx: CanvasRenderingContext2D | null | undefined
function context(): CanvasRenderingContext2D | null {
  if (ctx === undefined) {
    try {
      ctx = document.createElement("canvas").getContext("2d")
    } catch {
      ctx = null
    }
  }
  return ctx
}

const widths = new Map<string, number>()

/** Width of a string in px, as the browser will actually draw it. */
export function measure(text: string, size = 12.5, weight = 400, mono = false): number {
  if (!text) return 0
  const key = `${size}|${weight}|${mono ? 1 : 0}|${text}`
  const hit = widths.get(key)
  if (hit !== undefined) return hit
  const c = context()
  let w: number
  if (c) {
    c.font = `${weight} ${size}px ${mono ? MONO : SANS}`
    w = c.measureText(text).width
  } else {
    w = text.length * CHAR_W * (size / 12.5) * (mono ? 1.06 : 1)
  }
  if (widths.size > 4000) widths.clear()
  widths.set(key, w)
  return w
}

export type WrapOptions = {
  size?: number
  weight?: number
  mono?: boolean
  maxLines?: number
}

/** Trim a single unbreakable word until it fits, with an ellipsis. */
function clip(word: string, maxWidth: number, o: Required<WrapOptions>): string {
  let cut = word
  while (cut.length > 1 && measure(cut + "…", o.size, o.weight, o.mono) > maxWidth) {
    cut = cut.slice(0, -1)
  }
  return cut + "…"
}

/** Greedy wrap on measured width. Always returns at least one line. */
export function wrap(text: string, maxWidth: number, options: WrapOptions = {}): string[] {
  const o: Required<WrapOptions> = {
    size: options.size ?? 12.5,
    weight: options.weight ?? 400,
    mono: options.mono ?? false,
    maxLines: options.maxLines ?? 4,
  }
  const fits = (s: string) => measure(s, o.size, o.weight, o.mono) <= maxWidth
  const words = str(text).trim().split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ""
  let dropped = false

  for (const w of words) {
    const candidate = line ? line + " " + w : w
    if (fits(candidate)) {
      line = candidate
      continue
    }
    if (line) lines.push(line)
    if (lines.length >= o.maxLines) {
      line = ""
      dropped = true
      break
    }
    line = fits(w) ? w : clip(w, maxWidth, o)
  }
  if (line) {
    if (lines.length < o.maxLines) lines.push(line)
    else dropped = true
  }
  if (!lines.length) return [""]
  if (dropped) {
    const last = lines[lines.length - 1]
    lines[lines.length - 1] = fits(last + "…") ? last + "…" : clip(last, maxWidth, o)
  }
  return lines
}

/** Height of a wrapped block, matching how TextLines paints it. */
export const blockHeight = (lines: number, size: number): number => lines * size * 1.25

/* -------------------------------------------------------------- primitives */

export type Anchor = "start" | "middle" | "end"

export type TextRun = {
  lines: string[]
  x: number
  y: number
  size: number
  weight: number
  anchor: Anchor
  fill: string
  mono?: boolean
  rotate?: string
}

export type BoxShape = {
  x: number
  y: number
  w: number
  h: number
  fill: string
  stroke: string
  radius: number
}

export type RuleShape = {
  x1: number
  y1: number
  x2: number
  y2: number
  stroke: string
  width: number
}

/** The pill behind an edge label, so the line does not run through the text. */
export type PillShape = { text: string; x: number; y: number; w: number }
export type ArrowShape = { x1: number; y1: number; x2: number; y2: number; label?: PillShape }

export type BadgeShape = { cx: number; cy: number; r: number; fill: string; text: string }

export type CurveShape = { d: string; stroke: string; width: number; dashed: boolean }

const text = (
  lines: string[],
  x: number,
  y: number,
  o: Partial<TextRun> = {},
): TextRun => ({
  lines,
  x,
  y,
  size: o.size ?? 12.5,
  weight: o.weight ?? 400,
  anchor: o.anchor ?? "middle",
  fill: o.fill ?? COLOR.ink,
  mono: o.mono,
  rotate: o.rotate,
})

const box = (
  x: number,
  y: number,
  w: number,
  h: number,
  o: Partial<BoxShape> = {},
): BoxShape => ({
  x,
  y,
  w,
  h,
  fill: o.fill ?? COLOR.card,
  stroke: o.stroke ?? COLOR.lineStrong,
  radius: o.radius ?? 9,
})

/** A rectangle rounded on its top corners only — used for the compare header,
 *  which butts straight onto the first row and must not show a gap there. */
export function roundedTopPath(x: number, y: number, w: number, h: number, r: number): string {
  return (
    `M ${x} ${y + h} L ${x} ${y + r} Q ${x} ${y} ${x + r} ${y} ` +
    `L ${x + w - r} ${y} Q ${x + w} ${y} ${x + w} ${y + r} L ${x + w} ${y + h} Z`
  )
}

/* ---------------------------------------------------------------- layouts */

type LayoutBase = { width: number; height: number; meta: string }

export type FlowLayout = LayoutBase & {
  kind: "flow"
  nodes: { box: BoxShape; text: TextRun }[]
  arrows: ArrowShape[]
}

export type CycleLayout = LayoutBase & {
  kind: "cycle"
  arrows: ArrowShape[]
  steps: { box: BoxShape; text: TextRun; badge: BadgeShape }[]
}

export type MindmapLayout = LayoutBase & {
  kind: "mindmap"
  centre: { box: BoxShape; text: TextRun }
  branches: { box: BoxShape; text: TextRun; path: string; children: TextRun[] }[]
}

export type HierarchyLayout = LayoutBase & {
  kind: "hierarchy"
  root: { box: BoxShape; text: TextRun }
  children: { box: BoxShape; text: TextRun; path: string; leaves: TextRun[] }[]
}

export type TimelineLayout = LayoutBase & {
  kind: "timeline"
  axis: RuleShape
  points: { dot: BadgeShape; when: TextRun; what: TextRun }[]
}

export type CompareLayout = LayoutBase & {
  kind: "compare"
  headerPath: string
  headings: TextRun[]
  rows: { rule: RuleShape | null; aspect: TextRun; left: TextRun; right: TextRun }[]
  dividers: RuleShape[]
}

export type GraphLayout = LayoutBase & {
  kind: "graph"
  axes: RuleShape[]
  xLabel: TextRun
  yLabel: TextRun
  origin: TextRun
  curves: { curve: CurveShape; label: TextRun | null }[]
  note: TextRun | null
}

export type DiagramLayout =
  | FlowLayout
  | CycleLayout
  | MindmapLayout
  | HierarchyLayout
  | TimelineLayout
  | CompareLayout
  | GraphLayout

/* ------------------------------------------------------------------- flow */

export function layoutFlow(spec: AnySpec): FlowLayout | null {
  const raw = arr(spec.nodes).slice(0, 10)
  if (!raw.length) return null

  const W = 210
  const PAD = 16
  const MIN_H = 46
  const GAP = 34
  const X = 60

  const laid = raw.map((n, i) => {
    const lines = wrap(labelOf(n), W - PAD * 2, { size: 12.5, weight: 500, maxLines: 3 })
    return {
      id: str(rec(n).id) || `node-${i}`,
      lines,
      h: Math.max(MIN_H, 20 + lines.length * 16),
      y: 0,
    }
  })

  let y = 10
  for (const n of laid) {
    n.y = y
    y += n.h + GAP
  }
  const height = y - GAP + 10

  /* Ids first, then index aliases, so an edge written as {from:"0"} still
     lands but never steals a node whose real id happens to be "0". */
  const byId = new Map<string, (typeof laid)[number]>()
  for (const n of laid) if (!byId.has(n.id)) byId.set(n.id, n)
  laid.forEach((n, i) => {
    if (!byId.has(String(i))) byId.set(String(i), n)
  })

  const given = arr(spec.edges)
    .map((e) => rec(e))
    .filter((e) => first(e, "from", "source") && first(e, "to", "target"))
  const edges = given.length
    ? given.map((e) => ({
        from: first(e, "from", "source"),
        to: first(e, "to", "target"),
        label: first(e, "label", "text"),
      }))
    : laid.slice(0, -1).map((n, i) => ({ from: n.id, to: laid[i + 1].id, label: "" }))

  const arrows: ArrowShape[] = []
  for (const e of edges) {
    const a = byId.get(e.from)
    const b = byId.get(e.to)
    if (!a || !b || a === b) continue
    arrows.push({
      x1: X + W / 2,
      y1: a.y + a.h,
      x2: X + W / 2,
      y2: b.y - 4,
      label: e.label
        ? {
            text: e.label,
            x: X + W / 2,
            y: (a.y + a.h + b.y - 4) / 2,
            w: measure(e.label, 11) + 14,
          }
        : undefined,
    })
  }

  return {
    kind: "flow",
    width: W + 120,
    height,
    meta: plural(laid.length, "step"),
    nodes: laid.map((n) => ({
      box: box(X, n.y, W, n.h),
      text: text(n.lines, X + W / 2, n.y + n.h / 2, { weight: 500 }),
    })),
    arrows,
  }
}

/* ------------------------------------------------------------------ cycle */

/** The smallest radius at which no two boxes on the ring touch.

    The original pinned R at 132, which is right up to six steps and wrong at
    eight: the boxes either side of the top sit 39px apart vertically and 93px
    apart horizontally, so a 150x52 box overlaps its neighbour. Both offsets
    scale linearly with R, so the radius that clears a given pair is solvable
    directly, and the answer for six steps or fewer is still 132. */
function ringRadius(angles: number[], needX: number, needY: number, min: number): number {
  let r = min
  for (let i = 0; i < angles.length; i++) {
    for (let j = i + 1; j < angles.length; j++) {
      const dx = Math.abs(Math.cos(angles[j]) - Math.cos(angles[i]))
      const dy = Math.abs(Math.sin(angles[j]) - Math.sin(angles[i]))
      const byX = dx > 1e-6 ? needX / dx : Infinity
      const byY = dy > 1e-6 ? needY / dy : Infinity
      const need = Math.min(byX, byY)
      if (Number.isFinite(need)) r = Math.max(r, need)
    }
  }
  return Math.min(r, 320)
}

export function layoutCycle(spec: AnySpec): CycleLayout | null {
  const steps = arr(spec.steps).slice(0, 8).map(labelOf).filter(Boolean)
  if (steps.length < 2) return null

  const BW = 150
  const BH = 52
  const PAD = 96

  const laid = steps.map((s) => {
    const lines = wrap(s, BW - 26, { size: 12, weight: 500, maxLines: 3 })
    return { lines, h: Math.max(BH, 18 + lines.length * 16) }
  })
  const tallest = Math.max(...laid.map((l) => l.h))
  const angles = steps.map((_, i) => -Math.PI / 2 + (i * 2 * Math.PI) / steps.length)
  const R = ringRadius(angles, BW + 14, tallest + 12, 132)

  const size = (R + PAD) * 2
  const cx = size / 2
  const cy = size / 2
  const pts = angles.map((a) => ({ x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R, a }))

  const arrows: ArrowShape[] = pts.map((p, i) => {
    const next = pts[(i + 1) % pts.length]
    const mid = (p.a + (next.a > p.a ? next.a : next.a + Math.PI * 2)) / 2
    return {
      x1: p.x + Math.cos(p.a + 0.5) * 30,
      y1: p.y + Math.sin(p.a + 0.5) * 30,
      x2: cx + Math.cos(mid) * (R + 6),
      y2: cy + Math.sin(mid) * (R + 6),
    }
  })

  return {
    kind: "cycle",
    width: size,
    height: size,
    meta: plural(steps.length, "step"),
    arrows,
    steps: pts.map((p, i) => {
      const { lines, h } = laid[i]
      return {
        box: box(p.x - BW / 2, p.y - h / 2, BW, h, { fill: COLOR.sunk }),
        text: text(lines, p.x, p.y, { size: 12, weight: 500 }),
        badge: {
          cx: p.x - BW / 2 + 2,
          cy: p.y - h / 2 + 2,
          r: 9,
          fill: COLOR.fill,
          text: String(i + 1),
        },
      }
    }),
  }
}

/* ---------------------------------------------------------------- mindmap */

export function layoutMindmap(spec: AnySpec): MindmapLayout | null {
  const branches = arr(spec.branches)
    .slice(0, 7)
    .map((b) => ({
      label: labelOf(b),
      children: arr(rec(b).children).map(labelOf).filter(Boolean).slice(0, 6),
    }))
  if (!branches.length) return null

  const W = 700
  const ROW = 30
  const CW = 176
  const BW = 190
  const KID = 19

  const measured = branches.map((b) => {
    const lines = wrap(b.label, BW - 24, { size: 12.5, weight: 600, maxLines: 2 })
    const h = Math.max(34, 14 + lines.length * 16)
    /* The original gave each branch a flat (1 + children + 0.6) rows. That is
       generous for six children and two pixels short for a two-line label with
       none, so take whichever of the two is actually taller. */
    const advance = Math.max(
      (1 + b.children.length + 0.6) * ROW,
      h + b.children.length * KID + 16,
    )
    return { ...b, lines, h, advance }
  })

  const left = measured.filter((_, i) => i % 2 === 0)
  const right = measured.filter((_, i) => i % 2 === 1)
  const sideH = (side: typeof measured) => side.reduce((a, b) => a + b.advance, 0)

  const centreLines = wrap(
    first(spec, "centre", "center", "title") || "Topic",
    CW - 26,
    { size: 13.5, weight: 700, maxLines: 2 },
  )
  const ch = Math.max(52, 22 + centreLines.length * 17)
  const height = Math.max(sideH(left), sideH(right), 4 * ROW, ch + 24) + 60
  const cx = W / 2
  const cy = height / 2

  const out: MindmapLayout["branches"] = []
  const draw = (side: typeof measured, dir: -1 | 1) => {
    let top = (height - sideH(side)) / 2
    for (const b of side) {
      const y = top + b.h / 2 + 4
      const anchor = dir < 0 ? cx - CW / 2 - 70 : cx + CW / 2 + 70
      const bx = dir < 0 ? anchor - BW : anchor
      let ky = y + b.h / 2 + 14
      const children = b.children.map((kid) => {
        const run = text(
          ["· " + wrap(kid, BW - 24, { size: 11.5, maxLines: 1 })[0]],
          anchor - dir * 12,
          ky,
          { size: 11.5, anchor: dir < 0 ? "end" : "start", fill: COLOR.inkSoft },
        )
        ky += KID
        return run
      })
      out.push({
        box: box(bx, y - b.h / 2, BW, b.h, { fill: COLOR.sunk }),
        text: text(b.lines, bx + BW / 2, y, { size: 12.5, weight: 600 }),
        path:
          `M ${cx + (dir * CW) / 2} ${cy} C ${cx + dir * (CW / 2 + 40)} ${cy}, ` +
          `${anchor - dir * 40} ${y}, ${anchor} ${y}`,
        children,
      })
      top += b.advance
    }
  }
  draw(left, -1)
  draw(right, 1)

  return {
    kind: "mindmap",
    width: W,
    height,
    meta: plural(branches.length, "branch").replace("branchs", "branches"),
    centre: {
      box: box(cx - CW / 2, cy - ch / 2, CW, ch, { fill: COLOR.fill, stroke: COLOR.fill }),
      text: text(centreLines, cx, cy, { size: 13.5, weight: 700, fill: COLOR.onFill }),
    },
    branches: out,
  }
}

/* -------------------------------------------------------------- hierarchy */

export function layoutHierarchy(spec: AnySpec): HierarchyLayout | null {
  const kids = arr(spec.children)
    .slice(0, 6)
    .map((k) => ({
      label: labelOf(k),
      children: arr(rec(k).children).map(labelOf).filter(Boolean).slice(0, 6),
    }))
  if (!kids.length) return null

  const COL = 210
  const W = Math.max(560, kids.length * COL)
  const colW = W / kids.length
  const BY = 92
  const LEAF = 22

  const rootLines = wrap(first(spec, "root", "title") || "Topic", 184, {
    size: 12.5,
    weight: 700,
    maxLines: 2,
  })
  const rw = 210
  const rh = Math.max(46, 20 + rootLines.length * 16)

  const laid = kids.map((k) => {
    const lines = wrap(k.label, Math.min(colW - 24, 186) - 20, {
      size: 12.5,
      weight: 600,
      maxLines: 2,
    })
    return { ...k, lines, h: Math.max(38, 16 + lines.length * 16) }
  })
  const deepest = Math.max(0, ...laid.map((k) => k.children.length))
  const tallest = Math.max(...laid.map((k) => k.h))
  const height = Math.max(150 + deepest * 26, BY + tallest + 16 + deepest * LEAF + 12)

  return {
    kind: "hierarchy",
    width: W,
    height,
    meta: plural(kids.length, "branch").replace("branchs", "branches"),
    root: {
      box: box(W / 2 - rw / 2, 12, rw, rh, { fill: COLOR.fill, stroke: COLOR.fill }),
      text: text(rootLines, W / 2, 12 + rh / 2, { weight: 700, fill: COLOR.onFill }),
    },
    children: laid.map((k, i) => {
      const cx = (i + 0.5) * colW
      const bw = Math.min(colW - 24, 186)
      let y = BY + k.h + 16
      const leaves = k.children.map((child) => {
        const run = text([wrap(child, colW - 26, { size: 11.5, maxLines: 1 })[0]], cx, y, {
          size: 11.5,
          fill: COLOR.inkSoft,
        })
        y += LEAF
        return run
      })
      return {
        box: box(cx - bw / 2, BY, bw, k.h, { fill: COLOR.sunk }),
        text: text(k.lines, cx, BY + k.h / 2, { size: 12.5, weight: 600 }),
        path:
          `M ${W / 2} ${12 + rh} L ${W / 2} ${BY - 22} ` +
          `L ${cx} ${BY - 22} L ${cx} ${BY}`,
        leaves,
      }
    }),
  }
}

/* --------------------------------------------------------------- timeline */

export function layoutTimeline(spec: AnySpec): TimelineLayout | null {
  const points = arr(spec.points)
    .slice(0, 9)
    .map((p) => {
      const r = rec(p)
      return {
        when: first(r, "when", "date", "year", "time"),
        what: first(r, "what", "label", "text", "event"),
      }
    })
    .filter((p) => p.when || p.what)
  if (!points.length) return null

  const W = 640
  const AXIS = 132
  const ROW = 62
  const whatW = W - AXIS - 48

  const laid = points.map((p) => {
    const lines = wrap(p.what, whatW, { size: 13, maxLines: 3 })
    return {
      when: wrap(p.when, AXIS - 26, { size: 12.5, weight: 700, mono: true, maxLines: 1 })[0],
      lines,
      /* A three-line entry is 49px of text; the original's flat 62px row held
         it, but only just, and a fourth would have collided with the next
         date. Rows grow with their content instead. */
      h: Math.max(ROW, blockHeight(lines.length, 13) + 16),
    }
  })

  let y = 34
  const rows = laid.map((p) => {
    const cy = y
    y += p.h
    return { ...p, cy }
  })
  const height = 34 + laid.reduce((a, p) => a + p.h, 0)

  return {
    kind: "timeline",
    width: W,
    height,
    meta: plural(points.length, "point"),
    axis: { x1: AXIS, y1: 22, x2: AXIS, y2: height - 28, stroke: COLOR.lineStrong, width: 2 },
    points: rows.map((p) => ({
      dot: { cx: AXIS, cy: p.cy, r: 6, fill: COLOR.fill, text: "" },
      when: text([p.when], AXIS - 18, p.cy, {
        size: 12.5,
        weight: 700,
        anchor: "end",
        mono: true,
      }),
      what: text(p.lines, AXIS + 18, p.cy, { size: 13, anchor: "start" }),
    })),
  }
}

/* ---------------------------------------------------------------- compare */

export function layoutCompare(spec: AnySpec): CompareLayout | null {
  const rows = arr(spec.rows)
    .slice(0, 9)
    .map((r) => {
      const o = rec(r)
      return {
        aspect: first(o, "aspect", "label", "criterion", "feature"),
        left: first(o, "left", "a", "first"),
        right: first(o, "right", "b", "second"),
      }
    })
    .filter((r) => r.aspect || r.left || r.right)
  if (!rows.length) return null

  const cols = arr(spec.columns).map(labelOf)
  const W = 700
  const ASPECT = 150
  const colW = (W - ASPECT) / 2
  const HEAD = 38
  const cellW = colW - 40

  const laid = rows.map((r) => {
    const aspect = wrap(r.aspect, ASPECT - 26, { size: 12.5, weight: 600, maxLines: 3 })
    const left = wrap(r.left, cellW, { size: 12.5, maxLines: 4 })
    const right = wrap(r.right, cellW, { size: 12.5, maxLines: 4 })
    /* The original sized the row on the two cells and forgot the aspect, so a
       three-line aspect against a one-line cell ran into the row below. */
    const tallest = Math.max(aspect.length, left.length, right.length)
    return { aspect, left, right, h: Math.max(38, 16 + tallest * 16) }
  })
  const height = HEAD + 8 + laid.reduce((a, r) => a + r.h, 0)

  let y = HEAD
  const out = laid.map((r, i) => {
    const row = {
      rule: i
        ? { x1: 0, y1: y, x2: W, y2: y, stroke: COLOR.line, width: 1 }
        : null,
      aspect: text(r.aspect, 12, y + r.h / 2, {
        anchor: "start" as Anchor,
        weight: 600,
        size: 12.5,
      }),
      left: text(r.left, ASPECT + colW / 2, y + r.h / 2, { size: 12.5 }),
      right: text(r.right, ASPECT + colW * 1.5, y + r.h / 2, { size: 12.5 }),
    }
    y += r.h
    return row
  })

  return {
    kind: "compare",
    width: W,
    height,
    meta: plural(rows.length, "row"),
    headerPath: roundedTopPath(0, 0, W, HEAD, 8),
    headings: [
      text([cols[0] || "A"], ASPECT + colW / 2, HEAD / 2, { weight: 700, size: 13 }),
      text([cols[1] || "B"], ASPECT + colW * 1.5, HEAD / 2, { weight: 700, size: 13 }),
    ],
    rows: out,
    dividers: [
      { x1: ASPECT, y1: 0, x2: ASPECT, y2: height, stroke: COLOR.line, width: 1 },
      {
        x1: ASPECT + colW,
        y1: 0,
        x2: ASPECT + colW,
        y2: height,
        stroke: COLOR.line,
        width: 1,
      },
    ],
  }
}

/* ------------------------------------------------------------------ graph

   Labelled axes with one or more lines or curves — supply and demand, cost
   curves, velocity-time, rates of reaction. The whole point of a PES lesson is
   the SHAPE of the curve: vertical, horizontal, through the origin, cutting an
   axis. None of the other six shapes can draw an axis, so without this one the
   model had nothing to emit for an entire subject. */

export function layoutGraph(spec: AnySpec): GraphLayout | null {
  const lines = arr(spec.lines)
    .map((l) => {
      const o = rec(l)
      const pts = arr(o.points)
        .map((p): [number, number] => {
          if (Array.isArray(p)) return [num(p[0]), num(p[1])]
          const r = rec(p)
          return [num(r.x), num(r.y)]
        })
      return { label: first(o, "label", "name"), dashed: o.dashed === true, pts }
    })
    .filter((l) => l.pts.length >= 2)
  if (!lines.length) return null

  const W = 400
  const H = 260
  const L = 46
  const R = 18
  const T = 16
  const B = 40
  const clamp = (v: number) => Math.max(0, Math.min(100, v))
  const px = (v: number) => L + (clamp(v) / 100) * (W - L - R)
  const py = (v: number) => H - B - (clamp(v) / 100) * (H - T - B)
  const midY = (T + H - B) / 2

  /* Nothing may be drawn over anything else, so every label claims a box and
     the next one steps down past it. Two curves ending at the same height —
     perfectly elastic against perfectly inelastic, say — is common. */
  type Claim = { x0: number; x1: number; y: number }
  const claimed: Claim[] = []
  const spanFor = (x: number, w: number, anchor: Anchor): [number, number] =>
    anchor === "start" ? [x, x + w] : anchor === "end" ? [x - w, x] : [x - w / 2, x + w / 2]
  const settle = (x0: number, x1: number, y: number): number => {
    let out = y
    for (let guard = 0; guard < 12; guard++) {
      const hit = claimed.some(
        (c) => c.x0 < x1 + 4 && x0 < c.x1 + 4 && Math.abs(c.y - out) < 13,
      )
      if (!hit) break
      out += 13
    }
    return Math.min(out, H - B - 6)
  }

  const noteText = str(spec.note).trim()
  let note: TextRun | null = null
  if (noteText) {
    const clipped = wrap(noteText, W - L - R, { size: 11, maxLines: 1 })[0]
    note = text([clipped], L, T + 2, { size: 11, anchor: "start", fill: COLOR.inkSoft })
    claimed.push({ x0: L, x1: L + measure(clipped, 11), y: T + 2 })
  }

  const curves = lines.map((line, i) => {
    const pts = line.pts.map((p): [number, number] => [px(p[0]), py(p[1])])
    const d = pts
      .map((p, n) => `${n ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`)
      .join(" ")
    const stroke = COLOR.series[i % COLOR.series.length]

    let label: TextRun | null = null
    if (line.label) {
      const last = pts[pts.length - 1]
      const head = pts[0]
      /* A vertical line has no right-hand end to sit beside, so it is labelled
         above its top instead. */
      const vertical = Math.abs(last[0] - head[0]) < 6
      const lx = vertical ? last[0] : Math.min(last[0] + 6, W - R - 4)
      const ly = vertical ? Math.min(head[1], last[1]) - 6 : last[1] - 5
      const anchor: Anchor = vertical ? "middle" : lx > W - R - 40 ? "end" : "start"
      const w = measure(line.label, 11.5, 600)
      const [x0, x1] = spanFor(lx, w, anchor)
      const y = settle(x0, x1, Math.max(T + 10, ly))
      claimed.push({ x0, x1, y })
      label = text([line.label], lx, y, { size: 11.5, weight: 600, anchor, fill: stroke })
    }
    return { curve: { d, stroke, width: 2, dashed: line.dashed }, label }
  })

  return {
    kind: "graph",
    width: W,
    height: H,
    meta: plural(lines.length, "line"),
    axes: [
      { x1: L, y1: T, x2: L, y2: H - B, stroke: COLOR.inkSoft, width: 1.25 },
      { x1: L, y1: H - B, x2: W - R, y2: H - B, stroke: COLOR.inkSoft, width: 1.25 },
    ],
    /* The y label reads bottom-to-top, as on paper. */
    yLabel: text([str(spec.y) || "Price"], 14, midY, {
      size: 12,
      weight: 600,
      rotate: `rotate(-90 14 ${midY})`,
    }),
    xLabel: text([str(spec.x) || "Quantity"], (L + W - R) / 2, H - 10, {
      size: 12,
      weight: 600,
    }),
    /* "Passes through the origin" is often the whole point of the graph. */
    origin: text(["0"], L - 8, H - B + 12, { size: 10.5, fill: COLOR.inkSoft }),
    curves,
    note,
  }
}

/* ------------------------------------------------------------- dispatcher */

const LAYOUTS: Record<DiagramKind, (spec: AnySpec) => DiagramLayout | null> = {
  flow: layoutFlow,
  cycle: layoutCycle,
  mindmap: layoutMindmap,
  hierarchy: layoutHierarchy,
  timeline: layoutTimeline,
  compare: layoutCompare,
  graph: layoutGraph,
}

const isKind = (v: string): v is DiagramKind =>
  (DIAGRAM_KINDS as readonly string[]).includes(v)

/** The kind a spec claims, or the one its payload implies. The server guesses
 *  too, but a spec can reach the client from an older note. */
export function kindOf(spec: AnySpec): DiagramKind | null {
  const claimed = str(spec.kind).toLowerCase().trim()
  if (isKind(claimed)) return claimed
  if (arr(spec.lines).length) return "graph"
  if (arr(spec.rows).length) return "compare"
  if (arr(spec.branches).length) return "mindmap"
  if (arr(spec.points).length) return "timeline"
  if (arr(spec.children).length) return "hierarchy"
  if (arr(spec.steps).length) return "cycle"
  if (arr(spec.nodes).length) return "flow"
  return null
}

/** Lay a spec out, or return null if it cannot be drawn. Never throws: a note
 *  with one malformed diagram still renders the rest of the note. */
export function layoutSpec(spec: DiagramSpec | AnySpec | null | undefined): DiagramLayout | null {
  if (!spec || typeof spec !== "object") return null
  const raw = spec as AnySpec
  const kind = kindOf(raw)
  if (!kind) return null
  try {
    return LAYOUTS[kind](raw)
  } catch {
    return null
  }
}

/** The caption under the card, if the spec named one. */
export const titleOf = (spec: DiagramSpec | AnySpec | null | undefined): string =>
  spec && typeof spec === "object" ? str((spec as AnySpec).title).trim() : ""
