import { createAdminClient } from "@/lib/supabase/admin";

/**
 * ZKTeco "ADMS" / iClock push protocol: the fingerprint machine itself calls these URLs
 * over the internet (no academy PC needed). The machine cannot log in, so access is limited
 * to devices whose serial number (SN) is registered in the devices table.
 */
export function textResponse(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
  });
}

export async function findDevice(sn: string | null) {
  if (!sn) return null;
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("devices")
    .select("id")
    .eq("serial_number", sn)
    .eq("is_active", true)
    .maybeSingle();
  return data ? { supabase, id: data.id as string } : null;
}

/** Marks the machine online; the dashboard reads devices.updated_at as the heartbeat. */
export async function heartbeat(ctx: NonNullable<Awaited<ReturnType<typeof findDevice>>>) {
  const now = new Date().toISOString();
  await ctx.supabase
    .from("devices")
    .update({ status: "online", last_error: null, last_seen_at: now, updated_at: now })
    .eq("id", ctx.id);
}
