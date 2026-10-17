/**
 * Field-level encryption for the most sensitive values in the system:
 * property access instructions (door codes) and stored OAuth refresh tokens.
 *
 * AES-256-GCM with a 32-byte key from ACCESS_INSTRUCTIONS_KEY (hex).
 * Format: v1.<base64 iv>.<base64 ciphertext>.<base64 auth tag>
 *
 * RULES (binding):
 * - Decrypt only in memory, at the exact point of use (reminder rendering,
 *   owner's edit form, token refresh). Never assign a decrypted value to a
 *   variable that gets logged.
 * - NEVER write decrypted values to logs, error reports, audit metadata,
 *   or API responses that don't strictly require them.
 * - The honest limit: the app must decrypt codes to inject them into
 *   reminders. This protects data at rest, not a compromised server.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const KEY_ENV = "ACCESS_INSTRUCTIONS_KEY";

function getKey(): Buffer {
  const hex = process.env[KEY_ENV];
  if (!hex) {
    throw new Error(
      `${KEY_ENV} is not set. Generate one with: openssl rand -hex 32`,
    );
  }
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) {
    throw new Error(`${KEY_ENV} must be 32 bytes encoded as hex (64 chars).`);
  }
  return key;
}

export function encryptField(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64")}.${ciphertext.toString("base64")}.${tag.toString("base64")}`;
}

export function decryptField(payload: string): string {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Unrecognized encrypted payload format.");
  }
  const [, ivB64, ctB64, tagB64] = parts as [string, string, string, string];
  const decipher = createDecipheriv(
    "aes-256-gcm",
    getKey(),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
