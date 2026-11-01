import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const {
  classifyPresentKind,
  formatPresentBytes,
  hasPresentExcerpt,
  isPresentFilesDetails,
  MAX_PRESENT_ITEMS,
  MAX_PRESENT_SNIFFABLE_BYTES,
  presentItemsFromDetails,
  unwrapPresentFilesDetails,
} = await jiti.import("./present-files.ts");
const {
  decodePresentHead,
  headLooksLikeText,
  normalizePresentItems,
  probePresentItem,
} = await jiti.import("./present-files-probe.ts");
const { makePresentFilesTool, buildPresentResultText } = await jiti.import("./present-files-tool.ts");

function budget() {
  return { left: 6000 };
}

async function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "present-files-"));
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One real call through the tool definition, as the agent would make it. */
async function present(dir, params) {
  const tool = makePresentFilesTool();
  const result = await tool.execute("call-1", params, undefined, undefined, { cwd: dir });
  return {
    details: result.details,
    text: result.content.map((part) => part.text ?? "").join("\n"),
  };
}

// --------------------------------------------------------------- classify ---

test("classifies by extension into the card kinds the renderer knows", () => {
  assert.equal(classifyPresentKind("chart.png"), "image");
  assert.equal(classifyPresentKind("clip.mp4"), "video");
  assert.equal(classifyPresentKind("song.mp3"), "audio");
  assert.equal(classifyPresentKind("notes.md"), "markdown");
  assert.equal(classifyPresentKind("page.html"), "html");
  assert.equal(classifyPresentKind("report.pdf"), "pdf");
  assert.equal(classifyPresentKind("main.ts"), "text");
  assert.equal(classifyPresentKind("blob.unknown-ext"), "binary");
});

test("extension matching ignores case", () => {
  assert.equal(classifyPresentKind("PHOTO.PNG"), "image");
  assert.equal(classifyPresentKind("README.MD"), "markdown");
});

test("only the textual kinds carry an excerpt", () => {
  assert.equal(hasPresentExcerpt("text"), true);
  assert.equal(hasPresentExcerpt("markdown"), true);
  assert.equal(hasPresentExcerpt("html"), true);
  assert.equal(hasPresentExcerpt("image"), false);
  assert.equal(hasPresentExcerpt("binary"), false);
  assert.equal(hasPresentExcerpt("dir"), false);
});

// ------------------------------------------------------------- normalise ---

test("keeps the usable entries, folds backslashes, and names what it refused", () => {
  const { items, rejected } = normalizePresentItems([
    { path: "  a/b.png  " },
    { path: "a\\b.png" },
    { path: "" },
    { path: 42 },
    null,
    7,
    { caption: "no path here" },
    { path: "c.png", caption: "keep me" },
  ]);
  assert.deepEqual(items, [
    { path: "a/b.png", caption: undefined, open: false },
    { path: "c.png", caption: "keep me", open: false },
  ]);
  assert.deepEqual(rejected, [
    { path: "a/b.png", reason: "duplicate" },
    { path: "", reason: "empty" },
    { path: '{"path":42}', reason: "invalid" },
    { path: "null", reason: "invalid" },
    { path: "7", reason: "invalid" },
    { path: '{"caption":"no path here"}', reason: "invalid" },
  ]);
});

test("caps the item count at 48 and names what did not fit", () => {
  // The cap is one number in `lib/present-files.ts`. Pinning the value here is
  // what makes a later bump a decision instead of a silent edit.
  assert.equal(MAX_PRESENT_ITEMS, 48);
  const many = Array.from({ length: 50 }, (_, i) => ({ path: `f${i}.png` }));
  const { items, rejected } = normalizePresentItems(many);
  assert.equal(items.length, MAX_PRESENT_ITEMS);
  assert.deepEqual(rejected, [
    { path: "f48.png", reason: "overflow" },
    { path: "f49.png", reason: "overflow" },
  ]);
});

