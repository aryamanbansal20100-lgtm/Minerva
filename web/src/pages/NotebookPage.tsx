/* ==========================================================================
   NotebookPage.tsx — one subject, three tabs.

     Notes        every lesson recorded or written for this subject
     Documents    files you put here — worksheets, briefs, past papers
     Assignments  what is due in this subject, open and done

   Documents are uploads, not ManageBac pulls. The ManageBac calendar feed
   carries SUMMARY, DTSTART, DTEND and UID and no attachment field at all, and
   the files behind it need a school-admin token a student cannot mint. So it
   is drag-and-drop, and PDFs get their text pulled out so Ask can read them.

   Two details here are load-bearing and easy to lose in a port:

   1. A stored file is opened by FETCHING it and handing the browser a blob,
      never by navigating to /api/document. A plain <a href> does not carry the
      Firebase token, so the server answers 401 and the browser cheerfully
      saves that JSON error under the file's name. The bytes were always fine;
      the download was not.

   2. Rename and Delete show the server's refusal word for word. "that notebook
      still holds 3 notes, 2 documents. Move or delete those first." already
      says exactly what to do — replacing it with "Could not delete" throws
      away the only useful part.
   ========================================================================== */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiBlob, apiGet, apiPost, apiPostRaw } from "@/lib/api";
import { StatRow } from "@/components/StatRow";
import { cn } from "@/lib/utils";
import { Panel, Pill, SubjectDot, TaskRow, bandOf, hueFor } from "@/pages/DuePage";
import type { Task } from "@/pages/DuePage";

/* ------------------------------------------------------------------ types */

type NotebookNote = {
  id: string;
  title: string;
  subject: string;
  topic: string;
  continues: boolean;
  created_at: string;
  updated_at: string;
  preview?: string;
};

type StoredDocument = {
  id: string;
  subject: string;
  name: string;
  mime: string;
  size: number;
  source: string;
  created_at: string;
  chars: number;
};

type NotebookView = {
  subject: string;
  notes: NotebookNote[];
  documents: StoredDocument[];
  assignments: Task[];
};

type RenameResult = {
  title: string;
  moved?: { notes?: number; documents?: number; tasks?: number };
};

type FromDocumentsResult = {
  notes?: { id: string; title?: string }[];
  count?: number;
  used?: string[];
  skipped?: string[];
  warning?: string;
};

type TabKey = "notes" | "documents" | "assignments";

export type NotebookPageProps = {
  /** Which notebook. Falls back to the #/book/<subject> hash. */
  subject?: string;
  /** Subject list for the assignment picker, i.e. profile.subjects. */
  subjects?: string[];
  onOpenNote?: (noteId: string) => void;
  /** Where to go after a rename — the notebook now lives under a new name. */
  onOpenSubject?: (subject: string) => void;
  /** Where to go after the notebook is deleted. */
  onLeave?: () => void;
  /** Lets a parent store re-read /api/state after a write. */
  onChanged?: () => void | Promise<void>;
};

/* ---------------------------------------------------------------- helpers */

/* What a single file may weigh. Textbooks and scanned ebooks routinely run to
   hundreds of megabytes, and the old 20 MB ceiling rejected essentially every
   real one. Files are sent in slices now rather than base64'd whole into a
   JSON body, so a big one costs the server one slice of memory instead of
   roughly 2.3x the file. */
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;

/* Anything above this is sliced. Below it the old single-shot path is fine and
   saves a round trip. */
const CHUNK_THRESHOLD = 6 * 1024 * 1024;
const CHUNK_BYTES = 4 * 1024 * 1024;

/* Send one file as a sequence of raw slices, then ask the server to finish it.
   onProgress reports 0..1 so a 200 MB book does not look frozen. */
async function uploadInSlices(
  file: File,
  subject: string,
  onProgress: (fraction: number) => void,
): Promise<{ note?: string }> {
  const uploadId =
    Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const total = Math.ceil(file.size / CHUNK_BYTES);

  for (let i = 0; i < total; i++) {
    const slice = file.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
    await apiPostRaw("/api/document/chunk", slice, {
      "Content-Type": "application/octet-stream",
      "X-Upload": uploadId,
      "X-Chunk": String(i),
    });
    onProgress((i + 1) / total);
  }

  return await apiPost("/api/document/finish", {
    upload_id: uploadId,
    name: file.name,
    mime: file.type,
    subject,
  });
}

