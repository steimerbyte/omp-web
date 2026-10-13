"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { OmpWordmark } from "@/components/OmpWordmark";
import { AnimationProvider } from "@/components/motion/AnimationProvider";
import { Reveal } from "@/components/motion/Reveal";
import styles from "./login.module.css";

/**
 * Sign-in, reached from `proxy.ts` when a locked server turns away a navigation.
 *
 * The page posts the credential to `/api/web-access/login`, which sets an
 * `httpOnly` session cookie, and then hands the browser back to `/`. The
 * username field is pre-filled with `omp` because that is what every
 * single-user deployment has always used — one keystroke, and existing
 * installations keep working. With several accounts it is just a first guess:
 * the field is editable, and the server resolves an omitted name to the same
 * default.
 */

export default function LoginPage() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [username, setUsername] = useState("omp");
  const [password, setPassword] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every rejected attempt so the CSS animation restarts. React
  // re-uses a node whose class did not change, so re-adding the same class
  // would be a no-op and the shake would only ever play once.
  const [rejected, setRejected] = useState(0);

  /**
   * The one focus path into the password field, shared by the mount effect and
   * by the rejection path so both land in the same place.
   *
   * `select()` is not decoration. Chrome and Edge restore an autofilled
   * password with the caret at the end of the value, so a visitor who arrives
   * on a form the browser already knows would type into the middle of the
   * stored secret instead of replacing it. Selecting the whole value makes the
   * first keystroke overwrite, which is what "type your password" should mean.
   *
   * Stable across renders because it closes over the ref only — that is what
   * lets the effect below carry it as its only dependency and still run once.
   */
  const focusPassword = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  /**
   * Focus after the mount, not through `autoFocus`.
   *
   * `autoFocus` fires during React's commit, and at that moment `Reveal` has
   * already written `initial` — `opacity: 0`, a Y offset and a 6 px blur — onto
   * the card that contains this input. An element the browser cannot see is an
   * element it will not focus: the call is accepted, the caret simply ends up
   * on `<body>`, and the visitor has to click the field before typing. The
   * effect runs after the commit, and by then Motion has handed the card to its
   * 240 ms entrance, so the field is a real, focusable target.
   *
   * The same effect re-runs whenever `rejected` changes, which is what puts
   * the caret back after a failed attempt. It used to stay on the submit
   * button — the button is keyed by `rejected`, so it remounts on every
   * rejection and the browser drops focus to the body — and the next try cost
   * an extra click on the field before the first character could go in.
   *
   * Deliberately depends on nothing that changes while typing: `busy`,
   * `error`, `password`, `username` and `revealed` all churn during a normal
   * attempt, and re-stealing focus on any of them would fight the visitor for
   * the caret.
   */
  useEffect(() => {
    focusPassword();
  }, [focusPassword, rejected]);

  const signIn = useCallback(async () => {
    if (username.length === 0 || password.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/web-access/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null) as { error?: string } | null;
        setError(data?.error ?? `HTTP ${response.status}`);
        setRejected((count) => count + 1);
        return;
      }
      // `replace` so the browser Back button does not return to a login form
      // that is already satisfied.
      router.replace("/");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }, [password, router, username]);

  return (
    <AnimationProvider>
      <main className={styles.page}>
        <Reveal className={`${styles.card} ${styles.scanline}`}>
        <div className={styles.brand}>
          <OmpWordmark markSize={20} />
        </div>

        <h1 className={styles.title}>Sign in</h1>
        <p className={styles.lead}>
          omp-web is locked. Sign in with the configured username and password.
        </p>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void signIn();
          }}
        >
          <label className={styles.field}>
            <span>Username</span>
            <div className={styles.fieldGroup}>
              <input
                className={styles.input}
                type="text"
                autoComplete="username"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                value={username}
                disabled={busy}
                onChange={(event) => setUsername(event.target.value)}
              />
            </div>
          </label>

          <label className={styles.field}>
            <span>Password</span>
            <div className={styles.control}>
              <input
                ref={inputRef}
                className={styles.input}
                type={revealed ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                disabled={busy}
                onChange={(event) => setPassword(event.target.value)}
              />
              <button
                type="button"
                className={styles.reveal}
                aria-label={revealed ? "Hide password" : "Show password"}
                aria-pressed={revealed}
                onClick={() => {
                  setRevealed((current) => !current);
                  // Toggling visibility is a read of the value, so the same
                  // helper as everywhere else: the caret goes back to the
                  // password instead of staying on the toggle, and the text is
                  // ready to be replaced by the next keystroke.
                  focusPassword();
                }}
              >
                {revealed ? "Hide" : "Show"}
              </button>
            </div>
          </label>

          <p className={styles.error} role="alert" aria-live="polite">
            {error ?? ""}
          </p>

          <button
            type="submit"
            key={rejected}
            className={error ? `${styles.primary} ${styles.rejected}` : styles.primary}
            disabled={busy || username.length === 0 || password.length === 0}
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className={styles.aside}>
          <Link href="/recover">Forgot password?</Link>
        </p>
        </Reveal>
      </main>
    </AnimationProvider>
  );
}
