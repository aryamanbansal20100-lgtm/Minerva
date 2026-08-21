/* ==========================================================================
   StudyNudge — the app noticing something on the student's behalf.

   The school this was built for does not announce anything. Classes move, a
   formative appears in a teacher's slide deck and nowhere else, and the first
   time a test is real is the morning it happens. This strip is the one place
   the app is allowed to speak first.

   Three rules make that bearable rather than nagging:

     - ONE nudge. Never a stack. The moment a screen carries two banners the
       student starts reading past both of them, and the third one — the one
       that mattered — is already invisible.
     - SILENCE IS THE DEFAULT. Nothing pressing renders nothing at all, not an
       "all clear" card. A strip that is always there is wallpaper.
     - NO GUILT. "worth starting", never "you are behind". Overdue work is
       counted, not scolded: the number is red, the sentence is not.

   `pickNudge` holds all of the judgement and touches nothing but its two
   arguments, so the priority order can be tested without a DOM, and the
   component below is only ever asking "what did it pick, and is it dismissed".

   No StatRow here on purpose: this is a strip that sits under a page's stat
   row, not a page of its own.
   ========================================================================== */

import { useEffect, useMemo, useState } from "react"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"

/* ------------------------------------------------------------------ shapes */

/** One of the student's own notes, offered as revision material. */
export type ReviseSource = {
  id: string
  title: string
  topic: string
}

/** The server's urgency vocabulary, straight from `managebac.band_for`. */
export type AssessmentBand =
  | "overdue"
  | "today"
  | "tomorrow"
  | "this_week"
  | "later"
  | "past"
  | "undated"

/** A row of GET /api/assessments. */
export type Assessment = {
  uid: string
  title: string
  subject: string
  detail?: string
  when?: string | null
  /** Days from today, as the server counted them. Negative means it passed. */
  days?: number | null
  band?: AssessmentBand
  url?: string
  revise_from?: ReviseSource[]
  can_practise?: boolean
}

/** A row of GET /api/tasks. Deliberately looser than the Due page's Task. */
export type NudgeTask = {
  id: string
  title: string
  subject?: string
  due?: string | null
  done?: 0 | 1 | boolean
  kind?: string
}

/** What the one button does. `review` means "show me the overdue work". */
export type NudgeAction = {
  label: string
  run: "practise" | "review"
}

export type NudgeKind = "practise" | "overdue" | "start"

/**
 * The chosen nudge, already worded.
 *
 * The sentence arrives in three pieces because exactly one number in it wants
 * monospaced tabular figures — the house rule for every count and date in this
 * app. `text` is the same sentence joined up, which is what a test asserts on.
 */
export type Nudge = {
  kind: NudgeKind
  /** Stable identity, so dismissing survives a re-render. */
  key: string
  /** Sentence up to the number. */
  before: string
  /** The number itself, "" when the sentence has none ("is today"). */
  figure: string
  /** Sentence after the number. */
  after: string
  /** before + figure + after. */
  text: string
  /** The quiet second line. Context, never a second instruction. */
  sub: string
  /** Empty for nudges that are not about one subject. */
  subject: string
  /** Index into --subj-0 .. --subj-7. */
  hue: number
  action: NudgeAction | null
  /** ManageBac link, when the item carried one. */
  url: string
  /** Days until the assessment; null for the overdue nudge. */
  days: number | null
  /** How many things slipped; 0 unless this is the overdue nudge. */
  count: number
}

type AssessmentsResponse = {
  assessments?: Assessment[]
  count?: number
  next?: Assessment | null
  subjects?: string[]
}

type TasksResponse = { tasks?: NudgeTask[] }

/* ----------------------------------------------------------------- windows */

/** "Practise for this now" reaches three days out. */
const PRACTISE_WITHIN = 3
/** "Worth starting" covers the rest of the week. */
const START_FROM = 4
const START_UNTIL = 7

/* ----------------------------------------------------------------- helpers */

/**
 * Whole days from today, counted on the local calendar.
 *
 * Not UTC: a test at 09:00 tomorrow is "tomorrow" to the student even when the
 * timezone puts the timestamp on today's date, and midnight is the boundary
 * they actually feel.
 */
function daysFromToday(when: string | null | undefined): number | null {
  if (!when) return null
  const [y, m, d] = when.slice(0, 10).split("-").map(Number)
  if (!y || !m || !d) return null
  const target = new Date(y, m - 1, d).getTime()
  const now = new Date()
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const days = Math.round((target - base) / 86400000)
  return Number.isFinite(days) ? days : null
}

