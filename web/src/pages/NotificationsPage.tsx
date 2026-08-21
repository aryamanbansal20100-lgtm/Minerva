/* ==========================================================================
   NotificationsPage.tsx — one place for everything that wants your attention.

   The complaint about ManageBac was never that it lacks notifications. It is
   that an assignment due tomorrow, a graded discussion comment and a school
   newsletter all land in the same clamped pile, so the one that matters looks
   exactly like the two that do not.

   The old screen split by stream only, which meant a teacher's email and a
   ManageBac task sat in the same block with a small grey badge as the only
   clue where each came from. Those are different things: one you answer, one
   you hand in. So the split is by SOURCE first — ManageBac, then school email,
   as two visually separate sections — and by stream inside each, with anything
   urgent lifted to the top of its own section.

   The server sorts urgency into `streams.urgent` across both sources, so this
   screen re-splits that bucket by source rather than re-deriving urgency. The
   server owns that definition.

   School email is read-only and password-free. Its failures are told apart on
   the server — "the Gmail API is not switched on for this app yet" is my bug,
   "your school has blocked outside apps" is not — so those sentences are
   printed here word for word. Collapsing them into "could not connect" is the
   difference between a two-minute fix and a pointless trip to school IT.
   ========================================================================== */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { apiGet } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { StatRow } from "@/components/StatRow";
import { cn } from "@/lib/utils";
import { Panel, Pill } from "@/pages/DuePage";

/* ------------------------------------------------------------------ types */

type StreamKey = "urgent" | "assignment" | "discussion" | "admin" | "other";
type SourceKey = "managebac" | "email";

type NotifItem = {
  id: string;
  source: SourceKey;
  from: string;
  subject: string;
  snippet: string;
  stream: string;
  band?: string;
  urgent: boolean;
  at: string | null;
  unread: boolean;
  url: string;
};

type NotifPayload = {
  streams: Record<StreamKey, NotifItem[]>;
  counts: Record<StreamKey, number>;
  unread: number;
  email: { connected: boolean; address: string; error: string };
  managebac: { configured: boolean };
};

export type NotificationsPageProps = {
  /** Where Settings lives, for the "connect ManageBac" pointer. */
  onOpenSettings?: () => void;
};

/* ---------------------------------------------------------------- constants */

const STREAM_ORDER: StreamKey[] = [
  "urgent",
  "assignment",
  "discussion",
  "admin",
  "other",
];

const STREAM_TITLES: Record<StreamKey, string> = {
  urgent: "Needs you now",
  assignment: "Assignments",
  discussion: "Discussions",
  admin: "School admin",
  other: "Everything else",
};

const SOURCE_TITLES: Record<SourceKey, string> = {
  managebac: "ManageBac",
  email: "School email",
};

const EMPTY: NotifPayload = {
  streams: { urgent: [], assignment: [], discussion: [], admin: [], other: [] },
  counts: { urgent: 0, assignment: 0, discussion: 0, admin: 0, other: 0 },
  unread: 0,
  email: { connected: false, address: "", error: "" },
  managebac: { configured: false },
};

/* ---------------------------------------------------------------- helpers */

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Today → clock time, yesterday → "yesterday", this week → "3d ago". */
function when(at: string | null | undefined): string {
  if (!at) return "";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days === 0) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (days === 1) return "yesterday";
  if (days > 0 && days < 7) return `${days}d ago`;
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

type Block = { key: StreamKey; title: string; items: NotifItem[] };

/**
 * Re-split the server's stream buckets by source, keeping the bucket a message
 * landed in as its group. Reading `item.stream` instead would quietly undo the
 * server's urgency lift — an overdue assignment would drop back in with the
 * ordinary ones, which is the exact failure this screen exists to prevent.
 */
function blocksBySource(
  streams: Record<StreamKey, NotifItem[]>,
): Record<SourceKey, Block[]> {
  const held: Record<SourceKey, Map<StreamKey, NotifItem[]>> = {
    managebac: new Map(),
    email: new Map(),
  };
  for (const key of STREAM_ORDER) {
    for (const item of streams[key] || []) {
      const source: SourceKey = item.source === "email" ? "email" : "managebac";
      const bucket = held[source].get(key);
      if (bucket) bucket.push(item);
      else held[source].set(key, [item]);
    }
  }
  const shape = (source: SourceKey): Block[] =>
    STREAM_ORDER.filter((key) => (held[source].get(key) || []).length).map(
      (key) => ({
        key,
        title: STREAM_TITLES[key],
        items: held[source].get(key) as NotifItem[],
      }),
    );
  return { managebac: shape("managebac"), email: shape("email") };
}

/* ------------------------------------------------------------- primitives */

function Callout({
  tone,
  title,
  children,
}: {
  tone: "info" | "warn" | "ok";
  title: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border border-l-2 bg-card shadow-[0_1px_2px_rgba(20,20,26,0.04)]",
        tone === "warn" && "border-l-warn",
        tone === "ok" && "border-l-ok",
        tone === "info" && "border-l-info",
      )}
    >
      <div className="border-b px-3.5 py-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
          {title}
        </span>
      </div>
      <div className="space-y-2.5 px-3.5 py-3.5 text-[12.5px] text-muted-foreground">
        {children}
      </div>
    </div>
  );
}

