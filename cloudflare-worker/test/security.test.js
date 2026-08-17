import assert from "node:assert/strict";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import test from "node:test";

import {
  base64UrlEncode,
  createSession,
  csrfMatches,
  readSession,
  sessionCookie,
  verifyPassword,
} from "../src/security.js";

test("PBKDF2 password verification accepts only the matching password", async () => {
  const salt = randomBytes(16);
  const iterations = 210000;
  const digest = pbkdf2Sync("correct horse", salt, iterations, 32, "sha256");
  const encoded = `pbkdf2_sha256$${iterations}$${base64UrlEncode(salt)}$${base64UrlEncode(digest)}`;
  assert.equal(await verifyPassword("correct horse", encoded), true);
  assert.equal(await verifyPassword("wrong horse", encoded), false);
  assert.equal(await verifyPassword("correct horse", "invalid"), false);
});

test("signed session is authenticated, expires, and carries CSRF", async () => {
  const secret = "12345678901234567890123456789012";
  const token = await createSession(secret, 1000);
  const cookie = sessionCookie(token).split(";", 1)[0];
  const request = new Request("https://example.com/api/workspace", { headers: { Cookie: cookie } });
  const session = await readSession(request, secret, 1001);
  assert.ok(session);
  assert.equal(await readSession(request, "00000000000000000000000000000000", 1001), null);
  assert.equal(await readSession(request, secret, 1000 + 31 * 24 * 60 * 60), null);
  assert.equal(csrfMatches(new Request("https://example.com", { headers: { "X-CSRF-Token": session.csrf } }), session), true);
  assert.equal(csrfMatches(new Request("https://example.com", { headers: { "X-CSRF-Token": "wrong" } }), session), false);
});
