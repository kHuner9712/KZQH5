import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "@/lib/utils";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  required?: boolean;
  hint?: string;
  containerClassName?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    {
      className,
      containerClassName,
      label,
      error,
      required,
      hint,
      id,
      "aria-describedby": ariaDescribedBy,
      ...props
    },
    ref,
  ) => {
    const generatedId = useId();
    const inputId = id || props.name || generatedId;
    const errorId = `${inputId}-error`;
    const hintId = `${inputId}-hint`;
    const describedBy =
      [ariaDescribedBy, error ? errorId : hint ? hintId : null]
        .filter(Boolean)
        .join(" ") || undefined;

    return (
      <div className={cn("space-y-1.5", containerClassName)}>
        {label && (
          <label
            htmlFor={inputId}
            className="block text-xs font-medium text-ink-soft"
          >
            {label}
            {required && <span className="ml-0.5 text-red-600">*</span>}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            "h-11 w-full rounded-md border bg-white px-3.5 text-sm text-ink outline-none transition placeholder:text-ink-mute focus:border-gold focus:ring-2 focus:ring-gold/15",
            error ? "border-red-500" : "border-ink-line",
            className,
          )}
          {...props}
        />
        {hint && !error && (
          <p id={hintId} className="text-[11px] text-ink-mute">
            {hint}
          </p>
        )}
        {error && (
          <p id={errorId} className="text-[11px] text-red-600" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  },
);
Input.displayName = "Input";

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  required?: boolean;
  hint?: string;
  containerClassName?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  (
    {
      className,
      containerClassName,
      label,
      error,
      required,
      hint,
      id,
      "aria-describedby": ariaDescribedBy,
      ...props
    },
    ref,
  ) => {
    const generatedId = useId();
    const inputId = id || props.name || generatedId;
    const errorId = `${inputId}-error`;
    const hintId = `${inputId}-hint`;
    const describedBy =
      [ariaDescribedBy, error ? errorId : hint ? hintId : null]
        .filter(Boolean)
        .join(" ") || undefined;

    return (
      <div className={cn("space-y-1.5", containerClassName)}>
        {label && (
          <label
            htmlFor={inputId}
            className="block text-xs font-medium text-ink-soft"
          >
            {label}
            {required && <span className="ml-0.5 text-red-600">*</span>}
          </label>
        )}
        <textarea
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            "w-full rounded-md border bg-white px-3.5 py-2.5 text-sm text-ink outline-none transition placeholder:text-ink-mute focus:border-gold focus:ring-2 focus:ring-gold/15",
            error ? "border-red-500" : "border-ink-line",
            className,
          )}
          {...props}
        />
        {hint && !error && (
          <p id={hintId} className="text-[11px] text-ink-mute">
            {hint}
          </p>
        )}
        {error && (
          <p id={errorId} className="text-[11px] text-red-600" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  },
);
Textarea.displayName = "Textarea";
