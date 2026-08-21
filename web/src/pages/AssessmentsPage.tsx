/* ==========================================================================
   AssessmentsPage — FAs, summatives and tests, deliberately not homework.

   Homework is a deadline: you do it, you hand it in, it is gone. A formative
   is a different animal — it needs several days of revision *before* the date,
   and the day it arrives is the day it is too late to start. Mixing the two in
   one list is exactly how a test creeps up on a disorganised student, so this
   screen keeps them apart and answers one question first: how long have I got,
   and what can I do about it right now.

   Hence the shape of the page. A stat row of hard numbers, then a single hero
   card for the very next thing with the one action that actually helps —
   practice questions built from the student's own notes — then the rest of the
   list split into "this week" and "later", because those are two different
   feelings and should not share a heading.

   The server owns urgency (`band`) and the countdown (`days`). This page never
   re-derives either; it only decides how loudly to say them.
   ========================================================================== */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import { StatRow, type Stat } from "@/components/StatRow"
import { inlineNodes, type InlineNode } from "@/lib/mathText"

/* ------------------------------------------------------------------ shapes */

/** The server's urgency vocabulary. Nothing here invents a sixth band. */
export type AssessmentBand =
  | "overdue"
  | "today"
  | "tomorrow"
  | "this_week"
  | "later"
  | "past"
  | "undated"

/** One of the student's own notes, offered as revision material. */
export type ReviseNote = {
  id: string
  title: string
  topic: string
}

export type Assessment = {
  uid: string
  title: string
  subject: string
  detail: string
  when: string | null
  days: number | null
  band: AssessmentBand
  url: string
  revise_from: ReviseNote[]
  can_practise: boolean
}

type AssessmentsResponse = {
  assessments: Assessment[]
  count: number
  next: Assessment | null
  subjects: string[]
}

export type PracticeQuestion = {
  q: string
  marks: number
  /** recall | apply | analyse | calculate — free text, so it is never trusted. */
  kind: string
  /** The IB command term: Define, Explain, Calculate, Analyse, Evaluate. */
  command: string
  answer: string
  working: string[]
  why: string
  trap: string
}

export type PracticeResult = {
  topic: string
  questions: PracticeQuestion[]
}

export type AssessmentsPageProps = {
  /** Open one of the student's notes in the host app. */
  onOpenNote?: (id: string) => void
  /** Send the student to Settings, where ManageBac is connected. */
  onOpenSettings?: () => void
  /** Told what was just practised, once the questions have come back. */
  onPractise?: (opts: { subject?: string; noteId?: string }) => void
}

/* ----------------------------------------------------------------- helpers */

/** Bands that mean "this is inside the next seven days". */
const WEEK_BANDS = new Set<AssessmentBand>([
  "overdue",
  "today",
  "tomorrow",
  "this_week",
])

function isThisWeek(row: Assessment): boolean {
  if (WEEK_BANDS.has(row.band)) return true
  return row.days !== null && row.days <= 7
}

/**
 * The countdown, said out loud.
 *
 * Short enough to sit in a mono column next to a date without wrapping.
 */
function daysLabel(days: number | null): string {
  if (days === null) return "no date"
  if (days < 0) return `${-days}d ago`
  if (days === 0) return "today"
  if (days === 1) return "tomorrow"
  return `in ${days}d`
}

/** The date, as a student would read it off a wall: "Mon 24 Mar". */
function formatWhen(when: string | null): string {
  if (!when) return "no date"
  const [y, m, d] = when.slice(0, 10).split("-").map(Number)
  if (!y || !m || !d) return "no date"
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  })
}

/* Urgency owns the temperature of the text and nothing else. Two days out is
   the point at which "later" stops being true, which is where red starts. */
function toneFor(days: number | null): string {
  if (days === null) return "text-muted-foreground"
  if (days <= 2) return "text-late"
  if (days <= 7) return "text-warn"
  return "text-muted-foreground"
}

/**
 * The big number in the hero, and the words under it.
 *
 * Split out because the singular/plural/today/past branches are exactly the
 * sort of thing that turns into an unreadable nest of ternaries inside JSX.
 */
function heroCount(days: number | null): { value: string; label: string } {
  if (days === null) return { value: "—", label: "no date" }
  if (days < 0) {
    return { value: String(-days), label: days === -1 ? "day ago" : "days ago" }
  }
  if (days === 0) return { value: "today", label: "sit it today" }
  return { value: String(days), label: days === 1 ? "day away" : "days away" }
}

