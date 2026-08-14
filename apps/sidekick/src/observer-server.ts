import { createHash } from "node:crypto";
import { parseContractPrincipal } from "@stx-labs/signer-sidekick-protocol/principals";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import type {
  AcceptedObserverDelivery,
  ObserverInboxStatus,
  SidekickStore,
} from "./storage/store.js";

const canonicalHash = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/i)
  .transform((value) => value.toLowerCase());

const newBlockClaimSchema = z
  .object({
    block_hash: canonicalHash,
    block_height: z.number().int().nonnegative().safe(),
    index_block_hash: canonicalHash,
    events: z.array(z.unknown()),
    transactions: z.array(z.unknown()),
  })
  .passthrough();

const newBurnBlockClaimSchema = z
  .object({
    burn_block_hash: canonicalHash,
    burn_block_height: z.number().int().nonnegative().safe(),
    consensus_hash: z.string().min(1),
    parent_burn_block_hash: canonicalHash,
  })
  .passthrough();

const attachmentsClaimSchema = z.array(z.unknown());

export type ObserverEndpointKind = "new-block" | "new-burn-block" | "attachments";

export interface ObserverServerConfig {
  enabled: boolean;
  host: string;
  port: number;
  maxBodyBytes: number;
}

export interface ObserverRuntimeStatus {
  schemaVersion: 1;
  enabled: boolean;
  listening: boolean;
  listener: null | {
    host: string;
    port: number;
    maxBodyBytes: number;
  };
  inbox: ObserverInboxStatus;
}

function parseNodeReachableObserverEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(`http://${value}`);
  } catch {
    throw new Error("Observer endpoint must be a node-reachable host:port without a URL scheme");
  }
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash ||
    !endpoint.hostname ||
    !endpoint.port
  ) {
    throw new Error("Observer endpoint must be a node-reachable host:port without a URL scheme");
  }
  return endpoint.host;
}

export function renderStacksEventObserverConfig(input: {
  nodeReachableEndpoint: string;
  pox5ContractId: string;
  managerPrincipal: string;
}): { observerToml: string; nodeToml: string } {
  const endpoint = parseNodeReachableObserverEndpoint(input.nodeReachableEndpoint);
  parseContractPrincipal(input.pox5ContractId);
  parseContractPrincipal(input.managerPrincipal);
  return {
    observerToml: `[[events_observer]]
endpoint = "${endpoint}"
events_keys = [
  "burn_blocks",
  "${input.pox5ContractId}::print",
  "${input.managerPrincipal}::print",
]
timeout_ms = 5000
disable_retries = false`,
    nodeToml: `# Add these keys to the node's existing [node] table.
event_dispatcher_blocking = false
event_dispatcher_queue_size = 1000`,
  };
}

