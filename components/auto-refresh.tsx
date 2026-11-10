"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-fetches the page's server data every few seconds (default 2s) without a full reload.
 * Pauses while the browser tab is hidden so idle tabs don't use requests.
 */
export function AutoRefresh({ seconds = 2 }: { seconds?: number }) {
  const router = useRouter();

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);
    return () => clearInterval(timer);
  }, [router, seconds]);

  return null;
}