/**
 * One line of encouragement sized to how close the thing is.
 *
 * This app exists to take pressure off, so the closer the date the more
 * concrete and the *smaller* the suggested action gets — a student two days
 * out does not need to be told the situation is serious, they need to be told
 * twenty minutes is enough to start.
 */
function encouragement(days: number | null): string {
  if (days === null) return "No date on this one yet."
  if (days <= 0) return "It is today. Ten minutes of questions still helps."
  if (days === 1) return "Tomorrow. One short set of questions beats re-reading."
  if (days <= 3) return "This is the good window — little and often from here."
  if (days <= 7) return "Start this week and it never has to become a cram."
  return "Plenty of time. A quick pass now means nothing to panic about later."
}

/**
 * A stable colour index per subject.
 *
 * Built from the profile's subject list first so the dot for Physics is the
 * same colour here as it is in the sidebar, with anything the calendar knows
 * about but the profile does not appended on the end.
 */
function subjectIndexes(profile: string[], rows: Assessment[]): Map<string, number> {
  const order: string[] = []
  const seen = new Set<string>()
  const add = (name: string) => {
    const key = name.trim().toLowerCase()
    if (!key || seen.has(key)) return
    seen.add(key)
    order.push(key)
  }
  profile.forEach(add)
  rows.forEach((row) => add(row.subject))
  return new Map(order.map((key, i) => [key, i]))
}

/* ------------------------------------------------------------------- icons */

function IconCalendar() {
  return (
    <svg
      width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
    >
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4M9 15l2 2 4-4" />
    </svg>
  )
}

function IconSpark() {
  return (
    <svg
      width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
    >
      <path d="M12 3l1.9 4.8L19 9.7l-4.6 2.1L12 17l-2.4-5.2L5 9.7l5.1-1.9z" />
      <path d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
    </svg>
  )
}

function IconNote() {
  return (
    <svg
      width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
    >
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H12v16H5.5A1.5 1.5 0 0 1 4 18.5z" />
      <path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H12v16h6.5a1.5 1.5 0 0 0 1.5-1.5z" />
    </svg>
  )
}

function IconGear() {
  return (
    <svg
      width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

function IconSpinner() {
  return (
    <svg
      width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"
      stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"
      className="animate-spin"
    >
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  )
}

function IconArrow() {
  return (
    <svg
      width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
    >
      <path d="M7 17 17 7M9 7h8v8" />
    </svg>
  )
}

/* -------------------------------------------------------------- primitives */

const BTN_GHOST =
  "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1.5 " +
  "text-[12px] font-medium text-muted-foreground transition-colors " +
  "hover:bg-muted hover:text-foreground focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-ring " +
  "disabled:pointer-events-none disabled:opacity-45"

const BTN_HERO =
  "btn-brand inline-flex shrink-0 items-center gap-2 rounded-md px-4 py-2.5 " +
  "text-[13.5px] font-semibold focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 " +
  "disabled:pointer-events-none disabled:opacity-45 disabled:shadow-none"

const CARD =
  "rounded-[10px] border bg-card shadow-[0_1px_2px_rgba(20,20,26,0.04)] " +
  "transition-[transform,box-shadow] duration-[140ms] ease-out " +
  "hover:-translate-y-0.5 " +
  "hover:shadow-[0_2px_4px_rgba(28,27,25,0.06),0_14px_34px_rgba(28,27,25,0.10)]"

function SubjectDot({ index }: { index: number }) {
  return (
    <span
      aria-hidden="true"
      className="mt-[5px] size-2.5 shrink-0 rounded-[3px]"
      style={
        index < 0
          ? { background: "var(--color-border)" }
          : { background: "var(--subj-" + (index % 8) + ")" }
      }
    />
  )
}

function Pill({
  tone = "quiet",
  children,
}: {
  tone?: "quiet" | "brand" | "warn"
  children: ReactNode
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-px text-[10.5px] leading-[1.55]",
        tone === "quiet" && "border-border text-muted-foreground",
        tone === "brand" && "border-brand/40 text-brand",
        tone === "warn" && "border-warn/50 text-warn",
      )}
    >
      {children}
    </span>
  )
}

