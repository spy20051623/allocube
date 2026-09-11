export type TerminalArchitecture = "amd64" | "arm64";
export type TerminalRelease = { architecture: TerminalArchitecture; sha256: string; path: string; size: number; format: "deployment-tar-v1"; caCertificate?: string; caSha256?: string };
export type TerminalEnrollment = { terminalId: string; enrollmentToken: string; platformOrigin: string; expiresIn: number };

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function terminalInstallCommand(enrollment: TerminalEnrollment, release: TerminalRelease) {
  const origin = new URL(enrollment.platformOrigin);
  if (origin.protocol !== "https:" || origin.origin !== enrollment.platformOrigin ||
      !/^[a-f0-9]{64}$/.test(release.sha256) || !["amd64", "arm64"].includes(release.architecture) ||
      release.path !== `/api/v1/terminal/downloads/${release.architecture}/${release.sha256}/allocube-deploy-linux-${release.architecture}.tar.gz` ||
      !/^[a-zA-Z0-9_-]{32,128}$/.test(enrollment.enrollmentToken) ||
      !/^[a-f0-9-]{36}$/.test(enrollment.terminalId)) throw new Error("接入安装信息无效");
  const certificate = release.caCertificate?.trim();
  if (certificate && (certificate.length > 65536 || !/^(?:-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\r\n]+\n-----END CERTIFICATE-----\s*)+$/.test(certificate))) throw new Error("平台接入证书无效");
  if (release.format !== "deployment-tar-v1") throw new Error("部署包版本无效，请刷新页面");
  return [
    `ALLOCUBE_PLATFORM=${quote(origin.origin)} \\`,
    `ALLOCUBE_TERMINAL_ID=${quote(enrollment.terminalId)} \\`,
    `ALLOCUBE_ENROLL_TOKEN=${quote(enrollment.enrollmentToken)} \\`,
    ...(certificate ? [`ALLOCUBE_CA_CERT=${quote(btoa(certificate + "\n"))} \\`] : []),
    "bash ./install.sh",
  ].join("\n");
}
