import { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
import { tr } from "./i18n";

export function Modal({
  title,
  onClose,
  wide,
  large,
  className,
  headerActions,
  children
}: {
  title: string;
  onClose: () => void;
  wide?: boolean;
  large?: boolean;
  className?: string;
  headerActions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const headingId = useId();
  const dialogRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusableSelector = [
      "button:not([disabled])",
      "input:not([disabled])",
      "textarea:not([disabled])",
      "select:not([disabled])",
      "summary",
      "a[href]",
      "[tabindex]:not([tabindex='-1'])"
    ].join(",");
    const focusDialog = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      const preferred = dialog?.querySelector<HTMLElement>("[autofocus]");
      const first = dialog?.querySelector<HTMLElement>(focusableSelector);
      (preferred ?? first)?.focus();
    });
    const handleKeyboard = (event: KeyboardEvent) => {
      // A confirmation above an editor owns Escape/Tab; do not close both dialogs.
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (dialogs.item(dialogs.length - 1) !== dialogRef.current) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector)
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyboard);
    return () => {
      window.cancelAnimationFrame(focusDialog);
      window.removeEventListener("keydown", handleKeyboard);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section
        ref={dialogRef}
        className={`modal ${large ? "large" : wide ? "wide" : ""}${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
      >
        <header>
          <h2 id={headingId}>{title}</h2>
          {headerActions && <div className="modal-header-actions">{headerActions}</div>}
          <button type="button" className="icon-button" aria-label={tr("关闭")} onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
