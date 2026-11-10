import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";

/** The academy agent touches devices.updated_at every ~5 seconds while it runs. */
export const AGENT_STALE_SECONDS = 20;

export function isAgentOnline(updatedAt: string | null | undefined, now = Date.now()) {
  if (!updatedAt) return false;
  return now - new Date(updatedAt).getTime() < AGENT_STALE_SECONDS * 1000;
}

export async function getAgentOnline() {
  if (!isSupabaseConfigured()) return false;
  const supabase = await createClient();
  const { data } = await supabase
    .from("devices")
    .select("updated_at")
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return isAgentOnline(data?.updated_at);
}
