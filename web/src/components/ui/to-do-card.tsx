import { useEffect, useMemo, useState } from "react"
import { cn } from "@/lib/utils"

export interface TodoItem {
  id: string
  text: string
  done: boolean
  subject?: string
  due?: string | null
}

interface TodoCardProps {
  items: TodoItem[]
  onToggle?: (id: string) => void
  className?: string
  title?: string
}

/* The original had a yellow gradient header and a confetti burst on completion.
   Both are dropped deliberately: the brief was "professional, not kiddish", and
   celebration animation is the first thing that breaks that. The structure,
   props and interaction are unchanged. */

function dueLabel(due?: string | null) {
  if (!due) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const d = new Date(due + "T00:00:00")
  const days = Math.round((d.getTime() - today.getTime()) / 86400000)
  if (days < 0) return { text: `${-days}d overdue`, tone: "text-late" }
  if (days === 0) return { text: "today", tone: "text-warn" }
  if (days === 1) return { text: "tomorrow", tone: "text-warn" }
  if (days < 7) return { text: `${days}d`, tone: "text-muted-foreground" }
  return {
    text: d.toLocaleDateString(undefined, { day: "numeric", month: "short" }),
    tone: "text-muted-foreground",
  }
}

export function TodoCard({ items, onToggle, className, title = "Due" }: TodoCardProps) {
  const [now, setNow] = useState("")

  useEffect(() => {
    const tick = () =>
      setNow(
        new Date().toLocaleDateString(undefined, {
          weekday: "short",
          day: "numeric",
          month: "short",
        }),
      )
    tick()
    const id = setInterval(tick, 60000)
    return () => clearInterval(id)
  }, [])

  const open = useMemo(() => items.filter((i) => !i.done), [items])
  const done = useMemo(() => items.filter((i) => i.done), [items])
  const allDone = items.length > 0 && open.length === 0

  return (
    <div className={cn("rounded-lg border bg-card overflow-hidden", className)}>
      <div className="flex items-center justify-between px-4 py-2.5 border-b bg-muted/40">
        <div className="flex items-baseline gap-2.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
            {title}
          </span>
          <span className="text-[11px] text-muted-foreground tabular-nums">{now}</span>
        </div>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {open.length} open
        </span>
      </div>

      <div className="p-2">
        {allDone && (
          <p className="px-2 py-6 text-center text-[13px] text-muted-foreground">
            Nothing outstanding.
          </p>
        )}

        {!items.length && (
          <p className="px-2 py-6 text-center text-[13px] text-muted-foreground">
            Nothing due. Homework found in your lessons lands here.
          </p>
        )}

        <ul className="space-y-px">
          {[...open, ...done].map((item) => {
            const due = dueLabel(item.due)
            return (
              <li
                key={item.id}
                className="group flex items-start gap-2.5 px-2 py-1.5 rounded-md transition-colors hover:bg-muted/60"
              >
                <label className="relative inline-flex items-center justify-center w-5 h-5 mt-px shrink-0">
                  <input
                    type="checkbox"
                    checked={item.done}
                    onChange={() => onToggle?.(item.id)}
                    className="peer appearance-none absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  />
                  <span
                    className={cn(
                      "flex items-center justify-center w-4 h-4 rounded-[4px] border transition-colors",
                      item.done
                        ? "bg-primary border-primary"
                        : "border-input bg-transparent group-hover:border-foreground/40",
                    )}
                  >
                    <svg
                      className={cn(
                        "w-2.5 h-2.5 text-primary-foreground transition-opacity",
                        item.done ? "opacity-100" : "opacity-0",
                      )}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      viewBox="0 0 12 9"
                    >
                      <path d="M1 4.2L4 7L11 1" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                </label>

                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      "block text-[13px] leading-snug",
                      item.done ? "text-muted-foreground line-through" : "text-foreground",
                    )}
                  >
                    {item.text}
                  </span>
                  {item.subject && (
                    <span className="block text-[11px] text-muted-foreground mt-0.5">
                      {item.subject}
                    </span>
                  )}
                </span>

                {due && (
                  <span className={cn("text-[11px] tabular-nums shrink-0 mt-0.5", due.tone)}>
                    {due.text}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
