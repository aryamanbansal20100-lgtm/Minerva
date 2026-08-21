/* ==========================================================================
   CalendarPage — the month, with everything on it.

   Three things already exist separately and never met: the timetable (which
   periods, which days), tasks with due dates, and ManageBac deadlines. A
   student does not think in three lists — they think "what is this week".

   So: a month grid, every day carrying its lessons and its deadlines, and a
   day panel underneath. No library — a month is arithmetic.

   This screen does not fetch when it is given state: /api/state already holds
   the profile, the tasks and the ManageBac feed, and re-fetching them on every
   navigation is what makes an app feel slow. It falls back to fetching once
   when it is mounted on its own, so it works as a standalone route too.
   ========================================================================== */

import { useCallback, useEffect, useMemo, useState } from "react"
import { apiGet } from "@/lib/api"
import { cn } from "@/lib/utils"
import { StatRow, type Stat } from "@/components/StatRow"

/* -------------------------------------------------------------- the shapes */

type Period = {
  day: string
  start: string
  end: string
  subject: string
  room: string
  teacher: string
}

type Task = {
  id: string
  title: string
  subject: string
  due: string | null
  done: 0 | 1 | boolean
  source: string
  source_ref: string
  url: string
}

type FeedItem = {
  uid: string
  kind: string
  title: string
  subject: string
  due: string | null
  starts: string | null
  url: string
}

/** The slice of GET /api/state this screen reads. */
export type CalendarState = {
  profile?: { timetable?: Period[] }
  tasks?: Task[]
  managebac?: { streams?: Record<string, FeedItem[]> }
}

export type CalendarPageProps = {
  /** Pass the app-wide /api/state payload. Omit it and the page fetches once. */
  state?: CalendarState
}

type EntryKind = "lesson" | "due" | "done" | "deadline"

type Entry = {
  kind: EntryKind
  /** Sort key. Lessons carry their start time; deadlines carry "". */
  at: string
  title: string
  detail: string
  subject: string
  url?: string
}

/* ------------------------------------------------------------------- dates */

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const

const KIND_LABELS: Record<string, string> = {
  assignment: "Assignment",
  exam: "Exam",
  event: "Event",
  admin: "Admin",
}

const pad = (n: number) => String(n).padStart(2, "0")

/** Local calendar date as YYYY-MM-DD. Never toISOString — that shifts a day. */
const isoOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/* ------------------------------------------------------------ subject colour */

const SUBJECT_HUES = new Map<string, string>()

/** The same stable per-subject hue the timetable uses, so a lesson looks the
    same colour on both screens. */
function subjectHue(subject: string): string {
  if (!subject) return "var(--color-muted-foreground)"
  const known = SUBJECT_HUES.get(subject)
  if (known) return known
  let h = 0
  for (let i = 0; i < subject.length; i++) h = (h * 31 + subject.charCodeAt(i)) % 360
  const colour = `hsl(${h} 52% 45%)`
  SUBJECT_HUES.set(subject, colour)
  return colour
}

/* --------------------------------------------------------------- gathering */

/** Everything happening on a given date, from all three sources. */
function entriesFor(
  dateIso: string,
  periods: Period[],
  tasks: Task[],
  feed: FeedItem[],
): Entry[] {
  const out: Entry[] = []
  const day = new Date(`${dateIso}T12:00:00`)
  const weekday = DAY_NAMES[(day.getDay() + 6) % 7]

  /* Lessons from the timetable — the same day name every week. */
  for (const period of periods) {
    if (String(period.day || "").slice(0, 3).toLowerCase() !== weekday.toLowerCase()) {
      continue
    }
    out.push({
      kind: "lesson",
      at: period.start || "",
      title: period.subject || "Lesson",
      detail:
        [period.start, period.end].filter(Boolean).join("–") +
        (period.room ? ` · ${period.room}` : ""),
      subject: period.subject || "",
    })
  }

  /* Anything due that day. */
  for (const task of tasks) {
    if ((task.due || "").slice(0, 10) !== dateIso) continue
    out.push({
      kind: task.done ? "done" : "due",
      at: "",
      title: task.title,
      detail: task.subject || "",
      subject: task.subject || "",
      url: task.url || undefined,
    })
  }

  /* ManageBac deadlines that never became a task. */
  for (const item of feed) {
    const when = item.due || item.starts || ""
    if (when.slice(0, 10) !== dateIso) continue
    out.push({
      kind: "deadline",
      at: "",
      title: item.title,
      detail: [item.subject, KIND_LABELS[item.kind] || item.kind].filter(Boolean).join(" · "),
      subject: item.subject || "",
      url: item.url || undefined,
    })
  }

  /* Lessons order naturally by their start time; undated deadlines, whose
     sort key is "", sink to the top where they are seen first. */
  out.sort((a, b) => a.at.localeCompare(b.at))
  return out
}