function NotifRow({ item, urgent, quiet }: {
  item: NotifItem;
  urgent: boolean;
  quiet: boolean;
}) {
  const title = item.subject || "(no subject)";
  const band = item.band && item.band !== "past" ? item.band : "";
  const stamp = when(item.at);

  return (
    <li
      className={cn(
        "relative flex items-start gap-2.5 border-t px-3.5 py-2.5 transition-colors first:border-t-0 hover:bg-muted/40",
        quiet && "opacity-70",
      )}
    >
      <span
        aria-hidden="true"
        className="absolute left-0 top-0 h-full w-[2px]"
        style={{ background: urgent ? "var(--late)" : "transparent" }}
      />
      <span className="min-w-0 flex-1">
        {item.url ? (
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="block truncate text-[13.5px] font-medium underline-offset-2 hover:underline"
          >
            {title}
            <span aria-hidden="true" className="ml-1 text-[11px] text-muted-foreground">
              ↗
            </span>
          </a>
        ) : (
          <span className="block truncate text-[13.5px] font-medium">{title}</span>
        )}

        <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted-foreground">
          {item.from && <span className="truncate max-w-[220px]">{item.from}</span>}
          {band && (
            <Pill tone={band === "overdue" || band === "today" ? "late" : "soon"}>
              {band.replace("_", " ")}
            </Pill>
          )}
          {item.unread && <Pill tone="new">new</Pill>}
          {stamp && <span className="font-mono tabular-nums">{stamp}</span>}
        </span>

        {item.snippet && (
          <span className="mt-1 block truncate text-[11.5px] text-muted-foreground">
            {item.snippet.slice(0, 180)}
          </span>
        )}
      </span>
    </li>
  );
}

/* -------------------------------------------------------------- the page */

