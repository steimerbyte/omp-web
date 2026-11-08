# Mandanten-Isolation — Vorschlag für Upstream

Status: Vorschlag, nicht implementiert. Grundlage ist der Arbeitsstand v0.24.3
(`bbeaf3f`) mit `@oh-my-pi/pi-coding-agent` 18.14.0. Alle Zahlen sind am
2026-11-08 auf `agent-pc` gemessen (LXC 101, Kernel 7.0.14-12-pve, bubblewrap
0.12.0, Dienst läuft als `uid=1000(pi)`), nicht geschätzt. Wo eine Zahl aus dem
Quelltext stammt statt aus einem Lauf, steht das dabei.

Der Vorschlag trennt zwei Dinge, die heute vermischt sind: **wer darf etwas
anfragen** (Rollenprüfung, gebaut) und **wer kann etwas lesen** (Kerngrenze,
nicht gebaut).

---

## 1 Anlass: eine Grenzverletzung, gemessen

Aus einer Agent-Session heraus, also über den normalen Tool-Pfad des Modells, in
einem Zug:

| Prozedur | Ergebnis |
|---|---|
| `find / -xdev -iname '*samuel*'` | 2 Treffer: `/home/pi/accounts/samuel`, `/home/pi/.omp/agent/sessions/-accounts-samuel` |
| `grep -ril samuel /home/pi` | **133 Dateien**, zusammen **5 189 703 552 Byte** (5,19 GB) durchsucht, Laufzeit 128,71 s |
| `cat` auf den Transcript des fremden Kontos | `/home/pi/.omp/agent/sessions/-accounts-samuel/2026-11-08T11-41-37-455Z_01a1baf6-….jsonl`, **43 066 Byte**, Modus **0644** — vollständig gelesen (Inhalt: „Wetter Berlin", `web_search`-Turns) |
| Agent-Datenbank des fremden Kontos | `/home/pi/accounts/samuel/.omp/agent/agent.db` 4 096 B + `agent.db-wal` **527 392 B**, 0700 `pi:pi` — gelesen (der WAL enthielt den Gesprächsinhalt nicht: 0 Treffer für `Wetter`) |
| Konto-Store aller Mandanten | `/home/pi/.omp/agent/omp-web-accounts.json`, 1 965 B, **0600 `pi:pi`** — lesbar, enthält die scrypt-Hashes von vier Konten |
| **Sitzungsschlüssel des Dienstes** | `/home/pi/.omp/agent/omp-web-session-key`, 44 B, **0600 `pi:pi`** — lesbar |
| Umgebung des Agent-Bash | **74 Schlüssel**, darunter `BRAVE_API_KEY` und `PARALLEL_API_KEY` |

Der letzte Punkt ist der scharfe: mit `omp-web-session-key` und dem ebenfalls
lesbaren Quelltext lässt sich `issueSessionCookie()` für **jeden** Benutzernamen
nachbauen, auch für einen Admin. Der Schritt von „ein Mandant liest einen
fremden Ordner" zu „ein Mandant ist Betreiber" ist damit ein Dateizugriff.

`0600` ist hier keine Schwäche der Datei, sondern die Folge davon, dass alle
Konten dieselbe `uid` sind: der Modus unterscheidet Benutzer, und es gibt nur
einen.

Das Repo sagt das an drei Stellen selbst:

- `lib/write-access.ts:13-14` — „the service runs as one account, so the kernel
  only ever sees that account and hands over every file it can read."
- `lib/tenant-config.ts:17` — „Der Prozess läuft ohne uid-Wechsel als ein
  Benutzer."
- `lib/request-identity.ts:128` — „ein Admin-Passwort zu kompromittieren heisst,
  den Host zu kompromittieren."

## 2 Warum die vorhandenen Guards das nicht lösen

Die Guards (`requireIdentity`, `requireAdmin`, `getWritableRoots`,
`filterSessionsForIdentity`, `load-policy`) beantworten die Frage **„darf dieser
Request das"**, nicht **„kann dieser Prozess das"** — und können es nicht: eine
Prüfung im selben Prozess ist eine Vereinbarung, keine Grenze. Der Audit hat das
festgehalten: `OMP-021` wurde verworfen, weil die HTTP-Allowlist „keine Kontrolle
über die In-Process-Agent-Tools" ist und „der Guard ausdrücklich keine Sandbox"
(`docs/security-vulnerabilities.md:352`).

`OMP-006` (`omp-cwd-*`-Symlink als erlaubte Datei-Wurzel) und `OMP-007` (Symlink
lädt fremde Dateien in den Prompt) sind der Präzedenzfall: beides waren korrekte
Pfadprüfungen, die am `realpath`-Zeitpunkt gescheitert sind, nicht an der Logik.
Wer die Grenze weiter als Pfadprüfung baut, baut `OMP-006` noch einmal.

## 3 Der Befund, der die Bauform bestimmt: der Shell ist kein Prozess

`node_modules/@oh-my-pi/pi-coding-agent/src/exec/bash-executor.ts:701-706`
startet den Shell als `new Shell(shellOptions)` aus `@oh-my-pi/pi-natives` —
brush-core als native Bibliothek **im selben Prozess**, einmal pro
`sessionKey` persistiert. Es gibt kein Kind, an das man `bwrap` hängen könnte.
`read`/`write`/`edit` sind `fs`-Aufrufe im selben Prozess, und die Session selbst
ist ein Objekt im Next-Server (`lib/rpc-manager.ts:2352`, `createAgentSession`,
in-process, alle Konten in einem Prozess).

Daraus folgt zweierlei, und der zweite Punkt ist der wichtigere:

1. Eine Grenze um einzelne Tool-Aufrufe ist nicht verdrahtbar, solange der
   Shell eine Bibliothek ist. `delete process.env.X` wirkt auch nicht — genau
   das steht schon in `lib/runtime-secrets.ts:9-20` und ist der Grund, warum die
   Geheimnisse aus einer Datei kommen statt aus der Umgebung.
2. Die Grenze kann nur um **den Prozess** gebaut werden, der die Session
   hostet. Das ist eine kleinere Änderung als sie klingt: `planSandboxSpawn`
   liefert bereits ein vollständiges argv, und was fehlt, ist ein Prozess, den
   man ihm übergeben kann.

## 4 Was schon funktioniert: die Terminal-Sandbox

`planSandboxSpawn` (`lib/sandbox.ts:263`) baut eine User-Namespace über
`bubblewrap`, mit einer **kurzen Allowlist** statt „alles read-only": `/usr`,
`/bin`, `/etc`, `/dev`, `/proc`, `/tmp` (tmpfs), dazu `--unshare-user`,
`--unshare-pid`, `--unshare-ipc`, `--unshare-uts`, `--clearenv`. Alles andere
existiert in der Sandbox nicht.

Gemessen, denselben Plan für `samuel` ausgeführt (58 argv-Einträge):

| Probe in der Sandbox | Ergebnis |
|---|---|
| `ls /home/pi` | `No such file or directory` — Dienst-Home, Session-Archiv aller Konten und Code sind nicht vorhanden |
| `ls /home/pi/accounts` | `No such file or directory` — Geschwisterkonten sind nicht vorhanden |
| `env \| wc -l` | **6** (Allowlist) |
| `ls /proc \| grep -c '^[0-9]'` | **4** PIDs statt aller Prozesse des Hosts |
| `id` | `uid=1000(pi)` — die Namespace ändert die uid nicht, sie nimmt nur die Pfade weg; das ist der Punkt |

Kosten: 20 Starts in 75 ms, also **3,8 ms** pro Spawn (Namespace-Aufbau; die
Laufzeit des Kindprozesses selbst ist damit nicht gemessen).

Der Pfad ist schon fail-closed gebaut: `lib/terminal-manager.ts:193` — „Ein
Konto ohne Shell-Sandbox bekommt keine Shell."

**Der Befund ist also nicht „es gibt keine Isolation", sondern: es gibt genau
eine, sie kostet 3,8 ms, und nur der Terminal-Endpunkt benutzt sie.**

## 5 Zielbild

Eine Grenze, ein Primitiv, um **den Prozess**, der einem Konto gehört.

| | sichtbar | nicht vorhanden |
|---|---|---|
| Dateien | eigenes Home, Systemverzeichnisse read-only, eigenes tmpfs | fremde Homes, Dienst-Agent-Verzeichnis, Session-Archiv anderer Konten, Konto-Store, Sitzungsschlüssel, Geheimnisdatei |
| Umgebung | Allowlist (PATH, LANG, TERM, HOME, USER, LOGNAME, …) | geerbte Prozessumgebung (Provider-Schlüssel, Passwort) |
| Prozesse | eigener Prozessbaum | Prozesse des Dienstes und anderer Konten |
| Pfade | Guest-Pfade (`/home/<name>/…`) | Host-Pfade (`/home/pi/accounts/<name>/…`) |

Zwei Regeln machen den Unterschied zur Prüfung:

1. **Die Grenze wird nicht geprüft, sie wird gemountet.** Ein Pfad, der nicht
   gebunden ist, ist `ENOENT` — es gibt keinen Fehlerpfad, auf dem eine falsche
   Entscheidung zu einem Lesezugriff wird.
2. **Ohne Grenze kein Lauf.** Fehlt `bwrap`, ist die User-Namespace aus, fehlt
   das Konto-Home oder ist der Kontoname unbrauchbar, endet der Lauf mit
   benanntem Grund und Abhilfe — nie mit einem ungesandboxten Lauf.

## 6 Optionen und ihre Ausschlussgründe

| Option | Mechanismus | Messung / Quelle | Urteil |
|---|---|---|---|
| Unix-Benutzer pro Konto (`useradd` + `sudoers` + `runuser`) | echte uid-Trennung, stärkste Grenze | `sudo -n true` → „a password is required"; `setpriv --reuid=…` → „setresuid failed: Operation not permitted" (`lib/sandbox.ts:10-16`, gemessen 2026-10-03) | braucht root; als **L3** anbieten, wo der Dienst als root läuft, nicht als Vorgabe |
| **bubblewrap-User-Namespace** | Mount-Namespace + PID/IPC/UTS, kein root nötig | hier: `bwrap 0.12.0`, `unprivileged_userns_clone=1`, 3,8 ms/Spawn (§4) | **empfohlen** — im Repo, gemessen, fail-closed verdrahtet |
| Landlock | LSM, unprivilegiert, pro Prozess, ohne bwrap | **hier nicht verifizierbar**: `/sys/kernel/security/` existiert im LXC nicht, `landlock` fehlt in `/proc/self/status`. ABI-Level unbelegt | als Fallback führen, erst nach einer Messung auf dem Zielhost zusagen. Die Sperre ist irreversibel — passt genau zu einem Prozess pro Mandant |
| Nur Pfad-Guards verschärfen (`realpath`, Allowlist) | in-process Prüfung | §1 (0600-Dateien lesbar), `OMP-006`/`OMP-007` | keine Grenze. Als Antwort auf dieses Problem ablehnen |
| LXC/VM pro Konto | volle Trennung | — | Betriebsaufwand pro Konto, für eine Self-Host-Installation unverhältnismäßig |

## 7 Vorschlag

**L1 — ein Worker-Prozess pro Mandant (die eigentliche Grenze).**
Je Nicht-Admin-Konto ein Kindprozess, der SDK und Sessions hostet, gestartet
über `planSandboxSpawn`; der Next-Server hält nur den Griff und spricht über
stdio oder einen Unix-Socket. Weil brush, `fs`-Tools, Hooks und MCP-stdio dann
*innerhalb* der Grenze laufen, ändert sich am Tool-Code nichts — der Schnitt
liegt an einer Stelle. Granularität ist der Mandant und nicht die Session: die
Prozessstart-Kosten fallen einmal pro Konto an, nicht pro Chat.

Das ist derselbe Schnitt, den die Runtime-Session-Identität schon vorbereitet
(`lib/agent-client.ts:28-32`: `SessionIdentity.runtimeId`, „a request may be
addressed by a live runtime handle while the session's persisted id is only
resolved later").

**L2 — Vollständigkeit des Ausführungspfads.**
Alles, was der Server selbst für ein Konto startet (`git`, `du`, `file-index`,
Export, `which`), geht durch denselben Plan statt durch `childEnv()` allein.
Heute ist `childEnv()` sauber bei den Geheimnissen, aber es ist kein Namespace —
diese Kinder sehen jedes Verzeichnis.

**L3 — echte uid, wo root verfügbar ist.**
`systemd-run --uid=<konto> --gid=<konto> --pipe` als Ausführungspfad, wenn der
Dienst als root läuft (Container-Installationen). Kein `sudoers`-Eintrag, kein
interpoliertes Kommando. Optional: L1 muss ohne root tragen.

## 8 Was Upstream liefern muss

Was der Server braucht, ist kein Tool-Argument, sondern die Möglichkeit, eine
**Session in einem Prozess** zu hosten, den er selbst startet:

```ts
export interface ExecBoundary {
  kind: "bwrap" | "landlock";
  home: string;                 // Host-Pfad des Kontos (existiert, geprüft)
  guestHome: string;            // Pfad INNERHALB der Grenze
  maskFiles?: string[];         // Dateien, die /dev/null bekommen
  env: Record<string, string>;  // Allowlist; ersetzt die geerbte Umgebung
}

/** Baut argv oder scheitert mit benanntem Grund. Rein, testbar, ohne IO. */
export function resolveExecPlan(boundary: ExecBoundary, command: string[]):
  | { ok: true; argv: string[]; guestCwd?: string }
  | { ok: false; reason: BoundaryFailure; detail: string; remediation: string };

/** Guest-Pfad → Host-Pfad, oder null. Kein Fallback auf "unverändert". */
export function toHostPath(boundary: ExecBoundary, guestPath: string): string | null;
```

Fünf Garantien, jede mit einem Test:

1. **Ein Startpunkt.** Eine Session in einer Grenze zu starten ist ein Aufruf,
   nicht eine Konvention — `createAgentSession({ boundary })` oder ein
   gleichwertiger Worker-Einstieg. Kein zweiter Weg, der ohne Grenze startet.
2. **Keine geerbte Umgebung.** `--clearenv` + `--setenv`-Paare, env-Map
   verpflichtend. Ein Spawn ohne explizite Map ist ein Fehler, kein Default.
3. **Fail-closed.** `PI_REQUIRE_BOUNDARY=1` → eine Session ohne herstellbare
   Grenze startet nicht; der Aufrufer bekommt `reason` + `remediation`, nicht
   einen ungesandboxten Lauf.
4. **Sichtbarkeit.** `session.boundary = { kind, enforced: true }` in der
   Session-Info, damit der Server „isoliert" nicht behaupten muss, sondern
   anzeigen kann.
5. **Guest-Pfade als Vertrag.** `read`/`write`/`edit` und Reports nennen
   `/home/<name>/…`; die Host-Abbildung passiert an genau einer Stelle
   (`toHostPath`) und liefert `null` statt eines geratenen Pfads.

## 9 Pfad-Vertrag für den Server (omp-web)

| Heute | Problem | Vorschlag |
|---|---|---|
| Session-Archiv liegt in `<Prozess-Agent-Dir>/sessions/-<cwd-bucket>/*.jsonl`, Modus **0644** | Inhalt eines Kontos liegt außerhalb seines Homes und ist maschinenweit lesbar (§1) | Archiv unter `<tenantAgentDir>/sessions` (0700); `getAgentDir()` nur für den Admin. `lib/load-policy.ts:255` löst den Besitzer-Pfad schon so auf |
| `omp-web-accounts.json`, `omp-web-session-key`, `omp-web.env` liegen unter `/home/pi/.omp/agent` (0600, **gleiche uid**) | §1: lesbar aus jedem Agent-Bash; der Schlüssel erlaubt Admin-Cookies | aus dem Konto-Pfad herausnehmen (root-owned, z. B. `/etc/omp-web/`) **und** in der Grenze per `maskFiles` verdecken. Die Terminal-Sandbox maskiert sie schon (`lib/terminal-manager.ts:224`) — der Agent-Pfad nicht |
| `cwd` ist ein Host-Pfad | Der Agent sieht Pfade, die in der Grenze nicht existieren | `cwd` intern als Guest-Pfad führen, Host-Pfad nur an der API-Kante |

## 10 Migration

1. **Archiv umziehen, nicht kopieren.** Pro Bucket `-<cwd>` einmalig nach
   `<tenantAgentDir>/sessions/<bucket>`, Modus 0700/0600, sha256-Liste vorher
   und nachher. Ein Bestand, der liegen bleibt, ist ein Befund, den niemand
   mehr liest.
2. **Store umziehen.** Konto-Store und Sitzungsschlüssel nach `/etc/omp-web/`
   (root:root 0600) oder in ein eigenes Dienst-Home. Bestehende Cookies bleiben
   gültig, solange der Schlüsselinhalt derselbe ist.
3. **Admin bleibt global.** Ein Admin *ist* das Prozesskonto
   (`lib/tenant-config.ts:25`); ihm eine eigene Grenze zu geben, würde seinen
   Provider-Schlüssel verschwinden lassen. Mindestens aber muss der
   Sitzungsschlüssel auch für ihn maskiert werden — ein Admin-Token ist heute
   der Host.
4. **`OMP_WEB_ALLOW_UNSANDBOXED_TENANT=1`** als ausdrücklicher Ausstieg, mit
   Startwarnung. Vorgabe: fail-closed.

## 11 Abnahmekriterien

Jede Zeile ist ein Lauf, keine Absicht. „Heute" ist der gemessene Ist-Zustand
vom 2026-11-08 für den Agent-Pfad, „Ziel" der erwartete Wert nach L1.

| # | Probe (aus der Session des Kontos A) | Heute | Ziel |
|---|---|---|---|
| A1 | `ls /home/pi/accounts` | 5 Verzeichnisse sichtbar | `ENOENT` |
| A2 | `cat <Archiv von Konto B>/*.jsonl` | 43 066 B gelesen, Modus 0644 | `ENOENT` |
| A3 | `[ -r <session-key> ]` | lesbar (0600, gleiche uid) | `ENOENT` |
| A4 | `env \| wc -l` | **74**, inkl. `BRAVE_API_KEY`, `PARALLEL_API_KEY` | = Größe der Allowlist (im Terminal heute 6) |
| A5 | `ls /proc \| grep -c '^[0-9]'` | alle Host-PIDs | ≤ Prozessbaum des Mandanten |
| A6 | `echo x > /home/pi/x` | erlaubt, soweit in den Write-Roots | `EROFS`/`EACCES` außerhalb des eigenen Homes |
| A7 | Lesetool mit Host-Pfad (`/home/pi/accounts/b/…`) | funktioniert | Fehler „outside boundary", kein Fallback |
| A8 | `bwrap` umbenennen, Session von A starten | startet ungesandboxt | HTTP 4xx mit `reason`/`remediation`, kein Lauf |
| A9 | Namespace-Aufbau | — | ≤ 5 ms (gemessen 3,8 ms) |
| A10 | `grep -ril <name> /` aus A | 133 Dateien / 5,19 GB über alle Konten | nur Treffer im eigenen Home |

Dazu ein Integrationstest mit zwei Dummy-Konten, der A1–A3 und A8 in einem Lauf
prüft — dieselbe Form, die `lib/sandbox.ts` heute schon testet, eine Ebene
höher.

## 12 Restrisiken und bewusste Grenzen

- **Netz bleibt gemeinsam.** Ohne `--unshare-net` teilt eine Grenze den
  Netzwerk-Stack; Egress-Kontrolle ist eine eigene Entscheidung und gehört nicht
  in diesen Schnitt.
- **User-Namespaces sind nicht überall verfügbar** (Docker ohne
  `--security-opt seccomp=unconfined`, AppArmor-Profile). Fail-closed heißt
  dann: keine Mandanten-Session, bis der Betreiber es freischaltet. Das ist die
  richtige Richtung, aber eine Betriebsänderung — sie muss in der Fehlermeldung
  stehen.
- **Landlock ist hier unbelegt** (§6). Nicht als Zusage dokumentieren, bevor ein
  Lauf auf dem Zielhost den ABI-Level zeigt.
- **Prozess pro Mandant ist ein neuer Fehlerpfad.** Ein Worker, der stirbt,
  nimmt die Sessions seines Kontos mit; Neustart, Zustand und Session-Handles
  müssen denselben Vertrag haben wie heute der In-Process-Pfad. Das ist der
  eigentliche Aufwand an L1, nicht das Namespace-Argument.
- **Admin = Host.** Bleibt so, ist dokumentiert und bleibt eine Entscheidung.
  Die Änderung macht nur den Weg dorthin nicht mehr zu einem Dateizugriff aus
  einer Mandanten-Session.
- **Der Mandant kann seinen eigenen Provider-Key lesen.** Der Modellaufruf
  passiert im selben Prozess wie der Tool-Shell (der Shell ist eine native
  Bibliothek, §3), also muss die Anmeldeinformation dieses Kontos in der
  Umgebung des Workers stehen — und ein `env` in einem Tool-Aufruf sieht sie
  damit. Die Grenze verhindert weiterhin, dass er *fremde* Schlüssel sieht:
  der Worker bekommt die Allowlist **plus genau die Provider-Zugangsdaten, die
  seine eigene Session braucht**, und nichts davon (`BRAVE_API_KEY`,
  `PARALLEL_API_KEY`, `OMP_WEB_PASSWORD`, Sitzungsschlüssel) steht daneben.
  Diesen Rest zu schließen braucht einen Modell-Proxy, der den Schlüssel aus
  dem Mandantenprozess heraushält; das ist ein eigener Schnitt und nicht Teil
  von L1.
- **Ein Worker kostet rund 250–340 MiB und ~1,2 s Start.** Auf diesem Host
  (6 Kerne, 12 GiB, kein Swap) passen rund 20 Worker mit 50 % Reserve; die
  Kerne binden vor dem Speicher. Deshalb startet ein Worker **träge** beim
  ersten Agent-Request seines Kontos, wird nach einer konfigurierbaren
  Ruhezeit abgeräumt und beim nächsten Request neu gestartet — nicht bei jedem
  Chat und nicht alle Konten gleichzeitig.
