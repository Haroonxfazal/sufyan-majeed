import { findDevice, heartbeat, textResponse } from "@/lib/services/iclock";
import { parseDeviceTime, savePunches, type Punch } from "@/lib/services/punches";

// Machine asks for its settings when it connects.
export async function GET(request: Request) {
  const sn = new URL(request.url).searchParams.get("SN");
  const ctx = await findDevice(sn);
  if (!ctx) return textResponse("Unknown device", 403);
  await heartbeat(ctx);
  return textResponse(
    [
      `GET OPTION FROM: ${sn}`,
      // "None" = upload every attendance record not yet sent (duplicates are ignored on our side)
      "ATTLOGStamp=None",
      "OPERLOGStamp=9999",
      "ATTPHOTOStamp=None",
      "ErrorDelay=30",
      "Delay=10",
      "TransTimes=00:00;12:00",
      "TransInterval=1",
      "TransFlag=TransData AttLog\tOpLog\tAttPhoto\tEnrollUser\tChgUser\tEnrollFP\tChgFP\tFPImag",
      "TimeZone=5",
      "Realtime=1",
      "Encrypt=None",
    ].join("\n") + "\n",
  );
}

// Machine pushes data. Only attendance rows (table=ATTLOG) are kept.
export async function POST(request: Request) {
  const url = new URL(request.url);
  const ctx = await findDevice(url.searchParams.get("SN"));
  if (!ctx) return textResponse("Unknown device", 403);

  if (url.searchParams.get("table") !== "ATTLOG") {
    await heartbeat(ctx);
    return textResponse("OK");
  }

  const body = await request.text();
  const punches: Punch[] = [];
  for (const line of body.split(/\r?\n/)) {
    // columns: PIN, time, status (0 in / 1 out), verify mode, workcode ...
    const cols = line.split("\t");
    if (cols.length < 2) continue;
    const pin = cols[0].trim();
    const punchedAt = parseDeviceTime(cols[1]);
    if (!pin || !punchedAt) continue;
    punches.push({ zkUserId: pin, punchedAt, punch: Number(cols[2]) || 0, status: Number(cols[3]) || 0 });
  }

  try {
    const saved = await savePunches(ctx.supabase, ctx.id, punches);
    await heartbeat(ctx);
    return textResponse(`OK: ${saved}`);
  } catch (err) {
    // A non-OK reply makes the machine keep the records and retry later.
    return textResponse(err instanceof Error ? err.message : "Save failed", 500);
  }
}
