import { tr } from "../../i18n/index";
import { ShieldCheck, Mail } from "lucide-react";
import { useState, useEffect } from "react";
import { api, jsonBody } from "../../api";
import { validateForgotPasswordEmail } from "../../public-auth-validation";
import { type AuthNavigate } from "./types";
import { type RegistrationConfigPayload } from "../../shared/settings";
import { AuthLayout } from "./AuthLayout";
import { AuthFeedback, AuthFieldShell } from "../../components/forms";
import { BusyButtonContent } from "../../components/feedback";

export function ForgotPasswordPage({
  navigate
}: {
  navigate: AuthNavigate;
}) {
  const [registrationConfig, setRegistrationConfig] =
    useState<RegistrationConfigPayload | null>(null);
  const [configError, setConfigError] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);
  const [emailErrors, setEmailErrors] = useState<string[]>([]);
  const [formError, setFormError] = useState("");
  const [sent, setSent] = useState(false);

  useEffect(() => {
    let active = true;
    void api<RegistrationConfigPayload>("/auth/registration-config")
      .then((result) => {
        if (active) setRegistrationConfig(result);
      })
      .catch(() => {
        if (active) {
          setConfigError(tr("暂时无法加载邮件设置，请刷新页面重试。"));
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!registrationConfig?.emailEnabled) return;
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    setFocused(false);
    setFormError("");
    const staticErrors = validateForgotPasswordEmail(email);
    setEmailErrors(staticErrors);
    if (staticErrors.length) return;

    setBusy(true);
    try {
      await api<{ message: string }>("/auth/forgot-password", {
        method: "POST",
        body: jsonBody({ email })
      });
      setSent(true);
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : tr("重置邮件发送失败")
      );
    } finally {
      setBusy(false);
    }
  };

  if (registrationConfig && !registrationConfig.emailEnabled) {
    return (
      <AuthLayout title={tr("找回密码")}>
        <div className="registration-success">
          <div className="success-mark"><ShieldCheck size={24} /></div>
          <p>{tr("邮件功能未启用，请联系系统管理员获取密码重置链接。")}</p>
          <button
            type="button"
            className="primary-button wide auth-submit"
            onClick={() => navigate("/login")}
          >
            {tr("返回登录")}</button>
        </div>
      </AuthLayout>
    );
  }

  if (sent) {
    return (
      <AuthLayout title={tr("重置邮件已发送")}>
        <div className="registration-success">
          <div className="success-mark"><Mail size={24} /></div>
          <p>{tr("如果该邮箱已绑定有效账号，你将收到密码重置邮件。")}</p>
          <button
            type="button"
            className="primary-button wide auth-submit"
            onClick={() => navigate("/login")}
          >
            {tr("返回登录")}</button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={tr("找回密码")}>
      <form onSubmit={submit} className="stack-form" noValidate>
        {configError && (
          <AuthFeedback tone="error" anchored={false}>
            {configError}
          </AuthFeedback>
        )}
        <AuthFieldShell
          id="forgot-password-email"
          label={tr("邮箱")}
          focused={focused}
          error={emailErrors}
        >
          <input
            id="forgot-password-email"
            name="email"
            type="email"
            autoComplete="email"
            aria-invalid={emailErrors.length > 0}
            aria-describedby={
              !focused && emailErrors.length
                ? "forgot-password-email-error"
                : undefined
            }
            value={email}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onChange={(event) => {
              setEmail(event.target.value);
              setEmailErrors([]);
              setFormError("");
            }}
          />
        </AuthFieldShell>
        {formError && (
          <AuthFeedback tone="error" anchored={false}>
            {formError}
          </AuthFeedback>
        )}
        <button
          className="primary-button auth-submit"
          disabled={busy || !registrationConfig || Boolean(configError)}
        >
          <BusyButtonContent busy={busy} iconSize={16}>
            {tr("发送重置邮件")}</BusyButtonContent>
        </button>
      </form>
      <button
        type="button"
        className="text-button auth-alt"
        onClick={() => navigate("/login")}
      >
        {tr("返回登录")}</button>
    </AuthLayout>
  );
}
