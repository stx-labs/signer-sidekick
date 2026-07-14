import { createServer } from "./server.js";

const [command = "help"] = process.argv.slice(2);

if (command === "serve") {
  const server = createServer();
  await server.listen({ host: "127.0.0.1", port: 3998 });
} else {
  console.log(`Signer Sidekick scaffold

Usage:
  sidekick serve    Start the loopback-only local API

Activation setup commands are implemented in Milestone 2.`);
}
