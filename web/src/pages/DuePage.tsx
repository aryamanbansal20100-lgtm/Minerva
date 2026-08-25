/* ==========================================================================
   DuePage.tsx — every open task, grouped by how soon it bites.

   The old /due screen opened with four unlabelled panels and a red strip. It
   answered "what is there" but not "how bad is it", which is the only question
   anyone opens this page to ask. So it now opens the way the Timetable page
   does: a row of hard numbers first, with the overdue card turning red, then
   the work itself in bordered panels with quiet header bars.

   Data: /api/state owns the task list, so a parent that already holds it can
   pass `tasks` in and this screen never fetches. Given nothing, it loads its
   own copy — a page that only works when someone else remembered to feed it is
   a page that breaks the first time it is routed to directly.
   ========================================================================== */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { StatRow } from "@/components/StatRow";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ types */

export type Task = {
  id: string;
  title: string;
  detail?: string;
  subject?: string;
  kind?: string;
  due?: string | null;
  source?: string;
  source_ref?: string;
  done?: 0 | 1 | boolean;
  note_id?: string;
  url?: string;
  seen?: 0 | 1;
  created_at?: string;
  updated_at?: string;
};

type StatePayload = {
  profile?: { subjects?: string[] };
  tasks?: Task[];
};

export type DuePageProps = {
  /** Tasks from /api/state. Omit and the page loads its own. */
  tasks?: Task[];
  /** Subject list for the picker, i.e. profile.subjects. */
  subjects?: string[];
  /** Called after a write, so a parent store can refresh itself. */
  onChanged?: () => void | Promise<void>;
  /** Open a note in the host app instead of following the hash link. */
  onOpenNote?: (noteId: string) => void;
};

/* ---------------------------------------------------------------- helpers */

type BandKey = "late" | "soon" | "";
type Band = { k: BandKey; label: string };

/** Local calendar day, not UTC — "today" has to mean the student's today. */
function daysFromToday(due: string): number {
  const [y, m, d] = due.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return Number.NaN;
  const target = new Date(y, m - 1, d).getTime();
  const now = new Date();
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((target - base) / 86400000);
}

/** The client urgency band. Deliberately not the server's vocabulary. */
export function bandOf(due: string | null | undefined): Band {
  if (!due) return { k: "", label: "no date" };
  const days = daysFromToday(due);
  if (Number.isNaN(days)) return { k: "", label: "no date" };
  if (days < 0) return { k: "late", label: `${-days}d overdue` };
  if (days === 0) return { k: "late", label: "today" };
  if (days === 1) return { k: "soon", label: "tomorrow" };
  if (days <= 7) return { k: "soon", label: `in ${days}d` };
  return { k: "", label: `in ${days}d` };
}

const SUBJECT_HUES = new Map<string, string>();

/* A stable colour per subject. Urgency owns red and amber; this is a different
   job — making a list scannable — so it uses hue, never alarm. */
export function hueFor(subject: string | undefined): string {
  if (!subject) return "var(--border)";
  const held = SUBJECT_HUES.get(subject);
  if (held) return held;
  let h = 0;
  for (let i = 0; i < subject.length; i++) {
    h = (h * 31 + subject.charCodeAt(i)) % 360;
  }
  const colour = `hsl(${h} 52% 45%)`;
  SUBJECT_HUES.set(subject, colour);
  return colour;
}

function barColour(k: BandKey): string {
  if (k === "late") return "var(--late)";
  if (k === "soon") return "var(--warn)";
  return "var(--border)";
}

/* ------------------------------------------------------------- primitives */

