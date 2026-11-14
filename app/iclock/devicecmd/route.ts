import { textResponse } from "@/lib/services/iclock";

// Machine reports command results; none are sent, so just acknowledge.
export async function POST() {
  return textResponse("OK");
}