test("a call without entries is empty; a single entry is a call with one file", () => {
  assert.deepEqual(normalizePresentItems(null), { items: [], rejected: [] });
  assert.deepEqual(normalizePresentItems(undefined), { items: [], rejected: [] });
  assert.deepEqual(normalizePresentItems([]), { items: [], rejected: [] });
  // The `xd://` bridge hands a loose argument through without the schema
  // having checked it, so the shape of one file has to survive on its own.
  const onePath = { path: "a.png", caption: undefined, open: false };
  assert.deepEqual(normalizePresentItems("a.png").items, [onePath]);
  assert.deepEqual(normalizePresentItems({ path: "a.png" }).items, [onePath]);
  assert.deepEqual(
    normalizePresentItems(["a.png", "b.png"]).items.map((item) => item.path),
    ["a.png", "b.png"],
  );
});

// ----------------------------------------------------------------- sniff ---

test("a NUL byte or a control-char flood means binary", () => {
  assert.equal(headLooksLikeText(Buffer.from("hello world\n", "utf8")), true);
  assert.equal(headLooksLikeText(Buffer.from([0x68, 0x69, 0x00, 0x21])), false);
  assert.equal(headLooksLikeText(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x03])), false);
  assert.equal(headLooksLikeText(Buffer.alloc(0)), false);
});

test("an incomplete UTF-8 tail is dropped, not rendered as replacement chars", () => {
  const full = Buffer.from("Grüße", "utf8");
  const cut = Buffer.concat([full, Buffer.from([0xe2, 0x82])]);
  const decoded = decodePresentHead(cut);
  assert.ok(!decoded.includes("�"), `fand ein Ersatzzeichen: ${JSON.stringify(decoded)}`);
});

// ----------------------------------------------------------------- probe ---

test("a missing path yields a missing card instead of throwing", async () => {
  await withTempDir(async (dir) => {
    const item = await probePresentItem({ path: "nope.txt" }, dir, budget());
    assert.equal(item.kind, "missing");
    assert.equal(item.name, "nope.txt");
    assert.equal(item.size, undefined);
  });
});

test("a directory is a dir card, not a file card", async () => {
  await withTempDir(async (dir) => {
    // Pin: a directory entry must be classified as "dir" kind, not "binary".
    mkdirSync(join(dir, "sub"));
    const item = await probePresentItem({ path: "sub" }, dir, budget());
    assert.equal(item.kind, "dir");
  });
});

test("a relative path resolves against the session cwd", async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "a.txt"), "hello");
    const item = await probePresentItem({ path: "a.txt" }, dir, budget());
    assert.equal(item.kind, "text");
    assert.equal(item.abs, join(dir, "a.txt"));
    assert.equal(item.excerpt, "hello");
  });
});

test("an absolute path is taken as given", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "abs.txt");
    writeFileSync(file, "absolut");
    const item = await probePresentItem({ path: file }, "/elsewhere", budget());
    assert.equal(item.abs, file);
    assert.equal(item.excerpt, "absolut");
  });
});

test("an unknown extension holding text is upgraded to a text card", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "script.unknownext");
    writeFileSync(file, "console.log('hi');\n");
    const item = await probePresentItem({ path: file }, dir, budget());
    assert.equal(item.kind, "text", "der Inhalt sagt Text — die Karte sollte es auch sagen");
    assert.equal(item.excerpt, "console.log('hi');\n");
  });
});

test("an unknown extension holding binary stays binary", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "blob.unknownext");
    writeFileSync(file, Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]));
    const item = await probePresentItem({ path: file }, dir, budget());
    assert.equal(item.kind, "binary");
    assert.equal(item.excerpt, undefined);
  });
});

test("an image gets no excerpt", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "i.png");
    writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const item = await probePresentItem({ path: file }, dir, budget());
    assert.equal(item.kind, "image");
    assert.equal(item.excerpt, undefined);
  });
});

