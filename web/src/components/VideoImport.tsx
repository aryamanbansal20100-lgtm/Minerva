import { useCallback, useRef, useState } from "react"
import { videosToNotes, type VideoProgress } from "@/lib/videoNotes"

/* "Notes from video": pick one or many recordings, get one note each.

   Each file is decoded to audio in the browser and run through the same
   transcribe-and-compose path a live recording uses, one file at a time so a
   long queue never exhausts the tab. Progress is shown per file and per chunk,
   because a one-hour lesson takes real minutes and a silent spinner would read
   as a hang. */

type Status = {
  running: boolean
  fileIndex: number
  total: number
  phase: VideoProgress["phase"] | ""
  chunk?: number
  chunks?: number
  name?: string
  done: number
  failures: string[]
}

const IDLE: Status = {
  running: false,
  fileIndex: 0,
  total: 0,
  phase: "",
  done: 0,
  failures: [],
}

export default function VideoImport({
  subject,
  context = "school",
  onDone,
}: {
  subject?: string
  context?: "school" | "tuition"
  onDone?: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [status, setStatus] = useState<Status>(IDLE)

  const run = useCallback(
    async (files: File[]) => {
      if (!files.length) return
      setStatus({ ...IDLE, running: true, total: files.length })
      const { made, failures } = await videosToNotes(
        files,
        { subject, context },
        (fileIndex, total, p) =>
          setStatus((s) => ({
            ...s,
            fileIndex,
            total,
            phase: p.phase,
            chunk: p.chunk,
            chunks: p.chunks,
            name: p.message,
          })),
      )
      setStatus({ ...IDLE, done: made, failures })
      if (made) onDone?.()
    },
    [subject, onDone],
  )

  const phaseLabel =
    status.phase === "decoding"
      ? "Reading the audio…"
      : status.phase === "transcribing"
        ? `Transcribing ${status.chunk}/${status.chunks}…`
        : status.phase === "writing"
          ? "Writing the note…"
          : ""

  return (
    <div className="mb-5 rounded-lg border bg-card px-4 py-3.5">
      <input
        ref={input}
        type="file"
        accept="video/*,audio/*"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files || [])
          e.target.value = "" // let the same file be picked again later
          void run(files)
        }}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13.5px] font-medium">Notes from video</div>
          <div className="text-[12px] text-muted-foreground">
            Upload class recordings — one note per video, transcribed here in
            your browser.
          </div>
        </div>
        <button
          type="button"
          onClick={() => input.current?.click()}
          disabled={status.running}
          className="shrink-0 rounded-md border px-3 py-2 text-[13px] font-medium transition-colors hover:bg-muted disabled:opacity-55"
        >
          {status.running ? "Working…" : "Choose videos"}
        </button>
      </div>

      {status.running && (
        <div className="mt-3 flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-[12px] text-muted-foreground">
            <span className="truncate">
              {status.name} · {phaseLabel}
            </span>
            <span className="font-mono tabular-nums">
              {status.fileIndex + 1}/{status.total}
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-brand transition-[width] duration-300"
              style={{
                width: `${((status.fileIndex + (status.phase === "writing" || status.phase === "done" ? 1 : 0)) / Math.max(1, status.total)) * 100}%`,
              }}
            />
          </div>
        </div>
      )}

      {!status.running && status.done > 0 && (
        <p className="mt-2.5 text-[12.5px] text-ok">
          Made {status.done} note{status.done === 1 ? "" : "s"}. They're in the
          list below.
        </p>
      )}
      {!status.running && status.failures.length > 0 && (
        <div className="mt-2 flex flex-col gap-1">
          {status.failures.map((f, i) => (
            <p key={i} className="text-[12px] text-late">
              {f}
            </p>
          ))}
        </div>
      )}

      <p className="mt-2 text-[11.5px] text-muted-foreground">
        Big files are processed one at a time and can take a few minutes each.
        Transcription uses your daily Groq quota (~8 hours a day on a free key —
        add yours in Settings).
      </p>
    </div>
  )
}
