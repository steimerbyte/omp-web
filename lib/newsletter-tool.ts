import { Type } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-typebox";
import { defineTool } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import { randomUUID } from "crypto";
import {
  MAX_ISSUES_KEPT,
  MAX_ITEMS_PER_SECTION,
  MAX_SECTIONS,
  normalizeIssue,
  trimIssues,
  type Newsletter,
  type NewsletterIssue,
} from "./newsletter";
import { readNewsletterFile, writeNewsletterFile } from "./newsletter-store";
import type { WebIdentity } from "./request-identity";

/**
 * `newsletter_read` und `newsletter_write` — der Agent liest den Newsletter
 * des Kontos und legt eine neue Ausgabe an.
 *
 * Dieselben Begruendungen wie in `lib/calendar-tool.ts`: ein natives Tool
 * ueber `CreateAgentSessionOptions.customTools` (in jeder Sitzung vorhanden,
 * unabhaengig davon, ob das Projekt `.omp/extensions` freigibt), der
 * `defineTool`-Marker gegen die andere Argumentreihenfolge des SDK, und die
 * beim Sitzungsstart eingeschlossene Identitaet — ohne sie wuerde der Agent
 * eines Mandanten die Newsletter des Betreibers schreiben.
 *
 * Die geplante Aufgabe ruft den Agenten mit dem Prompt aus
 * `buildNewsletterPrompt`; sie kann nur ueber dieses Werkzeug eine Ausgabe
 * hinterlassen. Damit ist die Grenze zwischen "Agent denkt" und "Newsletter
 * aendert sich" genau ein Werkzeugaufruf.
 */

/** Die Identitaet, an die die Werkzeuge gebunden sind. */
export interface NewsletterToolContext {
  identity?: WebIdentity;
}

/** Ein ISO-Zeitpunkt in deutscher Schreibweise: `2026-11-17T…` als `17.11.2026`. */
function germanDate(iso: string): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
}

/**
 * Der Fehler fuer eine Kennung, die es in diesem Konto nicht gibt.
 *
 * Er nennt die gueltigen Kennungen, weil das Modell sonst raten muesste — und
 * eine geratene Kennung ist ein zweiter Fehlschlag.
 */
function unknownNewsletterId(newsletters: Newsletter[], id: string): Error {
  const valid = newsletters.length === 0 ? "(none yet)" : newsletters.map((entry) => entry.id).join(", ");
  return new Error(
    `Unknown 'newsletterId': no newsletter with the id '${id}' exists in this account. ` +
    `Valid ids: ${valid}. Call newsletter_read to see them.`,
  );
}

/**
 * Die Liste aller Newsletter fuer das Modell.
 *
 * Sie traegt die Kennung, weil genau sie der naechste `newsletter_write`
 * braucht — dieselbe Ueberlegung wie bei den Termin-Kennungen im Kalender.
 */
function describeNewsletters(newsletters: Newsletter[]): string {
  if (newsletters.length === 0) return "Dieses Konto hat noch keinen Newsletter.";
  const lines = newsletters.map((newsletter) => {
    const latest = newsletter.issues[0];
    return [
      `- ${newsletter.id} · ${newsletter.name} — ${newsletter.topics.length} Themen, ` +
        `${newsletter.issues.length} Ausgabe${newsletter.issues.length === 1 ? "" : "n"}, letzte Ausgabe: ` +
        `${latest ? germanDate(latest.generatedAt) : "keine"}`,
      `  Themen: ${newsletter.topics.join(", ")}`,
    ].join("\n");
  });
  return `Newsletter dieses Kontos: ${newsletters.length}\n${lines.join("\n")}`;
}

