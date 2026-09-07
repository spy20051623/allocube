import { useState, useRef, useEffect, useCallback } from "react";

type ToastState = { kind: "success" | "error"; message: string } | null;

export function useToast() {
  const [toast, setToast] = useState<ToastState>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);
  const notify = useCallback((kind: "success" | "error", message: string) => {
    if (!message) return;
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ kind, message });
    toastTimer.current = setTimeout(() => setToast(null), 3600);
  }, []);
  return { toast, notify };
}
