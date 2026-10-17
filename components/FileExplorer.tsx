"use client";

import { forwardRef, useState, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef } from "react";
import {
  Tree,
  type CursorProps,
  type DragPreviewProps,
  type NodeApi,
  type NodeRendererProps,
  type RowRendererProps,
  type TreeApi,
} from "react-arborist";
import { getFileIcon, FolderIcon } from "./FileIcons";
import { createPortal } from "react-dom";
import { Pressable } from "./motion/Pressable";
import { Skeleton } from "./motion/Skeleton";
import windowStyles from "./FileExplorerWindow.module.css";
import {
  encodeFilePathForApi,
  getFileDirectory,
  getFileName,
  getRelativeFilePath,
  joinFilePath,
  normalizeFilePathSlashes,
} from "@/lib/file-paths";
import type { GitFileStatus, GitFileStatusKind, GitStatusResponse } from "@/lib/git-types";
import { isArchivePath, isImagePath } from "@/lib/file-types";
import { FileActionToast, FileContextMenu, type FileActionNotice, type FileMenuTarget } from "./FileContextMenu";
import { FileBrowserDialog } from "./FileBrowserDialog";
import { FileImagePreview } from "./FileImagePreview";
import { FileViewer } from "./FileViewer";
import { TabBar, type FileTab } from "./TabBar";
import { useI18n } from "@/hooks/useI18n";
import { ModalBackdrop, ModalPanel, Spin } from "./motion/Enter";
type Translate = ReturnType<typeof useI18n>["t"];

/**
 * Ein fuer die Toolbar ausgewaehlter Baumknoten. Der Pfad genuegt als Schluessel,
 * Name und Ordner-Flag werden beim Klick mitgefuehrt, damit die Werkzeuge ohne
 * Rueckgriff auf den Baum auskommen.
 */
interface SelectionEntry {
  path: string;
  name: string;
  isDir: boolean;
}

/**
 * Der Blick auf den Baum: welcher Ordner oben steht und welche Aeste offen sind.
 * Er wandert als Prop von einer Instanz zur anderen, damit das grosse Fenster
 * seine Position nicht bei jedem Oeffnen verliert — es wird beim Schliessen aus
 * dem DOM entfernt, sein Zustand also nicht vom React-State behalten.
 */
export interface ExplorerViewState {
  currentPath: string;
  expandedPaths: Set<string>;
  /**
   * Die besuchten Ordner als ein Stack mit Zeiger, nicht als zwei Stapel
   * fuer zurueck und vorwaerts. Zwei Stapel laufen auseinander, sobald man
   * zurueckblättert und dann irgendwo neu hinspringt: der Vorwaerts-Stapel
   * wuerde stehen bleiben, während der zurueck bereits die neue Richtung
   * beschreibt. Mit einem Index ist die Vergangenheit unabhaengig von der
   * Zukunft, und ein Sprung schneidet einfach alles hinter dem Index ab.
   *
   * Der Stack gehoert zum Blick und damit zum Zustand des Fensters: das
   * Fenster wird beim Schliessen aus dem DOM entfernt, und ohne diese
   * Prop kaeme es beim naechsten Oeffnen mit leerer Historie zurueck.
   */
  history: NavigationHistory;
}

/**
 * Besuchte Ordner, chronologisch, plus der Index des gerade gezeigten. Der
 * Index ist immer ein gueltiger Eintrag: `paths` ist nie leer, und jeder
 * Spritzger schreibt beide Seiten gemeinsam.
 */
export interface NavigationHistory {
  paths: string[];
  index: number;
}

/**
 * Baut den Historie-Anfang zu einem Ordner. Wird an drei Stellen gebraucht —
 * Erstmontage, Projektwechsel, Zuruecksetzen — und die Regeln des
 * Abschneidens gehoeren an genau einer Stelle, nicht an drei.
 */
function historyStartingAt(path: string): NavigationHistory {
  return { paths: [path], index: 0 };
}

/**
 * Zwei Blicke gelten als gleich, wenn Pfad, aufgeklappte Ordner und Historie
 * uebereinstimmen. Der Vergleich entscheidet darueber, ob eine Meldung den
 * Zustand der aeusseren Instanz ueberhaupt anfasst: gibt der Melder denselben
 * Inhalt zurueck, bleibt der Zustand gleich und React rendert nicht neu.
 * Ohne diese Pruefung wuerden Fenster und Meldung einander hochschaukeln.
 *
 * Die Historie gehoert ausdruecklich dazu: nach einem Blaettern zurueck und
 * wieder vorwaerts steht zwar `currentPath` kurzzeitig wieder auf demselben
 * Wert wie vorher, die Historie aber nicht. Ohne ihren Vergleich wuerde das
 * Fenster seinen gemeldeten Stand verlieren und beim Schliessen genau dort
 * wieder aufnehmen, wo der Nutzer ihn bereits verlassen hatte.
 */
function sameViewState(a: ExplorerViewState, b: ExplorerViewState): boolean {
  if (a.currentPath !== b.currentPath) return false;
  if (a.expandedPaths.size !== b.expandedPaths.size) return false;
  for (const path of a.expandedPaths) if (!b.expandedPaths.has(path)) return false;
  if (a.history.index !== b.history.index) return false;
  if (a.history.paths.length !== b.history.paths.length) return false;
  for (let i = 0; i < a.history.paths.length; i++) {
    if (a.history.paths[i] !== b.history.paths[i]) return false;
  }
  return true;
}

interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  modified: string;
}

interface FileNode {
  name: string;
  fullPath: string;
  isDir: boolean;
  size: number;
  children?: FileNode[];
  loaded?: boolean;
}

interface Props {
  cwd: string;
  onOpenFile: (filePath: string, fileName: string, options?: OpenFileOptions) => void;
  refreshKey?: number;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onAtMentions?: (relativePaths: string[]) => void;
  /**
   * Zusaetzlicher Refresh der Umgebung. Die eigene Toolbar laedt den Baum ohnehin
   * neu; darueber hinaus braucht der Refresh-Button aber auch die Aussenwelt
   * (Git-Stand im Datei-Tab) im Takt. Ohne den Callback bleibt es beim lokalen
   * Nachladen.
   */
  onRefresh?: () => void;
  changesCollapsed: boolean;
  onChangesCountChange?: (count: number) => void;
  /**
   * Startzustand des Baums fuer eine Instanz, die nach dem Schliessen wieder
   * gemountet wird. Setzt die aufrufende Instanz den Wert, beginnt der Baum bei
   * diesem Pfad mit genau diesen offenen Aesten; der geladene Baum selbst wird
   * trotzdem neu geholt.
   */
  initialViewState?: ExplorerViewState;
  /**
   * Meldet jede Aenderung an Pfad und offenen Aesten nach aussen. Zusammen mit
   * `initialViewState` laesst sich damit eine Instanz aus dem DOM nehmen und
   * spaeter mit demselben Blick wieder einsetzen.
   *
   * Es ist ein echter Zustandskanal und kein Benachrichtigungs-Flag: der Melder
   * entscheidet, was an den Zustand der aufrufenden Instanz weitergegeben wird.
   * Wegen `sameViewState` entsteht dabei kein Pingpong, und weil der Baum erst
   * nach dem Mount geladen wird, kann der Melder nie eine `currentPath` melden,
   * die die Lade-Anfrage nicht kennt.
   */
  onViewStateChange?: (view: ExplorerViewState) => void;
  /**
   * Unterdrueckt den Knopf, der den Explorer in ein eigenes Fenster oeffnet.
   * Die Instanz im Fenster setzt das: ein Explorer im Explorer, der sich selbst
   * oeffnen darf, waere ein Klick ohne Ende.
   */
  allowPopup?: boolean;
  /**
   * Wohin ein Klick auf eine Bilddatei fuehrt.
   *
   * `"preview"` (Vorgabe) oeffnet die grosse Bildvorschau ueber der Seite — das
   * Verhalten der Seitenleiste, unveraendert. `"openFile"` schickt das Bild
   * stattdessen an `onOpenFile`, also in einen Tab des aufrufenden Fensters.
   * Die Instanz im Fenster setzt `"openFile"`: dort sollen Bilder wie jede
   * andere Datei als Tab landen, nicht in einem zweiten Overlay.
   *
   * Der Schalter liegt an der Instanz und nicht an `onOpenImage`, weil das kein
   * Prop ist, sondern der interne Zustandsschreiber — ein Uebergeben von aussen
   * gibt es dort nicht.
   */
  imageTarget?: "preview" | "openFile";
  /**
   * Meldet, ob das grosse Fenster offen ist. Die Instanz in der Seitenleiste
   * braucht das fuer ihre Resizer: waehrend das Fenster ueber der Seite liegt,
   * duerfen die Trennlinien der Seitenleiste weder sichtbar sein noch
   * bedienbar, sonst aendert der Nutzer beim Zielen auf das Fenster die
   * Seitenbreite.
   *
   * Ein Kanal und kein gemeinsamer Zustand: `FileExplorerWindow` lebt im
   * Zustand dieser Instanz (`popupOpen`), und der Zustand, der die Seitenleiste
   * betrifft, liegt in `AppShell`. Ein Kanal haelt die beiden getrennt.
   */
  onPopupOpenChange?: (open: boolean) => void;
}

export interface FileExplorerHandle {
  openUploadPicker: () => void;
}

type UploadPhase = "idle" | "checking" | "uploading";
type UploadConflictStrategy = "error" | "overwrite" | "skip";

interface UploadError {
  name: string;
  error: string;
}

interface UploadResponse {
  uploaded?: string[];
  skipped?: string[];
  errors?: UploadError[];
  conflicts?: string[];
  nonReplaceable?: string[];
  error?: string;
}

interface UploadSummary {
  uploaded: string[];
  skipped: string[];
  errors: UploadError[];
  /**
   * Der Ordner, in den tatsaechlich geschrieben wurde. Die Namen im Chat
   * muessen weiterhin relativ zur Projektwurzel sein, weil das Modell sie
   * gegen das Arbeitsverzeichnis aufloest — dafuer braucht es diesen
   * Schnappschuss, nicht das spaeter gelesene `currentPath`.
   */
  directory: string;
}

interface PendingConflict {
  files: File[];
  /**
   * Der Ordner, in den geschrieben werden soll — beim Start des Uploads
   * mitgenommen und nicht neu aus dem Navigationszustand gelesen. Der
   * Konflikt-Dialog kann offen bleiben, waehrend der Nutzer im Baum weiterklickt;
   * ohne diesen Schnappschuss wuerde "Ersetzen" in einen inzwischen anderen
   * Ordner schreiben als den, dessen Bestand der Dialog gerade zeigt.
   */
  directory: string;
  conflicts: string[];
  nonReplaceable: string[];
}

/**
 * Rechte Kanten der absoluten Hover-Knöpfe einer Baumzeile, in Pixeln.
 *
 * Die Knöpfe stehen nebeneinander am rechten Zeilenrand. Von rechts nach links:
 * Download (4), grosse Vorschau (30), Mention (58 bei Dateien, 4 bei Ordnern).
 * Die beiden Bildwerkzeuge sind 22 Pixel breit (20 plus je ein Pixel Rahmen),
 * der Download-Anker 23 (5 Pixel Polster links und rechts um ein 11-Pixel-Zeichen
 * plus Rahmen). Zwischen den 22-Pixel-Knoepfen bleiben damit 4 Pixel Luft, und
 * die Kante des 23-Pixel-Ankers liegt genau an der linken Kante des
 * Bildknopfes.
 *
 * Fuer Archivzeilen gilt die Tabelle nicht: ihr Download-Knopf ist kein
 * Hover-Knopf, sondern steht im Fluss hinter dem Git-Kuerzel (siehe
 * `downloadAlwaysVisible` in `FileTreeLabel`). Die absoluten Kanten werden
 * dort nicht ausgewertet — sie wuerden ihn neben den Git-Status ziehen.
 *
 * Die Mention-Schaltflaeche traegt Text und ist je nach Sprache unterschiedlich
 * breit; sie steht deshalb ganz links. Ihre Breite kann so wachsen, wie es die
 * Uebersetzung verlangt, ohne einen Nachbarn zu ueberdecken.
 */
const ROW_ACTION_RIGHT_DOWNLOAD = 4;
const ROW_ACTION_RIGHT_IMAGE = 30;
const ROW_ACTION_RIGHT_MENTION_FILE = 58;
const ROW_ACTION_RIGHT_MENTION_DIR = 4;

/**
 * Id des festen Explorer-Tabs im grossen Fenster.
 *
 * Bewusst eine Konstante und nicht `file:${cwd}`: der Tab muss ueber Oeffnen
 * und Schliessen des Fensters hinweg derselbe bleiben. Mit dem Pfad als Id
 * waere er nach jedem Ordnerwechsel ein anderer, und `handleCloseTab` koennte
 * ihn nicht an der Form, sondern nur an einem zufaelligen Vergleich erkennen.
 */
const EXPLORER_TAB_ID = "explorer:root";

async function fetchEntries(dirPath: string): Promise<FileNode[]> {
  const encoded = encodeFilePathForApi(dirPath);
  const res = await fetch(`/api/files/${encoded}?type=list`);
  if (!res.ok) {
    let message = `Failed to load files (HTTP ${res.status})`;
    try {
      const data = await res.json() as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // ignore non-JSON error bodies
    }
    throw new Error(message);
  }
  const data = await res.json() as { entries?: FileEntry[] };
  return (data.entries ?? []).map((e) => ({
    name: e.name,
    fullPath: joinFilePath(dirPath, e.name),
    isDir: e.isDir,
    size: e.size,
    children: e.isDir ? [] : undefined,
    loaded: !e.isDir,
  }));
}

async function fetchGitStatus(cwd: string): Promise<GitStatusResponse> {
  const params = new URLSearchParams({ cwd });
  const res = await fetch(`/api/git/status?${params.toString()}`);
  if (!res.ok) throw new Error(`Failed to load Git status (HTTP ${res.status})`);
  return res.json() as Promise<GitStatusResponse>;
}

const GIT_STATUS_KEYS: Record<GitFileStatusKind, string> = {
  modified: "files.modified",
  added: "files.added",
  deleted: "files.deleted",
  renamed: "files.renamed",
  untracked: "files.untracked",
  conflict: "files.conflict",
};

const GIT_STATUS_COLORS: Record<GitFileStatusKind, string> = {
  modified: "#d6a84b",
  added: "#4ade80",
  deleted: "#f87171",
  renamed: "#60a5fa",
  untracked: "#4ade80",
  conflict: "#f87171",
};

function GitStatusBadge({ status, t }: { status: GitFileStatus; t: Translate }) {
  return (
    <span
      title={t(GIT_STATUS_KEYS[status.status])}
      aria-label={t(GIT_STATUS_KEYS[status.status])}
      style={{
        width: 14,
        height: 14,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: GIT_STATUS_COLORS[status.status],
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        fontWeight: 600,
      }}
    >
      {status.code}
    </span>
  );
}

function uploadFiles(
  targetDirectory: string,
  files: File[],
  strategy: UploadConflictStrategy,
  onProgress: (progress: number) => void,
): Promise<{ status: number; data: UploadResponse }> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    files.forEach((file) => formData.append("files", file, file.name));

    const xhr = new XMLHttpRequest();
    xhr.open(
      "POST",
      `/api/files/${encodeFilePathForApi(targetDirectory)}?type=upload&conflict=${strategy}`,
    );
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onerror = () => reject(new Error("Network error while uploading files"));
    xhr.onabort = () => reject(new Error("Upload cancelled"));
    xhr.onload = () => {
      let data: UploadResponse = {};
      try {
        data = JSON.parse(xhr.responseText) as UploadResponse;
      } catch {
        if (xhr.responseText) data.error = xhr.responseText;
      }
      resolve({ status: xhr.status, data });
    };
    xhr.send(formData);
  });
}

function MentionIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
    </svg>
  );
}

/**
 * Spreizendes Bild als Zeichen fuer die grosse Vorschau. Bewusst nicht das
 * Dateityp-Symbol der Zeile: es steht zusammen mit Mention und Download auf
 * der Zeile und muss als Werkzeug erkennbar sein, nicht als Inhalt.
 */
function ImageOpenIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

function DismissButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <Pressable
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{ width: 24, height: 24, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: "none", borderRadius: 4, background: "none", color: "var(--text-dim)", cursor: "pointer" }}
      onMouseEnter={(event) => { event.currentTarget.style.color = "var(--text-muted)"; event.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(event) => { event.currentTarget.style.color = "var(--text-dim)"; event.currentTarget.style.background = "none"; }}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
        <path d="m6 6 12 12" />
        <path d="m18 6-12 12" />
      </svg>
    </Pressable>
  );
}

/** Bytestaende mit 1024er-Stufen, sonst sind grosse Dateien unlesbar. */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

interface FileMeta {
  size: number;
  mime: string;
  language: string;
}

/**
 * Eigenschaften eines Eintrags: Name, Ort, Groesse und Typ.
 *
 * `?type=meta` beantwortet nur Dateien und lehnt Ordner mit 400 ab, darum
 * fragt der Dialog fuer Ordner ueber `?type=list` und zeigt die Zahl der
 * enthaltenen Eintraege. Eine Aenderungszeit liefert keine der beiden Routen
 * (das Listing fuellt `modified` bewusst nicht, `meta` kennt kein mtime) —
 * sie wuerde hier erfunden, also bleibt die Zeile weg.
 */
