"use client";

import { useCallback, useEffect, useState } from "react";
import type { WebAccount } from "@/bin/web-auth-store.js";
import type { WhoAmIResponse } from "@/app/api/whoami/route";
import styles from "./SettingsConfig.module.css";
import { Skeleton } from "./motion/Skeleton";

/**
 * Kontenverwaltung, nur fuer Admins.
 *
 * Der Abschnitt erscheint in der Navigation nur, wenn `/api/whoami` sagt, dass
 * der angemeldete Benutzer Admin ist. Das ist eine Bequemlichkeitsgrenze, keine
 * Sicherheitsgrenze: die Route `/api/web-access/users` prueft dasselbe selbst und
 * antwortet einem Nicht-Admin mit 403. Verlaesst man sich nur auf das
 * ausgeblendete Menue, waere jeder Mandant ein Klick in der Adresszeile.
 *
 * Der 403 ist deshalb ein eigener Zustand mit eigener Anzeige und nicht
 * irgendein Fehlerbild. Wer den Abschnitt sieht und trotzdem abgelehnt wird, hat
 * einen Grund, den man ihm sagen muss — "This account only sees its own
 * directory" statt eines leeren Bildschirms.
 */

const MIN_PASSWORD_LENGTH = 8;

/** Dieselbe Regel wie `validateAccountName` im Store, damit der Fehler hier greift. */
const ACCOUNT_NAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;

/**
 * Die Aktionen, die eine Bestaetigung brauchen. `grant-admin` und
 * `revoke-admin` sind dabei, weil sie etwas veraendern, das nicht wieder
 * einfach zurueckgenommen wird: wer einem Konto die Admin-Rolle gibt, gibt ihm
 * den Zugriff auf jedes fremde Verzeichnis dieses Hosts.
 */
type PendingAction =
  | { kind: "disable" | "enable" | "grant-admin" | "revoke-admin"; username: string }
  | null;

