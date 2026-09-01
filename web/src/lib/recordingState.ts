/* recordingState.ts — is a lesson being recorded right now?

   One flag, shared between the recorder and the lock screen, because the two
   have a genuine conflict: when the lock engages it unmounts the whole app, and
   unmounting the recorder tears down its MediaRecorder and microphone stream.
   That means an automatic re-lock in the middle of a lesson does not merely
   cover the screen — it destroys the recording, and the student finds out
   forty minutes later when half the class is missing.

   So the sleep detector asks here first. A fresh page load still locks (the
   recorder is gone by then anyway), and the student can still lock by hand; the
   only thing suppressed is an automatic re-lock while audio is being captured. */

let recording = false

export function setRecording(on: boolean): void {
  recording = on
}

export function isRecording(): boolean {
  return recording
}