/** Die neueste Ausgabe eines Newsletters fuer das Modell. */
function describeLatestIssue(newsletter: Newsletter): string {
  const header = [
    `Newsletter "${newsletter.name}" (id: ${newsletter.id})`,
    `Themen: ${newsletter.topics.join(", ")}`,
    `Ausgaben aufbewahrt: ${newsletter.issues.length} (hoechstens ${MAX_ISSUES_KEPT}, neueste zuerst)`,
  ];
  const issue = newsletter.issues[0];
  if (!issue) {
    return [...header, "Noch keine Ausgabe — dieser Newsletter hat noch nichts veroeffentlicht."].join("\n");
  }

  const lines = [...header, "", `Neueste Ausgabe vom ${germanDate(issue.generatedAt)}`];
  if (issue.title) lines.push(`Titel: ${issue.title}`);
  if (issue.intro) lines.push(`Einleitung: ${issue.intro}`);
  lines.push("Diese Beitraege sind bereits erschienen — wiederhole sie nicht, berichte nur Neues:");

  for (const section of issue.sections.slice(0, MAX_SECTIONS)) {
    lines.push("", `## ${section.topic}${section.headline ? ` — ${section.headline}` : ""}`);
    if (section.summary) lines.push(section.summary);
    for (const item of section.items.slice(0, MAX_ITEMS_PER_SECTION)) {
      lines.push(`- ${item.title}${item.url ? ` — ${item.url}` : ""}`);
    }
  }
  return lines.join("\n");
}

/**
 * Die Newsletter-Werkzeuge fuer eine Sitzung.
 *
 * Eine Fabrik und keine Konstante: die Definition wird einmal pro Sitzung
 * gebaut und schliesst die Identitaet ein.
 */
