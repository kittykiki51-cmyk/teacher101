const encoder = new TextEncoder();

export const SESSION_COOKIE = "__Host-teacher_session";
export const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
export const LOGIN_WINDOW_SECONDS = 15 * 60;
export const LOGIN_ATTEMPT_LIMIT = 8;

export function base64UrlEncode(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function base64UrlDecode(value) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const binary = atob((value + padding).replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

export async function verifyPassword(password, encodedHash) {
  const [algorithm, iterationsValue, saltValue, hashValue] = String(encodedHash || "").split("$");
  const iterations = Number(iterationsValue);
  if (algorithm !== "pbkdf2_sha256" || !Number.isInteger(iterations) || iterations < 210000) return false;
  let salt;
  let expected;
  try {
    salt = base64UrlDecode(saltValue);
    expected = base64UrlDecode(hashValue);
  } catch {
    return false;
  }
  if (salt.length < 16 || expected.length !== 32) return false;
  const sourceKey = await crypto.subtle.importKey("raw", encoder.encode(String(password)), "PBKDF2", false, ["deriveBits"]);
  const actual = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    sourceKey,
    256,
  ));
  return constantTimeEqual(actual, expected);
}

export async function createSession(secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (String(secret || "").length < 32) throw new Error("SESSION_SECRET 必須至少 32 字元");
  const csrfBytes = new Uint8Array(32);
  crypto.getRandomValues(csrfBytes);
  const payload = base64UrlEncode(encoder.encode(JSON.stringify({
    exp: nowSeconds + SESSION_MAX_AGE,
    csrf: base64UrlEncode(csrfBytes),
  })));
  const signature = base64UrlEncode(await hmac(secret, payload));
  return `${payload}.${signature}`;
}

function cookieValue(request, name) {
  const cookies = request.headers.get("Cookie") || "";
  for (const part of cookies.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return "";
}

export async function readSession(request, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  const token = cookieValue(request, SESSION_COOKIE);
  const separator = token.lastIndexOf(".");
  if (separator < 1 || String(secret || "").length < 32) return null;
  const payloadValue = token.slice(0, separator);
  const suppliedSignature = token.slice(separator + 1);
  let expectedSignature;
  try {
    expectedSignature = base64UrlEncode(await hmac(secret, payloadValue));
  } catch {
    return null;
  }
  if (!constantTimeEqual(encoder.encode(suppliedSignature), encoder.encode(expectedSignature))) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadValue)));
    if (!Number.isInteger(payload.exp) || payload.exp <= nowSeconds || typeof payload.csrf !== "string" || payload.csrf.length < 32) return null;
    return payload;
  } catch {
    return null;
  }
}

export function sessionCookie(token) {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_MAX_AGE}; HttpOnly; Secure; SameSite=Strict`;
}

export function expiredSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

export function csrfMatches(request, session) {
  const supplied = request.headers.get("X-CSRF-Token") || "";
  return constantTimeEqual(encoder.encode(supplied), encoder.encode(String(session?.csrf || "")));
}

export async function clientKey(request, secret) {
  const address = request.headers.get("CF-Connecting-IP") || "unknown";
  const digest = await hmac(secret, `login:${address}`);
  return base64UrlEncode(digest);
}
