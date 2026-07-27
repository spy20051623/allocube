import { Algorithm, hash, verify } from "@node-rs/argon2";

const PASSWORD_HASH_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1
} as const;

export function hashPassword(password: string) {
  return hash(password, PASSWORD_HASH_OPTIONS);
}

export async function checkPassword(hashValue: string, password: string) {
  try {
    return await verify(hashValue, password);
  } catch {
    return false;
  }
}
