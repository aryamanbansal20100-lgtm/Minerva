import { useEffect, useRef, useState } from "react"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"

/* Live lesson capture, ported from the vanilla build with its hard-won
   classroom behaviour intact:

   - far-field constraints (every browser filter OFF — see CLASS_AUDIO),
   - a single continuous MediaRecorder that re-arms after every slice, so there
     are no gaps between slices,
   - first words fast (the first slice is cut at ~6s, not 20), then short 25s
     slices so the transcript keeps flowing — as close to live as a batch
     transcriber gets without a streaming API,
   - per-error microphone messages (NotReadableError means another app holds the
     mic — it is NOT a permission problem), trying every input device,
   - the running transcript is accumulated and streamed out via onTranscript so
     it can fill the whole page while the lesson runs, not a tiny caption line.

   All the mutable machinery lives in a ref, because it changes many times a
   second and must never trigger a React re-render. Only what the user actually
   sees is state. */

/* Slice length is an accuracy decision, not a UI one.

   Whisper reasons over a 30-second window. Cutting every 25s meant almost
   every slice was chopped mid-sentence, so it never had a whole thought to work
   from and words landing on a boundary were lost outright. Chasing a "live"
   feel made the transcript materially worse — which is the opposite of the
   point, because the notes are the product and the live text is only feedback.

   90 seconds gives Whisper several complete sentences of context. The first
   slice stays short so the student can see within seconds that it is hearing
   the room. */
const CHUNK_MS = 90 * 1000
const FIRST_CHUNK_MS = 8 * 1000
const TICK_MS = 100
const BITRATE = 64000

const CLASS_AUDIO: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
  sampleRate: 48000,
}

type FinishOut = {
  empty?: boolean
  message?: string
  note?: unknown
  words?: number
  tasks?: unknown[]
}

type CoachKey = "silent" | "quiet" | "loud" | "good" | "waiting" | "working"

const COACH: Record<CoachKey, { title: string; advice: string; tone: string }> = {
  silent: { title: "No sound reaching the mic", advice: "Something is muting it — check the mic icon in the address bar.", tone: "text-late" },
  quiet: { title: "Very quiet", advice: "Move the laptop closer to the teacher, or lift the lid a bit.", tone: "text-warn" },
  loud: { title: "Too loud — it may clip", advice: "Move it slightly away or turn the lid down.", tone: "text-warn" },
  good: { title: "Picking up the room", advice: "Leave it be. Notes are written when you press stop.", tone: "text-ok" },
  waiting: { title: "Listening", advice: "First words appear in a few seconds, then about every 90.", tone: "text-ok" },
  working: { title: "Transcribing", advice: "Keep it running — this happens in the background.", tone: "text-ok" },
}

function micReason(err: unknown): string {
  const name = (err as { name?: string })?.name || ""
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Microphone permission was refused. Click the icon at the left of the address bar, set Microphone to Allow, then reload."
  if (name === "NotReadableError" || name === "AbortError")
    return 'Another program is holding the microphone — WisprFlow, Teams, Zoom, Discord or a recorder. Close it (check the tray by the clock) and press record again. If nothing is open, check Windows Settings → Privacy & security → Microphone.'
  if (name === "NotFoundError" || name === "DevicesNotFoundError")
    return "No microphone was found. Plug one in, or check it is enabled in Windows sound settings."
  if (name === "OverconstrainedError")
    return "This microphone will not accept the classroom settings. It should have fallen back automatically."
  return "The microphone would not open (" + (name || String(err)) + ")."
}

async function tryEveryMic(): Promise<MediaStream | null> {
  let devices: MediaDeviceInfo[] = []
  try {
    devices = await navigator.mediaDevices.enumerateDevices()
  } catch {
    return null
  }
  for (const d of devices.filter((x) => x.kind === "audioinput" && x.deviceId)) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { ...CLASS_AUDIO, deviceId: { exact: d.deviceId } },
      })
    } catch {
      /* next device */
    }
  }
  return null
}

type Machine = {
  id: string | null
  rec: MediaRecorder | null
  stream: MediaStream | null
  ctx: AudioContext | null
  an: AnalyserNode | null
  buf: Uint8Array<ArrayBuffer> | null
  parts: Blob[]
  idx: number
  busy: number
  t0: number
  roll: ReturnType<typeof setTimeout> | null
  tick: ReturnType<typeof setInterval> | null
  mime: string
}

