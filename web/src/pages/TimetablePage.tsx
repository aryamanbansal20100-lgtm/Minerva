/* ==========================================================================
   TimetablePage — your week, and the reminder that you have a lesson in 5.

   This screen is the design reference for the rest of the app: a stat row of
   mono numbers on top, bordered cards with a quiet header bar underneath,
   coloured dots keying subjects, times in monospace so they form a column.

   The server owns the definition of "next period" — the page never re-derives
   it. It polls /api/timetable every 30 seconds so NOW and NEXT stay honest,
   and raises the reminder, because notifications belong to the browser. Every
   reminder carries a key of date|day|time|subject, so polling twice a minute
   can never fire the same one twice.
   ========================================================================== */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { apiGet, apiPost } from "@/lib/api"
import { cn } from "@/lib/utils"
import { StatRow, type Stat } from "@/components/StatRow"

/* -------------------------------------------------------------- the shapes */

export type Period = {
  day: string
  start: string
  end: string
  subject: string
  room: string
  teacher: string
}

type Remind = Period & { in_minutes: number; key: string }

type Upcoming = {
  day: string
  now: string
  current: Period | null
  next: Period | null
  remaining: number
  remind: Remind | null
  today: Period[]
}

type TimetableResponse = {
  periods: Period[]
  by_day: Record<string, Period[]>
  days: string[]
  upcoming: Upcoming
  vision: { vision: boolean; reason: string }
}

/* /api/timetable/read answers 200 even when it failed to read the photo — the
   failure is in the body, not the status. Branch on `ok`, never on the code. */
type ReadResponse =
  | { ok: true; periods: Period[]; notes: string }
  | { ok: false; error: string }

type Notice = { text: string; bad: boolean }

/* ------------------------------------------------------------ subject colour */

const SUBJECT_HUES = new Map<string, string>()

/**
 * A stable colour per subject.
 *
 * Urgency owns red and amber; this is a different job — making the week
 * scannable — so it uses hue, not alarm.
 */
export function subjectHue(subject: string): string {
  if (!subject) return "var(--color-muted-foreground)"
  const known = SUBJECT_HUES.get(subject)
  if (known) return known
  let h = 0
  for (let i = 0; i < subject.length; i++) h = (h * 31 + subject.charCodeAt(i)) % 360
  const colour = `hsl(${h} 52% 45%)`
  SUBJECT_HUES.set(subject, colour)
  return colour
}

/* A reminder fires once per browser session, whatever re-renders happen. */
const firedReminders = new Set<string>()

const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const POLL_MS = 30_000

/* ------------------------------------------------------------------ buttons */

const BTN_PRIMARY =
  "inline-flex shrink-0 items-center rounded-md bg-primary px-3 py-1.5 text-[13px] " +
  "font-medium text-primary-foreground transition-opacity hover:opacity-90 " +
  "disabled:pointer-events-none disabled:opacity-50"

const BTN_GHOST =
  "inline-flex shrink-0 items-center rounded-md border px-3 py-1.5 text-[13px] " +
  "font-medium text-muted-foreground transition-colors hover:bg-muted " +
  "hover:text-foreground disabled:pointer-events-none disabled:opacity-50"

/* --------------------------------------------------------------- the screen */

