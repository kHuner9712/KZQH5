// PostgreSQL's uuid type accepts any canonical 128-bit UUID value.
// It does not require RFC 4122 version bits (1-5) or variant bits (8/9/a/b).
//
// Some legacy/demo records in this project intentionally use deterministic
// UUID-shaped identifiers such as 77777777-7777-7777-7777-777777777701.
// Those values are valid for PostgreSQL uuid columns even though they are not
// RFC 4122 generated UUIDs. API validation must match the database contract.
export const POSTGRES_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isPostgresUuid(value: unknown): value is string {
  return typeof value === "string" && POSTGRES_UUID_PATTERN.test(value);
}
