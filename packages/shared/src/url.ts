/**
 * Loopback-URL validation shared with the frontend. The authoritative
 * detector lives in `rootray-core` (`process::url_detect`); this mirrors its
 * acceptance rules so the UI can gate "Open Browser" actions without a
 * round-trip.
 */

const LOOPBACK_HOSTNAMES = new Set(["localhost", "::1", "[::1]", "0.0.0.0"]);

function isLoopbackHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (LOOPBACK_HOSTNAMES.has(lower)) return true;
  if (lower.endsWith(".localhost")) return true;
  // 127.0.0.0/8
  if (/^127(?:\.\d{1,3}){3}$/.test(lower)) {
    return lower.split(".").every((octet) => Number.parseInt(octet, 10) <= 255);
  }
  return false;
}

/** Returns true only for http(s) URLs pointing at a loopback address. */
export function isLoopbackUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return isLoopbackHostname(url.hostname);
}

/** Extracts the port from a URL string, or null when unavailable. */
export function urlPort(raw: string): number | null {
  try {
    const url = new URL(raw);
    if (url.port) return Number.parseInt(url.port, 10);
    if (url.protocol === "http:") return 80;
    if (url.protocol === "https:") return 443;
    return null;
  } catch {
    return null;
  }
}
