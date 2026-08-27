/* ==========================================================================
   BlockRenderer.tsx — everything the note writer produces, on screen.

   A note is an array of blocks. This renders every type the server can send
   and skips anything it does not recognise, so a new block type from a newer
   model never blanks the page.

   Two rules carried over from the working build:

   1. `items` is a flat array of strings and ANY ONE STRING MAY HOLD SEVERAL
      LINES. The model routinely returns one item containing six lines of an
      outline. Splitting on "\n" before parsing is what keeps indentation,
      callouts and sub-headings; without it the whole thing collapses into one
      bullet and the note reads as a wall of text.
   2. No icons on callouts. The coloured left rule and the label carry the
      meaning — a row of emoji was the single most amateur thing on the page.

   Everything inline goes through the node tree in @/lib/mathText, so there is
   no dangerouslySetInnerHTML anywhere in this file.
   ========================================================================== */

import { memo, useId, type ReactNode } from "react";
import { Square, SquareCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  inlineNodes,
  mathNodes,
  nodeText,
  type InlineNode,
} from "@/lib/mathText";

/* ------------------------------------------------------------------ types */

export interface DiagramNode {
  id?: string;
  label?: string;
}

export interface DiagramEdge {
  from?: string;
  to?: string;
  label?: string;
}

export interface DiagramBranch {
  label?: string;
  children?: string[];
}

export interface DiagramPoint {
  when?: string;
  what?: string;
}

export interface DiagramRow {
  aspect?: string;
  left?: string;
  right?: string;
}

export type DiagramPointPair = [number, number] | { x: number; y: number };

export interface DiagramLine {
  label?: string;
  dashed?: boolean;
  points?: DiagramPointPair[];
}

/** A straight element on a "figure": a force/vector arrow or a plain segment.
    Coordinates are 0-100 with the origin bottom-left and y pointing UP, the
    way a diagram is drawn on paper. */
export interface FigureSeg {
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  label?: string;
  dashed?: boolean;
}
export interface FigureDot {
  x?: number;
  y?: number;
  label?: string;
}
export interface FigureCircle {
  cx?: number;
  cy?: number;
  r?: number;
  label?: string;
}

/** The small JSON the model returns for a drawing. Every field is optional:
    the kind decides which ones are read, and a spec that cannot be drawn is
    skipped rather than shown broken. */
export interface DiagramSpec {
  kind?: string;
  title?: string;
  note?: string;
  nodes?: DiagramNode[];
  edges?: DiagramEdge[];
  steps?: string[];
  centre?: string;
  branches?: DiagramBranch[];
  root?: string;
  children?: DiagramBranch[];
  points?: DiagramPoint[];
  columns?: string[];
  rows?: DiagramRow[];
  lines?: DiagramLine[];
  x?: string;
  y?: string;
  /* "centre" puts 0,0 in the middle and accepts -100..100, which any curve
     with negative values needs. Absent means the first quadrant only. */
  origin?: string;
  /* "figure": free-body diagrams, vectors, geometry, circular motion — the
     shapes that are neither a graph nor a flow. */
  arrows?: FigureSeg[];
  segments?: FigureSeg[];
  dots?: FigureDot[];
  circles?: FigureCircle[];
}

export interface Definition {
  term: string;
  meaning: string;
}

export type Block =
  | { type: "summary"; text: string }
  | { type: "points"; heading?: string; items: string[] }
  | { type: "definitions"; items: Definition[] }
  | { type: "formula"; formula: string; means?: string; when?: string }
  | { type: "example"; title?: string; steps: string[] }
  | { type: "assessed"; items: string[] }
  | { type: "gaps"; items: string[] }
  | { type: "diagram"; spec: DiagramSpec };

export interface NoteTask {
  title: string;
  due?: string | null;
}

export interface Note {
  id: string;
  title: string;
  subject: string;
  topic: string;
  body: string;
  transcript: string;
  summary?: string;
  blocks: Block[];
  tasks?: NoteTask[];
  continues?: boolean;
  created_at: string;
  updated_at: string;
}

/* --------------------------------------------------------------- inline md */

function renderNodes(nodes: InlineNode[]): ReactNode {
  return nodes.map((node, i) => {
    if (typeof node === "string") return node;
    const kids = renderNodes(node.children);
    if (node.tag === "sub") return <sub key={i}>{kids}</sub>;
    if (node.tag === "sup") return <sup key={i}>{kids}</sup>;
    if (node.tag === "b") return <b key={i} className="font-semibold">{kids}</b>;
    if (node.tag === "i") return <i key={i}>{kids}</i>;
    return (
      <code
        key={i}
        className="font-mono text-[0.9em] rounded bg-muted px-1 py-px"
      >
        {kids}
      </code>
    );
  });
}

/** Maths plus inline markdown. The only inline renderer in the app. */
export const InlineMd = memo(function InlineMd({ text }: { text: string }) {
  return <>{renderNodes(inlineNodes(text))}</>;
});

/** Maths only — for formula lines, which are LaTeX by nature, not markdown. */
export const InlineMath = memo(function InlineMath({ text }: { text: string }) {
  return <>{renderNodes(mathNodes(text))}</>;
});

/* ------------------------------------------------------------- the outline */

/* Callout kinds. Unknown kinds fall back to the "note" label but keep their
   own colour slot, exactly as the working build did. */
const CALLOUTS: Record<string, { label: string; rule: string; body: string }> = {
  tip: { label: "Tip", rule: "border-l-ok", body: "" },
  warning: { label: "Watch out", rule: "border-l-warn", body: "" },
  example: { label: "Example", rule: "border-l-info", body: "" },
  quote: {
    label: "In the teacher's words",
    rule: "border-l-border",
    body: "italic text-foreground",
  },
  info: { label: "Note", rule: "border-l-info", body: "" },
  note: { label: "Note", rule: "border-l-info", body: "" },
  todo: { label: "To do", rule: "border-l-info", body: "" },
};

interface Bullet {
  depth: number;
  text: string;
}

interface CalloutData {
  kind: string;
  title: string;
  lines: string[];
}