/** The server already counted; fall back to the date only when it did not. */
function daysFor(item: Assessment): number | null {
  if (typeof item.days === "number" && Number.isFinite(item.days)) return item.days
  return daysFromToday(item.when)
}

function isDone(task: NudgeTask): boolean {
  return task.done === true || task.done === 1
}

/** Practising needs a subject to pool notes from, and notes to pool. */
function canPractise(item: Assessment): boolean {
  if (!(item.subject || "").trim()) return false
  return item.can_practise ?? (item.revise_from?.length ?? 0) > 0
}

/**
 * The short name a student would use out loud: "FA", "mock", "paper".
 *
 * Titles arrive as whatever the teacher typed — "Formative Assessment 3:
 * market failure" — and reading that back at somebody is not a nudge, it is a
 * spreadsheet.
 */
function kindWord(title: string): string {
  const t = title.toLowerCase()
  if (/\bfas?\b|formative/.test(t)) return "FA"
  if (/\bsas?\b|summative/.test(t)) return "SA"
  if (/\bmock/.test(t)) return "mock"
  if (/\bpaper\s*\d/.test(t)) return "paper"
  if (/\bexam/.test(t)) return "exam"
  if (/\btest\b/.test(t)) return "test"
  if (/\bquiz/.test(t)) return "quiz"
  if (/\boral\b|\bpresentation\b/.test(t)) return "oral"
  return ""
}

/** "Economics FA", "Biology test", or the raw title when there is no subject. */
function assessmentLabel(item: Assessment): string {
  const subject = (item.subject || "").trim()
  const kind = kindWord(item.title || "")
  if (subject && kind) return `${subject} ${kind}`
  if (subject) return `${subject} assessment`
  return (item.title || "").trim() || "Your next assessment"
}

/** "Fri 28 Aug" — short enough to sit in a second line without wrapping. */
function shortDate(when: string | null | undefined): string {
  if (!when) return ""
  const [y, m, d] = when.slice(0, 10).split("-").map(Number)
  if (!y || !m || !d) return ""
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  })
}

/**
 * A stable slot in --subj-0 .. --subj-7 for a subject name.
 *
 * Hashed rather than looked up in the profile's subject list, because a nudge
 * has to colour itself the same way whether or not the caller happened to load
 * the profile first.
 */
function hueIndex(subject: string): number {
  let h = 0
  for (let i = 0; i < subject.length; i++) {
    h = (h * 31 + subject.charCodeAt(i)) % 4096
  }
  return h % 8
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many
}

/* --------------------------------------------------------- the three lines */

function practiseNudge(item: Assessment, days: number): Nudge {
  const label = assessmentLabel(item)
  const ask = " — want to run through some questions?"
  const named = days === 0 ? "today" : days === 1 ? "tomorrow" : ""

  const before = named ? `${label} is ${named}${ask}` : `${label} is in `
  const figure = named ? "" : String(days)
  const after = named ? "" : ` days${ask}`

  const notes = item.revise_from?.length ?? 0
  const sub = [
    shortDate(item.when),
    notes
      ? `${notes} ${plural(notes, "note", "notes")} of yours to practise from`
      : "built from your own notes",
  ]
    .filter(Boolean)
    .join(" · ")

  return {
    kind: "practise",
    key: `practise:${item.uid}`,
    before,
    figure,
    after,
    text: before + figure + after,
    sub,
    subject: (item.subject || "").trim(),
    hue: hueIndex(item.subject || ""),
    action: { label: "Practise now", run: "practise" },
    url: item.url || "",
    days,
    count: 0,
  }
}

function overdueNudge(count: number): Nudge {
  const after = plural(
    count,
    " thing slipped past its date",
    " things slipped past their date",
  )
  return {
    kind: "overdue",
    key: "overdue",
    before: "",
    figure: String(count),
    after,
    text: String(count) + after,
    /* Stated, not scolded. The student already knows; what they need is the
       list and a way in, not a verdict on their week. */
    sub: "Still doable — pick one and it is off the list",
    subject: "",
    hue: 0,
    action: { label: "See them", run: "review" },
    url: "",
    days: null,
    count,
  }
}

