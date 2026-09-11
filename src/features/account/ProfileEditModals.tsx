import { Modal } from "../../Modal";
import { tr } from "../../i18n/index";
import { useState, useRef, useCallback, useEffect } from "react";
import { api, jsonBody, ApiError } from "../../api";
import { verificationCooldownSeconds, verificationButtonLabel } from "../../auth-feedback";
import { normalizeRegistrationEmail, validateEmail } from "../../registration-validation";
import { isEmployeeNumberValid, EMPLOYEE_NUMBER_MESSAGE } from "../../shared/identity-rules";
import { fieldErrorFromApi } from "../../api-errors";
import { AuthFeedback } from "../../components/forms";
import { BusyButtonContent } from "../../components/feedback";
import { type RegistrationConfigPayload } from "../../shared/settings";
import { PasswordInput } from "../../components/PasswordFields";

function profileUsernameError(value: string, currentUsername: string) {
  const username = value.trim().normalize("NFKC");
  const length = Array.from(username).length;
  if (length < 2 || length > 32) return tr("用户名必须为 2–32 个字符");
  const edge = "[\\p{Script=Han}A-Za-z0-9]";
  const body = "[\\p{Script=Han}A-Za-z0-9._-]";
  if (!new RegExp(`^${edge}${body}*${edge}$`, "u").test(username)) {
    return tr("用户名仅支持中文、字母、数字、点、下划线和短横线，且首尾须为文字或数字");
  }
  if (username.toLocaleLowerCase("zh-CN") === "administrator") {
    return tr("该用户名为系统保留名称");
  }
  if (
    username.toLocaleLowerCase("zh-CN") ===
    currentUsername.normalize("NFKC").toLocaleLowerCase("zh-CN")
  ) {
    return tr("新用户名与当前用户名相同");
  }
  return "";
}

