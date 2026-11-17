import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  MAX_HEADLINE_LENGTH,
  MAX_INTRO_LENGTH,
  MAX_ISSUE_TITLE_LENGTH,
  MAX_ISSUES_KEPT,
  MAX_ITEMS_PER_SECTION,
  MAX_NEWSLETTER_NAME_LENGTH,
  MAX_NEWSLETTER_TOPICS,
  MAX_SECTIONS,
  MAX_TOPIC_LENGTH,
  MAX_ITEM_SUMMARY_LENGTH,
  buildNewsletterPrompt,
  normalizeIssue,
  normalizeNewsletter,
  normalizeNewsletterItem,
  normalizeNewsletterSection,
  normalizeNewsletterSections,
  normalizeNewsletters,
  newsletterSchedule,
  normalizeTopics,
  trimIssues,
} = await jiti.import("./newsletter.ts");
const { nextRunAfter, parseSchedule } = await jiti.import("./schedule.ts");

function item(overrides = {}) {
  return {
    title: "Meldung",
    summary: "Eine kurze Zusammenfassung.",
    url: "https://example.org/meldung",
    ...overrides,
  };
}

function section(overrides = {}) {
  return {
    topic: "KI-Regulierung",
    headline: "Brüssel bewegt sich",
    summary: "Ein Absatz zur Einordnung.",
    items: [item()],
    ...overrides,
  };
}

function issue(overrides = {}) {
  return {
    id: "issue-1",
    generatedAt: "2026-11-17T06:00:00.000Z",
    title: "Die Woche",
    intro: "Kurz und knapp.",
    sections: [section()],
    ...overrides,
  };
}

function newsletter(overrides = {}) {
  return {
    id: "nl-1",
    name: "Wochenblick",
    topics: ["KI-Regulierung", "Klimapolitik"],
    provider: "buds-gateway",
    modelId: "qwen3.8-27b",
    taskId: "task-1",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    issues: [issue()],
    ...overrides,
  };
}

// --- Die Grenzen -----------------------------------------------------------------

test("the limits are the numbers the API documents", () => {
  assert.equal(MAX_NEWSLETTER_NAME_LENGTH, 100);
  assert.equal(MAX_NEWSLETTER_TOPICS, 10);
  assert.equal(MAX_TOPIC_LENGTH, 120);
  assert.equal(MAX_ISSUES_KEPT, 20);
  assert.equal(MAX_SECTIONS, 12);
  assert.equal(MAX_ITEMS_PER_SECTION, 10);
  assert.equal(MAX_ISSUE_TITLE_LENGTH, 200);
  assert.equal(MAX_INTRO_LENGTH, 1200);
  assert.equal(MAX_HEADLINE_LENGTH, 200);
  assert.equal(MAX_ITEM_SUMMARY_LENGTH, 400);
});

// --- Themen ----------------------------------------------------------------------

test("topics are trimmed, deduplicated and kept in their first spelling", () => {
  assert.deepEqual(normalizeTopics(["  KI  ", "ki", "Klima", "  "]), ["KI", "Klima"]);
});

test("a topic that is not a string is dropped", () => {
  assert.deepEqual(normalizeTopics(["KI", 42, null, { topic: "Klima" }]), ["KI"]);
});

test("a topic longer than the limit is dropped, not truncated", () => {
  const topic = "x".repeat(MAX_TOPIC_LENGTH + 1);
  assert.deepEqual(normalizeTopics([topic, "KI"]), ["KI"]);
  assert.deepEqual(normalizeTopics(["x".repeat(MAX_TOPIC_LENGTH)]), ["x".repeat(MAX_TOPIC_LENGTH)]);
});

test("more topics than the limit are cut to the limit", () => {
  const topics = Array.from({ length: MAX_NEWSLETTER_TOPICS + 3 }, (_, index) => `Thema ${index}`);
  assert.equal(normalizeTopics(topics).length, MAX_NEWSLETTER_TOPICS);
  assert.equal(normalizeTopics(topics)[MAX_NEWSLETTER_TOPICS - 1], `Thema ${MAX_NEWSLETTER_TOPICS - 1}`);
});

test("a value that is not a list has no topics", () => {
  assert.deepEqual(normalizeTopics("KI"), []);
  assert.deepEqual(normalizeTopics(null), []);
});

// --- Ein Beitrag ------------------------------------------------------------------

test("a usable item keeps title, summary and url", () => {
  assert.deepEqual(normalizeNewsletterItem(item()), item());
});

