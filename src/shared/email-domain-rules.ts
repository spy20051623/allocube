const DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const EMAIL_DOMAIN_MESSAGE =
  "请输入合法邮箱域名，例如 company.com";

export function normalizeAllowedEmailDomain(value: string) {
  const normalized = value.trim().normalize("NFKC").toLowerCase();
  if (
    normalized.length < 3 ||
    normalized.length > 253 ||
    normalized.startsWith(".") ||
    normalized.endsWith(".") ||
    normalized.includes("..")
  ) {
    throw new Error(EMAIL_DOMAIN_MESSAGE);
  }
  const labels = normalized.split(".");
  if (
    labels.length < 2 ||
    labels.some(
      (label) => label.length > 63 || !DOMAIN_LABEL_PATTERN.test(label)
    )
  ) {
    throw new Error(EMAIL_DOMAIN_MESSAGE);
  }
  return normalized;
}

export function normalizeAllowedEmailDomains(values: string[]) {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const domain = normalizeAllowedEmailDomain(value);
    if (seen.has(domain)) continue;
    seen.add(domain);
    normalized.push(domain);
  }
  return normalized;
}