function PropertiesDialog({ target, onClose, t }: { target: SelectionEntry; onClose: () => void; t: Translate }) {
  const [meta, setMeta] = useState<FileMeta | null>(null);
  const [itemCount, setItemCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    let cancelled = false;
    const query = target.isDir ? "list" : "meta";
    setMeta(null);
    setItemCount(null);
    setError(null);
    void fetch(`/api/files/${encodeFilePathForApi(target.path)}?type=${query}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({})) as Partial<FileMeta> & { entries?: unknown[]; error?: string };
        if (cancelled) return;
        if (!res.ok) { setError(data.error ?? `HTTP ${res.status}`); return; }
        if (target.isDir) { setItemCount(data.entries?.length ?? 0); return; }
        setMeta({ size: data.size ?? 0, mime: data.mime ?? "", language: data.language ?? "" });
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { cancelled = true; };
  }, [target]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    panelRef.current?.focus();
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <ModalBackdrop
      data-nested-overlay
      style={{ position: "fixed", inset: 0, zIndex: 1100, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)" }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <ModalPanel
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{
          width: 360,
          maxWidth: "calc(100vw - 32px)",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          padding: 14,
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          boxShadow: "0 8px 32px rgba(0,0,0,0.22)",
          outline: "none",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
            {target.isDir ? <FolderIcon size={18} /> : getFileIcon(target.name, 18)}
          </span>
          <span id={titleId} style={{ minWidth: 0, fontSize: 13, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {target.name}
          </span>
        </div>

        <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "5px 12px", margin: 0, fontSize: 11, minWidth: 0 }}>
          <dt style={{ color: "var(--text-dim)" }}>{t("files.propertiesName")}</dt>
          <dd style={{ margin: 0, color: "var(--text)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>{target.name}</dd>

          <dt style={{ color: "var(--text-dim)" }}>{t("files.propertiesPath")}</dt>
          <dd style={{ margin: 0, color: "var(--text)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>{target.path}</dd>

          <dt style={{ color: "var(--text-dim)" }}>{t("files.propertiesSize")}</dt>
          <dd style={{ margin: 0, color: "var(--text)", fontFamily: "var(--font-mono)" }}>
            {error
              ? "—"
              : meta
                ? formatFileSize(meta.size)
                : target.isDir
                  ? itemCount === null ? "…" : t("files.propertiesSizeFolder", { count: itemCount })
                  : "…"}
          </dd>

          <dt style={{ color: "var(--text-dim)" }}>{t("files.propertiesType")}</dt>
          <dd style={{ margin: 0, color: "var(--text)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
            {target.isDir
              ? t("files.propertiesFolder")
              : error ? "—" : meta ? (meta.mime || "—") : "…"}
          </dd>

          {!target.isDir && !error && meta?.language && (
            <>
              <dt style={{ color: "var(--text-dim)" }}>{t("files.propertiesLanguage")}</dt>
              <dd style={{ margin: 0, color: "var(--text)", fontFamily: "var(--font-mono)" }}>{meta.language}</dd>
            </>
          )}
        </dl>

        {error && (
          <div role="alert" style={{ fontSize: 11, color: "var(--danger)", overflowWrap: "anywhere" }}>
            {t("files.propertiesLoadFailed")}: {error}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Pressable
            type="button"
            onClick={onClose}
            style={{
              height: 24,
              padding: "0 10px",
              border: "1px solid var(--border)",
              borderRadius: 4,
              background: "transparent",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            {t("files.cancel")}
          </Pressable>
        </div>
      </ModalPanel>
    </ModalBackdrop>
  );
}

/**
 * Was ein Tab anzeigt, in dem noch keine Datei steht.
 *
 * KEIN `FileViewer` mit leerem `filePath`. Der Viewer laedt den Pfad sofort:
 * ein leerer ergibt einen Fehler, und der Nutzer saehe eine rote Meldung an
 * der Stelle, an der er gerade auf "Neuer Tab" geklickt hat — die Anzeige
 * wuerde den Klick als Fehlschlag melden, obwohl er geklappt hat.
 *
 * Stattdessen zwei Wege zur Datei, beide im Fenster:
 *
 * - Der Baum links ist ohnehin da. Ein Klick dort fuellt diesen Tab, weil
 *   `handleOpenFile` einen leeren Tab zuerst befuellt und erst danach einen
 *   zweiten anlegt. Der Text hier sagt das dem Nutzer, weil es nicht
 *   offensichtlich ist.
 * - Das Pfadfeld fuer den Fall, dass die Datei weit weg liegt und der Weg
 *   durch die Ordner zu lang waere. `FileBrowserDialog` waere dafuer zu
 *   gross: es ist ein Modal ueber allem, waehrend hier die zweite Spalte des
 *   Fensters genau die freie Flaeche ist, die gefuellt werden soll.
 */
function EmptyTabView({
  startPath,
  onPick,
  t,
}: {
  /** Ordner, in dem der Tab angelegt wurde — dort startet auch das Feld. */
  startPath: string;
  onPick: (filePath: string) => void;
  t: Translate;
}) {
  const [path, setPath] = useState(startPath);

  // Beim Schliessen eines leeren Tabs kann ein zweiter leerer Tab derselbe
  // Komponente sein; ihr Zustand muss dann dem neuen Startordner folgen,
  // sonst zeigte das Feld den Pfad eines Tabs, den es nicht mehr gibt.
  useEffect(() => setPath(startPath), [startPath]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 14,
        height: "100%",
        padding: 24,
        textAlign: "center",
      }}
    >
      <div style={{ color: "var(--text-dim)", fontSize: 12, lineHeight: 1.5, maxWidth: 280 }}>
        {t("files.explorerWindowPickFile")}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          // Leer eingetragen waere ein Dateiname ohne Verzeichnis, und der
          // Viewer wuerde daran scheitern. Ohne Eingabe passiert deshalb gar
          // nichts, statt eine Fehlermeldung zu produzieren.
          if (path.trim()) onPick(path.trim());
        }}
        style={{ display: "flex", gap: 6, width: "100%", maxWidth: 420 }}
      >
        <input
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder={startPath}
          aria-label={t("files.explorerWindowOpenPath")}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          style={{
            flex: 1,
            minWidth: 0,
            height: 26,
            padding: "0 8px",
            border: "1px solid var(--border)",
            borderRadius: 4,
            background: "var(--bg)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
          }}
        />
        <Pressable
          type="submit"
          disabled={!path.trim()}
          style={{
            height: 26,
            padding: "0 10px",
            flexShrink: 0,
            border: "1px solid var(--border)",
            borderRadius: 4,
            background: "transparent",
            color: "var(--text-muted)",
            cursor: path.trim() ? "pointer" : "not-allowed",
            opacity: path.trim() ? 1 : 0.45,
            fontSize: 11,
            fontWeight: 600,
          }}
        >
          {t("files.explorerWindowOpenPath")}
        </Pressable>
      </form>
    </div>
  );
}

/**
 * Der KOMPLETTE Explorer in einem grossen, zentrierten Fenster.
 *
 * Bewusst kein Bild-Popup und kein Dialog mit einer Bestaetigung: hier steht
 * der ganze Explorer — Baum, Breadcrumb, Toolbar, Aenderungsliste, Git-Status.
 * Die Bildvorschau rendert die Instanz darin selbst, weil sie deren
 * Preview-State besitzt; dieses Fenster gibt es dafuer nicht noch einmal.
 *
 * Sie bleibt bewusst eine eigene Komponente in dieser Datei. `PropertiesDialog`
 * oben steht aus demselben Grund hier, und beide bekommen die Daten ueber
 * Props statt ueber einen gemeinsamen Zustand.
 *
 * Eigener Dateizustand, nicht der des Hauptpanels. Ein Klick auf eine Datei
 * im Fenster oeffnet einen Tab *hier* und sonst nirgends: `handleOpenFile`
 * unten setzt genau diesen State und ruft nichts von aussen. Vorher lief
 * derselbe Aufruf durch wie in der Seitenleiste, landete also im rechten
 * Panel der Hauptseite — der Nutzer sah die Datei nie, waehrend er im
 * Explorer stand. Der Tab-Zustand gehoert diesem Fenster und wird mit ihm
 * aus dem DOM entfernt; beim naechsten Oeffnen ist er leer. Das ist gewollt:
 * es ist ein Arbeitswerkzeug fuer einen Durchgang, kein dauerhafter
 * Dateistapel. Wer das Fenster behalten will, laesst es offen.
 *
 * Die Fenster-Instanz bekommt kein `onAtMention`/`onAtMentions`. Eine Mention
 * aus einem Fenster heraus schreibt in den Chat, den der Nutzer gar nicht
 * ansieht; die Seitenleiste bleibt der Ort, von dem aus man den Chat fuellt.
 * Aus demselben Grund bekommen die Tabs hier auch kein `onMentionLines` und
 * kein `onAtMention` im `FileViewer`.
 */
function FileExplorerWindow({
  cwd,
  changesCollapsed,
  initialViewState,
  onViewStateChange,
  onClose,
  t,
}: {
  cwd: string;
  changesCollapsed: boolean;
  initialViewState?: ExplorerViewState;
  onViewStateChange: (view: ExplorerViewState) => void;
  onClose: () => void;
  t: Translate;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  /**
   * Wohin das Fenster gerendert wird. `null`, solange es den Server nicht
   * gibt — dort existiert `document` nicht, und ein Render dorthin waere ein
   * harter Absturz beim Build.
   *
   * Das Portal ist keine Formalie: die Sidebar, in der diese Komponente
   * haengt, setzt `overflow-x: hidden` auf ihren Explore-Behaelter, und das
   * schneidet jedes Fenster am Rand der Sidebar ab. `position: fixed` loest das
   * nicht, denn es bezieht sich nur dann auf das Fenster, wenn kein Vorfahr
   * clippt. An `document.body` haengend liegt es ueber allem. Dasselbe Muster
   * nutzen `DirectoryPicker` und `FileContextMenu`.
   */
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const titleId = useId();
  const [tabs, setTabs] = useState<FileTab[]>(() => [
    { kind: "explorer", id: EXPLORER_TAB_ID, label: t("files.explorerWindowTitle"), filePath: "" },
  ]);
  const [activeTabId, setActiveTabId] = useState<string | null>(EXPLORER_TAB_ID);
  // Zaehler fuer die Ids der leeren Tabs. Ein Ref und kein State, weil er
  // nichts anzeigt: er muss nur garantieren, dass zwei leere Tabs nie dieselbe
  // Id bekommen. `titleId` steht als Praefix davor, weil `useId` je
  // Fenster-Instanz eindeutig ist — der Zaehler beginnt nach einem Remount
  // wieder bei null, und ohne das Praefix kaemen die Ids zweier Fenster
  // durcheinander.
  const emptyTabSeqRef = useRef(0);
  /**
   * Der Ordner, den der Baum dieses Fensters gerade zeigt — und damit der
   * Startort eines neu angelegten Tabs.
   *
   * Er kommt NICHT aus `initialViewState`. Die Prop klingt nach dem Zustand
   * beim Oeffnen, und das ist sie auch: der Explorer darin liest sie einmal
   * in seinen Startzustand (Zeile 1717) und meldet danach selbst. Dass die
   * Elterninstanz sie zufaellig wieder herueberschreibt, ist eine
   * Nebenwirk ihres eigenen Zustands, nicht ihre Zusage. Hier steht der Pfad
   * deshalb aus dem, was tatsaechlich gemeldet wird.
   */
  const [currentDir, setCurrentDir] = useState(initialViewState?.currentPath ?? cwd);

  // Der Explorer meldet nach aussen; das Fenster haelt denselben Wert noch
  // einmal, weil es ihn fuer den neuen Tab braucht. Beides in einem Aufruf:
  // die Elterninstanz verliert ihren Blick auf den Baum nicht, und hier
  // entsteht kein zweiter Zustand, der auseinanderlaufen koennte.
  const handleViewStateChange = useCallback((view: ExplorerViewState) => {
    setCurrentDir(view.currentPath);
    onViewStateChange(view);
  }, [onViewStateChange]);

  /**
   * Der einzige Weg aus dem Explorer dieses Fensters in einen Tab. Gleiche
   * Tab-Id und gleiche Duplikatregel wie im Hauptpanel (`AppShell.tsx`): ein
   * zweiter Klick auf dieselbe Datei aktiviert den vorhandenen Tab, statt einen
   * zweiten anzulegen. `modeHint` wandert mit, damit ein Klick in der
   * Aenderungsliste weiterhin die Diff-Ansicht oeffnet.
   *
   * `activeTabId` steht in der Abhaengigkeitsliste, weil das Fuellen eines
   * leeren Tabs davon abhaengt, welcher Tab gerade vorne steht. Muster aus
   * `handleCloseTab` unten: der Klick haelt damit die Liste, die der Nutzer
   * gerade sieht.
   */
  const handleOpenFile = useCallback((filePath: string, fileName: string, options?: OpenFileOptions) => {
    const tabId = `file:${filePath}`;
    const modeHint = options?.modeHint;
    setTabs((prev) => {
      const existing = prev.find((tab) => tab.id === tabId);
      // Ein Tab ohne Datei ist ein Platzhalter, kein Ziel. Fuellt ihn der
      // Klick auf eine Datei, wandert die Datei hinein, statt einen zweiten
      // Tab daneben zu bekommen — der Nutzer wollte *diesen* Tab fuellen.
      // Deshalb wird hier nicht angehaengt, sondern ersetzt, und zwar an
      // der Stelle des Platzhalters: waere er in die Mitte der Leiste
      // gesprungen, wuerde die Datei dem Tab entrissen, den der Nutzer
      // gerade ausgewahlt hat.
      const activeIndex = activeTabId === null ? -1 : prev.findIndex((tab) => tab.id === activeTabId);
      // Nur `kind: "file"` zaehlt als Platzhalter. Der Explorer-Tab hat auch
      // ein leeres `filePath`, ist aber keiner: ohne diese Pruefung loeste sich
      // ein Klick auf eine bereits geoeffnete Datei in sich selbst auf und
      // riss den Explorer-Tab aus der Leiste — der Nutzer haette danach keinen
      // Weg mehr zurueck in den Baum.
      const hasPlaceholder = activeIndex >= 0
        && prev[activeIndex].kind === "file"
        && prev[activeIndex].filePath === "";

      if (hasPlaceholder) {
        // Die Datei ist an anderer Stelle schon offen. Ein befuellter Tab
        // waere dann eine Dublette neben der Datei, die der Nutzer gerade
        // sieht, also loest sich der Platzhalter auf und der vorhandene
        // Tab wird zum aktiven.
        if (existing) {
          return prev
            .filter((_, index) => index !== activeIndex)
            .map((tab) => (
              tab.id === tabId && modeHint && tab.initialDisplayMode !== modeHint
                ? { ...tab, initialDisplayMode: modeHint }
                : tab
            ));
        }
        return [
          ...prev.slice(0, activeIndex),
          { kind: "file", id: tabId, label: fileName, filePath, initialDisplayMode: modeHint },
          ...prev.slice(activeIndex + 1),
        ];
      }

      if (!existing) {
        return [...prev, { kind: "file", id: tabId, label: fileName, filePath, initialDisplayMode: modeHint }];
      }
      if (!modeHint || existing.initialDisplayMode === modeHint) return prev;
      return prev.map((tab) => (tab.id === tabId ? { ...tab, initialDisplayMode: modeHint } : tab));
    });
    setActiveTabId(tabId);
  }, [activeTabId]);

  /**
   * Legt einen leeren Tab an und stellt ihn voran.
   *
   * Angehaengt wird, nicht eingefuegt: die Tabs eines Fensters wachsen wie im
   * Hauptpanel nach rechts, und die Leiste zeigt den neuesten am rechten
   * Rand, wo er ohne Scrollen erreichbar ist. Das ist dieselbe Regel, nach der
   * eine per Klick geoeffnete Datei hinten landet.
   *
   * Der Tab bekommt den Ordner mit, den der Baum gerade zeigt. Ohne das
   * muesste die Auswahl-Ansicht mit `cwd` starten, also am Projektwurzel, und
   * der Nutzer muesste sich von dort jeden Weg zur Datei neu klicken.
   */
  const handleNewTab = useCallback(() => {
    const id = `empty:${titleId}:${emptyTabSeqRef.current++}`;
    setTabs((prev) => [
      ...prev,
      { kind: "file", id, label: t("files.explorerWindowEmptyTab"), filePath: "", startPath: currentDir },
    ]);
    setActiveTabId(id);
  }, [currentDir, t, titleId]);

  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  // Der Baum erscheint genau dann, wenn sein eigener Tab vorne steht. Ohne
  // aktiven Tab zaehlt das nicht mit: sonst waere nach dem Schliessen des
  // letzten Datei-Tabs der Baum zurueck, obwohl kein Tab ihn mehr beschreibt.
  const showExplorer = activeTab?.kind === "explorer";

  /**
   * Bewusst zwei getrennte Setter statt eines `setActiveTabId` *innerhalb*
   * des `setTabs`-Updaters: ein Updater muss eine reine Funktion sein, und
   * React ruft es in der Entwicklung zweimal auf, um genau solche
   * Seiteneffekte zu finden. Ausserdem braucht der Nachfolger die Liste
   * *nach* dem Schliessen, und die bekommt man nur aus dem vorigen Zustand.
   * `tabs` steht deshalb in der Abhaengigkeitsliste — so haelt der Klick
   * immer die Liste, die der Nutzer gerade sieht. Muster aus `AppShell.tsx`.
   */
  const handleCloseTab = useCallback((tabId: string) => {
    // Der Explorer-Tab ist der Rueckweg und wird nicht geschlossen. Ohne diese
    // Zeile koennte ein Tastenkuerzel oder ein Rechte-Klick ihn entfernen, und
    // dann gabe es keinen Weg mehr aus einer Datei heraus.
    if (tabId === EXPLORER_TAB_ID) return;
    const next = tabs.filter((tab) => tab.id !== tabId);
    setTabs(next);
    setActiveTabId((current) => {
      if (current !== tabId) return current;
      // Der letzte linke Nachbar wird aktiv, wie im Hauptpanel. Ohne diese
      // Regel waere jeder Klick auf das X ein Sprung in den Leer-Zustand,
      // auch wenn noch sechs Tabs offen sind.
      return next.length > 0 ? next[next.length - 1].id : null;
    });
  }, [tabs]);

  const handleReorder = useCallback((tabId: string, beforeId: string) => {
    // Der Explorer-Tab bleibt links. Waere er verschiebbar, koennte ihn der
    // Nutzer aus dem Fenster schieben und damit den einen Weg zurueck verlieren.
    if (tabId === EXPLORER_TAB_ID) return;
    if (beforeId === EXPLORER_TAB_ID) beforeId = tabs[0]?.id === EXPLORER_TAB_ID ? (tabs[1]?.id ?? beforeId) : beforeId;
    setTabs((prev) => {
      const from = prev.findIndex((tab) => tab.id === tabId);
      if (from < 0) return prev;
      const without = prev.filter((tab) => tab.id !== tabId);
      const to = beforeId ? without.findIndex((tab) => tab.id === beforeId) : without.length;
      if (to < 0) return prev;
      return [...without.slice(0, to), prev[from], ...without.slice(to)];
    });
  }, [tabs]);

  useEffect(() => {
    setPortalTarget(document.body);
  }, []);

  useEffect(() => {
    /**
     * Der Fokus wandert mit dem Portal: der erste Render gibt `null` zurueck,
     * weil es `document.body` auf dem Server nicht gibt. Ohne `portalTarget` in
     * der Abhaengigkeit laeuft dieser Effekt genau einmal, bevor das Panel
     * existiert, und `panelRef.current` ist `null` — der Dialog stuende dann
     * ohne Fokus im Hintergrund und bekäme keinen Tastendruck.
     */
    if (!portalTarget) return;
    panelRef.current?.focus();
  }, [portalTarget]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      /**
       * In diesem Fenster liegen die Dialoge der inneren Explorer-Instanz:
       * Bildvorschau, Zielordner und Properties. Jeder von ihnen hat seinen
       * eigenen `document`-Listener, und `stopPropagation` wirkt zwischen
       * Geschwistern auf demselben Knoten nicht — ein Tastendruck wuerde sonst
       * alle Ebenen auf einmal schliessen. Deshalb entscheidet nicht die
       * Reihenfolge der Listener, sondern das DOM: ist der Tastendruck in
       * einer Ebene gelandet, die selbst noch etwas offen haelt, schliesst
       * dieses Fenster nicht.
       *
       * `preventDefault` genuegt als Signal, weil die Bildvorschau es fuer ihre
       * Zoomtasten setzt, aber nicht fuer Escape. Der Test auf einen tieferen
       * Dialog ist deshalb der verlaessliche: er fragt ab, ob zwischen dem
       * Tastendruck und diesem Fenster noch etwas liegt.
       */
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-nested-overlay]")) return;
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  if (!portalTarget) return null;

  return createPortal(
    <ModalBackdrop
      className={windowStyles.backdrop}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <ModalPanel
        ref={panelRef}
        className={windowStyles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className={windowStyles.header}>
          <span id={titleId} className={windowStyles.title} title={cwd}>
            {t("files.explorerWindowTitle")}: {cwd}
          </span>
          <Pressable
            type="button"
            className={windowStyles.iconButton}
            onClick={onClose}
            title={t("i18n.close")}
            aria-label={t("i18n.close")}
          >
            <svg className={windowStyles.glyph} viewBox="0 0 24 24" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </Pressable>
        </div>

        {/* Leiste und Arbeitsbereich. Die Leiste ist IMMER da, auch ohne
            offene Tabs: vorher stand sie hinter `tabs.length > 0`, und der
            Nutzer sah an einem Fenster ohne Tabs nicht, dass er Dateien hier
            als Tabs oeffnen kann. Ohne die Bedingung bleibt der Knopf an
            derselben Stelle erreichbar, und mit Tabs ist die Leiste wie
            zuvor. */}
        <div className={windowStyles.tabBar}>
          <div className={windowStyles.tabBarScroll}>
            <TabBar
              tabs={tabs}
              activeTabId={activeTabId ?? ""}
              onSelectTab={setActiveTabId}
              onCloseTab={handleCloseTab}
              onReorder={handleReorder}
            />
          </div>
          <button
            type="button"
            className={windowStyles.newTabButton}
            onClick={handleNewTab}
            title={t("files.explorerWindowNewTab")}
            aria-label={t("files.explorerWindowNewTab")}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          {/* Ein Weg zum Baum, der nicht ueber den Tabstrom laeuft. Der
              Explorer-Tab waere zwar da, aber er ist der linke Rand einer
              Leiste, die auf schmalen Fenstern rechts aus dem Bild rollt —
              dieser Knopf bleibt immer an derselben Stelle. Nur sichtbar,
              wenn gerade wirklich etwas anderes offen ist, sonst waere er ein
              Knopf, der nichts aendert. */}
          {!showExplorer && (
            <button
              type="button"
              className={windowStyles.newTabButton}
              onClick={() => setActiveTabId(EXPLORER_TAB_ID)}
              title={t("files.explorerWindowBackToTree")}
              aria-label={t("files.explorerWindowBackToTree")}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              </svg>
            </button>
          )}
        </div>

        {/* Der Baum ist der Inhalt seines eigenen Tabs, nicht eine feste Spalte
            daneben. Solange der Explorer-Tab aktiv ist, fuellt er die ganze
            Flaeche — vorher stand er links neben dem Viewer, auch wenn gerade
            gar keine Datei offen war, und auf 415px fraess er die halbe Breite
            fuer einen Baum, den man nur per Tabwechsel wieder sieht. */}
        <div className={windowStyles.workspace}>
          {showExplorer && (
            <div className={windowStyles.explorer}>
              <FileExplorer
                cwd={cwd}
                onOpenFile={handleOpenFile}
                initialViewState={initialViewState}
                onViewStateChange={handleViewStateChange}
                changesCollapsed={changesCollapsed}
                allowPopup={false}
                // Bilder sind hier ganz normale Tabs. Ohne diesen Schalter wuerde
                // ein Klick auf ein Bild weiterhin das grosse Overlay oeffnen und
                // der Nutzer haette neben dem Fenster noch eines darueber.
                imageTarget="openFile"
              />
            </div>
          )}

          {/* Derselbe `FileViewer` wie im rechten Panel der Hauptseite. Eine
              eigene Ansicht hier wuerde von der Panel-Fassung abdriften, und
              gerade der Diff- und der Markdown-Umschalter sind zu gross, um
              sie zu duplizieren. Kein `sourceSessionId`, weil der Explorer
              bereits auf `cwd` steht; ohne die Mention-Props, weil sie in den
              Chat der Hauptseite schreiben wuerden, den man hier nicht sieht. */}
          {activeTab && activeTab.kind !== "explorer" ? (
            <div className={windowStyles.content}>
              {/* Ein Tab ohne Datei traegt keinen Viewer: der wuerde einen
                  leeren Pfad laden und mit einer Fehlermeldung enden. Statt
                  dessen die Auswahl-Ansicht, die den Tab erst befuellt. */}
              {activeTab.filePath ? (
                <FileViewer
                  filePath={activeTab.filePath}
                  cwd={cwd}
                  initialDisplayMode={activeTab.initialDisplayMode}
                  onOpenFile={(filePath) => handleOpenFile(filePath, getFileName(filePath))}
                />
              ) : (
                <EmptyTabView
                  startPath={activeTab.startPath ?? currentDir}
                  onPick={(filePath) => handleOpenFile(filePath, getFileName(filePath))}
                  t={t}
                />
              )}
            </div>
          ) : !showExplorer ? (
            <div className={windowStyles.empty}>{t("files.explorerWindowNoTab")}</div>
          ) : null}
        </div>
      </ModalPanel>
    </ModalBackdrop>,
    portalTarget,
  );
}

interface ExplorerToolbarProps {
  selection: SelectionEntry[];
  uploadBusy: boolean;
  onNewFolder: (name: string) => void;
  onRefresh: () => void;
  /** `true` heisst: der Refresh ist gerade durch, der Haken bestaetigt das. */
  refreshDone: boolean;
  onUpload: () => void;
  onCopyTo: () => void;
  onMoveTo: () => void;
  onClearSelection: () => void;
  onProperties: () => void;
  /**
   * Oeffnet den Explorer in einem eigenen Fenster. Nur gesetzt, wenn die
   * aufrufende Instanz den Knopf erlauben laesst — die Instanz im Fenster
   * uebergibt bewusst keinen Wert.
   */
  onOpenPopup?: () => void;
  t: Translate;
}

const TOOLBAR_BUTTON_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 22,
  height: 22,
  padding: 0,
  flexShrink: 0,
  border: "none",
  borderRadius: 4,
  background: "transparent",
  color: "var(--text-muted)",
  cursor: "pointer",
};

/**
 * Knopf der Navigationsleiste. Dieselbe Optik wie die Werkzeuge oben, nur mit
 * dem deaktivierten Zustand, den ein Knopf braucht, am Anfang oder am Ende
 * einer Strecke: sichtbar, aber nicht klickbar. Ein versteckter Knopf waere
 * schlimmer — der Nutzer wuesste nicht, dass es zurueck geht, weil er schon
 * zurueck ist.
 *
 * `flex-shrink: 0` steht in `TOOLBAR_BUTTON_STYLE` und ist hier Pflicht, nicht
 * Kosmetik: auf einem Telefon ist die Leiste die einzige Breite, die es gibt,
 * und ein schrumpfender Knopf wird unantiklickbar. Der Pfad daneben gibt
 * Fläche ab (`flex: 1`, `minWidth: 0`), nicht die Knöpfe.
 */
function navButtonStyle(enabled: boolean): React.CSSProperties {
  return {
    ...TOOLBAR_BUTTON_STYLE,
    color: enabled ? "var(--text-muted)" : "var(--text-dim)",
    cursor: enabled ? "pointer" : "default",
    opacity: enabled ? 1 : 0.45,
  };
}

/**
 * Kopfzeile des Explorers: die Werkzeuge, die ohne Auswahl immer greifen, plus
 * die Auswahl-werkzeuge, die nur mit mindestens einem ausgewaehlten Knoten
 * sichtbar sind.
 *
 * New folder arbeitet auf dem aktuell angezeigten Ordner (`currentPath`) — das
 * ist der, den auch der Breadcrumb zeigt und in den der Upload landet. Die
 * Auswahl-werkzeuge arbeiten dagegen auf der Auswahl, weil sie ein Objekt
 * brauchen, dessen Elternordner sie als Startpunkt anbieten.
 */
function ExplorerToolbar({
  selection,
  uploadBusy,
  onNewFolder,
  onRefresh,
  refreshDone,
  onUpload,
  onCopyTo,
  onMoveTo,
  onClearSelection,
  onProperties,
  onOpenPopup,
  t,
}: ExplorerToolbarProps) {
  // `true` heisst: das Namensfeld ist offen. Der Text selbst liegt im
  // uncontrolled Input, nicht im State — das Formular wird genau einmal
  // abgeschickt und geschlossen, ein Render je Tastendruck waere Arbeit ohne
  // Gegenwert. Zusaetzlich loest es den Blur-Fall: bei einem kontrollierten
  // Feld raeumt `onBlur` den Entwurf, bevor der Submit-Handler ihn liest.
  const [draftOpen, setDraftOpen] = useState(false);
  const draftInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (draftOpen) draftInputRef.current?.focus();
  }, [draftOpen]);

  return (
    <div
      role="toolbar"
      aria-label={t("files.toolbarLabel")}
      title={t("files.selectionHint")}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        padding: "0 4px 4px 8px",
        borderBottom: "1px solid var(--border)",
      }}
    >
      {!draftOpen ? (
        <Pressable
          type="button"
          title={t("files.toolbarNewFolder")}
          aria-label={t("files.toolbarNewFolder")}
          style={TOOLBAR_BUTTON_STYLE}
          onClick={() => setDraftOpen(true)}
          onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
            <line x1="12" y1="11" x2="12" y2="16" />
            <line x1="9.5" y1="13.5" x2="14.5" y2="13.5" />
          </svg>
        </Pressable>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const name = (draftInputRef.current?.value ?? "").trim();
            setDraftOpen(false);
            if (name.length > 0) onNewFolder(name);
          }}
          style={{ display: "flex", alignItems: "center", gap: 3 }}
        >
          <input
            ref={draftInputRef}
            aria-label={t("files.newFolderName")}
            placeholder={t("files.newFolderName")}
            onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setDraftOpen(false); } }}
            onBlur={() => setDraftOpen(false)}
            style={{
              width: 120,
              height: 22,
              padding: "0 5px",
              boxSizing: "border-box",
              background: "var(--bg)",
              border: "1px solid var(--accent)",
              borderRadius: 4,
              color: "var(--text)",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              outline: "none",
            }}
          />
        </form>
      )}

      <Pressable
        type="button"
        title={t("files.toolbarRefresh")}
        aria-label={t("files.toolbarRefresh")}
        style={{
          ...TOOLBAR_BUTTON_STYLE,
          color: refreshDone ? "#4ade80" : "var(--text-muted)",
          background: refreshDone ? "rgba(74,222,128,0.18)" : "transparent",
        }}
        onClick={onRefresh}
        onMouseEnter={(event) => { if (!refreshDone) event.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(event) => {
          event.currentTarget.style.background = refreshDone ? "rgba(74,222,128,0.18)" : "transparent";
        }}
      >
        {/* Der Haken ist die Bestaetigung fuer den Refresh. Ohne ihn sieht der
            Nutzer nicht, ob der Klick durch ist — der Baum tauscht sich im
            Bestandsfall inhaltlich nicht. */}
        {refreshDone ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-5.7-8.4" />
            <polyline points="21 3 21 9 15 9" />
          </svg>
        )}
      </Pressable>

      <Pressable
        type="button"
        title={t("files.toolbarUpload")}
        aria-label={t("files.toolbarUpload")}
        disabled={uploadBusy}
        style={{ ...TOOLBAR_BUTTON_STYLE, color: uploadBusy ? "var(--text-dim)" : "var(--text-muted)", cursor: uploadBusy ? "default" : "pointer" }}
        onClick={onUpload}
        onMouseEnter={(event) => { if (!uploadBusy) event.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 16V4" />
          <path d="m7 9 5-5 5 5" />
          <path d="M5 20h14" />
        </svg>
      </Pressable>

      {/* Das grosse Fenster. Ohne `onOpenPopup` faellt der Knopf weg — das ist
          der Rekursionsschutz fuer die Instanz, die im Fenster selbst sitzt. */}
      {onOpenPopup && (
        <Pressable
          type="button"
          title={t("files.toolbarOpenWindow")}
          aria-label={t("files.toolbarOpenWindow")}
          style={TOOLBAR_BUTTON_STYLE}
          onClick={onOpenPopup}
          onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M3 9h18" />
            <path d="M8 14h8" />
          </svg>
        </Pressable>
      )}

      {selection.length > 0 && (
        <>
          <span aria-hidden="true" style={{ width: 1, height: 14, margin: "0 3px", background: "var(--border)", flexShrink: 0 }} />
          <span style={{ fontSize: 10, color: "var(--text-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {t("files.selectionCount", { count: selection.length })}
          </span>

          <Pressable
            type="button"
            title={t("files.toolbarCopyTo")}
            aria-label={t("files.toolbarCopyTo")}
            style={TOOLBAR_BUTTON_STYLE}
            onClick={onCopyTo}
            onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="9" y="3" width="11" height="12" rx="2" />
              <path d="M5 21V8a2 2 0 0 1 2-2h4" />
            </svg>
          </Pressable>

          <Pressable
            type="button"
            title={t("files.toolbarMoveTo")}
            aria-label={t("files.toolbarMoveTo")}
            style={TOOLBAR_BUTTON_STYLE}
            onClick={onMoveTo}
            onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 12h13" />
              <polyline points="13 6 19 12 13 18" />
            </svg>
          </Pressable>

          {selection.length === 1 && (
            <a
              href={`/api/files/${encodeFilePathForApi(selection[0].path)}?type=download`}
              download
              title={t("files.toolbarDownload")}
              aria-label={t("files.toolbarDownload")}
              style={TOOLBAR_BUTTON_STYLE}
              onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </a>
          )}

          <Pressable
            type="button"
            title={t("files.toolbarProperties")}
            aria-label={t("files.toolbarProperties")}
            style={TOOLBAR_BUTTON_STYLE}
            onClick={onProperties}
            onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 11v5" />
              <path d="M12 8h.01" />
            </svg>
          </Pressable>

          <Pressable
            type="button"
            title={t("files.clearSelection")}
            aria-label={t("files.clearSelection")}
            style={TOOLBAR_BUTTON_STYLE}
            onClick={onClearSelection}
            onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <path d="m6 6 12 12" />
              <path d="m18 6-12 12" />
            </svg>
          </Pressable>
        </>
      )}
    </div>
  );
}

/**
 * Masse des Baums. Sie stehen hier statt verstreut in den Komponenten, weil
 * drei Stellen dieselben Zahlen brauchen: die Zeilenhoehe entscheidet, was
 * `react-window` ueberhaupt rendert, die Einrueckung muss in der Zeile UND in
 * ihrer Hoehe uebereinstimmen, und die untere Luefte haelt die letzte Zeile
 * vom Rand des Panels weg.
 */
const TREE_ROW_HEIGHT = 24;
const TREE_INDENT = 14;
const TREE_EMPTY_ROW_HEIGHT = 22;
const TREE_BOTTOM_GAP = 8;
const TREE_MIN_HEIGHT = 120;

/**
 * Der naechste Vorfahr, der selbst scrollt.
 *
 * `react-arborist` braucht eine feste Pixelhoehe, weil sein virtualisiertes
 * Fenster eine Zahl will. Der Explorer liegt aber in keinem eigenen
 * scrollenden Kasten — er sitzt im Scrollcontainer der Seitenleiste, und im
 * Fenster im Panel. Beide muss man suchen, statt sie zu raten: die Kette wird
 * nach oben verfolgt, bis ein Element mit `overflow-y: auto|scroll` auftaucht.
 * Findet sich keiner, misst der Baum gegen den Fensterrand.
 */
function findScrollParent(el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el.parentElement;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return node;
    node = node.parentElement;
  }
  return null;
}

interface ExplorerTreeProps {
  /** Der Baum in Arborist-Form: `children === []` = Ordner, `undefined` = Datei. */
  data: FileNode[];
  cwd: string;
  currentPath: string;
  /**
   * Wechselt den Wert, wenn ein frischer Baum gebraucht wird. Der Schluessel
   * haengt an Projektordner und angezeigtem Ordner, denn beides ersetzt die
   * Knoten — und nur eine frische Instanz liest `initialOpenState` ueberhaupt.
   */
  resetKey: string;
  /** Startzustand fuer genau diese Instanz, aus dem gemeldeten Blick. */
  initialOpenState: Record<string, boolean>;
  loadingPaths: Set<string>;
  highlightedPaths: Set<string>;
  gitStatusByPath: Map<string, GitFileStatus>;
  changedDirectoryPaths: Set<string>;
  /** Die Auswahl der Toolbar. Sie ist die Quelle der Wahrheit, nicht Arborist. */
  selection: ReadonlyMap<string, SelectionEntry>;
  /** `false`, wenn diese Instanz keine grosse Bildvorschau kennt (das Fenster). */
  imagePreviewEnabled: boolean;
  onToggleExpanded: (fullPath: string, open: boolean) => void;
  onNavigate: (fullPath: string) => void;
  onOpenFile: OpenFileHandler;
  onContextMenu: (fullPath: string, name: string, isDir: boolean, x: number, y: number) => void;
  onSelectionChange: (entries: SelectionEntry[]) => void;
  /** Ziehen im Baum: verschiebt die genannten Eintraege in einen Ordner. */
  onDropMove: (entries: SelectionEntry[], destination: string) => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onOpenImage?: (filePath: string, fileName: string) => void;
  t: Translate;
}

/**
 * Was eine Zeile braucht, ohne es ueber `renderRow`/`renderNode` durchreichen
 * zu muessen. Beide Renderer werden von Arborist mit festen Props gerufen; ein
 * Kontext-Objekt haelt die Instanz-spezifischen Wege an einer Stelle.
 */
interface TreeRowContext {
  cwd: string;
  loadingPaths: Set<string>;
  highlightedPaths: Set<string>;
  gitStatusByPath: Map<string, GitFileStatus>;
  changedDirectoryPaths: Set<string>;
  imagePreviewEnabled: boolean;
  onRowClick: (node: NodeApi<FileNode>, event: React.MouseEvent) => void;
  onRowContextMenu: (node: NodeApi<FileNode>, event: React.MouseEvent) => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onOpenImage?: (filePath: string, fileName: string) => void;
  t: Translate;
}

/**
 * Ein Ordner, der offen steht, geladen ist und nichts enthaelt. Fuer ihn
 * stand im alten Baum eine eigene Zeile mit `files.emptyNode` unter dem
 * Chevron; sie ist hier eine zweite Zeile im gleichen Baumknoten, damit sie
 * beim Scrollen mitscrollt und beim Virtualisieren nicht verloren geht.
 */
function isEmptyOpenFolder(node: NodeApi<FileNode>): boolean {
  return node.isOpen && !node.isLeaf && node.data.loaded === true && (node.children?.length ?? 0) === 0;
}

/**
 * Der Inhalt einer Zeile ohne den Rahmen, den `react-window` um sie legt.
 *
 * `dragHandle` wird von Arborist fuer den React-DnD-Quellhaken geliefert und
 * sitzt hier auf dem Zeileninhalt. Das ist Absicht: die Zeilenwerkzeuge
 * (Mention, Bild, Download) sind ebenfalls Kinder dieses Elements, und ein
 * Element mit `draggable` koennte sonst beim Ziehen an ihnen haengen bleiben.
 * Sie halten ihren eigenen `mousedown` zurueck und starten damit weder einen
 * Zug noch eine Textauswahl.
 */
function FileTreeLabel({
  node,
  dragHandle,
  ctx,
}: {
  node: NodeApi<FileNode>;
  dragHandle?: (el: HTMLDivElement | null) => void;
  ctx: TreeRowContext;
}) {
  const { data } = node;
  const [hovered, setHovered] = useState(false);
  const normalizedPath = normalizeFilePathSlashes(data.fullPath);
  const gitStatus = ctx.gitStatusByPath.get(normalizedPath);
  const containsGitChanges = data.isDir && (
    gitStatus !== undefined || ctx.changedDirectoryPaths.has(normalizedPath)
  );

  /**
   * Der Knopf fuer die grosse Vorschau teilt sich den Weg mit dem Zeilen-Klick.
   * `imagePreviewEnabled` ist genau die Bedingung, an der auch der Eintrag im
   * Rechtsklick-Menue haengt: die Instanz im Fenster kennt keine grosse
   * Vorschau, also bekommen Zeile und Menue dort beide nichts zu zeigen. Der
   * Klick auf die Bildzeile geht trotzdem wie zuvor an `onOpenFile` — das
   * entscheidet `handleRowClick`, nicht dieser Knopf.
   */
  const canPreviewImage = ctx.imagePreviewEnabled && !data.isDir && isImagePath(data.name);

  /**
   * Archive bekommen ihren Download-Knopf ohne Hover.
   *
   * Eine Zeile mit einem Bild laesst sich oeffnen, eine mit Text, eine mit
   * PDF. Eine ZIP-Zeile nicht: der Viewer hat dafuer nichts, und der
   * Rechtsklick-Menue fuehrt zum selben Download. Bleibt der Knopf an `hovered`
   * gebunden, ist er auf einem Telefon unauffindbar — dort gibt es kein
   * Darueberfahren, die Zeile wird getippt, und die Datei kommt nie an.
   * Fuer Archivzeilen steht der Knopf deshalb immer.
   */
  const downloadAlwaysVisible = !data.isDir && isArchivePath(data.name);

  return (
    <div
      ref={dragHandle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        paddingRight: 8,
        height: TREE_ROW_HEIGHT,
        cursor: "pointer",
        userSelect: "none",
      }}
    >
      {!node.isLeaf && (
        <span
          role="button"
          tabIndex={-1}
          aria-label={node.isOpen ? ctx.t("files.collapseFolder") : ctx.t("files.expandFolder")}
          onClick={(event) => { event.stopPropagation(); node.toggle(); }}
          style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 14, height: 14, flexShrink: 0, cursor: "pointer" }}
        >
          <svg
            width="10" height="10" viewBox="0 0 10 10" fill="none"
            stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
            style={{ transform: node.isOpen ? "rotate(90deg)" : "none", transition: "transform 0.1s" }}
          >
            <polyline points="3 2 7 5 3 8" />
          </svg>
        </span>
      )}
      {node.isLeaf && <span style={{ width: 10, flexShrink: 0 }} />}
      <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
        {data.isDir ? <FolderIcon size={14} open={node.isOpen} /> : getFileIcon(data.name, 14)}
      </span>
      <span
        style={{
          fontSize: 12,
          color: "var(--text)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
        }}
        title={data.fullPath}
      >
        {data.name}
      </span>
      {ctx.highlightedPaths.has(data.fullPath) && (
        <span
          title={ctx.t("files.newlyUploaded")}
          aria-label={ctx.t("files.newlyUploaded")}
          style={{ width: 14, height: 14, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#3b82f6" }} />
        </span>
      )}
      {!hovered && node.isLeaf && gitStatus && <GitStatusBadge status={gitStatus} t={ctx.t} />}
      {!hovered && containsGitChanges && (
        <span
          title={ctx.t("files.containsChangedFiles")}
          aria-label={ctx.t("files.containsChangedFiles")}
          style={{ width: 14, height: 14, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#d6a84b" }} />
        </span>
      )}
      {ctx.loadingPaths.has(data.fullPath) && (
        <Spin style={{ display: "inline-flex", width: 10, height: 10 }}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4" />
          </svg>
        </Spin>
      )}
      {isEmptyOpenFolder(node) && (
        <div style={{ position: "absolute", left: 8 + node.level * TREE_INDENT, top: TREE_ROW_HEIGHT, height: TREE_EMPTY_ROW_HEIGHT, display: "flex", alignItems: "center", fontSize: 11, color: "var(--text-dim)" }}>
          {ctx.t("files.emptyNode")}
        </div>
      )}
      {ctx.onAtMention && hovered && (
        <Pressable
          onClick={(e) => {
            e.stopPropagation();
            ctx.onAtMention?.(getRelativeFilePath(data.fullPath, ctx.cwd), data.isDir);
          }}
          onMouseDown={(e) => e.preventDefault()}
          title={ctx.t("files.insertPath")}
          style={{
            position: "absolute",
            right: !data.isDir ? ROW_ACTION_RIGHT_MENTION_FILE : ROW_ACTION_RIGHT_MENTION_DIR,
            top: "50%",
            transform: "translateY(-50%)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 4,
            padding: "0 8px",
            height: 20,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            color: "var(--accent)",
            cursor: "pointer",
            fontSize: 11,
            fontWeight: 600,
            whiteSpace: "nowrap",
          }}
        >
          <MentionIcon />
          {ctx.t("files.mention")}
        </Pressable>
      )}
      {canPreviewImage && hovered && (
        <Pressable
          onClick={(e) => {
            // Ohne Halt ruft der Klick auf den Knopf den Zeilen-Klick auf und
            // oeffnet dieselbe Vorschau ein zweites Mal.
            e.stopPropagation();
            ctx.onOpenImage?.(data.fullPath, data.name);
          }}
          onMouseDown={(e) => e.preventDefault()}
          title={ctx.t("files.openImageLarge")}
          aria-label={ctx.t("files.openImageLarge")}
          style={{
            position: "absolute",
            right: ROW_ACTION_RIGHT_IMAGE,
            top: "50%",
            transform: "translateY(-50%)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
            width: 20,
            height: 20,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            color: "var(--text-muted)",
            cursor: "pointer",
          }}
        >
          <ImageOpenIcon />
        </Pressable>
      )}
      {node.isLeaf && (hovered || downloadAlwaysVisible) && (
        <a
          href={`/api/files/${encodeFilePathForApi(data.fullPath)}?type=download`}
          download
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.preventDefault()}
          title={ctx.t("files.download")}
          aria-label={ctx.t("files.download")}
          style={{
            // Der Knopf einer Archivzeile steht im Fluss, nicht absolut: er ist
            // dann neben dem Git-Kuerzel zu sehen, statt es zu ueberdecken.
            // Die Zeile gibt ihren Platz ueber `flex: 1` am Dateinamen ab, also
            // sitzt der Knopf auch so am rechten Rand.
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 4,
            padding: "0 5px",
            height: 20,
            marginLeft: 4,
            flexShrink: 0,
            position: downloadAlwaysVisible ? "static" : "absolute",
            right: ROW_ACTION_RIGHT_DOWNLOAD,
            top: "50%",
            transform: downloadAlwaysVisible ? "none" : "translateY(-50%)",
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 11,
            fontWeight: 600,
            whiteSpace: "nowrap",
            textDecoration: "none",
          }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </a>
      )}
    </div>
  );
}

/**
 * Der Rahmen um eine Zeile: `react-window` setzt Position und Hoehe, wir
 * setzen Einrueckung, Hintergrund und die Klicks darauf.
 *
 * Der Klick ersetzt `node.handleClick` aus Arborists Standardzeile. Der
 * Unterschied ist der Auswahlvertrag dieses Explorers: ein einfacher Klick
 * oeffnet oder navigiert und fasst die Toolbar-Auswahl gar nicht an, nur
 * Strg/Cmd-Klick schaltet einen Eintrag. Arborists `handleClick` wuerde bei
 * jedem Klick auswaehlen und damit nach jedem Datei-Klick die Werkzeuge der
 * Toolbar einblenden.
 */
function ExplorerRow({
  node,
  innerRef,
  attrs,
  children,
  ctx,
}: RowRendererProps<FileNode> & { ctx: TreeRowContext }) {
  const [hovered, setHovered] = useState(false);
  const level = Math.max(0, node.level - 1);
  return (
    <div
      {...attrs}
      ref={innerRef}
      onFocus={(e) => e.stopPropagation()}
      onClick={(e) => ctx.onRowClick(node, e)}
      onContextMenu={(e) => ctx.onRowContextMenu(node, e)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      data-selected={node.isSelected ? "true" : undefined}
      style={{
        ...attrs.style,
        paddingLeft: 8 + level * TREE_INDENT,
        paddingRight: 8,
        boxSizing: "border-box",
        display: "flex",
        alignItems: "flex-start",
        cursor: "pointer",
        // Auswahl schlaegt Hover: eine markierte Zeile soll auch dann
        // markiert bleiben, wenn der Zeiger sie gerade nicht beruehrt.
        background: node.isSelected ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : "transparent",
        borderRadius: 4,
        userSelect: "none",
      }}
    >
      {children}
    </div>
  );
}

/**
 * Der Baum.
 *
 * Gegenueber dem handgebauten `TreeNode` gibt es drei Aenderungen, die man
 * kennen muss:
 *
 * - **Nur sichtbare Zeilen existieren im DOM.** Das ist der Grund fuer den
 *   Umbau; dafuer braucht der Baum eine feste Pixelhoehe, die aus dem
 *   Scrollcontainer gemessen wird.
 * - **Der Wurzelknoten ist einOrdner.** Ein Drop auf oberster Ebene heisst
 *   deshalb „in den gerade angezeigten Ordner", nicht „neben die Liste".
 * - **Die Auswahl gehoert dem Explorer, nicht dem Baum.** Sie muss einen
 *   Ordnerwechsel und den Aufruf durch die Toolbar ueberleben; Arborist
 *   bekommt sie darum als Abbild gesetzt und nicht als Eigentum.
 */
function ExplorerTree({
  data,
  cwd,
  currentPath,
  resetKey,
  initialOpenState,
  loadingPaths,
  highlightedPaths,
  gitStatusByPath,
  changedDirectoryPaths,
  selection,
  imagePreviewEnabled,
  onToggleExpanded,
  onNavigate,
  onOpenFile,
  onContextMenu,
  onSelectionChange,
  onDropMove,
  onAtMention,
  onOpenImage,
  t,
}: ExplorerTreeProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<TreeApi<FileNode> | undefined>(undefined);
  const [height, setHeight] = useState(TREE_MIN_HEIGHT);

  // Zwei Werte, die die Callbacks brauchen, ohne dass sie bei jedem Werten
  // eine neue Funktion erzeugen muessen. Beide werden waehrend des Renderns
  // nachgefuehrt, nicht in einem Effekt: ein Effekt liefe zu spaet, und beide
  // Callbacks feuern genau dann, wenn sich der Wert schon geaendert hat.
  const currentPathRef = useRef(currentPath);
  currentPathRef.current = currentPath;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  /**
   * Als eigene Liste, weil die Auswahl als Karte aus der aufrufenden Instanz
   * kommt: `[...selection.values()]` waere bei jedem Rendern ein neuer Wert,
   * und der Abgleich mit dem Baum laeuft bei jeder Aenderung dieser Liste.
   */
  const selectedEntries = useMemo(() => [...selection.values()], [selection]);

  /**
   * Der verbleibende Platz fuer das virtualisierte Fenster. Gemessen wird
   * gegen den oberen Rand des Baums, nicht gegen seine Hoehe — sonst stuende
   * die Messung in einer Schleife: hoeherer Baum, tieferer Rand, weniger Platz.
   * Beobachtet werden die Vorfahren bis zum Scrollcontainer, damit auch das
   * Hoch- und Herunterklappen der Upload-Meldung ueber dem Baum die Hoehe
   * wieder ausmisst.
   */
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const scroller = findScrollParent(el);
      const own = el.getBoundingClientRect();
      const available = scroller
        ? scroller.clientHeight - (own.top - scroller.getBoundingClientRect().top + scroller.scrollTop) - TREE_BOTTOM_GAP
        : window.innerHeight - own.top - TREE_BOTTOM_GAP;
      setHeight(Math.max(TREE_MIN_HEIGHT, Math.floor(available)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    let node: HTMLElement | null = el;
    for (let depth = 0; node && depth < 8; depth++) {
      observer.observe(node);
      node = node.parentElement;
    }
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  const handleRowClick = useCallback((node: NodeApi<FileNode>, event: React.MouseEvent) => {
    // Auswahl laeuft ueber Strg/Cmd-Klick, nicht ueber den einfachen Klick.
    // Ein Dateimanager lebt davon, dass ein Klick eine Datei oeffnet; nimmt man
    // das fuer die Auswahl, muss jeder Nutzer zweimal klicken, um etwas zu
    // sehen. Der Modifikator kostet nur einen Finger und ist zugleich die
    // gewohnte Mehrfachauswahl ohne weitere Klickpflege — ein Checkbox je
    // Zeile wuerde bei tiefen Baeumen die Namensspalte verschieben.
    if (event.ctrlKey || event.metaKey) {
      if (node.isSelected) node.deselect(); else node.selectMulti();
      return;
    }
    // Der Tastaturcursor folgt dem Klick, damit die Pfeiltasten dort ansetzen,
    // wo der Nutzer zuletzt war. Die Auswahl der Toolbar bleibt unberuehrt.
    node.focus();
    if (node.data.isDir) {
      // Klick auf einen Ordner navigiert in ihn; das Chevron ist fuer
      // Auf- und Zuklappen zustaendig. So verhielt sich die oberste Ebene
      // vorher schon, und der Umbau macht es nicht unterschiedlich.
      onNavigate(node.id);
    } else if (onOpenImage && isImagePath(node.data.name)) {
      onOpenImage(node.id, node.data.name);
    } else {
      onOpenFile(node.id, node.data.name);
    }
  }, [onNavigate, onOpenFile, onOpenImage]);

  const handleRowContextMenu = useCallback((node: NodeApi<FileNode>, event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onContextMenu(node.id, node.data.name, node.data.isDir, event.clientX, event.clientY);
  }, [onContextMenu]);

  /**
   * Was der Baum meldet, wird mit der Auswahl des Explorers zusammengefuegt.
   * Arborist kennt nur die sichtbaren Knoten; eine Auswahl, die vor einem
   * Ordnerwechsel aufgenommen wurde, taucht in seiner Meldung nicht auf und
   * darf durch sie nicht verschwinden. Die unsichtbaren Eintraege wandern
   * darum unveraendert mit — genau wie vorher, als die Auswahl ein Zustand des
   * Explorers war und der Baum sie gar nicht kannte.
   */
  const handleTreeSelect = useCallback((nodes: NodeApi<FileNode>[]) => {
    const api = treeRef.current;
    const visible = new Set((api?.visibleNodes ?? []).map((node) => node.id));
    const next = new Map<string, SelectionEntry>();
    for (const entry of selectionRef.current.values()) {
      if (!visible.has(entry.path)) next.set(entry.path, entry);
    }
    for (const node of nodes) {
      next.set(node.id, { path: node.id, name: node.data.name, isDir: node.data.isDir });
    }
    onSelectionChange([...next.values()]);
  }, [onSelectionChange]);

  /**
   * Der Baum meldet jede Aenderung seiner offenen Aeste, und der Explorer
   * haelt sie fuer `initialViewState` fest. Gelesen wird der Zustand aus
   * Arborist, nicht der gewollte: `onToggle` feuert nach dem Umschalten, und
   * ein zweites `setExpandedPaths` an der aufrufenden Seite koennte sonst der
   * Auswertung des bereits gesetzten Zustands widersprechen.
   */
  const handleToggle = useCallback((id: string) => {
    const node = treeRef.current?.get(id);
    // Der Wurzelknoten traegt eine interne Kennung von Arborist und gehoert
    // nicht in den gemeldeten Blick: dort wuerde sie als offener Pfad
    // landen, im naechsten Fenster wieder als Startzustand ankommen und einen
    // Ordner oeffnen, den der Nutzer nie aufklappen konnte.
    if (!node || node.isRoot) return;
    onToggleExpanded(id, node.isOpen);
  }, [onToggleExpanded]);

  /**
   * Ablegen. `parentNode` ist bei einem Drop auf oberster Ebene der Wurzel-
   * knoten, und der steht fuer den Ordner, den der Baum gerade zeigt.
   * `canDrop` von Arborist hat Ordner-in-sich-schon vorher abgelehnt.
   */
  const handleMove = useCallback(({ dragNodes, parentNode }: {
    dragIds: string[];
    dragNodes: NodeApi<FileNode>[];
    parentId: string | null;
    parentNode: NodeApi<FileNode> | null;
    index: number;
  }) => {
    const destination = parentNode && !parentNode.isRoot ? parentNode.data.fullPath : currentPathRef.current;
    // Ein Eintrag, der schon im Ziel liegt, wird uebersprungen: `disableDrop`
    // lehnt nur ab, wenn ALLE gezogenen Eintraege dort liegen, weil eine
    // Mischeinspeisung weiterhin ein guter Zug ist. Ohne diese Filterung
    // wuerde der Server fuer die uebrigen einen Fehler melden, den der Nutzer
    // nicht ausgeloest hat.
    const entries = dragNodes
      .filter((node) => getFileDirectory(normalizeFilePathSlashes(node.data.fullPath)) !== normalizeFilePathSlashes(destination))
      .map((node) => ({ path: node.id, name: node.data.name, isDir: node.data.isDir }));
    if (entries.length === 0) return;
    onDropMove(entries, destination);
  }, [onDropMove]);

  /**
   * Ein Zug in den Ordner, in dem der Eintrag ohnehin liegt, waere eine
   * Umbenennung ohne Wirkung und ein Fehler des Servers. Der Pfad wird
   * darum abgelehnt, bevor ein Cursor verspricht, dass es klappt.
   */
  const disableDrop = useCallback(({ parentNode, dragNodes }: {
    parentNode: NodeApi<FileNode>;
    dragNodes: NodeApi<FileNode>[];
    index: number;
  }) => {
    const destination = parentNode && !parentNode.isRoot ? parentNode.data.fullPath : currentPathRef.current;
    return dragNodes.every((node) => (
      getFileDirectory(normalizeFilePathSlashes(node.data.fullPath)) === normalizeFilePathSlashes(destination)
    ));
  }, []);

  const rowHeight = useCallback((node: NodeApi<FileNode>) => (
    isEmptyOpenFolder(node) ? TREE_ROW_HEIGHT + TREE_EMPTY_ROW_HEIGHT : TREE_ROW_HEIGHT
  ), []);

  const accessId = useCallback((node: FileNode) => node.fullPath, []);

  /**
   * Die Auswahl des Explorers als Abbild in den Baum. Verglichen wird, nicht
   * blind gesetzt: `setSelection` meldet ueber `onSelect` zurueck, und ohne
   * den Vergleich wuerde jede Meldung wieder eine Meldung ausloesen.
   */
  useEffect(() => {
    const api = treeRef.current;
    if (!api) return;
    const desired = new Set(
      selectedEntries.map((entry) => entry.path).filter((path) => api.get(path) !== null),
    );
    const current = api.selectedIds;
    if (desired.size === current.size && [...desired].every((id) => current.has(id))) return;
    if (desired.size === 0) { api.deselectAll(); return; }
    const ids = [...desired];
    api.setSelection({ ids, anchor: ids[0], mostRecent: ids[ids.length - 1] });
  }, [selectedEntries, data]);

  /**
   * Was eine Zeile rendern muss, an einer Stelle zusammengefasst. Beide
   * Renderer bekommen es als Prop, weil Arborist sie mit festen Props ruft
   * und es nicht durchgereicht werden kann; ihr Name aendert sich darum nur,
   * wenn sich einer dieser Werte aendert — und genau dann soll der Baum seine
   * Knoten neu bauen.
   */
  const ctx = useMemo<TreeRowContext>(() => ({
    cwd,
    loadingPaths,
    highlightedPaths,
    gitStatusByPath,
    changedDirectoryPaths,
    imagePreviewEnabled,
    onRowClick: handleRowClick,
    onRowContextMenu: handleRowContextMenu,
    onAtMention,
    onOpenImage,
    t,
  }), [
    cwd, loadingPaths, highlightedPaths, gitStatusByPath, changedDirectoryPaths,
    imagePreviewEnabled, handleRowClick, handleRowContextMenu, onAtMention, onOpenImage, t,
  ]);

  const renderRow = useCallback((props: RowRendererProps<FileNode>) => (
    <ExplorerRow {...props} ctx={ctx} />
  ), [ctx]);

  const renderNode = useCallback(({ node, dragHandle }: NodeRendererProps<FileNode>) => (
    <FileTreeLabel node={node} dragHandle={dragHandle} ctx={ctx} />
  ), [ctx]);

  /** Die Linie, die beim Ziehen anzeigt, wohin der Eintrag fallen wuerde. */
  const renderCursor = useCallback(({ top, left, indent }: CursorProps) => (
    <div style={{ position: "absolute", pointerEvents: "none", top: top - 2, left, right: indent, display: "flex", alignItems: "center", zIndex: 1 }}>
      <span style={{ width: 4, height: 4, borderRadius: "50%", background: "var(--accent)", boxShadow: "0 0 0 2px var(--accent)", flexShrink: 0 }} />
      <span style={{ flex: 1, height: 2, borderRadius: 1, background: "var(--accent)" }} />
    </div>
  ), []);

  /**
   * Die mitlaufende Anzeige waehrend des Zugs. Arborists eigene Vorschau
   * traegt Klassen aus fremdem CSS; sie wird hier durch eine ersetzt, die in
   * den Farben des Panels bleibt und bei mehreren Eintraegen deren Zahl nennt.
   */
  const renderDragPreview = useCallback(({ offset, id, dragIds, isDragging }: DragPreviewProps) => {
    if (!isDragging || !offset) return null;
    const node = treeRef.current?.get(id);
    const label = dragIds.length > 1
      ? t("files.selectionCount", { count: dragIds.length })
      : node?.data.name ?? "";
    return (
      <div style={{ position: "fixed", left: 0, top: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 100 }}>
        <div style={{
          position: "absolute",
          transform: `translate(${offset.x + 10}px, ${offset.y + 10}px)`,
          display: "flex",
          alignItems: "center",
          height: 20,
          padding: "0 8px",
          borderRadius: 4,
          border: "1px solid var(--border)",
          background: "var(--bg-panel)",
          color: "var(--text)",
          fontSize: 11,
          fontWeight: 600,
          whiteSpace: "nowrap",
        }}>
          {label}
        </div>
      </div>
    );
  }, [t]);

  // Rechter Klick auf die Flaeche des Baums: kein Systemmenue, das Menue
  // gehoert zu einer Zeile. Aehnlich wie vorher am Wurzelelement des Panels.
  const suppressContextMenu = useCallback((event: React.MouseEvent) => {
    if (event.target === event.currentTarget) event.preventDefault();
  }, []);

  return (
    <div ref={wrapRef} style={{ position: "relative", height }}>
      <Tree<FileNode>
        key={resetKey}
        ref={treeRef}
        data={data}
        idAccessor={accessId}
        childrenAccessor="children"
        initialOpenState={initialOpenState}
        height={height}
        width="100%"
        rowHeight={rowHeight}
        indent={TREE_INDENT}
        overscanCount={8}
        aria-label={t("files.explorerWindowTitle")}
        onToggle={handleToggle}
        onSelect={handleTreeSelect}
        onMove={handleMove}
        disableDrop={disableDrop}
        onContextMenu={suppressContextMenu}
        renderRow={renderRow}
        // Arborist ruft den Knoten-Renderer ueber `children` und hat kein
        // `renderNode`; die Renderer sind `ElementType`-Werte und damit keine
        // echten Kind-Elemente, die man zwischen die Tags schreiben koennte.
        // eslint-disable-next-line react/no-children-prop
        children={renderNode}
        renderCursor={renderCursor}
        renderDragPreview={renderDragPreview}
      />
    </div>
  );
}

function Breadcrumb({
  currentPath,
  projectRoot,
  homeDir,
  canGoBack,
  canGoForward,
  onNavigate,
  onNavigateUp,
  onNavigateHome,
  onNavigateBack,
  onNavigateForward,
  t,
}: {
  currentPath: string;
  projectRoot: string;
  homeDir: string;
  canGoBack: boolean;
  canGoForward: boolean;
  onNavigate: (fullPath: string) => void;
  onNavigateUp: () => void;
  onNavigateHome: () => void;
  onNavigateBack: () => void;
  onNavigateForward: () => void;
  t: Translate;
}) {
  const canGoUp = currentPath !== "/" && currentPath !== projectRoot && getFileDirectory(currentPath) !== currentPath;
  const atHome = normalizeFilePathSlashes(currentPath) === normalizeFilePathSlashes(homeDir);
  // Build segments by splitting the absolute path. Skip the leading empty
  // entry from the leading slash so segment 0 is the first real directory.
  const segments: Array<{ name: string; fullPath: string }> = [];
  const parts = currentPath.split("/").filter(Boolean);
  let running = currentPath.startsWith("/") ? "" : "";
  for (const part of parts) {
    running = running === "" && currentPath.startsWith("/") ? `/${part}` : `${running}/${part}`;
    segments.push({ name: part, fullPath: running });
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        padding: "4px 4px 6px 8px",
        fontSize: 11,
        fontFamily: "var(--font-mono)",
        color: "var(--text-muted)",
      }}
    >
      {/* EINE Leiste fuer alle vier Wege, nicht vier Knöpfe an vier Orten.
          Up und Home standen vorher hier, Back und Forward kommen dazu: sie
          gehoeren zum selben Weg durch den Baum, und ein Nutzer, der zurueck
          kann, sucht die Leiste, in der auch "eine Ebene hoeher" steht — nicht
          einen zweiten Satz Knöpfe daneben.

          Der Pfad ist die scrollendeFlaeche, die Knöpfe sind es nicht: ohne
          `flex: 1` und `minWidth: 0` waere der Pfad die starre Komponente und
          die Leiste auf einem Telefon breiter als das Panel, in dem sie steht. */}
      <Pressable
        type="button"
        onClick={onNavigateBack}
        disabled={!canGoBack}
        title={t("files.navBack")}
        aria-label={t("files.navBack")}
        style={navButtonStyle(canGoBack)}
        onMouseEnter={(event) => { if (canGoBack) event.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M19 12H5" />
          <polyline points="12 19 5 12 12 5" />
        </svg>
      </Pressable>
      <Pressable
        type="button"
        onClick={onNavigateForward}
        disabled={!canGoForward}
        title={t("files.navForward")}
        aria-label={t("files.navForward")}
        style={navButtonStyle(canGoForward)}
        onMouseEnter={(event) => { if (canGoForward) event.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 12h14" />
          <polyline points="12 5 19 12 12 19" />
        </svg>
      </Pressable>
      <Pressable
        type="button"
        onClick={onNavigateHome}
        disabled={atHome}
        title={`${t("files.navHome")} (${homeDir})`}
        aria-label={`${t("files.navHome")} ${homeDir}`}
        style={navButtonStyle(!atHome)}
        onMouseEnter={(event) => { if (!atHome) event.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
          <polyline points="9 22 9 12 15 12 15 22" />
        </svg>
      </Pressable>
      <Pressable
        type="button"
        onClick={onNavigateUp}
        disabled={!canGoUp}
        title={t("files.navUp")}
        aria-label={t("files.navUp")}
        style={navButtonStyle(canGoUp)}
        onMouseEnter={(event) => { if (canGoUp) event.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m18 15-6-6-6 6" />
        </svg>
      </Pressable>
      {/* Der Rand zwischen den Wegen und dem Pfad: ohne ihn laesst die Leiste
          einen Knopf und den ersten Pfadabschnitt zusammen lesen. */}
      <span style={{ flex: "1 1 auto", minWidth: 0, display: "flex", alignItems: "center", gap: 2, overflowX: "auto", whiteSpace: "nowrap", scrollbarWidth: "thin", paddingLeft: 4 }}>
        {segments.map((segment, index) => {
          const isLast = index === segments.length - 1;
          return (
            <span key={segment.fullPath} style={{ display: "inline-flex", alignItems: "center", gap: 2, minWidth: 0 }}>
              <Pressable
                type="button"
                onClick={() => onNavigate(segment.fullPath)}
                title={segment.fullPath}
                style={{
                  padding: "1px 5px",
                  background: "transparent",
                  border: "none",
                  borderRadius: 3,
                  color: isLast ? "var(--text)" : "var(--text-muted)",
                  fontWeight: isLast ? 500 : 400,
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  cursor: "pointer",
                  maxWidth: 180,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                onMouseEnter={(event) => { if (!isLast) event.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
              >
                {segment.name}
              </Pressable>
              {!isLast && <span style={{ color: "var(--text-dim)" }}>/</span>}
            </span>
          );
        })}
      </span>
    </div>
  );
}

type OpenFileOptions = { sourceSessionId?: string | null; modeHint?: "diff" };

type OpenFileHandler = (filePath: string, fileName: string, options?: OpenFileOptions) => void;

function ChangeRow({
  status,
  cwd,
  onOpenFile,
  t,
}: {
  status: GitFileStatus;
  cwd: string;
  onOpenFile: OpenFileHandler;
  t: Translate;
}) {
  const [hovered, setHovered] = useState(false);
  const name = getFileName(status.filePath);
  const rel = getRelativeFilePath(status.filePath, cwd);
  return (
    <div
      onClick={() => onOpenFile(status.filePath, name, { modeHint: "diff" })}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={status.filePath}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        paddingLeft: 10,
        paddingRight: 8,
        height: 24,
        cursor: "pointer",
        background: hovered ? "var(--bg-hover)" : "transparent",
        borderRadius: 4,
        userSelect: "none",
      }}
    >
      <GitStatusBadge status={status} t={t} />
      <span style={{ flexShrink: 0, display: "flex", alignItems: "center", opacity: 0.85 }}>
        {getFileIcon(name, 13)}
      </span>
      <span
        style={{
          fontSize: 12,
          color: "var(--text)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
        }}
      >
        {rel}
      </span>
    </div>
  );
}

export const FileExplorer = forwardRef<FileExplorerHandle, Props>(function FileExplorer({
  cwd,
  onOpenFile,
  refreshKey,
  onAtMention,
  onAtMentions,
  onRefresh,
  changesCollapsed,
  onChangesCountChange,
  initialViewState,
  onViewStateChange,
  onPopupOpenChange,
  allowPopup = true,
  imageTarget = "preview",
}, ref) {
  const { t } = useI18n();
  const [roots, setRoots] = useState<FileNode[]>([]);
  /**
   * Der Inhalt der Unterordner, nach Pfad. Der Baum von `react-arborist`
   * bekommt seinen Datenbaum als einen Wert, aber das Dateisystem liefert ihn
   * nur auf Anfrage: ein Ordner wird erst geholt, wenn jemand ihn aufklappt.
   * Diese Map ist der Zwischenspeicher, aus dem der Baum bei jedem Rendern
   * zusammengesetzt wird.
   */
  const [childrenByPath, setChildrenByPath] = useState<Map<string, FileNode[]>>(new Map());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(initialViewState?.expandedPaths ?? new Set());
  // The directory currently shown at the top of the tree. Defaults to the
  // `cwd` prop (the project root) and updates when the user navigates up or
  // down via the breadcrumb, the Up button, or clicking a folder row. The
  // external `cwd` prop is the project root and never changes from inside.
  // `initialViewState` hat Vorrang: es ist der Blick, den eine gerade neu
  // gemountete Instanz (das grosse Fenster) uebernimmt.
  const [currentPath, setCurrentPath] = useState<string>(initialViewState?.currentPath ?? cwd);
  // Die besuchten Ordner. Startet beim Ordner, den die Ansicht zeigt — nicht
  // beim Projektwurzel-`cwd`: sonst stuende der Index in einem Fenster, das
  // mitten in der Historie aufmacht, auf einem Eintrag, den es gar nicht
  // besucht hat, und `currentPath` stuende neben dem Stack.
  const [history, setHistory] = useState<NavigationHistory>(
    initialViewState?.history ?? historyStartingAt(initialViewState?.currentPath ?? cwd),
  );
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  // Bestaetigung fuer den Refresh-Button. Zwei Sekunden gruen, dann faellt der
  // Haken wieder weg — ohne sie bliebe bei unveraendertem Baum kein Merkmal,
  // an dem der Nutzer den Klick sieht.
  const [refreshDone, setRefreshDone] = useState(false);
  const refreshDoneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [highlightedPaths, setHighlightedPaths] = useState<Set<string>>(new Set());
  const [homeDir, setHomeDir] = useState<string>("/");
  const [gitFiles, setGitFiles] = useState<GitFileStatus[]>([]);
  const [gitLineStats, setGitLineStats] = useState({ additions: 0, deletions: 0 });
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>("idle");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSummary, setUploadSummary] = useState<UploadSummary | null>(null);
  const [pendingConflict, setPendingConflict] = useState<PendingConflict | null>(null);
  // Rechtsklick-Ziel in Viewport-Koordinaten. `null` heisst: Menue geschlossen.
  const [menuTarget, setMenuTarget] = useState<FileMenuTarget | null>(null);
  // Auswahl fuer die Toolbar. Als Map nach Pfad, weil das Umschalten einer
  // Zeile ein Lookup und eine Ersetzung ist und die Reihenfolge der Auswahl
  // fuer die Werkzeuge keine Rolle spielt.
  const [selection, setSelection] = useState<Map<string, SelectionEntry>>(new Map());
  // Zielordner-Dialog der Toolbar. Bewusst getrennt vom Kontextmenue-Dialog:
  // beide nutzen denselben Dialog, aber unterschiedliche Quellen und
  // unterschiedliche Urspruenge, und ein gemeinsamer State wuerde beim
  // Schliessen des einen den anderen ungefragt mitreissen.
  const [toolbarTransfer, setToolbarTransfer] = useState<"copy" | "move" | null>(null);
  const [propertiesTarget, setPropertiesTarget] = useState<SelectionEntry | null>(null);
  // Grosse Bildvorschau. Eine Datei im Ziel reicht, solange keine Serie
  // geoeffnet wurde; dann liefert der Dialog onNext/onPrev selbst.
  const [imagePreview, setImagePreview] = useState<{ path: string; name: string } | null>(null);
  // GROSSES FENSTER. Der Blick auf den Baum des Fensters (`popupViewState`)
  // lebt hier, nicht in der Fenster-Komponente: das Fenster wird beim
  // Schliessen aus dem DOM entfernt und verliere damit seinen eigenen State.
  const [popupOpen, setPopupOpen] = useState(false);
  const [popupViewState, setPopupViewState] = useState<ExplorerViewState | null>(null);
  const [actionNotice, setActionNotice] = useState<FileActionNotice | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevCwdRef = useRef<string | null>(null);
  /**
   * Der Pfad, fuer den die zuletzt gestartete Listenabfrage lief. Eine Antwort
   * wird nur dann verworfen, wenn sie zu einem Pfad gehoert, den die Ansicht
   * inzwischen verlassen hat — nicht dann, wenn ein Refresh-Takt den Effekt
   * erneut gestartet hat. Siehe den Ladeeffekt weiter unten.
   */
  const listPathRef = useRef<string>("");
  const uploadInputRef = useRef<HTMLInputElement>(null);
  /**
   * Laufende Ordner-Anfragen. Ein Ref und kein Zustand, weil er nur eine
   * Frage beantwortet: „laeuft diese Anfrage schon?" — waehrenddessen soll
   * weder der Klick auf das Chevron noch der Abgleich der offenen Aeste eine
   * zweite an den Server schicken.
   */
  const loadingPathsRef = useRef<Set<string>>(new Set());
  const uploadBusy = uploadPhase !== "idle";

  /**
   * Meldet Pfad und aufgeklappte Aeste nach aussen, damit die aufrufende
   * Instanz sie als Startzustand fuer die naechste bekommt.
   *
   * Der Effekt haengt an genau diesen zwei Werten, nicht am Callback: die
   * aufrufende Instanz gibt bei jedem Rendern eine neue Pfeilfunktion, und
   * haenge der Effekt daran, meldete die Instanz ihren Zustand in jedem
   * Rendern zurueck und wuerde sich selbst wieder aufrufen. `sameViewState`
   * faengt das zusätzlich ab, sodass auch inhaltlich gleiche Meldungen den
   * Zustand der aufrufenden Seite unberuehrt lassen.
   */
  useEffect(() => {
    onViewStateChange?.({ currentPath, expandedPaths, history });
  }, [currentPath, expandedPaths, history, onViewStateChange]);

  const gitStatusByPath = useMemo(() => new Map(
    gitFiles.map((status) => [normalizeFilePathSlashes(status.filePath), status]),
  ), [gitFiles]);

  /**
   * Der Baum in der Form, die `react-arborist` liest.
   *
   * Der entscheidende Unterschied zur Datei ist `children`: bei einer Datei
   * `undefined` (daraus macht Arborist einen Blattknoten), bei einem Ordner ein
   * Array. Ein Ordner, dessen Inhalt noch nicht geholt wurde, bekommt ein
   * leeres Array und ist damit trotzdem intern — er hat dann ein Chevron, aber
   * keine Kinder. `loaded` sagt dem Renderer, dass das leere Array ein
   * geprueftes Ergebnis ist und nicht bloss ein noch ausstehendes.
   *
   * Die Pfade aller Ordner fallen gleich mit heraus: `loadDirectory` braucht
   * sie, um eine Anfrage an einen Ordner zu erkennen, ohne selbst eine Liste
   * zu bauen oder auf den Namen zu raten.
   */
  const { treeData, directoryPaths } = useMemo(() => {
    const directories = new Set<string>();
    const build = (nodes: FileNode[]): FileNode[] => nodes.map((node) => {
      if (!node.isDir) return node;
      directories.add(node.fullPath);
      const children = childrenByPath.get(node.fullPath);
      return {
        ...node,
        loaded: children !== undefined,
        children: children ? build(children) : [],
      };
    });
    return { treeData: build(roots), directoryPaths: directories };
  }, [roots, childrenByPath]);

  const directoryPathsRef = useRef(directoryPaths);
  directoryPathsRef.current = directoryPaths;

  /**
   * Holt den Inhalt eines Ordners. `null` ist ein Ergebnis: es gibt nichts
   * nachzuladen, und der Aufrufer tut dann auch nichts. Fehler werden
   * geschluckt, genau wie vorher in der Zeile — ein Ordner, den der Server
   * nicht liefert, bleibt leer statt den ganzen Explorer zu melden.
   */
  const loadDirectory = useCallback((fullPath: string) => {
    if (!directoryPathsRef.current.has(fullPath)) return;
    if (loadingPathsRef.current.has(fullPath)) return;
    loadingPathsRef.current.add(fullPath);
    setLoadingPaths((previous) => new Set(previous).add(fullPath));
    void fetchEntries(fullPath)
      .then((entries) => { setChildrenByPath((previous) => new Map(previous).set(fullPath, entries)); })
      .catch(() => { /* der Ordner bleibt leer, wie es die Zeile früher tat */ })
      .finally(() => {
        loadingPathsRef.current.delete(fullPath);
        setLoadingPaths((previous) => {
          const next = new Set(previous);
          next.delete(fullPath);
          return next;
        });
      });
  }, []);

/**
   * Die offenen Ordner, aufgeteilt danach, ob ihr Inhalt schon da ist.
   *
   * Vorher las das jede Zeile fuer sich beim Mount. Das ging nicht mehr: der
   * virtualisierte Baum holt keine Zeile fuer einen Ordner, den niemand
   * ansieht, und der wiederhergestellte Blick aus `initialViewState` nennt
   * offene Aeste, die es in diesem Durchlauf noch gar nicht gibt. Der
   * Abgleich laeuft darum ueber den Datenbaum und nicht ueber das DOM.
   *
   * Beide Listen entstehen in einem Durchgang, weil sie dieselbe Frage an
   * denselben Baum stellen: `toLoad` sind die offenen Ordner ohne Inhalt —
   * etwa aus einem wiederhergestellten Blick oder nach einem fehlgeschlagenen
   * Versuch —, `toReload` sind die mit Inhalt, die ein Refresh erneut holt.
   */
  const { toLoad, toReload } = useMemo(() => {
    const load: string[] = [];
    const reload: string[] = [];
    const walk = (nodes: FileNode[]) => {
      for (const node of nodes) {
        if (node.isDir && node.children && expandedPaths.has(node.fullPath)) {
          (childrenByPath.has(node.fullPath) ? reload : load).push(node.fullPath);
        }
        if (node.children) walk(node.children);
      }
    };
    walk(treeData);
    return { toLoad: load, toReload: reload };
  }, [treeData, expandedPaths, childrenByPath]);

  useEffect(() => {
    for (const fullPath of toLoad) loadDirectory(fullPath);
  }, [toLoad, loadDirectory]);

  /**
   * `toReload` steht in einem Ref, weil der Refresh-Takt der Ausloeser ist
   * und nicht das Neuladen: als Effekt-Abhaengigkeit wuerde jede Antwort den
   * naechsten Refresh ausloesen und der Refresh den naechsten Refresh.
   */
  const reloadOnRefreshRef = useRef(toReload);
  reloadOnRefreshRef.current = toReload;

  /**
   * Die offenen Aeste fuer den Refresh. Auch sie stehen in einem Ref, weil das
   * Auf- und Zuklappen keinen Refresh ausloesen soll: sonst wuerde ein
   * Klick auf das Chevron allen anderen offenen Ordnern einen neuen
   * Netzzugriff auf den Hals haengen.
   */
  const expandedPathsRef = useRef(expandedPaths);
  expandedPathsRef.current = expandedPaths;

  /**
   * `initialOpenState` wird nur einmal gelesen: beim Anlegen der Baum-Instanz.
   * Deshalb bekommt der Baum einen Schluessel, der Projektordner und
   * angezeigten Ordner nennt — bei jedem Wechsel davon sind es andere Knoten,
   * und die offenen Aeste des neuen Baums kommen aus dem Blick, den der
   * Explorer fuehrt.
   */
  const treeResetKey = `${cwd}\u0000${currentPath}`;
  const initialOpenState = useMemo(() => {
    const open: Record<string, boolean> = {};
    for (const fullPath of expandedPaths) open[fullPath] = true;
    return open;
  }, [expandedPaths]);

  const changedDirectoryPaths = useMemo(() => {
    const directories = new Set<string>();
    const normalizedCwd = normalizeFilePathSlashes(cwd).replace(/\/$/, "");
    for (const status of gitFiles) {
      let directory = getFileDirectory(normalizeFilePathSlashes(status.filePath));
      while (directory === normalizedCwd || directory.startsWith(`${normalizedCwd}/`)) {
        directories.add(directory);
        if (directory === normalizedCwd) break;
        const parent = getFileDirectory(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    return directories;
  }, [cwd, gitFiles]);

  /**
   * Ein Ast wurde aufgeklappt oder zugeklappt.
   *
   * Das Aufklappen holt den Inhalt mit. Der Abgleich der offenen Ordner
   * wuerde das ebenfalls tun, aber nur, wenn sich sein Ergebnis aendert — und
   * das tut es bei einem Ordner, dessen Anfrage zuvor fehlgeschlagen ist,
   * nicht. Der zweite Versuch gehoert darum hierher: er ist der Weg, auf dem
   * das Chevron arbeitet.
   */
  const handleToggleExpanded = useCallback((fullPath: string, open: boolean) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (open) next.add(fullPath); else next.delete(fullPath);
      return next;
    });
    if (open) loadDirectory(fullPath);
  }, [loadDirectory]);

  const handleNavigate = useCallback((fullPath: string) => {
    setCurrentPath(fullPath);
    // Navigation collapses the previously expanded branches so the new
    // starting point is a clean view; the user can re-expand from there.
    setExpandedPaths(new Set());
    // Jeder Sprung in einen Ordner gehoert in die Historie, egal ob er vom
    // Zeilenklick, vom Breadcrumb, von Up oder von Home kam: zurueck soll den
    // Weg zuruecknehmen, den der Nutzer gegangen ist, nicht nur einen Teil
    // davon. Steht der Pfad schon an der Spitze, wird nichts eingetragen —
    // sonst wuesste die Historie bei jedem Klick auf den Ordner, in dem man
    // bereits ist, und der Weg waere nicht mehr abzaehlbar.
    setHistory((prev) => {
      if (prev.paths[prev.index] === fullPath) return prev;
      // Alles nach dem Zeiger faellt weg. Genau das ist der Unterschied zum
      // Blättern in der Historie: ein neuer Sprung ist ein neuer Weg und macht
      // die alte Vorwaertsstrecke ungueltig, so wie im Browser.
      const paths = [...prev.paths.slice(0, prev.index + 1), fullPath];
      return { paths, index: paths.length - 1 };
    });
  }, []);

  const handleNavigateUp = useCallback(() => {
    // Der Elternordner aus dem aktuellen Pfad, nicht aus dem Updater: ein
    // Updater muss eine reine Funktion sein, und React ruft ihn in der
    // Entwicklung zweimal auf, um genau solche Seiteneffekte zu finden. Up ist
    // damit eine ganz normale Navigation und geht durch `handleNavigate` —
    // sonst stuende Up ausserhalb der Historie und waere der einzige Weg, den
    // zurueck nicht zuruecknimmt.
    const parent = getFileDirectory(currentPath);
    if (parent === currentPath) return;
    handleNavigate(parent);
  }, [currentPath, handleNavigate]);

  const handleNavigateHome = useCallback(() => {
    handleNavigate(homeDir);
  }, [handleNavigate, homeDir]);

  /**
   * Ein Schritt zurueck in der Historie. Am Anfang gibt es nichts zu tun, und
   * genau so verhaelt sich der Knopf: `disabled`, nicht abgelehnt. Der Weg
   * fuehrt auf denselben Punkt wie `handleNavigate`, schreibt aber keinen
   * neuen Eintrag — sonst wuerde zurueck die Liste verlaengern und man kaeme
   * nie wieder von dort weg.
   */
  const handleNavigateBack = useCallback(() => {
    // Aus dem Zustand, nicht aus einem Updater. `setCurrentPath` in einem
    // `setHistory`-Updater waere ein Seiteneffekt in einer Funktion, die React
    // in der Entwicklung zweimal aufruft, um genau solche zu finden — und die
    // beiden Aufrufe koennten unterschiedliche Stacks sehen. `history` steht
    // ohnehin im Scope, und die drei Setzer sind atomar genug: zwischen dem
    // Lesen und dem Setzen laeuft kein weiterer Klick.
    if (history.index <= 0) return;
    const index = history.index - 1;
    setCurrentPath(history.paths[index]);
    setExpandedPaths(new Set());
    setHistory((prev) => ({ paths: prev.paths, index }));
  }, [history]);

  /**
   * Ein Schritt vorwaerts, symmetrisch zu `handleNavigateBack`. Ohne sie waere
   * das Zurueck eine Einbahnstrasse: nach einem Sprung in die Historie gaebe es
   * keinen Weg mehr zum Ordner, aus dem man gekommen ist, und die Vorwaerts-
   * Haelfte des Stacks waere toter Zustand.
   */
  const handleNavigateForward = useCallback(() => {
    if (history.index >= history.paths.length - 1) return;
    const index = history.index + 1;
    setCurrentPath(history.paths[index]);
    setExpandedPaths(new Set());
    setHistory((prev) => ({ paths: prev.paths, index }));
  }, [history]);

  const canNavigateBack = history.index > 0;
  const canNavigateForward = history.index < history.paths.length - 1;

  // Das Menue haengt an einer Zeile, nicht an einem Element: der Pfad wandert
  // mit dem Navigieren mit, und ein Klick auf Breadcrumb, Leerflaeche oder eine
  // andere Zeile schliesst es, ohne dass diese Flaechen je einen Handler
  // bekommen. Das `null` hier ist derselbe Zustand, den das Panel selbst
  // ueber `onClose` zurueckmeldet.
  const handleOpenContextMenu = useCallback((
    fullPath: string,
    name: string,
    isDir: boolean,
    x: number,
    y: number,
  ) => {
    setMenuTarget({ x, y, path: fullPath, name, isDir });
  }, []);

  const closeContextMenu = useCallback(() => {
    setMenuTarget(null);
  }, []);

  /**
   * Die Auswahl, wie der Baum sie meldet.
   *
   * Der Baum kennt nur die Zeilen, die er gerade anzeigt, und meldet darum
   * auch nur diese. Der Explorer aber muss eine Auswahl ueber einen
   * Ordnerwechsel hinweg behalten — deshalb meldet der Baum nicht „das ist
   * jetzt alles", sondern „so sieht es bei mir aus", und der Explorer
   * entscheidet darueber, was davon uebernommen wird. Er vergleicht dabei
   * auch mit dem bisherigen Stand: `react-arborist` meldet ueber `onSelect`
   * zurueck, was er gerade bekommen hat, und ohne den Vergleich wuerde jede
   * Meldung wieder eine Meldung ausloesen.
   */
  const applySelection = useCallback((entries: SelectionEntry[]) => {
    setSelection((previous) => {
      if (previous.size === entries.length && entries.every((entry) => previous.has(entry.path))) {
        return previous;
      }
      return new Map(entries.map((entry) => [entry.path, entry]));
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelection(new Map());
  }, []);

  /**
   * Nimmt den gemeldeten Blick des Fenster-Explorers entgegen, aber nur wenn er
   * sich wirklich geaendert hat. Ohne diese Pruefung wuerde jedes Auf- und
   * Zuklappen einen neuen Zustand mit gleicher Bedeutung setzen und die
   * Seitenleiste neu rendern, waehrend der Inhalt unveraendert bleibt.
   */
  const handlePopupViewState = useCallback((view: ExplorerViewState) => {
    setPopupViewState((previous) => previous && sameViewState(previous, view) ? previous : view);
  }, []);

  /**
   * Der eine Weg, auf dem ein Bild den Explorer verlässt — ob per Zeilen-Klick,
   * per Augen-Knopf oder per Kontextmenü. `imageTarget` entscheidet, wohin:
   *
   * - `"preview"` (die Seitenleiste) setzt den Vorschau-Zustand. Das Overlay
   *   gehoert zu dieser Instanz und wird mit ihr aus dem DOM entfernt.
   * - `"openFile"` (die Instanz im Fenster) schickt das Bild an `onOpenFile`
   *   und damit in einen Tab. `setImagePreview` bliebe hier eine zweite,
   *   unsichtbare Anzeige: das Bild waere zweimal offen und nur einmal davon
   *   sichtbar, und der Zustand wuerde liegen bleiben, wenn der Tab wandert.
   *
   * Beide Ziele bekommen dieselben zwei Argumente, deshalb muss der Aufrufer
   * den Unterschied nicht kennen — er ruft nur `onOpenImage`.
   */
  const openImagePreview = useCallback((filePath: string, name: string) => {
    if (imageTarget === "openFile") {
      onOpenFile(filePath, name);
      return;
    }
    setImagePreview({ path: filePath, name });
  }, [imageTarget, onOpenFile]);

  /**
   * Oeffnet den Explorer im grossen Fenster. Der mitgegebene Blick ist der
   * Stand, den der zuletzt offene Fenster-Explorer gemeldet hat — er ist beim
   * ersten Oeffnen `null`, dann startet das Fenster bei `cwd`.
   */
  const openPopup = useCallback(() => {
    setPopupOpen(true);
  }, []);

  // Meldet den Zustand des Fensters nach aussen. Der Effekt haengt an
  // `popupOpen` selbst, nicht am Callback: die aufrufende Instanz gibt bei
  // jedem Rendern eine neue Pfeilfunktion, und haenge er daran, riefe er in
  // jedem Rendern zurueck — bei einer Meldung, die zurueck in den Zustand der
  // aufrufenden Instanz schreibt, waere das eine Endlosschleife.
  useEffect(() => {
    onPopupOpenChange?.(popupOpen);
  }, [popupOpen, onPopupOpenChange]);

  // Meldet `false`, wenn diese Instanz verschwindet, ohne dass das Fenster
  // geschlossen wurde — etwa weil die Seitenleiste den Explorer einklappt oder
  // das Arbeitsverzeichnis wechselt. Ohne diese Meldung bliebe der Zustand der
  // aufrufenden Seite dauerhaft auf "Fenster offen" stehen und die Trennlinien
  // der Seite blieben unsichtbar und tot, obwohl gar kein Fenster mehr da ist.
  useEffect(() => () => { onPopupOpenChange?.(false); }, [onPopupOpenChange]);

  const handleMutated = useCallback(() => {
    setTreeRefreshKey((key) => key + 1);
  }, []);

  // Fehler bleiben stehen, bis sie weggeklickt werden; Erfolgsmeldungen
  // verschwinden von selbst, weil sie nur eine Bestaetigung sind.
  const handleActionNotice = useCallback((notice: FileActionNotice) => {
    clearTimeout(noticeTimerRef.current ?? undefined);
    noticeTimerRef.current = null;
    setActionNotice(notice);
    if (notice.kind === "success") {
      noticeTimerRef.current = setTimeout(() => {
        noticeTimerRef.current = null;
        setActionNotice(null);
      }, 3200);
    }
  }, []);

  useEffect(() => () => clearTimeout(noticeTimerRef.current ?? undefined), []);

  /**
   * Neuer Ordner im aktuell angezeigten Verzeichnis. Dieselbe Route wie das
   * Kontextmenue (`POST ?type=mkdir`, Pfad = Elternordner, `name` = Segment),
   * damit beide Wege dieselbe Validierung durchlaufen. Die Namenspruefung
   * steht hier, weil die Toolbar keinen Formularschritt hat, in dem sie
   * sichtbar waere.
   */
  const handleNewFolder = useCallback((name: string) => {
    if (name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) {
      handleActionNotice({ kind: "error", text: t("files.invalidName") });
      return;
    }
    void fetch(`/api/file-actions/${encodeFilePathForApi(currentPath)}?type=mkdir`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({})) as { error?: string; reason?: string };
        if (!res.ok) {
          const message = data.error ?? data.reason ?? `HTTP ${res.status}`;
          handleActionNotice({ kind: "error", text: data.error && data.reason && data.reason !== data.error ? `${message} (${data.reason})` : message });
          return;
        }
        setTreeRefreshKey((key) => key + 1);
        handleActionNotice({ kind: "success", text: t("files.folderCreated", { name }) });
      })
      .catch((cause: unknown) => {
        handleActionNotice({ kind: "error", text: cause instanceof Error ? cause.message : String(cause) });
      });
  }, [currentPath, handleActionNotice, t]);

  /**
   * Kopieren oder Verschieben, eine Quelle nach der anderen.
   *
   * Die API kennt pro Anfrage genau eine Quelle, deshalb laeuft bei mehreren
   * Eintraegen eine Kette. Sie endet beim ersten Fehler: die Eintraege davor
   * sind schon verschoben, ein weiterer Versuch wuerde den Nutzer nur eine
   * halbe Aktion zeigen, die er nicht versteht.
   *
   * Der Weg ist derselbe fuer den Dialog der Toolbar und fuer das Ablegen im
   * Baum. Beide nutzen dieselbe Route mit derselben Fehlerbehandlung — der
   * Server entscheidet ueber Ziel existiert, Ordner in sich selbst und
   * fehlende Berechtigung, und diese Antwort erreicht den Nutzer unveraendert.
   */
  const performTransfer = useCallback(async (
    kind: "copy" | "move",
    entries: SelectionEntry[],
    destination: string,
  ): Promise<boolean> => {
    for (const entry of entries) {
      let result: { ok: boolean; text: string };
      try {
        const res = await fetch(`/api/file-actions/${encodeFilePathForApi(entry.path)}?type=${kind}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ destination }),
        });
        const data = await res.json().catch(() => ({})) as { error?: string; reason?: string };
        if (!res.ok) {
          const message = data.error ?? data.reason ?? `HTTP ${res.status}`;
          result = { ok: false, text: data.error && data.reason && data.reason !== data.error ? `${message} (${data.reason})` : message };
        } else {
          result = {
            ok: true,
            text: kind === "move" ? t("files.movedTo", { destination }) : t("files.copiedTo", { destination }),
          };
        }
      } catch (cause) {
        result = { ok: false, text: cause instanceof Error ? cause.message : String(cause) };
      }
      if (!result.ok) {
        handleActionNotice({ kind: "error", text: result.text });
        return false;
      }
      handleActionNotice({ kind: "success", text: result.text });
    }
    return true;
  }, [handleActionNotice, t]);

  /**
   * Copy/Move aus der Toolbar. Der Dialog bleibt fuer alle Quellen offen und
   * schliesst erst, wenn der letzte durch ist — auch dann, wenn einer
   * fehlschlug, denn die uebrigen sind dann schon verschoben.
   */
  const handleToolbarTransferConfirm = useCallback((destination: string) => {
    const pending = [...selection.values()];
    if (pending.length === 0) { setToolbarTransfer(null); return; }
    const kind = toolbarTransfer ?? "copy";
    void (async () => {
      const done = await performTransfer(kind, pending, destination);
      setToolbarTransfer(null);
      if (!done) return;
      setSelection(new Map());
      setTreeRefreshKey((key) => key + 1);
    })();
  }, [performTransfer, selection, toolbarTransfer]);

  /**
   * Ablegen im Baum. Der Baum uebergibt die gezogenen Knoten und den
   * Zielordner; verschoben wird mit derselben Kette wie aus der Toolbar, und
   * die Auswahl geht leer, weil die verschobenen Eintraege an ihrem Ort nicht
   * mehr existieren.
   */
  const handleDropMove = useCallback((entries: SelectionEntry[], destination: string) => {
    void (async () => {
      if (!await performTransfer("move", entries, destination)) return;
      setSelection(new Map());
      setTreeRefreshKey((key) => key + 1);
    })();
  }, [performTransfer]);

  // Der Zielordner wird einmal beim Start des Uploads als Wert uebernommen und
  // durch den ganzen Ablauf durchgereicht, statt in jedem Schritt neu aus dem
  // State gelesen zu werden. Grund: `prepareUpload` fragt erst die Konflikte
  // ab und schreibt dann, und dazwischen kann der Nutzer im Baum klicken. Ein
  // spaeter gelesenes `currentPath` wuerde die Datei in einen anderen Ordner
  // schreiben als den, den der Konflikt-Check gerade freigegeben hat — der
  // Benutzer bestaetigt "ersetzen" und bekommt trotzdem eine Datei an anderer
  // Stelle. Der Snapshot macht Check und Schreibvorgang nachweislich gleich.
  const applyUploadResult = useCallback((directory: string, data: UploadResponse) => {
    const uploaded = data.uploaded ?? [];
    const skipped = data.skipped ?? [];
    const errors = data.errors ?? [];
    setUploadSummary({ uploaded, skipped, errors, directory });

    if (uploaded.length > 0) {
      setHighlightedPaths(new Set(uploaded.map((name) => joinFilePath(directory, name))));
      setTreeRefreshKey((key) => key + 1);
    }
  }, []);

  const performUpload = useCallback(async (
    directory: string,
    files: File[],
    strategy: UploadConflictStrategy,
  ) => {
    setPendingConflict(null);
    setUploadError(null);
    setUploadProgress(0);
    setUploadPhase("uploading");

    try {
      const { status, data } = await uploadFiles(directory, files, strategy, setUploadProgress);
      if (status === 409 && data.conflicts?.length) {
        setPendingConflict({
          files,
          directory,
          conflicts: data.conflicts,
          nonReplaceable: data.nonReplaceable ?? [],
        });
        return;
      }
      if (status < 200 || status >= 300) {
        throw new Error(data.error ?? `Upload failed (HTTP ${status})`);
      }
      setUploadProgress(100);
      applyUploadResult(directory, data);
    } catch (uploadFailure) {
      setUploadError(uploadFailure instanceof Error ? uploadFailure.message : String(uploadFailure));
    } finally {
      setUploadPhase("idle");
    }
  }, [applyUploadResult]);

  const prepareUpload = useCallback(async (directory: string, files: File[]) => {
    if (files.length === 0 || uploadBusy) return;
    setUploadSummary(null);
    setHighlightedPaths(new Set());
    setPendingConflict(null);
    setUploadError(null);
    setUploadProgress(0);
    setUploadPhase("checking");

    try {
      const res = await fetch(
        `/api/files/${encodeFilePathForApi(directory)}?type=upload-check`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileNames: files.map((file) => file.name) }),
        },
      );
      const data = await res.json().catch(() => ({})) as UploadResponse;
      if (!res.ok) throw new Error(data.error ?? `Upload check failed (HTTP ${res.status})`);

      if (data.conflicts?.length) {
        setPendingConflict({
          files,
          directory,
          conflicts: data.conflicts,
          nonReplaceable: data.nonReplaceable ?? [],
        });
        return;
      }

      await performUpload(directory, files, "error");
    } catch (uploadFailure) {
      setUploadError(uploadFailure instanceof Error ? uploadFailure.message : String(uploadFailure));
    } finally {
      setUploadPhase("idle");
    }
  }, [performUpload, uploadBusy]);

  const handleUploadInput = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    // `currentPath` ist der Ordner, den der Breadcrumb zeigt — dort landet der
    // Upload, nicht in der Projektwurzel, die `cwd` nur als Startpunkt setzt.
    void prepareUpload(currentPath, files);
  }, [currentPath, prepareUpload]);

  useImperativeHandle(ref, () => ({
    openUploadPicker() {
      if (!uploadBusy) uploadInputRef.current?.click();
    },
  }), [uploadBusy]);

  // Laedt den Baum neu, meldet nach aussen (Git-Stand im Datei-Tab) und zeigt
  // den Haken. Der Timer wird vorher geraeumt, damit ein zweiter Klick die
  // Anzeige nicht vorzeitig zurueckstellt.
  const handleRefresh = useCallback(() => {
    setTreeRefreshKey((key) => key + 1);
    onRefresh?.();
    setRefreshDone(true);
    clearTimeout(refreshDoneTimerRef.current ?? undefined);
    refreshDoneTimerRef.current = setTimeout(() => {
      refreshDoneTimerRef.current = null;
      setRefreshDone(false);
    }, 2000);
  }, [onRefresh]);

  useEffect(() => () => clearTimeout(refreshDoneTimerRef.current ?? undefined), []);

  /**
   * Ein Refresh macht auch die Unterordner ungueltig.
   *
   * Die Wurzel laedt der Effekt unten bei jedem `treeRefreshKey` neu. Die
   * Unterordner liegen im Zwischenspeicher und waeren sonst eine Momentaufnahme
   * aus dem Augenblick, in dem sie zuletzt aufgeklappt wurden — dieselbe
   * Menge holt der Refresh hier erneut, ohne vorher zu leeren. Das Leeren
   * waere zwar einfacher, liesse den Baum aber bei jedem Takt kollabieren und
   * wieder aufbauen.
   *
   * Weggeraeumt wird nur, was zu niemandem gehoert: geschlossene Aeste. Ohne
   * diesen Schritt wuerde der Zwischenspeicher ueber eine Sitzung hinweg jeden
   * Ordner behalten, den der Nutzer einmal aufgesucht hat — vorher verschwand
   * das mit dem Auseinbauen der Zeile von selbst.
   */
  useEffect(() => {
    const reachable = new Set<string>();
    for (const fullPath of expandedPathsRef.current) {
      reachable.add(fullPath);
      let directory = getFileDirectory(fullPath);
      while (directory && !reachable.has(directory)) {
        reachable.add(directory);
        const parent = getFileDirectory(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    setChildrenByPath((previous) => {
      const next = new Map<string, FileNode[]>();
      for (const [fullPath, children] of previous) {
        if (reachable.has(fullPath)) next.set(fullPath, children);
      }
      return next.size === previous.size ? previous : next;
    });
    for (const fullPath of reloadOnRefreshRef.current) loadDirectory(fullPath);
  }, [treeRefreshKey, loadDirectory]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/home")
      .then((res) => res.ok ? res.json() as Promise<{ home: string }> : null)
      .then((data) => {
        if (!cancelled && data?.home) setHomeDir(data.home);
      })
      .catch(() => { /* keep the default of `/` */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    // Der ERSTE Lauf ist kein cwd-Wechsel. `prevCwdRef` ist absichtlich `null`
    // statt `cwd`, damit sich beides unterscheiden laesst: als Wechsel gewertet
    // wuerde der erste Lauf genau den Blick aus `initialViewState` wieder
    // wegraeumen, den diese Instanz gerade uebernommen hat. Zurueckgesetzt
    // wird nur beim echten Wechsel des Projektordners; die Ladeanzeige
    // erscheint in beiden Faellen.
    const firstRun = prevCwdRef.current === null;
    const cwdChanged = !firstRun && prevCwdRef.current !== cwd;
    prevCwdRef.current = cwd;

    // Reset expanded state and snap navigation back to the project root
    // when the externally-provided cwd changes (e.g. user picked a new
    // project). Same trigger also clears uploads and highlights.
    if (cwdChanged) {
      setExpandedPaths(new Set());
      setHighlightedPaths(new Set());
      setUploadSummary(null);
      setPendingConflict(null);
      setUploadError(null);
      setCurrentPath(cwd);
      // Die Historie gehoert zum alten Projekt: zurueck und vorwaerts ueber
      // Ordner des vorherigen Projekts zu fuehren ist kein Weg, den jemand
      // bewusst gegangen ist. Sie faellt mit dem Pfad auf den neuen Start zurueck.
      setHistory(historyStartingAt(cwd));
    }

    setLoading(firstRun || cwdChanged);
    setError(null);
    // Wichtig ist hier, WAS eine Antwort verwirft — nicht, ob der Effekt
    // noch einmal lief. Ein Refresh-Takt (`treeRefreshKey`) und ein Klick auf
    // den Refresh-Knopf (`refreshKey`) starten dieselbe Abfrage erneut, ohne
    // den Pfad zu wechseln. Ein `cancelled`-Flag pro Effektlauf hat jede
    // laufende Antwort verworfen, sobald der naechste Takt kam; ist die
    // Antwort langsamer als der Takt (gemessen: 8,2 s gegen 5 s), verwirft der
    // Effekt ausnahmslos jede Antwort und `roots` bleibt leer, obwohl die API
    // eine gefuellte Liste liefert. Verworfen wird deshalb nur, was zu einem
    // Pfad gehoert, den die Ansicht inzwischen verlassen hat.
    listPathRef.current = currentPath;
    fetchEntries(currentPath)
      .then((entries) => { if (listPathRef.current === currentPath) setRoots(entries); })
      .catch((e) => { if (listPathRef.current === currentPath) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (listPathRef.current === currentPath) setLoading(false); });
  }, [cwd, currentPath, refreshKey, treeRefreshKey]);

  // Auto-refresh the listing every 5 seconds. Bumping treeRefreshKey
  // re-runs the entry fetch above (and the git-status effect below) without
  // disturbing navigation state — expanded paths, currentPath, and
  // highlights all survive the round-trip.
  useEffect(() => {
    const interval = setInterval(() => {
      setTreeRefreshKey((key) => key + 1);
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchGitStatus(cwd)
      .then((status) => {
        if (!cancelled) {
          setGitFiles(status.isGitRepository ? status.files : []);
          setGitLineStats(status.isGitRepository
            ? { additions: status.additions, deletions: status.deletions }
            : { additions: 0, deletions: 0 });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setGitFiles([]);
          setGitLineStats({ additions: 0, deletions: 0 });
        }
      });
    return () => { cancelled = true; };
  }, [cwd, refreshKey, treeRefreshKey]);

  useEffect(() => {
    onChangesCountChange?.(gitFiles.length);
  }, [gitFiles, onChangesCountChange]);

  const showUploadFeedback = uploadBusy || pendingConflict !== null || uploadError !== null || uploadSummary !== null;

  const addUploadedFilesToChat = useCallback(() => {
    if (!uploadSummary || uploadSummary.uploaded.length === 0) return;
    onAtMentions?.(
      // Relativ zur Projektwurzel, nicht zum Zielordner: das Modell loest
      // einen @-Namen gegen sein Arbeitsverzeichnis auf. `directory` ist der
      // Ordner, in den wirklich geschrieben wurde, `cwd` die Wurzel, gegen
      // die relativiert wird — ein Unterordner wird so zu `unterordner/datei`.
      uploadSummary.uploaded.map((name) =>
        getRelativeFilePath(joinFilePath(uploadSummary.directory, name), cwd),
      ),
    );
  }, [cwd, onAtMentions, uploadSummary]);

  return (
    <div
      style={{ minHeight: "100%" }}
      // Rechtsklick auf die Wurzelflaeche: kein Systemmenue, das Menue
      // gehoert zu einer Zeile, nicht zu jedem freien Stueck des Panels.
      onContextMenu={(event) => {
        if (event.target === event.currentTarget) event.preventDefault();
      }}
    >
      <input ref={uploadInputRef} type="file" multiple hidden onChange={handleUploadInput} />
      {showUploadFeedback && (
        <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
        {uploadBusy && (
          <div role="status" aria-live="polite" aria-label={uploadPhase === "checking" ? t("files.checking") : t("files.uploading", { progress: uploadProgress })}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, minHeight: 14, color: "var(--text-muted)" }}>
              {uploadPhase === "checking" ? (
                <Spin style={{ display: "inline-flex" }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                  <path d="M21 12a9 9 0 1 1-5.7-8.4" />
                </svg>
              </Spin>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 16V4" />
                  <path d="m7 9 5-5 5 5" />
                  <path d="M5 20h14" />
                </svg>
              )}
              {uploadPhase === "uploading" && <span style={{ fontSize: 10 }}>{uploadProgress}%</span>}
            </div>
            {uploadPhase === "uploading" && (
              <div style={{ height: 3, marginTop: 4, overflow: "hidden", borderRadius: 2, background: "var(--border)" }}>
                <div style={{ width: `${uploadProgress}%`, height: "100%", background: "var(--text-muted)", transition: "width 120ms ease" }} />
              </div>
            )}
          </div>
        )}

        {pendingConflict && (
          <div role="alert" style={{ padding: 7, border: "1px solid color-mix(in srgb, #f59e0b 55%, var(--border))", borderRadius: 4, background: "color-mix(in srgb, #f59e0b 9%, var(--bg-panel))" }}>
            <div style={{ fontSize: 11, color: "var(--text)", lineHeight: 1.35, overflowWrap: "anywhere" }}>
              {t("files.conflictSummary", { count: pendingConflict.conflicts.length, countSuffix: pendingConflict.conflicts.length === 1 ? "" : "s", files: pendingConflict.conflicts.join(", ") })}
            </div>
            {pendingConflict.nonReplaceable.length > 0 && (
              <div style={{ marginTop: 3, fontSize: 10, color: "#f59e0b", lineHeight: 1.35, overflowWrap: "anywhere" }}>
                {t("files.cannotReplace", { files: pendingConflict.nonReplaceable.join(", ") })}
              </div>
            )}
            <div style={{ display: "flex", gap: 5, marginTop: 7 }}>
              <button type="button" onClick={() => void performUpload(pendingConflict.directory, pendingConflict.files, "overwrite")} style={{ height: 22, padding: "0 7px", border: "1px solid #ef4444", borderRadius: 4, background: "transparent", color: "#ef4444", cursor: "pointer", fontSize: 10 }}>
                {t("files.replace")}
              </button>
              <button type="button" onClick={() => void performUpload(pendingConflict.directory, pendingConflict.files, "skip")} style={{ height: 22, padding: "0 7px", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: 10 }}>
                {t("files.skipExisting")}
              </button>
              <button type="button" onClick={() => setPendingConflict(null)} style={{ height: 22, padding: "0 7px", border: "none", borderRadius: 4, background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 10 }}>
                {t("files.cancel")}
              </button>
            </div>
          </div>
        )}

        {uploadError && (
          <div role="alert" style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 11, lineHeight: 1.35, color: "#f87171" }}>
            <span style={{ minWidth: 0, flex: 1, overflowWrap: "anywhere" }}>{uploadError}</span>
            <DismissButton onClick={() => setUploadError(null)} title={t("files.dismissError")} />
          </div>
        )}

        {uploadSummary && (
          <div aria-live="polite">
            <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 22, fontSize: 11 }}>
              <div style={{ minWidth: 0, flex: 1, display: "flex", alignItems: "center", gap: 8 }}>
                {uploadSummary.uploaded.length > 0 && (
                  <span title={`${uploadSummary.uploaded.length} uploaded`} aria-label={`${uploadSummary.uploaded.length} uploaded`} style={{ display: "flex", alignItems: "center", gap: 3, color: "#22c55e" }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="m5 12 4 4L19 6" />
                    </svg>
                    <span>{uploadSummary.uploaded.length}</span>
                  </span>
                )}
                {uploadSummary.skipped.length > 0 && (
                  <span title={`${uploadSummary.skipped.length} skipped`} aria-label={`${uploadSummary.skipped.length} skipped`} style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--text-dim)" }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M8 12h8" />
                    </svg>
                    <span>{uploadSummary.skipped.length}</span>
                  </span>
                )}
                {uploadSummary.errors.length > 0 && (
                  <span title={`${uploadSummary.errors.length} failed`} aria-label={`${uploadSummary.errors.length} failed`} style={{ display: "flex", alignItems: "center", gap: 3, color: "#f87171" }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 3 2.5 20h19L12 3Z" />
                      <path d="M12 9v4" />
                      <path d="M12 17h.01" />
                    </svg>
                    <span>{uploadSummary.errors.length}</span>
                  </span>
                )}
              </div>
              {uploadSummary.uploaded.length > 0 && onAtMentions && (
                <Pressable
                  type="button"
                  onClick={addUploadedFilesToChat}
                  title={uploadSummary.uploaded.length === 1 ? t("files.addUploadedFile") : t("files.addAllUploadedFiles")}
                  aria-label={uploadSummary.uploaded.length === 1 ? t("files.addUploadedFile") : t("files.addAllUploadedFiles")}
                  style={{ height: 22, padding: "0 7px", display: "flex", alignItems: "center", justifyContent: "center", gap: 4, flexShrink: 0, border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-panel)", color: "var(--accent)", cursor: "pointer", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}
                >
                  <MentionIcon />
                  {t("files.mention")}
                </Pressable>
              )}
              <DismissButton onClick={() => setUploadSummary(null)} title={t("files.dismissUploadResults")} />
            </div>
            {uploadSummary.errors.map((item) => (
              <div key={item.name} title={item.error} style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 3, minWidth: 0, fontSize: 10, color: "#f87171" }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 8v5" />
                  <path d="M12 17h.01" />
                </svg>
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</span>
              </div>
            ))}
          </div>
        )}
        </div>
      )}

      {!changesCollapsed && gitFiles.length > 0 && (
        <div style={{ padding: "0 4px 2px" }}>
          <div
            aria-label={t("files.changeStats", {
              count: gitFiles.length,
              additions: gitLineStats.additions,
              deletions: gitLineStats.deletions,
            })}
            style={{ display: "flex", alignItems: "center", gap: 6, height: 24, padding: "0 10px", fontSize: 12 }}
          >
            <span style={{ color: "var(--text-dim)" }}>
              {t("files.changedCount", { count: gitFiles.length })}
            </span>
            <span style={{ color: GIT_STATUS_COLORS.added, fontFamily: "var(--font-mono)" }}>+{gitLineStats.additions}</span>
            <span style={{ color: GIT_STATUS_COLORS.deleted, fontFamily: "var(--font-mono)" }}>-{gitLineStats.deletions}</span>
          </div>
          {gitFiles.map((status) => (
            <ChangeRow key={status.filePath} status={status} cwd={cwd} onOpenFile={onOpenFile} t={t} />
          ))}
        </div>
      )}

      {/* Die Werkzeuge stehen ueber der Aenderungsliste und dem Baum, nicht
          darin: mit aufgeklappter Liste waeren Refresh und Upload sonst weg. */}
      {!loading && !error && (
        <div style={{ padding: "2px 4px 0" }}>
          <ExplorerToolbar
            selection={[...selection.values()]}
            uploadBusy={uploadBusy}
            onNewFolder={handleNewFolder}
            onRefresh={handleRefresh}
            refreshDone={refreshDone}
            onUpload={() => { if (!uploadBusy) uploadInputRef.current?.click(); }}
            onCopyTo={() => setToolbarTransfer("copy")}
            onMoveTo={() => setToolbarTransfer("move")}
            onClearSelection={clearSelection}
            onProperties={() => {
              const [first] = [...selection.values()];
              if (first) setPropertiesTarget(first);
            }}
            onOpenPopup={allowPopup ? openPopup : undefined}
            t={t}
          />
        </div>
      )}

      {(changesCollapsed || gitFiles.length === 0) && (
        <div style={{ padding: "2px 4px" }}>
          {loading ? (
            <div
              role="status"
              aria-label={t("files.loading")}
              style={{ display: "flex", flexDirection: "column", gap: 8, padding: "8px 12px" }}
            >
              {Array.from({ length: 10 }, (_, index) => (
                <Skeleton key={index} height={18} />
              ))}
            </div>
          ) : error ? (
            <div style={{ padding: "8px 12px", fontSize: 11, color: "#f87171" }}>{error}</div>
          ) : (
            <>
              <Breadcrumb
                currentPath={currentPath}
                projectRoot={cwd}
                homeDir={homeDir}
                canGoBack={canNavigateBack}
                canGoForward={canNavigateForward}
                onNavigate={handleNavigate}
                onNavigateUp={handleNavigateUp}
                onNavigateHome={handleNavigateHome}
                onNavigateBack={handleNavigateBack}
                onNavigateForward={handleNavigateForward}
                t={t}
              />
              {roots.length > 0 && (
                <ExplorerTree
                  data={treeData}
                  cwd={cwd}
                  currentPath={currentPath}
                  resetKey={treeResetKey}
                  initialOpenState={initialOpenState}
                  loadingPaths={loadingPaths}
                  highlightedPaths={highlightedPaths}
                  gitStatusByPath={gitStatusByPath}
                  changedDirectoryPaths={changedDirectoryPaths}
                  selection={selection}
                  imagePreviewEnabled={imageTarget === "preview"}
                  onToggleExpanded={handleToggleExpanded}
                  onNavigate={handleNavigate}
                  onOpenFile={onOpenFile}
                  onContextMenu={handleOpenContextMenu}
                  onSelectionChange={applySelection}
                  onDropMove={handleDropMove}
                  onAtMention={onAtMention}
                  onOpenImage={openImagePreview}
                  t={t}
                />
              )}
            </>
          )}
          {!loading && !error && roots.length === 0 && (
            <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>
              {t("files.noFiles")}
            </div>
          )}
        </div>
      )}

      {menuTarget && (
        <FileContextMenu
          target={menuTarget}
          onClose={closeContextMenu}
          onMutated={handleMutated}
          onNotify={handleActionNotice}
          // Der Eintrag "Vorschau" haengt in `FileContextMenu` allein daran,
          // ob dieser Callback gesetzt ist (Zeile 399). Bei `"openFile"` waere
          // er damit zweierlei: er ruft zwar ueber `openImagePreview` den Tab
          // auf, heisst aber "Vorschau", laesst das Menue offen und verspricht
          // ein Overlay, das es hier gar nicht gibt. Kein Callback, kein
          // Eintrag — der Klick auf die Bildzeile im Fenster reicht fuer den
          // Tab. In der Seitenleiste ist `imageTarget` "preview", dort bleibt
          // der Eintrag also genau wie zuvor.
          onOpenImage={imageTarget === "preview" ? openImagePreview : undefined}
        />
      )}
      {toolbarTransfer && selection.size > 0 && (
        // Startpunkt ist der Elternordner des ersten markierten Eintrags: das
        // ist der Ordner, aus dem heraus man am ehesten ein anderes Ziel waehlt.
        <FileBrowserDialog
          open
          title={toolbarTransfer === "move"
            ? t("files.moveDialogTitle", { name: [...selection.values()][0].name })
            : t("files.copyDialogTitle", { name: [...selection.values()][0].name })}
          initialPath={getFileDirectory([...selection.values()][0].path) || "/"}
          confirmLabel={toolbarTransfer === "move" ? t("files.moveHere") : t("files.copyHere")}
          onCancel={() => setToolbarTransfer(null)}
          onConfirm={handleToolbarTransferConfirm}
        />
      )}
      {propertiesTarget && (
        <PropertiesDialog target={propertiesTarget} onClose={() => setPropertiesTarget(null)} t={t} />
      )}
      {imagePreview && (
        <FileImagePreview
          open
          filePath={imagePreview.path}
          fileName={imagePreview.name}
          onClose={() => setImagePreview(null)}
        />
      )}
      {popupOpen && (
        // Beim Schliessen faellt `popupOpen` auf `false` und der ganze Baum
        // wird aus dem DOM entfernt. `popupViewState` ueberlebt das und ist
        // der Startzustand des naechsten Fensters.
        <FileExplorerWindow
          cwd={cwd}
          changesCollapsed={changesCollapsed}
          initialViewState={popupViewState ?? undefined}
          onViewStateChange={handlePopupViewState}
          onClose={() => setPopupOpen(false)}
          t={t}
        />
      )}
      {actionNotice && (
        <FileActionToast notice={actionNotice} onDismiss={() => setActionNotice(null)} />
      )}
    </div>
  );
});
