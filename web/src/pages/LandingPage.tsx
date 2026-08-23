import { useEffect, useMemo, useState } from "react"
import { cn } from "@/lib/utils"
import MinervaMark from "@/components/MinervaMark"

/* The logged-out experience — and the whole marketing site, folded into the app
   so there is ONE thing at one URL. A visitor lands here, reads, and signs in
   with Google right where they are; there is no separate website to keep in
   sync. Four in-app "pages" switch client-side (Home / How it works / Features
   / FAQ), it is mobile-first, and the hero actually demonstrates the product
   rather than describing it. */

type View = "home" | "how" | "features" | "faq"

type Props = {
  onSignIn: () => void
  signingIn?: boolean
  error?: string
}

const GoogleG = () => (
  <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.8 6.1C12.3 13.2 17.6 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-2.8-.4-4.1H24v7.5h12.7c-.3 2.1-1.6 5.3-4.7 7.4l7.2 5.6c4.3-4 6.9-9.9 6.9-16.4z" />
    <path fill="#FBBC05" d="M10.4 28.7c-.5-1.5-.8-3-.8-4.7s.3-3.2.8-4.7l-7.8-6.1C1 16.3 0 20 0 24s1 7.7 2.6 10.8l7.8-6.1z" />
    <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.2-5.6c-2 1.4-4.6 2.4-8.7 2.4-6.4 0-11.7-3.7-13.6-9.8l-7.8 6.1C6.5 42.6 14.6 48 24 48z" />
  </svg>
)

const Arrow = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
)

/* ------------------------------------------------------------- sample data */

type Sample = {
  key: string
  label: string
  transcript: string
  title: string
  points: { html: string }[]
  quote: string
  graph: "pes" | "vt" | null
}

const SAMPLES: Sample[] = [
  {
    key: "eco", label: "Economics",
    transcript:
      "so PES is percentage change in quantity supplied over percentage change in price… take 25 to 30 dollars, supply 20 up to 50 thousand… that's 7.5, so elastic… now the five categories, draw each curve…",
    title: "Price Elasticity of Supply",
    points: [
      { html: "<b>PES</b> measures how much quantity supplied responds to a price change: <b>%ΔQ&#8347; / %ΔP</b>." },
      { html: "Worked example: price $25→$30, supply 20k→50k → <b>PES = 7.5</b> (highly elastic)." },
      { html: "Five categories, from perfectly inelastic (vertical) to perfectly elastic (horizontal)." },
    ],
    quote: "Any straight-line supply curve through the origin has unitary elasticity.",
    graph: "pes",
  },
  {
    key: "eng", label: "English",
    transcript:
      "unpack the guided question first… how AND with what effect… you must do text and images, both… write this exactly: the comic explores the stereotype that comics are intellectually inferior…",
    title: "Paper 1 — Unpacking a Guided Question",
    points: [
      { html: "Always <b>unpack the question</b> before writing — identify exactly what it asks you to analyse." },
      { html: "Address <b>both</b> parts: <i>how</i> (the techniques) and <i>with what effect</i> (impact on the reader)." },
      { html: "Cover text <b>and</b> image — do only one and you lose marks straight away." },
    ],
    quote: "The comic explores the stereotype that comics are intellectually inferior to literary works.",
    graph: null,
  },
  {
    key: "phy", label: "Physics",
    transcript:
      "simple harmonic motion… acceleration proportional to displacement, always toward equilibrium… a equals minus omega squared x, don't drop the minus… period is two pi root m over k…",
    title: "Simple Harmonic Motion",
    points: [
      { html: "<b>SHM:</b> acceleration is proportional to displacement and always directed toward equilibrium." },
      { html: "<b>a = −ω²x</b> — the minus sign gives the restoring direction. Don't drop it." },
      { html: "Period <b>T = 2π√(m/k)</b> for a spring; <b>2π√(L/g)</b> for a pendulum." },
    ],
    quote: "At the amplitude, velocity is zero and acceleration is maximum.",
    graph: "vt",
  },
]

