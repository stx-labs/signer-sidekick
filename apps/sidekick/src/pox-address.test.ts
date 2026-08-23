import { describe, expect, it } from "vitest";
import { poxAddressNetwork, poxAddressToBtcAddress } from "./pox-address.js";

describe("poxAddressToBtcAddress", () => {
  it("encodes legacy P2PKH with base58check (genesis address)", () => {
    expect(
      poxAddressToBtcAddress("00", "62e907b15cbf27d5425399ebf6f0fb50ebb88f18", "mainnet"),
    ).toBe("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa");
    expect(
      poxAddressToBtcAddress("0x00", "0x62e907b15cbf27d5425399ebf6f0fb50ebb88f18", "testnet"),
    ).toMatch(/^[mn][1-9A-HJ-NP-Za-km-z]{33}$/);
  });

  it("encodes P2SH-family versions with the script-hash prefix", () => {
    const mainnet = poxAddressToBtcAddress(
      "01",
      "8f55563b9a19f321c211e9b9f38cdf686ea07845",
      "mainnet",
    );
    expect(mainnet).toMatch(/^3[1-9A-HJ-NP-Za-km-z]{33}$/);
    expect(
      poxAddressToBtcAddress("02", "8f55563b9a19f321c211e9b9f38cdf686ea07845", "mainnet"),
    ).toBe(mainnet);
    expect(
      poxAddressToBtcAddress("03", "8f55563b9a19f321c211e9b9f38cdf686ea07845", "testnet"),
    ).toMatch(/^2[1-9A-HJ-NP-Za-km-z]{34}$/);
  });

  it("encodes segwit v0 with bech32 (BIP173 vectors)", () => {
    expect(
      poxAddressToBtcAddress("04", "751e76e8199196d454941c45d1b3a323f1433bd6", "mainnet"),
    ).toBe("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");
    expect(
      poxAddressToBtcAddress("04", "751e76e8199196d454941c45d1b3a323f1433bd6", "testnet"),
    ).toBe("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx");
    expect(
      poxAddressToBtcAddress(
        "05",
        "1863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262",
        "mainnet",
      ),
    ).toBe("bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3");
    expect(
      poxAddressToBtcAddress("04", "751e76e8199196d454941c45d1b3a323f1433bd6", "regtest"),
    ).toMatch(/^bcrt1q/);
  });

  it("encodes taproot with bech32m (BIP350 vector)", () => {
    expect(
      poxAddressToBtcAddress(
        "06",
        "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
        "mainnet",
      ),
    ).toBe("bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0");
  });

  it("refuses unknown versions and hash lengths that cannot encode", () => {
    expect(
      poxAddressToBtcAddress("07", "751e76e8199196d454941c45d1b3a323f1433bd6", "mainnet"),
    ).toBe(null);
    expect(poxAddressToBtcAddress("04", "751e76e8", "mainnet")).toBe(null);
    expect(
      poxAddressToBtcAddress("06", "751e76e8199196d454941c45d1b3a323f1433bd6", "mainnet"),
    ).toBe(null);
    expect(
      poxAddressToBtcAddress("zz", "751e76e8199196d454941c45d1b3a323f1433bd6", "mainnet"),
    ).toBe(null);
  });

  it("maps Sidekick network names onto Bitcoin namespaces", () => {
    expect(poxAddressNetwork("mainnet")).toBe("mainnet");
    expect(poxAddressNetwork("testnet")).toBe("testnet");
    expect(poxAddressNetwork("devnet")).toBe("regtest");
    expect(poxAddressNetwork("mocknet")).toBe("regtest");
  });
});
