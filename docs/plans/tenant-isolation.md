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
| `ls /proc \| grep -c '^[0-9]'` | **4** PIDs — die der eigenen PID-Namespace, nicht die des Hosts |
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
| Dateien | eigenes Home, Systemverzeichnisse read-only, eigenes tmpfs | fremde Homes, Dienst-Agent-Verzeichnis, Session-Archiv anderer Konten; Konto-Store, Auth-Datei und Sitzungsschlüssel (`ENOENT`, weil kein Bind sie zeigt), Geheimnisdatei (leer überdeckt, weil sie unter dem `/etc`-Bind liegt) |
| Umgebung | Allowlist (PATH, LANG, TERM, HOME, USER, LOGNAME, …) | geerbte Prozessumgebung (Provider-Schlüssel, Passwort) |
| Prozesse | eigener Prozessbaum | Prozesse des Dienstes und anderer Konten |
| Pfade | Guest-Pfade (`/home/<name>/…`) | Host-Pfade (`/home/pi/accounts/<name>/…`) |

Drei Regeln machen den Unterschied zur Prüfung:

1. **Die Grenze wird nicht geprüft, sie wird gemountet.** Ein Pfad, der nicht
   gebunden ist, ist `ENOENT` — es gibt keinen Fehlerpfad, auf dem eine falsche
   Entscheidung zu einem Lesezugriff wird.
2. **Eine Maske ist nur nötig, wo ein Bind den Pfad sonst zeigt.** `/etc` ist
   als Ganzes gebunden, weil eine Shell ohne `/etc/ld.so.cache` und
   `/etc/passwd` nicht brauchbar ist — die Geheimnisdatei ist dort also
   **vorhanden** und wird von einer leeren Datei überdeckt. Alles, was unter
   keinem Bind liegt (Dienst-Agent-Verzeichnis, Konto-Store, Sitzungsschlüssel),
   wird nicht überdeckt, sondern **existiert nicht**: `ENOENT` ist die stärkere
   Zusage, weil eine Maske den Pfad wenigstens noch zeigt.
3. **Ohne Grenze kein Lauf.** Fehlt `bwrap`, ist die User-Namespace aus, fehlt
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
  maskFiles?: string[];         // Dateien, die eine leere Datei überdeckt —
                                // nur nötig, wo ein Bind den Pfad sonst zeigt
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
| `omp-web-accounts.json`, `omp-web-auth.json`, `omp-web-session-key` liegen unter `/home/pi/.omp/agent` (0600, **gleiche uid**), `omp-web.env` unter `/etc/omp-web.env` | §1: lesbar aus jedem Agent-Bash; der Schlüssel erlaubt Admin-Cookies | aus dem Konto-Pfad herausnehmen (root-owned, z. B. `/etc/omp-web/`). Zwei verschiedene Schnitte, je nach Pfad: die drei Dateien im Agent-Verzeichnis liegen unter **keinem** Bind — sie sind in der Grenze nicht vorhanden (`ENOENT`), das ist die stärkere Zusage und braucht keine Maske. `omp-web.env` liegt unter dem `/etc`-Bind und ist damit **vorhanden** — der Pfad existiert also, anders als die drei Dateien im Agent-Verzeichnis; lesbar ist sie heute nur deshalb nicht, weil sie `root:root 0600` gehört und der Mandant nicht root ist. Gehört sie dem Dienstbenutzer (die Installation erlaubt das), hilft der Modus nicht, weil die Namespace die uid nicht ändert — deshalb `maskFiles`, das sie mit einer leeren Datei überdeckt. Zieht man die Store-Dateien wie in §10 vorgeschlagen nach `/etc/omp-web/`, liegen auch sie unter dem `/etc`-Bind und brauchen dann dieselbe Maske. Die Terminal-Sandbox reicht die Liste schon durch (`lib/terminal-manager.ts:224`) — der Agent-Pfad nicht |
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
   Sitzungsschlüssel auch aus seiner Grenze herausbleiben — ein Admin-Token ist heute
   der Host; er liegt unter keinem Bind und ist dort `ENOENT`, eine Maske braucht
   es dafür nicht.
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
- **Ein Worker kostet rund 265 MiB RSS, 364 MiB Spitze (`VmRSS 271524 kB`,
  `VmHWM 372868 kB` aus `/proc/<pid>/status` am inneren `bun`) und ~1,2 s
  Start.** Auf diesem Host (6 Kerne, 12 GiB, kein Swap) passen auf den
  Ruhewert gerechnet 46 Worker; mit 50 % Reserve und der Spitze statt des
  Ruhewerts sind es 16. Die Kerne binden vor dem Speicher, und die Vorgabe
  `OMP_WEB_TENANT_WORKER_MAX=4` liegt weit darunter. Geplant wird die Grenze
  auf der **Spitze**, nicht auf dem Ruhewert: vier Worker sind ~1,4 GiB, nicht
  die ~1,0 GiB, die der Ruhewert nahelegt. Deshalb startet ein Worker **träge**
  beim ersten Agent-Request seines Kontos, wird nach einer konfigurierbaren
  Ruhezeit abgeräumt und beim nächsten Request neu gestartet — nicht bei jedem
  Chat und nicht alle Konten gleichzeitig.

