import { findDevice, heartbeat, textResponse } from "@/lib/services/iclock";

// Machine polls this every few seconds to ask for commands. Doubles as the heartbeat.
// We have no commands to send (this firmware answers every command with UNKNOWN CMD).
export async function GET(request: Request) {
  const ctx = await findDevice(new URL(request.url).searchParams.get("SN"));
  if (!ctx) return textResponse("Unknown device", 403);
  await heartbeat(ctx);
  return textResponse("OK");
}
