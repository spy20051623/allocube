import { describe, expect, it } from "vitest";
import { containsPrivateKey, shouldConfirmKeyImport } from "../src/features/account/ssh-key-import";

describe("SSH key import safeguards", () => {
  it.each([
    "-----BEGIN OPENSSH PRIVATE KEY-----\nexample\n-----END OPENSSH PRIVATE KEY-----",
    "-----BEGIN RSA PRIVATE KEY-----",
    "-----BEGIN EC PRIVATE KEY-----",
    "-----BEGIN ENCRYPTED PRIVATE KEY-----",
    "-----BEGIN PRIVATE KEY-----",
    "---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----",
    "PuTTY-User-Key-File-3: ssh-ed25519\nPrivate-Lines: 1",
  ])("detects private content even with a .pub filename: %s", (text) => {
    expect(containsPrivateKey(text)).toBe(true);
    expect(shouldConfirmKeyImport("work.pub", text)).toBe(true);
  });

  it.each(["id_rsa", "id_ed25519", "id_ed25519_sk", "work.pem", "work.KEY", "work.ppk"])("warns for suspicious filename %s without treating public content as private", (filename) => {
    const text = "ssh-ed25519 AAAA public-key-comment";
    expect(shouldConfirmKeyImport(filename, text)).toBe(true);
    expect(containsPrivateKey(text)).toBe(false);
  });

  it("does not flag a normal public key or a comment mentioning private keys", () => {
    const text = "ssh-ed25519 AAAA PRIVATE KEY backup reminder";
    expect(containsPrivateKey(text)).toBe(false);
    expect(shouldConfirmKeyImport("id_ed25519.pub", text)).toBe(false);
    expect(shouldConfirmKeyImport("work.pub", "ssh-rsa AAAA work")).toBe(false);
  });
});
