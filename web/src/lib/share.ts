/* share.ts — the browser side of sharing a note.

   Thin wrappers over the share API, plus the one piece of glue that belongs on
   the client: turning a token into the actual link a student sends. The link
   points at THIS origin's /s/<token> page, which the server renders for anyone
   and which quietly forwards a fellow Minerva user into the app. */

import { api, apiBase } from "@/lib/api"

/* The origin that actually serves /s/<token> — the Python backend. On an
   all-in-one deployment this is just the current origin; on a split deployment
   (static app on one host, API on another) it is the API host, because a static
   host does not serve the /s/ pages. */
function shareOrigin(): string {
  return apiBase() || window.location.origin
}

export type ShareInfo = {
  token: string
  path: string
  views: number
}

export type SharedNote = {
  token: string
  title: string
  subject: string
  topic: string
  summary: string
  blocks: unknown[]
  body: string
  owner_name: string
  created_at: string
  views: number
}

export type MyShare = {
  token: string
  title: string
  subject: string
  note_id: string
  created_at: string
  views: number
  revoked: boolean
}

/** The full, sendable link for a token — built from wherever the app is served,
    so it is correct on localhost, on Render, or behind a custom domain without
    anything to configure. */
export function shareLink(token: string): string {
  return shareOrigin() + "/s/" + token
}

/** Direct download links, handy for a "Download as Word" button that is just an
    anchor the browser follows. */
export function wordLink(token: string): string {
  return shareOrigin() + "/s/" + token + "/word"
}

/** Create (or refresh) the share for a note and return its token + link. */
export async function createShare(noteId: string): Promise<ShareInfo> {
  return api.post<ShareInfo>("/api/share/create", { note_id: noteId })
}

/** Stop sharing a note. One-way, and it takes effect everywhere at once. */
export async function revokeShare(token: string): Promise<boolean> {
  const r = await api.post<{ ok?: boolean }>("/api/share/revoke", { token })
  return !!r.ok
}

/** Read a shared note for the in-app viewer. */
export async function viewShare(token: string): Promise<SharedNote> {
  const r = await api.get<{ share: SharedNote }>(
    "/api/share/view?token=" + encodeURIComponent(token),
  )
  return r.share
}

/** Copy a shared note into the signed-in student's own notes. Returns the new
    (or already-existing) note id so the caller can open it. */
export async function addSharedNote(
  token: string,
): Promise<{ note_id: string; existed: boolean }> {
  return api.post<{ note_id: string; existed: boolean }>("/api/share/add", {
    token,
  })
}