export function Pill({
  tone = "",
  children,
}: {
  tone?: BandKey | "new" | "calm" | "ok";
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-px text-[10.5px] leading-[1.5]",
        tone === "late" && "border-late/45 text-late",
        tone === "soon" && "border-warn/50 text-warn",
        tone === "new" && "border-info/45 text-info",
        tone === "ok" && "border-ok/45 text-ok",
        (tone === "" || tone === "calm") && "border-border text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

export function SubjectDot({ subject }: { subject?: string }) {
  return (
    <span
      aria-hidden="true"
      className="mt-[5px] size-2.5 shrink-0 rounded-[3px]"
      style={{ background: hueFor(subject) }}
    />
  );
}

/** A bordered card with the quiet header bar the Timetable columns use. */
export function Panel({
  title,
  count,
  children,
  className,
}: {
  title: string;
  count?: number;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "overflow-hidden rounded-lg border bg-card shadow-[0_1px_2px_rgba(20,20,26,0.04)]",
        className,
      )}
    >
      <header className="flex items-center gap-2 border-b px-3.5 py-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
          {title}
        </span>
        {count !== undefined && (
          <span className="ml-auto font-mono text-[11px] tabular-nums text-muted-foreground">
            {count}
          </span>
        )}
      </header>
      {children}
    </section>
  );
}

/* -------------------------------------------------------------- task rows */

