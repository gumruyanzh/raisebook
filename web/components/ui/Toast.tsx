"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastItem {
  id: number;
  message: ReactNode;
  action?: ToastAction;
}

interface ToastApi {
  /** One line. With an action ("Undo"), it stays 8s instead of 4s. */
  show: (message: ReactNode, action?: ToastAction) => void;
  dismiss: () => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/**
 * The prototype toast (SYSTEM 3.16): fg box with canvas text, radius 8, bottom center with a
 * safe-area offset, one at a time, `role="status"`.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [item, setItem] = useState<ToastItem | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  const dismiss = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setItem(null);
  }, []);

  const show = useCallback(
    (message: ReactNode, action?: ToastAction) => {
      if (timer.current) clearTimeout(timer.current);
      seq.current += 1;
      setItem({ id: seq.current, message, action });
      timer.current = setTimeout(() => setItem(null), action ? 8000 : 4000);
    },
    [],
  );

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-[calc(18px+env(safe-area-inset-bottom))] z-[70] flex justify-center px-16"
      >
        {item ? (
          <div
            key={item.id}
            className="anim-fade pointer-events-auto flex max-w-[min(560px,100%)] items-center gap-14 rounded-md bg-fg px-14 py-8 text-13 text-canvas"
          >
            <span className="min-w-0">{item.message}</span>
            {item.action ? (
              <button
                type="button"
                className="shrink-0 border-0 bg-transparent p-0 font-semibold text-canvas underline underline-offset-2"
                onClick={() => {
                  item.action?.onClick();
                  dismiss();
                }}
              >
                {item.action.label}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </ToastContext.Provider>
  );
}

/** `const toast = useToast(); toast.show("Dana Whitfield moved to Meeting.", {label: "Undo", onClick})`. */
export function useToast(): ToastApi {
  const t = useContext(ToastContext);
  if (!t) throw new Error("useToast() needs <ToastProvider> (it is in app/layout.tsx).");
  return t;
}
