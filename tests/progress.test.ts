import { describe, expect, it } from "vitest";
import { buildDeps } from "../src/core/deps.js";
import { handleRequest } from "../src/core/handler.js";
import { scopeKey } from "../src/core/store.js";
import {
  createFetchMock,
  defaultResponse,
  dmUpdate,
  groupUpdate,
  NOW,
  postUpdate,
  testEnv,
  type RecordedCall,
} from "./helpers.js";

interface Reply {
  token: string;
  wake_id: string;
  chat_id: string;
}

function app(options: {
  env?: Record<string, string>;
  handler?: (call: RecordedCall) => Response | Promise<Response> | undefined;
} = {}) {
  const mock = createFetchMock(async (call) => {
    const custom = await options.handler?.(call);
    return custom ?? defaultResponse(call, mock.calls.length);
  });
  const tasks: Promise<unknown>[] = [];
  const logs: Record<string, unknown>[] = [];
  const deps = buildDeps({
    env: options.env ?? testEnv(),
    fetchImpl: mock.fetchImpl,
    now: () => NOW,
    sleep: async () => undefined,
    waitUntil: (promise) => tasks.push(promise),
    typingMode: "once",
    log: (event) => logs.push(event),
  });
  const calls = mock.calls;
  return {
    deps,
    tasks,
    calls,
    logs,
    telegram: (method: string) => calls.filter((call) => call.url.endsWith(`/${method}`)),
    replies: () => calls
      .filter((call) => call.url.startsWith("https://grok.example/hook"))
      .map((call) => (call.body as { reply: Reply }).reply),
    async send(reply: Reply, body: Record<string, unknown>, path = "/send"): Promise<Response> {
      return handleRequest(new Request(`https://bridge.example${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${reply.token}`, "content-type": "application/json" },
        body: JSON.stringify({ chat_id: reply.chat_id, ...body }),
      }), deps);
    },
  };
}

function methodOf(call: RecordedCall): string {
  return call.url.slice(call.url.lastIndexOf("/") + 1);
}

describe("👀 reaction lifecycle", () => {
  it("reacts on receipt and clears the reaction only after the final answer is delivered", async () => {
    const bridge = app();
    await postUpdate(bridge.deps, bridge.tasks, dmUpdate("what's the weather", 1));
    expect(bridge.telegram("setMessageReaction").map((call) => call.body)).toEqual([
      { chat_id: "42", message_id: 11, reaction: [{ type: "emoji", emoji: "👀" }], is_big: false },
    ]);
    const reply = bridge.replies()[0]!;

    await bridge.send(reply, { text: "Checking two sources, about a minute." });
    expect(bridge.telegram("setMessageReaction")).toHaveLength(1);

    const mark = bridge.calls.length;
    const final = await bridge.send(reply, { text: "Sunny.", final: true });
    expect(final.status).toBe(200);
    const after = bridge.calls.slice(mark).map(methodOf);
    expect(after).toEqual(["sendMessage", "setMessageReaction"]);
    expect(bridge.calls.at(-1)?.body).toEqual({ chat_id: "42", message_id: 11, reaction: [], is_big: false });
    expect(await bridge.deps.store.getTyping(scopeKey("42", null))).toBeNull();
  });

  it("logs and swallows a refused reaction, and still forwards the wake", async () => {
    const bridge = app({
      handler: (call) => call.url.endsWith("/setMessageReaction")
        ? Response.json({ ok: false, error_code: 400, description: "Bad Request: REACTION_INVALID" }, { status: 400 })
        : undefined,
    });
    await postUpdate(bridge.deps, bridge.tasks, dmUpdate("hello", 1));
    expect(bridge.replies()).toHaveLength(1);
    expect(bridge.logs).toContainEqual(expect.objectContaining({
      event: "reaction_failed",
      description: "Bad Request: REACTION_INVALID",
    }));
    // Nothing to clear later.
    await bridge.send(bridge.replies()[0]!, { text: "Hi.", final: true });
    expect(bridge.telegram("setMessageReaction")).toHaveLength(1);
  });

  it("still forwards when the reaction call cannot reach Telegram at all", async () => {
    const bridge = app({
      handler: (call) => {
        if (call.url.endsWith("/setMessageReaction")) throw new Error("network down");
        return undefined;
      },
    });
    await postUpdate(bridge.deps, bridge.tasks, dmUpdate("hello", 1));
    expect(bridge.replies()).toHaveLength(1);
  });

  it("sends no reaction when PROGRESS_REACTION is off, and uses a configured emoji otherwise", async () => {
    const off = app({ env: testEnv({ PROGRESS_REACTION: "off" }) });
    await postUpdate(off.deps, off.tasks, dmUpdate("hello", 1));
    expect(off.telegram("setMessageReaction")).toHaveLength(0);

    const custom = app({ env: testEnv({ PROGRESS_REACTION: "🤔" }) });
    await postUpdate(custom.deps, custom.tasks, dmUpdate("hello", 1));
    expect(custom.telegram("setMessageReaction")[0]?.body).toMatchObject({ reaction: [{ type: "emoji", emoji: "🤔" }] });
  });

  it("clears the reaction when /typing/stop ends that wake", async () => {
    const bridge = app();
    await postUpdate(bridge.deps, bridge.tasks, dmUpdate("hello", 1));
    const stopped = await bridge.send(bridge.replies()[0]!, {}, "/typing/stop");
    expect(await stopped.json()).toMatchObject({ stopped: true });
    expect(bridge.telegram("setMessageReaction").at(-1)?.body).toMatchObject({ reaction: [] });
  });
});

