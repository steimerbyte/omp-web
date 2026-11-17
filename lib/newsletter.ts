/**
 * Newsletter-Domaene: Ausgabenmodell, Grenzen, Normalisierung und der Prompt,
 * mit dem die geplante Aufgabe ihre Recherche ausfuehrt.
 *
 * ### Warum Zeitung und Termin dasselbe Muster haben
 *
 * Ein Newsletter ist kein eigener Speicher, sondern ein Datensatz neben einer
 * geplanten Aufgabe: `lib/scheduled-tasks-store.ts` besitzt den Zeitplan, den
 * Lauf und die Modellwahl, dieses Modul besitzt nur das, was die Aufgabe
 * *erzeugt* — die Ausgaben. Der Datensatz traegt deshalb `taskId` statt eines
 * zweiten Cron-Feldes; zwei Zeitplaene fuer denselben Newsletter waeren zwei
 * Wahrheiten.
 *
 * ### Warum diese Datei kein `fs` und kein `fetch` anfasst
 *
 * Dieselbe Linie wie `lib/calendar.ts`: die Domaene rechnet, sie speichert
 * nicht. Die Ablage steht in `lib/newsletter-store.ts`, das Werkzeug in
 * `lib/newsletter-tool.ts`, die Routen in `app/api/newsletters`. Damit laesst
 * sich jede Regel hier ohne Dateisystem und ohne Netz pruefen.
 *
 * ### Die Grenzen
 *
 * Die Zahlen sind bewusst endlich: `MAX_ISSUES_KEPT` verhindert, dass die
 * Datei mit jedem Lauf waechst, `MAX_SECTIONS` und `MAX_ITEMS_PER_SECTION`
 * verhindern, dass ein Modell die Antwort in einen unlesbaren Stapel
 * verwandelt. Zu lange Werte werden **verworfen**, nicht abgeschnitten: ein
 * halber Satz in der Ausgabe ist schlimmer als kein Satz, und der Nutzer
 * bekommt die Ausgabe, die er sonst nie geschrieben haette.
 */

import { nextRunAfter, parseSchedule } from "./schedule";

/** Ein einzelner Beitrag einer Ausgabe. */
export interface NewsletterItem {
  title: string;
  summary?: string;
  /** Die Quelle, die das Modell tatsaechlich gelesen hat. */
  url?: string;
}

/** Ein Abschnitt einer Ausgabe — genau ein Thema. */
export interface NewsletterSection {
  topic: string;
  headline?: string;
  summary?: string;
  items: NewsletterItem[];
}

/** Eine Ausgabe des Newsletters, so wie sie im Archiv steht. */
export interface NewsletterIssue {
  id: string;
  generatedAt: string;
  title?: string;
  intro?: string;
  sections: NewsletterSection[];
}

/** Ein Newsletter eines Kontos. */
export interface Newsletter {
  id: string;
  name: string;
  /** Die Themen, je Abschnitt der Ausgabe eines. */
  topics: string[];
  provider: string;
  modelId: string;
  /** Die geplante Aufgabe, die die Ausgaben erzeugt. */
  taskId: string;
  createdAt: string;
  updatedAt: string;
  /** Neueste Ausgabe zuerst; hoechstens {@link MAX_ISSUES_KEPT}. */
  issues: NewsletterIssue[];
}

/** Die hoechste Anzahl Themen eines Newsletters. */
export const MAX_NEWSLETTER_TOPICS = 10;

/** Der laengste erlaubte Newsletter-Name. */
export const MAX_NEWSLETTER_NAME_LENGTH = 100;

/** Die laengste erlaubte Laenge eines Themas. */
export const MAX_TOPIC_LENGTH = 120;

/** Die hoechste Anzahl aufbewahrter Ausgaben — aeltere fallen beim Schreiben weg. */
export const MAX_ISSUES_KEPT = 20;

/** Die hoechste Anzahl Abschnitte einer Ausgabe. */
export const MAX_SECTIONS = 12;

/** Die hoechste Anzahl Beitraege pro Abschnitt. */
export const MAX_ITEMS_PER_SECTION = 10;

