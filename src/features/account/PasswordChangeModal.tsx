import { Modal } from "../../Modal";
import { tr } from "../../i18n/index";
import { useState } from "react";
import { api, jsonBody } from "../../api";
import { getPasswordChecks } from "../../shared/identity-rules";
import { fieldErrorFromApi } from "../../api-errors";
import { AuthFieldShell, AuthFeedback } from "../../components/forms";
import { PasswordInput, PasswordChecklist } from "../../components/PasswordFields";
import { BusyButtonContent } from "../../components/feedback";

type PasswordChangeField =
  | "currentPassword"
  | "newPassword"
  | "confirmPassword";

type PasswordChangeErrors = Partial<
  Record<PasswordChangeField, { messages: string[]; checklist?: boolean }>
>;

export function PasswordChangeModal({
  title = tr("修改密码"),
  username,
  employeeNumber,
  onClose,
  onSaved
}: {
  title?: string;
  username: string;
  employeeNumber: string | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [focusedField, setFocusedField] =
    useState<PasswordChangeField | null>(null);
  const [newPasswordCapsLockOn, setNewPasswordCapsLockOn] = useState(false);
  const [errors, setErrors] = useState<PasswordChangeErrors>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const passwordChecks = getPasswordChecks(newPassword, {
    username,
    employeeNumbers: employeeNumber ? [employeeNumber] : []
  });

  const clearErrors = (...fields: PasswordChangeField[]) => {
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
    setFormError("");
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    setFocusedField(null);
    setFormError("");

    const nextErrors: PasswordChangeErrors = {};
    if (!currentPassword) {
      nextErrors.currentPassword = { messages: [tr("请输入当前密码")] };
    }
    if (passwordChecks.some((check) => check.met === false)) {
      nextErrors.newPassword = {
        messages: [tr("请满足全部密码要求")],
        checklist: true
      };
    }
    if (!confirmPassword) {
      nextErrors.confirmPassword = { messages: [tr("请再次输入新密码")] };
    } else if (confirmPassword !== newPassword) {
      nextErrors.confirmPassword = { messages: [tr("两次输入的密码不一致")] };
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;

    setBusy(true);
    try {
      await api("/auth/change-password", {
        method: "POST",
        body: jsonBody({ currentPassword, newPassword })
      });
      await onSaved();
    } catch (caught) {
      const currentPasswordError = fieldErrorFromApi(
        caught,
        "currentPassword"
      );
      const newPasswordError =
        fieldErrorFromApi(caught, "newPassword") ||
        fieldErrorFromApi(caught, "password");
      if (currentPasswordError || newPasswordError) {
        setErrors({
          ...(currentPasswordError
            ? {
              currentPassword: {
                messages: [currentPasswordError]
              }
            }
            : {}),
          ...(newPasswordError
            ? {
              newPassword: {
                messages: [newPasswordError]
              }
            }
            : {})
        });
      } else {
        setFormError(
          caught instanceof Error ? caught.message : tr("密码修改失败，请重试")
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const newPasswordError = errors.newPassword;
  return (
    <Modal title={title} onClose={onClose}>
      <form
        className="stack-form profile-edit-form profile-password-form"
        noValidate
        onSubmit={submit}
      >
        <AuthFieldShell
          id="change-current-password"
          label={tr("当前密码")}
          focused={focusedField === "currentPassword"}
          error={errors.currentPassword?.messages}
        >
          <PasswordInput
            id="change-current-password"
            autoFocus
            name="currentPassword"
            autoComplete="current-password"
            value={currentPassword}
            aria-invalid={Boolean(errors.currentPassword)}
            aria-describedby={
              focusedField !== "currentPassword" && errors.currentPassword
                ? "change-current-password-error"
                : undefined
            }
            onFieldFocus={() => setFocusedField("currentPassword")}
            onFieldBlur={() =>
              setFocusedField((current) =>
                current === "currentPassword" ? null : current
              )
            }
            onChange={(event) => {
              setCurrentPassword(event.target.value);
              clearErrors("currentPassword");
            }}
          />
        </AuthFieldShell>
        <AuthFieldShell
          id="change-new-password"
          label={tr("新密码")}
          focused={focusedField === "newPassword"}
          error={newPasswordError?.messages}
          hint={<PasswordChecklist checks={passwordChecks} />}
          hintClassName="password-checklist"
          errorClassName={
            newPasswordError?.checklist ? "password-checklist" : ""
          }
          errorContent={
            newPasswordError?.checklist ? (
              <PasswordChecklist checks={passwordChecks} />
            ) : undefined
          }
          suppressHint={newPasswordCapsLockOn}
        >
          <PasswordInput
            id="change-new-password"
            name="newPassword"
            autoComplete="new-password"
            value={newPassword}
            aria-invalid={Boolean(newPasswordError)}
            aria-describedby={
              focusedField !== "newPassword" && newPasswordError
                ? "change-new-password-error"
                : focusedField === "newPassword" && !newPasswordCapsLockOn
                  ? "change-new-password-hint"
                  : undefined
            }
            onCapsLockChange={setNewPasswordCapsLockOn}
            onFieldFocus={() => setFocusedField("newPassword")}
            onFieldBlur={() =>
              setFocusedField((current) =>
                current === "newPassword" ? null : current
              )
            }
            onChange={(event) => {
              setNewPassword(event.target.value);
              clearErrors("newPassword", "confirmPassword");
            }}
          />
        </AuthFieldShell>
        <AuthFieldShell
          id="change-confirm-password"
          label={tr("确认新密码")}
          focused={focusedField === "confirmPassword"}
          error={errors.confirmPassword?.messages}
        >
          <PasswordInput
            id="change-confirm-password"
            name="confirmPassword"
            autoComplete="new-password"
            value={confirmPassword}
            aria-invalid={Boolean(errors.confirmPassword)}
            aria-describedby={
              focusedField !== "confirmPassword" && errors.confirmPassword
                ? "change-confirm-password-error"
                : undefined
            }
            onFieldFocus={() => setFocusedField("confirmPassword")}
            onFieldBlur={() =>
              setFocusedField((current) =>
                current === "confirmPassword" ? null : current
              )
            }
            onChange={(event) => {
              setConfirmPassword(event.target.value);
              clearErrors("confirmPassword");
            }}
          />
        </AuthFieldShell>
        {formError && (
          <AuthFeedback tone="error" anchored={false}>
            {formError}
          </AuthFeedback>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
          >
            {tr("取消")}</button>
          <button className="primary-button" disabled={busy}>
            <BusyButtonContent busy={busy}>{tr("保存密码")}</BusyButtonContent>
          </button>
        </div>
      </form>
    </Modal>
  );
}
