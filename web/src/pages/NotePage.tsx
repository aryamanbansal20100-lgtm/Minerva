import { useCallback, useEffect, useRef, useState } from "react"
import { api } from "@/lib/api"
import { BlockRenderer, type Block } from "@/components/note/BlockRenderer"
import Recorder from "@/components/note/Recorder"
import ShareDialog from "@/components/ShareDialog"

/* The note editor.

   Deliberately not the recorder — live capture is its own component and its own
   risk, and this page has to work without it. What it does cover is the whole
   text path a student uses every day: write or paste, pull a file in, press
   "Write it up", and read the result. */

type Note = {
  id: string
  title?: string
  subject?: string
  topic?: string
  body?: string
  blocks?: Block[]
}

type Props = {
  id: string
  onLeave?: () => void
  refresh?: () => void | Promise<void>
}

export default function NotePage({ id, onLeave, refresh }: Props) {
  const [note, setNote] = useState<Note | null>(null)
  const [body, setBody] = useState("")
  const [saveState, setSaveState] = useState<"saved" | "saving" | "unsaved">("saved")
  const [writing, setWriting] = useState(false)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState("")
  const [live, setLive] = useState("")          // the transcript while recording
  const [recording, setRecording] = useState(false)
  const [showShare, setShowShare] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const saveTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    let live = true
    ;(async () => {
      try {
        const n = await api.get<Note>("/api/note?id=" + encodeURIComponent(id))
        if (!live) return
        setNote(n)
        setBody(n.body || "")
      } catch (e) {
        if (live) setError((e as Error).message)
      }
    })()
    return () => {
      live = false
    }
  }, [id])

  const save = useCallback(
    async (patch: Partial<Note>) => {
      if (!note) return
      setSaveState("saving")
      try {
        await api.post("/api/note/save", { id: note.id, ...patch })
        setSaveState("saved")
      } catch (e) {
        setSaveState("unsaved")
        setError((e as Error).message)
      }
    },
    [note],
  )

  const onBody = (value: string) => {
    setBody(value)
    setSaveState("unsaved")
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => save({ body: value }), 900)
  }

  const field = (key: "title" | "subject" | "topic", value: string) => {
    setNote((n) => (n ? { ...n, [key]: value } : n))
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => save({ [key]: value }), 700)
  }

  const writeItUp = async () => {
    if (!note) return
    setWriting(true)
    setError("")
    try {
      await save({ body })
      const out = await api.post<{ note: Note }>("/api/note/tidy", { id: note.id })
      setNote(out.note)
      // The raw text is now a proper note below — clear the box so it is not
      // sitting there as a duplicate wall of text. The note keeps the source in
      // its transcript, so nothing is lost.
      setBody("")
      await save({ body: "" })
      await refresh?.()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setWriting(false)
    }
  }

  const addFiles = async (files: FileList | null) => {
    if (!files || !files.length || !note) return
    setAdding(true)
    setError("")
    let added = ""
    for (const f of Array.from(files)) {
      try {
        const data: string = await new Promise((ok, no) => {
          const fr = new FileReader()
          fr.onload = () => ok(String(fr.result))
          fr.onerror = () => no(new Error("could not read that file"))
          fr.readAsDataURL(f)
        })
        const out = await api.post<{ readable?: boolean; text?: string; how?: string }>(
          "/api/document/upload",
          { subject: note.subject || "", name: f.name, data },
        )
        if (out.readable && out.text) {
          added += "\n\n--- from " + f.name + " (" + (out.how || "file") + ") ---\n" + out.text
        } else {
          setError(f.name + ": " + (out.how || "nothing readable in it"))
        }
      } catch (e) {
        setError(f.name + ": " + (e as Error).message)
      }
    }
    if (added) {
      const next = body + added
      setBody(next)
      await save({ body: next })
    }
    setAdding(false)
  }

  const del = async () => {
    if (!note || !confirm("Delete this note?")) return
    try {
      await api.post("/api/note/delete", { id: note.id })
      await refresh?.()
      onLeave?.()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  if (error && !note) {
    return <div className="p-8 text-sm text-muted-foreground">{error}</div>
  }
  if (!note) {
    return <div className="p-8 text-sm text-muted-foreground">Loading…</div>
  }

  return (
    <div>
      <div className="sticky top-0 z-20 flex items-start gap-3 border-b bg-background/85 px-6 py-4 backdrop-blur">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[21px] font-semibold tracking-tight">
            {note.title || "Untitled"}
          </h1>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            {note.subject || "No subject"} ·{" "}
            <span
              className={
                saveState === "saved"
                  ? "text-ok"
                  : saveState === "saving"
                    ? "text-muted-foreground"
                    : "text-warn"
              }
            >
              {saveState}
            </span>
          </p>
        </div>
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => addFiles(e.target.files)} />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={adding}
          className="rounded-md border px-2.5 py-1.5 text-[13px] text-muted-foreground hover:bg-muted disabled:opacity-50"
        >
          {adding ? "Reading…" : "Add file"}
        </button>
        <button
          onClick={writeItUp}
          disabled={writing}
          className="btn-brand rounded-lg px-3 py-1.5 text-[13px] font-semibold disabled:opacity-60"
        >
          {writing ? "Writing…" : "Write it up"}
        </button>
        <button
          onClick={() => setShowShare(true)}
          className="rounded-md border px-2.5 py-1.5 text-[13px] text-muted-foreground hover:bg-muted"
        >
          Share
        </button>
        <button
          onClick={del}
          className="rounded-md border px-2.5 py-1.5 text-[13px] text-muted-foreground hover:bg-muted"
        >
          Delete
        </button>
      </div>

      <div className="mx-auto max-w-3xl px-6 py-6">
        <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <input
            className="rounded-md border bg-card px-2.5 py-1.5 text-[13.5px]"
            placeholder="Title"
            value={note.title || ""}
            onChange={(e) => field("title", e.target.value)}
          />
          <input
            className="rounded-md border bg-card px-2.5 py-1.5 text-[13.5px]"
            placeholder="Subject"
            value={note.subject || ""}
            onChange={(e) => field("subject", e.target.value)}
          />
          <input
            className="rounded-md border bg-card px-2.5 py-1.5 text-[13.5px]"
            placeholder="Topic"
            value={note.topic || ""}
            onChange={(e) => field("topic", e.target.value)}
          />
        </div>

        {error && <p className="mb-3 text-[12.5px] text-warn">{error}</p>}

        {/* The recorder sits up top: it is the main way in. */}
        <div className="mb-4">
          <Recorder
            noteId={note.id}
            onError={(msg) => setError(msg)}
            onTranscript={(text, isLive) => {
              setLive(text)
              setRecording(isLive)
            }}
            onFinished={(out) => {
              const n = out.note as Note | undefined
              if (n) setNote(n)
              setBody("")
              setLive("")
              setRecording(false)
              refresh?.()
            }}
          />
        </div>

        {/* While recording, the live transcript fills the WHOLE area — big,
            readable, growing — instead of a tiny caption line. */}
        {recording ? (
          <div className="rounded-xl border border-brand/30 bg-brand-soft/40 p-5">
            <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-brand">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-late" />
              Live transcript
            </div>
            <p className="min-h-[240px] whitespace-pre-wrap font-serif text-[17px] leading-relaxed text-foreground">
              {live || (
                <span className="text-muted-foreground">
                  Listening… the first words appear in a few seconds. Keep the
                  laptop facing the teacher and just sit in class.
                </span>
              )}
            </p>
          </div>
        ) : (
          <textarea
            className="min-h-[200px] w-full resize-y rounded-xl border bg-card px-4 py-3 font-serif text-[16px] leading-relaxed"
            placeholder="Type or paste here — a transcript, rough notes, anything — then press Write it up. Or press Record above and just talk."
            value={body}
            onChange={(e) => onBody(e.target.value)}
          />
        )}

        {note.blocks && note.blocks.length > 0 && (
          <div className="mt-8">
            <div className="mb-3 border-b pb-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
              Your notes
            </div>
            <BlockRenderer blocks={note.blocks} />
          </div>
        )}
      </div>

      {showShare && (
        <ShareDialog
          noteId={note.id}
          title={note.title || ""}
          onClose={() => setShowShare(false)}
        />
      )}
    </div>
  )
}
