import { useCallback, useRef, useState } from "react";
import type { ToastMessage } from "./models";

type NewToast = Omit<ToastMessage, "id">;

export function useToastQueue() {
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const nextId = useRef(1);

  const dismiss = useCallback(() => {
    setToast(null);
  }, []);

  const show = useCallback((next: NewToast) => {
    setToast({ ...next, id: nextId.current++ });
  }, []);

  return { toast, show, dismiss };
}