describe("/send final and interim semantics", () => {
  it("rejects non-final sends past the per-wake cap and still accepts the final answer", async () => {
    const bridge = app({ env: testEnv({ MAX_NON_FINAL_SENDS: "2" }) });
    await postUpdate(bridge.deps, bridge.tasks, dmUpdate("long job", 1));
    const reply = bridge.replies()[0]!;
    expect((await bridge.send(reply, { text: "one", idempotency_key: "progress-1" })).status).toBe(200);
    const repeat = await bridge.send(reply, { text: "one", idempotency_key: "progress-1" });
    expect(await repeat.json()).toMatchObject({ ok: true, already_sent: true });
    expect((await bridge.send(reply, { text: "two" })).status).toBe(200);
    const blocked = await bridge.send(reply, { text: "three" });
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ ok: false, error: "progress_limit" });
    expect(bridge.telegram("sendMessage")).toHaveLength(2);
    expect((await bridge.send(reply, { text: "done", final: true })).status).toBe(200);
  });

  it("sends interim lines silently and re-pulses typing right after them", async () => {
    const bridge = app();
    await postUpdate(bridge.deps, bridge.tasks, dmUpdate("long job", 1));
    const reply = bridge.replies()[0]!;
    const mark = bridge.calls.length;
    const interim = await bridge.send(reply, { text: "Pulling the numbers, about two minutes." });
    expect(interim.status).toBe(200);
    const after = bridge.calls.slice(mark);
    expect(after.map(methodOf)).toEqual(["sendMessage", "sendChatAction"]);
    expect(after[0]?.body).toMatchObject({ disable_notification: true });
    expect(await bridge.deps.store.getTyping(scopeKey("42", null))).not.toBeNull();
  });

  it("notifies on the final answer and honours an explicit disable_notification either way", async () => {
    const bridge = app();
    await postUpdate(bridge.deps, bridge.tasks, dmUpdate("q", 1));
    const reply = bridge.replies()[0]!;
    await bridge.send(reply, { text: "loud interim", disable_notification: false });
    await bridge.send(reply, { text: "quiet answer", final: true, disable_notification: true });
    const sends = bridge.telegram("sendMessage").map((call) => call.body as Record<string, unknown>);
    expect(sends.map((body) => body.disable_notification)).toEqual([false, true]);

    const plain = app();
    await postUpdate(plain.deps, plain.tasks, dmUpdate("q", 1));
    await plain.send(plain.replies()[0]!, { text: "answer", final: true });
    expect(plain.telegram("sendMessage")[0]?.body).toMatchObject({ disable_notification: false });

    const bad = await plain.send(plain.replies()[0]!, { text: "x", disable_notification: "yes" });
    expect(bad.status).toBe(400);
  });

  it("does not stop typing or clear the reaction when the final send fails", async () => {
    let fail = true;
    const bridge = app({
      handler: (call) => fail && call.url.endsWith("/sendMessage")
        ? Response.json({ ok: false, error_code: 400, description: "Bad Request: chat not found" }, { status: 400 })
        : undefined,
    });
    await postUpdate(bridge.deps, bridge.tasks, dmUpdate("q", 1));
    const reply = bridge.replies()[0]!;
    const failed = await bridge.send(reply, { text: "answer", final: true });
    expect(failed.status).toBe(502);
    expect(bridge.telegram("setMessageReaction")).toHaveLength(1);
    expect(Object.keys((await bridge.deps.store.getTyping(scopeKey("42", null)))?.wakes ?? {})).toEqual([reply.wake_id]);

    // The token was not retired, so the retry goes through and only then ends the wake.
    fail = false;
    const retried = await bridge.send(reply, { text: "answer", final: true });
    expect(retried.status).toBe(200);
    expect(await bridge.deps.store.getTyping(scopeKey("42", null))).toBeNull();
  });

  it("ends only the finishing wake when two wakes overlap in one chat", async () => {
    const bridge = app();
    const mention = [{ type: "mention", offset: 0, length: 8 }];
    await postUpdate(bridge.deps, bridge.tasks, groupUpdate({ text: "@testbot one", updateId: 1, chatId: -500, entities: mention }));
    await postUpdate(bridge.deps, bridge.tasks, groupUpdate({ text: "@testbot two", updateId: 2, chatId: -500, entities: mention }));
    const [first, second] = bridge.replies();
    const scope = scopeKey("-500", null);
    expect(Object.keys((await bridge.deps.store.getTyping(scope))?.wakes ?? {}).sort())
      .toEqual([first!.wake_id, second!.wake_id].sort());

    const mark = bridge.calls.length;
    await bridge.send(first!, { text: "one done", final: true });
    const after = bridge.calls.slice(mark);
    expect(after.map(methodOf)).toEqual(["sendMessage", "setMessageReaction", "sendChatAction"]);
    expect(after[1]?.body).toMatchObject({ message_id: 31, reaction: [] });
    expect(Object.keys((await bridge.deps.store.getTyping(scope))?.wakes ?? {})).toEqual([second!.wake_id]);

    await bridge.send(second!, { text: "two done", final: true });
    expect(bridge.telegram("setMessageReaction").at(-1)?.body).toMatchObject({ message_id: 32, reaction: [] });
    expect(await bridge.deps.store.getTyping(scope)).toBeNull();
  });

  it("renews the lease on heartbeat and refuses it after the final answer", async () => {
    const bridge = app();
    await postUpdate(bridge.deps, bridge.tasks, dmUpdate("q", 1));
    const reply = bridge.replies()[0]!;
    const beat = await bridge.send(reply, {}, "/typing/heartbeat");
    expect(await beat.json()).toEqual({ ok: true, active: true });
    expect(bridge.telegram("sendMessage")).toHaveLength(0);
    await bridge.send(reply, { text: "done", final: true });
    const late = await bridge.send(reply, {}, "/typing/heartbeat");
    expect(late.status).toBe(401);
  });

  it("starts the lease at 10 minutes and caps the ceiling at the reply token's expiry", async () => {
    const bridge = app();
    await postUpdate(bridge.deps, bridge.tasks, dmUpdate("q", 1));
    const wake = Object.values((await bridge.deps.store.getTyping(scopeKey("42", null)))?.wakes ?? {})[0];
    expect(wake?.leaseUntil).toBe(NOW + 600_000);
    // The default 10 minute reply token caps the 30 minute typing ceiling.
    expect(wake?.deadline).toBe(NOW + 600_000);

    // A shorter token wins: nothing can send "final" after it expires.
    const shorter = app({ env: testEnv({ REPLY_TOKEN_TTL_SECONDS: "900" }) });
    await postUpdate(shorter.deps, shorter.tasks, dmUpdate("q", 1));
    const tokenCapped = Object.values((await shorter.deps.store.getTyping(scopeKey("42", null)))?.wakes ?? {})[0];
    expect(tokenCapped?.deadline).toBe(NOW + 900_000);

    // A longer token does not lift the ceiling.
    const longer = app({ env: testEnv({ REPLY_TOKEN_TTL_SECONDS: "3600" }) });
    await postUpdate(longer.deps, longer.tasks, dmUpdate("q", 1));
    const capped = Object.values((await longer.deps.store.getTyping(scopeKey("42", null)))?.wakes ?? {})[0];
    expect(capped?.deadline).toBe(NOW + 1_800_000);
  });
});

