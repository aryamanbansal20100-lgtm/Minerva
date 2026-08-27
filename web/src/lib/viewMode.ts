/* viewMode.ts — how the student wants to read their notes.

   Five layouts, and the choice is theirs. They are not five colour schemes:
   each one answers a different question about what the screen is for. Someone
   revising the night before an exam wants Focus; someone checking what the
   teacher actually said wants Split; someone testing themselves wants Cards.

   Stored per device in localStorage rather than on the server, because it is a
   preference about THIS screen — a phone and a laptop can reasonably differ —
   and because reading it must be instant, with no request in the way. */

export type ViewMode = "paper" | "focus" | "workspace" | "cards" | "split"

const KEY = "minerva.view"

export const VIEW_MODES: { id: ViewMode; name: string; blurb: string }[] = [
  { id: "paper", name: "Paper", blurb: "Like a page in a notebook. Calm, serif, easy on the eyes." },
  { id: "focus", name: "Focus", blurb: "Just the note, large. Everything else gets out of the way." },
  { id: "workspace", name: "Workspace", blurb: "Dense and compact. More on screen, less scrolling." },
  { id: "cards", name: "Cards", blurb: "Each section a card, side by side. Good for testing yourself." },
  { id: "split", name: "Split", blurb: "Your notes beside what the teacher actually said." },
]

export function viewMode(): ViewMode {
  try {
    const v = localStorage.getItem(KEY)
    if (v && VIEW_MODES.some((m) => m.id === v)) return v as ViewMode
  } catch {
    /* private mode: fall through to the default */
  }
  return "paper"
}

export function setViewMode(mode: ViewMode): void {
  try {
    localStorage.setItem(KEY, mode)
  } catch {
    /* private mode: the choice just will not persist, which is harmless */
  }
}
