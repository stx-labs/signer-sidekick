import { z } from "zod";

const contractPrincipal = z.string().regex(/^S[PMTN][0-9A-Z]{20,40}\.[a-zA-Z][a-zA-Z0-9-]{0,39}$/);
const standardPrincipal = z.string().regex(/^S[PMTN][0-9A-Z]{20,40}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const managerProfileSchema = z.object({
  id: z.string().min(1),
  network: z.enum(["mainnet", "testnet", "devnet", "regtest"]),
  upstream: z.object({
    tag: z.string().min(1),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    sourceSha256: sha256,
  }),
  contracts: z.object({
    pox5: contractPrincipal,
    sbtcDeployer: standardPrincipal,
  }),
  expectedReplacements: z.object({
    pox5: z.number().int().positive(),
    sbtcDeployer: z.number().int().positive(),
  }),
  productionApproved: z.boolean(),
});

export type ManagerProfile = z.infer<typeof managerProfileSchema>;

export function parseManagerProfile(input: unknown): ManagerProfile {
  return managerProfileSchema.parse(input);
}