function MiniGraph({ kind }: { kind: "pes" | "vt" | null }) {
  if (!kind) return null
  return (
    <div className="mt-4 rounded-lg border bg-muted/40 p-3">
      <svg viewBox="0 0 260 120" width="100%" height="92" fill="none" className="font-mono">
        <line x1="34" y1="12" x2="34" y2="98" stroke="var(--border)" strokeWidth="1.4" />
        <line x1="34" y1="98" x2="238" y2="98" stroke="var(--border)" strokeWidth="1.4" />
        <text x="16" y="60" fill="var(--muted-foreground)" fontSize="9" transform="rotate(-90 16 60)">
          {kind === "pes" ? "Price" : "Velocity"}
        </text>
        <text x="120" y="114" fill="var(--muted-foreground)" fontSize="9">
          {kind === "pes" ? "Quantity" : "Time"}
        </text>
        {kind === "pes" ? (
          <>
            <path d="M40 96 L226 22" stroke="var(--brand)" strokeWidth="2.4" strokeLinecap="round" />
            <path d="M150 96 L226 40" stroke="var(--brand-2)" strokeWidth="2.4" strokeLinecap="round" strokeDasharray="5 4" />
            <text x="196" y="18" fill="var(--brand)" fontSize="9">elastic</text>
          </>
        ) : (
          <path d="M40 60 Q 90 6, 140 60 T 236 60" stroke="var(--brand)" strokeWidth="2.4" strokeLinecap="round" />
        )}
      </svg>
      <p className="mt-1.5 text-center font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
        Auto-drawn from the lesson
      </p>
    </div>
  )
}

/* ---------------------------------------------------- the interactive hero */

