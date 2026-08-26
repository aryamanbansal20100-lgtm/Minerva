import { useEffect, useState } from "react"
import {
  createShare,
  revokeShare,
  shareLink,
  wordLink,
} from "@/lib/share"

/* The Share sheet.

   Opening it creates the link straight away, because "share" means "give me the
   link" — nobody wants a second click to generate the thing they asked for. The
   copy explains the one idea that makes this feature click: the SAME link does
   the right thing for whoever opens it. A friend who has Minerva lands in the
   app and can add the note to their own; anyone else reads it on the web or
   takes it away as a Word file. And because it is a frozen copy, sharing never
   opens a window onto the rest of the student's account.

   "Stop sharing" is here too, one tap, because a link you cannot recall is a
   link you should think twice about sending — so we made it recallable. */

export default function ShareDialog({
  noteId,
  title,
  onClose,
}: {
  noteId: string
  title: string
  onClose: () => void
}) {
  const [token, setToken] = useState("")
  const [views, setViews] = useState(0)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState("")
  const [copied, setCopied] = useState(false)
  const [revoked, setRevoked] = useState(false)

  useEffect(() => {
    let live = true
    ;(async () => {
      try {
        const info = await createShare(noteId)
        if (!live) return
        setToken(info.token)
        setViews(info.views)
      } catch (e) {
        if (live) setError((e as Error).message)
      } finally {
        if (live) setBusy(false)
      }
    })()
    return () => {
      live = false
    }
  }, [noteId])

  // Esc closes, like every other dialog the student meets.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  const link = token ? shareLink(token) : ""

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard blocked — the field is selectable, so nothing is lost */
    }
  }

  const nativeShare = async () => {
    try {
      await navigator.share({ title, text: title + " — a note on Minerva", url: link })
    } catch {
      /* the student dismissed the share sheet */
    }
  }

  const stop = async () => {
    if (!window.confirm("Stop sharing this note? The link will stop working.")) return
    setBusy(true)
    try {
      await revokeShare(token)
      setRevoked(true)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[80] grid place-items-center bg-black/45 px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Share note"
        className="w-full max-w-[420px] rounded-2xl border bg-card p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-start justify-between gap-3">
          <h2 className="text-[16px] font-semibold tracking-tight">Share this note</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 -mt-1 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <p className="mb-4 truncate text-[12.5px] text-muted-foreground">{title || "Untitled"}</p>

        {revoked ? (
          <div className="rounded-xl border bg-muted/30 px-4 py-6 text-center">
            <p className="text-[13.5px] font-medium">Sharing stopped.</p>
            <p className="mt-1 text-[12.5px] text-muted-foreground">
              The link no longer works. Share again any time to make a new one.
            </p>
            <button
              onClick={onClose}
              className="btn-brand mt-4 rounded-lg px-4 py-2 text-[13px] font-semibold"
            >
              Done
            </button>
          </div>
        ) : busy && !token ? (
          <div className="py-8 text-center text-[13px] text-muted-foreground">Making a link…</div>
        ) : error && !token ? (
          // Only creation failing (no link yet) takes over the whole panel.
          <div className="rounded-lg border border-late/30 bg-late/5 px-3 py-3 text-[12.5px] text-late">
            {error}
          </div>
        ) : (
          <>
            {/* The link itself. */}
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={link}
                onFocus={(e) => e.currentTarget.select()}
                className="min-w-0 flex-1 rounded-lg border bg-background px-3 py-2 text-[12.5px] text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-brand-ring"
              />
              <button
                onClick={copy}
                className="btn-brand shrink-0 rounded-lg px-3.5 py-2 text-[13px] font-semibold"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>

            <p className="mt-3 text-[12px] leading-relaxed text-muted-foreground">
              Anyone with the link can read this note. People who have Minerva can
              add it to their own notes; everyone else can open it on the web or
              download it as a Word file. It’s a fixed copy — the rest of your
              account stays private.
            </p>

            {/* Ways to send / take it away. */}
            <div className="mt-4 flex flex-wrap gap-2">
              {typeof navigator !== "undefined" && "share" in navigator && (
                <button
                  onClick={nativeShare}
                  className="flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[13px] transition-colors hover:bg-muted"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4" /></svg>
                  Share…
                </button>
              )}
              <a
                href={wordLink(token)}
                className="flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[13px] transition-colors hover:bg-muted"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M12 18v-6M9 15l3 3 3-3" /></svg>
                Word file
              </a>
              <a
                href={link}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[13px] transition-colors hover:bg-muted"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></svg>
                Preview
              </a>
            </div>

            <div className="mt-4 flex items-center justify-between border-t pt-3">
              <span className="text-[12px] text-muted-foreground">
                {views > 0
                  ? `Opened ${views} time${views === 1 ? "" : "s"}`
                  : "Not opened yet"}
              </span>
              <button
                onClick={stop}
                disabled={busy}
                className="text-[12.5px] font-medium text-late underline underline-offset-2 hover:opacity-80 disabled:opacity-50"
              >
                Stop sharing
              </button>
            </div>

            {/* A failed action (e.g. revoke) shows here, without hiding the
                link and controls the student still needs. */}
            {error && <p className="mt-3 text-[12.5px] text-late">{error}</p>}
          </>
        )}
      </div>
    </div>
  )
}
