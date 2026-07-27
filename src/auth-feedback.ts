export function verificationCooldownSeconds(
  availableAt: number | null,
  now = Date.now()
) {
  if (!availableAt) return 0;
  return Math.max(0, Math.ceil((availableAt - now) / 1000));
}

export function verificationButtonLabel({
  sending,
  remainingSeconds
}: {
  sending: boolean;
  remainingSeconds: number;
}) {
  if (sending) return "发送中…";
  if (remainingSeconds > 0) return `${remainingSeconds}秒`;
  return "获取验证码";
}
