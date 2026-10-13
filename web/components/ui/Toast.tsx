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
  type RefObject,
} from "react";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastItem {
  id: number;
  message: ReactNode;
  actions: ToastAction[];
}

interface ToastApi {
  /**
   * One line. With an action ("Undo"), it stays 8s instead of 4s. At most two actions
   * ("Refresh ≈ $0.20", "Undo"): the first is the offer, the last the undo.
   */
  show: (message: ReactNode, action?: ToastAction | ToastAction[]) => void;
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
    (message: ReactNode, action?: ToastAction | ToastAction[]) => {
      if (timer.current) clearTimeout(timer.current);
      seq.current += 1;
      const actions = (Array.isArray(action) ? action : action ? [action] : []).slice(0, 2);
      setItem({ id: seq.current, message, actions });
      timer.current = setTimeout(() => setItem(null), actions.length > 1 ? 12000 : actions.length ? 8000 : 4000);
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
        className="pointer-events-none fixed inset-x-0 bottom-[calc(18px+env(safe-area-inset-bottom)+var(--toast-lift,0px))] z-[70] flex justify-center px-16"
      >
        {item ? (
          <div
            key={item.id}
            className="anim-fade pointer-events-auto flex max-w-[min(560px,100%)] items-center gap-14 rounded-md bg-fg px-14 py-8 text-13 text-canvas"
          >
            <span className="min-w-0">{item.message}</span>
            {item.actions.map((a) => (
              <button
                key={a.label}
                type="button"
                className="shrink-0 border-0 bg-transparent p-0 font-semibold whitespace-nowrap text-canvas underline underline-offset-2"
                onClick={() => {
                  a.onClick();
                  dismiss();
                }}
              >
                {a.label}
              </button>
            ))}
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

/**
 * Keep the toast above a bar near the bottom of the viewport (a selection bar, the Today
 * queue's "Next follow-up?" strip), so "Undo" never covers the buttons under it. While
 * `active`, the toast rises by however much of the element sits in the bottom 80px.
 */
export function useToastLift(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const root = document.documentElement;
    if (!active) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const el = ref.current;
        const vh = window.innerHeight;
        const r = el?.getBoundingClientRect();
        const lift = r && r.bottom > vh - 80 && r.top < vh ? Math.round(vh - r.top) : 0;
        root.style.setProperty("--toast-lift", `${lift}px`);
      });
    };
    measure();
    window.addEventListener("scroll", measure, { passive: true, capture: true });
    window.addEventListener("resize", measure);
    const ro = typeof ResizeObserver !== "undefined" && ref.current ? new ResizeObserver(measure) : null;
    if (ro && ref.current) ro.observe(ref.current);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", measure, { capture: true });
      window.removeEventListener("resize", measure);
      ro?.disconnect();
      root.style.removeProperty("--toast-lift");
    };
  }, [ref, active]);
}
