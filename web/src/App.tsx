import { useCallback, useEffect, useMemo, useState } from "react"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import { useAuth, identityOf } from "@/lib/auth"
import { NotesPage } from "@/pages/NotesPage"
import NotePage from "@/pages/NotePage"
import SharedNotePage from "@/pages/SharedNotePage"
import { TimetablePage } from "@/pages/TimetablePage"
import { CalendarPage } from "@/pages/CalendarPage"
import DuePage from "@/pages/DuePage"
import NotificationsPage from "@/pages/NotificationsPage"
import NotebookPage from "@/pages/NotebookPage"
import { SettingsPage } from "@/pages/SettingsPage"
import AssessmentsPage from "@/pages/AssessmentsPage"
import PracticePage from "@/pages/PracticePage"
import StudyNudge from "@/components/StudyNudge"
import AskDock from "@/components/AskDock"
import MinervaMark from "@/components/MinervaMark"
import Onboarding from "@/components/Onboarding"
import ErrorBoundary from "@/components/ErrorBoundary"

/* The shell: a fixed sidebar and a scrolling pane, with the student's identity
   at the top — never the app's name. Routing is by hash, so there is no extra
   dependency and a refresh keeps you on the same screen.

   /api/state is loaded once here and handed down; every page also accepts no
   props and self-loads, so nothing breaks if a page is opened cold. */

type State = {
  profile?: { subjects?: string[]; onboarded?: boolean; name?: string; tuition_subjects?: string[] }
  notebooks?: { id: string; title: string; notes: number }[]
  notes?: unknown[]
  tasks?: { done?: boolean; due?: string | null }[]
  elsewhere?: unknown[]
}

type Route =
  | { name: "notes" }
  | { name: "note"; id: string }
  | { name: "shared"; token: string }
  | { name: "book"; subject: string }
  | { name: "assessments" }
  | { name: "practice"; subject?: string }
  | { name: "timetable" }
  | { name: "tuition" }
  | { name: "calendar" }
  | { name: "due" }
  | { name: "notifications" }
  | { name: "settings" }