export default function NotificationsPage({
  onOpenSettings,
}: NotificationsPageProps) {
  const { mail } = useAuth();

  const [data, setData] = useState<NotifPayload>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState("");
  const [connected, setConnected] = useState("");

  const load = useCallback(async () => {
    setChecking(true);
    try {
      const got = await apiGet<NotifPayload>("/api/notifications");
      setData({ ...EMPTY, ...got });
      setError("");
    } catch (err: unknown) {
      setError(messageOf(err));
    } finally {
      setChecking(false);
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const blocks = useMemo(() => blocksBySource(data.streams), [data.streams]);

  const totals = useMemo(() => {
    const count = (source: SourceKey) =>
      blocks[source].reduce((sum, b) => sum + b.items.length, 0);
    const urgent = STREAM_ORDER.includes("urgent")
      ? (data.streams.urgent || []).length
      : 0;
    return {
      managebac: count("managebac"),
      email: count("email"),
      urgent,
      all: count("managebac") + count("email"),
    };
  }, [blocks, data.streams]);

  /* --------------------------------------------------------- mail actions */

  const connectMail = useCallback(async () => {
    setConnecting(true);
    setConnectError("");
    setConnected("");
    try {
      const out = await mail.connect();
      if (out.cancelled) return;
      if (!out.ok) {
        /* Verbatim — auth.tsx writes a full explanation here, including the
           account-switch guard's whole paragraph. */
        setConnectError(out.error || "could not connect");
        return;
      }
      setConnected("School email connected — read-only.");
      await load();
    } finally {
      setConnecting(false);
    }
  }, [mail, load]);

  const disconnectMail = useCallback(async () => {
    mail.forget();
    setConnectError("");
    setConnected("School email disconnected. Nothing was kept.");
    await load();
  }, [mail, load]);

  /* -------------------------------------------------------------- render */

  const cards = [
    {
      k: "Needs you now",
      v: String(totals.urgent),
      s: totals.urgent ? "across both" : "nothing pressing",
      alert: totals.urgent > 0,
    },
    { k: "ManageBac", v: String(totals.managebac), s: data.managebac.configured ? "items" : "not linked" },
    {
      k: "Email",
      v: String(totals.email),
      s: data.email.connected ? "in your inbox" : "not connected",
    },
    { k: "Unread", v: String(data.unread), s: "not opened yet" },
  ];

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-6">
      <header className="mb-5 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-[17px] font-semibold tracking-tight">
            Notifications
          </h1>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            ManageBac and school email, kept apart
          </p>
        </div>
        <button
          type="button"
          disabled={checking}
          onClick={() => void load()}
          className="h-8 shrink-0 rounded-md border px-2.5 text-[12.5px] transition-colors hover:bg-muted disabled:opacity-60"
        >
          {checking ? "Checking…" : "Refresh"}
        </button>
      </header>

      <StatRow cards={cards} />

      {error && (
        <div className="mb-4 rounded-lg border border-l-2 border-l-late bg-card px-4 py-3">
          <p className="text-[13px] text-late">{error}</p>
        </div>
      )}

      {connected && (
        <div className="mb-4 rounded-lg border border-l-2 border-l-ok bg-card px-4 py-3">
          <p className="text-[13px]">{connected}</p>
        </div>
      )}

      {!loaded ? (
        <p className="text-[13px] text-muted-foreground">Loading…</p>
      ) : (
        <div className="space-y-10">
          {/* ================================================== ManageBac */}
          <SourceSection
            source="managebac"
            total={totals.managebac}
            caption="Assignments, exams and school admin from your ManageBac calendar"
          >
            {!data.managebac.configured && (
              <Callout tone="info" title="ManageBac is not connected">
                <p>
                  Add your ManageBac calendar link in Settings and assignments
                  will appear here.
                </p>
                {onOpenSettings && (
                  <p>
                    <button
                      type="button"
                      onClick={onOpenSettings}
                      className="h-8 rounded-md border px-2.5 text-[12.5px] text-foreground transition-colors hover:bg-muted"
                    >
                      Open Settings
                    </button>
                  </p>
                )}
              </Callout>
            )}

            {blocks.managebac.length ? (
              blocks.managebac.map((block) => (
                <Panel
                  key={block.key}
                  title={block.title}
                  count={block.items.length}
                >
                  <ul>
                    {block.items.map((item) => (
                      <NotifRow
                        key={`${item.source}-${item.id}`}
                        item={item}
                        urgent={block.key === "urgent"}
                        quiet={block.key === "other"}
                      />
                    ))}
                  </ul>
                </Panel>
              ))
            ) : (
              data.managebac.configured && (
                <p className="text-[13px] text-muted-foreground">
                  Nothing from ManageBac.
                </p>
              )
            )}
          </SourceSection>

          {/* ====================================================== Email */}
          <SourceSection
            source="email"
            total={totals.email}
            caption="Read-only. Minerva cannot send, reply to or delete anything."
          >
            {data.email.connected ? (
              <Callout tone="ok" title={`Reading ${data.email.address}`}>
                <p>
                  Read-only. Minerva cannot send, reply to or delete anything, and
                  you can revoke this at any time from your Google account.
                </p>
                <p>
                  <button
                    type="button"
                    onClick={() => void disconnectMail()}
                    className="h-8 rounded-md border px-2.5 text-[12.5px] text-foreground transition-colors hover:bg-muted"
                  >
                    Disconnect
                  </button>
                </p>
              </Callout>
            ) : (
              <Callout
                tone={data.email.error || connectError ? "warn" : "info"}
                title={
                  data.email.error
                    ? "School email needs reconnecting"
                    : "Add your school email"
                }
              >
                {/* Word for word from the server. It already distinguishes a
                    Gmail API that is switched off from a school that has
                    blocked outside apps, and those need opposite actions. */}
                {data.email.error && (
                  <p className="text-warn">{data.email.error}</p>
                )}
                {connectError && <p className="text-late">{connectError}</p>}
                {!data.email.error && !connectError && (
                  <p>
                    Sign in with your school Google account and Minerva can show
                    school mail here alongside ManageBac.{" "}
                    <span className="text-foreground">
                      No password is stored
                    </span>{" "}
                    — Google grants read-only access which you can revoke any
                    time from your Google account.
                  </p>
                )}
                <p>
                  <button
                    type="button"
                    disabled={connecting}
                    onClick={() => void connectMail()}
                    className="h-8 rounded-md bg-primary px-3 text-[12.5px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
                  >
                    {connecting ? "Waiting for Google…" : "Connect school email"}
                  </button>
                </p>
              </Callout>
            )}

            {blocks.email.length
              ? blocks.email.map((block) => (
                  <Panel
                    key={block.key}
                    title={block.title}
                    count={block.items.length}
                  >
                    <ul>
                      {block.items.map((item) => (
                        <NotifRow
                          key={`${item.source}-${item.id}`}
                          item={item}
                          urgent={block.key === "urgent"}
                          quiet={block.key === "other"}
                        />
                      ))}
                    </ul>
                  </Panel>
                ))
              : data.email.connected && (
                  <p className="text-[13px] text-muted-foreground">
                    Nothing in the inbox from the last two weeks.
                  </p>
                )}
          </SourceSection>

          {totals.all === 0 && !error && (
            <p className="text-[13px] text-muted-foreground">
              Nothing waiting.
              {data.email.connected
                ? ""
                : " Connect your school email to see mail here too."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** The source split, made unmissable: a ruled heading over its own stack. */
function SourceSection({
  source,
  total,
  caption,
  children,
}: {
  source: SourceKey;
  total: number;
  caption: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-b pb-2">
        <span
          aria-hidden="true"
          className="size-2.5 translate-y-px rounded-[3px]"
          style={{
            background: source === "email" ? "var(--info)" : "var(--warn)",
          }}
        />
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.07em]">
          {SOURCE_TITLES[source]}
        </h2>
        <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
          {total}
        </span>
        <span className="ml-auto text-[11.5px] text-muted-foreground">
          {caption}
        </span>
      </div>
      {children}
    </section>
  );
}