const ACCEPT =
  ".pdf,.txt,.md,.png,.jpg,.jpeg,.webp,.doc,.docx,.ppt,.pptx";

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Today → clock time, yesterday → "yesterday", this week → "3d ago". */
function when(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days === 0) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

function subjectFromHash(): string {
  const hash = typeof window === "undefined" ? "" : window.location.hash;
  const at = hash.indexOf("/book/");
  if (at < 0) return "";
  try {
    return decodeURIComponent(hash.slice(at + 6));
  } catch {
    return hash.slice(at + 6);
  }
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("could not read the file"));
    reader.readAsDataURL(file);
  });
}

/* ------------------------------------------------------------- the notice */

type Notice = { tone: "ok" | "bad"; text: string };

function NoticeStrip({
  notice,
  onDismiss,
}: {
  notice: Notice;
  onDismiss: () => void;
}) {
  return (
    <div
      className={cn(
        "mb-4 flex items-start gap-3 rounded-lg border border-l-2 bg-card px-4 py-3",
        notice.tone === "bad" ? "border-l-late" : "border-l-ok",
      )}
    >
      <p
        className={cn(
          "min-w-0 flex-1 text-[13px]",
          notice.tone === "bad" ? "text-late" : "text-foreground",
        )}
      >
        {notice.text}
      </p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded-md border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted"
      >
        Dismiss
      </button>
    </div>
  );
}

/* -------------------------------------------------------------- the page */

