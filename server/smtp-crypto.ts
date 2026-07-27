import {
  createCipheriv,
  createDecipheriv,
  randomBytes
} from "node:crypto";
import { config } from "./config.js";

const legacyEncryptionContext = Buffer.from(
  "resource-scheduler:smtp-password:v1",
  "utf8"
);
const encryptionContext = Buffer.from("allocube:smtp-password:v2", "utf8");

function encryptionKey() {
  const key = Buffer.from(config.smtpSettingsEncryptionKey, "base64");
  if (key.length !== 32) {
    throw new Error("SMTP 配置加密密钥无效");
  }
  return key;
}

export function decryptSmtpPasswordWithKey(
  envelope: string,
  keyValue: string
) {
  const key = Buffer.from(keyValue, "base64");
  if (key.length !== 32) throw new Error("SMTP 配置加密密钥无效");
  const [version, ivValue, tagValue, ciphertextValue, extra] =
    envelope.split(".");
  if (
    (version !== "v1" && version !== "v2") ||
    !ivValue ||
    !tagValue ||
    !ciphertextValue ||
    extra !== undefined
  ) {
    throw new Error("SMTP 密码密文格式无效");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivValue, "base64")
  );
  decipher.setAAD(
    version === "v1" ? legacyEncryptionContext : encryptionContext
  );
  decipher.setAuthTag(Buffer.from(tagValue, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64")),
    decipher.final()
  ]).toString("utf8");
}

export function encryptSmtpPassword(password: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(encryptionContext);
  const ciphertext = Buffer.concat([
    cipher.update(password, "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return [
    "v2",
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64")
  ].join(".");
}

export function decryptSmtpPassword(envelope: string) {
  return decryptSmtpPasswordWithKey(
    envelope,
    encryptionKey().toString("base64")
  );
}
