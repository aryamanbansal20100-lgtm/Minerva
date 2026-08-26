import { useCallback, useEffect, useMemo, useState } from "react"
import { apiGet, apiPost } from "@/lib/api"
import MinervaMark from "@/components/MinervaMark"
import { cn } from "@/lib/utils"

/* First-run setup.

   A signed-in account with no curriculum and no subjects is a blank app: the
   timetable has nothing to place, practice has nothing to draw from, notes have
   no subject to file under. This collects the few things everything else needs,
   once, up front — rather than leaving the student to discover Settings and
   guess what matters.

   Three short steps, not one long form: who you are, what you take, and the one
   optional thing that makes recording free. It writes the same profile the
   Settings page does (POST /api/profile) and sets onboarded, which is what the
   gate in App watches for. */

type SubjectsResponse = { subjects?: string[]; curricula?: string[] }

const FALLBACK_CURRICULA = [
  "IB Diploma Programme",
  "IB MYP",
  "CBSE",
  "ICSE / ISC",
  "Cambridge IGCSE",
  "A Levels",
]

export default function Onboarding({
  initialName,
  onDone,
}: {
  initialName?: string
  onDone: () => void
}) {
  const [step, setStep] = useState(0)
  const [name, setName] = useState(initialName || "")
  const [curriculum, setCurriculum] = useState("")
  const [curricula, setCurricula] = useState<string[]>(FALLBACK_CURRICULA)
  const [suggested, setSuggested] = useState<string[]>([])
  const [subjects, setSubjects] = useState<string[]>([])
  const [tuition, setTuition] = useState<string[]>([])
  const [customSubject, setCustomSubject] = useState("")
  const [key, setKey] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  // The list of curricula comes from the server, but the form works offline
  // too — a sensible list is baked in and replaced when the fetch lands.
  useEffect(() => {
    apiGet<SubjectsResponse>("/api/subjects")
      .then((r) => {
        if (r.curricula?.length) setCurricula(r.curricula)
      })
      .catch(() => {})
  }, [])

  // When a curriculum is chosen, suggest its usual subjects so the student taps
  // rather than types — but they can always add their own.
  useEffect(() => {
    if (!curriculum) {
      setSuggested([])
      return
    }
    apiGet<SubjectsResponse>(
      `/api/subjects?curriculum=${encodeURIComponent(curriculum)}`,
    )
      .then((r) => setSuggested(r.subjects || []))
      .catch(() => setSuggested([]))
  }, [curriculum])

  const toggle = useCallback((s: string) => {
    setSubjects((cur) =>
      cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s],
    )
  }, [])

  const addCustom = useCallback(() => {
    const s = customSubject.trim()
    if (s && !subjects.includes(s)) setSubjects((c) => [...c, s])
    setCustomSubject("")
  }, [customSubject, subjects])

  const canContinue = useMemo(() => {
    if (step === 0) return name.trim().length > 0 && curriculum.length > 0
    if (step === 1) return subjects.length > 0
    return true
  }, [step, name, curriculum, subjects])

  const finish = useCallback(async () => {
    setSaving(true)
    setError("")
    try {
      await apiPost("/api/profile", {
        name: name.trim(),
        curriculum,
        subjects,
        tuition_subjects: tuition,
        groq_key: key.trim() || undefined,
        onboarded: true,
      })
      // Remember on THIS browser that setup is done, so a later server reset
      // (the free host wipes its disk on redeploy) never re-pops the form.
      try {
        localStorage.setItem("minerva.onboarded", "1")
      } catch {
        /* private mode: the server flag still guards it */
      }
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setSaving(false)
    }
  }, [name, curriculum, subjects, tuition, key, onDone])

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-background text-foreground">
      <div className="mx-auto flex min-h-full w-full max-w-[560px] flex-col px-5 py-10">
        {/* header */}
        <div className="mb-8 flex items-center gap-3">
          <MinervaMark size={40} className="text-foreground" idPrefix="onb" />
          <div>
            <div className="font-display text-[19px] font-semibold tracking-tight">
              Welcome to Minerva
            </div>
            <div className="text-[13px] text-muted-foreground">
              A minute of setup, then it works for you.
            </div>
          </div>
        </div>

        {/* progress */}
        <div className="mb-8 flex gap-1.5">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className={cn(
                "h-1 flex-1 rounded-full transition-colors",
                i <= step ? "bg-brand" : "bg-muted",
              )}
            />
          ))}
        </div>

        {/* STEP 0 — who */}
        {step === 0 && (
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <label className="text-[13px] font-medium">
                What should Minerva call you?
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                autoFocus
                className="rounded-lg border bg-card px-3.5 py-2.5 text-[15px] outline-none focus-visible:ring-2 focus-visible:ring-brand-ring"
              />
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-[13px] font-medium">
                Which course are you doing?
              </label>
              <div className="grid grid-cols-2 gap-2">
                {curricula.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCurriculum(c)}
                    aria-pressed={curriculum === c}
                    className={cn(
                      "rounded-lg border px-3 py-2.5 text-left text-[13.5px] transition-colors",
                      curriculum === c
                        ? "border-brand bg-brand-soft font-medium text-brand"
                        : "hover:bg-muted",
                    )}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* STEP 1 — subjects */}
        {step === 1 && (
          <div className="flex flex-col gap-5">
            <div>
              <div className="text-[15px] font-medium">Your subjects</div>
              <div className="text-[13px] text-muted-foreground">
                Tap the ones you take. Your timetable, notes and practice are all
                organised by these.
              </div>
            </div>

            {suggested.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {suggested.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => toggle(s)}
                    aria-pressed={subjects.includes(s)}
                    className={cn(
                      "rounded-full border px-3 py-1.5 text-[13px] transition-colors",
                      subjects.includes(s)
                        ? "border-brand bg-brand-soft font-medium text-brand"
                        : "hover:bg-muted",
                    )}
                  >
                    {subjects.includes(s) ? "✓ " : "+ "}
                    {s}
                  </button>
                ))}
              </div>
            )}

            {/* subjects the list did not offer */}
            <div className="flex items-center gap-2">
              <input
                value={customSubject}
                onChange={(e) => setCustomSubject(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    addCustom()
                  }
                }}
                placeholder="Add another subject"
                className="min-w-0 flex-1 rounded-lg border bg-card px-3 py-2 text-[14px] outline-none focus-visible:ring-2 focus-visible:ring-brand-ring"
              />
              <button
                type="button"
                onClick={addCustom}
                disabled={!customSubject.trim()}
                className="rounded-lg border px-3 py-2 text-[13px] transition-colors hover:bg-muted disabled:opacity-50"
              >
                Add
              </button>
            </div>

            {subjects.filter((s) => !suggested.includes(s)).length > 0 && (
              <div className="flex flex-wrap gap-2">
                {subjects
                  .filter((s) => !suggested.includes(s))
                  .map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => toggle(s)}
                      className="rounded-full border border-brand bg-brand-soft px-3 py-1.5 text-[13px] font-medium text-brand"
                    >
                      ✓ {s}
                    </button>
                  ))}
              </div>
            )}

            <div className="text-[12.5px] text-muted-foreground">
              {subjects.length} selected
            </div>

            {subjects.length > 0 && (
              <div className="mt-1 flex flex-col gap-2 border-t pt-4">
                <div className="text-[13px] font-medium">
                  Do you go to tuition for any of these?
                </div>
                <div className="text-[12px] text-muted-foreground">
                  Optional — tap the subjects you have tuition for. Those notes
                  get their own Tuition tab, kept apart from school.
                </div>
                <div className="mt-1 flex flex-wrap gap-2">
                  {subjects.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() =>
                        setTuition((cur) =>
                          cur.includes(s)
                            ? cur.filter((x) => x !== s)
                            : [...cur, s],
                        )
                      }
                      aria-pressed={tuition.includes(s)}
                      className={cn(
                        "rounded-full border px-3 py-1.5 text-[13px] transition-colors",
                        tuition.includes(s)
                          ? "border-brand bg-brand-soft font-medium text-brand"
                          : "hover:bg-muted",
                      )}
                    >
                      {tuition.includes(s) ? "✓ " : "+ "}
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* STEP 2 — connect AI (optional) */}
        {step === 2 && (
          <div className="flex flex-col gap-5">
            <div>
              <div className="text-[15px] font-medium">
                Make recording free (optional)
              </div>
              <div className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                Minerva records a class and writes your notes. It works right
                away — but adding your own free Groq key gives you{" "}
                <strong className="text-foreground">
                  8 hours of transcription a day, on your own quota
                </strong>
                , so it never runs out no matter how many people use Minerva.
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <input
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="gsk_…  (paste your key, or skip)"
                autoComplete="off"
                spellCheck={false}
                className="rounded-lg border bg-card px-3.5 py-2.5 font-mono text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-brand-ring"
              />
              <a
                href="https://console.groq.com/keys"
                target="_blank"
                rel="noreferrer noopener"
                className="text-[12.5px] text-brand underline underline-offset-2"
              >
                Get one free at console.groq.com/keys — no card needed
              </a>
            </div>
            <div className="rounded-lg border border-dashed p-3 text-[12.5px] text-muted-foreground">
              You can add or change this any time in Settings → Recording. Your
              key is kept on the server and never shown back to you.
            </div>
          </div>
        )}

        {error && (
          <div className="mt-5 rounded-lg border border-late/40 bg-late/10 px-3 py-2 text-[13px] text-late">
            {error}
          </div>
        )}

        {/* nav */}
        <div className="mt-auto flex items-center justify-between gap-3 pt-9">
          {step > 0 ? (
            <button
              type="button"
              onClick={() => setStep((s) => s - 1)}
              className="rounded-lg px-3 py-2 text-[13.5px] text-muted-foreground transition-colors hover:bg-muted"
            >
              Back
            </button>
          ) : (
            <span />
          )}

          {step < 2 ? (
            <button
              type="button"
              onClick={() => setStep((s) => s + 1)}
              disabled={!canContinue}
              className="btn-brand rounded-lg px-5 py-2.5 text-[14px] font-semibold disabled:opacity-50"
            >
              Continue
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void finish()}
              disabled={saving}
              className="btn-brand rounded-lg px-5 py-2.5 text-[14px] font-semibold disabled:opacity-60"
            >
              {saving ? "Setting up…" : key.trim() ? "Finish" : "Skip & finish"}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
