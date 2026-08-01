"use client";

import { MfaEnrollment } from "@/components/admin/MfaEnrollment";

export default function SecurityPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-graphite">账号安全</h1>
        <p className="mt-1 text-sm text-gray-500">
          管理管理员账号的双重验证（MFA）绑定与状态
        </p>
      </div>
      <MfaEnrollment />
    </div>
  );
}
