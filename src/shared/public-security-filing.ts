const PUBLIC_SECURITY_FILING_PATTERN =
  /^[京津冀晋蒙辽吉黑沪苏浙皖闽赣鲁豫鄂湘粤桂琼渝川贵云藏陕甘青宁新]公网安备 (\d{14})号$/;

export function publicSecurityFilingValidationError(value: string) {
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > 100) return "公安备案号不能超过100个字符";
  if (!PUBLIC_SECURITY_FILING_PATTERN.test(normalized)) {
    return "请输入正确的公安备案号，如：省公网安备 11000000000000号（请将“省”替换为省份简称）";
  }
  return null;
}

export function publicSecurityFilingCode(value: string) {
  return value.trim().match(PUBLIC_SECURITY_FILING_PATTERN)?.[1] ?? "";
}

export function publicSecurityFilingUrl(value: string) {
  const code = publicSecurityFilingCode(value);
  return code
    ? `https://beian.mps.gov.cn/#/query/webSearch?code=${code}`
    : "";
}
