import { describe, expect, it } from "vitest";
import { parseDeviceTime, savePunches } from "@/lib/services/punches";
import { createFakeSupabase, type Call } from "../helpers/fake-supabase";

const STUDENTS = [
  { id: "stu-ali", zk_user_id: "2" },
  { id: "stu-sara", zk_user_id: "5" },
];
const STAFF = [{ id: "staff-1", zk_user_id: "90" }];

function db(existingDaily: unknown[] = []) {
  return createFakeSupabase((call: Call) => {
    if (call.table === "students" && call.op === "select") return { data: STUDENTS };
    if (call.table === "staff" && call.op === "select") return { data: STAFF };
    if (call.table === "daily_attendance" && call.op === "select") return { data: existingDaily };
    return { data: null };
  });
}

const pkt = (s: string) => parseDeviceTime(s)!;

describe("parseDeviceTime", () => {
  it("reads machine time as Pakistan time (UTC+5)", () => {
    expect(pkt("2026-11-14 21:35:55").toISOString()).toBe("2026-11-14T16:35:55.000Z");
    expect(pkt("2026-11-14T08:00:00").toISOString()).toBe("2026-11-14T03:00:00.000Z");
  });

  it.each(["", "garbage", "2026-11-14", "14/11/2026 08:00:00", "2026-13-45 99:99:99"])(
    "rejects %j",
    (value) => expect(parseDeviceTime(value)).toBeNull(),
  );
});

describe("savePunches", () => {
  it("does nothing for an empty list", async () => {
    const fake = db();
    expect(await savePunches(fake as never, "dev", [])).toBe(0);
    expect(fake.calls).toHaveLength(0);
  });

  it("logs every punch and marks a student present with the EARLIEST check-in", async () => {
    const fake = db();
    const n = await savePunches(fake as never, "dev-1", [
      { zkUserId: "2", punchedAt: pkt("2026-11-14 09:10:00") },
      { zkUserId: "2", punchedAt: pkt("2026-11-14 08:05:00") },
      { zkUserId: "2", punchedAt: pkt("2026-11-14 13:00:00"), punch: 1 },
    ]);
    expect(n).toBe(3);

    const upsert = fake.calls.find((c) => c.table === "attendance_logs")!;
    expect(upsert.op).toBe("upsert");
    expect(upsert.options).toEqual({ onConflict: "device_id,zk_user_id,punched_at", ignoreDuplicates: true });
    const rows = upsert.payload as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.punch_type)).toEqual(["check_in", "check_in", "check_out"]);
    expect(rows.every((r) => r.student_id === "stu-ali" && r.person_type === "student" && r.device_id === "dev-1")).toBe(true);

    const insert = fake.calls.find((c) => c.table === "daily_attendance" && c.op === "insert")!;
    expect(insert.payload).toEqual([
      {
        person_type: "student",
        student_id: "stu-ali",
        attendance_date: "2026-11-14",
        status: "present",
        check_in_at: "2026-11-14T03:05:00.000Z",
        source: "device",
      },
    ]);
  });

  it("uses the Pakistan date, not the UTC date, for late-night punches", async () => {
    const fake = db();
    await savePunches(fake as never, "dev", [{ zkUserId: "5", punchedAt: pkt("2026-11-15 00:30:00") }]);
    const insert = fake.calls.find((c) => c.table === "daily_attendance" && c.op === "insert")!;
    expect((insert.payload as Array<Record<string, unknown>>)[0].attendance_date).toBe("2026-11-15");
  });

  it("turns an ABSENT mark into PRESENT", async () => {
    const fake = db([{ id: "d1", student_id: "stu-ali", attendance_date: "2026-11-14", status: "absent", check_in_at: null }]);
    await savePunches(fake as never, "dev", [{ zkUserId: "2", punchedAt: pkt("2026-11-14 10:00:00") }]);
    const update = fake.calls.find((c) => c.table === "daily_attendance" && c.op === "update")!;
    expect(update.payload).toMatchObject({ status: "present", check_in_at: "2026-11-14T05:00:00.000Z" });
    expect(update.filters).toContainEqual(["eq", "id", "d1"]);
    expect(fake.calls.some((c) => c.table === "daily_attendance" && c.op === "insert")).toBe(false);
  });

  it("moves the check-in earlier but never later, and keeps manual statuses like 'late'", async () => {
    const existing = { id: "d1", student_id: "stu-ali", attendance_date: "2026-11-14", status: "late", check_in_at: "2026-11-14T04:00:00Z" };

    const later = db([existing]);
    await savePunches(later as never, "dev", [{ zkUserId: "2", punchedAt: pkt("2026-11-14 10:00:00") }]);
    expect(later.calls.some((c) => c.op === "update")).toBe(false);

    const earlier = db([existing]);
    await savePunches(earlier as never, "dev", [{ zkUserId: "2", punchedAt: pkt("2026-11-14 08:00:00") }]);
    const update = earlier.calls.find((c) => c.op === "update")!;
    expect(update.payload).toMatchObject({ status: "late", check_in_at: "2026-11-14T03:00:00.000Z" });
  });

  it("keeps unknown and staff fingerprints in the log without marking any student", async () => {
    const fake = db();
    await savePunches(fake as never, "dev", [
      { zkUserId: "77", punchedAt: pkt("2026-11-14 08:00:00") },
      { zkUserId: "90", punchedAt: pkt("2026-11-14 08:01:00") },
    ]);
    const rows = fake.calls.find((c) => c.table === "attendance_logs")!.payload as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ zk_user_id: "77", person_type: null, student_id: null, staff_id: null });
    expect(rows[1]).toMatchObject({ zk_user_id: "90", person_type: "staff", staff_id: "staff-1", student_id: null });
    expect(fake.calls.some((c) => c.table === "daily_attendance")).toBe(false);
  });

  it("marks several students on several days in one batch", async () => {
    const fake = db();
    await savePunches(fake as never, "dev", [
      { zkUserId: "2", punchedAt: pkt("2026-11-13 08:00:00") },
      { zkUserId: "2", punchedAt: pkt("2026-11-14 08:00:00") },
      { zkUserId: "5", punchedAt: pkt("2026-11-14 08:30:00") },
    ]);
    const insert = fake.calls.find((c) => c.table === "daily_attendance" && c.op === "insert")!;
    const marks = (insert.payload as Array<Record<string, unknown>>).map((r) => `${r.student_id}@${r.attendance_date}`);
    expect(marks.sort()).toEqual(["stu-ali@2026-11-13", "stu-ali@2026-11-14", "stu-sara@2026-11-14"]);
  });

  it("throws when the database rejects the log write (so the machine retries)", async () => {
    const fake = createFakeSupabase((call) =>
      call.table === "attendance_logs" ? { error: { message: "db down" } } : { data: [] },
    );
    await expect(
      savePunches(fake as never, "dev", [{ zkUserId: "2", punchedAt: pkt("2026-11-14 08:00:00") }]),
    ).rejects.toThrow("db down");
  });
});