test("the excerpt budget is shared across one call and runs out", async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "big.txt"), "x".repeat(50_000));
    const shared = { left: 1500 };
    const first = await probePresentItem({ path: "big.txt" }, dir, shared);
    // Pin: per-item cap of 1200 is applied first, leaving 300 in the shared budget.
    assert.equal(first.excerpt.length, 1200, "der Einzel-Cap greift zuerst");
    // Pin: shared budget after first probe = 1500 - 1200 = 300; second probe still gets budget.
    assert.equal(shared.left, 300);
    const second = await probePresentItem({ path: "big.txt" }, dir, shared);
    assert.equal(second.excerpt !== undefined, true, "noch Restbudget vorhanden");
    assert.equal(second.excerpt.length, 300, "Second excerpt bounded by remaining shared budget (300 chars)");
  });
});

// -------------------------------------------------- untrusted details ---

test("a details payload is recognized only when its shape holds up", () => {
  const ok = { items: [{ abs: "/a.png", name: "a.png", kind: "image" }] };
  assert.equal(isPresentFilesDetails(ok), true);

  assert.equal(isPresentFilesDetails(null), false);
  assert.equal(isPresentFilesDetails("x"), false);
  assert.equal(isPresentFilesDetails({}), false);
  assert.equal(isPresentFilesDetails({ items: "no" }), false);
  assert.equal(isPresentFilesDetails({ items: [{ name: "a" }] }), false, "abs fehlt");
  assert.equal(isPresentFilesDetails({ items: [{ abs: "/a", name: "a" }] }), false, "kind fehlt");
  assert.equal(isPresentFilesDetails({ items: [null] }), false);
  assert.equal(isPresentFilesDetails({ items: [{ abs: 1, name: "a", kind: "image" }] }), false);
  assert.equal(isPresentFilesDetails({ items: [], title: 7 }), false, "title muss String sein");
});

test("an unknown kind degrades to binary rather than reaching the renderer", () => {
  const details = { items: [{ abs: "/a", name: "a", kind: "exfiltrate-me" }] };
  const items = presentItemsFromDetails(details);
  assert.equal(items[0].kind, "binary");
});

test("optional numeric fields survive only when they are numbers", () => {
  const details = {
    items: [{ abs: "/a", name: "a", kind: "text", size: "12", mtime: 5, excerptTruncated: "yes" }],
  };
  const [item] = presentItemsFromDetails(details);
  assert.equal(item.size, undefined, "ein String ist keine Groesse");
  assert.equal(item.mtime, 5);
  assert.equal(item.excerptTruncated, false);
});

test("the xd:// wrapper is unwrapped, and a payload that is neither shape is not", () => {
  const inner = { items: [{ abs: "/a.png", name: "a.png", kind: "image" }] };
  assert.equal(unwrapPresentFilesDetails(inner), inner, "die direkte Form bleibt unveraendert");

  const wrapped = {
    xdev: {
      tool: "present_files",
      mode: "execute",
      args: { items: [{ path: "a.png" }] },
      tier: "read",
      inner,
    },
  };
  assert.equal(unwrapPresentFilesDetails(wrapped), inner, "die xdev.inner-Form wird ausgepackt");
  assert.equal(isPresentFilesDetails(wrapped), false, "allein ist die Huelle keine Card-Payload");

  assert.equal(unwrapPresentFilesDetails(null), null);
  assert.equal(unwrapPresentFilesDetails({}), null, "kein xdev, kein Card");
  assert.equal(unwrapPresentFilesDetails({ xdev: null }), null);
  assert.equal(unwrapPresentFilesDetails({ xdev: {} }), null, "xdev ohne inner");
  assert.equal(unwrapPresentFilesDetails({ xdev: { inner: { items: "no" } } }), null, "inner muss die Form halten");
});

// ---------------------------------------------------------------- format ---

test("byte formatting is readable at every scale", () => {
  assert.equal(formatPresentBytes(0), "0 B");
  assert.equal(formatPresentBytes(512), "512 B");
  assert.equal(formatPresentBytes(1536), "1.5 KB");
  assert.equal(formatPresentBytes(28_729), "28 KB");
  assert.equal(formatPresentBytes(3_362_000), "3.2 MB");
  assert.equal(formatPresentBytes(undefined), "?");
  assert.equal(formatPresentBytes(-1), "?");
});

