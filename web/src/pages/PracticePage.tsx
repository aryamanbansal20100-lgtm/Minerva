/* ==========================================================================
   PracticePage.tsx — the "learn it properly" half of the app.

   Notes are the recording half: they capture the lesson so nothing is lost.
   This screen is the other half — it turns what was captured into questions
   that have to be answered, because reading a note again is not revision and
   every student who has ever highlighted a page knows it.

   Three rules shape the whole screen:

     1. The answer starts CLOSED. Attempting the question first is the entire
        point; a card that opens with the mark scheme showing is a worksheet
        with the answers printed on it. Nothing here opens an answer for you —
        except marking yourself, which is the same act.

     2. The wait is real, so it is narrated. /api/practice reads the notes,
        then writes questions, then works the answers through — 15 to 40
        seconds. A frozen button for half a minute reads as a crash. So the
        panel says which of those three things is happening, counts the
        seconds in mono, and moves a bar, and the button says "Writing…"
        rather than sitting there looking dead.

     3. Self-marking is honest and private. "Got it" / "Not yet" is local
        state and stays local state — nothing is posted, no score is kept,
        nobody is ranked. A student who is scared of a number will not tell
        the truth to one, and the truth is the only thing that makes revision
        work. "Not yet" is a bookmark, not a mark.

   Data in: /api/state for the subject list, /api/notes for the notes. Both
   are optional — the page loads its own copies and still works if it is
   routed to cold.
   ========================================================================== */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { StatRow, type Stat } from "@/components/StatRow";
import { InlineMath } from "@/components/note/BlockRenderer";

/* -------------------------------------------------------------- the shapes */

/** How the question makes you think. The server's vocabulary, kept as-is. */
export type PracticeKind = "recall" | "apply" | "analyse" | "calculate";

/** One question as POST /api/practice sends it. */
export type PracticeQuestion = {
  q: string;
  marks?: number | null;
  /** The course's own command term — Define, Explain, Calculate, Evaluate. */
  command?: string | null;
  kind?: PracticeKind | string | null;
  /** The full mark-scheme answer, not a hint. */
  answer: string;
  /** Step-by-step route to the answer, one line per step. */
  working?: string[] | null;
  /** The underlying idea, for a student who got it wrong. */
  why?: string | null;
  /** The mistake students actually make here. Empty when there is no trap. */
  trap?: string | null;
};

export type PracticeResponse = {
  topic?: string | null;
  questions?: PracticeQuestion[] | null;
};

/** A note row, as GET /api/notes sends it. */
export type PracticeNote = {
  id: string;
  title?: string | null;
  subject?: string | null;
  topic?: string | null;
  updated_at?: string | null;
};

type NotesResponse = { notes?: PracticeNote[] | null };

/** The slice of GET /api/state this page reads. */
type StatePayload = {
  profile?: { subjects?: string[] | null } | null;
  notebooks?: { id?: string | null; title?: string | null }[] | null;
  notes?: PracticeNote[] | null;
};

/** What the student said about their own attempt. Never leaves the browser. */
type Verdict = "got" | "not";

export type PracticePageProps = {
  /** Deep link from another screen: prefill the picker and start straight in. */
  initial?: { subject?: string; noteId?: string };
  /** Open a note in the host app. Used by the "read it again" nudge. */
  onOpenNote?: (id: string) => void;
};

/* ------------------------------------------------------------------ pieces */

const COUNTS = [3, 5, 8] as const;

const FIELD_LABEL =
  "mb-1.5 block text-[11px] font-bold uppercase tracking-[0.08em] text-muted-foreground";

const SELECT =
  "h-9 w-full rounded-md border bg-background px-2.5 text-[13px] text-foreground " +
  "outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring " +
  "disabled:cursor-not-allowed disabled:opacity-50";

const BTN_GHOST =
  "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1.5 " +
  "text-[12.5px] font-medium text-muted-foreground transition-colors " +
  "hover:bg-muted hover:text-foreground";

const CARD =
  "rounded-[10px] border bg-card shadow-[0_1px_2px_rgba(20,20,26,0.04)] " +
  "transition-[transform,box-shadow] duration-[140ms] ease-out";

const MICRO_LABEL =
  "mb-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-muted-foreground";

/* --------------------------------------------------------------- the icons */

/* Inline, stroked, sized in the JSX. No icon dependency and no emoji: a book
   emoji in a revision app is the exact register this build is trying to
   leave behind. */