/** A bordered card with the quiet header bar the whole app shares. */
function Panel({
  title,
  count,
  index = 0,
  children,
}: {
  title: string
  count?: number
  index?: number
  children: ReactNode
}) {
  return (
    <section
      className={cn("minerva-rise overflow-hidden", CARD)}
      style={{ animationDelay: `${Math.min(index, 3) * 0.04}s` }}
    >
      <header className="flex items-center gap-2 border-b px-3.5 py-2.5">
        <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted-foreground">
          {title}
        </span>
        {count !== undefined ? (
          <span className="ml-auto font-mono text-[11px] tabular-nums text-muted-foreground">
            {count}
          </span>
        ) : null}
      </header>
      {children}
    </section>
  )
}

/* Question text arrives with maths in it — `v = u + at`, `H<sub>2</sub>O`,
   `\frac{1}{2}`. mathText turns that into a small closed tag tree; this walks
   it. Kept local so this screen carries no dependency on the note renderer. */
function renderNodes(nodes: InlineNode[]): ReactNode {
  return nodes.map((node, i) => {
    if (typeof node === "string") return node
    const kids = renderNodes(node.children)
    if (node.tag === "sub") return <sub key={i}>{kids}</sub>
    if (node.tag === "sup") return <sup key={i}>{kids}</sup>
    if (node.tag === "b") return <b key={i} className="font-semibold">{kids}</b>
    if (node.tag === "i") return <i key={i}>{kids}</i>
    return (
      <code key={i} className="rounded bg-muted px-1 py-px font-mono text-[0.9em]">
        {kids}
      </code>
    )
  })
}

function Rich({ text }: { text: string }) {
  return <>{renderNodes(inlineNodes(text))}</>
}

/* ------------------------------------------------------------ note links */

function ReviseLinks({
  notes,
  onOpenNote,
}: {
  notes: ReviseNote[]
  onOpenNote?: (id: string) => void
}) {
  if (!notes.length) return null
  return (
    <span className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
        <IconNote />
        Revise from
      </span>
      {notes.map((note) => (
        <a
          key={note.id}
          href={`#/note/${note.id}`}
          title={note.topic || note.title}
          onClick={(event) => {
            if (!onOpenNote) return
            event.preventDefault()
            onOpenNote(note.id)
          }}
          className="max-w-[190px] truncate text-[11.5px] text-brand underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {note.title}
        </a>
      ))}
    </span>
  )
}

/* ------------------------------------------------------------------- rows */

function AssessmentRow({
  row,
  colour,
  busy,
  disabled,
  onPractise,
  onOpenNote,
}: {
  row: Assessment
  colour: number
  busy: boolean
  disabled: boolean
  onPractise: () => void
  onOpenNote?: (id: string) => void
}) {
  const external = !!row.url

  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-2 border-t px-3.5 py-3 transition-colors first:border-t-0 hover:bg-muted/40">
      <SubjectDot index={colour} />

      <div className="min-w-0 flex-1 basis-[14rem]">
        {external ? (
          <a
            href={row.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`${row.title}, opens ManageBac in a new tab`}
            className="inline-flex items-baseline gap-1 text-[13.5px] font-medium underline-offset-2 hover:underline"
          >
            <span className="truncate">{row.title}</span>
            <span className="shrink-0 text-muted-foreground">
              <IconArrow />
            </span>
          </a>
        ) : (
          <span className="block truncate text-[13.5px] font-medium">{row.title}</span>
        )}

        <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted-foreground">
          {row.subject ? <span>{row.subject}</span> : null}
          {row.detail ? (
            <span className="max-w-[26rem] truncate">{row.detail}</span>
          ) : null}
        </span>

        <ReviseLinks notes={row.revise_from} onOpenNote={onOpenNote} />
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-3">
        <span className="text-right font-mono text-[12px] tabular-nums">
          <span className="block text-muted-foreground">{formatWhen(row.when)}</span>
          <span className={cn("block text-[11px]", toneFor(row.days))}>
            {daysLabel(row.days)}
          </span>
        </span>

        {row.can_practise ? (
          <button
            type="button"
            className={BTN_GHOST}
            disabled={disabled}
            aria-label={`Practise ${row.subject || row.title}`}
            onClick={onPractise}
          >
            {busy ? <IconSpinner /> : null}
            {busy ? "Writing…" : "Practise"}
          </button>
        ) : null}
      </div>
    </li>
  )
}

/* --------------------------------------------------------------- practice */

/* /api/practice is a real model call: 15-40 seconds. A button that greys out
   and says nothing for half a minute reads as broken, and a student who thinks
   it is broken presses it again. So the wait gets its own panel, a ticking
   count and a bar that keeps moving — the honest version of "still working". */