export function TimetablePage() {
  const [data, setData] = useState<TimetableResponse | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [reading, setReading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try {
      setData(await apiGet<TimetableResponse>("/api/timetable"))
      setError("")
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /* setInterval, not requestAnimationFrame: this must keep ticking while the
     tab is in the background, which is exactly when a reminder matters. */
  useEffect(() => {
    const timer = window.setInterval(() => void load(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [load])

  /* The server says when a reminder is due and hands over a key. All this does
     is refuse to say the same thing twice. */
  useEffect(() => {
    const remind = data?.upcoming?.remind
    if (!remind || firedReminders.has(remind.key)) return
    firedReminders.add(remind.key)
    const line =
      `${remind.subject} in ${remind.in_minutes} min` +
      (remind.room ? ` · ${remind.room}` : "")
    setNotice({ text: line, bad: false })
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("Next period", { body: line, tag: remind.key })
    }
  }, [data])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 7000)
    return () => window.clearTimeout(timer)
  }, [notice])

  const sendImage = useCallback(
    async (dataUrl: string) => {
      setReading(true)
      try {
        const out = await apiPost<ReadResponse>("/api/timetable/read", {
          image: dataUrl,
        })
        if (!out.ok) {
          setNotice({ text: out.error, bad: true })
          return
        }
        await apiPost("/api/timetable/save", { periods: out.periods })
        setNotice({ text: `Read ${out.periods.length} periods.`, bad: false })
        await load()
      } catch (err) {
        setNotice({ text: (err as Error).message, bad: true })
      } finally {
        setReading(false)
      }
    },
    [load],
  )

  const readFile = useCallback(
    (file: File | undefined) => {
      if (!file) return
      if (!file.type.startsWith("image/")) {
        setNotice({ text: "That was not an image.", bad: true })
        return
      }
      if (file.size > MAX_IMAGE_BYTES) {
        setNotice({
          text: "That image is over 8 MB — take a smaller screenshot.",
          bad: true,
        })
        return
      }
      const reader = new FileReader()
      reader.onerror = () => setNotice({ text: "Could not read that file.", bad: true })
      reader.onload = () => void sendImage(String(reader.result))
      reader.readAsDataURL(file)
    },
    [sendImage],
  )

  /* Ctrl+V anywhere on this screen. A screenshot goes straight from the
     clipboard into the reader without ever touching a file picker. */
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const items = event.clipboardData?.items
      if (!items) return
      for (const item of Array.from(items)) {
        if (item.kind !== "file" || !item.type.startsWith("image/")) continue
        const file = item.getAsFile()
        if (!file) continue
        event.preventDefault()
        readFile(file)
        return
      }
    }
    window.addEventListener("paste", onPaste)
    return () => window.removeEventListener("paste", onPaste)
  }, [readFile])

  const askNotify = useCallback(async () => {
    if (!("Notification" in window)) {
      setNotice({ text: "This browser has no notifications.", bad: true })
      return
    }
    const permission = await Notification.requestPermission()
    setNotice(
      permission === "granted"
        ? { text: "Reminders on — 5 minutes before each period.", bad: false }
        : {
            text: "Reminders blocked. Allow notifications from the address bar.",
            bad: true,
          },
    )
  }, [])

  const clearAll = useCallback(async () => {
    if (!window.confirm("Clear the whole timetable?")) return
    try {
      await apiPost("/api/timetable/save", { periods: [] })
      setNotice({ text: "Timetable cleared.", bad: false })
      await load()
    } catch (err) {
      setNotice({ text: (err as Error).message, bad: true })
    }
  }, [load])

  const days = useMemo(
    () => (data?.days ?? []).filter((day) => (data?.by_day?.[day]?.length ?? 0) > 0),
    [data],
  )

  if (error) {
    return (
      <section className="mx-auto w-full max-w-6xl px-6 py-6">
        <p className="text-[13px] text-muted-foreground">{error}</p>
      </section>
    )
  }

  if (loading || !data) {
    return (
      <section className="mx-auto w-full max-w-6xl px-6 py-6">
        <p className="text-[13px] text-muted-foreground">Loading your week…</p>
      </section>
    )
  }

  const up = data.upcoming
  const current = up.current
  const next = up.next

  const stats: Stat[] = [
    {
      label: "Now",
      value: current ? current.subject.slice(0, 11) : "—",
      sub: current
        ? current.start + (current.end ? `–${current.end}` : "")
        : "no period running",
    },
    {
      label: "Next",
      value: next ? next.start : "—",
      sub: next ? next.subject : "nothing left today",
    },
    { label: "Left today", value: up.remaining ?? 0, sub: "periods" },
    { label: "This week", value: data.periods.length, sub: "periods total" },
  ]

  return (
    <section className="mx-auto w-full max-w-6xl px-6 py-6">
      {/* ------------------------------------------------------------ header */}
      <header className="mb-5 flex flex-wrap items-start gap-3">
        <div className="min-w-0 grow">
          <h2 className="text-[19px] font-semibold tracking-tight">Timetable</h2>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            {data.periods.length
              ? `${data.periods.length} periods · reminders 5 minutes before each one`
              : "not set up yet"}
          </p>
        </div>
        <button type="button" className={BTN_PRIMARY} onClick={() => void askNotify()}>
          Enable reminders
        </button>
        {data.periods.length ? (
          <button type="button" className={BTN_GHOST} onClick={() => void clearAll()}>
            Clear
          </button>
        ) : null}
      </header>

      {notice ? (
        <p
          role="status"
          className={cn(
            "mb-4 text-[12.5px]",
            notice.bad ? "text-late" : "text-muted-foreground",
          )}
        >
          {notice.text}
        </p>
      ) : null}

      <StatRow stats={stats} />

      {/* ------------------------------------------------------------ ingest */}
      <div className="mt-[22px]">
        <div
          role="button"
          tabIndex={0}
          aria-label="Upload or paste a photo of your timetable"
          aria-busy={reading}
          onClick={() => fileRef.current?.click()}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return
            event.preventDefault()
            fileRef.current?.click()
          }}
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            const image = Array.from(event.dataTransfer.files).find((file) =>
              file.type.startsWith("image/"),
            )
            if (image) readFile(image)
            else setNotice({ text: "That was not an image.", bad: true })
          }}
          className={cn(
            "cursor-pointer rounded-md border-2 border-dashed px-5 py-[34px] text-center",
            "text-[13px] text-muted-foreground transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            dragging
              ? "border-foreground/40 bg-muted/60"
              : "border-input hover:border-foreground/30 hover:bg-muted/40",
          )}
        >
          {reading ? (
            <>
              <b className="mb-1 block text-[15px] font-semibold text-foreground">
                Reading your timetable…
              </b>
              A few seconds.
            </>
          ) : (
            <>
              <b className="mb-1 block text-[15px] font-semibold text-foreground">
                Drop a photo of your timetable, or paste it with Ctrl+V
              </b>
              A screenshot or a straight-on photo both work. I read it and build your
              week.
            </>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="sr-only"
          onChange={(event) => {
            readFile(event.target.files?.[0])
            event.target.value = ""
          }}
        />
        <p className="mt-2 text-[12.5px] text-muted-foreground">
          {data.vision.vision ? "Image reading is on." : data.vision.reason}
        </p>
      </div>

      {/* ------------------------------------------------------- day columns */}
      {days.length ? (
        <div className="mt-[18px] grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]">
          {days.map((day, index) => {
            const isToday = day === up.day
            const periods = data.by_day[day] ?? []
            return (
              <div
                key={day}
                style={{ animationDelay: `${Math.min(index, 4) * 0.04}s` }}
                className={cn(
                  "minerva-rise overflow-hidden rounded-lg border bg-card",
                  "shadow-[0_1px_2px_rgba(20,20,26,0.04)]",
                  "transition-[transform,box-shadow] duration-[140ms] ease-out",
                  "hover:-translate-y-0.5",
                  "hover:shadow-[0_2px_4px_rgba(28,27,25,0.06),0_14px_34px_rgba(28,27,25,0.10)]",
                  isToday && "border-foreground/35",
                )}
              >
                <header
                  className={cn(
                    "flex items-center gap-2 border-b px-[13px] py-2.5",
                    "text-[12px] font-bold uppercase tracking-[0.06em]",
                    isToday ? "bg-muted text-foreground" : "text-muted-foreground",
                  )}
                >
                  {day}
                  {isToday ? " · today" : ""}
                </header>

                {periods.map((period, row) => {
                  const live = !!current && isToday && current.start === period.start
                  return (
                    <div
                      key={`${period.start}-${period.subject}-${row}`}
                      className={cn(
                        "flex items-start gap-2.5 py-[9px] pr-[13px]",
                        row > 0 && "border-t",
                        live
                          ? "border-l-2 border-l-foreground bg-muted/60 pl-[11px]"
                          : "pl-[13px]",
                      )}
                    >
                      <span className="mt-px min-w-[42px] font-mono text-[11.5px] tabular-nums text-muted-foreground">
                        {period.start}
                      </span>
                      <span
                        aria-hidden="true"
                        className="mt-[5px] h-2.5 w-2.5 flex-none rounded-[3px]"
                        style={{ background: subjectHue(period.subject) }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13.5px] font-medium">
                          {period.subject}
                        </span>
                        {period.room || period.teacher ? (
                          <span className="block truncate text-[11.5px] text-muted-foreground">
                            {[period.room, period.teacher].filter(Boolean).join(" · ")}
                          </span>
                        ) : null}
                      </span>
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      ) : (
        <p className="mt-5 text-[13px] text-muted-foreground">
          Nothing yet. Drop a photo above and I will build it.
        </p>
      )}
    </section>
  )
}

export default TimetablePage