---

## 13 Phase 3: was gebaut wurde, was gemessen ist, was offen bleibt

Dieser Abschnitt ist der Nachtrag zu §7–§11. Er beschreibt den **Arbeitsstand
auf dem Branch `feat/tenant-isolation`**, nicht mehr einen Vorschlag. Alle
Zahlen sind am 2026-11-08 auf `agent-pc` (LXC 101, Kernel 7.0.14-12-pve,
bubblewrap 0.12.0, Dienst als `uid=1000(pi)`) gemessen, an einem Scratch-Server
mit eigener `OMP_WEB_HOME_ROOT`, eigenem Agent-Verzeichnis und eigener
Secrets-Datei — nicht an der Live-Installation.

### 13.1 Was gebaut ist

**L1, der Worker-Prozess (§7).** Ein Nicht-Admin-Konto wird von einem eigenen
Kindprozess gehostet, gestartet über `planSandboxSpawn` mit dem
`planSandboxSpawn`-argv aus §4 plus zwei zusätzlichen `--ro-bind` (das
`bun`-Binaerprogramm und die `node_modules` des Repos, beide in das Gast-Home).
Der Host ist das **SDK selbst** im `--mode rpc` (`lib/tenant-worker.ts`), der
Client der SDK-`RpcClient` — kein nachgebauter Frame-Codec.

Der Schnitt liegt vor jedem SDK-Aufbau in `startRpcSession`
(`lib/rpc-manager.ts`): `tenantBoundaryPolicy` kennt genau zwei Wege in den
Serverprozess (kein Mandant, oder `OMP_WEB_ALLOW_UNSANDBOXED_TENANT=1`), alles
andere geht in einen Worker, und ein abgelehnter Plan ist ein benannter Fehler.

**Der Provider des Kontos, aus seinem eigenen `models.yml`.** Der erste echte
Worker-Start scheiterte mit der Meldung des SDK (`No default model selected`),
weil die Provider-Liste konstant leer war. `tenantProviders(identity)` liest die
Datei jetzt über `ModelsConfigFile.relocate` — den Parser des SDK, keine zweite
YAML-Wahrheit. Der Betreiber-Bestand wird **nicht** geerbt; ein Konto ohne
`models.yml` startet ohne Provider und scheitert erst im Modellaufruf, mit der
Meldung des SDK.

**Lebenszyklus (§7, Anforderung 4).** Träger Start bei der ersten
Agent-Anfrage des Kontos, Abräumen nach `OMP_WEB_TENANT_WORKER_IDLE_MS`, harte
Obergrenze `OMP_WEB_TENANT_WORKER_MAX` mit LRU-Verdrängung, und Ersetzen eines
gestorbenen Workers. Der letzte Punkt war zuerst falsch: `acquire` gab den Slot
unbefragt zurück, also bekam nach einem `kill` jede weitere Anfrage denselben
toten Prozess. Jetzt meldet der Worker seinen Exit selbst
(`Bun.Subprocess.exited` → `isAlive()`), und `acquire` räumt den toten Slot ab
und startet neu.

