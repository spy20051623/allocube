import { tr } from "../../i18n/index";
import { Info } from "lucide-react";
import { useState, useMemo } from "react";
import { api, jsonBody, setCsrfToken } from "../../api";
import {
  readLoginPreference,
  type LoginMethod,
  rememberLoginMethod,
  rememberSuccessfulLogin
} from "../../login-preference";
import { type LoginField, type LoginFieldErrors, validateLoginForm } from "../../login-validation";
import type { DashboardBootstrap } from "../../shared/types";
import { type AuthNavigate } from "./types";
import { AuthLayout } from "./AuthLayout";
import { AuthFieldShell, AuthFeedback } from "../../components/forms";
import { PasswordInput } from "../../components/PasswordFields";
import { BusyButtonContent } from "../../components/feedback";

export function LoginPage({
  onAuthenticated,
  navigate,
  initialIdentifier,
  initialMessage
}: {
  onAuthenticated: (bootstrap: DashboardBootstrap) => Promise<void>;
  navigate: AuthNavigate;
  initialIdentifier: string;
  initialMessage: string;
}) {
  const [loginInfoMessage] = useState(initialMessage);
  const remembered = useMemo(() => readLoginPreference(), []);
  const [method, setMethod] = useState<LoginMethod>(
    initialIdentifier ? "USERNAME" : remembered.method
  );
  const [username, setUsername] = useState(
    initialIdentifier || remembered.username || ""
  );
  const [usernamePassword, setUsernamePassword] = useState("");
  const [employeeNumber, setEmployeeNumber] = useState(
    remembered.employeeNumber ?? ""
  );
  const [employeeNumberPassword, setEmployeeNumberPassword] = useState("");
  const [usernameError, setUsernameError] = useState("");
  const [employeeNumberError, setEmployeeNumberError] = useState("");
  const [usernameValidation, setUsernameValidation] =
    useState<LoginFormValidationState>(emptyLoginValidationState);
  const [employeeNumberValidation, setEmployeeNumberValidation] =
    useState<LoginFormValidationState>(emptyLoginValidationState);
  const [busy, setBusy] = useState(false);

  const selectMethod = (next: LoginMethod) => {
    setMethod(next);
    rememberLoginMethod(next);
  };

  const submit = async (
    identifierType: LoginMethod,
    identifier: string,
    password: string,
    setError: (message: string) => void
  ) => {
    setError("");
    setBusy(true);
    try {
      const result = await api<DashboardBootstrap>("/auth/login", {
        method: "POST",
        body: jsonBody({ identifierType, identifier, password })
      });
      rememberSuccessfulLogin(
        identifierType,
        identifier,
        result.user.username
      );
      setCsrfToken(result.csrfToken);
      await onAuthenticated(result);
    } catch (error) {
      setError(error instanceof Error ? error.message : tr("登录失败"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title={tr("账号登录")}>
      <div
        className="segmented auth-tabs"
        role="tablist"
        aria-label={tr("登录方式")}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
            return;
          }
          event.preventDefault();
          const next =
            event.key === "ArrowLeft" || event.key === "Home"
              ? "USERNAME"
              : "EMPLOYEE_NUMBER";
          selectMethod(next);
          window.requestAnimationFrame(() => {
            document
              .getElementById(
                next === "USERNAME"
                  ? "username-login-tab"
                  : "employee-number-login-tab"
              )
              ?.focus();
          });
        }}
      >
        <button
          type="button"
          id="username-login-tab"
          role="tab"
          aria-selected={method === "USERNAME"}
          aria-controls="username-login-form"
          tabIndex={method === "USERNAME" ? 0 : -1}
          className={method === "USERNAME" ? "active" : ""}
          onClick={() => selectMethod("USERNAME")}
        >
          {tr("用户名")}</button>
        <button
          type="button"
          id="employee-number-login-tab"
          role="tab"
          aria-selected={method === "EMPLOYEE_NUMBER"}
          aria-controls="employee-number-login-form"
          tabIndex={method === "EMPLOYEE_NUMBER" ? 0 : -1}
          className={method === "EMPLOYEE_NUMBER" ? "active" : ""}
          onClick={() => selectMethod("EMPLOYEE_NUMBER")}
        >
          {tr("工号")}</button>
      </div>
      {method === "USERNAME" ? (
        <LoginCredentialForm
          identifierType="USERNAME"
          identifier={username}
          password={usernamePassword}
          busy={busy}
          infoMessage={loginInfoMessage}
          errorMessage={usernameError}
          validation={usernameValidation}
          setValidation={setUsernameValidation}
          onIdentifierChange={(value) => {
            setUsername(value);
            setUsernameError("");
          }}
          onPasswordChange={(value) => {
            setUsernamePassword(value);
            setUsernameError("");
          }}
          onSubmit={(password) =>
            submit("USERNAME", username, password, setUsernameError)
          }
        />
      ) : (
        <LoginCredentialForm
          identifierType="EMPLOYEE_NUMBER"
          identifier={employeeNumber}
          password={employeeNumberPassword}
          busy={busy}
          errorMessage={employeeNumberError}
          validation={employeeNumberValidation}
          setValidation={setEmployeeNumberValidation}
          onIdentifierChange={(value) => {
            setEmployeeNumber(value);
            setEmployeeNumberError("");
          }}
          onPasswordChange={(value) => {
            setEmployeeNumberPassword(value);
            setEmployeeNumberError("");
          }}
          onSubmit={(password) =>
            submit(
              "EMPLOYEE_NUMBER",
              employeeNumber,
              password,
              setEmployeeNumberError
            )
          }
        />
      )}
      <button
        type="button"
        className="text-button auth-alt"
        onClick={() => navigate("/forgot-password")}
      >
        {tr("忘记密码？")}</button>
      <div className="auth-register-entry">
        <span>{tr("还没有账号？")}</span>
        <button
          type="button"
          className="secondary-button wide"
          onClick={() => navigate("/register")}
        >
          {tr("申请注册账号")}</button>
      </div>
    </AuthLayout>
  );
}