describe("forward failure", () => {
  it("stops typing, clears the reaction, and sends one silent failure line", async () => {
    const bridge = app({
      handler: (call) => call.url.startsWith("https://grok.example/hook") ? new Response("down", { status: 503 }) : undefined,
    });
    await postUpdate(bridge.deps, bridge.tasks, dmUpdate("hello", 1));
    expect(await bridge.deps.store.getTyping(scopeKey("42", null))).toBeNull();
    expect(bridge.telegram("setMessageReaction").map((call) => (call.body as { reaction: unknown[] }).reaction.length))
      .toEqual([1, 0]);
    const lines = bridge.telegram("sendMessage").map((call) => call.body);
    expect(lines).toEqual([{
      chat_id: "42",
      text: "Sorry — I couldn't pick that up just now. Mind sending it again?",
      disable_notification: true,
      reply_parameters: { message_id: 11, allow_sending_without_reply: true },
    }]);

    // Telegram redelivering the same update does not produce a second line.
    await postUpdate(bridge.deps, bridge.tasks, dmUpdate("hello", 1));
    expect(bridge.telegram("sendMessage")).toHaveLength(1);
  });

  it("sends the line when the routine could not be reached at all", async () => {
    const bridge = app({
      handler: (call) => {
        if (call.url.startsWith("https://grok.example/hook")) {
          throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) });
        }
        return undefined;
      },
    });
    await postUpdate(bridge.deps, bridge.tasks, dmUpdate("hello", 1));
    expect(bridge.logs).toContainEqual(expect.objectContaining({ event: "forward", ok: false, reason: "unreachable" }));
    expect(bridge.logs.some((entry) => entry.event === "forward_ambiguous")).toBe(false);
    expect(bridge.telegram("sendMessage")).toHaveLength(1);
    expect(await bridge.deps.store.getTyping(scopeKey("42", null))).toBeNull();
  });

  const ambiguous: [string, (call: RecordedCall) => Response | undefined][] = [
    ["a timeout", () => { throw new DOMException("timed out", "TimeoutError"); }],
    ["a connection reset", () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("socket"), { code: "ECONNRESET" }) });
    }],
    ["an unexplained network error", () => { throw new TypeError("Network connection lost."); }],
    ["a 502 from a gateway", () => new Response("bad gateway", { status: 502 })],
    ["a 504 from a gateway", () => new Response("gateway timeout", { status: 504 })],
  ];
  for (const [label, grok] of ambiguous) {
    it(`after ${label}, keeps the wake open, sends nothing, and never retries`, async () => {
      const bridge = app({
        handler: (call) => call.url.startsWith("https://grok.example/hook") ? grok(call) : undefined,
      });
      await postUpdate(bridge.deps, bridge.tasks, dmUpdate("hello", 1));
      expect(bridge.replies()).toHaveLength(1);
      expect(bridge.logs).toContainEqual(expect.objectContaining({ event: "forward_ambiguous", update_id: 1 }));
      expect(bridge.telegram("sendMessage")).toHaveLength(0);
      // The routine may be answering: typing and the 👀 stay until its final send or the lease.
      const wakes = (await bridge.deps.store.getTyping(scopeKey("42", null)))?.wakes ?? {};
      expect(Object.keys(wakes)).toEqual([bridge.replies()[0]!.wake_id]);
      expect(bridge.telegram("setMessageReaction")).toHaveLength(1);

      // A late answer from the routine is still delivered once and ends the wake.
      const final = await bridge.send(bridge.replies()[0]!, { text: "Hi.", final: true });
      expect(final.status).toBe(200);
      expect(bridge.telegram("sendMessage")).toHaveLength(1);

      // Telegram redelivering the update does not forward it again.
      await postUpdate(bridge.deps, bridge.tasks, dmUpdate("hello", 1));
      expect(bridge.replies()).toHaveLength(1);
    });
  }

  it("can be silenced with FORWARD_FAILURE_TEXT=off", async () => {
    const bridge = app({
      env: testEnv({ FORWARD_FAILURE_TEXT: "off" }),
      handler: (call) => call.url.startsWith("https://grok.example/hook") ? new Response("down", { status: 500 }) : undefined,
    });
    await postUpdate(bridge.deps, bridge.tasks, dmUpdate("hello", 1));
    expect(bridge.telegram("sendMessage")).toHaveLength(0);
    expect(bridge.telegram("setMessageReaction").at(-1)?.body).toMatchObject({ reaction: [] });
  });
});

