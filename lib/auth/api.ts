import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { canManageRecords } from "@/lib/auth/roles";
import type { StaffRole } from "@/lib/constants";

/**
 * Guard for API routes (the proxy treats /api as public, so every route must check itself).
 * Returns a NextResponse to send back when access is denied, or null when allowed.
 * Requires a logged-in, active staff member with a write role.
 */
export async function requireStaff(): Promise<NextResponse | null> {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "Supabase is not configured" }, { status: 500 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, is_active")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile?.is_active || !canManageRecords(profile.role as StaffRole)) {
    return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  }

  return null;
}
