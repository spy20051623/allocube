import { tr } from "../../i18n/index";
import { Check, CircleAlert } from "lucide-react";
import { useState, useRef, useCallback, useEffect } from "react";
import { api, jsonBody, ApiError } from "../../api";
import { verificationCooldownSeconds, verificationButtonLabel } from "../../auth-feedback";
import { rememberUsername } from "../../login-preference";
import {
  type RegistrationField,
  type RegistrationFormValues,
  normalizeRegistrationEmail,
  validateRegistrationField,
  registrationFieldValue,
  type RegistrationFieldErrors,
  isServerRegistrationField,
  validateRegistrationForm,
  registrationFields,
  parseServerRegistrationErrors,
  validateEmail
} from "../../registration-validation";
import { getPasswordChecks } from "../../shared/identity-rules";
import { AuthFeedback } from "../../components/forms";
import { PasswordChecklist, PasswordInput } from "../../components/PasswordFields";
import { type AuthNavigate } from "./types";
import { useAppDialog } from "../../components/dialogs";
import { type RegistrationConfigPayload } from "../../shared/settings";
import { AuthLayout } from "./AuthLayout";
import { BusyButtonContent } from "../../components/feedback";

type RegistrationErrorState = {
  source: "STATIC" | "SERVER";
  value: string;
  messages: string[];
};

type RegistrationErrorMap = Partial<
  Record<RegistrationField, RegistrationErrorState>
>;

