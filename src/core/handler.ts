import { configStatus } from "./config.js";
import { secretsEqual } from "./crypto.js";
import type { AppDeps } from "./deps.js";
import { json, routePath } from "./http.js";
import { handleWebhook } from "./inbound.js";
import { handleSend, handleTypingHeartbeat, handleTypingStop } from "./outbound.js";

/**
 * Liveness is always `{ ok: true }`. Configuration names and the ready flag
 * are shown only when HEALTH_DETAIL is on, or when a HEALTHZ_TOKEN bearer matches.
 * A configured token wins: HEALTH_DETAIL alone does not open the detail.
 */
export async function handleHealth(request: Request, deps: AppDeps): Promise<Response> {
  if (!await healthDetailAllowed(request, deps)) return json(200, { ok: true });
  const configured = configStatus(deps.config);
  const ready = Object.values(configured).every(Boolean) && deps.config.problems.length === 0;
  return json(200, {
    ok: true,
    service: "grokbot-telegram",
    ready,
    configured,
    // Setting names only, never values.
    problems: deps.config.problems,
  });
}

async function healthDetailAllowed(request: Request, deps: AppDeps): Promise<boolean> {
  const token = deps.config.healthzToken;
  if (token) {
    const header = request.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
    return secretsEqual(token, match?.[1] ?? "");
  }
  return deps.config.healthDetail;
}

export async function handleRequest(request: Request, deps: AppDeps): Promise<Response> {
  try {
    return await route(request, deps);
  } catch (err) {
    // A store or upstream failure must not surface a platform error page or stack.
    deps.log({ event: "request_failed", error: err instanceof Error ? err.name : "error" });
    return json(500, { ok: false, error: "internal_error" });
  }
}

async function route(request: Request, deps: AppDeps): Promise<Response> {
  const url = new URL(request.url);
  const path = routePath(url, deps.config.pathPrefix);
  if (request.method === "GET" || request.method === "HEAD") {
    if (path === "/healthz") {
      const response = await handleHealth(request, deps);
      if (request.method === "HEAD") return new Response(null, { status: response.status, headers: response.headers });
      return response;
    }
  }
  if (request.method === "POST" && path === "/webhook") return handleWebhook(request, deps);
  if (request.method === "POST" && path === "/send") return handleSend(request, deps);
  if (request.method === "POST" && path === "/typing/stop") return handleTypingStop(request, deps);
  if (request.method === "POST" && path === "/typing/heartbeat") return handleTypingHeartbeat(request, deps);
  if (["/healthz", "/webhook", "/send", "/typing/stop", "/typing/heartbeat"].includes(path)) {
    return json(405, { ok: false, error: "method_not_allowed" });
  }
  return json(404, { ok: false, error: "not_found" });
}

export { handleSend, handleTypingHeartbeat, handleTypingStop, handleWebhook };
