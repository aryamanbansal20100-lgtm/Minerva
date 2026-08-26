import { useEffect, useState } from "react"
import { addSharedNote, viewShare, type SharedNote } from "@/lib/share"
import { BlockRenderer, type Block } from "@/components/note/BlockRenderer"
import MinervaMark from "@/components/MinervaMark"

/* The shared note, opened inside Minerva.

   This is the destination of a share link for someone who has the app: the note
   itself, read-only, drawn with the real renderer (so diagrams show properly,
   which the plain web page cannot), and one button that matters — Add to my
   notes. Pressing it copies the note into their own account, and from then on it
   is theirs to edit, practise from, and keep. Pressing it twice just reopens the
   copy they already made. */

export default function SharedNotePage({
  token,
  onOpenNote,
  onLeave,
  onAdded,
}: {
  token: string
  onOpenNote: (id: string) => void
  onLeave: () => void
  onAdded?: () => void | Promise<void>
}) {
  const [note, setNote] = useState<SharedNote | null>(null)
  const [error, setError] = useState("")
  const [adding, setAdding] = useState(false)
  const [addedId, setAddedId] = useState("")

  useEffect(() => {
    let live = true
    setNote(null)
    setError("")
    ;(async () => {
      try {
        const n = await viewShare(token)
        if (live) setNote(n)
      } catch (e) {
        if (live) setError((e as Error).message)
      }
    })()
    return () => {
      live = false
    }
  }, [token])

  const add = async () => {
    setAdding(true)
    setError("")
    try {
      const { note_id } = await addSharedNote(token)
      await onAdded?.()
      // Confirm in place rather than redirect. A brand-new viewer who signed in
      // just to read this has not set Minerva up yet, so jumping straight to the
      // note would drop them into the setup form; letting them choose "Open it"
      // keeps them with the note they came for.
      setAddedId(note_id)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setAdding(false)
    }
  }

  if (error && !note) {
    return (
      <div className="grid min-h-[60vh] place-items-center px-6 text-center">
        <div className="max-w-sm">
          <MinervaMark size={40} className="mx-auto mb-4 text-muted-foreground" idPrefix="shared-err" />
          <h1 className="text-[17px] font-semibold">This shared note isn’t available</h1>
          <p className="mt-1.5 text-[13px] text-muted-foreground">
            The link may have been turned off by the person who shared it.
          </p>
          <button
            onClick={onLeave}
            className="btn-brand mt-5 rounded-lg px-4 py-2 text-[13px] font-semibold"
          >
            Go to my notes
          </button>
        </div>
      </div>
    )
  }

  if (!note) {
    return <div className="p-8 text-sm text-muted-foreground">Loading…</div>
  }

  return (
    <div>
      <div className="sticky top-0 z-20 flex items-center gap-3 border-b bg-background/85 px-6 py-4 backdrop-blur">
        <button
          onClick={onLeave}
          className="rounded-md border px-2.5 py-1.5 text-[13px] text-muted-foreground hover:bg-muted"
        >
          ← Notes
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] text-muted-foreground">
            Shared{note.owner_name ? ` by ${note.owner_name}` : ""}
          </div>
        </div>
        {addedId ? (
          <button
            onClick={() => onOpenNote(addedId)}
            className="btn-brand rounded-lg px-3.5 py-1.5 text-[13px] font-semibold"
          >
            Open it →
          </button>
        ) : (
          <button
            onClick={add}
            disabled={adding}
            className="btn-brand rounded-lg px-3.5 py-1.5 text-[13px] font-semibold disabled:opacity-60"
          >
            {adding ? "Adding…" : "Add to my notes"}
          </button>
        )}
      </div>

      <div className="mx-auto max-w-3xl px-6 py-6">
        <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-brand">
          <MinervaMark size={15} className="text-brand" idPrefix="shared" />
          Shared note
        </div>
        <h1 className="text-[24px] font-semibold tracking-tight">{note.title || "Untitled"}</h1>
        {(note.subject || note.topic) && (
          <div className="mt-2 flex flex-wrap gap-2">
            {note.subject && (
              <span className="rounded-full bg-brand-soft px-2.5 py-0.5 text-[12px] font-medium text-brand">
                {note.subject}
              </span>
            )}
            {note.topic && (
              <span className="rounded-full border px-2.5 py-0.5 text-[12px] text-muted-foreground">
                {note.topic}
              </span>
            )}
          </div>
        )}

        {error && <p className="mt-4 text-[12.5px] text-late">{error}</p>}

        <div className="mt-6">
          {note.blocks && note.blocks.length > 0 ? (
            <BlockRenderer blocks={note.blocks as Block[]} />
          ) : note.body ? (
            <p className="whitespace-pre-wrap font-serif text-[16px] leading-relaxed">{note.body}</p>
          ) : (
            <p className="text-[13px] text-muted-foreground">This note has no content yet.</p>
          )}
        </div>

        {addedId ? (
          <div className="mt-8 rounded-xl border border-ok/30 bg-ok/5 px-4 py-4 text-center">
            <p className="text-[13.5px] font-medium text-foreground">
              Added to your notes ✓
            </p>
            <p className="mt-1 text-[12.5px] text-muted-foreground">
              It’s yours now — open it to edit it and practise from it.
            </p>
            <button
              onClick={() => onOpenNote(addedId)}
              className="btn-brand mt-3 rounded-lg px-4 py-2 text-[13px] font-semibold"
            >
              Open it
            </button>
          </div>
        ) : (
          <div className="mt-8 rounded-xl border bg-muted/25 px-4 py-4 text-center">
            <p className="text-[13px] text-muted-foreground">
              Like this note? Add it to your own to edit it and practise from it.
            </p>
            <button
              onClick={add}
              disabled={adding}
              className="btn-brand mt-3 rounded-lg px-4 py-2 text-[13px] font-semibold disabled:opacity-60"
            >
              {adding ? "Adding…" : "Add to my notes"}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
