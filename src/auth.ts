import { timingSafeEqual } from "node:crypto";

/** Constant-time check of an `Authorization: Bearer <token>` header against the configured secret. */
export function bearerMatches(authorizationHeader: string | null | undefined, expected: string | undefined): boolean {
  if (!expected) return false;
  const m = /^Bearer\s+(.+)$/i.exec(authorizationHeader ?? "");
  if (!m) return false;
  const a = Buffer.from(m[1].trim());
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
