import { describe, expect, it } from "vitest";
import { displayDate, formatPkr, monthStartInKarachi, todayInKarachi } from "@/lib/utils";
import { isAgentOnline, AGENT_STALE_SECONDS } from "@/lib/services/agent-status";

describe("utils", () => {
  it("formats PKR without decimals", () => {
    expect(formatPkr(2500)).toMatch(/2,500/);
    expect(formatPkr("1234.6")).toMatch(/1,235/);
  });

  it("treats invalid amounts as zero", () => {
    expect(formatPkr(undefined)).toMatch(/0/);
    expect(formatPkr("abc")).toMatch(/0/);
  });

  it("returns today's date in Karachi as YYYY-MM-DD", () => {
    expect(todayInKarachi()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(monthStartInKarachi()).toBe(`${todayInKarachi().slice(0, 7)}-01`);
  });

  it("shows a dash for empty dates and Karachi date otherwise", () => {
    expect(displayDate(null)).toBe("—");
    // 20:00 UTC on 14 Nov is already 15 Nov in Pakistan
    expect(displayDate("2026-11-14T20:00:00Z")).toBe("15 Nov 2026");
  });
});

describe("agent / device online status", () => {
  const now = Date.parse("2026-11-14T12:00:00Z");

  it("is offline with no heartbeat", () => {
    expect(isAgentOnline(null, now)).toBe(false);
  });

  it("is online within the stale window and offline after it", () => {
    expect(AGENT_STALE_SECONDS).toBe(45);
    expect(isAgentOnline(new Date(now - 10_000).toISOString(), now)).toBe(true);
    expect(isAgentOnline(new Date(now - 44_000).toISOString(), now)).toBe(true);
    expect(isAgentOnline(new Date(now - 46_000).toISOString(), now)).toBe(false);
  });
});
