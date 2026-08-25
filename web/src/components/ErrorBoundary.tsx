import { Component, type ErrorInfo, type ReactNode } from "react"

/* A safety net so one broken render never blanks the whole app.

   React has no built-in error handling: if any component throws while
   rendering — a note with an unexpected shape, a stray undefined — React
   unmounts the entire tree and leaves a white screen with nothing to do. In
   front of a class, or in front of a marker, that is the worst possible
   failure. This catches the throw, shows a calm message with a way out, and —
   when it wraps a single page rather than the whole app — keeps the sidebar and
   every other page working so you can simply navigate away from the one thing
   that broke.

   Error boundaries have to be class components; there is no hook equivalent. */

type Props = {
  children: ReactNode
  /** What to show instead of the crash. Defaults to a full-screen card; pass a
      compact one when this only wraps a page. */
  variant?: "page" | "app"
  /** Reset the boundary when this value changes — e.g. the current route — so
      navigating away clears a page-level error automatically. */
  resetKey?: unknown
}

type State = { failed: boolean; message: string }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, message: "" }

  static getDerivedStateFromError(err: unknown): State {
    return {
      failed: true,
      message: err instanceof Error ? err.message : String(err),
    }
  }

  componentDidUpdate(prev: Props) {
    // A new route (or other reset key) clears a previous page's error, so the
    // student is not stuck on the error card after moving on.
    if (prev.resetKey !== this.props.resetKey && this.state.failed) {
      this.setState({ failed: false, message: "" })
    }
  }

  componentDidCatch(err: Error, info: ErrorInfo) {
    // Kept for the console during development; never shown to the student.
    console.error("Caught by ErrorBoundary:", err, info)
  }

  render() {
    if (!this.state.failed) return this.props.children

    const compact = this.props.variant === "page"
    return (
      <div
        className={
          compact
            ? "grid min-h-[50vh] place-items-center p-6"
            : "grid min-h-screen place-items-center bg-background p-6"
        }
      >
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <div className="grid h-11 w-11 place-items-center rounded-full bg-late/10 text-late">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
              <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
            </svg>
          </div>
          <div className="text-[15px] font-semibold">Something went wrong here</div>
          <p className="text-[13px] text-muted-foreground">
            {compact
              ? "This page hit an error. Your notes are safe — try again, or use the menu to go elsewhere."
              : "Minerva hit an unexpected error. Your notes are safe — reloading usually clears it."}
          </p>
          <div className="mt-1 flex gap-2">
            <button
              type="button"
              onClick={() => this.setState({ failed: false, message: "" })}
              className="rounded-lg border px-3.5 py-2 text-[13px] font-medium transition-colors hover:bg-muted"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="btn-brand rounded-lg px-3.5 py-2 text-[13px] font-semibold"
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    )
  }
}