function IconChevron({ open }: { open: boolean }) {
  return (
    <svg
      width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true"
      className={cn("transition-transform duration-150", open && "rotate-180")}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg
      width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function IconAgain() {
  return (
    <svg
      width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

function IconWarn() {
  return (
    <svg
      width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      <path d="M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );
}

function IconIdea() {
  return (
    <svg
      width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      <path d="M9 18h6M10 22h4" />
      <path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2h6c0-.8.4-1.5 1-2A7 7 0 0 0 12 2Z" />
    </svg>
  );
}

function IconPencil() {
  return (
    <svg
      width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function IconSpinner() {
  return (
    <svg
      width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" aria-hidden="true"
      className="animate-spin text-brand"
    >
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  );
}

/* ------------------------------------------------------------ the long wait */

/* The stages are the three things the server actually does, in order, timed
   off the observed 15-40 second range. They are honest labels, not a fake
   progress theatre: "Reading your notes…" really is what happens first. */
const STAGES: { at: number; head: string; sub: string }[] = [
  { at: 0, head: "Reading your notes…", sub: "pulling out what the lesson actually covered" },
  { at: 7, head: "Picking what is worth asking…", sub: "the bits an exam would go for" },
  { at: 15, head: "Writing questions…", sub: "your course's own command terms and marks" },
  { at: 25, head: "Working the answers through…", sub: "every step, so you can check yours against it" },
  { at: 34, head: "Checking the mark scheme…", sub: "nearly there — this set is a long one" },
];

function stageFor(seconds: number): { head: string; sub: string } {
  let chosen = STAGES[0];
  for (const stage of STAGES) if (seconds >= stage.at) chosen = stage;
  return chosen;
}

/* ----------------------------------------------------------------- helpers */

/** "4 marks", "1 mark", and nothing at all when the model left it off. */
function marksLabel(marks: number | null | undefined): string {
  const value = typeof marks === "number" && marks > 0 ? marks : 0;
  if (!value) return "";
  return `${value} ${value === 1 ? "mark" : "marks"}`;
}

/** Dedupe while keeping the order the student is used to seeing. */
function uniqueStrings(values: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = (value || "").trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function same(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a || "").trim().toLowerCase() === (b || "").trim().toLowerCase();
}

/** The label a note wears in the picker. */
function noteLabel(note: PracticeNote): string {
  return (note.title || note.topic || "Untitled note").trim() || "Untitled note";
}

/* ------------------------------------------------------------ one question */

type QuestionCardProps = {
  index: number;
  question: PracticeQuestion;
  hue: string;
  revealed: boolean;
  verdict: Verdict | undefined;
  onToggle: (index: number) => void;
  onMark: (index: number, verdict: Verdict) => void;
};

/* memo'd because the loading panel ticks four times a second while a second
   set is generating, and a set of eight cards should not re-render with it. */
const QuestionCard = memo(function QuestionCard({
  index,
  question,
  hue,
  revealed,
  verdict,
  onToggle,
  onMark,
}: QuestionCardProps) {
  const bodyId = `practice-answer-${index}`;
  const working = (question.working || []).filter((step) => (step || "").trim());
  const trap = (question.trap || "").trim();
  const why = (question.why || "").trim();
  const marks = marksLabel(question.marks);
  const command = (question.command || "").trim();
  const kind = (question.kind || "").trim();

  return (
    <article
      className={cn(
        CARD,
        "minerva-rise overflow-hidden",
        "hover:-translate-y-0.5 hover:shadow-[0_2px_4px_rgba(28,27,25,0.06),0_14px_34px_rgba(28,27,25,0.10)]",
      )}
      style={{ animationDelay: `${Math.min(index, 5) * 0.04}s` }}
    >
      {/* -------------------------------------------------------- the ask */}
      <div className="px-4 py-[15px] sm:px-5">
        <div className="mb-2.5 flex flex-wrap items-center gap-2">
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
            style={{ background: hue }}
          />
          <span className="font-mono text-[11.5px] tabular-nums text-muted-foreground">
            Q{index + 1}
          </span>
          {command ? (
            <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-brand">
              {command}
            </span>
          ) : null}
          {kind ? (
            <span className="text-[11.5px] lowercase text-muted-foreground">{kind}</span>
          ) : null}
          {marks ? (
            <span className="ml-auto font-mono text-[12px] tabular-nums text-muted-foreground">
              {marks}
            </span>
          ) : null}
        </div>

        {/* break-words, because a long formula or a chemical name must wrap
            rather than push the card sideways on a phone. */}
        <p className="break-words text-[15px] leading-[1.6] text-foreground">
          <InlineMath text={question.q} />
        </p>

        {/* ----------------------------------------------------- controls */}
        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onToggle(index)}
            aria-expanded={revealed}
            aria-controls={bodyId}
            className={cn(
              BTN_GHOST,
              revealed && "border-brand/40 text-brand hover:text-brand",
            )}
          >
            <IconChevron open={revealed} />
            {revealed ? "Hide answer" : "Show answer"}
          </button>

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => onMark(index, "got")}
              aria-pressed={verdict === "got"}
              className={cn(
                BTN_GHOST,
                verdict === "got" && "border-ok font-semibold text-ok hover:text-ok",
              )}
            >
              <IconCheck />
              Got it
            </button>
            <button
              type="button"
              onClick={() => onMark(index, "not")}
              aria-pressed={verdict === "not"}
              className={cn(
                BTN_GHOST,
                verdict === "not" && "border-info font-semibold text-info hover:text-info",
              )}
            >
              <IconAgain />
              Not yet
            </button>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------ the answer */}
      {revealed ? (
        <div id={bodyId} className="border-t bg-muted/25 px-4 py-[15px] sm:px-5">
          <div>
            <div className={MICRO_LABEL}>Mark scheme</div>
            <p className="break-words text-[13.5px] leading-[1.65] text-foreground">
              <InlineMath text={question.answer} />
            </p>
          </div>

          {working.length ? (
            <div className="mt-4">
              <div className={MICRO_LABEL}>Working</div>
              <ol className="space-y-1.5">
                {working.map((step, stepIndex) => (
                  <li key={stepIndex} className="flex gap-2.5">
                    <span className="mt-[3px] w-4 shrink-0 font-mono text-[11.5px] tabular-nums text-muted-foreground">
                      {stepIndex + 1}
                    </span>
                    <span className="min-w-0 flex-1 break-words text-[13.5px] leading-[1.6]">
                      <InlineMath text={step} />
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}

          {why ? (
            <div className="mt-4 rounded-md border border-l-2 border-l-info px-3 py-2.5">
              <div className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-info">
                <IconIdea />
                Why this works
              </div>
              <p className="text-[13px] leading-[1.6] text-foreground">
                <InlineMath text={why} />
              </p>
            </div>
          ) : null}

          {trap ? (
            <div className="mt-3 rounded-md border border-l-2 border-l-warn px-3 py-2.5">
              <div className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-warn">
                <IconWarn />
                Common mistake
              </div>
              <p className="text-[13px] leading-[1.6] text-warn">
                <InlineMath text={trap} />
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
});

/* --------------------------------------------------------------- the screen */

export function PracticePage({ initial, onOpenNote }: PracticePageProps) {
  /* Picker */
  const [subject, setSubject] = useState(initial?.subject?.trim() || "");
  const [noteId, setNoteId] = useState(initial?.noteId?.trim() || "");
  const [count, setCount] = useState<number>(5);

  /* Sources for the picker */
  const [subjects, setSubjects] = useState<string[]>([]);
  const [notes, setNotes] = useState<PracticeNote[]>([]);

  /* The set */
  const [topic, setTopic] = useState("");
  const [questions, setQuestions] = useState<PracticeQuestion[]>([]);
  const [fromNoteId, setFromNoteId] = useState("");
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [verdicts, setVerdicts] = useState<Record<number, Verdict>>({});

  /* The wait */
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const running = useRef(false);

  /* ---------------------------------------------------------- the sources */

  useEffect(() => {
    let live = true;
    void (async () => {
      const [stateOut, notesOut] = await Promise.allSettled([
        api.get<StatePayload>("/api/state"),
        api.get<NotesResponse>("/api/notes"),
      ]);
      if (!live) return;

      const state = stateOut.status === "fulfilled" ? stateOut.value : null;
      const fromNotes = notesOut.status === "fulfilled" ? notesOut.value.notes : null;
      const list = (fromNotes || state?.notes || []).filter((n) => n && n.id);
      setNotes(list);
      setSubjects(
        uniqueStrings([
          ...(state?.profile?.subjects || []),
          ...(state?.notebooks || []).map((book) => book?.title ?? ""),
          ...list.map((note) => note.subject ?? ""),
        ]),
      );
      /* Both calls failing means the connection is down, and the picker would
         otherwise sit there empty with no explanation. */
      if (stateOut.status === "rejected" && notesOut.status === "rejected") {
        const err = notesOut.reason;
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  /* --------------------------------------------------------------- the run */

  /* Takes its arguments rather than reading state, so the deep-link path and
     the button path are the same code and neither can fire on stale values. */
  const run = useCallback(
    async (wantSubject: string, wantNote: string, wantCount: number) => {
      if (running.current) return;
      if (!wantSubject && !wantNote) {
        setError("Pick a subject or one of your notes first, then I can write you a set.");
        return;
      }
      running.current = true;
      setBusy(true);
      setError("");
      setElapsed(0);
      try {
        const body: { count: number; subject?: string; note_id?: string } = {
          count: wantCount,
        };
        if (wantSubject) body.subject = wantSubject;
        if (wantNote) body.note_id = wantNote;

        const out = await api.post<PracticeResponse>("/api/practice", body);
        const written = (out.questions || []).filter(
          (question) => question && (question.q || "").trim() && (question.answer || "").trim(),
        );
        setQuestions(written);
        setTopic((out.topic || "").trim());
        setFromNoteId(wantNote);
        setOpen({});
        setVerdicts({});
        if (!written.length) {
          setError(
            "That came back with no questions. There may not be enough written down " +
              "on this topic yet — record one more lesson and try again.",
          );
        }
      } catch (err: unknown) {
        /* The server writes a human sentence into { error }; the api client
           hands it over unchanged, so show it unchanged. */
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        running.current = false;
        setBusy(false);
      }
    },
    [],
  );

  /* A deep link from another screen — "practise this" on an assessment — fills
     the picker and starts straight away, once per distinct link. Waiting for a
     second click after the student already asked for practice is a click for
     nothing. */
  const linkKey = `${initial?.subject?.trim() || ""}|${initial?.noteId?.trim() || ""}`;
  const linked = useRef("");
  useEffect(() => {
    if (linked.current === linkKey) return;
    linked.current = linkKey;
    const [wantSubject, wantNote] = linkKey.split("|");
    if (!wantSubject && !wantNote) return;
    setSubject(wantSubject);
    setNoteId(wantNote);
    void run(wantSubject, wantNote, count);
    /* `count` is read once at link time on purpose: changing the count later
       must not re-run a generation that already happened. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkKey, run]);

  /* The seconds counter. Only alive while a request is in flight. */
  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    const timer = window.setInterval(
      () => setElapsed(Math.round((Date.now() - started) / 1000)),
      250,
    );
    return () => window.clearInterval(timer);
  }, [busy]);

  /* ------------------------------------------------------------ the marking */

  const toggle = useCallback((index: number) => {
    setOpen((current) => ({ ...current, [index]: !current[index] }));
  }, []);

  /* Marking yourself reveals the answer — you cannot mark what you have not
     seen, and making the student press two buttons for one intention is the
     kind of friction that ends a revision session. Pressing the same verdict
     again clears it, so a mis-tap is not a permanent lie. */
  const mark = useCallback((index: number, verdict: Verdict) => {
    setVerdicts((current) => {
      const next = { ...current };
      if (next[index] === verdict) delete next[index];
      else next[index] = verdict;
      return next;
    });
    setOpen((current) => ({ ...current, [index]: true }));
  }, []);

  /* ------------------------------------------------------------ the numbers */

  const notesForSubject = useMemo(
    () => notes.filter((note) => !subject || same(note.subject, subject)),
    [notes, subject],
  );

  const totalMarks = useMemo(
    () =>
      questions.reduce(
        (sum, question) =>
          sum + (typeof question.marks === "number" && question.marks > 0 ? question.marks : 0),
        0,
      ),
    [questions],
  );

  const got = useMemo(
    () => Object.values(verdicts).filter((verdict) => verdict === "got").length,
    [verdicts],
  );
  const notYet = useMemo(
    () => Object.values(verdicts).filter((verdict) => verdict === "not").length,
    [verdicts],
  );

  const hasSet = questions.length > 0;

  const stats: Stat[] = [
    {
      label: "Questions",
      value: hasSet ? questions.length : "—",
      sub: hasSet ? topic || "written from your notes" : "nothing written yet",
    },
    {
      label: "Marks",
      value: hasSet ? totalMarks : "—",
      sub: hasSet ? "available in this set" : "pick a subject to start",
    },
    {
      label: "Self-marked",
      value: hasSet ? `${got}/${questions.length}` : "—",
      sub: hasSet ? "you say you got it" : "only you ever see this",
    },
  ];

  const subjectIndex = subjects.findIndex((name) => same(name, subject));
  const hue =
    subjectIndex >= 0
      ? `var(--subj-${subjectIndex % 8})`
      : "var(--color-muted-foreground)";

  const chosenNote = notes.find((note) => note.id === noteId);
  const sourceNoteId = fromNoteId || "";
  const canGenerate = Boolean(subject || noteId);
  const stage = stageFor(elapsed);
  /* Creeps toward 94% over the 40-second worst case and stops there. A bar that
     hits 100% and then keeps waiting is worse than no bar at all. */
  const progress = Math.min(94, 6 + elapsed * 2.4);

  return (
    <section className="mx-auto w-full max-w-4xl px-5 py-6 sm:px-6">
      {/* ------------------------------------------------------------ header */}
      <header className="mb-5">
        <h1 className="text-[19px] font-semibold tracking-tight">Practice</h1>
        <p className="mt-0.5 text-[12.5px] text-muted-foreground">
          Exam-style questions written from your own lessons — attempt first, then
          mark yourself.
        </p>
      </header>

      <StatRow stats={stats} />

      {/* ------------------------------------------------------------ picker */}
      <div className={cn(CARD, "px-4 py-4 sm:px-5")}>
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label className={FIELD_LABEL} htmlFor="practice-subject">
              Subject
            </label>
            <select
              id="practice-subject"
              className={SELECT}
              value={subject}
              disabled={busy}
              onChange={(event) => {
                setSubject(event.target.value);
                /* A note from the old subject would quietly override the new
                   one on the next click, so it goes. */
                setNoteId("");
              }}
            >
              <option value="">
                {subjects.length ? "Choose a subject" : "No subjects yet"}
              </option>
              {subjects.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={FIELD_LABEL} htmlFor="practice-note">
              From
            </label>
            <select
              id="practice-note"
              className={SELECT}
              value={noteId}
              disabled={busy || !notesForSubject.length}
              onChange={(event) => {
                const id = event.target.value;
                setNoteId(id);
                const picked = notes.find((note) => note.id === id);
                /* Picking a note from "all notes" tells us its subject, which
                   the server wants anyway. */
                if (picked?.subject && !subject) setSubject(picked.subject.trim());
              }}
            >
              <option value="">
                {notesForSubject.length
                  ? subject
                    ? `Everything in ${subject}`
                    : "Everything I have written"
                  : "No notes here yet"}
              </option>
              {notesForSubject.map((note) => (
                <option key={note.id} value={note.id}>
                  {noteLabel(note)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2.5">
            <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted-foreground">
              Questions
            </span>
            <div
              role="group"
              aria-label="How many questions"
              className="inline-flex rounded-md border p-0.5"
            >
              {COUNTS.map((option) => (
                <button
                  key={option}
                  type="button"
                  disabled={busy}
                  aria-pressed={count === option}
                  onClick={() => setCount(option)}
                  className={cn(
                    "rounded-[5px] px-3 py-1 font-mono text-[13px] tabular-nums transition-colors",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                    count === option
                      ? "bg-brand-soft font-semibold text-brand"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>

          <button
            type="button"
            disabled={busy || !canGenerate}
            aria-busy={busy}
            onClick={() => void run(subject, noteId, count)}
            className={cn(
              "btn-brand ml-auto inline-flex items-center gap-2 rounded-lg px-4 py-2",
              "text-[13.5px] font-semibold",
              "disabled:pointer-events-none disabled:opacity-60",
            )}
          >
            {busy ? (
              <>
                <svg
                  width="15" height="15" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                  aria-hidden="true" className="animate-spin"
                >
                  <path d="M12 3a9 9 0 1 0 9 9" />
                </svg>
                Writing your set…
              </>
            ) : (
              <>
                <IconPencil />
                {hasSet ? "Generate another set" : "Generate practice"}
              </>
            )}
          </button>
        </div>

        {chosenNote ? (
          <p className="mt-2.5 text-[12px] text-muted-foreground">
            Questions will come from {noteLabel(chosenNote)}
            {chosenNote.subject ? ` · ${chosenNote.subject}` : ""}.
          </p>
        ) : null}
      </div>

      {/* ------------------------------------------------------------- error */}
      {error ? (
        <div className="mt-4 rounded-[10px] border border-l-2 border-l-late bg-card px-4 py-3">
          <p className="text-[13px] leading-[1.55] text-late">{error}</p>
        </div>
      ) : null}

      {/* ----------------------------------------------------------- waiting */}
      {busy ? (
        <div className={cn(CARD, "mt-4 px-4 py-[18px] sm:px-5")} role="status" aria-live="polite">
          <div className="flex items-center gap-3">
            <IconSpinner />
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-semibold">{stage.head}</p>
              <p className="mt-0.5 text-[12.5px] text-muted-foreground">{stage.sub}</p>
            </div>
            <span className="shrink-0 font-mono text-[12.5px] tabular-nums text-muted-foreground">
              {elapsed}s
            </span>
          </div>
          <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="brand-gradient h-full rounded-full transition-[width] duration-500 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="mt-2.5 text-[12px] text-muted-foreground">
            Writing real questions takes 15 to 40 seconds. Stay on this screen and I
            will have them ready.
          </p>
        </div>
      ) : null}

      {/* ----------------------------------------------------------- the set */}
      {hasSet ? (
        <>
          <div className="mb-3 mt-6 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-[15px] font-semibold tracking-tight">
              {topic || subject || "Your practice"}
            </h2>
            <p className="text-[12.5px] text-muted-foreground">
              <span className="font-mono tabular-nums">{questions.length}</span> questions
              {" · "}
              <span className="font-mono tabular-nums">{totalMarks}</span> marks · answers
              stay hidden until you ask
            </p>
            {sourceNoteId && onOpenNote ? (
              <button
                type="button"
                className={cn(BTN_GHOST, "ml-auto")}
                onClick={() => onOpenNote(sourceNoteId)}
              >
                Open the note
              </button>
            ) : null}
          </div>

          <div className="space-y-3">
            {questions.map((question, index) => (
              <QuestionCard
                key={`${index}-${question.q.slice(0, 24)}`}
                index={index}
                question={question}
                hue={hue}
                revealed={Boolean(open[index])}
                verdict={verdicts[index]}
                onToggle={toggle}
                onMark={mark}
              />
            ))}
          </div>

          {/* Closing line. Encouraging, and it says what to do next rather than
              what was got wrong. */}
          <div className="mt-4 rounded-[10px] border px-4 py-3">
            <p className="text-[12.5px] leading-[1.6] text-muted-foreground">
              {got === questions.length ? (
                <>
                  Every one marked <span className="text-ok">got it</span>. That topic is
                  in decent shape — try a longer set, or move on to the next one.
                </>
              ) : notYet ? (
                <>
                  <span className="font-mono tabular-nums">{notYet}</span>{" "}
                  {notYet === 1 ? "question" : "questions"} marked{" "}
                  <span className="text-info">not yet</span> — read those bits back in
                  your notes, then generate a fresh set and see what changed.
                </>
              ) : (
                <>
                  Work through them on paper first. Marking yourself honestly is what
                  makes this worth the half hour.
                </>
              )}
            </p>
          </div>
        </>
      ) : null}

      {/* --------------------------------------------------------- the empty */}
      {!hasSet && !busy ? (
        <div className="brand-panel mt-4 rounded-[10px] px-5 py-6">
          <div className="flex items-start gap-3.5">
            <div className="brand-gradient grid h-9 w-9 shrink-0 place-items-center rounded-lg text-white">
              <IconPencil />
            </div>
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold tracking-tight">
                Practice written from your own notes
              </h2>
              <p className="mt-1 max-w-[62ch] text-[13px] leading-[1.65] text-muted-foreground">
                Not generic questions off the internet — these come from the lessons you
                recorded, in your course's command terms, with the marks a real paper
                would give. So the more lessons you record, the closer this gets to the
                paper you actually sit.
              </p>
              <p className="mt-2 max-w-[62ch] text-[13px] leading-[1.65] text-muted-foreground">
                {notes.length
                  ? "Pick a subject above — or one note if you want to drill one topic — and I will write you a set. Answers stay hidden until you have had a go."
                  : "Record a lesson first and this fills itself in. One lesson is enough to practise from."}
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export default PracticePage;
