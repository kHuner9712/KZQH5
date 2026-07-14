"use client";

import { X } from "lucide-react";
import { useRef } from "react";
import { Button } from "@/components/ui/Button";
import { useDialogFocusTrap } from "@/lib/client/use-dialog-focus-trap";

// ============================================================
// 通用：Modal 容器
// ============================================================
export function Modal({
  title,
  onClose,
  children,
  size = "md",
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  size?: "md" | "lg";
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocusTrap({ active: true, containerRef: dialogRef, onClose });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-modal-title"
        tabIndex={-1}
        className={`relative max-h-[90vh] w-full overflow-y-auto rounded-2xl bg-white shadow-2xl ${
          size === "lg" ? "max-w-3xl" : "max-w-lg"
        }`}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-gray-100 bg-white px-5 py-3.5">
          <h2 id="admin-modal-title" className="text-sm font-semibold text-graphite">{title}</h2>
          <button onClick={onClose} data-dialog-autofocus className="flex h-10 w-10 items-center justify-center text-gray-400 hover:text-gray-600" aria-label="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

// ============================================================
// 通用：表单底部按钮
// ============================================================
export function FormActions({
  onClose,
  saving,
  isEdit,
}: {
  onClose: () => void;
  saving: boolean;
  isEdit: boolean;
}) {
  return (
    <div className="flex justify-end gap-2 border-t border-gray-100 pt-4">
      <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
        取消
      </Button>
      <Button type="submit" loading={saving} disabled={saving}>
        {saving ? "保存中..." : isEdit ? "保存修改" : "创建"}
      </Button>
    </div>
  );
}