function practiceStage(seconds: number): string {
  if (seconds < 8) return "Reading your notes…"
  if (seconds < 20) return "Writing exam-style questions…"
  if (seconds < 34) return "Working through the answers…"
  return "Nearly there — the long ones are worth the wait."
}

function PracticeProgress({ label, seconds }: { label: string; seconds: number }) {
  const pct = Math.min(94, 6 + (seconds / 38) * 88)
  return (
    <section
      role="status"
      aria-live="polite"
      className="brand-panel mb-4 rounded-[10px] px-4 py-3.5"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-brand">
          <IconSpinner />
        </span>
        <span className="text-[13px] font-medium">{practiceStage(seconds)}</span>
        <span className="ml-auto font-mono text-[12px] tabular-nums text-muted-foreground">
          {seconds}s
        </span>
      </div>
      <p className="mt-1 text-[11.5px] text-muted-foreground">
        {label} · questions are written from your own notes, so this takes a
        moment. You can keep reading the list below.
      </p>
      <div
        className="mt-2.5 h-1 overflow-hidden rounded-full bg-brand/15"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-label="Writing practice questions"
      >
        <div
          className="brand-gradient h-full rounded-full transition-[width] duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </section>
  )
}

function QuestionCard({
  question,
  number,
  open,
  onToggle,
}: {
  question: PracticeQuestion
  number: number
  open: boolean
  onToggle: () => void
}) {
  return (
    <li className="border-t px-4 py-3.5 first:border-t-0">
      <div className="flex gap-3">
        <span className="mt-px font-mono text-[12px] tabular-nums text-muted-foreground">
          {number}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] leading-relaxed">
            <Rich text={question.q} />
          </p>

          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {question.command ? <Pill tone="brand">{question.command}</Pill> : null}
            {question.kind ? <Pill>{question.kind}</Pill> : null}
            {question.marks > 0 ? (
              <Pill>
                <span className="font-mono tabular-nums">{question.marks}</span>
                <span className="ml-1">{question.marks === 1 ? "mark" : "marks"}</span>
              </Pill>
            ) : null}
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={open}
              className="ml-auto text-[11.5px] text-brand underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {open ? "Hide answer" : "Show answer"}
            </button>
          </div>

          {open ? (
            <div className="mt-2.5 space-y-2 rounded-md border bg-muted/40 px-3 py-2.5">
              <p className="text-[13px] leading-relaxed">
                <Rich text={question.answer} />
              </p>

              {question.working.length ? (
                <ol className="space-y-1">
                  {question.working.map((step, i) => (
                    <li
                      key={i}
                      className="flex gap-2 text-[12.5px] leading-relaxed text-muted-foreground"
                    >
                      <span className="font-mono text-[11px] tabular-nums">{i + 1}</span>
                      <span className="min-w-0 flex-1">
                        <Rich text={step} />
                      </span>
                    </li>
                  ))}
                </ol>
              ) : null}

              {question.why ? (
                <p className="text-[12px] text-muted-foreground">
                  <span className="font-semibold">Why: </span>
                  <Rich text={question.why} />
                </p>
              ) : null}

              {question.trap ? (
                <p className="text-[12px] text-warn">
                  <span className="font-semibold">Easy to lose a mark: </span>
                  <Rich text={question.trap} />
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </li>
  )
}

/* ------------------------------------------------------------- the screen */

export function AssessmentsPage({
  onOpenNote,
  onOpenSettings,
  onPractise,
}: AssessmentsPageProps) {
  const [data, setData] = useState<AssessmentsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  const [busy, setBusy] = useState("")
  const [busyLabel, setBusyLabel] = useState("")
  const [seconds, setSeconds] = useState(0)
  const [result, setResult] = useState<PracticeResult | null>(null)
  const [practiceError, setPracticeError] = useState("")
  const [openAnswers, setOpenAnswers] = useState<Record<number, boolean>>({})
  const resultRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await api.get<AssessmentsResponse>("/api/assessments"))
      setError("")
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /* The clock only runs while a request is in flight, and restarts with each
     one, so the number on screen is elapsed time and not a guess. */
  useEffect(() => {
    if (!busy) return
    setSeconds(0)
    const started = Date.now()
    const timer = window.setInterval(
      () => setSeconds(Math.round((Date.now() - started) / 1000)),
      250,
    )
    return () => window.clearInterval(timer)
  }, [busy])

  useEffect(() => {
    if (!result) return
    resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [result])

  const practise = useCallback(
    async (key: string, label: string, opts: { subject?: string; noteId?: string }) => {
      setBusy(key)
      setBusyLabel(label)
      setPracticeError("")
      setResult(null)
      setOpenAnswers({})
      try {
        const out = await api.post<PracticeResult>("/api/practice", {
          subject: opts.subject || "",
          note_id: opts.noteId || "",
        })
        setResult({ topic: out.topic || label, questions: out.questions || [] })
        onPractise?.(opts)
      } catch (err: unknown) {
        /* The server writes these sentences for a student to read — "there are
           no notes in Physics to practise from yet". Passing it through
           untouched is the whole contract. */
        setPracticeError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy("")
      }
    },
    [onPractise],
  )

  const rows = useMemo(() => data?.assessments ?? [], [data])
  const colours = useMemo(
    () => subjectIndexes(data?.subjects ?? [], rows),
    [data, rows],
  )
  const colourOf = useCallback(
    (subject: string) => {
      const found = colours.get(subject.trim().toLowerCase())
      return found === undefined ? -1 : found
    },
    [colours],
  )

  const week = useMemo(() => rows.filter(isThisWeek), [rows])
  const later = useMemo(() => rows.filter((row) => !isThisWeek(row)), [rows])
  const month = useMemo(
    () => rows.filter((row) => row.days !== null && row.days <= 31).length,
    [rows],
  )
  const subjectCount = useMemo(
    () => new Set(rows.map((row) => row.subject.trim()).filter(Boolean)).size,
    [rows],
  )

  const next = data?.next ?? rows[0] ?? null
  const hero = heroCount(next?.days ?? null)

  const stats: Stat[] = [
    {
      label: "Next up",
      value: next ? daysLabel(next.days) : "—",
      sub: next ? next.subject || next.title : "nothing scheduled",
      alert: !!next && next.days !== null && next.days <= 2,
    },
    {
      label: "This week",
      value: week.length,
      sub: week.length ? "in the next 7 days" : "nothing in 7 days",
    },
    { label: "This month", value: month, sub: "in the next 31 days" },
    {
      label: "Subjects",
      value: subjectCount,
      sub: subjectCount === 1 ? "subject covered" : "subjects covered",
    },
  ]

  const groups = [
    { name: "This week", rows: week },
    { name: "Later", rows: later },
  ].filter((group) => group.rows.length)

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-6">
      {/* ------------------------------------------------------------ header */}
      <header className="mb-5">
        <h1 className="text-[19px] font-semibold tracking-tight">FAs &amp; tests</h1>
        <p className="mt-0.5 text-[12.5px] text-muted-foreground">
          Everything you sit, kept away from everything you hand in — because a
          test needs a few days of revision, not a reminder the night before.
        </p>
      </header>

      <StatRow stats={stats} />

      {error ? (
        <div className="mb-4 rounded-[10px] border border-l-2 border-l-late bg-card px-4 py-3">
          <p className="text-[13px] text-late">{error}</p>
          <button type="button" className={cn(BTN_GHOST, "mt-2")} onClick={() => void load()}>
            Try again
          </button>
        </div>
      ) : null}

      {loading ? (
        <p className="text-[13px] text-muted-foreground">Looking at your calendar…</p>
      ) : rows.length === 0 && !error ? (
        /* ------------------------------------------------------ empty state.
           Guarded on `error` as well as on the count: a page that greets a
           dropped connection with "no tests on the horizon" is telling the
           student something reassuring that it does not actually know. */
        <section className="brand-panel rounded-[10px] px-5 py-6">
          <div className="flex items-start gap-3">
            <span className="mt-px text-brand">
              <IconCalendar />
            </span>
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold">
                No tests on the horizon — enjoy it while it lasts.
              </h2>
              <p className="mt-1 max-w-[46rem] text-[13px] leading-relaxed text-muted-foreground">
                Formatives, summatives and tests land on this page by themselves
                once your ManageBac calendar is connected, with the notes to
                revise from already attached. You never have to type one in.
              </p>
              <button
                type="button"
                className={cn(BTN_HERO, "mt-3.5")}
                onClick={() => {
                  if (onOpenSettings) onOpenSettings()
                  else window.location.hash = "#/settings"
                }}
              >
                <IconGear />
                Connect ManageBac in Settings
              </button>
            </div>
          </div>
        </section>
      ) : (
        <>
          {/* -------------------------------------------------------- hero */}
          {next ? (
            <section className="brand-panel minerva-rise mb-4 rounded-[10px] px-5 py-[18px]">
              <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.08em] text-muted-foreground">
                <span className="text-brand">
                  <IconCalendar />
                </span>
                Next up
              </div>

              <div className="mt-3 flex flex-wrap items-start gap-x-5 gap-y-4">
                <div className="flex min-w-0 flex-1 basis-[16rem] items-start gap-2.5">
                  <SubjectDot index={colourOf(next.subject)} />
                  <div className="min-w-0">
                    <h2 className="text-[17px] font-semibold leading-snug">
                      {next.title}
                    </h2>
                    <p className="mt-0.5 font-mono text-[12px] tabular-nums text-muted-foreground">
                      {[next.subject, formatWhen(next.when)].filter(Boolean).join(" · ")}
                    </p>
                    <p className="mt-1.5 text-[12.5px] text-muted-foreground">
                      {encouragement(next.days)}
                    </p>
                  </div>
                </div>

                <div className="shrink-0 text-right">
                  <div
                    className={cn(
                      "font-mono text-[32px] leading-none tabular-nums",
                      toneFor(next.days),
                    )}
                  >
                    {hero.value}
                  </div>
                  <div className="mt-1 text-[11px] font-bold uppercase tracking-[0.08em] text-muted-foreground">
                    {hero.label}
                  </div>
                </div>

                <div className="shrink-0">
                  <button
                    type="button"
                    className={BTN_HERO}
                    disabled={!next.can_practise || !!busy}
                    onClick={() =>
                      void practise(
                        `next:${next.uid}`,
                        next.subject || next.title,
                        { subject: next.subject },
                      )
                    }
                  >
                    {busy === `next:${next.uid}` ? <IconSpinner /> : <IconSpark />}
                    {busy === `next:${next.uid}` ? "Writing questions…" : "Practise this now"}
                  </button>
                  {!next.can_practise ? (
                    <p className="mt-1.5 max-w-[15rem] text-[11.5px] text-muted-foreground">
                      Questions come from your own notes — there are none in{" "}
                      {next.subject || "this subject"} yet.
                    </p>
                  ) : null}
                </div>
              </div>
            </section>
          ) : null}

          {/* ---------------------------------------------------- practice */}
          {busy ? <PracticeProgress label={busyLabel} seconds={seconds} /> : null}

          {practiceError ? (
            <div className="mb-4 rounded-[10px] border border-l-2 border-l-late bg-card px-4 py-3">
              <p className="text-[13px] text-late">{practiceError}</p>
            </div>
          ) : null}

          {result ? (
            <div ref={resultRef} className="mb-4 scroll-mt-4">
              <section className={cn("overflow-hidden", CARD)}>
                <header className="flex flex-wrap items-center gap-2 border-b px-3.5 py-2.5">
                  <span className="text-brand">
                    <IconSpark />
                  </span>
                  <span className="min-w-0 truncate text-[12px] font-bold uppercase tracking-[0.08em] text-muted-foreground">
                    Practice · {result.topic}
                  </span>
                  <span className="ml-auto font-mono text-[11px] tabular-nums text-muted-foreground">
                    {result.questions.length}
                  </span>
                  <button
                    type="button"
                    className={BTN_GHOST}
                    onClick={() => {
                      setResult(null)
                      setOpenAnswers({})
                    }}
                  >
                    Hide
                  </button>
                </header>

                {result.questions.length ? (
                  <ol>
                    {result.questions.map((question, i) => (
                      <QuestionCard
                        key={i}
                        question={question}
                        number={i + 1}
                        open={!!openAnswers[i]}
                        onToggle={() =>
                          setOpenAnswers((open) => ({ ...open, [i]: !open[i] }))
                        }
                      />
                    ))}
                  </ol>
                ) : (
                  <p className="px-4 py-3.5 text-[13px] text-muted-foreground">
                    Nothing came back that time. Press Practise again in a minute.
                  </p>
                )}
              </section>
            </div>
          ) : null}

          {/* -------------------------------------------------- the list */}
          <div className="space-y-4">
            {groups.map((group, i) => (
              <Panel key={group.name} title={group.name} count={group.rows.length} index={i}>
                <ul>
                  {group.rows.map((row) => (
                    <AssessmentRow
                      key={row.uid}
                      row={row}
                      colour={colourOf(row.subject)}
                      busy={busy === `row:${row.uid}`}
                      disabled={!!busy}
                      onOpenNote={onOpenNote}
                      onPractise={() =>
                        void practise(
                          `row:${row.uid}`,
                          row.subject || row.title,
                          { subject: row.subject },
                        )
                      }
                    />
                  ))}
                </ul>
              </Panel>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

export default AssessmentsPage
