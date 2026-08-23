/* ==========================================================================
   auth.tsx — Google sign-in, and nothing else.

   One provider owns identity. Everything else asks useAuth() rather than
   reaching for a global, and the app tree is simply not mounted until there is
   a signed-in user with a token in hand — which is what guarantees the first
   GET /api/state carries an Authorization header instead of bouncing off the
   server's 401.
   ========================================================================== */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut as firebaseSignOut,
} from "firebase/auth";
import type { User, UserCredential } from "firebase/auth";
import {
  auth,
  authErrorCode,
  authErrorMessage,
  clearMailToken,
  googleProvider,
  initAuth,
  MAIL_SCOPE,
  readMailToken,
  writeMailToken,
} from "./firebase";
import { currentIdToken, setIdToken } from "./api";

/* Firebase ID tokens last an hour. Refreshing at half that means a long lesson
   never dies mid-recording with a 401 while audio slices are being posted to
   /api/record/chunk. The forced refresh is deliberate — asking for the cached
   token would return the same nearly-expired one. */
const TOKEN_REFRESH_MS = 30 * 60 * 1000;

export type ConnectMailResult =
  | { ok: true; cancelled?: false; error?: undefined }
  | { ok: false; cancelled: true; error?: undefined }
  | { ok: false; cancelled?: false; error: string };

export type MailApi = {
  /** The access token held for this tab, or "". */
  token: () => string;
  /** Ask Google for read-only inbox access for the account already signed in. */
  connect: () => Promise<ConnectMailResult>;
  /** Drop the token. Nothing is kept. */
  forget: () => void;
};

export type AuthValue = {
  user: User | null;
  /** The live ID token. A getter, so reading it never re-renders anything. */
  token: string;
  /** False until the first auth-state callback has fired. */
  ready: boolean;
  /** A sentence for the gate when sign-in itself failed. */
  error: string;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  mail: MailApi;
  /** Mirrors the stored mail token so connected-state UI re-renders. */
  mailToken: string;
  connectMail: () => Promise<ConnectMailResult>;
  forgetMail: () => void;
};

