import { describe, expect, test } from "bun:test";
import { createTenantWorkerHost } from "./tenant-worker";

/**
 * Der Lebenszyklus der Worker-Registry, ohne echten Prozess.
 *
 * `createTenantWorkerHost` bekommt seine `start`-Funktion von aussen; damit ist
 * genau das pruefbar, was der Vertrag verlangt und was ein Integrationstest
 * nicht sauber hinbekommt: zwei gleichzeitige erste Anfragen starten **einen**
 * Worker, ein toter Worker wird ersetzt, und die Kapazitaet weicht dem
 * aeltesten Platz statt den neuen Request abzuweisen.
 */

function identity(username) {
  return { username };
}

function fakeWorker(username, pid = Math.floor(Math.random() * 1e6)) {
  const worker = {
    username,
    pid,
    enforced: true,
    client: {},
    startedAt: Date.now(),
    boundary: { kind: "tenant-worker", enforced: true, pid },
    stopped: 0,
    async stop() { worker.stopped += 1; },
  };
  return worker;
}

const failure = (reason = "tenant-worker-spawn-failed") => ({
  ok: false, reason, detail: "boom", remediation: "retry",
});

describe("worker registry", () => {
  test("two concurrent first requests start exactly one worker", async () => {
    // Der Fall ist real: ein Browser oeffnet die Session-Route und den
    // Event-Stream gleichzeitig. Zwei Worker fuer ein Konto waeren zwei
    // Prozesse mit derselben Session — und damit zwei Wahrheiten.
    const host = createTenantWorkerHost({ max: 4, idleMs: 60_000 });
    let starts = 0;
    const start = async () => {
      starts += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return fakeWorker("hannah", 111);
    };
    const [a, b] = await Promise.all([
      host.acquire(identity("hannah"), start),
      host.acquire(identity("hannah"), start),
    ]);
    expect(starts).toBe(1);
    expect(a.pid).toBe(111);
    expect(b.pid).toBe(111);
  });

  test("two tenants get two workers, one each", async () => {
    const host = createTenantWorkerHost({ max: 4, idleMs: 60_000 });
    let nextPid = 200;
    const start = async () => fakeWorker("x", nextPid++);
    const first = await host.acquire(identity("hannah"), start);
    const second = await host.acquire(identity("samuel"), start);
    expect(first.pid).not.toBe(second.pid);
    expect(host.snapshot().length).toBe(2);
    expect(host.snapshot().map((entry) => entry.username).sort()).toEqual(["hannah", "samuel"]);
  });

  test("a refused start is reported, not swallowed", async () => {
    const host = createTenantWorkerHost({ max: 4, idleMs: 60_000 });
    const result = await host.acquire(identity("hannah"), async () => failure("bwrap-missing"));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("bwrap-missing");
    // Nichts wird registriert: ein gescheiterter Start darf keinen Platz
    // belegen, sonst leert die Kapazitaet sich mit toten Konten.
    expect(host.snapshot().length).toBe(0);
  });

  test("a thrown start becomes a named failure, not an exception", async () => {
    const host = createTenantWorkerHost({ max: 4, idleMs: 60_000 });
    const result = await host.acquire(identity("hannah"), async () => {
      throw new Error("spawn ENOENT");
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("tenant-worker-spawn-failed");
    expect(result.detail).toContain("spawn ENOENT");
    // Und der naechste Versuch muss wieder starten duerfen: ein haengender
    // `starting`-Eintrag wuerde das Konto dauerhaft aussperren.
    const retry = await host.acquire(identity("hannah"), async () => fakeWorker("hannah", 300));
    expect(retry.pid).toBe(300);
  });

  test("a released worker is stopped and the next request starts a new one", async () => {
    const host = createTenantWorkerHost({ max: 4, idleMs: 60_000 });
    const worker = await host.acquire(identity("hannah"), async () => fakeWorker("hannah", 400));
    await host.release("hannah");
    expect(worker.stopped).toBe(1);
    expect(host.snapshot().length).toBe(0);
    const again = await host.acquire(identity("hannah"), async () => fakeWorker("hannah", 401));
    expect(again.pid).toBe(401);
  });

  test("at capacity the least recently used worker yields instead of refusing", async () => {
    // Ohne diese Regel waere die Grenze bei vier Konten ein Dauerausfall des
    // fuenften — ein Mandant, der den Server schon bezahlt hat.
    const host = createTenantWorkerHost({ max: 2, idleMs: 60_000 });
    let nextPid = 500;
    const start = async () => fakeWorker("x", nextPid++);
    const first = await host.acquire(identity("a"), start);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await host.acquire(identity("b"), start);
    // `a` ist jetzt der aelteste Platz und weicht dem dritten Konto.
    const third = await host.acquire(identity("c"), start);
    expect(third.pid).toBeGreaterThan(0);
    expect(first.stopped).toBe(1);
    expect(host.snapshot().map((entry) => entry.username).sort()).toEqual(["b", "c"]);
  });

  test("there is no in-process fallback for a tenant", async () => {
    // Der Vertrag aus §5: die einzigen Wege in den Serverprozess sind "kein
    // Mandant" und der ausdrueckliche Ausstieg. Ein fehlgeschlagener Plan ist
    // ein Fehler mit Namen, kein stiller Rueckfall.
    const host = createTenantWorkerHost({ max: 1, idleMs: 60_000 });
    await host.acquire(identity("a"), async () => fakeWorker("a", 600));
    const result = await host.acquire(identity("b"), async () => failure("boundary-unavailable"));
    // Kapazitaet raeumt `a` ab, dann scheitert `b` an seinem eigenen Start —
    // aber es gibt keinen Pfad, der `b` in den Serverprozess legt.
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("boundary-unavailable");
  });
});
