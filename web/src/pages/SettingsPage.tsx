/* ==========================================================================
   SettingsPage.tsx — who the student is, and what Minerva is allowed to read.

   Four things live here, in the order people look for them:
     Account        the Google account the notes are stored against, shown as
                    the STUDENT's photo, name and email — never the app's name.
                    With two Google accounts in play, the one thing that
                    matters is which account you are actually in.
     Profile        name, curriculum, grade, school, city, subjects. Subjects
                    were previously only settable during onboarding, which left
                    the subject picker on every task row stuck with whatever was
                    guessed on day one. They are editable here.
     School email   connect / disconnect, read-only, no password ever stored.
                    The connected state is checked against the server rather
                    than trusted from this tab: a token can be present but
                    expired, and "connected" that silently shows nothing is the
                    worst of both.
     ManageBac      the calendar link, tested before it is saved so nobody has
                    to paste it and hope.

   Everything saves through POST /api/profile, which merges — omitting
   timetable and goals is safe.
   ========================================================================== */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StatRow, type Stat } from "@/components/StatRow";
import { apiGet, apiPost } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

/* -------------------------------------------------------------------------
   Shapes
   ------------------------------------------------------------------------- */

export type Profile = {
  name?: string | null;
  curriculum?: string | null;
  grade?: string | null;
  school?: string | null;
  city?: string | null;
  subjects?: string[] | null;
  managebac_ics?: string | null;
};

export type EngineStatus = {
  ok?: boolean;
  model?: string | null;
  engine?: string | null;
  reason?: string | null;
};

export type TlsStatus = { relaxed_strict_x509?: boolean };

/** The slice of GET /api/state this page reads. */
export type SettingsState = {
  profile?: Profile | null;
  ai?: EngineStatus | null;
  stt?: EngineStatus | null;
  tls?: TlsStatus | null;
  managebac?: { configured?: boolean } | null;
};

export type SettingsPageProps = {
  /** Shared /api/state. Omit it and the page loads its own copy. */
  state?: SettingsState | null;
  /** Re-read the shared state after a save. */
  refresh?: () => void | Promise<void>;
};

/** POST /api/managebac/test answers 200 with ok:false on a bad link. */
type TestResult =
  | { ok: true; total: number; counts: Record<string, number>; sample: string[] }
  | { ok: false; error: string };

/** GET /api/notifications?days=1, read only for the email block. */
type MailProbe = {
  email?: { connected?: boolean; address?: string; error?: string } | null;
};

type Form = {
  name: string;
  curriculum: string;
  grade: string;
  school: string;
  city: string;
  subjects: string[];
  managebac_ics: string;
};

const EMPTY_FORM: Form = {
  name: "",
  curriculum: "",
  grade: "",
  school: "",
  city: "",
  subjects: [],
  managebac_ics: "",
};

function text(value: string | null | undefined): string {
  return typeof value === "string" ? value : "";
}

function formFrom(profile: Profile | null | undefined): Form {
  if (!profile) return EMPTY_FORM;
  return {
    name: text(profile.name),
    curriculum: text(profile.curriculum),
    grade: text(profile.grade),
    school: text(profile.school),
    city: text(profile.city),
    subjects: Array.isArray(profile.subjects) ? profile.subjects.slice() : [],
    managebac_ics: text(profile.managebac_ics),
  };
}

/* One subject, one colour, everywhere — the same hash the timetable uses. */
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

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* -------------------------------------------------------------------------
   Pieces
   ------------------------------------------------------------------------- */

const INPUT =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-[13.5px] " +
  "outline-none transition-colors placeholder:text-muted-foreground/70 " +
  "focus:border-ring focus:ring-2 focus:ring-ring/25";

const PRIMARY =
  "rounded-md bg-primary px-3 py-2 text-[13px] font-medium text-primary-foreground " +
  "transition-opacity hover:opacity-90 disabled:opacity-55";

const OUTLINE =
  "rounded-md border px-3 py-1.5 text-[13px] font-medium transition-colors " +
  "hover:bg-muted disabled:opacity-55";

const GHOST =
  "rounded-md px-2.5 py-1.5 text-[13px] text-muted-foreground transition-colors " +
  "hover:bg-muted hover:text-foreground disabled:opacity-55";

