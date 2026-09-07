import { Modal } from "../Modal";
import { tr } from "../i18n/index";
import { createContext, useContext, useState, useRef, useCallback, useMemo } from "react";
import { Field, AuthFeedback } from "./forms";

type DialogTone = "default" | "danger";

type ConfirmDialogOptions = {
  signal?: AbortSignal;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: DialogTone;
};

export type PromptDialogOptions = ConfirmDialogOptions & {
  label: string;
  initialValue?: string;
  placeholder?: string;
  required?: boolean;
  maxLength?: number;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
  multiline?: boolean;
  validate?: (value: string) => string;
};

type DialogController = {
  confirm: (options: ConfirmDialogOptions) => Promise<boolean>;
  prompt: (options: PromptDialogOptions) => Promise<string | null>;
};

const DialogContext = createContext<DialogController | null>(null);

export function useAppDialog() {
  const value = useContext(DialogContext);
  if (!value) throw new Error("DialogProvider is missing");
  return value;
}

type DialogRequest =
  | {
    id: number;
    kind: "confirm";
    options: ConfirmDialogOptions;
    resolve: (value: boolean) => void;
  }
  | {
    id: number;
    kind: "prompt";
    options: PromptDialogOptions;
    resolve: (value: string | null) => void;
  };

export function DialogProvider({ children }: { children: React.ReactNode }) {
  const [request, setRequest] = useState<DialogRequest | null>(null);
  const requestId = useRef(0);
  const confirm = useCallback(
    (options: ConfirmDialogOptions) =>
      new Promise<boolean>((resolve) => {
        if (options.signal?.aborted) { resolve(false); return; }
        const id = ++requestId.current;
        const finish = (value: boolean) => { options.signal?.removeEventListener("abort", abort); resolve(value); };
        const abort = () => { finish(false); setRequest(current => current?.id === id ? null : current); };
        options.signal?.addEventListener("abort", abort, { once: true });
        setRequest(current => {
          if (current?.kind === "confirm") current.resolve(false);
          else if (current) current.resolve(null);
          return { id, kind: "confirm", options, resolve: finish };
        });
      }),
    []
  );
  const prompt = useCallback(
    (options: PromptDialogOptions) =>
      new Promise<string | null>((resolve) => {
        if (options.signal?.aborted) { resolve(null); return; }
        const id = ++requestId.current;
        const finish = (value: string | null) => { options.signal?.removeEventListener("abort", abort); resolve(value); };
        const abort = () => { finish(null); setRequest(current => current?.id === id ? null : current); };
        options.signal?.addEventListener("abort", abort, { once: true });
        setRequest(current => {
          if (current?.kind === "confirm") current.resolve(false);
          else if (current) current.resolve(null);
          return { id, kind: "prompt", options, resolve: finish };
        });
      }),
    []
  );
  const controller = useMemo(() => ({ confirm, prompt }), [confirm, prompt]);
  const close = (value: boolean | string | null) => {
    if (!request) return;
    if (request.kind === "confirm") {
      request.resolve(Boolean(value));
    } else {
      request.resolve(typeof value === "string" ? value : null);
    }
    setRequest(null);
  };
  return (
    <DialogContext.Provider value={controller}>
      {children}
      {request && <AppActionDialog key={request.id} request={request} onClose={close} />}
    </DialogContext.Provider>
  );
}

function AppActionDialog({
  request,
  onClose
}: {
  request: DialogRequest;
  onClose: (value: boolean | string | null) => void;
}) {
  const options = request.options;
  const [value, setValue] = useState(
    request.kind === "prompt" ? request.options.initialValue ?? "" : ""
  );
  const [error, setError] = useState("");
  const submit = () => {
    if (request.kind === "confirm") {
      onClose(true);
      return;
    }
    const normalized = value.trim();
    if (request.options.required && !normalized) {
      setError(tr("请输入{{v0}}", { v0: request.options.label.replace(/（.*?）/g, "") }));
      return;
    }
    const validationError = request.options.validate?.(normalized) ?? "";
    if (validationError) {
      setError(validationError);
      return;
    }
    onClose(normalized);
  };
  return (
    <Modal title={options.title} onClose={() => onClose(request.kind === "confirm" ? false : null)}>
      <form
        className="action-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <p className={`action-dialog-message ${options.tone === "danger" ? "danger" : ""}`}>
          {options.message}
        </p>
        {request.kind === "prompt" && (
          <Field label={request.options.label}>
            {request.options.multiline ? (
              <textarea
                autoFocus
                value={value}
                maxLength={request.options.maxLength}
                placeholder={request.options.placeholder}
                aria-invalid={Boolean(error)}
                onChange={(event) => {
                  setValue(event.target.value);
                  setError("");
                }}
              />
            ) : (
              <input
                autoFocus
                value={value}
                maxLength={request.options.maxLength}
                placeholder={request.options.placeholder}
                inputMode={request.options.inputMode}
                aria-invalid={Boolean(error)}
                onChange={(event) => {
                  setValue(event.target.value);
                  setError("");
                }}
              />
            )}
            {error && <AuthFeedback tone="error">{error}</AuthFeedback>}
          </Field>
        )}
        <div className="modal-actions action-dialog-actions">
          <button
            type="button"
            className="secondary-button"
            autoFocus={request.kind === "confirm"}
            onClick={() => onClose(request.kind === "confirm" ? false : null)}
          >
            {options.cancelLabel ?? tr("取消")}
          </button>
          <button
            type="submit"
            className={options.tone === "danger" ? "danger-button" : "primary-button"}
          >
            {options.confirmLabel ?? tr("确认")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
