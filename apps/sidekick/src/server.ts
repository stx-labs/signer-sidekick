import { STACKS_CORE_4_0_0 } from "@stx-labs/signer-sidekick-protocol";
import Fastify from "fastify";

export function createServer() {
  const server = Fastify({ logger: true });

  server.get("/healthz", async () => ({
    status: "ok",
    phase: "protocol-foundation",
    protocol: {
      stacksCoreTag: STACKS_CORE_4_0_0.tag,
      stacksCoreCommit: STACKS_CORE_4_0_0.commit,
    },
  }));

  return server;
}
