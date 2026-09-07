import { type SelectControlOption, SelectControl } from "../SelectControl";

type AuthFeedbackTone = "hint" | "warning" | "error";

export function AuthFeedback({
  id,
  tone,
  anchored = true,
  className = "",
  children
}: {
  id?: string;
  tone: AuthFeedbackTone;
  anchored?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      id={id}
      className={`field-bubble ${tone}${anchored ? "" : " form-feedback"}${className ? ` ${className}` : ""
        }`}
      role={tone === "error" ? "alert" : "status"}
      aria-live={tone === "error" ? "assertive" : "polite"}
    >
      {children}
    </div>
  );
}

export function AuthFieldShell({
  id,
  label,
  focused,
  error,
  hint,
  hintClassName = "",
  errorClassName = "",
  errorContent,
  suppressHint = false,
  children
}: {
  id: string;
  label: string;
  focused: boolean;
  error?: string | string[];
  hint?: React.ReactNode;
  hintClassName?: string;
  errorClassName?: string;
  errorContent?: React.ReactNode;
  suppressHint?: boolean;
  children: React.ReactNode;
}) {
  const hasError = Array.isArray(error) ? error.length > 0 : Boolean(error);
  const showError = !focused && hasError;
  const showHint = focused && !suppressHint && Boolean(hint);
  return (
    <div className={`field auth-field${showError ? " has-error" : ""}`}>
      <label htmlFor={id}>{label}</label>
      {children}
      {showError && (
        <AuthFeedback
          id={`${id}-error`}
          tone="error"
          className={errorClassName}
        >
          {errorContent ??
            (Array.isArray(error) ? (
              error.length === 1 ? (
                error[0]
              ) : (
                <ul>
                  {error.map((message) => (
                    <li key={message}>{message}</li>
                  ))}
                </ul>
              )
            ) : (
              error
            ))}
        </AuthFeedback>
      )}
      {showHint && (
        <AuthFeedback
          id={`${id}-hint`}
          tone="hint"
          className={hintClassName}
        >
          {hint}
        </AuthFeedback>
      )}
    </div>
  );
}

export function ChoiceField({
  label,
  value,
  options,
  onChange,
  disabled,
  name
}: {
  label: string;
  value: string;
  options: SelectControlOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  name?: string;
}) {
  return (
    <div className="field">
      <span>{label}</span>
      <SelectControl
        ariaLabel={label}
        value={value}
        options={options}
        onChange={onChange}
        disabled={disabled}
        name={name}
      />
    </div>
  );
}

export function Field({
  label,
  children,
  error
}: {
  label: string;
  children: React.ReactNode;
  error?: string;
}) {
  return (
    <label className={`field${error ? " has-error" : ""}`}>
      <span>{label}</span>
      {children}
      {error && <small className="field-inline-error" role="alert">{error}</small>}
    </label>
  );
}