function startNudge(item: Assessment, days: number): Nudge {
  const label = assessmentLabel(item)
  const before = `${label} is in `
  const figure = String(days)
  const after = " days — worth starting when you get a minute"

  return {
    kind: "start",
    key: `start:${item.uid}`,
    before,
    figure,
    after,
    text: before + figure + after,
    sub: [shortDate(item.when), "still plenty of room"].filter(Boolean).join(" · "),
    subject: (item.subject || "").trim(),
    hue: hueIndex(item.subject || ""),
    action: canPractise(item) ? { label: "Start early", run: "practise" } : null,
    url: item.url || "",
    days,
    count: 0,
  }
}

/* -------------------------------------------------------------- the choice */

function overdueCount(assessments: Assessment[], tasks: NudgeTask[]): number {
  let n = 0
  for (const task of tasks) {
    if (isDone(task)) continue
    const days = daysFromToday(task.due)
    if (days !== null && days < 0) n++
  }
  for (const item of assessments) {
    /* "past" is a lesson that has already happened, not a missed deadline —
       counting it as slipped would invent work out of the timetable. */
    if (item.band === "past") continue
    const days = daysFor(item)
    if (item.band === "overdue" || (days !== null && days < 0)) n++
  }
  return n
}

/**
 * The single most useful thing to say right now, or nothing.
 *
 * Pure: same two arrays in, same nudge out, no clock beyond today's date and
 * no network. The order is the whole opinion of this component —
 *
 *   1. something in the next three days that can actually be practised for,
 *      because that is the only case where the app can DO the next step rather
 *      than describe it;
 *   2. work that slipped, counted plainly;
 *   3. the rest of the week, offered rather than urged;
 *   4. otherwise silence.
 *
 * @example
 * pickNudge(assessments, tasks)?.text
 * // "Economics FA is in 2 days — want to run through some questions?"
 */
export function pickNudge(
  assessments: Assessment[],
  tasks: NudgeTask[],
): Nudge | null {
  const items = assessments ?? []
  const open = tasks ?? []

  const dated = items
    .filter((item) => item.band !== "past")
    .map((item) => ({ item, days: daysFor(item) }))
    .filter(
      (row): row is { item: Assessment; days: number } => row.days !== null,
    )
    .sort(
      (l, r) =>
        l.days - r.days || (l.item.when || "").localeCompare(r.item.when || ""),
    )

  const practise = dated.find(
    (row) => row.days >= 0 && row.days <= PRACTISE_WITHIN && canPractise(row.item),
  )
  if (practise) return practiseNudge(practise.item, practise.days)

  const slipped = overdueCount(items, open)
  if (slipped > 0) return overdueNudge(slipped)

  const start = dated.find(
    (row) => row.days >= START_FROM && row.days <= START_UNTIL,
  )
  if (start) return startNudge(start.item, start.days)

  return null
}

/* ------------------------------------------------------------------ icons */

const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const

function KindIcon({ kind }: { kind: NudgeKind }) {
  if (kind === "overdue") {
    /* A clock, not a warning triangle. The difference is the whole tone. */
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" strokeWidth="1.7" {...STROKE}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7.5V12l3 1.8" />
      </svg>
    )
  }
  if (kind === "start") {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" strokeWidth="1.7" {...STROKE}>
        <path d="M12 7.5v12M12 7.5A4.5 4.5 0 0 0 7.5 4H3v12h4.5a4.5 4.5 0 0 1 4.5 3.5M12 7.5A4.5 4.5 0 0 1 16.5 4H21v12h-4.5a4.5 4.5 0 0 0-4.5 3.5" />
      </svg>
    )
  }
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" strokeWidth="1.7" {...STROKE}>
      <rect x="3" y="4.5" width="18" height="16.5" rx="2.5" />
      <path d="M8 2.5v4M16 2.5v4M3 10h18M9.5 15.5l1.8 1.8 3.4-3.4" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" strokeWidth="2" {...STROKE}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  )
}

function ExternalIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" strokeWidth="2" {...STROKE}>
      <path d="M14 4h6v6M20 4l-8.5 8.5M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
    </svg>
  )
}

/* ------------------------------------------------------------- the strip */

/* Module-level, so "not now" survives the component unmounting when the
   student changes page. A session means the browser tab, not the mount. */
const DISMISSED = new Set<string>()

export type StudyNudgeProps = {
  /** Open practice for a subject. Runs POST /api/practice on the far side. */
  onPractise: (target: { subject: string }) => void
  /** Escape hatch: the student can turn the whole thing off, not just hide it. */
  onOpenSettings: () => void
  /** Where "See them" goes. Defaults to the Due screen. */
  onSeeOverdue?: () => void
  className?: string
}