**Sichtbarkeit (Anforderung 6).** `SessionInfo.boundary` trägt `kind`,
`enforced` und `pid`. `enforced: true` steht dort nur mit gemeldeter PID; der
In-Process-Pfad meldet `kind: "in-process", enforced: false`.

### 13.2 Die Abnahmetabelle, gemessen

Dieselbe Fassung, drei Läufe des Harness (`scripts/verify-tenant-isolation.mjs`),
jeweils gegen einen frisch gestarteten Server:

| Modus | Ergebnis | Anmerkung |
|---|---|---|
| `probe` | **27 PASS, 0 FAIL, 0 SKIP** (exit 0) | Basisstand auf unverändertem `main`: 6 PASS / 19 FAIL |
| `fail-closed` | **10 PASS, 0 FAIL, 0 SKIP** (exit 0, 21 N/A) | Server ohne `bwrap` auf dem `PATH`; `reason: "bwrap-missing"` |
| `opt-out` | **8 PASS, 0 FAIL, 0 SKIP** (exit 0, 22 N/A) | `OMP_WEB_ALLOW_UNSANDBOXED_TENANT=1`, `6c` belegt die Wirkung |

Die beiden Zeilen `A11` und `A12` sind beim Abschluss des Branches
dazugekommen; sie zählen in `probe` und sind in den beiden anderen Modi N/A, weil
dort kein Worker laeuft. Jeder der drei Laeufe braucht einen **frisch gestarteten**
Server: das Harness reinigt die Homes, aber die Session-Registry des Servers lebt
im Prozess, und ein zweiter Lauf gegen denselben Prozess misst einen halb
abgeraeumten Zustand (gemessen: `3d` 755 und `A11` `(deleted)`, beides Artefakte
des Vorlaufs, nicht des Codes).

Die Zeilen aus §11, mit dem beobachteten Wert im `probe`-Lauf:

| # | Probe | Wert |
|---|---|---|
| A1 | `ls <homeRoot>` aus der Mandanten-Session | `No such file or directory` |
| A2 | fremdes Archiv lesen | `cannot open …: No such file or directory` |
| A3 | `[ -r <session-key> ]` | `NO` |
| A4 | Geheimnisse in der Shell | 55 Variablen, **keine** mit `KEY`/`PASSWORD`/`TOKEN`/`SECRET` |
| A5 | `ls /proc \| grep -c '^[0-9]'` | **2** — nur der eigene Prozessbaum; der Host zeigt zur selben Zeit die Einträge aller laufenden Prozesse, eine Zahl, die mit der Laufzeit schwankt und deshalb hier nicht als Wert steht |
| A6 | ausserhalb des Homes schreiben | verweigert (`No such file or directory`) |
| A11 | Arbeitsverzeichnis des Workers | `readlink /proc/self/cwd`, `/bin/pwd -P` und `$PWD` alle `/home/verifyalpha` |
| A12 | selbst geschriebene Kopfzeile mit `cwd:"/"` | `/api/files` → `/etc/passwd=403`, `/proc/self/environ=403` |
| A10 | fremde lesbare Dateien | **0** |
| 2a | ein Workerprozess pro Mandant | PIDs 1004695 / 1004694, verschiedene Konten |
| 2b | `/proc/<worker>/root/home` | `["verifyalpha"]` |
| 2c | `/proc/<worker>/root/home/pi` | `ENOENT` |
| 2d | Worker-`environ` | **7** Schlüssel, keine Dienstgeheimnisse |
| 2e | Secrets-Datei in der Grenze | nicht lesbar: `ENOENT`, wenn sie unter keinem Bind liegt; unter dem `/etc`-Bind wird sie mit einer leeren Datei überdeckt (0 Byte) |
| 3a | Archiv im Mandanten-Home | 1 Datei, im Dienstverzeichnis 0 |
| 3d | Verzeichnis-Modus | `700` |
| 3e | Datei-Modus | `600` |
| 7 | weltlesbare Mandanten-Datei | **0** von 12 geprüft |

