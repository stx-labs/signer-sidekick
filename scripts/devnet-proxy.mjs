import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";

const controlPort = Number(process.env.SIDEKICK_PROXY_CONTROL_PORT ?? 21999);
const targets = {
  node: {
    listenPort: Number(process.env.SIDEKICK_PROXY_NODE_PORT ?? 21443),
    upstream: process.env.SIDEKICK_PROXY_NODE_UPSTREAM ?? "http://127.0.0.1:20443",
  },
  api: {
    listenPort: Number(process.env.SIDEKICK_PROXY_API_PORT ?? 13999),
    upstream: process.env.SIDEKICK_PROXY_API_UPSTREAM ?? "http://127.0.0.1:3999",
  },
  observer: {
    listenPort: Number(process.env.SIDEKICK_PROXY_OBSERVER_PORT ?? 23700),
    upstream: process.env.SIDEKICK_PROXY_OBSERVER_UPSTREAM ?? "http://127.0.0.1:3700",
    forwardPaths: new Set(["/new_block", "/new_burn_block", "/attachments/new"]),
  },
};

const methodsWithoutBodies = new Set(["GET", "HEAD"]);

const state = {
  node: {
    mode: "pass",
    latencyMs: 0,
    statusCode: 503,
    fixture: null,
    pathContains: null,
    remainingPasses: 0,
  },
  api: {
    mode: "pass",
    latencyMs: 0,
    statusCode: 503,
    fixture: null,
    pathContains: null,
    remainingPasses: 0,
  },
  observer: {
    // stacks-node starts before Sidekick has a deployed manager to bind. Acknowledge that bootstrap
    // traffic without retaining it; the harness switches this proxy to pass-through only after
    // Sidekick's private listener is ready.
    mode: "ack",
    latencyMs: 0,
    statusCode: 503,
    fixture: null,
    pathContains: null,
    remainingPasses: 0,
  },
};

function sendJson(response, statusCode, body) {
  const encoded = Buffer.from(`${JSON.stringify(body)}\n`);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": encoded.length,
    "cache-control": "no-store",
  });
  response.end(encoded);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function sanitizeHeaders(headers) {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || ["host", "connection", "content-length"].includes(name)) continue;
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    } else {
      result.set(name, value);
    }
  }
  return result;
}

function startProxy(name, configuration) {
  return http
    .createServer(async (request, response) => {
      const current = state[name];
      if (current.latencyMs > 0) await delay(current.latencyMs);
      if (current.mode === "drop") {
        request.socket.destroy();
        return;
      }
      if (current.mode === "status") {
        sendJson(response, current.statusCode, { error: `injected_${name}_failure` });
        return;
      }
      if (current.mode === "ack") {
        if (!methodsWithoutBodies.has(request.method ?? "GET")) await readBody(request);
        sendJson(response, 200, { accepted: true, forwarded: false });
        return;
      }
      if (
        configuration.forwardPaths &&
        !configuration.forwardPaths.has(request.url?.split("?", 1)[0] ?? "")
      ) {
        if (!methodsWithoutBodies.has(request.method ?? "GET")) await readBody(request);
        sendJson(response, 200, { accepted: true, forwarded: false });
        return;
      }
      if (
        current.mode === "fail-after" &&
        current.pathContains &&
        request.url?.includes(current.pathContains)
      ) {
        if (current.remainingPasses <= 0) {
          sendJson(response, current.statusCode, { error: `injected_${name}_failure` });
          return;
        }
        current.remainingPasses -= 1;
      }
      if (
        current.mode === "fixture" &&
        current.fixture &&
        request.url?.includes(current.fixture.pathContains)
      ) {
        sendJson(response, current.fixture.statusCode ?? 200, current.fixture.body);
        return;
      }
      try {
        const body = methodsWithoutBodies.has(request.method ?? "GET")
          ? undefined
          : await readBody(request);
        const upstream = await fetch(new URL(request.url ?? "/", configuration.upstream), {
          method: request.method,
          headers: sanitizeHeaders(request.headers),
          body,
          redirect: "manual",
        });
        const headers = {};
        for (const [key, value] of upstream.headers) {
          if (!["connection", "transfer-encoding", "content-encoding"].includes(key)) {
            headers[key] = value;
          }
        }
        const encoded = Buffer.from(await upstream.arrayBuffer());
        headers["content-length"] = String(encoded.length);
        response.writeHead(upstream.status, headers);
        response.end(encoded);
      } catch {
        sendJson(response, 502, { error: "proxy_upstream_unavailable", target: name });
      }
    })
    .listen(configuration.listenPort, "0.0.0.0", () => {
      console.log(`${name} proxy listening on ${configuration.listenPort}`);
    });
}

const servers = Object.entries(targets).map(([name, configuration]) =>
  startProxy(name, configuration),
);

const control = http
  .createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/state") {
      sendJson(response, 200, state);
      return;
    }
    if (request.method !== "POST" || request.url !== "/control") {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    try {
      const body = JSON.parse((await readBody(request)).toString("utf8"));
      if (!Object.hasOwn(state, body.target)) throw new Error("invalid target");
      if (!["ack", "pass", "drop", "status", "fixture", "fail-after"].includes(body.mode)) {
        throw new Error("invalid mode");
      }
      const latencyMs = Number(body.latencyMs ?? 0);
      if (!Number.isSafeInteger(latencyMs) || latencyMs < 0 || latencyMs > 60_000) {
        throw new Error("invalid latency");
      }
      const statusCode = Number(body.statusCode ?? 503);
      if (!Number.isSafeInteger(statusCode) || statusCode < 400 || statusCode > 599) {
        throw new Error("invalid status code");
      }
      let fixture = null;
      if (body.mode === "fixture") {
        if (typeof body.pathContains !== "string" || body.pathContains.length < 1) {
          throw new Error("fixture requires pathContains");
        }
        fixture = {
          pathContains: body.pathContains,
          body: body.body,
          statusCode: body.fixtureStatus,
        };
      }
      let pathContains = null;
      let remainingPasses = 0;
      if (body.mode === "fail-after") {
        if (typeof body.pathContains !== "string" || body.pathContains.length < 1) {
          throw new Error("fail-after requires pathContains");
        }
        remainingPasses = Number(body.passCount ?? 1);
        if (
          !Number.isSafeInteger(remainingPasses) ||
          remainingPasses < 0 ||
          remainingPasses > 100
        ) {
          throw new Error("invalid passCount");
        }
        pathContains = body.pathContains;
      }
      state[body.target] = {
        mode: body.mode,
        latencyMs,
        statusCode,
        fixture,
        pathContains,
        remainingPasses,
      };
      sendJson(response, 200, { target: body.target, ...state[body.target] });
    } catch {
      sendJson(response, 400, { error: "invalid_control_request" });
    }
  })
  .listen(controlPort, "127.0.0.1", () => {
    console.log(`control listening on ${controlPort}`);
  });

function shutdown() {
  control.close();
  for (const server of servers) server.close();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