const fresh = (): Machine => ({
  id: null, rec: null, stream: null, ctx: null, an: null, buf: null,
  parts: [], idx: 0, busy: 0, t0: 0, roll: null, tick: null, mime: "",
})

type Props = {
  noteId: string
  onError?: (msg: string) => void
  onFinished?: (out: FinishOut) => void
  /** Fires whenever a new slice lands, with the FULL running transcript so the
      page can show it live in the main area rather than a caption line. */
  onTranscript?: (fullText: string, live: boolean) => void
}

export default function Recorder({ noteId, onError, onFinished, onTranscript }: Props) {
  const R = useRef<Machine>(fresh())
  const transcript = useRef("")
  const [on, setOn] = useState(false)
  const [clock, setClock] = useState("00:00")
  const [chunks, setChunks] = useState("0")
  const [level, setLevel] = useState(0)
  const [coachKey, setCoachKey] = useState<CoachKey | null>(null)
  const [caption, setCaption] = useState("Press record when the lesson starts.")
  const quiet = useRef(0)
  const loud = useRef(0)

  // Stop cleanly if the note is closed mid-recording.
  useEffect(() => {
    return () => {
      const m = R.current
      if (m.roll) clearTimeout(m.roll)
      if (m.tick) clearInterval(m.tick)
      m.stream?.getTracks().forEach((t) => t.stop())
      m.ctx?.close().catch(() => {})
    }
  }, [])

  const paint = () => {
    const m = R.current
    const secs = m.id ? Math.floor((Date.now() - m.t0) / 1000) : 0
    setClock(String(Math.floor(secs / 60)).padStart(2, "0") + ":" + String(secs % 60).padStart(2, "0"))
    setChunks(m.idx + (m.busy ? "+" + m.busy : ""))
    if (m.id && m.an && m.buf) {
      m.an.getByteTimeDomainData(m.buf)
      let sum = 0
      for (let i = 0; i < m.buf.length; i++) {
        const v = (m.buf[i] - 128) / 128
        sum += v * v
      }
      const lvl = Math.min(1, Math.sqrt(sum / m.buf.length) * 4)
      setLevel(lvl)
      updateCoach(lvl)
    }
  }

  const updateCoach = (lvl: number) => {
    const m = R.current
    let key: CoachKey
    if (m.busy) key = "working"
    else if (!m.idx && Date.now() - m.t0 < FIRST_CHUNK_MS) key = "waiting"
    else if (lvl < 0.004) {
      quiet.current += TICK_MS
      key = quiet.current > 4000 ? "silent" : "good"
    } else if (lvl < 0.02) {
      quiet.current = 0
      loud.current = 0
      key = "quiet"
    } else if (lvl > 0.85) {
      loud.current += TICK_MS
      key = loud.current > 1500 ? "loud" : "good"
    } else {
      quiet.current = 0
      loud.current = 0
      key = "good"
    }
    if (lvl >= 0.004) quiet.current = 0
    setCoachKey((prev) => (prev === key ? prev : key))
  }

  const send = async (blob: Blob, idx: number) => {
    const m = R.current
    m.busy++
    paint()
    try {
      const out = await api.postRaw<{ text?: string }>("/api/record/chunk", blob, {
        "Content-Type": blob.type || "audio/webm",
        "X-Recording": m.id || "",
        "X-Chunk": String(idx),
        "X-Note": noteId,
        "X-Filename": (m.mime || "").includes("mp4") ? "c.mp4" : "c.webm",
      })
      if (out.text) {
        // Append to the running transcript and stream the whole thing out, so
        // the note area fills with words as the lesson goes.
        transcript.current = (transcript.current + " " + out.text).trim()
        onTranscript?.(transcript.current, true)
        setCaption(out.text.slice(-160))
      } else {
        setCaption("Heard nothing in that slice — check the mic is picking up the room.")
      }
    } catch (e) {
      setCaption("Slice " + (idx + 1) + " failed — " + (e as Error).message)
      onError?.("Slice " + (idx + 1) + ": " + (e as Error).message)
    } finally {
      m.busy--
      paint()
    }
  }

  const spin = () => {
    const m = R.current
    m.mime =
      ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((t) =>
        MediaRecorder.isTypeSupported(t),
      ) || ""
    m.parts = []
    m.rec = new MediaRecorder(m.stream!, {
      ...(m.mime ? { mimeType: m.mime } : {}),
      audioBitsPerSecond: BITRATE,
    })
    m.rec.ondataavailable = (e) => {
      if (e.data.size) m.parts.push(e.data)
    }
    m.rec.onstop = () => {
      const blob = new Blob(m.parts, { type: m.mime || "audio/webm" })
      m.parts = []
      if (blob.size > 1200) send(blob, m.idx++)
      if (m.id) spin()
    }
    m.rec.start()
  }

  const cut = (final: boolean) => {
    const m = R.current
    if (m.rec && m.rec.state !== "inactive") m.rec.stop()
    if (final) m.rec = null
  }

  const start = async () => {
    const m = R.current
    try {
      m.stream = await navigator.mediaDevices.getUserMedia({ audio: CLASS_AUDIO })
    } catch {
      try {
        m.stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      } catch (e2) {
        const got = await tryEveryMic()
        if (got) m.stream = got
        else return onError?.(micReason(e2))
      }
    }
    try {
      const out = await api.post<{ id: string }>("/api/record/start", { note_id: noteId })
      m.id = out.id
    } catch (e) {
      m.stream?.getTracks().forEach((t) => t.stop())
      return onError?.((e as Error).message)
    }
    m.idx = 0
    m.busy = 0
    m.t0 = Date.now()
    transcript.current = ""
    onTranscript?.("", true)
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    m.ctx = new AC()
    m.an = m.ctx.createAnalyser()
    m.an.fftSize = 1024
    m.ctx.createMediaStreamSource(m.stream!).connect(m.an)
    m.buf = new Uint8Array(new ArrayBuffer(m.an.fftSize))
    spin()
    m.roll = setTimeout(() => {
      cut(false)
      m.roll = setInterval(() => cut(false), CHUNK_MS)
    }, FIRST_CHUNK_MS)
    m.tick = setInterval(paint, TICK_MS)
    setOn(true)
    setCaption("Listening… first words appear in about 20 seconds.")
    paint()
  }

  const stop = async () => {
    const m = R.current
    const id = m.id
    const seconds = Math.round((Date.now() - m.t0) / 1000)
    m.id = null
    setOn(false)
    if (m.roll) {
      clearTimeout(m.roll)
      clearInterval(m.roll)
    }
    if (m.tick) clearInterval(m.tick)
    cut(true)
    m.stream?.getTracks().forEach((t) => t.stop())
    m.ctx?.close().catch(() => {})
    m.stream = null
    m.ctx = null
    m.an = null
    setCaption("Writing your notes…")

    for (let i = 0; i < 180 && m.busy > 0; i++) {
      await new Promise((r) => setTimeout(r, 500))
    }
    try {
      const out = await api.post<FinishOut>("/api/record/finish", { id, seconds })
      // The lesson is written up now — the live transcript is no longer live.
      onTranscript?.(transcript.current, false)
      if (out.empty) onError?.(out.message || "nothing was recorded")
      else onFinished?.(out)
    } catch (e) {
      onError?.((e as Error).message)
    } finally {
      setCaption("Press record when the lesson starts.")
      paint()
    }
  }

  const coach = coachKey ? COACH[coachKey] : null

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center gap-4">
        <button
          onClick={on ? stop : start}
          className={cn(
            "flex items-center gap-2 rounded-md px-3 py-2 text-[13px] font-medium transition-colors",
            on
              ? "bg-late/15 text-late hover:bg-late/25"
              : "bg-primary text-primary-foreground hover:opacity-90",
          )}
        >
          <span
            className={cn("inline-block h-2 w-2 rounded-full", on ? "animate-pulse bg-late" : "bg-current")}
          />
          {on ? "Stop recording" : "Record"}
        </button>

        <div className="flex items-end gap-[2px]" aria-hidden>
          {Array.from({ length: 7 }).map((_, i) => {
            const c = 1 - Math.abs(i - 3) / 7
            const h = on ? Math.max(3, level * 22 * (0.5 + c)) : 3
            return <span key={i} className="w-[3px] rounded-full bg-muted-foreground/60" style={{ height: h }} />
          })}
        </div>

        <div className="ml-auto text-right">
          <div className="font-mono text-[15px] tabular-nums">{clock}</div>
          <div className="text-[11px] text-muted-foreground">
            <span className="tabular-nums">{chunks}</span> slices
          </div>
        </div>
      </div>

      {coach && (
        <div className="mt-3 border-l-2 border-current pl-3">
          <div className={cn("text-[12px] font-semibold", coach.tone)}>{coach.title}</div>
          <div className="text-[12px] text-muted-foreground">{coach.advice}</div>
        </div>
      )}

      <div className="mt-3 min-h-[18px] text-[12.5px] text-muted-foreground">{caption}</div>
    </div>
  )
}