/**
 * At most one nudge, or nothing at all.
 *
 * @example
 * <StudyNudge
 *   onPractise={({ subject }) => go(`#/practise/${subject}`)}
 *   onOpenSettings={() => go("#/settings")}
 * />
 */
export function StudyNudge({
  onPractise,
  onOpenSettings,
  onSeeOverdue,
  className,
}: StudyNudgeProps) {
  const [loaded, setLoaded] = useState<{
    assessments: Assessment[]
    tasks: NudgeTask[]
  } | null>(null)
  const [dismissed, setDismissed] = useState<string[]>(() => [...DISMISSED])

  useEffect(() => {
    let live = true

    const load = async () => {
      /* A helper that shouts about its own failure is worse than one that
         stays quiet: this sits above real content, and "couldn't load nudges"
         is never the most useful thing on the screen. The pages that own this
         data report their own errors. */
      const [a, t] = await Promise.all([
        api
          .get<AssessmentsResponse>("/api/assessments")
          .catch((): AssessmentsResponse => ({})),
        api.get<TasksResponse>("/api/tasks").catch((): TasksResponse => ({})),
      ])
      if (!live) return
      setLoaded({ assessments: a.assessments ?? [], tasks: t.tasks ?? [] })
    }

    void load()

    /* A laptop that was shut on Thursday should not still be saying "in 2
       days" on Saturday. Coming back to the tab is the cheap, honest moment to
       re-check — no polling, no timer running through a lesson. */
    const onFocus = () => void load()
    window.addEventListener("focus", onFocus)
    return () => {
      live = false
      window.removeEventListener("focus", onFocus)
    }
  }, [])

  const nudge = useMemo(
    () => (loaded ? pickNudge(loaded.assessments, loaded.tasks) : null),
    [loaded],
  )

  /* Dismissed means dismissed: the runner-up does not slide into the empty
     slot. Replacing a banner the moment it is closed is how an app teaches
     you that the X does nothing. */
  if (!nudge || dismissed.includes(nudge.key)) return null

  const dismiss = () => {
    DISMISSED.add(nudge.key)
    setDismissed([...DISMISSED])
  }

  const act = () => {
    if (!nudge.action) return
    if (nudge.action.run === "practise") {
      onPractise({ subject: nudge.subject })
      return
    }
    if (onSeeOverdue) onSeeOverdue()
    else window.location.hash = "#/due"
  }

  return (
    <div
      role="status"
      className={cn(
        "brand-panel mb-[22px] flex flex-wrap items-start gap-x-3 gap-y-2.5",
        "rounded-[10px] px-4 py-3 shadow-[0_1px_2px_rgba(20,20,26,0.04)]",
        "transition-transform duration-[140ms] ease-out hover:-translate-y-px",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "mt-px shrink-0",
          nudge.kind === "overdue" ? "text-late" : "text-brand",
        )}
      >
        <KindIcon kind={nudge.kind} />
      </span>

      <div className="min-w-0 flex-1 basis-[240px]">
        <p className="text-[13.5px] leading-[1.45] break-words">
          {nudge.before}
          {nudge.figure ? (
            <span
              className={cn(
                "font-mono tabular-nums",
                nudge.kind === "overdue" && "text-late",
              )}
            >
              {nudge.figure}
            </span>
          ) : null}
          {nudge.after}
        </p>

        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11.5px] tabular-nums text-muted-foreground">
          {nudge.subject ? (
            <span
              aria-hidden="true"
              className="size-2 shrink-0 rounded-[2px]"
              style={{ background: `var(--subj-${nudge.hue % 8})` }}
            />
          ) : null}
          {nudge.sub ? <span className="break-words">{nudge.sub}</span> : null}
          {nudge.sub ? <span aria-hidden="true">·</span> : null}
          <button
            type="button"
            onClick={onOpenSettings}
            className="underline-offset-2 transition-colors hover:text-foreground hover:underline"
          >
            turn these off
          </button>
        </p>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {nudge.action ? (
          <button
            type="button"
            onClick={act}
            className="btn-brand inline-flex h-8 items-center rounded-md px-3 text-[12.5px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {nudge.action.label}
          </button>
        ) : nudge.url ? (
          <a
            href={nudge.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-card px-3 text-[12.5px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Open
            <ExternalIcon />
          </a>
        ) : null}

        <button
          type="button"
          onClick={dismiss}
          aria-label="Hide this for now"
          title="Hide this for now"
          className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  )
}

export default StudyNudge