function HeroDemo() {
  const [subject, setSubject] = useState(0)
  const [typed, setTyped] = useState("")
  const [phase, setPhase] = useState<"typing" | "writing" | "done">("typing")
  const sample = SAMPLES[subject]
  const reduce = useMemo(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  )

  // Typewriter → "writing" → note reveal, restarting when the subject changes.
  useEffect(() => {
    if (reduce) {
      setTyped(sample.transcript)
      setPhase("done")
      return
    }
    setTyped("")
    setPhase("typing")
    let i = 0
    const full = sample.transcript
    const type = window.setInterval(() => {
      i += 2
      setTyped(full.slice(0, i))
      if (i >= full.length) {
        window.clearInterval(type)
        setPhase("writing")
        window.setTimeout(() => setPhase("done"), 900)
      }
    }, 26)
    return () => window.clearInterval(type)
  }, [subject, sample.transcript, reduce])

  return (
    <div className="relative">
      {/* subject switcher */}
      <div className="mb-4 flex flex-wrap gap-2">
        {SAMPLES.map((s, i) => (
          <button
            key={s.key}
            onClick={() => setSubject(i)}
            className={cn(
              "rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors",
              i === subject
                ? "bg-brand text-white shadow-sm"
                : "border text-muted-foreground hover:border-brand hover:text-brand",
            )}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-[0.92fr_1.08fr]">
        {/* what Minerva hears */}
        <div className="rounded-2xl border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            <span className={cn("h-2 w-2 rounded-full", phase === "done" ? "bg-muted-foreground/40" : "animate-pulse bg-late")} />
            {phase === "done" ? "Recorded" : "Recording"}
          </div>
          <p className="mt-3 min-h-[132px] font-hand text-[19px] leading-snug text-muted-foreground">
            {typed}
            {phase === "typing" && <span className="ml-0.5 inline-block h-5 w-[2px] animate-pulse bg-brand align-middle" />}
          </p>
        </div>

        {/* what Minerva writes */}
        <div
          className={cn(
            "rounded-2xl border bg-card p-5 shadow-md transition-all duration-500",
            phase === "done" ? "opacity-100 translate-y-0" : "opacity-40 translate-y-2",
          )}
        >
          <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-brand">Minerva · revision note</div>
          <h3 className="mt-1.5 font-display text-[21px] font-semibold leading-tight text-foreground">{sample.title}</h3>
          <div className="my-3 h-px bg-border" />
          <ul className="flex flex-col gap-2.5">
            {sample.points.map((p, i) => (
              <li key={i} className="relative pl-5 text-[13.5px] leading-snug text-muted-foreground">
                <span className="absolute left-0.5 top-[7px] h-[7px] w-[7px] rounded-sm bg-gradient-to-br from-brand to-brand-2" />
                <span dangerouslySetInnerHTML={{ __html: p.html }} />
              </li>
            ))}
          </ul>
          <p className="mt-3 border-l-2 border-brand pl-3 font-display text-[14px] italic text-foreground">
            &ldquo;{sample.quote}&rdquo;
          </p>
          <MiniGraph kind={sample.graph} />
        </div>
      </div>
    </div>
  )
}

/* --------------------------------------------------------------- sections */

const STEPS = [
  { n: "01", t: "Press record", d: "One tap when the lesson starts — even with the lid half down. Minerva hears the teacher across the room, in English or Hindi, and keeps up live." },
  { n: "02", t: "Minerva writes it up", d: "Press stop and you get structured notes: headings, the phrases you were told to write exactly, diagrams and graphs — and any homework, filed with its due date." },
  { n: "03", t: "You just revise", d: "Every note lands in the right subject notebook, searchable, on every device. Ask Minerva a question and it answers from your own notes." },
]

const FEATURES = [
  { t: "Records the whole class", d: "Far-field audio tuned for a classroom, not a headset. It transcribes as it goes, so a dropped connection costs minutes, not the lesson." },
  { t: "Diagrams & graphs", d: "Supply curves, velocity–time graphs, flowcharts, mind maps — drawn automatically when the topic has a shape, placed in the right section." },
  { t: "Turns your files into notes", d: "Drop in worksheets, slides, PDFs or a photo of the board. Minerva reads them, groups what belongs together, and writes a proper note per topic." },
  { t: "Timetable & reminders", d: "Snap a photo of your timetable. Minerva reads it and nudges you five minutes before each period, so you never miss the class you meant to record." },
  { t: "ManageBac, untangled", d: "Assignments, discussions and deadlines pulled in and split into clean streams — with anything urgent lifted to the top instead of buried." },
  { t: "Ask your own notes", d: "“What did we say about intertextuality?” Minerva answers from your notes and transcripts, and tells you which lesson it came from." },
]

const FAQS = [
  { q: "Is it free?", a: "Yes — it runs on free AI tiers, no card needed. You sign in with your Google account and start recording." },
  { q: "Will it understand my teacher's accent, or Hindi and English mixed?", a: "It doesn't force a language, so it follows a teacher who switches between Hindi and English mid-sentence — which is exactly when most tools fall apart." },
  { q: "What if the wifi drops mid-class?", a: "The lesson is transcribed in short slices as it runs and a dropped connection is retried automatically, so a blip costs you seconds, not the whole period." },
  { q: "Is my data safe?", a: "Google sign-in only, your notes tied to your account, and the AI keys never leave the server. Nothing is posted anywhere you didn't ask for." },
  { q: "Do the notes actually match my syllabus?", a: "They're written to the standard your course marks against, using its command terms — and they keep the exact phrases your teacher told you to write down." },
  { q: "Can I use it on my phone?", a: "Yes. It's the same app on any device you sign into — record on a laptop in class, revise on your phone on the bus." },
]

function Faq() {
  const [open, setOpen] = useState<number | null>(0)
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-3">
      {FAQS.map((f, i) => (
        <div key={i} className="overflow-hidden rounded-xl border bg-card">
          <button
            onClick={() => setOpen(open === i ? null : i)}
            className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left"
            aria-expanded={open === i}
          >
            <span className="text-[15px] font-semibold">{f.q}</span>
            <span className={cn("shrink-0 text-brand transition-transform", open === i && "rotate-45")}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
            </span>
          </button>
          {open === i && (
            <p className="px-5 pb-5 text-[14.5px] leading-relaxed text-muted-foreground">{f.a}</p>
          )}
        </div>
      ))}
    </div>
  )
}

/* --------------------------------------------------------------- the page */

export default function LandingPage({ onSignIn, signingIn, error }: Props) {
  const [view, setView] = useState<View>("home")
  const [menu, setMenu] = useState(false)

  const NAV: { key: View; label: string }[] = [
    { key: "home", label: "Home" },
    { key: "how", label: "How it works" },
    { key: "features", label: "Features" },
    { key: "faq", label: "FAQ" },
  ]

  const goto = (v: View) => {
    setView(v)
    setMenu(false)
    window.scrollTo({ top: 0, behavior: "smooth" })
  }

  const SignInBtn = ({ big }: { big?: boolean }) => (
    <button
      onClick={onSignIn}
      disabled={signingIn}
      className={cn(
        "inline-flex items-center gap-2.5 rounded-xl bg-white font-semibold text-[#3c4043] shadow-sm ring-1 ring-black/10 transition-transform hover:-translate-y-0.5 disabled:opacity-60",
        big ? "px-6 py-3 text-[15px]" : "px-4 py-2 text-[14px]",
      )}
    >
      <GoogleG />
      {signingIn ? "Opening…" : "Sign in with Google"}
    </button>
  )

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* ------------------------------------------------------------- nav */}
      <header className="sticky top-0 z-50 border-b border-border/70 bg-background/80 backdrop-blur-lg">
        <div className="mx-auto flex w-[92%] max-w-6xl items-center justify-between py-3.5">
          <button onClick={() => goto("home")} className="flex items-center gap-2.5">
            <MinervaMark size={32} idPrefix="nav" className="text-foreground" />
            <span className="font-display text-[20px] font-semibold tracking-tight">Minerva</span>
          </button>

          <nav className="hidden items-center gap-7 md:flex">
            {NAV.map((n) => (
              <button
                key={n.key}
                onClick={() => goto(n.key)}
                className={cn(
                  "text-[14px] font-medium transition-colors",
                  view === n.key ? "text-brand" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {n.label}
              </button>
            ))}
            <SignInBtn />
          </nav>

          <button
            onClick={() => setMenu(!menu)}
            className="rounded-lg border p-2 text-muted-foreground md:hidden"
            aria-label="Menu"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              {menu ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
            </svg>
          </button>
        </div>

        {menu && (
          <div className="border-t bg-background px-[4%] py-3 md:hidden">
            <div className="flex flex-col gap-1">
              {NAV.map((n) => (
                <button
                  key={n.key}
                  onClick={() => goto(n.key)}
                  className={cn(
                    "rounded-lg px-3 py-2.5 text-left text-[15px] font-medium",
                    view === n.key ? "bg-brand-soft text-brand" : "text-foreground",
                  )}
                >
                  {n.label}
                </button>
              ))}
              <div className="px-3 pt-2">
                <SignInBtn />
              </div>
            </div>
          </div>
        )}
      </header>

      {error && (
        <div className="mx-auto mt-4 w-[92%] max-w-2xl rounded-lg border border-l-2 border-l-late bg-card px-4 py-3 text-[13px] text-late">
          {error}
        </div>
      )}

      <main className="mx-auto w-[92%] max-w-6xl">
        {view === "home" && (
          <>
            {/* hero */}
            {/* overflow-hidden clips the decorative glow below: it is a fixed 720px
                wide and on a 375px phone it pushed the page sideways. */}
            <section className="relative grid items-center gap-12 overflow-hidden py-14 md:grid-cols-[0.95fr_1.05fr] md:py-20">
              <div
                aria-hidden
                className="pointer-events-none absolute -top-24 left-1/2 -z-10 h-[520px] w-[720px] -translate-x-1/2 opacity-70"
                style={{ background: "radial-gradient(46% 46% at 30% 20%, color-mix(in oklab, var(--brand) 22%, transparent), transparent 70%), radial-gradient(40% 40% at 78% 8%, color-mix(in oklab, var(--brand-2) 16%, transparent), transparent 70%)" }}
              />
              <div>
                <span className="font-mono text-[12px] font-medium uppercase tracking-[0.14em] text-brand">For IB Diploma students</span>
                <h1 className="mt-4 font-display text-[clamp(38px,6vw,62px)] font-[650] leading-[1.05] tracking-tight">
                  Sit in class.<br />Leave with the{" "}
                  <span className="bg-gradient-to-r from-brand to-brand-2 bg-clip-text italic text-transparent">notes</span>.
                </h1>
                <p className="mt-5 max-w-[32ch] text-[18px] text-muted-foreground">
                  Minerva listens to the lesson and writes complete, revision-ready notes — headings, diagrams, quotes and all. You just show up.
                </p>
                <div className="mt-8 flex flex-wrap items-center gap-3.5">
                  <SignInBtn big />
                  <button onClick={() => goto("how")} className="inline-flex items-center gap-2 rounded-xl border bg-card px-5 py-3 text-[15px] font-semibold text-foreground shadow-sm transition-colors hover:border-brand hover:text-brand">
                    See how it works
                  </button>
                </div>
                <p className="mt-5 flex items-center gap-2 text-[13.5px] text-muted-foreground">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--ok)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                  Free to start · your notes on every device · nothing to install
                </p>
              </div>
              <HeroDemo />
            </section>

            {/* trust strip */}
            <section className="flex flex-wrap items-center justify-center gap-x-8 gap-y-3 rounded-2xl border bg-muted/30 px-6 py-5 font-mono text-[12.5px] text-muted-foreground">
              <span>Records the whole class</span>
              <span className="text-brand">·</span>
              <span>Writes the notes</span>
              <span className="text-brand">·</span>
              <span>Draws the diagrams</span>
              <span className="text-brand">·</span>
              <span>Catches the homework</span>
              <span className="text-brand">·</span>
              <span>Syncs everywhere</span>
            </section>

            {/* how teaser */}
            <section className="py-16 md:py-24">
              <div className="mx-auto mb-12 max-w-xl text-center">
                <span className="font-mono text-[12px] uppercase tracking-[0.14em] text-brand">Three steps, one of them yours</span>
                <h2 className="mt-3 font-display text-[clamp(28px,4vw,40px)] font-semibold">You press record. Minerva does the rest.</h2>
              </div>
              <div className="grid gap-5 md:grid-cols-3">
                {STEPS.map((s) => (
                  <div key={s.n} className="rounded-2xl border bg-card p-6 shadow-sm">
                    <div className="font-mono text-[13px] text-brand">Step {s.n}</div>
                    <h3 className="mt-3 font-display text-[22px] font-semibold">{s.t}</h3>
                    <p className="mt-2.5 text-[15px] leading-relaxed text-muted-foreground">{s.d}</p>
                    <div className="mt-4 h-[2px] w-10 rounded bg-gradient-to-r from-brand to-brand-2" />
                  </div>
                ))}
              </div>
            </section>

            {/* story */}
            <section className="grid items-center gap-10 rounded-3xl border bg-muted/30 p-8 md:grid-cols-2 md:p-12">
              <div>
                <span className="font-mono text-[12px] uppercase tracking-[0.14em] text-brand">Why it exists</span>
                <blockquote className="mt-4 font-display text-[clamp(23px,3.2vw,31px)] font-medium leading-[1.28]">
                  I'm a builder and a sports guy, not the studious type —{" "}
                  <span className="bg-gradient-to-r from-brand to-brand-2 bg-clip-text italic text-transparent">I still want notes as good as the ones I'd spend an hour making by hand.</span>
                </blockquote>
                <p className="mt-5 font-mono text-[13px] text-muted-foreground">— the student Minerva was built for</p>
              </div>
              <div className="flex flex-col gap-4">
                {[
                  ["Notes to your syllabus", "Written to the standard your course marks against, using its command terms — not a generic summary."],
                  ["The teacher's exact words", "The phrases you'd lose marks for missing are kept verbatim, in their own line."],
                  ["Nothing to install or leak", "Google sign-in only, data tied to your account, keys never leave the server."],
                ].map(([t, d]) => (
                  <div key={t} className="flex items-start gap-3.5">
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-ok/15 text-ok">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                    </span>
                    <p className="text-[15px] text-muted-foreground"><b className="text-foreground">{t}.</b> {d}</p>
                  </div>
                ))}
              </div>
            </section>

            <FinalCta onSignIn={onSignIn} signingIn={signingIn} />
          </>
        )}

        {view === "how" && (
          <section className="py-14 md:py-20">
            <div className="mx-auto mb-14 max-w-xl text-center">
              <span className="font-mono text-[12px] uppercase tracking-[0.14em] text-brand">How it works</span>
              <h2 className="mt-3 font-display text-[clamp(30px,5vw,46px)] font-semibold">From spoken lesson to finished note.</h2>
              <p className="mt-4 text-[17px] text-muted-foreground">No typing in class. No re-writing it neatly at home. Watch a real lesson become a note.</p>
            </div>
            <div className="mb-16"><HeroDemo /></div>
            <div className="mx-auto flex max-w-3xl flex-col gap-4">
              {STEPS.map((s) => (
                <div key={s.n} className="flex gap-5 rounded-2xl border bg-card p-6">
                  <div className="font-display text-[34px] font-semibold leading-none text-brand/40">{s.n}</div>
                  <div>
                    <h3 className="font-display text-[22px] font-semibold">{s.t}</h3>
                    <p className="mt-2 text-[15.5px] leading-relaxed text-muted-foreground">{s.d}</p>
                  </div>
                </div>
              ))}
            </div>
            <FinalCta onSignIn={onSignIn} signingIn={signingIn} />
          </section>
        )}

        {view === "features" && (
          <section className="py-14 md:py-20">
            <div className="mx-auto mb-14 max-w-xl text-center">
              <span className="font-mono text-[12px] uppercase tracking-[0.14em] text-brand">Everything a note needs</span>
              <h2 className="mt-3 font-display text-[clamp(30px,5vw,46px)] font-semibold">Built for how a lesson actually goes.</h2>
            </div>
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((f) => (
                <div key={f.t} className="group rounded-2xl border bg-card p-6 shadow-sm transition-all hover:-translate-y-1 hover:shadow-md">
                  <div className="mb-4 h-1 w-8 rounded bg-gradient-to-r from-brand to-brand-2" />
                  <h3 className="font-display text-[19px] font-semibold">{f.t}</h3>
                  <p className="mt-2 text-[14.5px] leading-relaxed text-muted-foreground">{f.d}</p>
                </div>
              ))}
            </div>
            <FinalCta onSignIn={onSignIn} signingIn={signingIn} />
          </section>
        )}

        {view === "faq" && (
          <section className="py-14 md:py-20">
            <div className="mx-auto mb-12 max-w-xl text-center">
              <span className="font-mono text-[12px] uppercase tracking-[0.14em] text-brand">Questions students ask</span>
              <h2 className="mt-3 font-display text-[clamp(30px,5vw,46px)] font-semibold">Good questions.</h2>
            </div>
            <Faq />
            <FinalCta onSignIn={onSignIn} signingIn={signingIn} />
          </section>
        )}
      </main>

      <footer className="border-t">
        <div className="mx-auto flex w-[92%] max-w-6xl flex-wrap items-center justify-between gap-4 py-8">
          <div className="flex items-center gap-2.5">
            <MinervaMark size={28} idPrefix="foot" className="text-foreground" />
            <span className="font-display text-[17px] font-semibold">Minerva</span>
          </div>
          <p className="text-[13.5px] text-muted-foreground">Notes that write themselves while you sit in class.</p>
        </div>
      </footer>
    </div>
  )
}

function FinalCta({ onSignIn, signingIn }: { onSignIn: () => void; signingIn?: boolean }) {
  return (
    <section className="my-16 md:my-24">
      <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand to-brand-2 px-8 py-16 text-center text-white shadow-xl md:px-12">
        <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(60% 80% at 80% 0%, rgba(255,255,255,.16), transparent 60%)" }} />
        <h2 className="relative font-display text-[clamp(30px,5vw,48px)] font-semibold text-white">Your next class could write itself.</h2>
        <p className="relative mt-4 text-[18px] text-white/90">Sign in with Google and press record when the lesson starts.</p>
        <div className="relative mt-8 flex justify-center">
          <button
            onClick={onSignIn}
            disabled={signingIn}
            className="inline-flex items-center gap-2.5 rounded-xl bg-white px-6 py-3 text-[15px] font-semibold text-[#3c4043] shadow-md transition-transform hover:-translate-y-0.5 disabled:opacity-60"
          >
            <GoogleG />
            {signingIn ? "Opening…" : "Get started — it's free"}
            <Arrow />
          </button>
        </div>
      </div>
    </section>
  )
}