**Der Statuscode einer fehlenden Grenze ist 503, nicht 500.** Eine fehlende
Grenze ist ein Zustand des Hosts — benannt, behebbar, und beim nächsten Versuch
vielleicht weg (nach `pacman -S bubblewrap`). Eine 500 sagt „der Server ist
kaputt" und schickt den Betreiber in die Logs, obwohl `reason` und `remediation`
im Körper stehen. Der Terminal-Pfad antwortet für dieselbe Ursache seit jeher
503 (`app/api/terminal/route.ts:97-104`); zwei Routen mit zwei Statuscodes für
eine Ursache wären ein Widerspruch in der API. Die Abbildung steht an einer
Stelle (`tenantBoundaryHttpStatus` in `lib/rpc-manager.ts`) und wird von beiden
Agent-Routen benutzt, weil `POST /api/agent/[id]` denselben Worker startet:

| `reason` | Status | Warum |
|---|---|---|
| `bwrap-missing` | **503** | Voraussetzung des Hosts |
| `userns-disabled` | **503** | Voraussetzung des Hosts |
| `boundary-unavailable` | **503** | fehlende Datei (Home, SDK-CLI, Bun) |
| `mask-unavailable` | **503** | Maskierung nicht herstellbar |
| `unsupported-platform` | 500 | Windows bekommt keine userns durch Wiederholen |
| `tenant-worker-capacity` | 500 | Betriebsgrenze, kein Zustand des Hosts |
| `tenant-worker-spawn-failed` | 500 | echter Defekt; 503 löste einen Wiederholungssturm aus |

Der Körper bleibt in allen Fällen `{ error, reason, detail, remediation }`.
Abnahmezeile `5a` prüft den Status mit, nicht nur „nicht 200": ein 401 wäre
sonst grün.

A4 ist präzisiert: die ursprüngliche Zeile fragte nach „höchstens 10 Variablen"
und maß damit das falsche Kriterium. Die Shell **im Worker** sieht 55, weil das
SDK seine eigenen `NON_INTERACTIVE_ENV`-Defaults hinzufügt (alle Pager auf
`cat`, `CI=true`, `GIT_TERMINAL_PROMPT=0`, npm/pip-Schalter — keine
Geheimnisse). Der Vertrag aus §11 lautet „die Shell erbt keine
Dienstgeheimnisse", und das ist es, was gemessen wird.

### 13.3 Defekte, die die Messung gefunden hat

Die ersten beiden waren nicht im Entwurf, sondern im ersten Lauf; die letzten
beiden kamen beim Abschluss des Branches dazu und waren **ausnutzbar**:

**Der Modus des Transcripts.** Die Datei einer In-Process-Mandanten-Session war
`0644`. `persistBashOnlySession` schrieb ohne `mode` und erbte die umask des
Prozesses; zusätzlich öffnet das SDK die `.jsonl` mit `O_CREAT` **ohne** Modus
(`session-storage.ts:316-321`), sodass ein `chmod` nach dem Schreiben ein Rennen
gegen den nächsten Append wäre. Jetzt `mode: 0o600` beim Anlegen **und** ein
Nachziehen des Mandanten-Baums nach jedem `bash`-Lauf.

**Der Ausstieg, der nichts bewiesen hätte.** `--mode opt-out` war grün, sobald
die Session startete und die stderr-Zeile existierte. Beides wäre auch dann wahr,
wenn der Code das Flag ignoriert. Zeile `6c` misst deshalb das Gegenteil der
A-Zeilen: das fremde Konto **muss** sichtbar sein (gemessen: sichtbar, fremdes
Archiv lesbar, Session-Key lesbar, 6 fremde lesbare Dateien). Ein Flag, das
nichts tut, macht den Lauf jetzt rot.

