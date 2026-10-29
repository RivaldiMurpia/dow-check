// Anonymous per-browser identity. No login: each browser gets its own user
// row, carried by an httpOnly cookie, so histories stay isolated per browser
// (incognito starts empty) while the first question is never blocked.
import { createUser, findUser } from "./store.mjs";

export const USER_COOKIE = "dc_uid";

// Resolve the user for a request, creating a fresh one when the cookie is
// missing or unknown. Returns { user, isNew }.
export async function resolveUser(request) {
  const cookieHeader = request.headers.get("cookie") || "";
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${USER_COOKIE}=([^;]+)`));
  const cookieId = match ? decodeURIComponent(match[1]) : null;
  if (cookieId) {
    const existing = await findUser(cookieId);
    if (existing) return { user: existing, isNew: false };
  }
  const user = await createUser();
  return { user, isNew: true };
}

// Attach the identity cookie to a response for newly created users.
export function applyUserCookie(response, { user, isNew }) {
  if (isNew && user?.id) {
    response.cookies.set(USER_COOKIE, user.id, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  return response;
}