/** Der laengste erlaubte Titel einer Ausgabe. */
export const MAX_ISSUE_TITLE_LENGTH = 200;

/** Die laengste erlaubte Einleitung einer Ausgabe. */
export const MAX_INTRO_LENGTH = 1200;

/** Die laengste erlaubte Zeile eines Abschnitts oder Beitrags. */
export const MAX_HEADLINE_LENGTH = 200;

/** Die laengste erlaubte Zusammenfassung eines Beitrags. */
export const MAX_ITEM_SUMMARY_LENGTH = 400;

/** `true`, wenn der Wert etwas ist, das `Date.parse` als Zeitpunkt liest. */
function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Date.parse(value));
}

/** `true`, wenn der Wert eine absolute HTTP(S)-Adresse ist. */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Die Themen eines Newsletters aus ungeprueftem Material.
 *
 * Getrimmt, duplikatfrei (ohne Ruecksicht auf Gross- und Kleinschreibung) und
 * gekappt: "Klima" und "klima " sind dasselbe Thema und wuerden sonst zwei
 * Abschnitte erzeugen, die beide dasselbe recherchieren. Ein leeres oder zu
 * langes Thema faellt weg statt gekuerzt zu werden.
 */
export function normalizeTopics(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const topics: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const topic = entry.trim();
    if (!topic || topic.length > MAX_TOPIC_LENGTH) continue;
    const key = topic.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    topics.push(topic);
    if (topics.length >= MAX_NEWSLETTER_TOPICS) break;
  }
  return topics;
}

/**
 * Ein Beitrag aus ungeprueftem Material — oder `null`, wenn er unbrauchbar ist.
 *
 * Ohne Titel ist ein Beitrag nichts, was ein Leser anklicken kann; eine
 * Zusammenfassung oder eine Adresse, die die Grenze reisst, faellt weg, der
 * Beitrag bleibt. Eine `javascript:`-Adresse ist keine Quelle und wird nie
 * gespeichert.
 */
export function normalizeNewsletterItem(value: unknown): NewsletterItem | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;

  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title || title.length > MAX_HEADLINE_LENGTH) return null;

  const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
  const url = typeof raw.url === "string" ? raw.url.trim() : "";

  return {
    title,
    ...(summary && summary.length <= MAX_ITEM_SUMMARY_LENGTH ? { summary } : {}),
    ...(url && isHttpUrl(url) ? { url } : {}),
  };
}

/**
 * Ein Abschnitt aus ungeprueftem Material — oder `null`.
 *
 * Ein Abschnitt ohne Thema oder ohne einen einzigen lesbaren Beitrag ist kein
 * Abschnitt: eine Ueberschrift ueber einer leeren Liste ist eine Behauptung
 * ohne Inhalt.
 */
export function normalizeNewsletterSection(value: unknown): NewsletterSection | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;

  const topic = typeof raw.topic === "string" ? raw.topic.trim() : "";
  if (!topic || topic.length > MAX_TOPIC_LENGTH) return null;

  const items: NewsletterItem[] = [];
  if (Array.isArray(raw.items)) {
    for (const entry of raw.items) {
      const item = normalizeNewsletterItem(entry);
      if (!item) continue;
      items.push(item);
      if (items.length >= MAX_ITEMS_PER_SECTION) break;
    }
  }
  if (items.length === 0) return null;

  const headline = typeof raw.headline === "string" ? raw.headline.trim() : "";
  const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";

  return {
    topic,
    ...(headline && headline.length <= MAX_HEADLINE_LENGTH ? { headline } : {}),
    ...(summary && summary.length <= MAX_INTRO_LENGTH ? { summary } : {}),
    items,
  };
}

/** Die lesbaren Abschnitte einer Ausgabe, gekappt auf {@link MAX_SECTIONS}. */
export function normalizeNewsletterSections(value: unknown): NewsletterSection[] {
  if (!Array.isArray(value)) return [];
  const sections: NewsletterSection[] = [];
  for (const entry of value) {
    const section = normalizeNewsletterSection(entry);
    if (!section) continue;
    sections.push(section);
    if (sections.length >= MAX_SECTIONS) break;
  }
  return sections;
}

