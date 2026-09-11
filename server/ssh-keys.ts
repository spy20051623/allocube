import { createHash, createPublicKey, ECDH } from "node:crypto";
import { db } from "./db.js";
import { IdentityError } from "./identity.js";

// Accept a single ordinary public key, never authorized_keys options or certificates.
export function parsePersonalKey(input: string) {
  const text = input.trim();
  if (text.length > 4096 || /[\r\n\x00-\x08\x0b-\x1f\x7f]/.test(text))
    throw new IdentityError("请提供一行 SSH 公钥", 400);
  const match =
    /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) +([A-Za-z0-9+/]+={0,2})(?: +(.*))?$/.exec(
      text,
    );
  if (!match)
    throw new IdentityError(
      "支持 Ed25519、RSA 和 ECDSA 公钥，不接受私钥、证书或限制选项",
      400,
    );
  try {
    const blob = Buffer.from(match[2], "base64");
    if (
      blob.toString("base64").replace(/=+$/, "") !== match[2].replace(/=+$/, "")
    )
      throw Error();
    let offset = 0;
    const field = () => {
      if (offset + 4 > blob.length) throw Error();
      const size = blob.readUInt32BE(offset);
      offset += 4;
      if (size > blob.length - offset) throw Error();
      const value = blob.subarray(offset, offset + size);
      offset += size;
      return value;
    };
    if (field().toString() !== match[1]) throw Error();
    if (match[1] === "ssh-ed25519") {
      const key = field();
      if (key.length !== 32) throw Error();
      createPublicKey({
        key: { kty: "OKP", crv: "Ed25519", x: key.toString("base64url") },
        format: "jwk",
      });
    } else if (match[1] === "ssh-rsa") {
      const integer = () => {
        const b = field();
        if (
          !b.length ||
          b[0] & 128 ||
          (b[0] === 0 && (b.length === 1 || !(b[1] & 128)))
        )
          throw Error();
        return b[0] === 0 ? b.subarray(1) : b;
      };
      const e = integer(),
        n = integer();
      const bits = (n.length - 1) * 8 + (32 - Math.clz32(n[0]));
      const exponent = BigInt("0x" + e.toString("hex"));
      if (
        bits < 2048 ||
        bits > 8192 ||
        exponent < 3n ||
        exponent % 2n === 0n ||
        exponent > 0xffffffffn
      )
        throw Error();
      createPublicKey({
        key: {
          kty: "RSA",
          e: e.toString("base64url"),
          n: n.toString("base64url"),
        },
        format: "jwk",
      });
    } else {
      const curve = field().toString();
      if (match[1] !== "ecdsa-sha2-" + curve) throw Error();
      const names: Record<string, string> = {
        nistp256: "prime256v1",
        nistp384: "secp384r1",
        nistp521: "secp521r1",
      };
      const point = field();
      // SSH's Go parser requires SEC1 uncompressed points. OpenSSL also accepts
      // compressed/hybrid points, so curve validation alone is not sufficient.
      const size: Record<string, number> = { nistp256: 65, nistp384: 97, nistp521: 133 };
      if (point[0] !== 4 || point.length !== size[curve]) throw Error();
      ECDH.convertKey(point, names[curve]);
    }
    if (offset !== blob.length) throw Error();
    return {
      publicKey: `${match[1]} ${blob.toString("base64")}${match[3] ? " " + match[3] : ""}`,
      fingerprint:
        "SHA256:" +
        createHash("sha256").update(blob).digest("base64").replace(/=+$/, ""),
    };
  } catch {
    throw new IdentityError("SSH 公钥内容无效，RSA 至少需要 2048 位", 400);
  }
}
export function personalKeys(userId: string) {
  return db
    .prepare(
      "SELECT k.id,k.name,k.public_key AS publicKey,k.fingerprint,k.created_at AS createdAt,(SELECT COUNT(*) FROM machine_ssh_keys a WHERE a.key_id=k.id) AS activeMachineCount FROM user_ssh_keys k WHERE k.user_id=? ORDER BY k.fingerprint",
    )
    .all(userId);
}

export function activeMachineKeys(userId: string, machineId: string) {
  return db
    .prepare(
      "SELECT k.id,k.name,k.public_key AS publicKey,k.fingerprint,k.created_at AS createdAt FROM user_ssh_keys k JOIN machine_ssh_keys a ON a.key_id=k.id AND a.user_id=k.user_id WHERE k.user_id=? AND a.machine_id=? ORDER BY k.fingerprint",
    )
    .all(userId, machineId);
}