export function makeNewsletterTools(context: NewsletterToolContext) {
  const { identity } = context;

  /**
   * Der Newsletter dieses Kontos, oder ein Fehler, der sagt, warum nicht.
   *
   * Die Meldung ist an den *Agenten* gerichtet: er soll nicht raten, warum das
   * Werkzeug nicht funktioniert, sondern es dem Nutzer erklaeren koennen.
   */
  const requireIdentity = (): WebIdentity => {
    if (!identity) {
      throw new Error(
        "This newsletter belongs to a signed-in account, and this session has none. " +
        "The newsletter is only usable in a session opened through the web with an account.",
      );
    }
    return identity;
  };

  const readTool = defineTool({
    name: "newsletter_read",
    label: "Newsletter lesen",
    description:
      "Read the user's newsletters: without an argument the list of every newsletter with its id, name, " +
      "topics and issue count; with a 'newsletterId' the newest issue of that newsletter, so you know " +
      "which items were already published. " +
      "Use it whenever the user asks about their newsletters or before you write an issue: the list " +
      "names the ids that newsletter_write needs, and the newest issue is what you must not repeat. " +
      "The answer is in German, for the user.",
    approval: "read",
    loadMode: "essential",
    parameters: Type.Object({
      newsletterId: Type.Optional(Type.String({
        description:
          "The id of one newsletter, taken from a previous newsletter_read. Leave it out to list all " +
          "newsletters with their ids.",
      })),
    }),

    async execute(_toolCallId, params) {
      const owner = requireIdentity();
      const { newsletters } = readNewsletterFile(owner);

      const id = params.newsletterId?.trim();
      if (!id) {
        return { content: [{ type: "text" as const, text: describeNewsletters(newsletters) }] };
      }

      const newsletter = newsletters.find((entry) => entry.id === id);
      if (!newsletter) throw unknownNewsletterId(newsletters, id);
      return { content: [{ type: "text" as const, text: describeLatestIssue(newsletter) }] };
    },
  });

  const writeTool = defineTool({
    name: "newsletter_write",
    label: "Newsletter schreiben",
    description:
      "Publish a new issue in one of the user's newsletters. The issue appears in the newsletter " +
      "immediately — the newsletter is the surface the user reads, not the chat. " +
      "One call publishes one issue; it is prepended and the oldest issues fall off after 20. " +
      "Pass the 'newsletterId' from newsletter_read, one section per researched topic, and 3 to 5 items " +
      "per section. Every item needs the real URL of a source you opened in this run: never invent a " +
      "title, a summary or an address. " +
      "Write title, intro, headlines and summaries in German; item titles may keep the language of the " +
      "source. " +
      "If your research found nothing usable, do not call this tool at all — write nothing rather than a " +
      "placeholder issue. " +
      "Limits: 12 sections, 10 items per section, a section without items is refused; longer text fields " +
      "are dropped, not truncated. " +
      "Example: newsletter_write({ newsletterId: '<id from newsletter_read>', title: 'KI-Regulierung: " +
      "die Woche', sections: [{ topic: 'KI-Regulierung', headline: 'Brüssel einigt sich', items: " +
      "[{ title: 'Einigung im Trilog', url: 'https://example.org/article' }] }] }).",
    approval: "write",
    loadMode: "essential",
    parameters: Type.Object({
      newsletterId: Type.String({
        description:
          "The id of the newsletter that receives the issue, a UUID taken from newsletter_read's list.",
      }),
      title: Type.Optional(Type.String({
        description: "Optional German headline of this issue, at most 200 characters, e.g. 'Die Woche in der KI-Politik'.",
      })),
      intro: Type.Optional(Type.String({
        description: "Optional German introduction of the issue, two or three sentences, at most 1200 characters.",
      })),
      sections: Type.Array(
        Type.Object({
          topic: Type.String({
            description: "The topic of this section — one of the newsletter's topics, exactly as listed.",
          }),
          headline: Type.Optional(Type.String({
            description: "Optional German headline of the section, at most 200 characters.",
          })),
          summary: Type.Optional(Type.String({
            description: "Optional German paragraph that introduces the section, at most 1200 characters.",
          })),
          items: Type.Array(
            Type.Object({
              title: Type.String({
                description: "The item's title, at most 200 characters.",
              }),
              summary: Type.Optional(Type.String({
                description: "Optional German summary of the item, at most 400 characters.",
              })),
              url: Type.Optional(Type.String({
                description: "The real http(s) address of the source you read. Never invent one.",
              })),
            }),
            { description: "The items of this section, 3 to 5 of them, at most 10." },
          ),
        }),
        { description: "One section per researched topic, at most 12." },
      ),
    }),

    async execute(_toolCallId, params) {
      const owner = requireIdentity();
      const { newsletters } = readNewsletterFile(owner);

      const id = params.newsletterId.trim();
      const newsletter = newsletters.find((entry) => entry.id === id);
      if (!newsletter) throw unknownNewsletterId(newsletters, id);

      if (params.sections.length === 0) {
        throw new Error(
          "A newsletter issue needs at least one section. Research the newsletter's topics and pass one " +
          "section per topic; if nothing usable turned up, do not call newsletter_write at all.",
        );
      }
      const empty = params.sections.find((section) => section.items.length === 0)?.topic;
      if (empty !== undefined) {
        throw new Error(
          `The section '${empty}' has no items. Every section needs at least one item with a real source ` +
          `URL; leave the section out instead of sending it empty.`,
        );
      }

      const issue: NewsletterIssue | null = normalizeIssue({
        id: randomUUID(),
        generatedAt: new Date().toISOString(),
        title: params.title,
        intro: params.intro,
        sections: params.sections,
      });
      if (!issue) {
        throw new Error(
          "Nothing of this issue survives validation: every section needs a topic and at least one item " +
          "with a title. Write nothing rather than a placeholder issue.",
        );
      }

      const updated: Newsletter = {
        ...newsletter,
        issues: trimIssues([issue, ...newsletter.issues]),
        updatedAt: issue.generatedAt,
      };
      writeNewsletterFile(owner, newsletters.map((entry) => (entry.id === id ? updated : entry)));

      const itemCount = issue.sections.reduce((total, section) => total + section.items.length, 0);
      const droppedSections = params.sections.length - issue.sections.length;
      return {
        content: [{
          type: "text" as const,
          text: [
            `Newsletter-Ausgabe gespeichert: „${newsletter.name}" vom ${germanDate(issue.generatedAt)} — ` +
            `${issue.sections.length} Abschnitt${issue.sections.length === 1 ? "" : "e"}, ` +
            `${itemCount} ${itemCount === 1 ? "Beitrag" : "Beiträge"} — ${updated.issues.length} von ` +
            `hoechstens ${MAX_ISSUES_KEPT} Ausgaben im Archiv.`,
            ...(droppedSections > 0
              ? [`Hinweis: ${droppedSections} Abschnitt${droppedSections === 1 ? "" : "e"} ` +
                `${droppedSections === 1 ? "wurde" : "wurden"} nicht uebernommen (leer, ungueltig oder ueber ` +
                `der Grenze von ${MAX_SECTIONS}).`]
              : []),
            "Der Newsletter des Nutzers ist jetzt aktualisiert.",
          ].join("\n"),
        }],
      };
    },
  });

  return [readTool, writeTool];
}