/** Eine Ausgabe aus ungeprueftem Material — oder `null`, wenn sie leer ist. */
export function normalizeIssue(value: unknown): NewsletterIssue | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;

  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) return null;
  if (!isTimestamp(raw.generatedAt)) return null;

  const sections = normalizeNewsletterSections(raw.sections);
  if (sections.length === 0) return null;

  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const intro = typeof raw.intro === "string" ? raw.intro.trim() : "";

  return {
    id,
    generatedAt: raw.generatedAt,
    ...(title && title.length <= MAX_ISSUE_TITLE_LENGTH ? { title } : {}),
    ...(intro && intro.length <= MAX_INTRO_LENGTH ? { intro } : {}),
    sections,
  };
}

/**
 * Die neuesten Ausgaben — hoechstens {@link MAX_ISSUES_KEPT}.
 *
 * `issues` liegt neueste-zuerst; der Aufrufer stellt die Reihenfolge her, diese
 * Funktion schneidet nur ab. Sie steht hier und nicht im Speicher, weil das
 * Werkzeug dieselbe Grenze braucht.
 */
export function trimIssues(issues: NewsletterIssue[]): NewsletterIssue[] {
  return issues.slice(0, MAX_ISSUES_KEPT);
}

/** Ein Newsletter aus ungeprueftem Material — oder `null`. */
export function normalizeNewsletter(value: unknown): Newsletter | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;

  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) return null;

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name || name.length > MAX_NEWSLETTER_NAME_LENGTH) return null;

  const topics = normalizeTopics(raw.topics);
  if (topics.length === 0) return null;

  const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
  const modelId = typeof raw.modelId === "string" ? raw.modelId.trim() : "";
  const taskId = typeof raw.taskId === "string" ? raw.taskId.trim() : "";
  if (!provider || !modelId || !taskId) return null;

  const createdAt = isTimestamp(raw.createdAt) ? raw.createdAt : new Date().toISOString();
  const updatedAt = isTimestamp(raw.updatedAt) ? raw.updatedAt : createdAt;

  const issues: NewsletterIssue[] = [];
  if (Array.isArray(raw.issues)) {
    for (const entry of raw.issues) {
      const issue = normalizeIssue(entry);
      if (!issue) continue;
      issues.push(issue);
      if (issues.length >= MAX_ISSUES_KEPT) break;
    }
  }

  return { id, name, topics, provider, modelId, taskId, createdAt, updatedAt, issues };
}

/**
 * Eine Liste von Newslettern, in der unbrauchbare Zeilen fehlen und doppelte
 * `id`s nur einmal vorkommen.
 *
 * Wie in `normalizeCalendarEvents`: eine kaputte Zeile darf die anderen nicht
 * mitreissen. Die Reihenfolge der Datei bleibt erhalten — sie ist die
 * Reihenfolge, in der die uebersicht sie zeigt.
 */
export function normalizeNewsletters(value: unknown): Newsletter[] {
  if (!Array.isArray(value)) return [];
  const newsletters: Newsletter[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const newsletter = normalizeNewsletter(entry);
    if (!newsletter) continue;
    if (seen.has(newsletter.id)) continue;
    seen.add(newsletter.id);
    newsletters.push(newsletter);
  }
  return newsletters;
}

/** Die Sicht auf den Zeitplan, die die Route beim Lesen dazujoint. */
export interface NewsletterSchedule {
  /** Der Ausdruck der geplanten Aufgabe — die einzige Quelle fuer den Client. */
  cron: string;
  enabled: boolean;
  nextRun: number | null;
  lastRunAt: string | null;
  lastRunStatus: "ok" | "error" | null;
}