test("an item without a title is not a contribution", () => {
  assert.equal(normalizeNewsletterItem(item({ title: "  " })), null);
  assert.equal(normalizeNewsletterItem({ summary: "ohne Titel" }), null);
});

test("an over-long item title drops the item, an over-long summary only the summary", () => {
  assert.equal(normalizeNewsletterItem(item({ title: "x".repeat(MAX_HEADLINE_LENGTH + 1) })), null);
  assert.deepEqual(
    normalizeNewsletterItem(item({ summary: "x".repeat(MAX_ITEM_SUMMARY_LENGTH + 1) })),
    { title: "Meldung", url: "https://example.org/meldung" },
  );
});

test("a url that is not an absolute http(s) address is dropped", () => {
  assert.deepEqual(normalizeNewsletterItem(item({ url: "javascript:alert(1)" })), {
    title: "Meldung",
    summary: "Eine kurze Zusammenfassung.",
  });
  assert.deepEqual(normalizeNewsletterItem(item({ url: "example.org/ohne-schema" })), {
    title: "Meldung",
    summary: "Eine kurze Zusammenfassung.",
  });
  assert.deepEqual(normalizeNewsletterItem(item({ url: "http://example.org/b" })).url, "http://example.org/b");
});

// --- Ein Abschnitt ---------------------------------------------------------------

test("a section without a topic or without items is not a section", () => {
  assert.equal(normalizeNewsletterSection(section({ topic: "" })), null);
  assert.equal(normalizeNewsletterSection(section({ items: [] })), null);
  assert.equal(normalizeNewsletterSection(section({ items: [item({ title: "" })] })), null);
});

test("the items of a section are cut to the limit", () => {
  const items = Array.from({ length: MAX_ITEMS_PER_SECTION + 4 }, (_, index) => item({ title: `Meldung ${index}` }));
  const normalized = normalizeNewsletterSection(section({ items }));
  assert.equal(normalized.items.length, MAX_ITEMS_PER_SECTION);
  assert.equal(normalized.items[MAX_ITEMS_PER_SECTION - 1].title, `Meldung ${MAX_ITEMS_PER_SECTION - 1}`);
});

test("an over-long headline is dropped, the section stays", () => {
  const normalized = normalizeNewsletterSection(section({ headline: "x".repeat(MAX_HEADLINE_LENGTH + 1) }));
  assert.equal(normalized.headline, undefined);
  assert.equal(normalized.items.length, 1);
});

test("the sections of an issue are cut to the limit and broken ones dropped", () => {
  const sections = Array.from({ length: MAX_SECTIONS + 2 }, (_, index) => section({ topic: `Thema ${index}` }));
  assert.equal(normalizeNewsletterSections(sections).length, MAX_SECTIONS);
  assert.equal(normalizeNewsletterSections([section(), "kein Abschnitt"]).length, 1);
  assert.deepEqual(normalizeNewsletterSections({}), []);
});

// --- Eine Ausgabe ----------------------------------------------------------------

test("an issue needs an id, a timestamp and one section", () => {
  assert.equal(normalizeIssue(issue({ id: "" })), null);
  assert.equal(normalizeIssue(issue({ generatedAt: "gestern" })), null);
  assert.equal(normalizeIssue(issue({ sections: [] })), null);
  assert.deepEqual(normalizeIssue(issue()), issue());
});

test("an over-long issue title or intro is dropped, the issue stays", () => {
  const normalized = normalizeIssue(issue({
    title: "x".repeat(MAX_ISSUE_TITLE_LENGTH + 1),
    intro: "x".repeat(MAX_INTRO_LENGTH + 1),
  }));
  assert.equal(normalized.title, undefined);
  assert.equal(normalized.intro, undefined);
  assert.equal(normalized.sections.length, 1);
});

test("trimIssues keeps the newest entries and cuts the rest", () => {
  const issues = Array.from({ length: MAX_ISSUES_KEPT + 5 }, (_, index) => issue({ id: `issue-${index}` }));
  const kept = trimIssues(issues);
  assert.equal(kept.length, MAX_ISSUES_KEPT);
  assert.equal(kept[0].id, "issue-0");
  assert.equal(kept[MAX_ISSUES_KEPT - 1].id, `issue-${MAX_ISSUES_KEPT - 1}`);
});

// --- Der Newsletter --------------------------------------------------------------

test("a newsletter survives normalization unchanged", () => {
  const stored = newsletter();
  assert.deepEqual(normalizeNewsletter(stored), stored);
});

