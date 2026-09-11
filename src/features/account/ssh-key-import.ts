export function containsPrivateKey(text: string): boolean {
  return /-{3,}\s*(?:BEGIN|END)\s+[A-Z0-9 ]*PRIVATE KEY\s*-{3,}/i.test(text)
    || /^\s*PuTTY-User-Key-File-\d+:/im.test(text)
    || /^\s*Private-Lines:\s*\d+/im.test(text);
}

export function shouldConfirmKeyImport(filename: string, text: string): boolean {
  return containsPrivateKey(text)
    || /\.(?:pem|key|ppk)$/i.test(filename)
    || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?$/i.test(filename);
}
