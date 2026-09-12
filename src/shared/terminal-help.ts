export const terminalHelpCodes = ["SSH_CONFIGURATION", "SSH_RECOVERY", "ACCOUNT_POLICY", "KEY_WRITE", "LOCAL_STATE", "PLATFORM_RESPONSE"] as const;
export const terminalHelpOutcomes = ["UNCHANGED", "KEYS_WITHHELD", "RESTORED", "RECOVERY_REQUIRED"] as const;
export type TerminalHelpCode = typeof terminalHelpCodes[number];
export type TerminalHelpOutcome = typeof terminalHelpOutcomes[number];
export type TerminalHelp = {
  eventId: string; code: TerminalHelpCode; scope: string; outcome: TerminalHelpOutcome;
  logPath: string; openedAt: string; acknowledgedAt: string | null;
  severity: "GENERAL" | "URGENT"; status: "OPEN" | "RESOLVED";
  resolvedAt: string | null; resolutionSource: "MACHINE" | "ADMIN" | null;
  resolvedByName: string | null;
};
const descriptions: Record<TerminalHelpCode, [string, string]> = {
  SSH_CONFIGURATION: ["SSH 配置阻止自动接管，请检查配置及服务范围。", "SSH configuration prevents automatic enrollment. Review the configuration and services."],
  SSH_RECOVERY: ["SSH 操作未完成，请检查阶段日志并处理恢复。", "An SSH operation is unfinished. Review its journal and recovery state."],
  ACCOUNT_POLICY: ["账户无法安全接管，请检查映射、排除设置或历史撤销记录。", "An account cannot be enrolled safely. Check mappings, exclusions and legacy revocations."],
  KEY_WRITE: ["公钥文件无法安全更新，请检查路径、权限和 SELinux 标签。", "Key files cannot be updated safely. Check paths, permissions and SELinux labels."],
  LOCAL_STATE: ["终端本地状态异常，请检查配置及状态文件。", "Local terminal state is invalid. Check configuration and state files."],
  PLATFORM_RESPONSE: ["平台返回的公钥数据无效，相应授权未更新。", "The platform returned invalid key data. Affected authorizations were not updated."],
};
const outcomes: Record<TerminalHelpOutcome, [string, string]> = {
  UNCHANGED: ["相关配置未修改", "Affected configuration unchanged"],
  KEYS_WITHHELD: ["新增授权暂缓，安全撤销继续", "New grants withheld; safe removals continue"],
  RESTORED: ["配置已恢复，接管仍未完成", "Configuration restored; enrollment remains incomplete"],
  RECOVERY_REQUIRED: ["恢复未完成，需要处理", "Recovery incomplete; intervention required"],
};
export function terminalHelpText(code: TerminalHelpCode, english = false) { return descriptions[code][english ? 1 : 0]; }
export function terminalHelpOutcome(outcome: TerminalHelpOutcome, english = false) { return outcomes[outcome][english ? 1 : 0]; }
