import { findDevice, heartbeat, textResponse } from "@/lib/services/iclock";
import { parseDeviceTime, savePunches, type Punch } from "@/lib/services/punches";

/**
 * The machine answers a "DATA QUERY" command here (newer ZKTeco push firmware).
 * Rows look like tab-separated key=value pairs, e.g. "pin=2\ttime=2026-11-14 16:52:30\tstatus=0".
 * The parser is tolerant about field names.
 */
const PIN_KEYS = ["pin", "userid", "user_pin", "badgenumber", "cardno"];
const TIME_KEYS = ["time", "verify_time", "checktime", "datetime", "punch_time"];

export async function POST(request: Request) {
  const ctx = await findDevice(new URL(request.url).searchParams.get("SN"));
  if (!ctx) return textResponse("Unknown device", 403);

  const body = await request.text();
  const punches: Punch[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.includes("=")) continue;
    const row: Record<string, string> = {};
    for (const part of line.split("\t")) {
      const i = part.indexOf("=");
      if (i > 0) row[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
    }
    const pin = PIN_KEYS.map((k) => row[k]).find(Boolean);
    const timeRaw = TIME_KEYS.map((k) => row[k]).find(Boolean);
    const punchedAt = timeRaw ? parseDeviceTime(timeRaw) : null;
    if (!pin || !punchedAt) continue;
    punches.push({ zkUserId: pin, punchedAt, punch: Number(row.status) || 0 });
  }

  try {
    await savePunches(ctx.supabase, ctx.id, punches);
    await heartbeat(ctx);
    return textResponse("OK");
  } catch (err) {
    return textResponse(err instanceof Error ? err.message : "Save failed", 500);
  }
}
