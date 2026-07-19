import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  fetchHealthSource,
  isDeniedHealthAddress,
  validateHealthEndpointForSave,
  validateHealthEndpointUrl,
} from "./health-http.js";
import { InteractiveRequestCancelledError } from "./request-context.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("health endpoint safety", () => {
  it("allows private and loopback targets while blocking metadata and link-local targets", () => {
    expect(isDeniedHealthAddress("127.0.0.1")).toBe(false);
    expect(isDeniedHealthAddress("10.0.0.2")).toBe(false);
    expect(isDeniedHealthAddress("::1")).toBe(false);
    expect(isDeniedHealthAddress("169.254.169.254")).toBe(true);
    expect(isDeniedHealthAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isDeniedHealthAddress("100.100.100.200")).toBe(true);
    expect(isDeniedHealthAddress("fd00:ec2::254")).toBe(true);
    expect(isDeniedHealthAddress("0.0.0.0")).toBe(true);
    expect(isDeniedHealthAddress("ff02::1")).toBe(true);
  });

  it("rejects credentials, non-http schemes, query strings, and blocked literal addresses", async () => {
    expect(() => validateHealthEndpointUrl("file:///etc/passwd")).toThrow();
    expect(() => validateHealthEndpointUrl("http://user:pass@localhost:9153")).toThrow();
    expect(() => validateHealthEndpointUrl("http://localhost:9153?secret=value")).toThrow();
    await expect(
      validateHealthEndpointForSave("http://169.254.169.254/latest"),
    ).rejects.toMatchObject({
      code: "unsafe-address",
    });
  });

  it("stops save validation when the operator request is cancelled", async () => {
    const controller = new AbortController();
    const validation = validateHealthEndpointForSave(
      "http://127.0.0.1:9153",
      "Node metrics URL",
      controller.signal,
    );
    controller.abort(new InteractiveRequestCancelledError());

    await expect(validation).rejects.toBeInstanceOf(InteractiveRequestCancelledError);
  });

  it("pins an allowed address and bounds the response", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/plain");
      response.end("metric 1\n");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");

    await expect(fetchHealthSource(`http://127.0.0.1:${address.port}`)).resolves.toMatchObject({
      status: 200,
      body: "metric 1\n",
    });
    await expect(
      fetchHealthSource(`http://127.0.0.1:${address.port}`, { maxBytes: 3 }),
    ).rejects.toMatchObject({ code: "response-too-large" });
  });

  it("times out stalled sources and does not follow redirects", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/redirect") {
        response.statusCode = 302;
        response.setHeader("location", "http://169.254.169.254/latest");
        response.end();
      }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    await expect(fetchHealthSource(`${baseUrl}/redirect`)).rejects.toMatchObject({
      code: "http-error",
    });
    await expect(fetchHealthSource(`${baseUrl}/stalled`, { timeoutMs: 10 })).rejects.toMatchObject({
      code: "timeout",
    });
  });
});