export function TaskRow({
  task,
  subjects,
  busy,
  onDone,
  onSubject,
  onOpenNote,
}: {
  task: Task;
  subjects: string[];
  busy: boolean;
  onDone: (task: Task) => void;
  onSubject: (task: Task, subject: string) => void;
  onOpenNote?: (noteId: string) => void;
}) {
  const band = bandOf(task.due);
  const external = !!task.url;
  const href = task.url || (task.note_id ? `#/note/${task.note_id}` : "");
  const label = `${task.title}${task.subject ? `, ${task.subject}` : ""}, ${band.label}`;

  const title = href ? (
    <a
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
      aria-label={
        external ? `${label}, opens ManageBac in a new tab` : label
      }
      onClick={(e) => {
        if (!external && task.note_id && onOpenNote) {
          e.preventDefault();
          onOpenNote(task.note_id);
        }
      }}
      className="text-[13.5px] font-medium underline-offset-2 hover:underline"
    >
      {task.title}
      {external && (
        <span aria-hidden="true" className="ml-1 text-[11px] text-muted-foreground">
          ↗
        </span>
      )}
    </a>
  ) : (
    <span className="text-[13.5px] font-medium">{task.title}</span>
  );

  return (
    <li className="relative flex items-start gap-2.5 border-t px-3.5 py-2.5 transition-colors first:border-t-0 hover:bg-muted/40">
      <span
        aria-hidden="true"
        className="absolute left-0 top-0 h-full w-[2px]"
        style={{ background: barColour(band.k) }}
      />
      <SubjectDot subject={task.subject} />

      <span className="min-w-0 flex-1">
        <span className="block truncate">{title}</span>
        <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted-foreground">
          {task.subject && <span>{task.subject}</span>}
          <Pill tone={band.k}>{band.label}</Pill>
          {task.kind && <Pill>{task.kind}</Pill>}
          {task.source === "managebac" && <Pill tone="calm">ManageBac</Pill>}
          {task.seen === 0 && <Pill tone="new">new</Pill>}
        </span>
      </span>

      {/* The student always overrules the AI's subject guess, so the control
          stays visible rather than hiding behind a menu. */}
      <span className="flex shrink-0 items-center gap-1.5">
        <select
          value={task.subject || ""}
          disabled={busy}
          aria-label={`Subject for ${task.title}`}
          onChange={(e) => onSubject(task, e.target.value)}
          className="h-7 max-w-[132px] rounded-md border bg-background px-1.5 text-[11.5px] text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <option value="">Unfiled</option>
          {subjects.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={busy}
          onClick={() => onDone(task)}
          aria-label={`Mark done: ${task.title}`}
          className="h-7 rounded-md border px-2 text-[11.5px] transition-colors hover:bg-muted disabled:opacity-50"
        >
          Done
        </button>
      </span>
    </li>
  );
}

/* -------------------------------------------------------------- the page */

export default function DuePage({
  tasks,
  subjects,
  onChanged,
  onOpenNote,
}: DuePageProps) {
  const managed = tasks === undefined;

  const [own, setOwn] = useState<Task[]>([]);
  const [ownSubjects, setOwnSubjects] = useState<string[]>([]);
  const [loading, setLoading] = useState(managed);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string>("");

  const load = useCallback(async () => {
    try {
      const state = await apiGet<StatePayload>("/api/state");
      setOwn((state.tasks || []).filter((t) => !t.done));
      setOwnSubjects(state.profile?.subjects || []);
      setError("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!managed) return;
    void load();
  }, [managed, load]);

  const rows = useMemo(
    () => (managed ? own : (tasks || []).filter((t) => !t.done)),
    [managed, own, tasks],
  );
  const pickList = subjects ?? ownSubjects;

  /** Re-read whichever source owns the list. */
  const reload = useCallback(async () => {
    if (managed) await load();
    if (onChanged) await onChanged();
  }, [managed, load, onChanged]);

  const markDone = useCallback(
    async (task: Task) => {
      setBusy(task.id);
      /* Optimistic: the row goes now. A tick of lag on the one interaction
         that is meant to feel like crossing something out is the whole
         difference between a list you keep using and one you abandon. */
      setOwn((list) => list.filter((t) => t.id !== task.id));
      try {
        await apiPost("/api/task/done", { id: task.id, done: true });
        setError("");
        await reload();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
        if (managed) await load();
      } finally {
        setBusy("");
      }
    },
    [reload, managed, load],
  );

  const moveSubject = useCallback(
    async (task: Task, subject: string) => {
      setBusy(task.id);
      setOwn((list) =>
        list.map((t) => (t.id === task.id ? { ...t, subject } : t)),
      );
      try {
        await apiPost("/api/task/subject", { id: task.id, subject });
        setError("");
        await reload();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
        if (managed) await load();
      } finally {
        setBusy("");
      }
    },
    [reload, managed, load],
  );

  /* ------------------------------------------------------------- grouping */

  const groups = useMemo(() => {
    const late: Task[] = [];
    const now: Task[] = [];
    const week: Task[] = [];
    const later: Task[] = [];
    for (const t of rows) {
      const band = bandOf(t.due);
      if (!t.due || band.k === "") later.push(t);
      else if (band.label.endsWith("overdue")) late.push(t);
      else if (band.label === "today" || band.label === "tomorrow") now.push(t);
      else week.push(t);
    }
    return [
      { name: "Overdue", rows: late },
      { name: "Today & tomorrow", rows: now },
      { name: "This week", rows: week },
      { name: "Later & undated", rows: later },
    ];
  }, [rows]);

  const overdue = groups[0].rows.length;
  const dueToday = rows.filter((t) => bandOf(t.due).label === "today").length;
  const thisWeek = groups[2].rows.length;

  const cards = [
    { k: "Open", v: String(rows.length), s: rows.length === 1 ? "task" : "tasks" },
    {
      k: "Overdue",
      v: String(overdue),
      s: overdue ? "past the date" : "nothing missed",
      alert: overdue > 0,
    },
    { k: "Due today", v: String(dueToday), s: "hand in today" },
    { k: "This week", v: String(thisWeek), s: "next 7 days" },
  ];

  const shown = groups.filter((g) => g.rows.length);

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-6">
      <header className="mb-5 flex items-baseline gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-[17px] font-semibold tracking-tight">Due</h1>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            <span className="font-mono tabular-nums">{rows.length}</span> open ·
            everything with a deadline, soonest first
          </p>
        </div>
      </header>

      <StatRow cards={cards} />

      {error && (
        <div className="mb-4 rounded-lg border border-l-2 border-l-late bg-card px-4 py-3">
          <p className="text-[13px] text-late">{error}</p>
        </div>
      )}

      {loading ? (
        <p className="text-[13px] text-muted-foreground">Loading…</p>
      ) : shown.length ? (
        <div className="space-y-4">
          {shown.map((group) => (
            <Panel key={group.name} title={group.name} count={group.rows.length}>
              <ul>
                {group.rows.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    subjects={pickList}
                    busy={busy === task.id}
                    onDone={markDone}
                    onSubject={moveSubject}
                    onOpenNote={onOpenNote}
                  />
                ))}
              </ul>
            </Panel>
          ))}
        </div>
      ) : (
        <p className="text-[13px] text-muted-foreground">
          Nothing due. Genuinely nothing.
        </p>
      )}
    </div>
  );
}
