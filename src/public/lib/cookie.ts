// Tiny cookie helpers used by the public SSR pages.
//
// Pure string-in / string-out. No Request / Env imports so any Hono
// handler (and any test) can call them without ceremony.
//
// The parser is deliberately forgiving — malformed pairs are dropped
// silently so a misbehaving third-party cookie never takes down a
// page render. The builder emits a standards-compliant Set-Cookie
// string with our defaults (Path=/, SameSite=Lax) baked in.

export function parseCookie(header: string | null | undefined): Record<string, string> {
  if (!header) return {};
  const result: Record<string, string> = {};
  for (const rawPair of header.split(";")) {
    const pair = rawPair.trim();
    if (pair.length === 0) continue;
    const eq = pair.indexOf("=");
    if (eq === -1) continue; // malformed — no value
    const name = pair.slice(0, eq).trim();
    const rawValue = pair.slice(eq + 1).trim();
    if (name.length === 0) continue;
    let decoded = rawValue;
    try {
      decoded = decodeURIComponent(rawValue);
    } catch {
      // Keep the raw value on malformed percent-encoding. A cookie
      // with garbage in it shouldn't crash the render.
    }
    result[name] = decoded;
  }
  return result;
}

export interface SetCookieOptions {
  name: string;
  value: string;
  /** Seconds until expiry. Use 0 to clear. */
  maxAge: number;
  /**
   * Path attribute. Defaults to "/" — our user-preference cookies are
   * shared across every route.
   */
  path?: string;
  /** SameSite — defaults to Lax (right default for GET filter toggles). */
  sameSite?: "Lax" | "Strict" | "None";
  /** Secure attribute. Defaults to true so previews + prod stay HTTPS-only. */
  secure?: boolean;
  /** HttpOnly attribute. Defaults to false — the SPA may need to read the value. */
  httpOnly?: boolean;
}

export function buildSetCookie(opts: SetCookieOptions): string {
  const {
    name,
    value,
    maxAge,
    path = "/",
    sameSite = "Lax",
    secure = true,
    httpOnly = false,
  } = opts;
  const parts: string[] = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${path}`);
  parts.push(`Max-Age=${maxAge}`);
  parts.push(`SameSite=${sameSite}`);
  if (secure) parts.push("Secure");
  if (httpOnly) parts.push("HttpOnly");
  return parts.join("; ");
}