function Card({
  label,
  aside,
  children,
}: {
  label: string;
  aside?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border bg-card">
      <div className="flex items-center justify-between gap-3 border-b bg-muted/40 px-4 py-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
          {label}
        </span>
        {aside ? (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
            {aside}
          </span>
        ) : null}
      </div>
      <div className="px-4 py-4">{children}</div>
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
        {label}
      </span>
      <input
        className={INPUT}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function Help({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-2 text-[12.5px] leading-relaxed text-muted-foreground">
      {children}
    </p>
  );
}

/** A coloured dot in front of a status line. Colour is the only signal. */
function Dot({ tone }: { tone: "muted" | "ok" | "late" | "info" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "h-1.5 w-1.5 shrink-0 rounded-full",
        tone === "ok" && "bg-ok",
        tone === "late" && "bg-late",
        tone === "info" && "bg-info animate-pulse",
        tone === "muted" && "bg-muted-foreground/60",
      )}
    />
  );
}

/* -------------------------------------------------------------------------
   The page
   ------------------------------------------------------------------------- */

type BackupState = {
  verdict: string;
  message: string;
  local?: { notes: number; documents: number; tasks: number };
  cloud?: { saved?: number; failed?: number; last_error?: string };
};

export function SettingsPage({ state, refresh }: SettingsPageProps) {
  /* Whether the student's work actually survives losing this laptop. It was
     previously unknowable from inside the app: sync failures were swallowed,
     so a broken backup looked exactly like a working one. */
  const [backup, setBackup] = useState<BackupState | null>(null);
  const [probe, setProbe] = useState<{ ok: boolean; message: string; error?: string } | null>(null);
  const [probing, setProbing] = useState(false);

  /* A real round trip: write a document, read it back, delete it. Rules cannot
     be checked from outside — an unauthenticated probe is refused whether they
     are correct or still the locked default — so the only honest test runs as
     the signed-in student. */
  const testBackup = useCallback(async () => {
    setProbing(true);
    setProbe(null);
    try {
      const out = await apiPost<{ ok: boolean; message: string; error?: string }>(
        "/api/backup/test", {},
      );
      setProbe(out);
      apiGet<BackupState>("/api/backup").then(setBackup).catch(() => {});
    } catch (err) {
      setProbe({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setProbing(false);
    }
  }, []);
  useEffect(() => {
    let live = true;
    apiGet<BackupState>("/api/backup")
      .then((b) => live && setBackup(b))
      .catch(() => live && setBackup({ verdict: "unknown", message: "Could not check the backup." }));
    return () => {
      live = false;
    };
  }, []);

  const { user, signOut, mailToken, connectMail, forgetMail } = useAuth();

  const [ownState, setOwnState] = useState<SettingsState | null>(null);
  const [loadError, setLoadError] = useState("");

  const load = useCallback(async () => {
    try {
      setOwnState(await apiGet<SettingsState>("/api/state"));
      setLoadError("");
    } catch (err: unknown) {
      setLoadError(message(err));
    }
  }, []);

  useEffect(() => {
    if (state) return;
    void load();
  }, [state, load]);

  const live = state ?? ownState;
  const profile = live?.profile ?? null;

  /* ---------------------------------------------------------------- form */
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const filled = useRef(false);

  /* Fill once, from whichever copy of the profile arrives first. A later
     refresh must not overwrite half-typed fields — that is how a save lands on
     stale text without anybody noticing. */
  useEffect(() => {
    if (!profile || filled.current) return;
    filled.current = true;
    setForm(formFrom(profile));
  }, [profile]);

  const set = useCallback(<K extends keyof Form>(key: K, value: Form[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  const [newSubject, setNewSubject] = useState("");

  const addSubject = useCallback(() => {
    const wanted = newSubject.trim();
    if (!wanted) return;
    setForm((prev) =>
      prev.subjects.some((s) => s.toLowerCase() === wanted.toLowerCase())
        ? prev
        : { ...prev, subjects: [...prev.subjects, wanted] },
    );
    setNewSubject("");
  }, [newSubject]);

  const removeSubject = useCallback((subject: string) => {
    setForm((prev) => ({
      ...prev,
      subjects: prev.subjects.filter((s) => s !== subject),
    }));
  }, []);

  /* ---------------------------------------------------------------- save */
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");
  const [saveError, setSaveError] = useState("");

  const save = useCallback(async () => {
    setSaving(true);
    setSaved("");
    setSaveError("");
    try {
      await apiPost("/api/profile", {
        name: form.name.trim(),
        curriculum: form.curriculum.trim(),
        grade: form.grade.trim(),
        school: form.school.trim(),
        city: form.city.trim(),
        subjects: form.subjects,
        managebac_ics: form.managebac_ics.trim(),
      });
      setSaved("Saved.");
      if (refresh) await Promise.resolve(refresh());
      else await load();
    } catch (err: unknown) {
      setSaveError(message(err));
    } finally {
      setSaving(false);
    }
  }, [form, refresh, load]);

  /* --------------------------------------------------------- school mail */
  type MailLine = { tone: "muted" | "ok" | "late" | "info"; line: string };

  const [mailState, setMailState] = useState<MailLine>({
    tone: "muted",
    line: "Not connected.",
  });
  const [mailNote, setMailNote] = useState("");
  const [connecting, setConnecting] = useState(false);

  /* Ask the server, do not trust the token sitting in this tab: it can be
     present and expired, and a "connected" that silently shows nothing is the
     worst of both. `cancelled` lets the mount check drop its answer if the page
     went away while the request was in the air. */
  const checkMail = useCallback(
    async (cancelled?: { current: boolean }) => {
      const settle = (next: MailLine) => {
        if (!cancelled?.current) setMailState(next);
      };
      if (!mailToken) {
        settle({ tone: "muted", line: "Not connected." });
        return;
      }
      settle({ tone: "info", line: "Checking…" });
      try {
        const probe = await apiGet<MailProbe>("/api/notifications?days=1");
        const email = probe.email;
        if (email && email.connected) {
          settle({
            tone: "ok",
            line: `Connected — reading ${email.address || "your school inbox"} (read-only)`,
          });
        } else {
          settle({
            tone: "late",
            line: (email && email.error) || "Not connected.",
          });
        }
      } catch (err: unknown) {
        settle({ tone: "late", line: message(err) });
      }
    },
    [mailToken],
  );

  useEffect(() => {
    const cancelled = { current: false };
    void checkMail(cancelled);
    return () => {
      cancelled.current = true;
    };
  }, [checkMail]);

  const connect = useCallback(async () => {
    setConnecting(true);
    setMailNote("");
    try {
      const out = await connectMail();
      if (out.ok) {
        await checkMail();
        return;
      }
      if (out.cancelled) return;
      setMailState({ tone: "late", line: out.error || "Could not connect." });
    } finally {
      setConnecting(false);
    }
  }, [connectMail, checkMail]);

  /* Dropping the token re-runs the check above, which will write "Not
     connected." over any message set here — so the reassurance lives on its own
     line rather than fighting it. */
  const disconnect = useCallback(() => {
    forgetMail();
    setMailNote("Disconnected. Nothing was kept.");
  }, [forgetMail]);

  /* ------------------------------------------------------------ managebac */
  const [testing, setTesting] = useState(false);
  const [testLine, setTestLine] = useState<{ ok: boolean; line: string } | null>(
    null,
  );

  const testLink = useCallback(async () => {
    const url = form.managebac_ics.trim();
    if (!url) {
      setTestLine({ ok: false, line: "Paste the link first." });
      return;
    }
    setTesting(true);
    setTestLine(null);
    try {
      /* 200 with ok:false is a normal answer here, not an HTTP failure. */
      const out = await apiPost<TestResult>("/api/managebac/test", { url });
      if (!out.ok) {
        setTestLine({ ok: false, line: out.error });
        return;
      }
      const counts = Object.entries(out.counts || {})
        .map(([kind, n]) => `${n} ${kind}`)
        .join(", ");
      const sample = out.sample && out.sample.length ? ` e.g. ${out.sample[0]}` : "";
      setTestLine({
        ok: true,
        line: `Works — ${out.total} items${counts ? ` (${counts})` : ""}.${sample}`,
      });
    } catch (err: unknown) {
      setTestLine({ ok: false, line: message(err) });
    } finally {
      setTesting(false);
    }
  }, [form.managebac_ics]);

  /* -------------------------------------------------------------- account */
  const [photoBroken, setPhotoBroken] = useState(false);

  /* The student's identity, never the app's. Falls back down the chain to the
     saved profile name and then the email, so this row always answers "which
     account am I in" even before the profile has loaded. */
  const identity = useMemo(() => {
    const email = text(user?.email);
    const name =
      text(user?.displayName) ||
      form.name.trim() ||
      text(profile?.name) ||
      (email ? email.split("@")[0] : "");
    return {
      name: name || (user ? "Signed in" : "Not signed in"),
      email,
      photo: text(user?.photoURL),
      initial: (name.trim()[0] || "?").toUpperCase(),
    };
  }, [user, form.name, profile]);

  const doSignOut = useCallback(async () => {
    if (!window.confirm("Sign out on this device?")) return;
    try {
      /* signOut() drops the school-mail token first — leaving it behind would
         hand the next person at this laptop a live read handle on the inbox. */
      await signOut();
    } catch (err: unknown) {
      setSaveError(message(err));
    }
  }, [signOut]);

  /* ---------------------------------------------------------------- stats */
  const ai = live?.ai ?? null;
  const stt = live?.stt ?? null;
  const tls = live?.tls ?? null;
  const managebacLinked = Boolean(live?.managebac?.configured);

  const stats = useMemo<Stat[]>(
    () => [
      {
        label: "Brain",
        value: ai?.ok ? "ready" : "off",
        sub: ai?.ok ? text(ai.model).slice(0, 22) || "connected" : "not connected",
        alert: !ai?.ok,
      },
      {
        label: "Recording",
        value: stt?.ok ? "ready" : "off",
        sub: stt?.ok ? text(stt.engine).slice(0, 22) || "ready" : "not connected",
        alert: !stt?.ok,
      },
      {
        label: "ManageBac",
        value: managebacLinked ? "linked" : "not set",
        sub: managebacLinked ? "read-only" : "add the link below",
      },
      {
        label: "Subjects",
        value: form.subjects.length,
        sub: "on file",
      },
    ],
    [ai, stt, managebacLinked, form.subjects.length],
  );

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-6">
      <header className="mb-5">
        <h1 className="text-[19px] font-semibold tracking-tight">Settings</h1>
        <p className="mt-0.5 text-[12.5px] text-muted-foreground">
          Your details, your school email and the ManageBac link.
        </p>
      </header>

      <StatRow stats={stats} />

      {loadError ? (
        <p className="mb-5 border-l-2 border-l-late pl-3 text-[13px] text-late">
          {loadError}
        </p>
      ) : null}

      <div className="space-y-4">
        {/* ------------------------------------------------------- account */}
        <Card label="Account" aside={user ? "signed in" : "signed out"}>
          <div className="flex items-center gap-3 rounded-md border bg-muted/30 px-3 py-3">
            {identity.photo && !photoBroken ? (
              <img
                src={identity.photo}
                alt=""
                referrerPolicy="no-referrer"
                onError={() => setPhotoBroken(true)}
                className="h-9 w-9 shrink-0 rounded-full border object-cover"
              />
            ) : (
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border bg-card text-[13px] font-semibold">
                {identity.initial}
              </span>
            )}

            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px] font-medium">
                {identity.name}
              </div>
              <div className="truncate font-mono text-[12px] text-muted-foreground">
                {identity.email || "no email on this account"}
              </div>
            </div>

            <button type="button" className={OUTLINE} onClick={() => void doSignOut()}>
              Sign out
            </button>
          </div>

          <Help>
            Your notes are stored against this Google account and follow you to
            any device you sign in on. If a lesson looks missing, check you are
            in the right account here first — nothing is ever deleted by signing
            in somewhere else.
          </Help>
        </Card>

        {/* ------------------------------------------------------- profile */}
        <Card label="You">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Name"
              value={form.name}
              onChange={(v) => set("name", v)}
              placeholder="Your name"
            />
            <Field
              label="Curriculum"
              value={form.curriculum}
              onChange={(v) => set("curriculum", v)}
              placeholder="IB DP, IGCSE, A Level…"
            />
            <Field
              label="Grade"
              value={form.grade}
              onChange={(v) => set("grade", v)}
              placeholder="11"
            />
            <Field
              label="School"
              value={form.school}
              onChange={(v) => set("school", v)}
              placeholder="Your school"
            />
            <Field
              label="City"
              value={form.city}
              onChange={(v) => set("city", v)}
              placeholder="Where you are"
            />
          </div>
          <Help>
            Used to pitch notes at the right level — the curriculum and grade
            change how much a written-up lesson explains.
          </Help>
        </Card>

        {/* ------------------------------------------------------ subjects */}
        <Card label="Subjects" aside={`${form.subjects.length}`}>
          {form.subjects.length ? (
            <div className="flex flex-wrap gap-2">
              {form.subjects.map((subject) => (
                <span
                  key={subject}
                  className="inline-flex items-center gap-2 rounded-md border px-2 py-1 text-[12.5px]"
                >
                  <span
                    aria-hidden="true"
                    className="h-2.5 w-2.5 rounded-[3px]"
                    style={{ background: hueFor(subject) }}
                  />
                  {subject}
                  <button
                    type="button"
                    aria-label={`Remove ${subject}`}
                    onClick={() => removeSubject(subject)}
                    className="-mr-0.5 rounded px-1 text-[13px] leading-none text-muted-foreground transition-colors hover:bg-muted hover:text-late"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="text-[13px] text-muted-foreground">
              No subjects yet. Add them and every task can be filed under one.
            </p>
          )}

          <div className="mt-3 flex gap-2">
            <input
              className={INPUT}
              value={newSubject}
              placeholder="Add a subject"
              onChange={(e) => setNewSubject(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                addSubject();
              }}
            />
            <button
              type="button"
              className={OUTLINE}
              onClick={addSubject}
              disabled={!newSubject.trim()}
            >
              Add
            </button>
          </div>

          <Help>
            These fill the subject picker on every piece of homework, so a
            wrongly-guessed subject can always be corrected to one of yours.
          </Help>
        </Card>

        {/* ------------------------------------------------ cloud backup */}
        <Card label="Cloud backup">
          <div className="flex items-center gap-2">
            <Dot
              tone={
                backup?.verdict === "ok"
                  ? "ok"
                  : backup?.verdict === "failing" || backup?.verdict === "partial"
                    ? "late"
                    : "muted"
              }
            />
            <span className="text-[13px]">
              {backup ? backup.message : "Checking…"}
            </span>
          </div>
          {backup?.local ? (
            <p className="mt-1.5 font-mono text-[11.5px] tabular-nums text-muted-foreground">
              on this device: {backup.local.notes} notes · {backup.local.documents} documents ·{" "}
              {backup.local.tasks} tasks
              {backup.cloud?.saved ? ` · ${backup.cloud.saved} saved to cloud` : ""}
              {backup.cloud?.failed ? ` · ${backup.cloud.failed} failed` : ""}
            </p>
          ) : null}
          {backup?.cloud?.last_error ? (
            <p className="mt-1.5 break-words text-[12px] text-late">
              {backup.cloud.last_error}
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={testBackup}
              disabled={probing}
              className="btn-brand rounded-lg px-3 py-1.5 text-[13px] font-semibold disabled:opacity-60"
            >
              {probing ? "Testing…" : "Test cloud backup"}
            </button>
            {probe ? (
              <span className={cn("text-[12.5px]", probe.ok ? "text-ok" : "text-late")}>
                {probe.message}
              </span>
            ) : null}
          </div>
          {probe && !probe.ok && probe.error ? (
            <p className="mt-1.5 break-words font-mono text-[11.5px] text-late">
              {probe.error}
            </p>
          ) : null}
          <Help>
            Your notes live on this device and are mirrored to your Google
            account, so signing in anywhere brings them with you. If this says
            nothing is reaching the cloud, publish the rules in
            <b> firestore.rules</b> (Firebase console → Firestore → Rules) —
            until then Firestore rejects every write and only this device has
            your work.
          </Help>
        </Card>

        {/* -------------------------------------------------- school email */}
        <Card label="School email">
          <div className="flex items-center gap-2">
            <Dot tone={mailState.tone} />
            <span
              className={cn(
                "text-[13px]",
                mailState.tone === "ok" && "text-ok",
                mailState.tone === "late" && "text-late",
                (mailState.tone === "muted" || mailState.tone === "info") &&
                  "text-muted-foreground",
              )}
            >
              {mailState.line}
            </span>
          </div>

          {mailNote ? (
            <p className="mt-1.5 pl-3.5 text-[12.5px] text-muted-foreground">
              {mailNote}
            </p>
          ) : null}

          <Help>
            School mail sits beside your ManageBac work — assignments, replies
            and anything urgent, kept in separate lists.{" "}
            <b className="text-foreground">No password is stored, ever.</b> You
            sign in with Google and it grants read-only access, which you can
            take back at any time from your Google account. Minerva cannot send,
            reply to or delete anything.
          </Help>

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              className={OUTLINE}
              onClick={() => void connect()}
              disabled={connecting || !user}
            >
              {connecting ? "Waiting for Google…" : "Connect school email"}
            </button>
            {mailToken ? (
              <button type="button" className={GHOST} onClick={disconnect}>
                Disconnect
              </button>
            ) : null}
          </div>
        </Card>

        {/* ----------------------------------------------------- managebac */}
        <Card
          label="ManageBac calendar link"
          aside={managebacLinked ? "linked" : "not linked"}
        >
          <input
            className={cn(INPUT, "font-mono text-[12.5px]")}
            value={form.managebac_ics}
            placeholder="webcal://… or https://…ics"
            onChange={(e) => set("managebac_ics", e.target.value)}
          />

          <Help>
            <b className="text-foreground">In ManageBac:</b> My Workspace →{" "}
            <b className="text-foreground">Subscribe to Calendar</b>. A small box
            appears with a long link in it — that link is what I need. Select it,
            copy it, paste it here. If the box shows a{" "}
            <i>Subscribe</i> button instead of text, right-click that button and
            choose <b className="text-foreground">Copy link address</b>.
            <br />
            Read-only: nothing in ManageBac can ever be changed from here.
          </Help>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              className={OUTLINE}
              onClick={() => void testLink()}
              disabled={testing}
            >
              {testing ? "Checking…" : "Test this link"}
            </button>
            {testLine ? (
              <span
                className={cn(
                  "text-[12.5px]",
                  testLine.ok ? "text-ok" : "text-late",
                )}
              >
                {testLine.line}
              </span>
            ) : null}
          </div>
        </Card>

        {/* ---------------------------------------------------------- save */}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className={PRIMARY}
            onClick={() => void save()}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          {saved ? (
            <span className="text-[12.5px] text-ok">{saved}</span>
          ) : null}
          {saveError ? (
            <span className="text-[12.5px] text-late">{saveError}</span>
          ) : null}
        </div>

        {/* -------------------------------------------------------- status */}
        <Card label="Status">
          <ul className="space-y-2 text-[13px]">
            <li className="flex items-start gap-2">
              <Dot tone={ai?.ok ? "ok" : "late"} />
              <span className="text-muted-foreground">
                Brain:{" "}
                {ai?.ok ? (
                  <>
                    connected ·{" "}
                    <span className="font-mono text-foreground">
                      {text(ai.model)}
                    </span>
                  </>
                ) : (
                  <b className="text-foreground">
                    {text(ai?.reason) || "not connected"}
                  </b>
                )}
              </span>
            </li>
            <li className="flex items-start gap-2">
              <Dot tone={stt?.ok ? "ok" : "late"} />
              <span className="text-muted-foreground">
                Recording:{" "}
                {stt?.ok ? (
                  <>
                    ready ·{" "}
                    <span className="font-mono text-foreground">
                      {text(stt.engine)}
                    </span>
                  </>
                ) : (
                  <b className="text-foreground">
                    {text(stt?.reason) || "not ready"}
                  </b>
                )}
              </span>
            </li>
            {tls?.relaxed_strict_x509 ? (
              <li className="flex items-start gap-2">
                <Dot tone="info" />
                <span className="text-muted-foreground">
                  TLS: inspection detected on this network; certificates are
                  still verified.
                </span>
              </li>
            ) : null}
          </ul>
        </Card>
      </div>
    </div>
  );
}

export default SettingsPage;