// ------------------------------------------------------------------ tool ---

test("forty files arrive as forty cards, not as the first twelve", async () => {
  await withTempDir(async (dir) => {
    const names = Array.from({ length: 40 }, (_, i) => `shot-${String(i).padStart(2, "0")}.txt`);
    for (const name of names) writeFileSync(join(dir, name), name);
    const { details, text } = await present(dir, { items: names.map((path) => ({ path })) });
    assert.equal(details.items.length, 40);
    assert.ok(text.startsWith("Presented 40 file(s) to the user as preview cards:"), text);
  });
});

test("an entry that is not a path is named, and the rest are still shown", async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "a.txt"), "a");
    writeFileSync(join(dir, "b.txt"), "b");
    const { details, text } = await present(dir, {
      items: [{ path: "a.txt" }, { path: 42 }, { path: "b.txt" }],
    });
    assert.deepEqual(details.items.map((item) => item.name), ["a.txt", "b.txt"]);
    assert.ok(text.includes('Not shown (1): {"path":42} (not a path)'), text);
  });
});

test("a path that is not on disk is named instead of discarding the call", async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "there.txt"), "here");
    const { details, text } = await present(dir, {
      items: [{ path: "there.txt" }, { path: "gone.txt" }],
    });
    assert.equal(details.items.length, 1);
    assert.ok(text.includes("Not shown (1): gone.txt (missing or unreadable)"), text);
  });
});

test("a duplicate collapses to one card and is named", async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "a.txt"), "a");
    const { details, text } = await present(dir, {
      items: [{ path: "a.txt" }, { path: " a.txt " }, { path: "a.txt", caption: "again" }],
    });
    assert.equal(details.items.length, 1);
    assert.equal((text.match(/\(duplicate\)/g) ?? []).length, 2, text);
  });
});

test("a path with spaces and punctuation is one path, not two", async () => {
  await withTempDir(async (dir) => {
    const name = 'Report (1) & co — "final" ü.txt';
    writeFileSync(join(dir, name), "ok");
    const { details } = await present(dir, { items: [{ path: name }] });
    assert.equal(details.items.length, 1);
    assert.equal(details.items[0].name, name);
    assert.equal(details.items[0].abs, join(dir, name));
    assert.equal(details.items[0].kind, "text");
  });
});

test("a file too large for an excerpt still gets its card", async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "huge.log"), "");
    truncateSync(join(dir, "huge.log"), MAX_PRESENT_SNIFFABLE_BYTES + 1);
    const { details } = await present(dir, { items: [{ path: "huge.log" }] });
    assert.equal(details.items.length, 1);
    assert.equal(details.items[0].size, MAX_PRESENT_SNIFFABLE_BYTES + 1);
    assert.equal(details.items[0].excerpt, undefined, "kein Auszug aus einer Datei dieser Groesse");
  });
});

test("a call that can show nothing fails loudly and names every entry", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(() => present(dir, { items: [] }), /needs at least one item with a path/);
    await assert.rejects(
      () => present(dir, { items: [{ path: "  " }, { caption: "no path" }] }),
      (error) =>
        error.message.includes("every entry was refused") &&
        error.message.includes('{"caption":"no path"} (not a path)') &&
        error.message.includes("(empty path)"),
    );
    await assert.rejects(
      () => present(dir, { items: [{ path: "gone.txt" }] }),
      /nothing was shown: gone\.txt \(missing or unreadable\)/,
    );
  });
});

test("the refusal list names ten entries and counts the rest", () => {
  const shown = [{ path: "a.txt", abs: "/a.txt", name: "a.txt", kind: "text" }];
  const refused = Array.from({ length: 15 }, (_, i) => ({ path: `f${i}.png`, reason: "missing" }));
  const text = buildPresentResultText(shown, refused, undefined);
  assert.ok(text.includes("Not shown (15):"), text);
  assert.ok(text.includes("f9.png (missing or unreadable), and 5 more"), text);
});