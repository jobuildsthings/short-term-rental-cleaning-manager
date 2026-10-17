import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptField, encryptField } from "../lib/crypto";

const TEST_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("encryptField / decryptField", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("round-trips arbitrary text", () => {
    vi.stubEnv("ACCESS_INSTRUCTIONS_KEY", TEST_KEY);
    const original = "Gate code 4821, lockbox under the mat";
    const enc = encryptField(original);
    expect(enc).not.toContain("4821");
    expect(enc.startsWith("v1.")).toBe(true);
    expect(decryptField(enc)).toBe(original);
  });

  it("produces different ciphertexts for the same plaintext (random IV)", () => {
    vi.stubEnv("ACCESS_INSTRUCTIONS_KEY", TEST_KEY);
    expect(encryptField("same")).not.toBe(encryptField("same"));
  });

  it("rejects tampered payloads", () => {
    vi.stubEnv("ACCESS_INSTRUCTIONS_KEY", TEST_KEY);
    const enc = encryptField("secret");
    const parts = enc.split(".");
    parts[2] = Buffer.from("tampered-ciphertext-padded!!").toString("base64");
    expect(() => decryptField(parts.join("."))).toThrow();
  });

  it("rejects the wrong key", () => {
    vi.stubEnv("ACCESS_INSTRUCTIONS_KEY", TEST_KEY);
    const enc = encryptField("secret");
    vi.stubEnv(
      "ACCESS_INSTRUCTIONS_KEY",
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    );
    expect(() => decryptField(enc)).toThrow();
  });

  it("fails closed when the key is missing or malformed", () => {
    vi.stubEnv("ACCESS_INSTRUCTIONS_KEY", "");
    expect(() => encryptField("x")).toThrow(/ACCESS_INSTRUCTIONS_KEY/);
    vi.stubEnv("ACCESS_INSTRUCTIONS_KEY", "short");
    expect(() => encryptField("x")).toThrow(/32 bytes/);
  });
});