type Piece =
  | { k: "list"; ordered: boolean; items: Bullet[] }
  | { k: "heading"; text: string }
  | { k: "task"; done: boolean; text: string }
  | { k: "callout"; call: CalloutData };

/**
 * Turn a flat list of strings into real structure.
 *
 * Handles the four things the model writes that a flat <ul> destroys:
 * indentation, "> [!tip] …" callouts, "## …" sub-headings and "1. …" ordered
 * lists. A straight port of the working state machine — the regexes and the
 * order they are tried in are the whole behaviour.
 */
export function parseItems(items: readonly string[] | undefined): Piece[] {
  const out: Piece[] = [];
  let mode = "";
  let buffer: Bullet[] = [];
  let call: CalloutData | null = null;

  const flush = () => {
    if (!buffer.length) return;
    out.push({ k: "list", ordered: mode === "ol", items: buffer });
    buffer = [];
  };

  const closeCallout = () => {
    if (!call) return;
    out.push({ k: "callout", call });
    call = null;
  };

  for (const raw of items || []) {
    /* One item can arrive holding several lines. */
    for (const line of String(raw ?? "").split("\n")) {
      if (!line.trim()) continue;
      const lead = (line.match(/^[ \t]*/) || [""])[0].replace(/\t/g, "  ");
      /* A callout is often written as a bullet: "- > [!warning] …". Strip the
         marker before testing, or it renders as an ordinary list item with a
         stray ">" sitting in the text. */
      const s = line.trim().replace(/^[-*•]\s+(?=>)/, "");

      const opener = s.match(/^>\s*\[!(\w+)\]\s*(.*)$/);
      if (opener) {
        flush();
        closeCallout();
        mode = "";
        call = { kind: opener[1].toLowerCase(), title: opener[2].trim(), lines: [] };
        continue;
      }

      const cont = s.match(/^>\s?(.*)$/);
      if (cont) {
        flush();
        mode = "";
        if (call) {
          if (cont[1].trim()) call.lines.push(cont[1].trim());
          continue;
        }
        /* A bare "> …" with no marker is the teacher's own wording. Each one
           closes immediately, so two quoted lines stay two quotes. */
        call = { kind: "quote", title: "", lines: [cont[1].trim()] };
        closeCallout();
        continue;
      }

      /* An indented plain line straight after a callout opener belongs to that
         callout even without its own ">". Models write it that way about half
         the time, and dropping it loses the content of the warning. */
      if (call && lead.length >= 2 && !/^[-*•\d#]/.test(s)) {
        call.lines.push(s);
        continue;
      }
      closeCallout();

      const heading = s.match(/^#{1,4}\s+(.*)$/);
      if (heading) {
        flush();
        mode = "";
        out.push({ k: "heading", text: heading[1] });
        continue;
      }

      const task = s.match(/^[-*]\s+\[([ xX])\]\s+(.*)$/);
      if (task) {
        flush();
        mode = "";
        out.push({ k: "task", done: task[1] !== " ", text: task[2] });
        continue;
      }

      const numbered = s.match(/^\d+[.)]\s+(.*)$/);
      const bulleted = s.match(/^[-*•]\s+(.*)$/);
      const text = numbered ? numbered[1] : bulleted ? bulleted[1] : s;
      const want = numbered ? "ol" : "ul";
      /* Switching between ordered and unordered starts a new list. */
      if (mode && mode !== want) flush();
      mode = want;
      /* Two spaces per level, capped so a stray indent cannot run away. */
      buffer.push({ depth: Math.min(3, Math.floor(lead.length / 2)), text });
    }
  }
  flush();
  closeCallout();
  return out;
}

interface TreeNode {
  text: string;
  children: TreeNode[];
}

/**
 * Rebuild the indent tree.
 *
 * The original emitted sub-lists as siblings of their <li> — invalid HTML that
 * browsers happen to render correctly. This nests them properly instead, which
 * looks identical and is real markup. A depth jump of more than one opens the
 * levels one at a time, as it did before, using an unmarked spacer row so the
 * indent survives without inventing a bullet.
 */
function toTree(items: Bullet[]): TreeNode[] {
  const root: TreeNode[] = [];
  const levels: TreeNode[][] = [root];
  for (const item of items) {
    while (levels.length - 1 < item.depth) {
      const parent = levels[levels.length - 1];
      let holder = parent[parent.length - 1];
      if (!holder) {
        holder = { text: "", children: [] };
        parent.push(holder);
      }
      levels.push(holder.children);
    }
    while (levels.length - 1 > item.depth) levels.pop();
    levels[levels.length - 1].push({ text: item.text, children: [] });
  }
  return root;
}

function OutlineList({
  nodes,
  ordered,
  nested = false,
}: {
  nodes: TreeNode[];
  ordered: boolean;
  nested?: boolean;
}) {
  const Tag = ordered ? "ol" : "ul";
  return (
    <Tag
      className={cn(
        "font-serif text-[18px] leading-[1.72] max-w-[68ch]",
        ordered ? "list-decimal" : "list-disc",
        "pl-5 marker:text-muted-foreground",
        nested ? "mt-1.5 ml-1 border-l pl-4" : "space-y-1.5",
      )}
    >
      {nodes.map((node, i) => (
        <li key={i} className={cn(!node.text && "list-none", nested && "mt-1.5")}>
          {node.text ? <InlineMd text={node.text} /> : null}
          {node.children.length > 0 && (
            <OutlineList nodes={node.children} ordered={ordered} nested />
          )}
        </li>
      ))}
    </Tag>
  );
}

function Callout({ call }: { call: CalloutData }) {
  const style = CALLOUTS[call.kind] || CALLOUTS.note;
  return (
    <div className={cn("my-5 border-l-2 pl-4", style.rule)}>
      <div className="text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
        <InlineMd text={call.title || style.label} />
      </div>
      {call.lines.length > 0 && (
        <div className="mt-1.5 space-y-1.5">
          {call.lines.map((line, i) => (
            <p
              key={i}
              className={cn(
                "font-serif text-[17px] leading-[1.66] max-w-[64ch] text-muted-foreground",
                style.body,
              )}
            >
              <InlineMd text={line} />
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/** The outline of one `items` array — lists, headings, tasks and callouts. */
export function Outline({ items }: { items: readonly string[] | undefined }) {
  const pieces = parseItems(items);
  if (!pieces.length) return null;
  return (
    <div className="space-y-3">
      {pieces.map((piece, i) => {
        if (piece.k === "list") {
          return (
            <OutlineList
              key={i}
              nodes={toTree(piece.items)}
              ordered={piece.ordered}
            />
          );
        }
        if (piece.k === "heading") {
          return (
            <h4
              key={i}
              className="text-[13px] font-semibold tracking-tight pt-1"
            >
              <InlineMd text={piece.text} />
            </h4>
          );
        }
        if (piece.k === "task") {
          const Box = piece.done ? SquareCheck : Square;
          return (
            <div key={i} className="flex items-start gap-2">
              <Box
                size={12}
                className="mt-[5px] shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="font-serif text-[18px] leading-[1.72] max-w-[68ch]">
                <InlineMd text={piece.text} />
              </span>
            </div>
          );
        }
        return <Callout key={i} call={piece.call} />;
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ shells */

function BlockCard({
  label,
  rule,
  kind,
  children,
}: {
  label: string;
  rule?: string;
  kind?: string;
  children: ReactNode;
}) {
  return (
    <section
      /* data-block is the hook the reading views restyle through. Keeping it as
         a data attribute rather than more classes means a view mode is pure CSS
         and this component never has to know which one is active. */
      data-block={kind || "block"}
      className={cn(
        "note-block rounded-lg border bg-card overflow-hidden",
        rule && "border-l-2",
        rule,
      )}
    >
      <div className="note-block-label px-4 py-2.5 border-b bg-muted/40">
        <span className="text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
          {label}
        </span>
      </div>
      <div className="note-block-body px-4 py-4">{children}</div>
    </section>
  );
}

/* --------------------------------------------------------------- diagrams */

/* Six shapes cover almost everything a lesson has, plus a labelled graph for
   the subjects that are entirely about the shape of a curve. Ported from the
   hand-tuned SVG layout in the working build: text wrapping is measured on a
   character budget rather than guessed, so labels never overflow their boxes.
   Colours come from the theme tokens, so the diagrams follow dark mode. */

const CH = 6.9; // approximate px per character at 12.5px

const INK = "var(--foreground)";
const DIM = "var(--muted-foreground)";
const LINE = "var(--border)";
const EDGE = "var(--input)";
const FILL = "var(--card)";
const SUNK = "var(--muted)";
const KEY = "var(--primary)";
const KEY_INK = "var(--primary-foreground)";
const SERIES = ["var(--info)", "var(--ok)", "var(--warn)", "var(--late)"];

function wrap(text: unknown, maxChars: number, maxLines = 4): string[] {
  const words = String(text ?? "").split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const candidate = line ? line + " " + w : w;
    if (candidate.length <= maxChars) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = w.length > maxChars ? w.slice(0, maxChars - 1) + "…" : w;
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines.length ? lines : [""];
}

/* A model that is reasoning about content, not about our schema, writes the
   natural shape: a comparison as {left,right} objects, a tree node as
   {label,children}. wrap() would turn those into "[object Object]", so every
   such diagram rendered as an empty titled box across every subject. Pull the
   readable string out of whatever shape arrived. */
function asText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const s = o.label ?? o.text ?? o.title ?? o.name ?? o.value;
    if (typeof s === "string") return s;
  }
  return "";
}

function TextLines({
  lines,
  x,
  y,
  size = 12.5,
  weight = 400,
  fill = INK,
  anchor = "middle",
}: {
  lines: string[];
  x: number;
  y: number;
  size?: number;
  weight?: number;
  fill?: string;
  anchor?: "start" | "middle" | "end";
}) {
  const lh = size * 1.25;
  const start = y - ((lines.length - 1) * lh) / 2;
  return (
    <>
      {lines.map((ln, i) => (
        <text
          key={i}
          x={x}
          y={start + i * lh}
          textAnchor={anchor}
          dominantBaseline="middle"
          fontSize={size}
          fontWeight={weight}
          fill={fill}
        >
          {ln}
        </text>
      ))}
    </>
  );
}

function Box({
  x,
  y,
  w,
  h,
  fill = FILL,
  stroke = EDGE,
  r = 9,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  fill?: string;
  stroke?: string;
  r?: number;
}) {
  return (
    <rect x={x} y={y} width={w} height={h} rx={r} fill={fill} stroke={stroke} strokeWidth={1.2} />
  );
}

function Arrow({
  x1,
  y1,
  x2,
  y2,
  label,
  marker,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  label?: string;
  marker: string;
}) {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const w = String(label ?? "").length * CH + 10;
  return (
    <>
      <line
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={DIM}
        strokeWidth={1.4}
        markerEnd={`url(#${marker})`}
      />
      {label ? (
        <>
          <rect x={mx - w / 2} y={my - 9} width={w} height={18} rx={5} fill={FILL} />
          <text
            x={mx}
            y={my}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize={11}
            fill={DIM}
          >
            {label}
          </text>
        </>
      ) : null}
    </>
  );
}

interface Drawing {
  w: number;
  h: number;
  body: ReactNode;
}

type Draw = (spec: DiagramSpec, marker: string) => Drawing | null;

/* ---- flow: a process with arrows ---------------------------------------- */
const flow: Draw = (spec, marker) => {
  const nodes = (spec.nodes || []).slice(0, 10);
  if (!nodes.length) return null;
  const W = 210;
  const GAP = 34;
  const laid = nodes.map((n) => {
    const lines = wrap(n.label, 26, 3);
    return { id: n.id ?? "", lines, h: Math.max(46, 20 + lines.length * 16) };
  });
  const total = laid.reduce((a, n) => a + n.h, 0) + GAP * (laid.length - 1);
  const pos: Record<string, { y: number; h: number }> = {};
  let y = 10;
  const boxes = laid.map((n, i) => {
    const top = y;
    pos[n.id] = { y: top, h: n.h };
    y += n.h + GAP;
    return (
      <g key={i}>
        <Box x={60} y={top} w={W} h={n.h} />
        <TextLines lines={n.lines} x={60 + W / 2} y={top + n.h / 2} weight={500} />
      </g>
    );
  });
  const edges =
    (spec.edges || []).length > 0
      ? spec.edges || []
      : laid.slice(0, -1).map((n, i): DiagramEdge => ({ from: n.id, to: laid[i + 1].id, label: undefined }));
  const arrows = edges.map((e, i) => {
    const a = pos[e.from ?? ""];
    const b = pos[e.to ?? ""];
    if (!a || !b || a === b) return null;
    return (
      <Arrow
        key={`e${i}`}
        x1={60 + W / 2}
        y1={a.y + a.h}
        x2={60 + W / 2}
        y2={b.y - 4}
        label={e.label}
        marker={marker}
      />
    );
  });
  return { w: W + 120, h: total + 20, body: <>{boxes}{arrows}</> };
};

/* ---- cycle: a loop that comes back round -------------------------------- */
const cycle: Draw = (spec, marker) => {
  const steps = (spec.steps || []).slice(0, 8);
  if (steps.length < 2) return null;
  const R = 132;
  const BW = 150;
  const size = (R + 96) * 2;
  const cx = size / 2;
  const cy = size / 2;
  const pts = steps.map((s, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / steps.length;
    return { x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R, label: s, a };
  });
  return {
    w: size,
    h: size,
    body: (
      <>
        {pts.map((p, i) => {
          const next = pts[(i + 1) % pts.length];
          const mid = (p.a + (next.a > p.a ? next.a : next.a + Math.PI * 2)) / 2;
          return (
            <Arrow
              key={`a${i}`}
              x1={p.x + Math.cos(p.a + 0.5) * 30}
              y1={p.y + Math.sin(p.a + 0.5) * 30}
              x2={cx + Math.cos(mid) * (R + 6)}
              y2={cy + Math.sin(mid) * (R + 6)}
              marker={marker}
            />
          );
        })}
        {pts.map((p, i) => {
          const lines = wrap(p.label, 20, 3);
          const h = Math.max(52, 18 + lines.length * 16);
          return (
            <g key={`s${i}`}>
              <Box x={p.x - BW / 2} y={p.y - h / 2} w={BW} h={h} fill={SUNK} />
              <TextLines lines={lines} x={p.x} y={p.y} size={12} weight={500} />
              <circle cx={p.x - BW / 2 + 2} cy={p.y - h / 2 + 2} r={9} fill={KEY} />
              <text
                x={p.x - BW / 2 + 2}
                y={p.y - h / 2 + 2}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize={10.5}
                fontWeight={700}
                fill={KEY_INK}
              >
                {i + 1}
              </text>
            </g>
          );
        })}
      </>
    ),
  };
};

/* ---- mindmap: a centre with branches ------------------------------------ */
const mindmap: Draw = (spec) => {
  const branches = (spec.branches || []).slice(0, 7);
  if (!branches.length) return null;
  const colW = 250;
  const rowH = 30;
  const left = branches.filter((_, i) => i % 2 === 0);
  const right = branches.filter((_, i) => i % 2 === 1);
  const rowsFor = (b: DiagramBranch) => 1 + Math.min((b.children || []).length, 6);
  const side = (arr: DiagramBranch[]) =>
    arr.reduce((a, b) => a + rowsFor(b) + 0.6, 0);
  const height = Math.max(side(left), side(right), 4) * rowH + 60;
  const W = colW * 2 + 200;
  const cx = W / 2;
  const cy = height / 2;
  const centre = wrap(spec.centre || spec.title || "Topic", 20, 2);
  const cw = 176;
  const ch = Math.max(52, 22 + centre.length * 17);

  const draw = (arr: DiagramBranch[], dir: 1 | -1) => {
    let y = (height - side(arr) * rowH) / 2 + rowH / 2;
    return arr.map((b, i) => {
      const bx = dir < 0 ? cx - cw / 2 - 70 : cx + cw / 2 + 70;
      const lines = wrap(b.label, 24, 2);
      const bw = 190;
      const bh = Math.max(34, 14 + lines.length * 16);
      const at = y;
      y += (rowsFor(b) + 0.6) * rowH;
      let ky = at + bh / 2 + 6;
      return (
        <g key={`${dir}${i}`}>
          <path
            d={
              `M ${cx + (dir * cw) / 2} ${cy} C ${cx + dir * (cw / 2 + 40)} ${cy}, ` +
              `${bx - dir * 40} ${at}, ${bx} ${at}`
            }
            fill="none"
            stroke={EDGE}
            strokeWidth={1.4}
          />
          <Box x={dir < 0 ? bx - bw : bx} y={at - bh / 2} w={bw} h={bh} fill={SUNK} />
          <TextLines
            lines={lines}
            x={dir < 0 ? bx - bw / 2 : bx + bw / 2}
            y={at}
            size={12.5}
            weight={600}
          />
          {(b.children || []).slice(0, 6).map((kid, k) => {
            const yy = ky + 8;
            ky += 19;
            return (
              <text
                key={k}
                x={dir < 0 ? bx - 12 : bx + 12}
                y={yy}
                textAnchor={dir < 0 ? "end" : "start"}
                dominantBaseline="middle"
                fontSize={11.5}
                fill={DIM}
              >
                {"· " + wrap(kid, 30, 1)[0]}
              </text>
            );
          })}
        </g>
      );
    });
  };

  return {
    w: W,
    h: height,
    body: (
      <>
        {draw(left, -1)}
        {draw(right, 1)}
        <Box x={cx - cw / 2} y={cy - ch / 2} w={cw} h={ch} fill={KEY} stroke={KEY} />
        <TextLines lines={centre} x={cx} y={cy} weight={700} fill={KEY_INK} size={13.5} />
      </>
    ),
  };
};

/* ---- hierarchy: a tree --------------------------------------------------- */
const hierarchy: Draw = (spec) => {
  /* Documented shape: root is a string, children is the top-level array. The
     shape the model actually writes: root is an object carrying its own label
     and children. Reading only the top-level `children` found nothing in that
     case, so the tree rendered as an empty box. Accept both. */
  const rootRaw = (spec as unknown as Record<string, unknown>).root;
  const rootObj =
    rootRaw && typeof rootRaw === "object"
      ? (rootRaw as Record<string, unknown>)
      : null;
  const kids = (((rootObj?.children as unknown[]) || spec.children || []) as {
    label?: unknown;
    children?: unknown[];
  }[]).slice(0, 6);
  if (!kids.length) return null;
  const colW = 210;
  const W = Math.max(560, kids.length * colW);
  const deepest = Math.max(...kids.map((k) => (k.children || []).length), 0);
  const H = 150 + deepest * 26;
  const rootLines = wrap(
    asText(rootObj ? rootObj.label : rootRaw) || spec.title || "Topic",
    26,
    2,
  );
  const rw = 210;
  const rh = Math.max(46, 20 + rootLines.length * 16);
  return {
    w: W,
    h: H,
    body: (
      <>
        <Box x={W / 2 - rw / 2} y={12} w={rw} h={rh} fill={KEY} stroke={KEY} />
        <TextLines
          lines={rootLines}
          x={W / 2}
          y={12 + rh / 2}
          weight={700}
          fill={KEY_INK}
        />
        {kids.map((k, i) => {
          const cx = (i + 0.5) * (W / kids.length);
          const lines = wrap(asText(k.label ?? k), 24, 2);
          const bw = Math.min(colW - 24, 186);
          const bh = Math.max(38, 16 + lines.length * 16);
          const by = 92;
          return (
            <g key={i}>
              <path
                d={`M ${W / 2} ${12 + rh} L ${W / 2} ${by - 22} L ${cx} ${by - 22} L ${cx} ${by}`}
                fill="none"
                stroke={EDGE}
                strokeWidth={1.4}
              />
              <Box x={cx - bw / 2} y={by} w={bw} h={bh} fill={SUNK} />
              <TextLines lines={lines} x={cx} y={by + bh / 2} size={12.5} weight={600} />
              {(k.children || []).slice(0, 6).map((child, c) => (
                <text
                  key={c}
                  x={cx}
                  y={by + bh + 16 + c * 22}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={11.5}
                  fill={DIM}
                >
                  {wrap(asText(child), 28, 1)[0]}
                </text>
              ))}
            </g>
          );
        })}
      </>
    ),
  };
};

/* ---- timeline: dated points along a line -------------------------------- */
const timeline: Draw = (spec) => {
  const points = (spec.points || []).slice(0, 9);
  if (!points.length) return null;
  const rowH = 62;
  const W = 640;
  const x = 132;
  return {
    w: W,
    h: points.length * rowH + 34,
    body: (
      <>
        <line x1={x} y1={22} x2={x} y2={points.length * rowH + 6} stroke={EDGE} strokeWidth={2} />
        {points.map((p, i) => {
          const y = 34 + i * rowH;
          return (
            <g key={i}>
              <circle cx={x} cy={y} r={6} fill={KEY} />
              <text
                x={x - 18}
                y={y}
                textAnchor="end"
                dominantBaseline="middle"
                fontSize={12.5}
                fontWeight={700}
                fill={INK}
                fontFamily="var(--font-mono)"
              >
                {wrap(p.when || "", 16, 1)[0]}
              </text>
              <TextLines
                lines={wrap(p.what || "", 46, 3)}
                x={x + 18}
                y={y}
                anchor="start"
                size={13}
              />
            </g>
          );
        })}
      </>
    ),
  };
};

/* ---- compare: two columns against shared aspects ------------------------ */
const compare: Draw = (spec) => {
  /* Two shapes both mean "a two-column comparison". The documented one is
     rows:[{aspect,left,right}] with a column per side. The one the model
     actually reaches for is left:{title,items[]} and right:{title,items[]} --
     a list down each side. Accept either; the second is paired into rows by
     position, and the empty aspect column is dropped so it does not leave a
     blank 150px gutter. */
  const specAny = spec as unknown as Record<string, unknown>;
  let cols = spec.columns as string[] | undefined;
  let rows = (spec.rows || []).map((r) => ({
    aspect: asText(r.aspect),
    left: asText(r.left),
    right: asText(r.right),
  }));
  if (!rows.length && (specAny.left || specAny.right)) {
    const lo = (specAny.left || {}) as Record<string, unknown>;
    const ro = (specAny.right || {}) as Record<string, unknown>;
    cols = cols || [asText(lo) || "A", asText(ro) || "B"];
    const li = ((lo.items as unknown[]) || []).map(asText);
    const ri = ((ro.items as unknown[]) || []).map(asText);
    const n = Math.max(li.length, ri.length);
    rows = Array.from({ length: n }, (_, i) => ({
      aspect: "",
      left: li[i] || "",
      right: ri[i] || "",
    }));
  }
  rows = rows.slice(0, 9);
  if (!rows.length) return null;
  cols = cols || ["A", "B"];
  const hasAspect = rows.some((r) => r.aspect.trim());
  const W = 700;
  const aspectW = hasAspect ? 150 : 0;
  const colW = (W - aspectW) / 2;
  const heights = rows.map((r) =>
    Math.max(
      38,
      16 +
        Math.max(wrap(r.left, 30, 4).length, wrap(r.right, 30, 4).length) * 16,
    ),
  );
  const H = 46 + heights.reduce((a, b) => a + b, 0);
  let y = 38;
  const body = rows.map((r, i) => {
    const h = heights[i];
    const top = y;
    y += h;
    return (
      <g key={i}>
        {i > 0 && <line x1={0} y1={top} x2={W} y2={top} stroke={LINE} strokeWidth={1} />}
        {hasAspect ? (
          <TextLines
            lines={wrap(r.aspect, 20, 3)}
            x={12}
            y={top + h / 2}
            anchor="start"
            weight={600}
            size={12.5}
            fill={INK}
          />
        ) : null}
        <TextLines lines={wrap(r.left, 30, 4)} x={aspectW + colW / 2} y={top + h / 2} size={12.5} />
        <TextLines
          lines={wrap(r.right, 30, 4)}
          x={aspectW + colW * 1.5}
          y={top + h / 2}
          size={12.5}
        />
      </g>
    );
  });
  return {
    w: W,
    h: H,
    body: (
      <>
        <rect x={0} y={0} width={W} height={38} rx={8} fill={SUNK} />
        <TextLines lines={[cols[0] || "A"]} x={aspectW + colW / 2} y={19} weight={700} size={13} />
        <TextLines lines={[cols[1] || "B"]} x={aspectW + colW * 1.5} y={19} weight={700} size={13} />
        {body}
        {hasAspect ? <line x1={aspectW} y1={0} x2={aspectW} y2={H} stroke={LINE} /> : null}
        <line x1={aspectW + colW} y1={0} x2={aspectW + colW} y2={H} stroke={LINE} />
      </>
    ),
  };
};

/* ---- graph: labelled axes with lines or curves --------------------------

   Added after a real Price Elasticity of Supply lesson produced excellent
   notes and zero diagrams: the whole lesson is about the SHAPE of supply
   curves and not one of the six other shapes can draw an axis. Points come in
   0-100 space both ways so the model never has to think in pixels; y is
   flipped here because SVG counts downwards. */
const graph: Draw = (spec) => {
  const lines = (spec.lines || []).filter((l) => (l.points || []).length >= 2);
  if (!lines.length) return null;
  const W = 400;
  const H = 260;
  const L = 46;
  const R = 18;
  const T = 16;
  const B = 40;

  /* Two coordinate modes, because one quadrant is not enough.

     The original clamped every point to 0-100 with the origin in the bottom
     left corner. That suits a supply curve and makes a maths lesson
     impossible: y = x cubed needs negative y, 1/x lives in two opposite
     quadrants, and reflecting a graph in the x-axis -- the single most common
     thing a transformations lesson does -- has nowhere to go. Points were
     silently clamped to zero, so those curves came out flat along the axis.

     centre mode maps -100..100 both ways with the origin in the middle and
     draws both axes through it. The model asks for it with
     "origin":"centre". */
  const centred = spec.origin === "centre";

  /* Fit the frame to the data, rather than assuming the model normalised it.

     The prompt asks for points on a 0-100 scale, but a model that is thinking
     about physics naturally writes the real numbers -- Example 3.4 emitted the
     force-distance line as (0,2)->(4,10). Clamped to 0-100 that became a stub
     in the bottom-left corner: a labelled, empty-looking graph. Reading the
     actual extent of the points and mapping THAT to the frame draws the line
     correctly whether it arrived as 0-100, 0-10, or -60..90. */
  const all = lines.flatMap((l) =>
    (l.points || []).map((p) => (Array.isArray(p) ? p : [p.x, p.y])),
  );
  const xs = all.map((p) => Number(p[0]) || 0);
  const ys = all.map((p) => Number(p[1]) || 0);

  let x0: number, x1: number, y0: number, y1: number;
  if (centred) {
    // Symmetric about zero on both axes, so the origin sits dead centre and a
    // curve and its reflection are mirror images across a visible axis.
    const m = Math.max(1, ...xs.map(Math.abs), ...ys.map(Math.abs)) * 1.08;
    x0 = -m; x1 = m; y0 = -m; y1 = m;
  } else {
    // Corner: always include the origin so a baseline and the area under a
    // curve read correctly. Pad only the far side so the curve does not touch
    // the frame edge.
    x0 = Math.min(0, ...xs); y0 = Math.min(0, ...ys);
    x1 = Math.max(...xs, x0 + 1); y1 = Math.max(...ys, y0 + 1);
    x1 += (x1 - x0) * 0.06; y1 += (y1 - y0) * 0.06;
  }
  // A single vertical or horizontal line has zero span on one axis; widen it so
  // the division is safe and the line sits sensibly in the frame.
  if (x1 - x0 < 1e-6) { x0 -= 1; x1 += 1; }
  if (y1 - y0 < 1e-6) { y0 -= 1; y1 += 1; }

  const px = (v: number) => L + ((( Number(v) || 0) - x0) / (x1 - x0)) * (W - L - R);
  const py = (v: number) => H - B - ((( Number(v) || 0) - y0) / (y1 - y0)) * (H - T - B);
  // Where the axes cross: the frame corner unless zero is inside the range.
  const ax = x0 < 0 && x1 > 0 ? px(0) : L;
  const ay = y0 < 0 && y1 > 0 ? py(0) : H - B;

  return {
    w: W,
    h: H,
    body: (
      <>
        <line x1={ax} y1={T} x2={ax} y2={H - B} stroke={DIM} strokeWidth={1.25} />
        <line x1={L} y1={ay} x2={W - R} y2={ay} stroke={DIM} strokeWidth={1.25} />
        <text
          x={14}
          y={(T + H - B) / 2}
          fill={INK}
          fontSize={12}
          fontWeight={600}
          textAnchor="middle"
          transform={`rotate(-90 14 ${(T + H - B) / 2})`}
        >
          {spec.y || "Price"}
        </text>
        <text
          x={(L + W - R) / 2}
          y={H - 10}
          fill={INK}
          fontSize={12}
          fontWeight={600}
          textAnchor="middle"
        >
          {spec.x || "Quantity"}
        </text>
        {/* "passes through the origin" is often the whole point. */}
        <text
          x={ax - 8}
          y={ay + 12}
          fill={DIM}
          fontSize={10.5}
          textAnchor="middle"
        >
          0
        </text>
        {lines.map((line, i) => {
          const pts = (line.points || []).map((p) => {
            const pair = Array.isArray(p) ? p : [p.x, p.y];
            return [px(pair[0]), py(pair[1])] as const;
          });
          const d = pts
            .map((p, n) => `${n ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`)
            .join(" ");
          const colour = SERIES[i % SERIES.length];
          const first = pts[0];
          const last = pts[pts.length - 1];
          const vertical = Math.abs(last[0] - first[0]) < 6;
          const lx = vertical ? last[0] : Math.min(last[0] + 6, W - R - 4);
          const ly = vertical ? Math.min(first[1], last[1]) - 6 : last[1] - 5;
          return (
            <g key={i}>
              <path
                d={d}
                fill="none"
                stroke={colour}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray={line.dashed ? "5 4" : undefined}
              />
              {line.label ? (
                <text
                  x={lx}
                  y={Math.max(T + 10, ly)}
                  fill={colour}
                  fontSize={11.5}
                  fontWeight={600}
                  textAnchor={vertical ? "middle" : lx > W - R - 40 ? "end" : "start"}
                >
                  {line.label}
                </text>
              ) : null}
            </g>
          );
        })}
        {spec.note ? (
          <text x={L} y={T + 2} fill={DIM} fontSize={11} textAnchor="start">
            {spec.note}
          </text>
        ) : null}
      </>
    ),
  };
};

/* ---- figure: free-body diagrams, vectors, geometry, circular motion ------

   The shapes a teacher draws that are none of the six above: a mass with force
   arrows out of it, a triangle with labelled sides, a vector sum, a ball on a
   circle. One flexible primitive covers them all -- arrows (with heads),
   segments (without), dots and circles, all on a 0-100 plane with the origin
   bottom-left and y pointing UP, so the model specifies coordinates the way it
   would sketch them rather than in flipped pixels. */
const figure: Draw = (spec, marker) => {
  const num = (v: unknown, d = 0) => (typeof v === "number" && isFinite(v) ? v : d);
  const arrows = (spec.arrows || []).slice(0, 12);
  const segments = (spec.segments || []).slice(0, 14);
  const dots = (spec.dots || []).slice(0, 12);
  const circles = (spec.circles || []).slice(0, 6);
  if (!arrows.length && !segments.length && !dots.length && !circles.length)
    return null;

  const W = 380;
  const H = 300;
  const PAD = 34;
  // 0..100 in, y flipped so 100 is the top of the drawing.
  const px = (x: number) => PAD + (num(x) / 100) * (W - 2 * PAD);
  const py = (y: number) => H - PAD - (num(y) / 100) * (H - 2 * PAD);
  // A label sitting a little beyond the tip of an arrow, pushed outward along
  // the arrow's own direction so it never lands on the line.
  const beyond = (x1: number, y1: number, x2: number, y2: number) => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    return { x: x2 + (dx / len) * 15, y: y2 + (dy / len) * 12 };
  };

  return {
    w: W,
    h: H,
    body: (
      <>
        {circles.map((c, i) => (
          <g key={`c${i}`}>
            <circle
              cx={px(num(c.cx, 50))}
              cy={py(num(c.cy, 50))}
              r={(num(c.r, 20) / 100) * (W - 2 * PAD)}
              fill="none"
              stroke={DIM}
              strokeWidth={1.6}
            />
            {c.label ? (
              <text
                x={px(num(c.cx, 50))}
                y={py(num(c.cy, 50)) - (num(c.r, 20) / 100) * (W - 2 * PAD) - 6}
                textAnchor="middle"
                fontSize={11.5}
                fill={DIM}
              >
                {wrap(asText(c.label), 24, 1)[0]}
              </text>
            ) : null}
          </g>
        ))}

        {segments.map((s, i) => {
          const x1 = px(num(s.x1));
          const y1 = py(num(s.y1));
          const x2 = px(num(s.x2, 100));
          const y2 = py(num(s.y2));
          return (
            <g key={`s${i}`}>
              <line
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke={INK}
                strokeWidth={1.8}
                strokeDasharray={s.dashed ? "5 4" : undefined}
              />
              {s.label ? (
                <text
                  x={(x1 + x2) / 2}
                  y={(y1 + y2) / 2 - 6}
                  textAnchor="middle"
                  fontSize={11.5}
                  fill={DIM}
                >
                  {wrap(asText(s.label), 22, 1)[0]}
                </text>
              ) : null}
            </g>
          );
        })}

        {arrows.map((a, i) => {
          const x1 = px(num(a.x1, 50));
          const y1 = py(num(a.y1, 50));
          const x2 = px(num(a.x2, 50));
          const y2 = py(num(a.y2, 80));
          const colour = SERIES[i % SERIES.length];
          const lab = a.label ? beyond(x1, y1, x2, y2) : null;
          return (
            <g key={`a${i}`}>
              <line
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke={colour}
                strokeWidth={2.4}
                strokeDasharray={a.dashed ? "5 4" : undefined}
                markerEnd={`url(#${marker})`}
              />
              {lab ? (
                <text
                  x={lab.x}
                  y={lab.y}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={12}
                  fontWeight={600}
                  fill={colour}
                >
                  {wrap(asText(a.label), 18, 1)[0]}
                </text>
              ) : null}
            </g>
          );
        })}

        {dots.map((d, i) => (
          <g key={`d${i}`}>
            <circle cx={px(num(d.x, 50))} cy={py(num(d.y, 50))} r={4} fill={INK} />
            {d.label ? (
              <text
                x={px(num(d.x, 50)) + 8}
                y={py(num(d.y, 50)) - 8}
                fontSize={12}
                fontWeight={600}
                fill={INK}
              >
                {wrap(asText(d.label), 22, 1)[0]}
              </text>
            ) : null}
          </g>
        ))}
      </>
    ),
  };
};

const KINDS: Record<string, Draw> = {
  flow,
  cycle,
  mindmap,
  hierarchy,
  timeline,
  compare,
  graph,
  figure,
};

/** One diagram, or nothing at all when the spec cannot be drawn. */
export function Diagram({ spec }: { spec: DiagramSpec }) {
  const marker = `minerva-arrow-${useId().replace(/[^A-Za-z0-9]/g, "")}`;
  if (!spec || typeof spec !== "object") return null;
  const draw = KINDS[String(spec.kind || "").toLowerCase()];
  if (!draw) return null;
  let drawing: Drawing | null = null;
  try {
    drawing = draw(spec, marker);
  } catch {
    drawing = null;
  }
  if (!drawing) return null;
  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${drawing.w} ${drawing.h}`}
        width="100%"
        style={{ maxWidth: drawing.w }}
        role="img"
        aria-label={spec.title || `${spec.kind} diagram`}
        fontFamily="var(--font-sans)"
      >
        <defs>
          <marker
            id={marker}
            viewBox="0 0 10 10"
            refX={9}
            refY={5}
            markerWidth={6}
            markerHeight={6}
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill={DIM} />
          </marker>
        </defs>
        {drawing.body}
      </svg>
    </div>
  );
}

/* ---------------------------------------------------------------- blocks */

function OneBlock({ block }: { block: Block }) {
  switch (block.type) {
    case "summary":
      return (
        <BlockCard label="In one line" kind="summary">
          <p className="font-serif text-[20.5px] leading-[1.62] max-w-[68ch] text-muted-foreground border-l-2 pl-4">
            <InlineMd text={block.text} />
          </p>
        </BlockCard>
      );

    case "points":
      return (
        <BlockCard label={block.heading || "Key points"} kind="points">
          <Outline items={block.items} />
        </BlockCard>
      );

    case "definitions":
      return (
        <BlockCard label="Definitions" kind="definitions">
          <dl className="divide-y">
            {(block.items || []).map((d, i) => (
              <div key={i} className="grid gap-1 py-2.5 first:pt-0 last:pb-0 sm:grid-cols-[180px_1fr] sm:gap-4">
                <dt className="text-[14px] font-semibold">
                  <InlineMd text={d.term} />
                </dt>
                <dd className="font-serif text-[17px] leading-[1.66] text-muted-foreground max-w-[64ch]">
                  <InlineMd text={d.meaning} />
                </dd>
              </div>
            ))}
          </dl>
        </BlockCard>
      );

    /* The one deliberate change from the old build: formula is the block whose
       content is LaTeX by nature and was the only one NOT running mathText, so
       "\frac{\%\Delta Q_s}{\%\Delta P}" printed raw. It runs through the maths
       converter now. */
    case "formula":
      return (
        <BlockCard label="Formula" kind="formula">
          <p className="font-mono text-[19px] leading-snug tabular-nums">
            <InlineMath text={block.formula} />
          </p>
          {block.means ? (
            <p className="mt-2.5 font-serif text-[17px] leading-[1.66] text-muted-foreground max-w-[64ch]">
              <InlineMath text={block.means} />
            </p>
          ) : null}
          {block.when ? (
            <p className="mt-2 text-[12.5px] text-muted-foreground">
              <span className="uppercase tracking-[0.07em] text-[11px] font-semibold">
                Use it when
              </span>{" "}
              <InlineMath text={block.when} />
            </p>
          ) : null}
        </BlockCard>
      );

    case "example":
      return (
        <BlockCard label="Worked example" kind="example">
          {block.title ? (
            <p className="text-[13.5px] font-semibold mb-2">
              <InlineMd text={block.title} />
            </p>
          ) : null}
          <ol className="list-decimal pl-5 space-y-1.5 font-serif text-[18px] leading-[1.72] max-w-[68ch] marker:text-muted-foreground marker:font-mono marker:text-[13px]">
            {(block.steps || []).map((s, i) => (
              <li key={i}>
                <InlineMd text={s} />
              </li>
            ))}
          </ol>
        </BlockCard>
      );

    case "assessed":
      return (
        <BlockCard label="Comes up in assessment" rule="border-l-warn" kind="assessed">
          <Outline items={block.items} />
        </BlockCard>
      );

    case "gaps":
      return (
        <BlockCard label="Ask about next lesson" rule="border-l-info" kind="gaps">
          <Outline items={block.items} />
        </BlockCard>
      );

    /* No generic "Diagram" heading where the drawing names itself: five
       identical headings above five graphs is noise. */
    case "diagram": {
      const drawn = <Diagram spec={block.spec} />;
      return (
        <BlockCard label={block.spec?.title || "Diagram"} kind="diagram">
          {drawn}
          {block.spec?.note ? (
            <p className="mt-2 text-[12.5px] text-muted-foreground">{block.spec.note}</p>
          ) : null}
        </BlockCard>
      );
    }

    default:
      /* An unknown block type is skipped, never shown broken. */
      return null;
  }
}

/**
 * A note's rendered content.
 *
 * Memoised because the recorder ticks ten times a second while a lesson runs
 * and none of that touches the blocks.
 */
export const BlockRenderer = memo(function BlockRenderer({
  blocks,
  className,
}: {
  blocks: Block[] | undefined;
  className?: string;
}) {
  const list = (blocks || []).filter((b) => {
    if (!b || typeof b !== "object") return false;
    /* A diagram whose spec cannot be drawn leaves no empty card behind.

       Checking only that the KIND is known was not enough: a "graph" with no
       usable line, or a "flow" with no nodes, is a known kind that still draws
       nothing, and it left a titled, empty box (the "Forces in vertical
       circular motion" card). Actually attempt the draw and keep the block only
       if it produces something. */
    if (b.type === "diagram") {
      if (!b.spec) return false;
      const draw = KINDS[String(b.spec.kind || "").toLowerCase()];
      if (!draw) return false;
      try {
        return draw(b.spec, "probe") != null;
      } catch {
        return false;
      }
    }
    return true;
  });
  if (!list.length) return null;
  return (
    <div className={cn("note-blocks space-y-4", className)}>
      {list.map((block, i) => (
        <OneBlock key={i} block={block} />
      ))}
    </div>
  );
});

/** Plain text of a block, for search fields and aria labels. */
export function blockText(block: Block): string {
  switch (block.type) {
    case "summary":
      return nodeText(inlineNodes(block.text));
    case "points":
    case "assessed":
    case "gaps":
      return (block.items || []).join("\n");
    case "definitions":
      return (block.items || []).map((d) => `${d.term} — ${d.meaning}`).join("\n");
    case "formula":
      return [block.formula, block.means, block.when].filter(Boolean).join(" ");
    case "example":
      return [block.title, ...(block.steps || [])].filter(Boolean).join("\n");
    case "diagram":
      return block.spec?.title || "";
    default:
      return "";
  }
}

export default BlockRenderer;