const isPending = (entry: Entry) => entry.kind === "due" || entry.kind === "deadline"

/* ------------------------------------------------------------------ buttons */

const BTN_STEP =
  "inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded-md border " +
  "px-2 text-[13px] font-medium text-muted-foreground transition-colors " +
  "hover:bg-muted hover:text-foreground"

/* --------------------------------------------------------------- the screen */

export function CalendarPage({ state }: CalendarPageProps) {
  const [fetched, setFetched] = useState<CalendarState | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    if (state) return
    let alive = true
    apiGet<CalendarState>("/api/state")
      .then((payload) => {
        if (alive) setFetched(payload)
      })
      .catch((err: unknown) => {
        if (alive) setError((err as Error).message)
      })
    return () => {
      alive = false
    }
  }, [state])

  const data = state ?? fetched

  const today = useMemo(() => isoOf(new Date()), [])
  const [year, setYear] = useState(() => new Date().getFullYear())
  const [month, setMonth] = useState(() => new Date().getMonth())
  const [picked, setPicked] = useState(today)

  const step = useCallback(
    (by: number) => {
      const moved = new Date(year, month + by, 1)
      setYear(moved.getFullYear())
      setMonth(moved.getMonth())
    },
    [year, month],
  )

  const goToday = useCallback(() => {
    const now = new Date()
    setYear(now.getFullYear())
    setMonth(now.getMonth())
    setPicked(isoOf(now))
  }, [])

  const periods = useMemo(() => data?.profile?.timetable ?? [], [data])
  const tasks = useMemo(() => data?.tasks ?? [], [data])

  /* A ManageBac item that already became a task would otherwise show twice —
     once as the task, once as the feed row it was built from. */
  const feed = useMemo(() => {
    const streams = data?.managebac?.streams
    if (!streams) return []
    const claimed = new Set(
      tasks.filter((t) => t.source === "managebac" && t.source_ref).map((t) => t.source_ref),
    )
    const seen = new Set<string>()
    const rows: FeedItem[] = []
    for (const stream of Object.values(streams)) {
      for (const item of stream ?? []) {
        if (!item || claimed.has(item.uid) || seen.has(item.uid)) continue
        seen.add(item.uid)
        rows.push(item)
      }
    }
    return rows
  }, [data, tasks])

  /* The Monday-first grid: leading blanks before the 1st, trailing blanks to
     fill the last week. */
  const cells = useMemo(() => {
    const lead = (new Date(year, month, 1).getDay() + 6) % 7
    const length = new Date(year, month + 1, 0).getDate()
    const out: (string | null)[] = []
    for (let i = 0; i < lead; i++) out.push(null)
    for (let n = 1; n <= length; n++) out.push(isoOf(new Date(year, month, n)))
    while (out.length % 7) out.push(null)
    return out
  }, [year, month])

  /* Built once per month rather than per cell render — dayEntries walks every
     period and every task, and there are up to 42 cells. */
  const byDate = useMemo(() => {
    const map = new Map<string, Entry[]>()
    for (const date of cells) {
      if (date) map.set(date, entriesFor(date, periods, tasks, feed))
    }
    if (!map.has(picked)) map.set(picked, entriesFor(picked, periods, tasks, feed))
    return map
  }, [cells, periods, tasks, feed, picked])

  const stats: Stat[] = useMemo(() => {
    const todayEntries = entriesFor(today, periods, tasks, feed)
    const todayLessons = todayEntries.filter((e) => e.kind === "lesson").length
    const todayDue = todayEntries.filter(isPending).length

    let monthDue = 0
    let monthLessons = 0
    for (const date of cells) {
      if (!date) continue
      for (const entry of byDate.get(date) ?? []) {
        if (entry.kind === "lesson") monthLessons++
        else if (isPending(entry)) monthDue++
      }
    }

    const overdue =
      tasks.filter((t) => !t.done && t.due && t.due.slice(0, 10) < today).length +
      feed.filter((f) => {
        const when = (f.due || f.starts || "").slice(0, 10)
        return !!when && when < today
      }).length

    return [
      {
        label: "Today",
        value: todayEntries.length,
        sub: `${todayLessons} lessons · ${todayDue} due`,
      },
      { label: "Overdue", value: overdue, sub: overdue ? "not handed in" : "nothing late", alert: overdue > 0 },
      { label: MONTHS[month].slice(0, 3), value: monthDue, sub: "deadlines this month" },
      { label: "Lessons", value: monthLessons, sub: "timetabled this month" },
    ]
  }, [today, periods, tasks, feed, cells, byDate, month])

  if (error) {
    return (
      <section className="mx-auto w-full max-w-6xl px-6 py-6">
        <p className="text-[13px] text-muted-foreground">{error}</p>
      </section>
    )
  }

  if (!data) {
    return (
      <section className="mx-auto w-full max-w-6xl px-6 py-6">
        <p className="text-[13px] text-muted-foreground">Loading your month…</p>
      </section>
    )
  }

  const pickedEntries = byDate.get(picked) ?? []
  const pickedLabel = new Date(`${picked}T12:00:00`).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  })

  return (
    <section className="mx-auto w-full max-w-6xl px-6 py-6">
      {/* ------------------------------------------------------------ header */}
      <header className="mb-5 flex flex-wrap items-start gap-2">
        <div className="min-w-0 grow">
          <h2 className="text-[19px] font-semibold tracking-tight">
            {MONTHS[month]} <span className="tabular-nums">{year}</span>
          </h2>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            lessons, homework and deadlines together
          </p>
        </div>
        <button
          type="button"
          className={BTN_STEP}
          aria-label="Previous month"
          onClick={() => step(-1)}
        >
          ‹
        </button>
        <button type="button" className={BTN_STEP} onClick={goToday}>
          Today
        </button>
        <button
          type="button"
          className={BTN_STEP}
          aria-label="Next month"
          onClick={() => step(1)}
        >
          ›
        </button>
      </header>

      <StatRow stats={stats} />

      {/* -------------------------------------------------------- month grid */}
      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border bg-border">
        {DAY_NAMES.map((name) => (
          <div
            key={name}
            className="bg-muted px-2.5 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground"
          >
            {name}
          </div>
        ))}

        {cells.map((date, index) => {
          if (!date) {
            return (
              <div
                key={`blank-${index}`}
                aria-hidden="true"
                className="min-h-[96px] bg-muted/40 max-[720px]:min-h-[62px]"
              />
            )
          }

          const entries = byDate.get(date) ?? []
          const due = entries.filter(isPending)
          const lessons = entries.filter((e) => e.kind === "lesson")
          const overdue = date < today && due.length > 0
          const isToday = date === today
          const isPicked = date === picked

          return (
            <button
              key={date}
              type="button"
              onClick={() => setPicked(date)}
              aria-current={isToday ? "date" : undefined}
              aria-pressed={isPicked}
              aria-label={`${date}, ${due.length} due, ${lessons.length} lessons`}
              className={cn(
                "relative flex min-h-[96px] flex-col items-start gap-[3px] bg-card p-2",
                "text-left transition-colors hover:bg-muted/60",
                "max-[720px]:min-h-[62px] max-[720px]:p-1.5",
                /* An inset ring, never a fill: a filled cell fights both the
                   today marker and the deadline colours inside it. */
                isPicked && "shadow-[inset_0_0_0_1.5px_var(--color-foreground)]",
              )}
            >
              <span className="flex w-full items-start gap-1.5">
                <span
                  className={cn(
                    "text-[12px] font-semibold tabular-nums",
                    isToday
                      ? "-mt-px -ml-px inline-flex h-[22px] w-[22px] items-center justify-center rounded-full bg-primary text-primary-foreground"
                      : overdue
                        ? "text-late"
                        : "text-foreground/80",
                  )}
                >
                  {Number(date.slice(8, 10))}
                </span>
                <span className="ml-auto flex items-center gap-1.5 pt-0.5">
                  {lessons.length ? (
                    <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                      {lessons.length}
                    </span>
                  ) : null}
                  {due.length ? (
                    <span
                      aria-hidden="true"
                      className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        overdue ? "bg-late" : "bg-warn",
                      )}
                    />
                  ) : null}
                </span>
              </span>

              {due.slice(0, 2).map((entry, n) => (
                <span
                  key={`${date}-mini-${n}`}
                  className={cn(
                    "block w-full truncate rounded-[3px] border-l-2 bg-muted/70 px-1.5 py-px",
                    "text-[11px] leading-[1.35] text-foreground/85 max-[720px]:hidden",
                    overdue ? "border-l-late" : "border-l-warn",
                  )}
                >
                  {entry.title.slice(0, 22)}
                </span>
              ))}
              {due.length > 2 ? (
                <span className="block pl-[7px] text-[11px] tabular-nums text-muted-foreground max-[720px]:hidden">
                  +{due.length - 2} more
                </span>
              ) : null}
            </button>
          )
        })}
      </div>

      {/* --------------------------------------------------------- day panel */}
      <div className="mt-6">
        <div className="flex items-center gap-2">
          <h3 className="text-[13px] font-semibold">{pickedLabel}</h3>
          <span className="rounded-full border px-1.5 py-px font-mono text-[11px] tabular-nums text-muted-foreground">
            {pickedEntries.length}
          </span>
        </div>

        {pickedEntries.length ? (
          <ul className="mt-3 space-y-1.5">
            {pickedEntries.map((entry, index) => {
              const past = picked < today
              const hot = isPending(entry) && past
              const bar =
                entry.kind === "lesson"
                  ? subjectHue(entry.subject)
                  : entry.kind === "done"
                    ? "var(--color-border)"
                    : hot
                      ? "var(--color-late)"
                      : "var(--color-warn)"
              const label =
                entry.kind === "lesson"
                  ? "Lesson"
                  : entry.kind === "done"
                    ? "Done"
                    : entry.kind === "deadline"
                      ? "Deadline"
                      : "Due"

              return (
                <li
                  key={`${entry.kind}-${entry.title}-${index}`}
                  className={cn(
                    "relative overflow-hidden rounded-lg border bg-card py-2.5 pr-3.5 pl-4",
                    "transition-transform duration-[140ms] ease-out hover:-translate-y-px",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className="absolute inset-y-0 left-0 w-[2px]"
                    style={{ background: bar }}
                  />
                  <div className="flex items-start gap-2.5">
                    {entry.subject ? (
                      <span
                        aria-hidden="true"
                        className="mt-[5px] h-2.5 w-2.5 flex-none rounded-[3px]"
                        style={{ background: subjectHue(entry.subject) }}
                      />
                    ) : null}
                    <div className="min-w-0 flex-1">
                      {entry.url ? (
                        <a
                          href={entry.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={cn(
                            "block truncate text-[13.5px] font-medium underline-offset-2 hover:underline",
                            entry.kind === "done" && "line-through opacity-60",
                          )}
                        >
                          {entry.title} <span aria-hidden="true">↗</span>
                        </a>
                      ) : (
                        <span
                          className={cn(
                            "block truncate text-[13.5px] font-medium",
                            entry.kind === "done" && "line-through opacity-60",
                          )}
                        >
                          {entry.title}
                        </span>
                      )}
                      <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted-foreground">
                        <span>{label}</span>
                        {entry.detail ? <span>· {entry.detail}</span> : null}
                        {entry.kind === "deadline" ? (
                          <span className="rounded-full border px-1.5 py-px text-[10.5px]">
                            ManageBac
                          </span>
                        ) : null}
                        {hot ? (
                          <span className="rounded-full border border-late/40 px-1.5 py-px text-[10.5px] text-late">
                            overdue
                          </span>
                        ) : null}
                      </span>
                    </div>
                    {entry.at ? (
                      <span className="mt-px font-mono text-[11.5px] tabular-nums text-muted-foreground">
                        {entry.at}
                      </span>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="mt-3.5 text-[13px] text-muted-foreground">Nothing on this day.</p>
        )}
      </div>
    </section>
  )
}

export default CalendarPage
