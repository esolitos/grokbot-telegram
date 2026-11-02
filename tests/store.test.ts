import { describe, expect, it } from "vitest";
import { MemoryStore, scopeKey } from "../src/core/store.js";
import type { ContextMessage } from "../src/core/types.js";

function entry(text: string, id: number): ContextMessage {
  return {
    message_id: id,
    text,
    date: null,
    message_thread_id: null,
    from: null,
  };
}

describe("memory store", () => {
  it("claims an update once until the ttl passes", async () => {
    const store = new MemoryStore();
    expect(await store.claimUpdate(5, 1_000, 500)).toBe("new");
    expect(await store.claimUpdate(5, 1_200, 500)).toBe("duplicate");
    await store.releaseUpdate(5);
    expect(await store.claimUpdate(5, 1_200, 500)).toBe("new");
    expect(await store.claimUpdate(5, 2_000, 500)).toBe("new");
  });

  it("rate limits inside a fixed window and resets on the next one", async () => {
    const store = new MemoryStore();
    expect((await store.hitRate("chat:1", 0, 1_000, 2)).allowed).toBe(true);
    expect((await store.hitRate("chat:1", 10, 1_000, 2)).allowed).toBe(true);
    expect((await store.hitRate("chat:1", 20, 1_000, 2)).allowed).toBe(false);
    expect((await store.hitRate("chat:1", 1_000, 1_000, 2)).allowed).toBe(true);
  });

  it("keeps a ring buffer and reports the prior messages", async () => {
    const store = new MemoryStore();
    const key = scopeKey("42", null);
    expect(await store.pushContext(key, entry("a", 1), 2)).toEqual([]);
    expect(await store.pushContext(key, entry("b", 2), 2)).toEqual([entry("a", 1)]);
    expect(await store.pushContext(key, entry("c", 3), 2)).toEqual([entry("a", 1), entry("b", 2)]);
    expect(await store.pushContext(key, entry("d", 4), 2)).toEqual([entry("b", 2), entry("c", 3)]);
  });

  it("claims a message once per chat until the ttl passes", async () => {
    const store = new MemoryStore();
    expect(await store.claimMessage("42", 11, 0, 1000)).toBe("new");
    expect(await store.claimMessage("42", 11, 500, 1000)).toBe("duplicate");
    expect(await store.claimMessage("43", 11, 500, 1000)).toBe("new");
    expect(await store.claimMessage("42", 11, 1500, 1000)).toBe("new");
  });

  it("counts non-final sends per wake until the ttl", async () => {
    const store = new MemoryStore();
    expect(await store.adjustProgress("w", 1, 0, 100)).toBe(1);
    expect(await store.adjustProgress("w", 1, 50, 100)).toBe(2);
    expect(await store.adjustProgress("w", -1, 50, 100)).toBe(1);
    expect(await store.adjustProgress("other", 1, 50, 100)).toBe(1);
    expect(await store.adjustProgress("w", 1, 200, 100)).toBe(1);
  });

  it("closes a wake until its ttl", async () => {
    const store = new MemoryStore();
    expect(await store.isWakeClosed("w", 0)).toBe(false);
    await store.closeWake("w", 0, 100);
    expect(await store.isWakeClosed("w", 50)).toBe(true);
    expect(await store.isWakeClosed("w", 100)).toBe(false);
  });
});