type LoginFormValidationState = {
  focused: LoginField | null;
  errors: LoginFieldErrors;
};

const emptyLoginValidationState: LoginFormValidationState = {
  focused: null,
  errors: {}
};

type LoginValidationSetter = React.Dispatch<
  React.SetStateAction<LoginFormValidationState>
>;

function focusLoginField(
  setValidation: LoginValidationSetter,
  field: LoginField
) {
  setValidation((current) => ({ ...current, focused: field }));
}

function blurLoginField(setValidation: LoginValidationSetter) {
  setValidation((current) => ({ ...current, focused: null }));
}

function clearLoginFieldError(
  setValidation: LoginValidationSetter,
  field: LoginField
) {
  setValidation((current) => {
    if (!current.errors[field]) return current;
    const errors = { ...current.errors };
    delete errors[field];
    return { ...current, errors };
  });
}

function LoginCredentialForm({
  identifierType,
  identifier,
  password,
  busy,
  infoMessage = "",
  errorMessage,
  validation,
  setValidation,
  onIdentifierChange,
  onPasswordChange,
  onSubmit
}: {
  identifierType: LoginMethod;
  identifier: string;
  password: string;
  busy: boolean;
  infoMessage?: string;
  errorMessage: string;
  validation: LoginFormValidationState;
  setValidation: LoginValidationSetter;
  onIdentifierChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: (password: string) => Promise<void>;
}) {
  const usernameLogin = identifierType === "USERNAME";
  const formPrefix = usernameLogin ? "username" : "employee-number";
  const identifierId = `${formPrefix}-login-identifier`;
  const passwordId = `${formPrefix}-login-password`;
  return (
    <form
      id={`${formPrefix}-login-form`}
      role="tabpanel"
      aria-labelledby={`${formPrefix}-login-tab`}
      className="stack-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        const errors = validateLoginForm(identifierType, identifier, password);
        setValidation({ focused: null, errors });
        if (Object.keys(errors).length) return;
        void onSubmit(password);
      }}
    >
      <AuthFieldShell
        id={identifierId}
        label={usernameLogin ? tr("用户名") : tr("工号")}
        focused={validation.focused === "identifier"}
        error={validation.errors.identifier}
      >
        <input
          id={identifierId}
          name={usernameLogin ? "username" : "employeeNumber"}
          autoFocus
          autoComplete="username"
          aria-invalid={Boolean(validation.errors.identifier)}
          aria-describedby={
            validation.focused !== "identifier" &&
              validation.errors.identifier
              ? `${identifierId}-error`
              : undefined
          }
          value={identifier}
          onFocus={() => focusLoginField(setValidation, "identifier")}
          onBlur={() => blurLoginField(setValidation)}
          onChange={(event) => {
            clearLoginFieldError(setValidation, "identifier");
            onIdentifierChange(
              usernameLogin
                ? event.target.value
                : event.target.value.toLowerCase()
            );
          }}
        />
      </AuthFieldShell>
      <AuthFieldShell
        id={passwordId}
        label={tr("密码")}
        focused={validation.focused === "password"}
        error={validation.errors.password}
      >
        <PasswordInput
          id={passwordId}
          name="password"
          autoComplete="current-password"
          aria-invalid={Boolean(validation.errors.password)}
          aria-describedby={
            validation.focused !== "password" && validation.errors.password
              ? `${passwordId}-error`
              : undefined
          }
          value={password}
          onFieldFocus={() => focusLoginField(setValidation, "password")}
          onFieldBlur={() => blurLoginField(setValidation)}
          onChange={(event) => {
            clearLoginFieldError(setValidation, "password");
            onPasswordChange(event.target.value);
          }}
        />
      </AuthFieldShell>
      {infoMessage && (
        <div className="inline-message"><Info size={16} />{infoMessage}</div>
      )}
      {errorMessage && (
        <AuthFeedback tone="error" anchored={false}>
          {errorMessage}
        </AuthFeedback>
      )}
      <button className="primary-button auth-submit" disabled={busy}>
        <BusyButtonContent busy={busy} iconSize={16}>{tr("登录")}</BusyButtonContent>
      </button>
    </form>
  );
}