test("a newsletter without a name, topics or task is not a newsletter", () => {
  assert.equal(normalizeNewsletter(newsletter({ name: "" })), null);
  assert.equal(normalizeNewsletter(newsletter({ name: "x".repeat(MAX_NEWSLETTER_NAME_LENGTH + 1) })), null);
  assert.equal(normalizeNewsletter(newsletter({ topics: [] })), null);
  assert.equal(normalizeNewsletter(newsletter({ topics: ["x".repeat(MAX_TOPIC_LENGTH + 1)] })), null);
  assert.equal(normalizeNewsletter(newsletter({ taskId: "" })), null);
  assert.equal(normalizeNewsletter(newsletter({ provider: "" })), null);
  assert.equal(normalizeNewsletter(newsletter({ modelId: "" })), null);
  assert.equal(normalizeNewsletter("kein Newsletter"), null);
});

test("the issues of a newsletter are cut to the limit, the newest stay", () => {
  const issues = Array.from({ length: MAX_ISSUES_KEPT + 4 }, (_, index) => issue({ id: `issue-${index}` }));
  const normalized = normalizeNewsletter(newsletter({ issues }));
  assert.equal(normalized.issues.length, MAX_ISSUES_KEPT);
  assert.equal(normalized.issues[0].id, "issue-0");
});

test("a newsletter without a usable timestamp gets one", () => {
  const normalized = normalizeNewsletter(newsletter({ createdAt: "irgendwann", updatedAt: undefined }));
  assert.equal(Number.isFinite(Date.parse(normalized.createdAt)), true);
  assert.equal(normalized.updatedAt, normalized.createdAt);
});

test("a list of newsletters drops broken rows and duplicate ids", () => {
  const list = normalizeNewsletters([newsletter({ id: "a" }), newsletter({ id: "a" }), { kaputt: true }, newsletter({ id: "b" })]);
  assert.deepEqual(list.map((entry) => entry.id), ["a", "b"]);
  assert.deepEqual(normalizeNewsletters("keine Liste"), []);
});

// --- Der Zeitplan ----------------------------------------------------------------

test("the schedule carries the cron and derives nextRun from it", () => {
  const nowMs = Date.parse("2026-11-17T08:00:00.000Z");
  const schedule = newsletterSchedule(
    { cron: "0 3 * * *", enabled: true, lastRunAt: "2026-11-16T03:00:00.000Z", lastRunStatus: "ok" },
    nowMs,
  );
  assert.equal(schedule.cron, "0 3 * * *");
  assert.equal(schedule.enabled, true);
  assert.equal(schedule.nextRun, nextRunAfter(parseSchedule("0 3 * * *"), nowMs));
  assert.ok(schedule.nextRun > nowMs);
  assert.equal(schedule.lastRunAt, "2026-11-16T03:00:00.000Z");
  assert.equal(schedule.lastRunStatus, "ok");
});

test("a disabled task has a cron but no next run", () => {
  const schedule = newsletterSchedule({ cron: "0 3 * * *", enabled: false }, Date.now());
  assert.equal(schedule.cron, "0 3 * * *");
  assert.equal(schedule.nextRun, null);
  assert.equal(schedule.lastRunAt, null);
  assert.equal(schedule.lastRunStatus, null);
});

test("a missing task has no schedule at all", () => {
  assert.equal(newsletterSchedule(null, Date.now()), null);
});

test("an unparseable cron has no next run and throws nothing", () => {
  const schedule = newsletterSchedule({ cron: "0 3 * *", enabled: true }, Date.now());
  assert.equal(schedule.cron, "0 3 * *");
  assert.equal(schedule.nextRun, null);
});

// --- Der Prompt ------------------------------------------------------------------

test("the prompt names the id exactly once and every topic", () => {
  const prompt = buildNewsletterPrompt({ id: "nl-77", name: "Wochenblick", topics: ["KI", "Klima"] });
  assert.equal(prompt.split("nl-77").length - 1, 1);
  assert.match(prompt, /Wochenblick/);
  assert.match(prompt, /1\. KI/);
  assert.match(prompt, /2\. Klima/);
});

test("the prompt asks for web research and exactly one write call", () => {
  const prompt = buildNewsletterPrompt({ id: "nl-1", name: "Wochenblick", topics: ["KI"] });
  assert.match(prompt, /research every topic above on the web/i);
  assert.match(prompt, /`newsletter_write` tool exactly once/);
  assert.match(prompt, /one section per topic/i);
  assert.match(prompt, /3 to 5 items/i);
  assert.match(prompt, /real URL/i);
  assert.match(prompt, /in German/i);
  assert.match(prompt, /write nothing/i);
  assert.match(prompt, /placeholder issue/i);
});
