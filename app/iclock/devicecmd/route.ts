import { textResponse } from "@/lib/services/iclock";

// Machine reports command results (the relay logs the body); just acknowledge.
export async function POST() {
  return textResponse("OK");
}
