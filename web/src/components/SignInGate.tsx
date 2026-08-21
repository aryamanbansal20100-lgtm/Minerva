/* ==========================================================================
   SignInGate.tsx — the only door into the app, and the whole landing page.

   Three states, and the app tree is mounted in exactly one of them:
     ready === false   → a quiet "checking your sign-in" splash
     ready && !user    → the LANDING PAGE, with Sign in with Google on it
     ready && user     → children (the app)

   The landing page and the app are one thing at one URL: a visitor reads the
   marketing page and signs in right where they are, and the moment they do the
   same tree swaps to the app. Nothing underneath renders before there is a user
   and a token, so the first /api/state call always carries an Authorization
   header.
   ========================================================================== */

import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { useAuth } from "@/lib/auth";
import LandingPage from "@/pages/LandingPage";

export function SignInGate({ children }: { children: ReactNode }) {
  const { ready, user, error, signIn } = useAuth();
  const [busy, setBusy] = useState(false);

  const onSignIn = useCallback(async () => {
    setBusy(true);
    try {
      await signIn();
    } finally {
      setBusy(false);
    }
  }, [signIn]);

  if (ready && user) return <>{children}</>;

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-foreground">
        <div className="flex items-center gap-2.5">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" />
          <span className="font-mono text-[13px] tabular-nums text-muted-foreground">
            Checking your sign-in…
          </span>
        </div>
      </div>
    );
  }

  return <LandingPage onSignIn={onSignIn} signingIn={busy} error={error} />;
}

export default SignInGate;
