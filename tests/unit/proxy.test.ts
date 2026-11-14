import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

let configured = true;
let user: { id: string } | null = null;

vi.mock("@/lib/supabase/env", () => ({
  getSupabasePublicEnv: () => (configured ? { url: "https://x.supabase.co", anonKey: "anon" } : null),
}));
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user } }) } }),
}));

const { updateSession } = await import("@/lib/supabase/middleware");
const go = (path: string) => updateSession(new NextRequest(`https://site.test${path}`));
const location = (res: Response) => res.headers.get("location");

beforeEach(() => {
  configured = true;
  user = null;
});

describe("login proxy", () => {
  it.each(["/", "/students", "/attendance", "/fees", "/sms", "/settings", "/device"])(
    "anonymous %s -> /login?next=…",
    async (path) => {
      const res = await go(path);
      expect(res.status).toBe(307);
      expect(location(res)).toBe(`https://site.test/login?next=${encodeURIComponent(path)}`);
    },
  );

  it.each(["/login", "/api/health", "/api/students", "/iclock/getrequest", "/auth/callback"])(
    "anonymous %s is let through (routes check auth themselves)",
    async (path) => {
      expect(location(await go(path))).toBeNull();
    },
  );

  it("signed-in users can open pages, and /login sends them home", async () => {
    user = { id: "u" };
    expect(location(await go("/students"))).toBeNull();
    expect(location(await go("/login"))).toBe("https://site.test/");
  });

  it("without Supabase settings everything goes to the setup screen", async () => {
    configured = false;
    expect(location(await go("/students"))).toBe("https://site.test/login?setup=1");
    expect(location(await go("/login"))).toBeNull();
  });
});
