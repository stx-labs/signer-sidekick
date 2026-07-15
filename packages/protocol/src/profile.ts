import { z } from "zod";
import { parseContractPrincipal, validatePrincipal } from "./principals.js";

const contractPrincipal = z.string().refine((value) => {
  try {
    parseContractPrincipal(value);
    return true;
  } catch {
    return false;
  }
}, "Invalid contract principal");
const standardPrincipal = z
  .string()
  .refine(
    (value) => !value.includes(".") && validatePrincipal(value),
    "Invalid standard principal",
  );
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const managerProfileSchema = z
  .object({
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
  })
  .superRefine((profile, context) => {
    const expectedPox5 =
      profile.network === "mainnet"
        ? "SP000000000000000000002Q6VF78.pox-5"
        : "ST000000000000000000002AMW42H.pox-5";
    if (profile.contracts.pox5 !== expectedPox5) {
      context.addIssue({
        code: "custom",
        path: ["contracts", "pox5"],
        message: `Expected the canonical ${profile.network} PoX-5 boot contract ${expectedPox5}`,
      });
    }
    const sbtcPrefix = profile.contracts.sbtcDeployer.slice(0, 2);
    const isMainnetPrincipal = sbtcPrefix === "SP" || sbtcPrefix === "SM";
    if ((profile.network === "mainnet") !== isMainnetPrincipal) {
      context.addIssue({
        code: "custom",
        path: ["contracts", "sbtcDeployer"],
        message: `sBTC deployer principal does not match the ${profile.network} network`,
      });
    }
  });

export type ManagerProfile = z.infer<typeof managerProfileSchema>;

export function parseManagerProfile(input: unknown): ManagerProfile {
  return managerProfileSchema.parse(input);
}
