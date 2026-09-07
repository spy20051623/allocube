import { tr, trDynamic } from "../i18n/index";
import { EyeOff, Eye, Check } from "lucide-react";
import { useState, useId } from "react";
import { getPasswordChecks } from "../shared/identity-rules";
import { AuthFeedback } from "./forms";

type PasswordInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "type"
> & {
  onFieldFocus?: () => void;
  onFieldBlur?: () => void;
  onCapsLockChange?: (active: boolean) => void;
};

export function PasswordInput({
  className,
  onFieldFocus,
  onFieldBlur,
  onCapsLockChange,
  ...inputProps
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  const [focused, setFocused] = useState(false);
  const [capsLockOn, setCapsLockOn] = useState(false);
  const capsLockFeedbackId = useId();
  const actionLabel = visible ? tr("隐藏密码") : tr("显示密码");
  const updateCapsLock = (active: boolean) => {
    setCapsLockOn(active);
    onCapsLockChange?.(active);
  };
  const describedBy = [
    inputProps["aria-describedby"],
    focused && capsLockOn ? capsLockFeedbackId : undefined
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className="password-input-control"
      onFocusCapture={() => {
        setFocused(true);
        onFieldFocus?.();
      }}
      onBlurCapture={(event) => {
        if (
          !event.currentTarget.contains(event.relatedTarget as Node | null)
        ) {
          setFocused(false);
          updateCapsLock(false);
          onFieldBlur?.();
        }
      }}
      onKeyDownCapture={(event) =>
        updateCapsLock(event.getModifierState("CapsLock"))
      }
      onKeyUpCapture={(event) =>
        updateCapsLock(event.getModifierState("CapsLock"))
      }
    >
      <div className="password-input-shell">
        <input
          {...inputProps}
          className={className}
          type={visible ? "text" : "password"}
          aria-describedby={describedBy || undefined}
        />
        <button
          type="button"
          className="password-visibility-button"
          tabIndex={-1}
          aria-label={actionLabel}
          aria-pressed={visible}
          title={actionLabel}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setVisible((current) => !current)}
        >
          {visible ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
      {focused && capsLockOn && (
        <AuthFeedback id={capsLockFeedbackId} tone="warning">
          {tr("已开启大写锁定。")}</AuthFeedback>
      )}
    </div>
  );
}

export function PasswordField({
  label,
  id,
  ...inputProps
}: PasswordInputProps & {
  label: string;
}) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  return (
    <div className="field">
      <label htmlFor={inputId}>{label}</label>
      <PasswordInput {...inputProps} id={inputId} />
    </div>
  );
}

export function PasswordChecklist({
  checks
}: {
  checks: ReturnType<typeof getPasswordChecks>;
}) {
  return (
    <ul>
      {checks.map((check) => (
        <li
          key={check.key}
          className={
            check.met === true
              ? "passed"
              : check.met === false
                ? "failed"
                : "pending"
          }
        >
          {check.met === true ? (
            <Check size={13} />
          ) : (
            <span className="check-dot" />
          )}
          <span>{trDynamic(check.label)}</span>
        </li>
      ))}
    </ul>
  );
}
