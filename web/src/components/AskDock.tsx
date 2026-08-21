import { useCallback, useEffect, useRef, useState } from "react"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"

/* Ask Minerva — a question answered from the student's own notes.

   This existed in the original build and was simply never ported when the UI
   moved to React, so the button "went on vacation". It is the feature that
   makes a term of recorded lessons useful on the night before a test: the
   answer comes from what the teacher actually said, and it says which lesson
   it came from rather than sounding confident about nothing.

   A docked panel rather than a page, because a question is something you have
   *while* reading a note — sending the student somewhere else to ask it is how
   a feature goes unused. */

type Source = { label: string; id: string; title: string }
type AskResponse = { answer: string; sources?: Source[]; web?: boolean }

type Props = {
  /** The note being read, so "this note" is searched first. */
  noteId?: string
  onOpenNote?: (id: string) => void
}

export default function AskDock({ noteId, onOpenNote }: Props) {
  const [open, setOpen] = useState(false)
  const [question, setQuestion] = useState("")
  const [answer, setAnswer] = useState("")
  const [sources, setSources] = useState<Source[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  // Ctrl/Cmd+K is where every tool of this kind puts "ask me something".
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setOpen((v) => !v)
      }
      if (e.key === "Escape") setOpen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const ask = useCallback(async () => {
    const q = question.trim()
    if (!q || busy) return
    setBusy(true)
    setError("")
    setAnswer("")
    setSources([])
    try {
      const out = await api.post<AskResponse>("/api/ask", {
        question: q,
        note_id: noteId || "",
      })
      setAnswer(out.answer || "")
      setSources(out.sources || [])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [question, busy, noteId])

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        title="Ask Minerva  (Ctrl+K)"
        className="btn-brand fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full px-4 py-3 text-[13px] font-semibold shadow-lg"
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3a9 9 0 1 0 4.5 16.8L21 21l-1.2-4.5A9 9 0 0 0 12 3Z" />
          <path d="M9.5 9.5a2.5 2.5 0 1 1 3.2 2.4c-.6.2-1 .8-1 1.4v.2" />
          <path d="M12 17h.01" />
        </svg>
        Ask
      </button>
    )
  }

  return (
    <div className="fixed bottom-5 right-5 z-50 w-[min(440px,calc(100vw-2.5rem))] overflow-hidden rounded-xl border bg-card shadow-2xl">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <span className="text-[13px] font-semibold">Ask Minerva</span>
        <span className="font-mono text-[10.5px] text-muted-foreground">
          answers from your notes
        </span>
        <button
          onClick={() => setOpen(false)}
          aria-label="Close"
          className="ml-auto rounded-md px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="max-h-[min(60vh,520px)] overflow-y-auto px-4 py-3">
        {!answer && !busy && !error ? (
          <p className="text-[12.5px] text-muted-foreground">
            Ask anything from your lessons — "what did we say about
            intertextuality?", "explain elasticity again". The answer comes from
            your own notes and names the lesson it used.
          </p>
        ) : null}

        {busy ? (
          <p className="text-[13px] text-muted-foreground">
            Reading your notes…
          </p>
        ) : null}

        {error ? <p className="text-[13px] text-late">{error}</p> : null}

        {answer ? (
          <div className="whitespace-pre-wrap text-[13.5px] leading-relaxed">
            {answer}
          </div>
        ) : null}

        {sources.length ? (
          <div className="mt-3 border-t pt-2.5">
            <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              From
            </div>
            <ul className="space-y-1">
              {sources.map((s, i) => (
                <li key={s.id || i}>
                  {s.id ? (
                    <button
                      onClick={() => {
                        setOpen(false)
                        onOpenNote
                          ? onOpenNote(s.id)
                          : (window.location.hash = "#/note/" + s.id)
                      }}
                      className="text-[12.5px] text-brand hover:underline"
                    >
                      {s.title || s.label}
                    </button>
                  ) : (
                    <span className="text-[12.5px] text-muted-foreground">
                      {s.title || s.label}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <div className="border-t p-2.5">
        <textarea
          ref={inputRef}
          rows={2}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              ask()
            }
          }}
          placeholder="Ask about anything you've recorded…"
          className="w-full resize-none rounded-md border bg-background px-2.5 py-2 text-[13px] outline-none focus:border-brand"
        />
        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={ask}
            disabled={busy || !question.trim()}
            className={cn("btn-brand rounded-lg px-3 py-1.5 text-[13px] font-semibold", "disabled:opacity-50")}
          >
            {busy ? "Thinking…" : "Ask"}
          </button>
          <span className="font-mono text-[10.5px] text-muted-foreground">
            Enter to send · Ctrl+K to open
          </span>
        </div>
      </div>
    </div>
  )
}