function parseHash(): Route {
  const h = window.location.hash.replace(/^#\/?/, "")
  const [head, ...rest] = h.split("/")
  const arg = decodeURIComponent(rest.join("/") || "")
  switch (head) {
    case "note":
      return { name: "note", id: arg }
    case "shared":
      return { name: "shared", token: arg }
    case "book":
      return { name: "book", subject: arg }
    case "assessments":
      return { name: "assessments" }
    case "practice":
      // "#/practice/Economics" deep-links straight into a subject.
      return { name: "practice", subject: arg || undefined }
    case "timetable":
      return { name: "timetable" }
    case "tuition":
      return { name: "tuition" }
    case "calendar":
      return { name: "calendar" }
    case "due":
      return { name: "due" }
    case "notifications":
      return { name: "notifications" }
    case "settings":
      return { name: "settings" }
    default:
      return { name: "notes" }
  }
}

const go = (hash: string) => {
  window.location.hash = hash
}

/* A time-of-day greeting. Small, but it is the difference between an app that
   addresses the student and one that files them. */
function greeting(): string {
  const h = new Date().getHours()
  if (h < 5) return "Still up?"
  if (h < 12) return "Good morning"
  if (h < 17) return "Good afternoon"
  if (h < 21) return "Good evening"
  return "Working late"
}

const NAV: { label: string; hash: string; match: Route["name"] }[] = [
  { label: "Notes", hash: "#/notes", match: "notes" },
  { label: "Tuition", hash: "#/tuition", match: "tuition" },
  { label: "Timetable", hash: "#/timetable", match: "timetable" },
  { label: "Calendar", hash: "#/calendar", match: "calendar" },
  { label: "Due", hash: "#/due", match: "due" },
  { label: "FAs & Tests", hash: "#/assessments", match: "assessments" },
  { label: "Practice", hash: "#/practice", match: "practice" },
  { label: "Notifications", hash: "#/notifications", match: "notifications" },
  { label: "Settings", hash: "#/settings", match: "settings" },
]

export default function App() {
  const { user, signOut } = useAuth()
  const [accountMenu, setAccountMenu] = useState(false)
  /* On a phone the sidebar is a drawer, not a column. 236px of fixed navigation
     on a 375px screen leaves nothing for the notes themselves. */
  const [navOpen, setNavOpen] = useState(false)
  const [route, setRoute] = useState<Route>(parseHash())
  const [state, setState] = useState<State | null>(null)

  useEffect(() => {
    const onHash = () => {
      setRoute(parseHash())
      setNavOpen(false)
    }
    window.addEventListener("hashchange", onHash)
    return () => window.removeEventListener("hashchange", onHash)
  }, [])

  /* Remember, on THIS browser, that it has the app. A shared link's landing
     page reads this flag: set, it forwards the visitor straight into Minerva;
     unset, it leaves them on the web page with the Word download. App only ever
     renders for a signed-in student, so reaching here is proof enough. */
  useEffect(() => {
    try {
      localStorage.setItem("minerva.seen", "1")
    } catch {
      /* private mode: the link simply shows its web page, which is fine */
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      setState(await api.get<State>("/api/state"))
    } catch {
      /* a 401 is handled by the sign-in gate; anything else the pages surface */
    }
  }, [])

  /* Keep the shell live too.

     The sidebar counts, the Due badge and the nudge all come from /api/state,
     which was fetched once at load. Leave the app open through a lesson and
     everything it tells you is from whenever you opened it. Same rule as the
     notifications page: refresh on a timer, refresh the moment the tab comes
     back to the front, and go quiet while it is hidden. */
  useEffect(() => {
    refresh()

    let timer: ReturnType<typeof setInterval> | null = null
    const start = () => {
      if (timer) return
      timer = setInterval(() => {
        if (document.visibilityState === "visible") refresh()
      }, 60000)
    }
    const stop = () => {
      if (timer) clearInterval(timer)
      timer = null
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        refresh()
        start()
      } else {
        stop()
      }
    }

    start()
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("focus", onVisible)
    return () => {
      stop()
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("focus", onVisible)
    }
  }, [refresh])

  const newNotebook = useCallback(async () => {
    const name = window.prompt("Name the new notebook (e.g. a subject):")
    const title = (name || "").trim()
    if (!title) return
    try {
      await api.post("/api/notebook", { title })
      await refresh()
      go("#/book/" + encodeURIComponent(title))
    } catch (e) {
      window.alert((e as Error).message)
    }
  }, [refresh])

  const id = useMemo(() => identityOf(user), [user])
  const openTop =
    route.name === "note" || route.name === "book" || route.name === "shared"
      ? "notes"
      : route.name
  const openTasks = (state?.tasks || []).filter((t) => !t.done).length

  /* First run: a signed-in account that has never been set up has no subjects
     to organise anything around. Show the setup form instead of a blank app.

     The localStorage guard is what stops the questionnaire coming back. The
     free host wipes its disk on every redeploy, which resets the server profile
     to onboarded=0 -- so without this, the form popped again after every deploy
     even for someone who set up weeks ago. Once a browser has seen setup
     completed, it never shows it again, whatever the server says. A genuinely
     new browser has no flag and still gets it. */
  useEffect(() => {
    if (state?.profile?.onboarded) {
      try {
        localStorage.setItem("minerva.onboarded", "1")
      } catch {
        /* private mode; the server flag still guards it */
      }
    }
  }, [state?.profile?.onboarded])

  let seenSetup = false
  try {
    seenSetup = localStorage.getItem("minerva.onboarded") === "1"
  } catch {
    /* no localStorage: fall back to the server flags below */
  }

  const needsSetup =
    !!state &&
    !seenSetup &&
    !state.profile?.onboarded &&
    !(state.profile?.subjects && state.profile.subjects.length > 0)

  /* A shared link is the one screen that must work before setup: a friend who
     just signed in to read a note you sent should see the note, not a
     questionnaire. They can set Minerva up afterwards. */
  if (needsSetup && route.name !== "shared") {
    return (
      <Onboarding
        initialName={state?.profile?.name || user?.displayName || ""}
        onDone={refresh}
      />
    )
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      {/* Backdrop. Only exists on a phone, and only while the drawer is open. */}
      {navOpen ? (
        <button
          aria-label="Close menu"
          onClick={() => setNavOpen(false)}
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
        />
      ) : null}

      <aside
        className={cn(
          "flex w-[236px] shrink-0 flex-col border-r bg-muted/25",
          // Phone: slide over the content, above the backdrop.
          "fixed inset-y-0 left-0 z-40 transition-transform duration-200 ease-out",
          navOpen ? "translate-x-0 shadow-2xl" : "-translate-x-full",
          // Desktop: back to being an ordinary column that is always there.
          "md:static md:z-auto md:translate-x-0 md:shadow-none",
        )}
      >
        <div className="relative border-b">
          <button
            onClick={() => setAccountMenu((v) => !v)}
            className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-card/60"
            aria-haspopup="menu"
            aria-expanded={accountMenu}
          >
            {id.photo ? (
              <img
                src={id.photo}
                alt=""
                className="h-9 w-9 shrink-0 rounded-full object-cover ring-2 ring-brand/30"
              />
            ) : (
              <div className="brand-gradient grid h-9 w-9 shrink-0 place-items-center rounded-full text-[14px] font-semibold text-white">
                {id.initial}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-[11px] font-medium text-muted-foreground">
                {greeting()}
              </div>
              <div className="truncate text-[14px] font-semibold leading-tight">
                {id.name.split(" ")[0]}
              </div>
            </div>
            <svg
              width="16" height="16" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className={cn("shrink-0 text-muted-foreground transition-transform", accountMenu && "rotate-180")}
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>

          {accountMenu && (
            <>
              {/* click-away layer */}
              <button
                className="fixed inset-0 z-40 cursor-default"
                aria-hidden
                tabIndex={-1}
                onClick={() => setAccountMenu(false)}
              />
              <div className="absolute left-3 right-3 top-[64px] z-50 overflow-hidden rounded-xl border bg-card shadow-lg">
                <div className="border-b px-3 py-2.5">
                  <div className="truncate text-[13px] font-medium">{id.name}</div>
                  <div className="truncate text-[11.5px] text-muted-foreground">{id.email}</div>
                </div>
                <button
                  onClick={() => {
                    setAccountMenu(false)
                    go("#/settings")
                  }}
                  className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[13px] text-foreground transition-colors hover:bg-muted"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
                  Settings
                </button>
                <button
                  onClick={async () => {
                    setAccountMenu(false)
                    if (!window.confirm("Sign out on this device?")) return
                    await signOut()
                  }}
                  className="flex w-full items-center gap-2.5 border-t px-3 py-2.5 text-left text-[13px] text-late transition-colors hover:bg-late/10"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></svg>
                  Sign out
                </button>
              </div>
            </>
          )}
        </div>

        <nav className="shrink-0 space-y-px p-2">
          {NAV.map((n) => (
            <button
              key={n.hash}
              onClick={() => go(n.hash)}
              className={cn(
                "flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors",
                openTop === n.match
                  ? "bg-brand-soft font-semibold text-brand"
                  : "text-muted-foreground hover:bg-card hover:text-foreground",
              )}
            >
              {n.label}
              {n.match === "due" && openTasks > 0 && (
                <span
                  className={cn(
                    "tabular-nums rounded-full px-1.5 text-[11px] font-medium",
                    openTop === "due" ? "bg-brand/15 text-brand" : "bg-warn/15 text-warn",
                  )}
                >
                  {openTasks}
                </span>
              )}
            </button>
          ))}
        </nav>

        <div className="flex items-center justify-between px-4 pb-1 pt-4">
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Notebooks
          </span>
          <button
            onClick={newNotebook}
            title="New notebook"
            aria-label="New notebook"
            className="grid h-5 w-5 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-brand-soft hover:text-brand"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>
        <div className="flex-1 space-y-px overflow-y-auto p-2 pt-1">
          {(state?.notebooks || []).map((b, i) => (
            <button
              key={b.id || b.title}
              onClick={() => go("#/book/" + encodeURIComponent(b.title))}
              className={cn(
                "flex w-full items-center gap-2 truncate rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors",
                route.name === "book" && route.subject === b.title
                  ? "bg-brand-soft font-semibold text-foreground"
                  : "text-muted-foreground hover:bg-card",
              )}
            >
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: "var(--subj-" + (i % 8) + ")" }}
              />
              <span className="flex-1 truncate">{b.title}</span>
              <span className="tabular-nums text-[11px] text-muted-foreground">{b.notes}</span>
            </button>
          ))}
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        {/* Phone-only top bar: the only way to reach navigation once the
            sidebar is off-canvas. Hidden the moment there is room for the
            real sidebar. */}
        <div className="sticky top-0 z-20 flex items-center gap-3 border-b bg-background/90 px-4 py-2.5 backdrop-blur md:hidden">
          <button
            onClick={() => setNavOpen(true)}
            aria-label="Open menu"
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <MinervaMark size={22} idPrefix="bar" className="text-foreground" />
          <span className="text-[14px] font-semibold tracking-tight">Minerva</span>
          {openTasks > 0 ? (
            <span className="ml-auto rounded-full bg-warn/15 px-2 py-0.5 text-[11px] font-medium tabular-nums text-warn">
              {openTasks} due
            </span>
          ) : null}
        </div>

        {/* One broken page must not take the nav down with it: this boundary
            keeps the sidebar and every other screen working, and clears itself
            when the route changes. */}
        <ErrorBoundary variant="page" resetKey={route.name + (("id" in route && route.id) || "") + (("subject" in route && route.subject) || "")}>
        {route.name === "notes" && (
          <>
            {/* The quiet helping hand: shows at most one thing worth doing now,
                and renders nothing at all when there is nothing pressing. */}
            <div className="px-6 pt-5">
              <StudyNudge
                onPractise={({ subject }) =>
                  go("#/practice/" + encodeURIComponent(subject))
                }
                onOpenSettings={() => go("#/settings")}
                onSeeOverdue={() => go("#/due")}
              />
            </div>
            <NotesPage
              state={state as never}
              refresh={refresh}
              onOpenNote={(nid) => go("#/note/" + nid)}
            />
          </>
        )}

        {route.name === "tuition" && (
          <NotesPage
            context="tuition"
            state={state as never}
            refresh={refresh}
            onOpenNote={(nid) => go("#/note/" + nid)}
          />
        )}

        {route.name === "assessments" && (
          <AssessmentsPage
            onOpenNote={(nid) => go("#/note/" + nid)}
            onOpenSettings={() => go("#/settings")}
            onPractise={({ subject, noteId }) =>
              go("#/practice/" + encodeURIComponent(subject || noteId || ""))
            }
          />
        )}

        {route.name === "practice" && (
          <PracticePage
            /* Remount when the subject changes, so a deep link from another
               screen starts a fresh run rather than showing stale questions. */
            key={route.subject || "any"}
            initial={route.subject ? { subject: route.subject } : undefined}
            onOpenNote={(nid) => go("#/note/" + nid)}
          />
        )}
        {route.name === "note" && (
          <NotePage id={route.id} refresh={refresh} onLeave={() => go("#/notes")} />
        )}
        {route.name === "shared" && (
          <SharedNotePage
            token={route.token}
            onOpenNote={(nid) => go("#/note/" + nid)}
            onLeave={() => go("#/notes")}
            onAdded={refresh}
          />
        )}
        {route.name === "book" && (
          <NotebookPage
            subject={route.subject}
            subjects={state?.profile?.subjects}
            onOpenNote={(nid) => go("#/note/" + nid)}
            onOpenSubject={(s) => go("#/book/" + encodeURIComponent(s))}
            onLeave={() => go("#/notes")}
            onChanged={refresh}
          />
        )}
        {route.name === "timetable" && <TimetablePage />}
        {route.name === "calendar" && <CalendarPage state={state as never} />}
        {route.name === "due" && (
          <DuePage
            tasks={state?.tasks as never}
            subjects={state?.profile?.subjects}
            onChanged={refresh}
            onOpenNote={(nid) => go("#/note/" + nid)}
          />
        )}
        {route.name === "notifications" && (
          <NotificationsPage onOpenSettings={() => go("#/settings")} />
        )}
        {route.name === "settings" && <SettingsPage state={state as never} refresh={refresh} />}
        </ErrorBoundary>
      </main>

      {/* Ask sits above every screen: a question happens while you are reading
          a note, not on a separate page you have to go and find. */}
      <AskDock
        noteId={route.name === "note" ? route.id : undefined}
        onOpenNote={(nid) => go("#/note/" + nid)}
      />
    </div>
  )
}
