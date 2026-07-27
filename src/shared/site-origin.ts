const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function siteOriginValidationError(
  rawValue: string,
  allowLocalHttp = false
): string | null {
  const value = rawValue.trim();
  if (!value) return "请输入站点地址";
  if (value.length > 2048) return "站点地址过长";

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "请输入有效的站点地址";
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "站点地址必须使用 HTTPS";
  }
  const localHttpAllowed =
    allowLocalHttp &&
    url.protocol === "http:" &&
    LOCAL_HOSTNAMES.has(url.hostname);
  if (url.protocol !== "https:" && !localHttpAllowed) {
    return "站点地址必须使用 HTTPS";
  }
  if (url.username || url.password) {
    return "站点地址不能包含账号信息";
  }
  if (
    url.hostname === "example.com" ||
    url.hostname.endsWith(".example.com")
  ) {
    return "请将示例域名替换为实际站点地址";
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    return "站点地址不能包含路径、查询参数或片段";
  }
  return null;
}

export function normalizeSiteOrigin(
  rawValue: string,
  allowLocalHttp = false
) {
  const issue = siteOriginValidationError(rawValue, allowLocalHttp);
  if (issue) throw new Error(issue);
  return new URL(rawValue.trim()).origin;
}
