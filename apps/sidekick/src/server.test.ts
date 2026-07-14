import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "./server.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("local API", () => {
  it("reports the exact protocol pin", async () => {
    const server = createServer();
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      protocol: {
        stacksCoreTag: "4.0.0",
        stacksCoreCommit: "5595f08a244362cefc316f95b398510a2b8cb791",
      },
    });
  });
});
