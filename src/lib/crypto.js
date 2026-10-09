import crypto from "crypto";

const PREFIX = "enc:v1:";

function getKey() {
  const secret = process.env.CHANNEL_ENCRYPTION_KEY || process.env.ACCESS_KEY;
  if (!secret) {
    throw new Error("CHANNEL_ENCRYPTION_KEY (or ACCESS_KEY) is required to encrypt bot tokens");
  }
  // AES-256 needs 32 bytes
  return crypto.createHash("sha256").update(String(secret)).digest();
}

/**
 * Encrypt a Telegram bot token for MongoDB storage.
 * Returns `enc:v1:<iv_b64>:<tag_b64>:<ciphertext_b64>`
 */
export function encryptSecret(plain) {
  const text = String(plain || "");
  if (!text) return text;
  if (text.startsWith(PREFIX)) return text; // already encrypted

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

/**
 * Decrypt a stored bot token. Plaintext legacy values pass through unchanged.
 */
export function decryptSecret(stored) {
  const text = String(stored || "");
  if (!text) return text;
  if (!text.startsWith(PREFIX)) return text; // legacy plaintext

  const raw = text.slice(PREFIX.length);
  const [ivB64, tagB64, dataB64] = raw.split(":");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Invalid encrypted secret format");
  }

  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/** Safe to return in API responses — never expose the real token. */
export function maskSecret(stored) {
  if (!stored) return null;
  if (String(stored).startsWith(PREFIX)) return "•••••••• (encrypted)";
  const t = String(stored);
  if (t.includes(":")) {
    const [id, secret] = t.split(":");
    return `${id}:${"•".repeat(Math.min(8, secret.length))}…`;
  }
  return "••••••••";
}
