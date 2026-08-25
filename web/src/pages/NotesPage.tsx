/* ==========================================================================
   NotesPage.tsx — the list of notes, in the Timetable page's language.

   Stat row on top, then the notes themselves as bordered cards. Nothing is a
   flat hairline list any more: a note is a thing you made, so it gets an edge.

   The one piece of real logic here is the "elsewhere" banner. Signing in with a
   second Google account gives a second, empty database, and the app simply
   looks wiped — that is exactly how it looked when a lesson's notes appeared to
   vanish and caused a genuine panic. The server already reports what else is on
   the device (counts only, no content), so when this account is empty and
   another account is not, the page says so loudly, in the first thing you read,
   and says nothing was deleted.
   ========================================================================== */

import { useCallback, useEffect, useMemo, useState } from "react";
import { StatRow, type Stat } from "@/components/StatRow";
import VideoImport from "@/components/VideoImport";
import { apiGet, apiPost } from "@/lib/api";
import { cn } from "@/lib/utils";

/* -------------------------------------------------------------------------
   Row shapes, as the server actually sends them.

   Everything nullable that SQLite can hand back empty, so a half-filled row
   cannot throw on render — a note with no subject is normal, not an error.
   ------------------------------------------------------------------------- */

export type Period = {
  day: string;
  start: string;
  end?: string | null;
  subject: string;
  room?: string | null;
  teacher?: string | null;
};

export type Upcoming = {
  day?: string;
  now?: string;
  current?: Period | null;
  next?: Period | null;
  remaining?: number;
  today?: Period[];
};

export type NoteRow = {
  id: string;
  title?: string | null;
  subject?: string | null;
  topic?: string | null;
  updated_at?: string | null;
  preview?: string | null;
  size?: number | null;
};

export type TaskRow = {
  id: string;
  title?: string | null;
  subject?: string | null;
  due?: string | null;
  done?: number | boolean | null;
};

export type NotebookRow = {
  id?: string;
  title?: string | null;
  notes?: number | null;
};

/** Counts from another Google account's database on this device. No content. */
export type ElsewhereAccount = {
  notes: number;
  documents: number;
  name?: string | null;
  hint?: string | null;
};

/** The slice of GET /api/state this page reads. */
export type NotesState = {
  notes?: NoteRow[] | null;
  tasks?: TaskRow[] | null;
  notebooks?: NotebookRow[] | null;
  timetable?: Upcoming | null;
  elsewhere?: ElsewhereAccount[] | null;
};

export type NotesPageProps = {
  /** Shared /api/state. Omit it and the page loads its own copy. */
  state?: NotesState | null;
  /** Show only this subject. Empty or absent means every note. */
  subject?: string;
  /** Re-read the shared state after this page writes something. */
  refresh?: () => void | Promise<void>;
  /** Open a note. Falls back to the hash route the old build used. */
  onOpenNote?: (id: string) => void;
};

/* -------------------------------------------------------------------------
   Small helpers. Deliberately local: this file is meant to drop into the app
   without waiting on a utils module that may not exist yet.
   ------------------------------------------------------------------------- */

