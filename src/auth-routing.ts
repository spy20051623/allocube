export const authPaths = [
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password"
] as const;

export type AuthPath = (typeof authPaths)[number];

export type ResolvedAuthLocation = {
  path: AuthPath;
  resetToken: string;
  canonicalUrl: string | null;
};

const dedicatedAuthPaths = new Set<AuthPath>(authPaths);

export function resolveAuthLocation(
  pathname: string,
  _search: string,
  hash = ""
): ResolvedAuthLocation {
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  const params = new URLSearchParams(fragment);
  if (dedicatedAuthPaths.has(pathname as AuthPath)) {
    const path = pathname as AuthPath;
    return {
      path,
      resetToken: path === "/reset-password" ? params.get("token") ?? "" : "",
      canonicalUrl: null
    };
  }
  return {
    path: "/login",
    resetToken: "",
    canonicalUrl: "/login"
  };
}