function parseBoolean(value: string | undefined, name: string, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function parseInteger(
  value: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const candidate = value?.trim() || String(fallback);
  if (!/^\d+$/.test(candidate)) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  const parsed = Number(candidate);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}

export function loadObserverServerConfig(env: NodeJS.ProcessEnv): ObserverServerConfig {
  return {
    enabled: parseBoolean(env.SIDEKICK_EVENT_HTTP_ENABLED, "SIDEKICK_EVENT_HTTP_ENABLED", true),
    host: env.SIDEKICK_EVENT_HTTP_HOST?.trim() || "127.0.0.1",
    port: parseInteger(env.SIDEKICK_EVENT_HTTP_PORT, "SIDEKICK_EVENT_HTTP_PORT", 3700, 1, 65_535),
    maxBodyBytes: parseInteger(
      env.SIDEKICK_EVENT_MAX_BODY_BYTES,
      "SIDEKICK_EVENT_MAX_BODY_BYTES",
      4 * 1_024 * 1_024,
      1_024,
      16 * 1_024 * 1_024,
    ),
  };
}

function invalidPayloadReason(error: z.ZodError): string {
  const first = error.issues[0];
  const path = first?.path.length ? first.path.join(".") : "payload";
  return `invalid-payload-shape:${path}:${first?.message ?? "invalid callback payload"}`.slice(
    0,
    500,
  );
}

function deliveryClaim(
  endpointKind: ObserverEndpointKind,
  payload: unknown,
): {
  state: "observer-claimed" | "quarantined" | "expired";
  stateReason: string | null;
  claimedBlockHeight: number | null;
  claimedBlockHash: string | null;
  claimedIndexBlockHash: string | null;
  claimedBurnBlockHeight: number | null;
  claimedBurnBlockHash: string | null;
} {
  if (endpointKind === "new-block") {
    const parsed = newBlockClaimSchema.safeParse(payload);
    if (!parsed.success) {
      return {
        state: "quarantined",
        stateReason: invalidPayloadReason(parsed.error),
        claimedBlockHeight: null,
        claimedBlockHash: null,
        claimedIndexBlockHash: null,
        claimedBurnBlockHeight: null,
        claimedBurnBlockHash: null,
      };
    }
    return {
      state: "observer-claimed",
      stateReason: null,
      claimedBlockHeight: parsed.data.block_height,
      claimedBlockHash: parsed.data.block_hash,
      claimedIndexBlockHash: parsed.data.index_block_hash,
      claimedBurnBlockHeight: null,
      claimedBurnBlockHash: null,
    };
  }
  if (endpointKind === "new-burn-block") {
    const parsed = newBurnBlockClaimSchema.safeParse(payload);
    if (!parsed.success) {
      return {
        state: "quarantined",
        stateReason: invalidPayloadReason(parsed.error),
        claimedBlockHeight: null,
        claimedBlockHash: null,
        claimedIndexBlockHash: null,
        claimedBurnBlockHeight: null,
        claimedBurnBlockHash: null,
      };
    }
    return {
      state: "observer-claimed",
      stateReason: null,
      claimedBlockHeight: null,
      claimedBlockHash: null,
      claimedIndexBlockHash: null,
      claimedBurnBlockHeight: parsed.data.burn_block_height,
      claimedBurnBlockHash: parsed.data.burn_block_hash,
    };
  }
  const parsed = attachmentsClaimSchema.safeParse(payload);
  return {
    state: parsed.success ? "expired" : "quarantined",
    stateReason: parsed.success
      ? "implicit-attachment-callback-not-used"
      : invalidPayloadReason(parsed.error),
    claimedBlockHeight: null,
    claimedBlockHash: null,
    claimedIndexBlockHash: null,
    claimedBurnBlockHeight: null,
    claimedBurnBlockHash: null,
  };
}

export function observerRuntimeStatus(
  config: ObserverServerConfig,
  inbox: ObserverInboxStatus,
  listening = false,
): ObserverRuntimeStatus {
  if (listening && !config.enabled) {
    throw new Error("A disabled observer listener cannot be reported as listening");
  }
  return {
    schemaVersion: 1,
    enabled: config.enabled,
    listening,
    listener: config.enabled
      ? { host: config.host, port: config.port, maxBodyBytes: config.maxBodyBytes }
      : null,
    inbox,
  };
}

export function createObserverServer(options: {
  store: Pick<SidekickStore, "acceptObserverDelivery">;
  maxBodyBytes: number;
  logger?: boolean;
  now?: () => Date;
  onAccepted?: (delivery: AcceptedObserverDelivery) => Promise<void> | void;
}): FastifyInstance {
  const now = options.now ?? (() => new Date());
  const server = Fastify({
    logger: options.logger ?? false,
    bodyLimit: options.maxBodyBytes,
    requestTimeout: 5_000,
  });
  server.removeContentTypeParser("application/json");
  server.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) =>
    done(null, body),
  );

  const accept =
    (endpointKind: ObserverEndpointKind) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (
        typeof request.body !== "string" ||
        !request.headers["content-type"]?.toLowerCase().startsWith("application/json")
      ) {
        return reply.code(415).send({ error: "content-type must be application/json" });
      }
      let payload: unknown;
      try {
        payload = JSON.parse(request.body);
      } catch {
        return reply.code(400).send({ error: "body must be valid JSON" });
      }
      const claim = deliveryClaim(endpointKind, payload);
      const delivery = options.store.acceptObserverDelivery({
        endpointKind,
        contentSha256: createHash("sha256").update(request.body, "utf8").digest("hex"),
        rawPayloadJson: request.body,
        payloadBytes: Buffer.byteLength(request.body, "utf8"),
        ...claim,
        receivedAt: now().toISOString(),
      });
      if (options.onAccepted) {
        queueMicrotask(() => {
          void Promise.resolve(options.onAccepted?.(delivery)).catch((error: unknown) => {
            server.log.warn(
              { error: error instanceof Error ? error.message : String(error) },
              "Observer delivery follow-up failed; the durable inbox retains it for retry",
            );
          });
        });
      }
      return {
        schemaVersion: 1,
        accepted: true,
        deliveryId: delivery.deliveryId,
        duplicate: delivery.duplicate,
        state: delivery.state,
      };
    };

  server.get("/health/live", async () => ({ status: "ok" }));
  server.post("/new_block", accept("new-block"));
  server.post("/new_burn_block", accept("new-burn-block"));
  // Stacks Core sends this endpoint to every observer even when it is not subscribed explicitly.
  // Commit and expire it so the node receives a durable acknowledgement instead of retrying.
  server.post("/attachments/new", accept("attachments"));
  return server;
}
