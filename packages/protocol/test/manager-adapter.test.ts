import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalizeClaritySource,
  createReferenceManagerAdapter,
} from "../src/manager-adapter.js";
import { parseManagerProfile } from "../src/profile.js";

const root = resolve(import.meta.dirname, "../../..");

async function loadFixture() {
  const [source, profileJson] = await Promise.all([
    readFile(
      resolve(root, "contracts/reference-manager/generated/mainnet/signer-manager.clar"),
      "utf8",
    ),
    readFile(resolve(root, "contracts/reference-manager/profiles/mainnet.json"), "utf8"),
  ]);
  return { source, profile: parseManagerProfile(JSON.parse(profileJson)) };
}

describe("reference manager source recognition", () => {
  it("recognizes an exact artifact without enabling an unapproved profile", async () => {
    const { source, profile } = await loadFixture();
    const adapter = createReferenceManagerAdapter(profile, source);

    expect(adapter.recognizeSource(source)).toMatchObject({
      match: "exact",
      profileId: profile.id,
      automationAllowed: false,
    });
  });

  it("recognizes only lexical whitespace and comment changes", async () => {
    const { source, profile } = await loadFixture();
    const adapter = createReferenceManagerAdapter(profile, source);
    const reformatted = `;; local deployment note\n\n${source.replaceAll("\n", "  \n")}`;

    expect(adapter.recognizeSource(reformatted)).toMatchObject({
      match: "canonical",
      profileId: profile.id,
    });
  });

  it("rejects a behavior-changing source edit", async () => {
    const { source, profile } = await loadFixture();
    const adapter = createReferenceManagerAdapter(profile, source);
    const modified = source.replace(
      "(define-data-var fees-bips uint u0)",
      "(define-data-var fees-bips uint u1)",
    );

    expect(adapter.recognizeSource(modified)).toMatchObject({
      match: "unknown",
      profileId: null,
      automationAllowed: false,
    });
  });

  it("preserves comment-like content inside strings", () => {
    expect(
      canonicalizeClaritySource('(print "value ;; not a comment") ;; comment\n(ok true)'),
    ).toBe('(print "value ;; not a comment") (ok true)');
  });
});