describe("draft placeholder (phase 3)", () => {
  it("is off by default", async () => {
    const bridge = app();
    await postUpdate(bridge.deps, bridge.tasks, dmUpdate("hello", 1));
    expect(bridge.telegram("sendMessageDraft")).toHaveLength(0);
  });

  it("when enabled, shows the empty-text placeholder in private chats only", async () => {
    const env = testEnv({ TELEGRAM_DRAFT_PLACEHOLDER: "true" });
    const dm = app({ env });
    await postUpdate(dm.deps, dm.tasks, dmUpdate("hello", 1));
    expect(dm.telegram("sendMessageDraft").map((call) => call.body)).toEqual([{ chat_id: 42, draft_id: 11, text: "" }]);

    const group = app({ env });
    await postUpdate(group.deps, group.tasks, groupUpdate({
      text: "@testbot hi",
      chatId: -500,
      entities: [{ type: "mention", offset: 0, length: 8 }],
    }));
    expect(group.replies()).toHaveLength(1);
    expect(group.telegram("sendMessageDraft")).toHaveLength(0);
  });

  it("swallows draft failures", async () => {
    const bridge = app({
      env: testEnv({ TELEGRAM_DRAFT_PLACEHOLDER: "true" }),
      handler: (call) => call.url.endsWith("/sendMessageDraft")
        ? Response.json({ ok: false, error_code: 400, description: "Bad Request: method not available" }, { status: 400 })
        : undefined,
    });
    await postUpdate(bridge.deps, bridge.tasks, dmUpdate("hello", 1));
    expect(bridge.replies()).toHaveLength(1);
    expect(bridge.logs).toContainEqual(expect.objectContaining({ event: "draft_failed" }));
  });
});
