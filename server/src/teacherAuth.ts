import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

const COOKIE = "teacher";
const SESSION_HOURS = 12;

function digest(s: string) {
  return createHash("sha256").update(s).digest();
}

export function passwordMatches(given: string, expected: string) {
  return timingSafeEqual(digest(given), digest(expected));
}

/** Sets a signed cookie holding the time the teacher signed in. */
export function startTeacherSession(reply: FastifyReply) {
  reply.setCookie(COOKIE, String(Date.now()), {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    secure: "auto",
    signed: true,
    maxAge: SESSION_HOURS * 3600,
  });
}

export function endTeacherSession(reply: FastifyReply) {
  reply.clearCookie(COOKIE, { path: "/" });
}

export function isTeacher(req: FastifyRequest) {
  const raw = req.cookies[COOKIE];
  if (!raw) return false;
  const { valid, value } = req.unsignCookie(raw);
  if (!valid || !value) return false;
  const issued = Number(value);
  return Number.isFinite(issued) && Date.now() - issued < SESSION_HOURS * 3600 * 1000;
}