export function UsernameEditModal({
  currentUsername,
  onClose,
  onSaved
}: {
  currentUsername: string;
  onClose: () => void;
  onSaved: (username: string) => Promise<void>;
}) {
  const [username, setUsername] = useState(currentUsername);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const staticError = profileUsernameError(username, currentUsername);
    setError(staticError);
    if (staticError) return;
    setBusy(true);
    try {
      await api("/auth/change-username", {
        method: "POST",
        body: jsonBody({ username })
      });
      await onSaved(username.trim().normalize("NFKC"));
    } catch (caught) {
      const fieldError = fieldErrorFromApi(caught, "username");
      if (fieldError) setError(fieldError);
      else setError(caught instanceof Error ? caught.message : tr("修改失败"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={tr("修改用户名")} onClose={onClose}>
      <form className="stack-form profile-edit-form" noValidate onSubmit={submit}>
        <label className={`field${error ? " has-error" : ""}`}>
          <span>{tr("用户名")}</span>
          <input
            autoFocus
            name="username"
            autoComplete="username"
            value={username}
            aria-invalid={Boolean(error)}
            onChange={(event) => {
              setUsername(event.target.value);
              setError("");
            }}
          />
          {error && <AuthFeedback tone="error">{error}</AuthFeedback>}
        </label>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{tr("取消")}</button>
          <button className="primary-button" disabled={busy}>
            <BusyButtonContent busy={busy}>{tr("保存")}</BusyButtonContent>
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function IdentityEditModal({
  displayName,
  employeeNumber,
  registrationPending,
  onClose,
  onSubmitted
}: {
  displayName: string;
  employeeNumber: string;
  registrationPending: boolean;
  onClose: () => void;
  onSubmitted: () => Promise<void>;
}) {
  const [name, setName] = useState(displayName);
  const [number, setNumber] = useState(employeeNumber);
  const [errors, setErrors] = useState<{ displayName?: string; employeeNumber?: string }>({});
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const nextName = name.trim();
    const nextNumber = number.trim().toLowerCase();
    const nextErrors: typeof errors = {};
    if (Array.from(nextName).length < 2 || Array.from(nextName).length > 60) {
      nextErrors.displayName = tr("姓名必须为 2–60 个字符");
    }
    if (!isEmployeeNumberValid(nextNumber)) {
      nextErrors.employeeNumber = tr(EMPLOYEE_NUMBER_MESSAGE);
    }
    if (nextName === displayName && nextNumber === employeeNumber) {
      nextErrors.displayName = tr("姓名或工号至少需要修改一项");
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    setBusy(true);
    try {
      await api("/auth/profile-change-requests", {
        method: "POST",
        body: jsonBody({ displayName: nextName, employeeNumber: nextNumber })
      });
      await onSubmitted();
    } catch (caught) {
      const displayNameError = fieldErrorFromApi(caught, "displayName");
      const employeeNumberError = fieldErrorFromApi(caught, "employeeNumber");
      if (displayNameError || employeeNumberError) {
        setErrors({
          ...(displayNameError ? { displayName: displayNameError } : {}),
          ...(employeeNumberError ? { employeeNumber: employeeNumberError } : {})
        });
      } else {
        setErrors({ displayName: caught instanceof Error ? caught.message : tr("提交失败") });
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={tr("修改姓名和工号")} onClose={onClose}>
      <form className="stack-form profile-edit-form" noValidate onSubmit={submit}>
        <div className="two-fields">
          <label className={`field${errors.displayName ? " has-error" : ""}`}>
            <span>{tr("姓名")}</span>
            <input
              autoFocus
              name="displayName"
              value={name}
              aria-invalid={Boolean(errors.displayName)}
              onChange={(event) => {
                setName(event.target.value);
                setErrors((current) => ({ ...current, displayName: undefined }));
              }}
            />
            {errors.displayName && <AuthFeedback tone="error">{errors.displayName}</AuthFeedback>}
          </label>
          <label className={`field${errors.employeeNumber ? " has-error" : ""}`}>
            <span>{tr("工号")}</span>
            <input
              name="employeeNumber"
              value={number}
              aria-invalid={Boolean(errors.employeeNumber)}
              onChange={(event) => {
                setNumber(event.target.value.toLowerCase());
                setErrors((current) => ({ ...current, employeeNumber: undefined }));
              }}
            />
            {errors.employeeNumber && <AuthFeedback tone="error">{errors.employeeNumber}</AuthFeedback>}
          </label>
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{tr("取消")}</button>
          <button className="primary-button" disabled={busy}>
            <BusyButtonContent busy={busy}>
              {registrationPending ? tr("保存") : tr("提交审核")}
            </BusyButtonContent>
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function EmailEditModal({
  currentEmail,
  notify,
  onClose,
  onSaved
}: {
  currentEmail: string | null;
  notify: (kind: "success" | "error", message: string) => void;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [step, setStep] = useState<"EDIT" | "CONFIRM_CLEAR">("EDIT");
  const [oldChallengeId, setOldChallengeId] = useState("");
  const [oldCode, setOldCode] = useState("");
  const [oldSending, setOldSending] = useState(false);
  const [email, setEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [registrationConfig, setRegistrationConfig] =
    useState<RegistrationConfigPayload | null>(null);
  const [configError, setConfigError] = useState("");
  const [emailError, setEmailError] = useState("");
  const [currentPasswordError, setCurrentPasswordError] = useState("");
  const [codeError, setCodeError] = useState("");
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resendAvailableAt, setResendAvailableAt] = useState<number | null>(null);
  const [resendSeconds, setResendSeconds] = useState(0);
  const [focusCodeAfterSend, setFocusCodeAfterSend] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  const loadConfig = useCallback(async () => {
    const result = await api<RegistrationConfigPayload>(
      "/auth/registration-config"
    );
    setRegistrationConfig({
      ...result,
      allowedEmailDomains: result.allowedEmailDomains.map((item) =>
        item.toLowerCase()
      )
    });
    if (!result.emailEnabled) {
      setEmail("");
      setCode("");
      setChallengeId("");
    }
    setConfigError("");
  }, []);
  useEffect(() => {
    void loadConfig().catch(() =>
      setConfigError(tr("暂时无法加载邮箱规则，请稍后重试。"))
    );
  }, [loadConfig]);
  useEffect(() => {
    if (!resendAvailableAt) {
      setResendSeconds(0);
      return;
    }
    const update = () => setResendSeconds(verificationCooldownSeconds(resendAvailableAt));
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [resendAvailableAt]);
  useEffect(() => {
    if (!focusCodeAfterSend || !challengeId) return;
    codeRef.current?.focus();
    setFocusCodeAfterSend(false);
  }, [challengeId, focusCodeAfterSend]);

  const emailEnabled = registrationConfig?.emailEnabled ?? false;
  const allowedDomains = registrationConfig?.allowedEmailDomains ?? null;
  const validateCurrentEmail = () => {
    if (!email.trim()) {
      return currentEmail ? "" : tr("当前账号尚未设置邮箱");
    }
    if (!emailEnabled) return tr("邮件功能未启用，暂时不能绑定邮箱");
    const normalized = normalizeRegistrationEmail(email);
    const errors = validateEmail(normalized, allowedDomains ?? []);
    if (errors.length) return errors[0];
    if (
      currentEmail &&
      normalized === normalizeRegistrationEmail(currentEmail)
    ) {
      return tr("新邮箱与当前邮箱相同");
    }
    return "";
  };
  const sendCode = async () => {
    if (!emailEnabled) return;
    const nextError = validateCurrentEmail();
    setEmailError(nextError);
    if (nextError || sending || resendSeconds > 0 || allowedDomains === null) return;
    setSending(true);
    try {
      const result = await api<{ challengeId: string; expiresAt: string }>("/auth/email-change-code", {
        method: "POST",
        body: jsonBody({ email: normalizeRegistrationEmail(email) })
      });
      setChallengeId(result.challengeId);
      setCode("");
      setCodeError("");
      setResendAvailableAt(Date.now() + 60_000);
      setFocusCodeAfterSend(true);
    } catch (caught) {
      if (
        caught instanceof ApiError &&
        caught.code === "EMAIL_FEATURE_DISABLED"
      ) {
        await loadConfig().catch(() =>
          setConfigError(tr("暂时无法加载邮箱规则，请稍后重试。"))
        );
        return;
      }
      const message = caught instanceof Error ? caught.message : tr("发送失败");
      if (/邮箱|域名|占用/.test(message)) setEmailError(message);
      else notify("error", message);
    } finally {
      setSending(false);
    }
  };
  const performChange = async ({
    clearing,
    password
  }: {
    clearing: boolean;
    password?: string;
  }) => {
    if (!registrationConfig) return;
    const normalizedEmail = normalizeRegistrationEmail(email);
    setBusy(true);
    try {
      await api("/auth/change-email", {
        method: "POST",
        body: jsonBody({
          email: clearing ? null : normalizedEmail,
          challengeId: clearing ? null : challengeId,
          ...(registrationConfig?.emailEnabled && currentEmail ? { oldChallengeId: oldChallengeId || undefined, oldCode: oldCode || undefined } : {}),
          code: clearing ? null : code,
          clearEmailConfirmed: clearing,
          expectedConfigRevision: registrationConfig.revision,
          ...(clearing ? { currentPassword: password } : {})
        })
      });
      await onSaved();
    } catch (caught) {
      if (
        caught instanceof ApiError &&
        (caught.code === "REGISTRATION_CONFIG_CHANGED" ||
          caught.code === "EMAIL_FEATURE_DISABLED")
      ) {
        setStep("EDIT");
        await loadConfig().catch(() =>
          setConfigError(tr("暂时无法加载邮箱规则，请稍后重试。"))
        );
        notify("error", tr("邮件设置已更新，请按当前规则重新确认"));
        return;
      }
      const message = caught instanceof Error ? caught.message : tr("更换失败");
      const passwordMessage = fieldErrorFromApi(caught, "currentPassword");
      const codeMessage = fieldErrorFromApi(caught, "code");
      const emailMessage = fieldErrorFromApi(caught, "email");
      if (passwordMessage) {
        setCurrentPasswordError(passwordMessage);
        setStep("CONFIRM_CLEAR");
      } else if (codeMessage) {
        setCodeError(codeMessage);
        setStep("EDIT");
      } else if (emailMessage) {
        setEmailError(emailMessage);
        setStep("EDIT");
      } else if (/验证码/.test(message)) {
        setCodeError(message);
        setStep("EDIT");
      } else if (/邮箱|域名|占用/.test(message)) {
        setEmailError(message);
        setStep("EDIT");
      } else {
        notify("error", message);
      }
    } finally {
      setBusy(false);
    }
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!registrationConfig) return;
    const normalizedEmail = normalizeRegistrationEmail(email);
    const clearing = !normalizedEmail;
    const nextEmailError = validateCurrentEmail();
    const nextCodeError = clearing
      ? ""
      : /^\d{6}$/.test(code)
        ? challengeId
          ? ""
          : tr("验证码无效，请重新输入")
        : tr("请输入6位验证码");
    setEmailError(nextEmailError);
    setCodeError(nextCodeError);
    if (nextEmailError || nextCodeError) return;
    if (clearing) {
      setCurrentPassword("");
      setCurrentPasswordError("");
      setStep("CONFIRM_CLEAR");
      return;
    }
    await performChange({ clearing: false });
  };
  const confirmClear = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!currentPassword) {
      setCurrentPasswordError(tr("请输入当前密码"));
      return;
    }
    await performChange({ clearing: true, password: currentPassword });
  };
  const buttonLabel = verificationButtonLabel({
    sending,
    remainingSeconds: resendSeconds
  });
  return (
    <Modal
      title={step === "CONFIRM_CLEAR" ? tr("确认清空邮箱") : tr("修改邮箱")}
      onClose={
        step === "CONFIRM_CLEAR"
          ? () => {
            setStep("EDIT");
            setCurrentPassword("");
            setCurrentPasswordError("");
          }
          : onClose
      }
    >
      {step === "CONFIRM_CLEAR" ? (
        <form
          className="stack-form profile-edit-form"
          noValidate
          onSubmit={confirmClear}
        >
          <AuthFeedback tone="warning" anchored={false}>
            {tr("清空邮箱后将无法接收系统邮件提醒，也无法自行通过邮件找回密码。")}</AuthFeedback>
          <label className={`field${currentPasswordError ? " has-error" : ""}`}>
            <span>{tr("当前密码")}</span>
            <PasswordInput
              autoFocus
              name="currentPassword"
              autoComplete="current-password"
              value={currentPassword}
              aria-invalid={Boolean(currentPasswordError)}
              onChange={(event) => {
                setCurrentPassword(event.target.value);
                setCurrentPasswordError("");
              }}
            />
            {currentPasswordError && (
              <AuthFeedback tone="error">{currentPasswordError}</AuthFeedback>
            )}
          </label>
          <div className="modal-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => {
                setStep("EDIT");
                setCurrentPassword("");
                setCurrentPasswordError("");
              }}
            >
              {tr("返回")}</button>
            <button className="danger-button" disabled={busy}>
              <BusyButtonContent busy={busy}>{tr("确认清空")}</BusyButtonContent>
            </button>
          </div>
        </form>
      ) : (
        <form className="stack-form profile-edit-form" noValidate onSubmit={submit}>
          {configError && (
            <AuthFeedback tone="error" anchored={false}>
              {configError}
            </AuthFeedback>
          )}
          {currentEmail && (
            <label className="field">
              <span>{tr("当前邮箱")}</span>
              <input readOnly value={currentEmail} />
            </label>
          )}
          {currentEmail && emailEnabled && (
            <div className="verification-row">
              <label className="field"><span>{tr("旧邮箱验证码")}</span>
                <input inputMode="numeric" maxLength={6} value={oldCode} onChange={event => setOldCode(event.target.value.replace(/\D/g, ""))} />
                <small>{tr("旧邮箱不可用时，请联系管理员恢复。")}</small>
              </label>
              <button type="button" className="secondary-button verification-button" disabled={oldSending} onClick={async () => {
                setOldSending(true);
                try { const result = await api<{ challengeId: string }>("/auth/old-email-code", { method: "POST", body: jsonBody({}) }); setOldChallengeId(result.challengeId); notify("success", tr("验证码已发送至旧邮箱")); }
                catch (error) { notify("error", error instanceof Error ? error.message : tr("发送失败")); }
                finally { setOldSending(false); }
              }}>{tr("验证旧邮箱")}</button>
            </div>
          )}
          {registrationConfig && !emailEnabled && (
            currentEmail ? (
              <AuthFeedback tone="warning" anchored={false}>
                {tr("邮件功能未启用，只能清空当前邮箱。")}</AuthFeedback>
            ) : (
              <AuthFeedback tone="warning" anchored={false}>
                {tr("邮件功能未启用，当前账号没有可修改的邮箱。")}</AuthFeedback>
            )
          )}
          <label className={`field${emailError ? " has-error" : ""}`}>
            <span>{tr("新邮箱（留空表示清空）")}</span>
            <input
              autoFocus
              type="email"
              name="email"
              autoComplete="email"
              disabled={!emailEnabled}
              value={email}
              aria-invalid={Boolean(emailError)}
              onChange={(event) => {
                setEmail(event.target.value);
                setEmailError("");
                setCode("");
                setCodeError("");
                setChallengeId("");
              }}
            />
            {emailEnabled && allowedDomains?.length ? (
              <small>{tr("仅允许以下邮箱域名：")}{allowedDomains.join("、")}。</small>
            ) : null}
            {emailError && <AuthFeedback tone="error">{emailError}</AuthFeedback>}
          </label>
          <div className="verification-row">
            <label className={`field${codeError ? " has-error" : ""}`}>
              <span>{tr("验证码")}</span>
              <input
                ref={codeRef}
                name="code"
                inputMode="numeric"
                maxLength={6}
                disabled={!emailEnabled || !email.trim() || !challengeId}
                value={code}
                aria-invalid={Boolean(codeError)}
                onChange={(event) => {
                  setCode(event.target.value.replace(/\D/g, ""));
                  setCodeError("");
                }}
              />
              {codeError && <AuthFeedback tone="error">{codeError}</AuthFeedback>}
            </label>
            <button
              type="button"
              className="secondary-button verification-button"
              disabled={
                !emailEnabled ||
                !email.trim() ||
                sending ||
                resendSeconds > 0 ||
                allowedDomains === null ||
                Boolean(configError) ||
                Boolean(validateCurrentEmail())
              }
              onClick={() => void sendCode()}
            >
              {buttonLabel}
            </button>
          </div>
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={onClose}>
              {tr("取消")}</button>
            <button
              className="primary-button"
              disabled={
                busy ||
                Boolean(configError) ||
                !registrationConfig ||
                (!emailEnabled && !currentEmail)
              }
            >
              <BusyButtonContent busy={busy}>{tr("确认修改")}</BusyButtonContent>
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