export default function NotebookPage({
  subject: subjectProp,
  subjects,
  onOpenNote,
  onOpenSubject,
  onLeave,
  onChanged,
}: NotebookPageProps) {
  const subject = subjectProp ?? subjectFromHash();

  const [tab, setTab] = useState<TabKey>("notes");
  const [data, setData] = useState<NotebookView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);

  /* Notebook-level actions. Both are destructive enough to deserve a real
     panel rather than a browser prompt(). */
  const [panel, setPanel] = useState<"" | "rename" | "delete">("");
  const [wantedName, setWantedName] = useState(subject);
  const [panelError, setPanelError] = useState("");
  const [panelBusy, setPanelBusy] = useState(false);

  /* Documents. */
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState<{
    name: string;
    done: number;
    total: number;
  } | null>(null);
  const [opening, setOpening] = useState("");
  const [deletingDoc, setDeletingDoc] = useState("");
  const [writingNotes, setWritingNotes] = useState(false);

  /* Assignments. */
  const [busyTask, setBusyTask] = useState("");

  const load = useCallback(async () => {
    if (!subject) {
      setLoading(false);
      setLoadError("No subject given. Open a notebook from the sidebar.");
      return;
    }
    try {
      const view = await apiGet<NotebookView>(
        `/api/notebook?subject=${encodeURIComponent(subject)}`,
      );
      setData(view);
      setLoadError("");
    } catch (err: unknown) {
      setLoadError(messageOf(err));
    } finally {
      setLoading(false);
    }
  }, [subject]);

  useEffect(() => {
    setLoading(true);
    setData(null);
    setNotice(null);
    setPanel("");
    setWantedName(subject);
    void load();
  }, [subject, load]);

  const notes = data?.notes || [];
  const documents = data?.documents || [];
  const assignments = data?.assignments || [];
  const open = useMemo(() => assignments.filter((a) => !a.done), [assignments]);
  const done = useMemo(() => assignments.filter((a) => a.done), [assignments]);
  const overdue = useMemo(
    () => open.filter((a) => bandOf(a.due).label.endsWith("overdue")).length,
    [open],
  );

  /* ---------------------------------------------------------- new note */

  const newNote = useCallback(async () => {
    try {
      const note = await apiPost<{ id: string }>("/api/note/new", {
        title: "",
        subject,
      });
      if (onChanged) await onChanged();
      if (onOpenNote) onOpenNote(note.id);
      else window.location.hash = `#/note/${note.id}`;
    } catch (err: unknown) {
      setNotice({ tone: "bad", text: messageOf(err) });
    }
  }, [subject, onChanged, onOpenNote]);

  /* ------------------------------------------------- rename and delete */

  const rename = useCallback(async () => {
    const wanted = wantedName.trim();
    if (!wanted || wanted === subject) {
      setPanel("");
      return;
    }
    setPanelBusy(true);
    setPanelError("");
    try {
      const out = await apiPost<RenameResult>("/api/notebook/rename", {
        old: subject,
        new: wanted,
      });
      const moved = out.moved || {};
      const carried = (
        [
          [moved.notes, "note"],
          [moved.documents, "document"],
          [moved.tasks, "task"],
        ] as [number | undefined, string][]
      )
        .filter(([n]) => !!n)
        .map(([n, word]) => `${n} ${word}${n === 1 ? "" : "s"}`);
      setPanel("");
      setNotice({
        tone: "ok",
        text:
          `Renamed to ${out.title}` +
          (carried.length ? ` — ${carried.join(", ")} moved with it.` : "."),
      });
      if (onChanged) await onChanged();
      if (onOpenSubject) onOpenSubject(out.title);
      else window.location.hash = `#/book/${encodeURIComponent(out.title)}`;
    } catch (err: unknown) {
      /* Verbatim. The server already says "you already have a notebook called
         'Physics'. Rename that one first, or pick a different name." */
      setPanelError(messageOf(err));
    } finally {
      setPanelBusy(false);
    }
  }, [wantedName, subject, onChanged, onOpenSubject]);

  const removeNotebook = useCallback(async () => {
    setPanelBusy(true);
    setPanelError("");
    try {
      await apiPost("/api/notebook/delete", { title: subject });
      setPanel("");
      if (onChanged) await onChanged();
      if (onLeave) onLeave();
      else window.location.hash = "#/notes";
    } catch (err: unknown) {
      setPanelError(messageOf(err));
    } finally {
      setPanelBusy(false);
    }
  }, [subject, onChanged, onLeave]);

  /* ------------------------------------------------------------ uploads */

  const upload = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      let added = 0;
      const failures: string[] = [];
      for (const file of files) {
        if (file.size > MAX_UPLOAD_BYTES) {
          failures.push(
            `${file.name} is ${(file.size / 1024 / 1024).toFixed(0)} MB — the limit is 300 MB.`,
          );
          continue;
        }
        setUploading({ name: file.name, done: added, total: files.length });
        try {
          if (file.size > CHUNK_THRESHOLD) {
            const out = await uploadInSlices(file, subject, (fraction) =>
              setUploading({
                name: `${file.name} · ${Math.round(fraction * 100)}%`,
                done: added,
                total: files.length,
              }),
            );
            // The server drops the original above its keep-limit and says so.
            // Surfacing that is the difference between a student knowing the
            // text was saved and believing the whole file is still there.
            if (out?.note) failures.push(`${file.name}: ${out.note}`);
          } else {
            const dataUrl = await readAsDataUrl(file);
            await apiPost("/api/document/upload", {
              subject,
              name: file.name,
              data: dataUrl,
            });
          }
          added++;
        } catch (err: unknown) {
          failures.push(`${file.name}: ${messageOf(err)}`);
        }
      }
      setUploading(null);
      if (failures.length) {
        setNotice({ tone: "bad", text: failures.join(" ") });
      } else if (added) {
        setNotice({
          tone: "ok",
          text: `${added} document${added === 1 ? "" : "s"} added.`,
        });
      }
      await load();
      if (onChanged) await onChanged();
    },
    [subject, load, onChanged],
  );

  const deleteDocument = useCallback(
    async (doc: StoredDocument) => {
      setDeletingDoc(doc.id);
      try {
        await apiPost("/api/document/delete", { id: doc.id });
        setNotice({ tone: "ok", text: `Deleted ${doc.name}.` });
        await load();
        if (onChanged) await onChanged();
      } catch (err: unknown) {
        setNotice({ tone: "bad", text: messageOf(err) });
      } finally {
        setDeletingDoc("");
      }
    },
    [load, onChanged],
  );

  /**
   * Open a stored file.
   *
   * Fetch it with the token attached, then hand the browser the real bytes
   * through an object URL. Revoke late — revoking straight away kills the tab
   * that has only just started reading it.
   */
  const openDocument = useCallback(async (doc: StoredDocument) => {
    setOpening(doc.id);
    try {
      const blob = await apiBlob(
        `/api/document?id=${encodeURIComponent(doc.id)}`,
      );
      if (!blob.size) throw new Error("that file is empty on disk");
      const url = URL.createObjectURL(blob);
      const win = window.open(url, "_blank", "noopener");
      if (!win) {
        /* Popup blocked. A real download link click always gets through. */
        const link = document.createElement("a");
        link.href = url;
        link.download = doc.name || "file";
        document.body.appendChild(link);
        link.click();
        link.remove();
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err: unknown) {
      setNotice({ tone: "bad", text: messageOf(err) });
    } finally {
      setOpening("");
    }
  }, []);

  const makeNotes = useCallback(async () => {
    setWritingNotes(true);
    try {
      const out = await apiPost<FromDocumentsResult>(
        "/api/notes/from-documents",
        { subject },
      );
      const skipped =
        out.skipped && out.skipped.length
          ? ` Skipped (no readable text): ${out.skipped.slice(0, 3).join(", ")}.`
          : "";
      const notes = out.notes || [];
      const used = out.used ? out.used.length : 0;
      // The files are now split into SEPARATE, coherent notes — so report the
      // count of notes AND the files they came from, and land the student on
      // the Notes tab where the new notes are waiting rather than dropping them
      // into just one of them.
      setNotice({
        tone: out.warning ? "bad" : "ok",
        text:
          (out.warning
            ? out.warning
            : `Created ${notes.length} note${notes.length === 1 ? "" : "s"} ` +
              `from ${used} file${used === 1 ? "" : "s"}.`) + skipped,
      });
      if (onChanged) await onChanged();
      setTab("notes");
    } catch (err: unknown) {
      setNotice({ tone: "bad", text: messageOf(err) });
    } finally {
      setWritingNotes(false);
    }
  }, [subject, onChanged]);

  /* --------------------------------------------------------- assignments */

  const markDone = useCallback(
    async (task: Task) => {
      setBusyTask(task.id);
      try {
        await apiPost("/api/task/done", { id: task.id, done: true });
        await load();
        if (onChanged) await onChanged();
      } catch (err: unknown) {
        setNotice({ tone: "bad", text: messageOf(err) });
      } finally {
        setBusyTask("");
      }
    },
    [load, onChanged],
  );

  const moveSubject = useCallback(
    async (task: Task, next: string) => {
      setBusyTask(task.id);
      try {
        await apiPost("/api/task/subject", { id: task.id, subject: next });
        setNotice({
          tone: "ok",
          text: next ? `Moved to ${next}.` : "Unfiled.",
        });
        await load();
        if (onChanged) await onChanged();
      } catch (err: unknown) {
        setNotice({ tone: "bad", text: messageOf(err) });
      } finally {
        setBusyTask("");
      }
    },
    [load, onChanged],
  );

  /* -------------------------------------------------------------- render */

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-5xl px-6 py-6">
        <p className="text-[13px] text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="mx-auto w-full max-w-5xl px-6 py-6">
        <p className="text-[13px] text-muted-foreground">{loadError}</p>
      </div>
    );
  }

  const tabs: { key: TabKey; label: string; count: number }[] = [
    { key: "notes", label: "Notes", count: notes.length },
    { key: "documents", label: "Documents", count: documents.length },
    { key: "assignments", label: "Assignments", count: open.length },
  ];

  const cards = [
    { k: "Notes", v: String(notes.length), s: "in this notebook" },
    { k: "Documents", v: String(documents.length), s: "files stored" },
    {
      k: "Open",
      v: String(open.length),
      s: open.length === 1 ? "assignment" : "assignments",
    },
    {
      k: "Overdue",
      v: String(overdue),
      s: overdue ? "past the date" : "nothing missed",
      alert: overdue > 0,
    },
  ];

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-6">
      {/* ------------------------------------------------------- topbar */}
      <header className="mb-5 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="size-2.5 shrink-0 rounded-[3px]"
              style={{ background: hueFor(subject) }}
            />
            <h1 className="truncate text-[17px] font-semibold tracking-tight">
              {data?.subject || subject}
            </h1>
          </div>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            <span className="font-mono tabular-nums">{notes.length}</span> notes ·{" "}
            <span className="font-mono tabular-nums">{documents.length}</span>{" "}
            documents ·{" "}
            <span className="font-mono tabular-nums">{open.length}</span> open
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setPanelError("");
              setWantedName(subject);
              setPanel(panel === "rename" ? "" : "rename");
            }}
            className="h-8 rounded-md border px-2.5 text-[12.5px] transition-colors hover:bg-muted"
          >
            Rename
          </button>
          <button
            type="button"
            onClick={() => {
              setPanelError("");
              setPanel(panel === "delete" ? "" : "delete");
            }}
            className="h-8 rounded-md border px-2.5 text-[12.5px] transition-colors hover:bg-muted"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={() => void newNote()}
            className="h-8 rounded-md bg-primary px-3 text-[12.5px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            New note
          </button>
        </div>
      </header>

      <StatRow cards={cards} />

      {notice && (
        <NoticeStrip notice={notice} onDismiss={() => setNotice(null)} />
      )}

      {/* ------------------------------------------- rename / delete panel */}
      {panel === "rename" && (
        <Panel title="Rename notebook" className="mb-4">
          <div className="space-y-3 px-3.5 py-3.5">
            <p className="text-[12.5px] text-muted-foreground">
              The notes, documents and assignments filed under{" "}
              <span className="text-foreground">{subject}</span> move with it.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={wantedName}
                autoFocus
                onChange={(e) => setWantedName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void rename();
                  if (e.key === "Escape") setPanel("");
                }}
                aria-label="New notebook name"
                className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <button
                type="button"
                disabled={panelBusy || !wantedName.trim()}
                onClick={() => void rename()}
                className="h-8 rounded-md bg-primary px-3 text-[12.5px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {panelBusy ? "Renaming…" : "Rename"}
              </button>
              <button
                type="button"
                onClick={() => setPanel("")}
                className="h-8 rounded-md border px-2.5 text-[12.5px] transition-colors hover:bg-muted"
              >
                Cancel
              </button>
            </div>
            {panelError && <p className="text-[12.5px] text-late">{panelError}</p>}
          </div>
        </Panel>
      )}

      {panel === "delete" && (
        <Panel title="Delete notebook" className="mb-4">
          <div className="space-y-3 px-3.5 py-3.5">
            <p className="text-[12.5px] text-muted-foreground">
              A notebook can only be deleted once it is empty — Minerva refuses
              while anything is still filed under it, and says what is left.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={panelBusy}
                onClick={() => void removeNotebook()}
                className="h-8 rounded-md border border-late/45 px-3 text-[12.5px] font-medium text-late transition-colors hover:bg-late/10 disabled:opacity-50"
              >
                {panelBusy ? "Deleting…" : `Delete ${subject}`}
              </button>
              <button
                type="button"
                onClick={() => setPanel("")}
                className="h-8 rounded-md border px-2.5 text-[12.5px] transition-colors hover:bg-muted"
              >
                Cancel
              </button>
            </div>
            {panelError && <p className="text-[12.5px] text-late">{panelError}</p>}
          </div>
        </Panel>
      )}

      {/* ---------------------------------------------------------- tabs */}
      <div role="tablist" aria-label="Notebook sections" className="mb-4 flex items-center gap-1 border-b">
        {tabs.map((t) => {
          const on = tab === t.key;
          return (
            <button
              key={t.key}
              role="tab"
              type="button"
              aria-selected={on}
              onClick={() => setTab(t.key)}
              className={cn(
                "-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-[13px] transition-colors",
                on
                  ? "border-foreground font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
              <span
                className={cn(
                  "rounded border px-1.5 py-px font-mono text-[10.5px] tabular-nums",
                  on
                    ? "border-foreground/30 text-foreground"
                    : "border-border text-muted-foreground",
                )}
              >
                {t.count}
              </span>
            </button>
          );
        })}
      </div>

      {/* --------------------------------------------------------- notes */}
      {tab === "notes" &&
        (notes.length ? (
          <Panel title="Notes" count={notes.length}>
            <ul>
              {notes.map((n) => (
                <li
                  key={n.id}
                  className="flex items-start gap-2.5 border-t px-3.5 py-2.5 transition-colors first:border-t-0 hover:bg-muted/40"
                >
                  <SubjectDot subject={n.subject || subject} />
                  <span className="min-w-0 flex-1">
                    <a
                      href={`#/note/${n.id}`}
                      onClick={(e) => {
                        if (onOpenNote) {
                          e.preventDefault();
                          onOpenNote(n.id);
                        }
                      }}
                      className="block truncate text-[13.5px] font-medium underline-offset-2 hover:underline"
                    >
                      {n.title || "Untitled"}
                    </a>
                    <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted-foreground">
                      <span>{n.topic || "no topic"}</span>
                      <span className="font-mono tabular-nums">
                        {when(n.updated_at)}
                      </span>
                      {n.continues && <Pill tone="soon">left mid-topic</Pill>}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        ) : (
          <p className="text-[13px] text-muted-foreground">
            No notes in {subject} yet. Make one and press record when the lesson
            starts.
          </p>
        ))}

      {/* ----------------------------------------------------- documents */}
      {tab === "documents" && (
        <div className="space-y-4">
          <div
            role="button"
            tabIndex={0}
            aria-label="Upload documents for this subject"
            onClick={() => fileInput.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                fileInput.current?.click();
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              void upload(Array.from(e.dataTransfer.files));
            }}
            className={cn(
              "cursor-pointer rounded-lg border-2 border-dashed px-5 py-8 text-center transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
              dragOver
                ? "border-foreground/40 bg-muted/60"
                : "border-input hover:border-foreground/30 hover:bg-muted/30",
            )}
          >
            {uploading ? (
              <>
                <span className="block truncate text-[13.5px] font-semibold">
                  Uploading {uploading.name}…
                </span>
                <span className="mt-1 block font-mono text-[12px] tabular-nums text-muted-foreground">
                  {uploading.done}/{uploading.total} done
                </span>
              </>
            ) : (
              <>
                <span className="block text-[13.5px] font-semibold">
                  Drop worksheets, briefs or past papers here
                </span>
                <span className="mt-1 block text-[12.5px] text-muted-foreground">
                  PDFs get read so you can ask questions about them. Up to 20 MB
                  each.
                </span>
              </>
            )}
          </div>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={ACCEPT}
            className="sr-only"
            onChange={(e) => {
              const picked = Array.from(e.target.files || []);
              e.target.value = "";
              void upload(picked);
            }}
          />

          {documents.length > 0 && (
            <button
              type="button"
              disabled={writingNotes}
              onClick={() => void makeNotes()}
              className="h-8 rounded-md bg-primary px-3 text-[12.5px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {writingNotes
                ? "Reading the files and writing notes…"
                : "Make notes from these files"}
            </button>
          )}

          {documents.length ? (
            <Panel title="Files" count={documents.length}>
              <ul>
                {documents.map((f) => (
                  <li
                    key={f.id}
                    className="flex items-start gap-2.5 border-t px-3.5 py-2.5 transition-colors first:border-t-0 hover:bg-muted/40"
                  >
                    <span className="min-w-0 flex-1">
                      <button
                        type="button"
                        disabled={opening === f.id}
                        onClick={() => void openDocument(f)}
                        className="block max-w-full truncate text-left text-[13.5px] font-medium underline-offset-2 hover:underline disabled:opacity-60"
                      >
                        {opening === f.id ? "Opening…" : f.name}
                        {opening !== f.id && (
                          <span
                            aria-hidden="true"
                            className="ml-1 text-[11px] text-muted-foreground"
                          >
                            ↗
                          </span>
                        )}
                      </button>
                      <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted-foreground">
                        <span className="font-mono tabular-nums">
                          {(f.size / 1024).toFixed(0)} KB
                        </span>
                        <span className="font-mono tabular-nums">
                          {when(f.created_at)}
                        </span>
                        {f.chars > 40 ? (
                          <Pill tone="new">readable</Pill>
                        ) : (
                          <Pill>not searchable</Pill>
                        )}
                      </span>
                    </span>
                    <button
                      type="button"
                      disabled={deletingDoc === f.id}
                      onClick={() => void deleteDocument(f)}
                      aria-label={`Delete ${f.name}`}
                      className="h-7 shrink-0 rounded-md border px-2 text-[11.5px] transition-colors hover:bg-muted disabled:opacity-50"
                    >
                      {deletingDoc === f.id ? "Deleting…" : "Delete"}
                    </button>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : (
            <p className="text-[13px] text-muted-foreground">
              No documents yet.
            </p>
          )}
        </div>
      )}

      {/* --------------------------------------------------- assignments */}
      {tab === "assignments" &&
        (open.length || done.length ? (
          <div className="space-y-4">
            {open.length ? (
              <Panel title="Open" count={open.length}>
                <ul>
                  {open.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      subjects={subjects || (subject ? [subject] : [])}
                      busy={busyTask === task.id}
                      onDone={markDone}
                      onSubject={moveSubject}
                      onOpenNote={onOpenNote}
                    />
                  ))}
                </ul>
              </Panel>
            ) : (
              <p className="text-[13px] text-muted-foreground">Nothing open.</p>
            )}

            {done.length > 0 && (
              <Panel title="Done" count={done.length}>
                <ul>
                  {done.map((task) => (
                    <li
                      key={task.id}
                      className="flex items-start gap-2.5 border-t px-3.5 py-2.5 opacity-55 first:border-t-0"
                    >
                      <SubjectDot subject={task.subject} />
                      <span className="min-w-0 flex-1 truncate text-[13.5px] line-through">
                        {task.title}
                      </span>
                    </li>
                  ))}
                </ul>
              </Panel>
            )}
          </div>
        ) : (
          <p className="text-[13px] text-muted-foreground">
            Nothing due in {subject}. Assignments arrive from ManageBac and from
            lessons you record.
          </p>
        ))}
    </div>
  );
}
