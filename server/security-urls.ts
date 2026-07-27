export function buildPasswordResetUrl(appOrigin: string, token: string) {
  const url = new URL("/reset-password", appOrigin);
  url.hash = new URLSearchParams({ token }).toString();
  return url.toString();
}