function RegistrationFieldShell({
  field,
  label,
  focused,
  error,
  hint,
  passwordChecks,
  suppressHint = false,
  children
}: {
  field: RegistrationField;
  label: string;
  focused: boolean;
  error?: RegistrationErrorState;
  hint?: string;
  passwordChecks?: ReturnType<typeof getPasswordChecks>;
  suppressHint?: boolean;
  children: React.ReactNode;
}) {
  const showHint =
    focused &&
    !suppressHint &&
    (Boolean(hint) || Boolean(passwordChecks));
  const showError = !focused && Boolean(error);
  const bubbleId = `register-${field}-${showError ? "error" : "hint"}`;
  const showPasswordChecklist =
    field === "password" && passwordChecks && (showHint || showError);
  return (
    <div
      className={`field registration-field${showError ? " has-error" : ""}`}
    >
      <label htmlFor={`register-${field}`}>{label}</label>
      {children}
      {(showHint || showError) && (
        <AuthFeedback
          id={bubbleId}
          tone={showError ? "error" : "hint"}
          className={showPasswordChecklist ? "password-checklist" : ""}
        >
          {showPasswordChecklist ? (
            <PasswordChecklist checks={passwordChecks} />
          ) : showError ? (
            error!.messages.length === 1 ? (
              error!.messages[0]
            ) : (
              <ul>
                {error!.messages.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            )
          ) : (
            hint
          )}
        </AuthFeedback>
      )}
    </div>
  );
}

export function RegisterPage({
  notify,
  navigate,
  successUsername
}: {
  notify: (kind: "success" | "error", message: string) => void;
  navigate: AuthNavigate;
  successUsername: string;
}) {
  const dialog = useAppDialog();
  const [submitting, setSubmitting] = useState(false);
  const [codeSending, setCodeSending] = useState(false);
  const [focusedField, setFocusedField] = useState<RegistrationField | null>(
    null
  );
  const [errors, setErrors] = useState<RegistrationErrorMap>({});
  const [announcement, setAnnouncement] = useState("");
  const [passwordCapsLockOn, setPasswordCapsLockOn] = useState(false);
  const [focusCodeAfterSend, setFocusCodeAfterSend] = useState(false);
  const [resendAvailableAt, setResendAvailableAt] = useState<number | null>(null);
  const [resendSeconds, setResendSeconds] = useState(0);
  const [registrationConfig, setRegistrationConfig] =
    useState<RegistrationConfigPayload | null>(null);
  const [configError, setConfigError] = useState(false);
  const codeInputRef = useRef<HTMLInputElement | null>(null);
  const [form, setForm] = useState<RegistrationFormValues>({
    username: "",
    realName: "",
    employeeNumber: "",
    email: "",
    challengeId: "",
    challengeEmail: "",
    code: "",
    password: "",
    confirmPassword: ""
  });

  const loadRegistrationConfig = useCallback(async () => {
    const result = await api<RegistrationConfigPayload>(
      "/auth/registration-config"
    );
    if (
      typeof result.emailEnabled !== "boolean" ||
      typeof result.allowRegistrationWithoutEmail !== "boolean" ||
      !Number.isInteger(result.revision) ||
      !Array.isArray(result.allowedEmailDomains) ||
      !result.allowedEmailDomains.every(
        (domain) => typeof domain === "string"
      )
    ) {
      throw new Error(tr("注册配置格式不正确"));
    }
    setRegistrationConfig({
      ...result,
      allowedEmailDomains: result.allowedEmailDomains.map((domain) =>
        domain.toLowerCase()
      )
    });
    if (!result.emailEnabled) {
      setErrors((current) => {
        if (!current.email && !current.code) return current;
        const next = { ...current };
        delete next.email;
        delete next.code;
        return next;
      });
    }
    setConfigError(false);
  }, []);

  useEffect(() => {
    let active = true;
    void loadRegistrationConfig().catch(() => {
      if (active) setConfigError(true);
    });
    return () => {
      active = false;
    };
  }, [loadRegistrationConfig]);

  const allowedEmailDomains =
    registrationConfig?.allowedEmailDomains ?? null;
  const emailEnabled = registrationConfig?.emailEnabled ?? false;
  const allowEmptyEmail =
    registrationConfig?.allowRegistrationWithoutEmail ?? true;

  const passwordChecks = getPasswordChecks(form.password, {
    username: form.username,
    employeeNumbers: [form.employeeNumber]
  });
  const codeEnabled =
    emailEnabled &&
    Boolean(form.challengeId) &&
    form.challengeEmail === normalizeRegistrationEmail(form.email);

  useEffect(() => {
    if (!focusCodeAfterSend || !codeEnabled) return;
    codeInputRef.current?.focus();
    setFocusedField("code");
    setFocusCodeAfterSend(false);
  }, [codeEnabled, focusCodeAfterSend]);

  useEffect(() => {
    if (!resendAvailableAt) {
      setResendSeconds(0);
      return;
    }
    const updateCountdown = () => {
      const remaining = verificationCooldownSeconds(resendAvailableAt);
      setResendSeconds(remaining);
      if (remaining === 0) setResendAvailableAt(null);
    };
    updateCountdown();
    const intervalId = window.setInterval(updateCountdown, 250);
    return () => window.clearInterval(intervalId);
  }, [resendAvailableAt]);

  const showBubbleFor = (field: RegistrationField, hasHint: boolean) =>
    focusedField === field
      ? hasHint
        ? `register-${field}-hint`
        : undefined
      : errors[field]
        ? `register-${field}-error`
        : undefined;

  const inputAccessibility = (field: RegistrationField, hasHint = false) => ({
    id: `register-${field}`,
    "aria-invalid": Boolean(errors[field]),
    "aria-describedby": showBubbleFor(field, hasHint)
  });

  const announceErrors = () => {
    setAnnouncement("");
    window.requestAnimationFrame(() => setAnnouncement(tr("请检查标出的内容")));
  };

  const validateOnBlur = (field: RegistrationField) => {
    setFocusedField((current) => (current === field ? null : current));
    if (!allowedEmailDomains || !registrationConfig) return;
    const messages = validateRegistrationField(
      field,
      form,
      allowedEmailDomains,
      emailEnabled,
      allowEmptyEmail
    );
    const value = registrationFieldValue(field, form);
    setErrors((current) => {
      if (messages.length) {
        return {
          ...current,
          [field]: { source: "STATIC", value, messages }
        };
      }
      const existing = current[field];
      if (
        existing?.source === "SERVER" &&
        existing.value === value
      ) {
        return current;
      }
      if (!existing) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  };

  const updateFormField = (
    field: Exclude<
      RegistrationField,
      "code" | "confirmPassword"
    >,
    value: string
  ) => {
    if (field === "email") {
      const normalizedEmail = normalizeRegistrationEmail(value);
      const emailChanged =
        normalizedEmail !== normalizeRegistrationEmail(form.email);
      const invalidatesChallenge =
        Boolean(form.challengeId) &&
        normalizedEmail !== form.challengeEmail;

      if (emailChanged) {
        setFocusCodeAfterSend(false);
        setErrors((current) => {
          if (!current.code) return current;
          const next = { ...current };
          delete next.code;
          return next;
        });
      }

      setForm((current) => ({
        ...current,
        email: value,
        ...(invalidatesChallenge
          ? { challengeId: "", challengeEmail: "", code: "" }
          : {})
      }));
      return;
    }

    setForm((current) => {
      return { ...current, [field]: value };
    });
  };

  const applyServerErrors = (fieldErrors: RegistrationFieldErrors) => {
    const next: RegistrationErrorMap = {};
    for (const [field, messages] of Object.entries(fieldErrors)) {
      if (!isServerRegistrationField(field) || !messages?.length) continue;
      next[field] = {
        source: "SERVER",
        value: registrationFieldValue(field, form),
        messages
      };
    }
    setErrors(next);
    announceErrors();
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!allowedEmailDomains || !registrationConfig || configError) return;
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    setFocusedField(null);
    const staticErrors = validateRegistrationForm(
      form,
      allowedEmailDomains,
      emailEnabled,
      allowEmptyEmail
    );
    if (Object.keys(staticErrors).length) {
      setErrors((current) => {
        const next: RegistrationErrorMap = {};
        for (const field of registrationFields) {
          const messages = staticErrors[field];
          if (messages?.length) {
            next[field] = {
              source: "STATIC",
              value: registrationFieldValue(field, form),
              messages
            };
            continue;
          }
          const existing = current[field];
          if (
            existing?.source === "SERVER" &&
            existing.value === registrationFieldValue(field, form)
          ) {
            next[field] = existing;
          }
        }
        return next;
      });
      announceErrors();
      return;
    }

    const normalizedEmail = normalizeRegistrationEmail(form.email);
    let withoutEmailConfirmed = false;
    if (emailEnabled && allowEmptyEmail && !normalizedEmail) {
      withoutEmailConfirmed = await dialog.confirm({
        title: tr("不填写邮箱？"),
        message:
          tr("不填写邮箱将无法接收系统邮件提醒，也无法自行通过邮件找回密码。"),
        confirmLabel: tr("仍然提交")
      });
      if (!withoutEmailConfirmed) return;
    }

    setSubmitting(true);
    try {
      await api<{ message: string }>("/auth/register", {
        method: "POST",
        body: jsonBody({
          username: form.username,
          realName: form.realName,
          employeeNumber: form.employeeNumber,
          email: emailEnabled ? normalizedEmail || null : null,
          challengeId:
            emailEnabled && normalizedEmail ? form.challengeId : null,
          code: emailEnabled && normalizedEmail ? form.code : null,
          password: form.password,
          expectedConfigRevision: registrationConfig.revision,
          withoutEmailConfirmed
        })
      });
      const username = form.username.trim().normalize("NFKC");
      rememberUsername(username, true);
      setForm({
        username: "",
        realName: "",
        employeeNumber: "",
        email: "",
        challengeId: "",
        challengeEmail: "",
        code: "",
        password: "",
        confirmPassword: ""
      });
      setErrors({});
      navigate(
        "/register",
        { registrationSuccess: { username } },
        true
      );
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.code === "REGISTRATION_CONFIG_CHANGED" ||
          error.code === "EMAIL_FEATURE_DISABLED")
      ) {
        try {
          await loadRegistrationConfig();
          notify("error", tr("注册规则已更新，请按当前页面重新确认后提交"));
        } catch {
          setConfigError(true);
        }
        return;
      }
      if (
        error instanceof ApiError &&
        (error.status === 400 || error.status === 409) &&
        error.code === "REGISTRATION_VALIDATION_FAILED"
      ) {
        const fieldErrors = parseServerRegistrationErrors(error.fieldErrors);
        if (fieldErrors) {
          applyServerErrors(fieldErrors);
          return;
        }
      }
      notify("error", error instanceof Error ? error.message : tr("注册提交失败"));
    } finally {
      setSubmitting(false);
    }
  };

  const requestCode = async () => {
    if (
      !emailEnabled ||
      !allowedEmailDomains ||
      codeSending ||
      resendSeconds > 0
    ) {
      return;
    }
    const emailErrors = validateEmail(form.email, allowedEmailDomains);
    if (emailErrors.length) {
      setErrors((current) => ({
        ...current,
        email: {
          source: "STATIC",
          value: registrationFieldValue("email", form),
          messages: emailErrors
        }
      }));
      return;
    }
    setCodeSending(true);
    try {
      const result = await api<{
        challengeId: string;
        expiresAt: string;
      }>("/auth/registration-email-code", {
        method: "POST",
        body: jsonBody({ email: form.email })
      });
      const challengeEmail = normalizeRegistrationEmail(form.email);
      setForm((current) => ({
        ...current,
        challengeId: result.challengeId,
        challengeEmail,
        code: ""
      }));
      setFocusCodeAfterSend(true);
      setResendAvailableAt(Date.now() + 60_000);
      setResendSeconds(60);
      setErrors((current) => {
        if (!current.email) return current;
        const next = { ...current };
        delete next.email;
        return next;
      });
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.code === "EMAIL_FEATURE_DISABLED"
      ) {
        try {
          await loadRegistrationConfig();
        } catch {
          setConfigError(true);
        }
        return;
      }
      if (error instanceof ApiError && (error.status === 400 || error.status === 409)) {
        const fieldErrors = parseServerRegistrationErrors(error.fieldErrors);
        if (fieldErrors?.email) {
          setErrors((current) => ({
            ...current,
            email: {
              source: "SERVER",
              value: registrationFieldValue("email", form),
              messages: fieldErrors.email!
            }
          }));
          return;
        }
      }
      notify("error", error instanceof Error ? error.message : tr("验证码发送失败"));
    } finally {
      setCodeSending(false);
    }
  };

  if (successUsername) {
    return (
      <AuthLayout title={tr("注册申请已提交")}>
        <div className="registration-success">
          <div className="success-mark"><Check size={24} /></div>
          <p>{tr("注册审核通过前请使用用户名登录。")}</p>
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

  const emailHasHint = Boolean(allowedEmailDomains?.length);
  const emailHint = emailHasHint
    ? tr("仅允许以下邮箱域名：{{v0}}", { v0: allowedEmailDomains!.join("、") })
    : undefined;
  const emailIsValid =
    emailEnabled &&
    allowedEmailDomains !== null &&
    Boolean(form.email.trim()) &&
    validateEmail(form.email, allowedEmailDomains).length === 0;
  const emailHasCurrentServerError =
    errors.email?.source === "SERVER" &&
    errors.email.value === registrationFieldValue("email", form);
  const codeButtonLabel = verificationButtonLabel({
    sending: codeSending,
    remainingSeconds: resendSeconds
  });

  return (
    <AuthLayout
      title={tr("用户注册")}
    >
      <form onSubmit={submit} className="stack-form" noValidate>
        <RegistrationFieldShell
          field="username"
          label={tr("用户名")}
          focused={focusedField === "username"}
          error={errors.username}
          hint={tr("2–32个字符，支持中文。")}
        >
          <input
            {...inputAccessibility("username", true)}
            name="username"
            autoComplete="username"
            value={form.username}
            onFocus={() => setFocusedField("username")}
            onBlur={() => validateOnBlur("username")}
            onChange={(event) => updateFormField("username", event.target.value)}
          />
        </RegistrationFieldShell>
        <div className="two-fields auth-two-fields">
          <RegistrationFieldShell
            field="realName"
            label={tr("姓名")}
            focused={focusedField === "realName"}
            error={errors.realName}
          >
            <input
              {...inputAccessibility("realName")}
              name="realName"
              autoComplete="name"
              value={form.realName}
              onFocus={() => setFocusedField("realName")}
              onBlur={() => validateOnBlur("realName")}
              onChange={(event) => updateFormField("realName", event.target.value)}
            />
          </RegistrationFieldShell>
          <RegistrationFieldShell
            field="employeeNumber"
            label={tr("工号")}
            focused={focusedField === "employeeNumber"}
            error={errors.employeeNumber}
          >
            <input
              {...inputAccessibility("employeeNumber")}
              name="employeeNumber"
              autoComplete="username"
              value={form.employeeNumber}
              onFocus={() => setFocusedField("employeeNumber")}
              onBlur={() => validateOnBlur("employeeNumber")}
              onChange={(event) =>
                updateFormField("employeeNumber", event.target.value.toLowerCase())
              }
            />
          </RegistrationFieldShell>
        </div>
        {emailEnabled && (
          <>
            <RegistrationFieldShell
              field="email"
              label={allowEmptyEmail ? tr("邮箱（选填）") : tr("邮箱")}
              focused={focusedField === "email"}
              error={errors.email}
              hint={emailHint}
            >
              <input
                {...inputAccessibility("email", emailHasHint)}
                name="email"
                type="email"
                disabled={codeSending}
                autoComplete="email"
                value={form.email}
                onFocus={() => setFocusedField("email")}
                onBlur={() => validateOnBlur("email")}
                onChange={(event) => updateFormField("email", event.target.value)}
              />
            </RegistrationFieldShell>
            <div className="verification-row">
              <RegistrationFieldShell
                field="code"
                label={tr("邮箱验证码")}
                focused={focusedField === "code"}
                error={errors.code}
              >
                <input
                  {...inputAccessibility("code")}
                  name="code"
                  ref={codeInputRef}
                  disabled={!codeEnabled}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={form.code}
                  onFocus={() => setFocusedField("code")}
                  onBlur={() => validateOnBlur("code")}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      code: event.target.value.replace(/\D/g, "")
                    }))
                  }
                />
              </RegistrationFieldShell>
              <button
                type="button"
                className="secondary-button verification-button"
                disabled={
                  submitting ||
                  codeSending ||
                  resendSeconds > 0 ||
                  configError ||
                  !emailIsValid ||
                  emailHasCurrentServerError
                }
                onClick={() => void requestCode()}
              >
                {codeButtonLabel}
              </button>
            </div>
          </>
        )}
        <RegistrationFieldShell
          field="password"
          label={tr("密码")}
          focused={focusedField === "password"}
          error={errors.password}
          passwordChecks={passwordChecks}
          suppressHint={passwordCapsLockOn}
        >
          <PasswordInput
            {...inputAccessibility("password", true)}
            name="password"
            autoComplete="new-password"
            value={form.password}
            onCapsLockChange={setPasswordCapsLockOn}
            onFieldFocus={() => setFocusedField("password")}
            onFieldBlur={() => validateOnBlur("password")}
            onChange={(event) => updateFormField("password", event.target.value)}
          />
        </RegistrationFieldShell>
        <RegistrationFieldShell
          field="confirmPassword"
          label={tr("确认密码")}
          focused={focusedField === "confirmPassword"}
          error={errors.confirmPassword}
        >
          <PasswordInput
            {...inputAccessibility("confirmPassword")}
            name="confirmPassword"
            autoComplete="new-password"
            value={form.confirmPassword}
            onFieldFocus={() => setFocusedField("confirmPassword")}
            onFieldBlur={() => validateOnBlur("confirmPassword")}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                confirmPassword: event.target.value
              }))
            }
          />
        </RegistrationFieldShell>
        {configError && (
          <div className="inline-message error">
            <CircleAlert size={16} />
            {tr("暂时无法加载注册规则，请刷新页面重试。")}</div>
        )}
        <div className="sr-only" aria-live="assertive">{announcement}</div>
        <button
          className="primary-button auth-submit"
          disabled={
            submitting ||
            codeSending ||
            configError ||
            registrationConfig === null
          }
        >
          <BusyButtonContent busy={submitting} iconSize={16}>
            {tr("提交注册")}</BusyButtonContent>
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
