"use client";

import { createContext, useCallback, useContext, useState } from "react";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";

type ToastType = "success" | "error" | "info";
interface Toast {
  id: number;
  type: ToastType;
  message: string;
}

interface ToastContextValue {
  show: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast 必须在 ToastProvider 内使用");
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const show = useCallback((message: string, type: ToastType = "success") => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3000);
  }, []);

  const remove = (id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div className="fixed right-4 top-4 z-[100] flex flex-col gap-2">
        {toasts.map((t) => {
          const Icon =
            t.type === "success" ? CheckCircle2 : t.type === "error" ? AlertCircle : Info;
          return (
            <div
              key={t.id}
              className={cn(
                "flex items-start gap-2 rounded-lg px-4 py-3 text-sm shadow-lg ring-1 animate-slide-up",
                t.type === "success" && "bg-white text-emerald-700 ring-emerald-200",
                t.type === "error" && "bg-white text-red-700 ring-red-200",
                t.type === "info" && "bg-white text-steel ring-steel/20"
              )}
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="flex-1">{t.message}</span>
              <button onClick={() => remove(t.id)} aria-label="关闭">
                <X className="h-3.5 w-3.5 text-gray-400" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