/**
 * Der Zeitplan eines Newsletters, verbunden aus seiner Aufgabe.
 *
 * ### Warum der Datensatz den Cron nicht traegt
 *
 * Cron, `enabled` und der letzte Lauf stehen in der Aufgabe; der Newsletter
 * traegt nur `taskId`. Diese Funktion ist die eine Stelle, an der beides
 * zusammenkommt — die Liste und der Einzeldatensatz wuerden sonst zwei
 * Fassungen derselben Verbindung bauen, und eine davon wuerde beim naechsten
 * Feld auseinanderlaufen.
 *
 * `cron` geht mit hinaus, weil der Nutzer den Zeitplan bearbeiten koennen
 * muss: der PATCH-Body nimmt `cron`, und ohne dieses Feld kennt der Client
 * den aktuellen Wert nicht.
 *
 * ### Warum ein struktureller Parameter
 *
 * `ScheduledTask` kommt aus `lib/scheduled-tasks-store.ts`, und der zieht `fs`
 * nach. Diese Datei bleibt ohne Dateisystem — die vier Felder, die hier
 * gelesen werden, sind die ganze Schnittstelle, und ein `ScheduledTask` passt
 * strukturell hinein.
 *
 * `nextRun` wird serverseitig gerechnet: die Zeitplaene gelten in der Zone des
 * Servers, und ein Browser in einer anderen Zone wuerde eine andere Uhrzeit
 * anzeigen als die, zu der der Lauf stattfindet. `schedule: null` heisst "die
 * Aufgabe gibt es nicht mehr"; dann laeuft auch nichts mehr.
 */
export function newsletterSchedule(
  task: { cron: string; enabled: boolean; lastRunAt?: string; lastRunStatus?: "ok" | "error" } | null,
  nowMs: number,
): NewsletterSchedule | null {
  if (task === null) return null;
  let nextRun: number | null = null;
  if (task.enabled) {
    try {
      nextRun = nextRunAfter(parseSchedule(task.cron), nowMs);
    } catch {
      nextRun = null;
    }
  }
  return {
    cron: task.cron,
    enabled: task.enabled,
    nextRun,
    lastRunAt: task.lastRunAt ?? null,
    lastRunStatus: task.lastRunStatus ?? null,
  };
}

/**
 * Der Prompt, mit dem die geplante Aufgabe eine Ausgabe recherchiert.
 *
 * ### Warum der Prompt aus der Domaene kommt
 *
 * Er ist die Anweisung zu diesem Datensatz: Kennung, Name und Themen stehen
 * beide hier, und die Route, die den Newsletter anlegt oder aendert, ruft ihn
 * erneut auf. Ein Prompt, der in der Route zusammengebaut wird, wuerde bei
 * einem geaenderten Thema nicht mitwandern.
 *
 * ### Warum die Kennung genau einmal vorkommt
 *
 * Sie steht nur im Argument von `newsletter_write`. Zweimal genannt (etwa
 * noch in einer Ueberschrift) verleitet das Modell dazu, eine zweite Ausgabe
 * anzulegen oder die Kennung zu variieren; der Test zaehlt das Vorkommen.
 *
 * Die Anweisungen sind englisch, weil sie an das Modell gehen; der Inhalt, den
 * das Modell schreibt, ist deutsch, weil ihn der Nutzer liest.
 */
export function buildNewsletterPrompt(input: { id: string; name: string; topics: string[] }): string {
  const topics = input.topics.map((topic, index) => `${index + 1}. ${topic}`).join("\n");
  return [
    `You produce one issue of the newsletter "${input.name}".`,
    "",
    "Topics to research:",
    topics,
    "",
    "How to work:",
    "1. Research every topic above on the web, with current sources. Do not answer from memory and do " +
      "not invent anything.",
    "2. Publish the issue by calling the `newsletter_write` tool exactly once, with " +
      `\`newsletterId: "${input.id}"\`, a short German title and intro, and one section per topic.`,
    "3. Stop after that call. Do not call `newsletter_write` a second time in the same run.",
    "",
    "Rules for the issue:",
    "- One section per topic, in the order given above, with `topic` set to the topic's text.",
    "- Each section holds 3 to 5 items. Every item carries the real URL of a source you opened in this " +
      "run; drop an item rather than guessing its address.",
    "- Write the title, the intro and every headline and summary in German, calm and factual. Item " +
      "titles may keep the language of the source.",
    "- Never repeat an item that the latest issue already carried; this run is about what is new.",
    "- If a topic yields no usable source, leave that section out instead of padding it.",
    "- If nothing usable turns up at all, write nothing: do not call `newsletter_write` and do not " +
      "publish a placeholder issue.",
  ].join("\n");
}