const AuthContext = createContext<AuthValue | null>(null);

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth() used outside <AuthProvider>");
  return value;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [mailToken, setMailToken] = useState<string>(() => readMailToken());

  /* connectMail can sign the app out while its own promise is still running,
     which unmounts most of the tree underneath. Guard the state writes. */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    let unsubscribe: (() => void) | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    const stopTimer = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    void (async () => {
      const initError = await initAuth();
      if (!alive) return;
      if (initError) {
        setError(initError);
        setReady(true);
        return;
      }

      unsubscribe = onAuthStateChanged(auth, async (next: User | null) => {
        /* The old build registered a fresh interval on every auth change and
           cleared none of them; signing out and back in twice left three
           timers running against three stale User objects. */
        stopTimer();

        if (!next) {
          setIdToken("");
          if (!alive) return;
          setUser(null);
          setReady(true);
          return;
        }

        /* Token first, user second. Flipping `ready` before the token exists
           would let the app mount and fire its first /api/state unauthenticated
           (EVIE_REQUIRE_AUTH defaults to on, so the server answers 401). */
        let token = "";
        try {
          token = await next.getIdToken();
        } catch (err: unknown) {
          setIdToken("");
          if (!alive) return;
          setError(
            "Could not confirm your sign-in — " +
              (authErrorMessage(err) || "check the connection") +
              ". Try again.",
          );
          setUser(null);
          setReady(true);
          return;
        }
        setIdToken(token);
        if (!alive) return;
        setError("");
        setUser(next);
        setReady(true);

        timer = setInterval(() => {
          void (async () => {
            try {
              setIdToken(await next.getIdToken(true));
            } catch {
              /* Offline for a moment. Keep the token we have and try again in
                 half an hour; a 401 would force a refresh sooner anyway. */
            }
          })();
        }, TOKEN_REFRESH_MS);
      });
    })();

    return () => {
      alive = false;
      stopTimer();
      if (unsubscribe) unsubscribe();
    };
  }, []);

  const signIn = useCallback(async () => {
    setError("");
    try {
      const credential = await signInWithPopup(auth, googleProvider);
      /* Belt and braces: the listener does this too, but setting it here means
         a sign-in always leaves a usable token even if the listener's own
         getIdToken had failed a moment earlier. */
      try {
        setIdToken(await credential.user.getIdToken());
      } catch {
        /* The listener will retry. */
      }
    } catch (err: unknown) {
      const code = authErrorCode(err);
      if (code === "auth/popup-blocked") {
        /* Popups are blocked often enough that without this fallback the
           button silently does nothing. */
        try {
          await signInWithRedirect(auth, googleProvider);
        } catch (redirectErr: unknown) {
          setError(
            `Sign-in failed — ${
              authErrorCode(redirectErr) || authErrorMessage(redirectErr)
            }`,
          );
        }
        return;
      }
      /* Changed their mind. Not a failure, so say nothing. */
      if (
        code === "auth/popup-closed-by-user" ||
        code === "auth/cancelled-popup-request"
      ) {
        return;
      }
      setError(`Sign-in failed — ${code || authErrorMessage(err)}`);
    }
  }, []);

  const forgetMail = useCallback(() => {
    clearMailToken();
    if (mounted.current) setMailToken("");
  }, []);

  /* Signing out must drop the school-mail token first. Leaving it behind would
     hand the next person at this laptop a live read handle on the school
     inbox. */
  const signOut = useCallback(async () => {
    forgetMail();
    setIdToken("");
    setError("");
    await firebaseSignOut(auth);
  }, [forgetMail]);

  /* ----------------------------------------------------------------------
     Connect the school inbox — read-only, and without a password.

     Deliberately a SEPARATE action from signing in. Asking for inbox access at
     sign-in would make every student hand over mail permission just to take
     notes. This runs only when they press the button.
     ---------------------------------------------------------------------- */
  const connectMail = useCallback(async (): Promise<ConnectMailResult> => {
    /* Capture the identity BEFORE anything opens. Everything below depends on
       knowing who we were. */
    const before = auth.currentUser;
    if (!before) return { ok: false, error: "sign in first, then connect mail" };

    /* A second, fresh provider — not the sign-in one. "consent" (not
       "select_account") forces the scope screen, and login_hint pins the popup
       to the account already signed in. That is the first half of the guard. */
    const mailProvider = new GoogleAuthProvider();
    mailProvider.addScope(MAIL_SCOPE);
    mailProvider.setCustomParameters({
      prompt: "consent",
      login_hint: before.email || "",
    });

    let result: UserCredential;
    try {
      result = await signInWithPopup(auth, mailProvider);
    } catch (err: unknown) {
      const code = authErrorCode(err);
      if (
        code === "auth/popup-closed-by-user" ||
        code === "auth/cancelled-popup-request"
      ) {
        return { ok: false, cancelled: true };
      }
      if (code === "auth/popup-blocked") {
        /* No redirect fallback here, unlike sign-in: a full-page redirect
           would throw away whatever the student was in the middle of. */
        return {
          ok: false,
          error:
            "your browser blocked the Google popup — allow popups for this " +
            "page and try again",
        };
      }
      return { ok: false, error: authErrorMessage(err) };
    }

    /* THE ACCOUNT-SWITCH GUARD.

       signInWithPopup does not merely fetch a scope: it signs the app in as
       whichever account was chosen. Notes are stored per account, so picking a
       different mailbox swaps the whole identity and every note appears to
       vanish. That is the "everything resets" failure, and it must not be able
       to happen by accident.

       Compare on uid, never email — an email can change case or be an alias.
       Drop the mail token first, then sign out, so the app lands on the gate
       under a known-empty identity rather than sitting silently inside the
       wrong account's empty notebook. A failing signOut is swallowed because
       the explanation still has to reach the student. */
    if (result.user && result.user.uid !== before.uid) {
      clearMailToken();
      try {
        await firebaseSignOut(auth);
      } catch {
        /* Fall through — still report. */
      }
      if (mounted.current) setMailToken("");
      return {
        ok: false,
        error:
          "that is a different Google account (" +
          (result.user.email || "") +
          "). Your notes live under " +
          (before.email || "your school account") +
          ", so I signed out rather than switch you. Sign back in with that " +
          "account. Reading a second mailbox needs a separate connection I " +
          "have not built yet — tell me and I will.",
      };
    }

    const credential = GoogleAuthProvider.credentialFromResult(result);
    const token = credential ? credential.accessToken : undefined;
    if (!token) {
      return {
        ok: false,
        error:
          "Google did not grant mail access. Make sure you tick the " +
          "permission it asks for.",
      };
    }
    writeMailToken(token);
    if (mounted.current) setMailToken(token);
    return { ok: true };
  }, []);

  const mail = useMemo<MailApi>(
    () => ({ token: readMailToken, connect: connectMail, forget: forgetMail }),
    [connectMail, forgetMail],
  );

  const value = useMemo<AuthValue>(
    () => ({
      user,
      /* A getter, not a stored field: the token changes every half hour and no
         consumer should re-render because of it. */
      get token() {
        return currentIdToken();
      },
      ready,
      error,
      signIn,
      signOut,
      mail,
      mailToken,
      connectMail,
      forgetMail,
    }),
    [user, ready, error, signIn, signOut, mail, mailToken, connectMail, forgetMail],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * The name and email to show in the sidebar. With two Google accounts in play,
 * the one thing that matters is which account you are actually in.
 */
export function identityOf(user: User | null): {
  name: string;
  email: string;
  photo: string;
  initial: string;
} {
  if (!user) return { name: "Minerva", email: "—", photo: "", initial: "M" };
  const email = user.email || "";
  const name = user.displayName || email.split("@")[0] || "You";
  return {
    name,
    email: email || "—",
    photo: user.photoURL || "",
    initial: (name.trim()[0] || "Y").toUpperCase(),
  };
}