export function UsersConfig() {
  const [identity, setIdentity] = useState<WhoAmIResponse["user"]>(null);
  const [checked, setChecked] = useState(false);
  const [accounts, setAccounts] = useState<WebAccount[] | null>(null);
  const [homeRoot, setHomeRoot] = useState("/home");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingAction>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  /** Das Passwort, das fuer ein Konto neu gesetzt werden soll. */
  const [passwordFor, setPasswordFor] = useState<string | null>(null);
  /**
   * Der angemeldete Benutzer hat sich gerade selbst die Admin-Rolle genommen.
   *
   * Der 403, der daraufhin auf `/api/web-access/users` kommt, ist die richtige
   * Antwort — aber "Der Server hat die Kontenliste verweigert, obwohl er Sie
   * als Administrator fuehrt, melden Sie sich ab und wieder an" waere die
   * falsche Erklaerung fuer genau diesen Fall.
   */
  const [selfDemoted, setSelfDemoted] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    setDenied(false);
    try {
      const response = await fetch("/api/web-access/users", { cache: "no-store" });
      if (response.status === 403) {
        setDenied(true);
        setAccounts([]);
        return;
      }
      const data = await response.json() as { accounts?: WebAccount[]; homeRoot?: string; error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setAccounts(data.accounts ?? []);
      setHomeRoot(data.homeRoot ?? "/home");
    } catch (caught) {
      setLoadError(caught instanceof Error ? caught.message : String(caught));
      setAccounts([]);
    }
  }, []);

  useEffect(() => {
    // Two questions, one load: "am I admin?" decides whether the route is worth
    // asking, and a non-admin never triggers the 403 that would look like a bug.
    void (async () => {
      try {
        const response = await fetch("/api/whoami", { cache: "no-store" });
        const data = await response.json() as WhoAmIResponse;
        setIdentity(data.user);
        if (data.user?.isAdmin) await load();
      } catch (caught) {
        setLoadError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setChecked(true);
      }
    })();
  }, [load]);

  const send = useCallback(async (method: "POST" | "PATCH", body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/web-access/users", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json() as { account?: WebAccount; error?: string };
      if (!response.ok || data.error) {
        setError(data.error ?? `HTTP ${response.status}`);
        return false;
      }
      await load();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setBusy(false);
      setPending(null);
      setPasswordFor(null);
      setPassword("");
      setConfirmation("");
    }
  }, [load]);

  const trimmed = username.trim();
  const nameValid = ACCOUNT_NAME_PATTERN.test(trimmed);
  const canCreate = !busy && nameValid && password.length >= MIN_PASSWORD_LENGTH && password === confirmation;

  if (!checked) {
    return <div className={styles.empty}>Checking your access…</div>;
  }

  // `null` heisst: der Server hat den Header nicht gesetzt. Das ist kein Admin,
  // und es ist auch kein Fehler, ueber den man reden muss.
  if (identity === null || !identity.isAdmin) {
    return (
      <div className={styles.empty}>
        Administrator access is required. This account manages its own directory only.
      </div>
    );
  }

  if (denied) {
    return (
      <div className={styles.empty}>
        {selfDemoted
          ? "You removed your own administrator role. It ended with this request — that is why the account list is now refused. Ask another administrator to grant it back."
          : "The server refused the account list for this session, although it reports you as an administrator. Sign out and back in to refresh your session."}
      </div>
    );
  }

  return (
    <div className={styles.scrollContent}>
      <header className={styles.contentHeader}>
        <h2 className={styles.contentTitle}>Accounts</h2>
        <p className={styles.contentDescription}>
          Every account gets a home directory under <code>{homeRoot}</code> when it is created here. There is no
          self-service: a login never creates a directory, so nobody can grant themselves one by signing up.
          Admins may work in every directory; everyone else is limited to their own. A role takes effect from the
          next request on — the server reads it fresh, so there is nothing to reload. If <code>OMP_WEB_ADMINS</code>
          is set on the server, it decides alone and the buttons below are refused with an explanation.
        </p>
        {notice && <div className={styles.reloadNotice}><span>{notice}</span></div>}
      </header>

      <div className={styles.settingsBody}>
        <section className={styles.group}>
          <h3 className={styles.groupTitle}>Accounts</h3>
          {loadError && <div className={styles.error}>{loadError}</div>}
          {accounts === null && (
            <div role="status" aria-label="Loading accounts…" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <Skeleton height={16} width="40%" />
              <Skeleton height={14} />
              <Skeleton height={14} width="80%" />
            </div>
          )}
          {accounts?.length === 0 && (
            <div className={styles.readOnlyNotice}>No accounts yet. The first one is created below.</div>
          )}
          {accounts?.map((account) => (
            <div key={account.username} className={styles.settingRow}>
              <div>
                <div className={styles.settingLabel}>
                  {account.username}
                  {account.isAdmin && " · admin"}
                  {!account.enabled && " · disabled"}
                </div>
                <div className={styles.settingDescription}>
                  <code>{account.home}</code>
                </div>
                {passwordFor === account.username && (
                  <div className={styles.settingControl}>
                    <input
                      className={styles.textInput}
                      type="password"
                      autoComplete="new-password"
                      placeholder="New password"
                      value={password}
                      disabled={busy}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                    <input
                      className={styles.textInput}
                      type="password"
                      autoComplete="new-password"
                      placeholder="Repeat"
                      value={confirmation}
                      disabled={busy}
                      onChange={(event) => setConfirmation(event.target.value)}
                    />
                  </div>
                )}
                {error && <div className={styles.error}>{error}</div>}
              </div>
              <div className={styles.settingControl}>
                <button
                  type="button"
                  className={styles.linkButton}
                  disabled={busy}
                  onClick={() => {
                    setNotice(null);
                    setError(null);
                    if (passwordFor === account.username) {
                      void send("PATCH", { action: "set-password", username: account.username, password });
                      return;
                    }
                    setPasswordFor(account.username);
                    setPassword("");
                    setConfirmation("");
                  }}
                >
                  {passwordFor === account.username ? "Save password" : "Set password"}
                </button>
                <button
                  type="button"
                  className={styles.linkButton}
                  disabled={busy}
                  onClick={() => {
                    setNotice(null);
                    setError(null);
                    setPending({ kind: account.isAdmin ? "revoke-admin" : "grant-admin", username: account.username });
                  }}
                >
                  {account.isAdmin ? "Remove admin" : "Make admin"}
                </button>
                <button
                  type="button"
                  className={styles.dangerButton}
                  disabled={busy}
                  onClick={() => setPending({ kind: account.enabled ? "disable" : "enable", username: account.username })}
                >
                  {account.enabled ? "Disable" : "Enable"}
                </button>
              </div>
            </div>
          ))}
        </section>

        <section className={styles.group}>
          <h3 className={styles.groupTitle}>New account</h3>
          <div className={styles.settingRow}>
            <div>
              <div className={styles.settingLabel}>Username</div>
              <div className={styles.settingDescription}>
                Lowercase letters, digits, underscores and hyphens, starting with a letter or an underscore. The name
                becomes a directory, so no slashes and no dots.
              </div>
              {trimmed.length > 0 && !nameValid && (
                <div className={styles.error}>That username cannot become a directory name.</div>
              )}
              {error && <div className={styles.error}>{error}</div>}
            </div>
            <div className={styles.settingControl}>
              <input
                className={styles.textInput}
                type="text"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="username"
                value={username}
                disabled={busy}
                onChange={(event) => setUsername(event.target.value)}
              />
            </div>
          </div>
          <div className={styles.settingRow}>
            <div>
              <div className={styles.settingLabel}>Password</div>
              <div className={styles.settingDescription}>
                At least {MIN_PASSWORD_LENGTH} characters. It is hashed before it is written and never sent back —
                give it to the person out of band.
              </div>
            </div>
            <div className={styles.settingControl}>
              <input
                className={styles.textInput}
                type="password"
                autoComplete="new-password"
                value={password}
                disabled={busy}
                onChange={(event) => setPassword(event.target.value)}
              />
              <input
                className={styles.textInput}
                type="password"
                autoComplete="new-password"
                placeholder="Repeat"
                value={confirmation}
                disabled={busy}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </div>
          </div>
          <div className={styles.editorActions}>
            <span className={styles.readOnlyNotice}>
              {canCreate ? `Creates ${homeRoot}/${trimmed} on the server.` : " "}
            </span>
            <button
              type="button"
              className={styles.primaryButton}
              disabled={!canCreate}
              onClick={() => {
                void (async () => {
                  if (!await send("POST", { username: trimmed, password })) return;
                  setUsername("");
                  setNotice(`Account "${trimmed}" created with home ${homeRoot}/${trimmed}.`);
                })();
              }}
            >
              Create account
            </button>
          </div>
        </section>
      </div>

      {/*
        Bestaetigung fuer die zwei Aktionen, die jemanden aussperren koennen.
        Inline und nicht `window.confirm`: der Dialog ist im Browser nicht
        lokalisierbar, und ein Abschreiten an der falschen Stelle kostet hier
        mehr, als es Aerger macht.
      */}
      {pending && (
        <div className={styles.backdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) setPending(null); }}>
          <div className={styles.window} role="dialog" aria-modal="true" aria-label="Confirm">
            <div className={styles.mcpEditor}>
              <header className={styles.contentHeader}>
                <h2 className={styles.contentTitle}>
                  {pending.kind === "disable" ? `Disable ${pending.username}?`
                    : pending.kind === "enable" ? `Enable ${pending.username}?`
                      : pending.kind === "grant-admin" ? `Make ${pending.username} an administrator?`
                        : `Remove admin from ${pending.username}?`}
                </h2>
                <p className={styles.contentDescription}>
                  {pending.kind === "disable"
                    ? "They are signed out on their next request and cannot get back in until you enable the account again. The directory and its files are kept."
                    : pending.kind === "enable"
                      ? "They can sign in again with the password you set for them."
                      : pending.kind === "grant-admin"
                        ? "They will be able to read and write in every directory on this host, not only in their own. It takes effect from their next request on."
                        : pending.kind === "revoke-admin" && pending.username === identity?.username
                          ? "You are removing your own role. This request still succeeds — the role was proven before it arrived — but every request after it is answered as a normal account. Another administrator has to grant it back."
                          : "They keep their directory and everything in it, and lose access to every other directory on this host. It takes effect from their next request on."}
                </p>
              </header>
              <div className={styles.editorActions}>
                <button type="button" className={styles.dangerButton} disabled={busy} onClick={() => setPending(null)}>Cancel</button>
                <button
                  type="button"
                  className={styles.primaryButton}
                  disabled={busy}
                  onClick={() => {
                    const target = pending;
                    const body = target.kind === "grant-admin" || target.kind === "revoke-admin"
                      ? { action: "set-admin", username: target.username, isAdmin: target.kind === "grant-admin" }
                      : { action: "set-enabled", username: target.username, enabled: target.kind === "enable" };
                    // Muss **vor** `send` gesetzt werden: `send` laedt die Liste
                    // neu, und der 403, der dann kommt, ist genau das hier.
                    if (target.kind === "revoke-admin" && target.username === identity?.username) setSelfDemoted(true);
                    void send("PATCH", body).then((ok) => {
                      if (!ok) return;
                      setNotice(
                        target.kind === "disable" ? `${target.username} is disabled.`
                          : target.kind === "enable" ? `${target.username} is enabled.`
                            : target.kind === "grant-admin" ? `${target.username} is an administrator from their next request on.`
                              : `${target.username} is no longer an administrator from their next request on.`,
                      );
                    });
                  }}
                >
                  {pending.kind === "disable" ? "Disable account"
                    : pending.kind === "enable" ? "Enable account"
                      : pending.kind === "grant-admin" ? "Make administrator"
                        : "Remove admin"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
