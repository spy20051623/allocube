const ICP_FILING_PATTERN =
  /^[京津冀晋蒙辽吉黑沪苏浙皖闽赣鲁豫鄂湘粤桂琼渝川贵云藏陕甘青宁新]ICP备\d{6,20}号-\d+$/;

export function icpFilingValidationError(value: string) {
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > 100) return "ICP备案号不能超过100个字符";
  if (!ICP_FILING_PATTERN.test(normalized)) {
    return "请输入正确的ICP备案号，如：省ICP备12345678号-1（请将“省”替换为省份简称）";
  }
  return null;
}
