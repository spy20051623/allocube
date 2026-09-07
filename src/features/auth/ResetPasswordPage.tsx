import { tr } from "../../i18n/index";
import { useState, useEffect } from "react";
import { api, jsonBody, ApiError } from "../../api";
import { type ResetPasswordField, validateResetPasswordForm } from "../../public-auth-validation";
import { getPasswordChecks } from "../../shared/identity-rules";
import { type AuthNavigate } from "./types";
import { AuthLayout } from "./AuthLayout";
import { AuthFeedback, AuthFieldShell } from "../../components/forms";
import { PasswordChecklist, PasswordInput } from "../../components/PasswordFields";
import { BusyButtonContent } from "../../components/feedback";

type ResetPasswordFieldError = {
  source: "STATIC" | "SERVER";
  messages: string[];
};

type ResetPasswordFieldErrors = Partial<
  Record<ResetPasswordField, ResetPasswordFieldError>
>;

export function ResetPasswordPage({
  token,
  navigate
}: {
  token: string;
  navigate: AuthNavigate;
}) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [focusedField, setFocusedField] =
    useState<ResetPasswordField | null>(null);
  const [errors, setErrors] = useState<ResetPasswordFieldErrors>({});
  const [formError, setFormError] = useState("");
  const [passwordCapsLockOn, setPasswordCapsLockOn] = useState(false);
  const [linkInvalid, setLinkInvalid] = useState(!token);
  const passwordChecks = getPasswordChecks(password);

  useEffect(() => {
    setPassword("");
    setConfirmPassword("");
    setErrors({});
    setFormError("");
    setFocusedField(null);
    setLinkInvalid(!token);
  }, [token]);

  const clearFieldErrors = (...fields: ResetPasswordField[]) => {
    setErrors((current) => {
      const next = { ...current };
      let changed = false;
      for (const field of fields) {
        if (!next[field]) continue;
        delete next[field];
        changed = true;
      }
      return changed ? next : current;
    });
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!token || linkInvalid) return;
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    setFocusedField(null);
    setFormError("");

    const validationErrors = validateResetPasswordForm(
      password,
      confirmPassword
    );
    const staticErrors: ResetPasswordFieldErrors = {};
    for (const [field, messages] of Object.entries(validationErrors)) {
      staticErrors[field as ResetPasswordField] = {
        source: "STATIC",
        messages
      };
    }
    setErrors(staticErrors);
    if (Object.keys(staticErrors).length) return;

    setBusy(true);
    try {
      const result = await api<{ message: string }>("/auth/reset-password", {
        method: "POST",
        body: jsonBody({ token, password })
      });
      navigate(
        "/login",
        { authFlash: { message: result.message } },
        true
      );
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status === 400 &&
        error.code === "PASSWORD_VALIDATION_FAILED" &&
        error.fieldErrors &&
        typeof error.fieldErrors === "object" &&
        !Array.isArray(error.fieldErrors)
      ) {
        const passwordMessages = (
          error.fieldErrors as Record<string, unknown>
        ).password;
        if (
          Array.isArray(passwordMessages) &&
          passwordMessages.length > 0 &&
          passwordMessages.every(
            (message): message is string =>
              typeof message === "string" && message.trim().length > 0
          )
        ) {
          setErrors({
            password: {
              source: "SERVER",
              messages: passwordMessages
            }
          });
          return;
        }
      }
      if (
        error instanceof ApiError &&
        error.status === 400 &&
        error.code === "PASSWORD_RESET_TOKEN_INVALID"
      ) {
        setPassword("");
        setConfirmPassword("");
        setErrors({});
        setFormError("");
        setLinkInvalid(true);
        return;
      }
      setFormError(error instanceof Error ? error.message : tr("密码重置失败"));
    } finally {
      setBusy(false);
    }
  };

  if (linkInvalid) {
    return (
      <AuthLayout title={tr("设置新密码")}>
        <AuthFeedback tone="error" anchored={false}>
          {tr("重置链接无效或已经过期")}</AuthFeedback>
        <button
          type="button"
          className="primary-button wide auth-submit"
          onClick={() => navigate("/forgot-password")}
        >
          {tr("重新申请重置链接")}</button>
      </AuthLayout>
    );
  }

  const passwordError = errors.password;
  const confirmPasswordError = errors.confirmPassword;
  const passwordHintVisible =
    focusedField === "password" && !passwordCapsLockOn;

  return (
    <AuthLayout title={tr("设置新密码")}>
      <form onSubmit={submit} className="stack-form" noValidate>
        <AuthFieldShell
          id="reset-password"
          label={tr("新密码")}
          focused={focusedField === "password"}
          error={passwordError?.messages}
          hint={<PasswordChecklist checks={passwordChecks} />}
          hintClassName="password-checklist"
          errorClassName={
            passwordError?.source === "STATIC" ? "password-checklist" : ""
          }
          errorContent={
            passwordError?.source === "STATIC" ? (
              <PasswordChecklist checks={passwordChecks} />
            ) : undefined
          }
          suppressHint={passwordCapsLockOn}
        >
          <PasswordInput
            id="reset-password"
            name="newPassword"
            autoComplete="new-password"
            aria-invalid={Boolean(passwordError)}
            aria-describedby={
              focusedField !== "password" && passwordError
                ? "reset-password-error"
                : passwordHintVisible
                  ? "reset-password-hint"
                  : undefined
            }
            value={password}
            onCapsLockChange={setPasswordCapsLockOn}
            onFieldFocus={() => setFocusedField("password")}
            onFieldBlur={() =>
              setFocusedField((current) =>
                current === "password" ? null : current
              )
            }
            onChange={(event) => {
              setPassword(event.target.value);
              clearFieldErrors("password", "confirmPassword");
              setFormError("");
            }}
          />
        </AuthFieldShell>
        <AuthFieldShell
          id="reset-confirm-password"
          label={tr("确认密码")}
          focused={focusedField === "confirmPassword"}
          error={confirmPasswordError?.messages}
        >
          <PasswordInput
            id="reset-confirm-password"
            name="confirmPassword"
            autoComplete="new-password"
            aria-invalid={Boolean(confirmPasswordError)}
            aria-describedby={
              focusedField !== "confirmPassword" && confirmPasswordError
                ? "reset-confirm-password-error"
                : undefined
            }
            value={confirmPassword}
            onFieldFocus={() => setFocusedField("confirmPassword")}
            onFieldBlur={() =>
              setFocusedField((current) =>
                current === "confirmPassword" ? null : current
              )
            }
            onChange={(event) => {
              setConfirmPassword(event.target.value);
              clearFieldErrors("confirmPassword");
              setFormError("");
            }}
          />
        </AuthFieldShell>
        {formError && (
          <AuthFeedback tone="error" anchored={false}>
            {formError}
          </AuthFeedback>
        )}
        <button className="primary-button auth-submit" disabled={busy}>
          <BusyButtonContent busy={busy} iconSize={16}>
            {tr("保存新密码")}</BusyButtonContent>
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
