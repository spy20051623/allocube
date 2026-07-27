export function requestOriginMatches(
  originHeader: string | undefined,
  protocol: string,
  hostHeader: string | undefined
) {
  if (!originHeader) return true;
  if (!hostHeader || (protocol !== "http" && protocol !== "https")) return false;

  try {
    const origin = new URL(originHeader);
    if (
      (origin.protocol !== "http:" && origin.protocol !== "https:") ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    ) {
      return false;
    }
    return origin.origin === new URL(`${protocol}://${hostHeader}`).origin;
  } catch {
    return false;
  }
}
