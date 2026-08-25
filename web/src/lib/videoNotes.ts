/* videoNotes.ts — turn an uploaded video (or audio) recording into a note.

   The heavy lifting is done here in the browser, which already has the codecs:
   the file's audio is decoded, downmixed to mono and resampled to 16 kHz (all
   Whisper needs), then cut into ten-minute WAV chunks. Each chunk goes through
   the SAME endpoints a live recording uses -- /api/record/start, /chunk,
   /finish -- so an uploaded lesson becomes a note by exactly the path a
   recorded one does, diagrams and all. Nothing new is asked of the server, and
   no ffmpeg is needed anywhere.

   Why chunks: Groq's transcription takes at most 25 MB a request. Ten minutes
   of 16 kHz mono WAV is about 19 MB, comfortably under it, and long enough that
   a sentence is rarely split. Why 16 kHz mono: it is the model's native rate,
   and it shrinks a one-hour lesson from a gigabyte of video to ~115 MB of audio
   the browser can hold. */

import { apiPost, apiPostRaw } from "@/lib/api"

const CHUNK_SECONDS = 10 * 60 // 10 minutes per transcription request
const TARGET_RATE = 16000 // Whisper's native sample rate

export type VideoProgress = {
  phase: "decoding" | "transcribing" | "writing" | "done" | "error"
  chunk?: number
  chunks?: number
  message?: string
}

/** Decode any browser-playable video/audio file to a single mono 16 kHz track.
    Returns the raw Float32 samples. Throws a readable error if the file has no
    audio the browser can decode. */
async function decodeToMono16k(file: File): Promise<Float32Array> {
  const bytes = await file.arrayBuffer()
  // Decoding at the target rate makes the browser resample for us; we still
  // downmix to mono ourselves afterwards.
  const Ctx: typeof OfflineAudioContext =
    window.OfflineAudioContext ||
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext })
      .webkitOfflineAudioContext
  // A 1-frame context purely to run decodeAudioData at 16 kHz.
  const probe = new Ctx(1, 1, TARGET_RATE)
  let buffer: AudioBuffer
  try {
    buffer = await probe.decodeAudioData(bytes)
  } catch {
    throw new Error(
      "That file's audio could not be read in the browser. MP4, MOV, WebM and " +
        "M4A work best; try one of those.",
    )
  }
  // Downmix to mono by averaging channels.
  const chans = buffer.numberOfChannels
  const n = buffer.length
  const mono = new Float32Array(n)
  for (let c = 0; c < chans; c++) {
    const data = buffer.getChannelData(c)
    for (let i = 0; i < n; i++) mono[i] += data[i] / chans
  }
  return mono
}

/** A 16-bit PCM WAV file from mono Float32 samples at 16 kHz. No library: the
    header is 44 fixed bytes and the samples are scaled to int16. */
function monoToWav(samples: Float32Array, rate = TARGET_RATE): Blob {
  const bytesPerSample = 2
  const dataLen = samples.length * bytesPerSample
  const buf = new ArrayBuffer(44 + dataLen)
  const view = new DataView(buf)
  const put = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }
  put(0, "RIFF")
  view.setUint32(4, 36 + dataLen, true)
  put(8, "WAVE")
  put(12, "fmt ")
  view.setUint32(16, 16, true) // PCM chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * bytesPerSample, true) // byte rate
  view.setUint16(32, bytesPerSample, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  put(36, "data")
  view.setUint32(40, dataLen, true)
  let off = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    off += bytesPerSample
  }
  return new Blob([buf], { type: "audio/wav" })
}

/** Turn one video/audio file into one note. Drives the same record endpoints a
    live lesson uses. `onProgress` reports decode → per-chunk transcribe →
    write, so a long file never looks frozen. Returns the note id. */
export async function videoToNote(
  file: File,
  opts: { subject?: string; topic?: string; context?: string },
  onProgress?: (p: VideoProgress) => void,
): Promise<{ noteId: string }> {
  try {
    onProgress?.({ phase: "decoding", message: file.name })
    const mono = await decodeToMono16k(file)

    const total = Math.max(1, Math.ceil(mono.length / (TARGET_RATE * CHUNK_SECONDS)))

    // A title without the extension reads better as a note title.
    const title = file.name.replace(/\.[^.]+$/, "")
    const started = await apiPost<{ id: string; note_id: string }>(
      "/api/record/start",
      { title, subject: opts.subject || "", topic: opts.topic || title, context: opts.context || "school" },
    )

    for (let c = 0; c < total; c++) {
      const from = c * TARGET_RATE * CHUNK_SECONDS
      const to = Math.min(mono.length, from + TARGET_RATE * CHUNK_SECONDS)
      const wav = monoToWav(mono.subarray(from, to))
      onProgress?.({ phase: "transcribing", chunk: c + 1, chunks: total, message: file.name })
      await apiPostRaw("/api/record/chunk", wav, {
        "Content-Type": "audio/wav",
        "X-Recording": started.id,
        "X-Note": started.note_id,
        "X-Chunk": String(c),
        "X-Filename": `part-${c}.wav`,
      })
    }

    onProgress?.({ phase: "writing", message: file.name })
    await apiPost("/api/record/finish", { id: started.id })
    onProgress?.({ phase: "done", chunks: total, message: file.name })
    return { noteId: started.note_id }
  } catch (err) {
    onProgress?.({
      phase: "error",
      message: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}

/** Process a queue of videos ONE AT A TIME, so only one file's audio is ever
    held in memory. Twenty one-hour videos decoded at once would exhaust the
    tab; sequentially, each is freed before the next. Returns how many became
    notes. */
export async function videosToNotes(
  files: File[],
  opts: { subject?: string; context?: string },
  onProgress?: (fileIndex: number, total: number, p: VideoProgress) => void,
): Promise<{ made: number; failures: string[] }> {
  let made = 0
  const failures: string[] = []
  for (let i = 0; i < files.length; i++) {
    try {
      await videoToNote(files[i], opts, (p) => onProgress?.(i, files.length, p))
      made++
    } catch (err) {
      failures.push(
        `${files[i].name}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  return { made, failures }
}
