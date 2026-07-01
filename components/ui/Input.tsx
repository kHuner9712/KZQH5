import { cn } from "@/lib/utils";
import { InputHTMLAttributes, TextareaHTMLAttributes, forwardRef } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  required?: boolean;
  hint?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, error, required, hint, id, ...props }, ref) => {
    const inputId = id || props.name;
    return (
      <div className="space-y-1.5">
        {label && (
          <label
            htmlFor={inputId}
            className="block text-[12px] font-medium text-ink-soft"
          >
            {label}
            {required && <span className="ml-0.5 text-red-500">*</span>}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          className={cn(
            "h-11 w-full rounded-xl border bg-white px-3.5 text-sm text-ink outline-none transition placeholder:text-ink-mute focus:border-industrial focus:ring-2 focus:ring-industrial/15",
            error ? "border-red-400" : "border-ink-line",
            className
          )}
          {...props}
        />
        {hint && !error && <p className="text-[11px] text-ink-mute">{hint}</p>}
        {error && <p className="text-[11px] text-red-500">{error}</p>}
      </div>
    );
  }
);
Input.displayName = "Input";

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  required?: boolean;
  hint?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, label, error, required, hint, id, ...props }, ref) => {
    const inputId = id || props.name;
    return (
      <div className="space-y-1.5">
        {label && (
          <label
            htmlFor={inputId}
            className="block text-[12px] font-medium text-ink-soft"
          >
            {label}
            {required && <span className="ml-0.5 text-red-500">*</span>}
          </label>
        )}
        <textarea
          ref={ref}
          id={inputId}
          className={cn(
            "w-full rounded-xl border bg-white px-3.5 py-2.5 text-sm text-ink outline-none transition placeholder:text-ink-mute focus:border-industrial focus:ring-2 focus:ring-industrial/15",
            error ? "border-red-400" : "border-ink-line",
            className
          )}
          {...props}
        />
        {hint && !error && <p className="text-[11px] text-ink-mute">{hint}</p>}
        {error && <p className="text-[11px] text-red-500">{error}</p>}
      </div>
    );
  }
);
Textarea.displayName = "Textarea";
