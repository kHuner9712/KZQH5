export function classifyProtectedReadResult({ data, error }) {
  if (error) {
    return error.code === "42501"
      ? { ok: true, mode: "grant-denied" }
      : { ok: false, mode: "unexpected-error" };
  }

  if (!Array.isArray(data)) {
    return { ok: false, mode: "unexpected-error" };
  }

  return data.length === 0
    ? { ok: true, mode: "rls-filtered" }
    : { ok: false, mode: "visible-data" };
}
