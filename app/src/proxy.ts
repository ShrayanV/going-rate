import { NextResponse, type NextRequest } from "next/server";

/**
 * Password gate for the deployed demo. When SITE_PASSWORD is set, every request
 * (pages, API routes, static files) needs HTTP Basic auth with that password; any
 * username works. Unset locally, so `npm run dev` stays open.
 * The predictions contain fields derived from Microburbs' supplied files, which
 * must not be republished, so the hosted site is never public.
 */
export function proxy(req: NextRequest) {
  const password = process.env.SITE_PASSWORD;
  if (!password) return NextResponse.next();

  const header = req.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice(6));
      const given = decoded.slice(decoded.indexOf(":") + 1);
      if (given.length === password.length && timingSafeEqual(given, password)) return NextResponse.next();
    } catch {
      /* malformed header: fall through to the challenge */
    }
  }
  return new NextResponse("Password required.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Going Rate demo", charset="UTF-8"', "Cache-Control": "no-store" },
  });
}

function timingSafeEqual(a: string, b: string) {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