**Das Arbeitsverzeichnis des Workers war `/tmp`.** `bwrap --chdir /home/<name>`
setzt das cwd des Prozesses; die SDK-CLI fasst es danach wieder an
(`src/cli/startup-cwd.ts:11-42`: ein Start im Home gilt als „der Benutzer wollte
ein Projekt, nicht sein Home" und zieht nach `<home>/tmp`, `/tmp` oder
`/var/tmp` um). Ein Mandant, dessen Arbeitsverzeichnis `/tmp` ist, verliert seine
Dateien beim Abräumen des Workers und teilt ein welt-beschreibbares Verzeichnis.
`--allow-home` ist der dokumentierte Ausweg desselben Codes. Gemessen an der CLI
allein, ein Argument Unterschied: ohne Flag `workingDir=/tmp`, mit Flag das
Home. Im Worker belegen es drei Proben zugleich — `readlink /proc/self/cwd`,
`/bin/pwd -P` und `$PWD` (Abnahmezeile `A11`); `$PWD` allein wäre eine
Behauptung der Shell.

**Eine selbst geschriebene Session-Kopfzeile verschaffte jede Datei-Wurzel.**
Das Archiv eines Kontos liegt in seinem Home (0700, aber von seiner eigenen Bash
beschreibbar). Eine Datei darin, deren zweite Zeile
`{"type":"session","cwd":"/"}` ist, trug ihren `cwd` ungefiltert in
`getAllowedFileRoots`: der Besitzfilter lief nur über den Prozess-Baum, nicht
über das Mandanten-Archiv. Gemessen an einem Scratch-Server antwortete danach
`GET /api/files/etc/passwd?type=read` mit **200**, und dieselbe Route gab die
44-Byte-Datei `omp-web-session-key` heraus — aus einem Leser wurde die Fälschung
beliebiger Cookies, auch des Admins. Geschlossen an zwei Stellen: das Archiv
filtert mit derselben Besitzregel wie der Prozess-Baum, und
`getAllowedFileRoots` nimmt einen `cwd` für einen Nicht-Admin nur noch als
Wurzel, wenn er in dessen Home liegt. Zeile `A12` schreibt den Angriff und
prüft, dass er `403` bekommt.

**Die Session-Kopfzeile nannte den Quellbaum des Betreibers.** Der Server öffnet
das Transcript mit `SessionManager.open`; ohne `initialCwd` fällt das SDK auf
`getProjectDir()` zurück — den cwd des Serverprozesses. Gemessen:
`"cwd":"/home/pi/workspace/omp-web-iso"` in der Kopfzeile einer
Mandanten-Session, und `/api/sessions` zeigte ihn als `cwd` **und**
`projectRoot`. Über denselben Wurzel-Pfad wie oben wurde daraus eine erlaubte
Datei-Wurzel. Jetzt geht der Konto-Pfad als `initialCwd` mit.

### 13.4 Was **nicht** verifiziert ist

- **Nur ein Host.** Alles oben ist auf `agent-pc` (LXC 101, bubblewrap 0.12.0)
  gemessen. Ob `unprivileged_userns_clone` auf einem anderen Zielhost gesetzt
  ist, ist offen — bis dahin ist der Betrieb dort **fail-closed**: keine
  Mandanten-Session. Das ist die richtige Richtung, aber eine Betriebsänderung.
- **Landlock ist unbelegt** (§6). `/sys/kernel/security` existiert im LXC nicht,
  `landlock` fehlt in `/proc/self/status`. Kein ABI-Level gemessen, also keine
  Zusage.
- **Kein echter Modellaufruf.** Alle Läufe sind modellfrei: `ensure_session` und
  `bash` gehen über den RPC-Pfad, ohne Turn und ohne Token. Ein vollständiger
  Chat durch einen Worker ist **nicht** gemessen; die Fixtures benutzen ein
  Dummy-Modell auf `127.0.0.1:9` (discard), damit ein versehentlicher Aufruf
  scheitert statt in ein Netz zu gehen.