/** today → HH:MM · yesterday · 3d ago · 12 Mar. Same rule as the old build. */
function when(iso?: string | null): string {
  if (!iso) return "";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const days = Math.floor((Date.now() - then.getTime()) / 86400000);
  if (days <= 0) {
    return then.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return then.toLocaleDateString([], { day: "numeric", month: "short" });
}

/* One subject always gets one colour, everywhere in the app. Hashed rather
   than assigned, so a new subject needs no bookkeeping. */
const HUES = new Map<string, string>();

function hueFor(subject: string): string {
  const key = subject.trim();
  if (!key) return "var(--muted-foreground)";
  const known = HUES.get(key);
  if (known) return known;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
  const colour = `hsl(${h} 52% 45%)`;
  HUES.set(key, colour);
  return colour;
}

function isOpen(task: TaskRow): boolean {
  return !task.done;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/* -------------------------------------------------------------------------
   Pieces
   ------------------------------------------------------------------------- */

function SubjectDot({ subject }: { subject: string }) {
  return (
    <span
      aria-hidden="true"
      className="mt-[5px] h-2.5 w-2.5 shrink-0 rounded-[3px]"
      style={{ background: hueFor(subject) }}
    />
  );
}

function Badge({ children, tone }: { children: string; tone?: "muted" | "warn" }) {
  return (
    <span
      className={cn(
        "rounded-[4px] border px-1.5 py-px text-[10.5px] font-medium uppercase tracking-[0.06em]",
        tone === "warn"
          ? "border-warn/40 text-warn"
          : "border-border text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

/**
 * The banner that stops a panic.
 *
 * Shown only when this account has no notes at all and another account on the
 * device does. It leads with where the notes are, not with what went wrong,
 * and the counts are real numbers read from the other database.
 */
function ElsewhereWarning({ accounts }: { accounts: ElsewhereAccount[] }) {
  const total = accounts.reduce((sum, a) => sum + (a.notes || 0), 0);
  return (
    <section className="mb-5 overflow-hidden rounded-lg border border-warn/40 bg-card">
      <div className="flex items-center justify-between gap-3 border-b border-warn/30 bg-warn/10 px-4 py-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.07em] text-warn">
          Your notes are under your other Google account
        </span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-warn">
          nothing deleted
        </span>
      </div>

      <div className="space-y-3 px-4 py-4">
        <p className="text-[13.5px] leading-relaxed">
          This account has no notes yet. Another Google account signed in on this
          device has{" "}
          <b className="font-mono tabular-nums">{plural(total, "note")}</b>{" "}
          waiting. <b>Nothing has been deleted.</b>
        </p>

        <div className="space-y-1.5">
          {accounts.map((a, i) => (
            <div
              key={a.hint || `account-${i}`}
              className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
            >
              <span className="min-w-0 truncate text-[13px]">
                {a.name || "Another Google account"}
                {a.hint ? (
                  <span className="ml-2 font-mono text-[11px] text-muted-foreground">
                    {a.hint}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 font-mono text-[12px] tabular-nums text-muted-foreground">
                {a.notes} notes · {a.documents} docs
              </span>
            </div>
          ))}
        </div>

        <p className="text-[13px] leading-relaxed text-muted-foreground">
          To get them back, go to <b className="text-foreground">Settings</b> →{" "}
          <b className="text-foreground">Account</b> →{" "}
          <b className="text-foreground">Sign out</b>, then sign back in with
          your other Google account. Every note and document will be there.
        </p>
      </div>
    </section>
  );
}

function NoteCard({
  note,
  onOpen,
}: {
  note: NoteRow;
  onOpen: (id: string) => void;
}) {
  const title = note.title || "Untitled";
  const subject = note.subject || "";
  const empty = (note.size || 0) <= 40;
  const stamp = when(note.updated_at);

  return (
    <button
      type="button"
      onClick={() => onOpen(note.id)}
      aria-label={`${title}, ${subject || "no subject"}`}
      className="w-full rounded-lg border bg-card px-4 py-3 text-left shadow-[0_1px_2px_rgba(20,20,26,0.04)] transition-[transform,box-shadow] duration-150 hover:-translate-y-px hover:shadow-[0_2px_4px_rgba(28,27,25,0.06),0_14px_34px_rgba(28,27,25,0.08)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <div className="flex items-start gap-3">
        <SubjectDot subject={subject} />

        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-medium">{title}</div>

          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground">
            <span className="truncate">{subject || "No subject"}</span>
            {note.topic ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="truncate">{note.topic}</span>
              </>
            ) : null}
            {empty ? <Badge tone="warn">empty</Badge> : null}
          </div>

          {note.preview && !empty ? (
            <p className="mt-1.5 truncate text-[12.5px] text-muted-foreground">
              {note.preview}
            </p>
          ) : null}
        </div>

        {stamp ? (
          <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-muted-foreground">
            {stamp}
          </span>
        ) : null}
      </div>
    </button>
  );
}

/* -------------------------------------------------------------------------
   The page
   ------------------------------------------------------------------------- */

export function NotesPage({
  state,
  subject = "",
  refresh,
  onOpenNote,
}: NotesPageProps) {
  /* The shared state is the normal path. This local copy exists so the page
     still works when it is mounted on its own — it never double-fetches when
     the app hands it state. */
  const [ownState, setOwnState] = useState<NotesState | null>(null);
  const [loading, setLoading] = useState(!state);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setOwnState(await apiGet<NotesState>("/api/state"));
      setError("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (state) {
      setLoading(false);
      return;
    }
    void load();
  }, [state, load]);

  const reload = useCallback(async () => {
    if (refresh) await Promise.resolve(refresh());
    else await load();
  }, [refresh, load]);

  const live = state ?? ownState;

  const allNotes = useMemo<NoteRow[]>(() => live?.notes ?? [], [live]);
  const tasks = useMemo<TaskRow[]>(() => live?.tasks ?? [], [live]);
  const notebooks = useMemo<NotebookRow[]>(() => live?.notebooks ?? [], [live]);
  const elsewhere = useMemo<ElsewhereAccount[]>(
    () => live?.elsewhere ?? [],
    [live],
  );

  const shown = useMemo(() => {
    const want = subject.trim().toLowerCase();
    if (!want) return allNotes;
    return allNotes.filter((n) => (n.subject || "").toLowerCase() === want);
  }, [allNotes, subject]);

  const open = useMemo(() => tasks.filter(isOpen), [tasks]);

  const overdue = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return open.filter((t) => t.due && t.due.slice(0, 10) < today).length;
  }, [open]);

  /* The server owns the definition of "next period" — this only reads it. */
  const upcoming = live?.timetable ?? null;
  const nextPeriod = upcoming?.next ?? null;
  const currentPeriod = upcoming?.current ?? null;

  const stats = useMemo<Stat[]>(
    () => [
      {
        label: "Notes",
        value: shown.length,
        sub: subject ? `in ${subject}` : "written",
      },
      {
        label: "Due",
        value: open.length,
        sub: overdue ? `${overdue} overdue` : "open",
        alert: overdue > 0,
      },
      {
        label: "Subjects",
        value: notebooks.length,
        sub: "notebooks",
      },
      {
        label: "Next lesson",
        value: nextPeriod ? nextPeriod.start : "—",
        sub: nextPeriod
          ? nextPeriod.subject.slice(0, 18)
          : currentPeriod
            ? `${currentPeriod.subject.slice(0, 11)} now`
            : "nothing left today",
      },
    ],
    [shown.length, subject, open.length, overdue, notebooks.length, nextPeriod, currentPeriod],
  );

  const openNote = useCallback(
    (id: string) => {
      if (onOpenNote) onOpenNote(id);
      else window.location.hash = `#/note/${id}`;
    },
    [onOpenNote],
  );

  const newNote = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const note = await apiPost<{ id: string }>("/api/note/new", {
        title: "",
        subject: subject.trim(),
      });
      await reload();
      if (note && note.id) openNote(note.id);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [subject, reload, openNote]);

  /* Empty account plus a populated one next door is the panic case. Judge it on
     every note in the account, never on the filtered view — a subject with no
     notes is not the same thing as an account with none. */
  const misplaced = allNotes.length === 0 && elsewhere.length > 0;

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-6">
      <header className="mb-5 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[19px] font-semibold tracking-tight">
            {subject || "Notes"}
          </h1>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            {loading && !live ? "Loading…" : plural(shown.length, "note")}
          </p>
        </div>

        <button
          type="button"
          onClick={() => void newNote()}
          disabled={busy}
          className="shrink-0 rounded-md bg-primary px-3 py-2 text-[13px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-55"
        >
          {busy ? "Making it…" : "New note"}
        </button>
      </header>

      <StatRow stats={stats} />

      <div className="mt-4">
        <VideoImport
          subject={subject}
          onDone={() => {
            void load();
            if (refresh) void Promise.resolve(refresh());
          }}
        />
      </div>

      {error ? (
        <p className="mb-5 border-l-2 border-l-late pl-3 text-[13px] text-late">
          {error}
        </p>
      ) : null}

      {misplaced ? <ElsewhereWarning accounts={elsewhere} /> : null}

      {shown.length ? (
        <div className="space-y-2">
          {shown.map((note) => (
            <NoteCard key={note.id} note={note} onOpen={openNote} />
          ))}
        </div>
      ) : (
        !loading &&
        !misplaced && (
          <div className="rounded-lg border bg-card px-4 py-8 text-center">
            <p className="text-[13.5px] font-medium">Nothing here yet.</p>
            <p className="mx-auto mt-1 max-w-[46ch] text-[13px] leading-relaxed text-muted-foreground">
              Make a note, then press record when class starts — or just type and
              press <b className="text-foreground">Write it up</b>.
            </p>
          </div>
        )
      )}
    </div>
  );
}

export default NotesPage;