- **Der Admin-Pfad ist unverändert**, also auch unverändert ungeschützt (§12).
- **Kein Deploy.** Nichts davon läuft auf der Live-Installation; der Branch ist
  lokal, ohne Tag und ohne Push.
- **Die beiden Grenzverletzungen aus §13.3 sind auf diesem Host belegt** —
  gegen einen Scratch-Server mit eigener `OMP_WEB_HOME_ROOT`, nicht gegen einen
  Host ohne User-Namespaces und nicht gegen einen zweiten Host.
- **Das Test-Gate ist grün**: 3012 Tests, 0 Fehlschläge, 3 Skip, 85,9 % der
  Funktionen ausgeführt, Gate „bestanden".

### 13.5 Restrisiken

Ein Worker kostet **rund 265 MiB RSS, 364 MiB Spitze** (nachgemessen am
laufenden Worker: `VmRSS 271524 kB`, `VmHWM 372868 kB` aus `/proc/<pid>/status`
am inneren `bun`; die beiden `bwrap`-Hüllen daneben kosten je ~1,5 MiB) und
~1–1,2 s Start. Vier Worker planen damit auf der Spitze (~1,4 GiB), nicht auf
dem Ruhewert (~1,0 GiB). Die Grenze teilt den
Netzwerk-Stack; **der Mandant kann seinen eigenen Provider-Schlüssel lesen** —
der Modellaufruf passiert im selben Prozess wie die Tool-Shell, und ohne einen
Modell-Proxy laesst sich das nicht schliessen —, aber keinen fremden;
Admin = Host bleibt eine getroffene Entscheidung.

**Die Grenze haengt an User-Namespaces.** Ohne sie startet kein Worker, und
fail-closed heisst dann: **keine Mandanten-Session auf diesem Host**. Das ist
die richtige Richtung, aber eine Betriebsaenderung fuer jeden Zielhost, auf dem
`unprivileged_userns_clone` aus ist.

**Was ausdruecklich NICHT gebaut ist** (aus §6/§7, damit die Liste nicht
veraltet):

- **L2 (ein Prozess je serverseitigem Kindprozess) ist nicht gebaut.** Der
  Worker faengt den Agenten; Kindprozesse, die der **Server** startet
  (MCP-stdio, `task`-Subagenten im Prozesspfad), laufen weiter im Dienstprozess.
- **L3 (eigene unix-uid je Mandant) ist nicht gebaut.** Alle Konten laufen als
  `uid=1000(pi)`; 0600 schuetzt deshalb innerhalb des Hosts nichts. Die Grenze
  kommt allein aus der User-Namespace und dem einen gebundenen Home.
- **Landlock ist nicht gebaut und nicht gemessen** (siehe oben).

**Die Namespace-Probe (`lib/tenant-namespace-probe.ts`) misst die Grenze, statt
sie aus der PID zu schliessen.** Sie beweist, dass die Mount-Namespace des
Workers das Dienst-Home wirklich verbirgt: ab der gemeldeten PID — auf diesem
Host der äussere `bwrap`, dessen `/proc/<pid>/root` noch dem Host entspricht —
wird abwärts der Prozess gesucht, dessen Wurzel ein anderes Geräte-/Inode-Paar
als `/` trägt, und dort muss `/proc/<pid>/root/home` genau den Gastnamen
enthalten und das Home des Dienstbenutzers (`os.userInfo().username`)
vermissen lassen; sie beweist **nicht**, dass der Prozessbaum echt ist, denn ein
absichtlich gefälschtes `/proc` liegt ausserhalb des Bedrohungsmodells, das
gegen einen Mandanten schützt und nicht gegen den Betreiber der Maschine; und
`boundary.enforced: true` steht seitdem nur noch nach einer bestandenen Probe —
eine fehlgeschlagene endet mit `boundary-not-enforced`, beendet den
Prozessbaum und nennt einen Wrapper oder eine mitgelieferte `bwrap`-Kopie
früher im `PATH` als wahrscheinliche Ursache.
