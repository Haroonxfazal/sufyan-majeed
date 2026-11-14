import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type Handler } from "../helpers/fake-supabase";

type Profile = { role: string; is_active: boolean } | null;
let user: { id: string } | null = null;
let profile: Profile = null;
let dataHandler: Handler = () => ({ data: [] });

function makeClient() {
  const fake = createFakeSupabase((call) =>
    call.table === "profiles" ? { data: profile } : dataHandler(call),
  );
  return Object.assign(fake, { auth: { getUser: async () => ({ data: { user } }) } });
}
let client = makeClient();

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => client }));
vi.mock("@/lib/supabase/env", () => ({ isSupabaseConfigured: () => true }));

const smsSend = await import("@/app/api/sms/send/route");
const smsDelete = await import("@/app/api/sms/delete/route");
const fees = await import("@/app/api/fees/update/route");
const students = await import("@/app/api/students/route");
const calendar = await import("@/app/api/attendance/calendar/route");
const absentees = await import("@/app/api/attendance/process-absentees/route");
const punch = await import("@/app/api/attendance/punch/route");
const cron = await import("@/app/api/sms/cron/fee-reminders/route");
const { requireStaff } = await import("@/lib/auth/api");

const json = (method: string, body: unknown, path = "x") =>
  new Request(`http://site/${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const GUARDED: Array<[string, () => Promise<Response>]> = [
  ["POST /api/sms/send", () => smsSend.POST(json("POST", { recipients: [{ parentPhone: "0300" }] }))],
  ["DELETE /api/sms/delete", () => smsDelete.DELETE(json("DELETE", { all: true }))],
  ["GET /api/fees/update", () => fees.GET(new Request("http://site/api/fees/update"))],
  ["POST /api/fees/update", () => fees.POST(json("POST", { studentId: "s1", isPaid: true }))],
  ["GET /api/students", () => students.GET()],
  ["POST /api/students", () => students.POST(json("POST", { fullName: "A", parentPhone: "0300" }))],
  ["GET /api/attendance/calendar", () => calendar.GET(new Request("http://site/api/attendance/calendar"))],
  ["POST /api/attendance/process-absentees", () => absentees.POST(json("POST", {}))],
  ["POST /api/attendance/punch", () => punch.POST(json("POST", { zk_user_id: "1" }))],
  ["POST /api/sms/cron/fee-reminders", () => cron.POST(new Request("http://site/api/sms/cron/fee-reminders", { method: "POST" }))],
];

beforeEach(() => {
  user = null;
  profile = null;
  dataHandler = () => ({ data: [] });
  client = makeClient();
  delete process.env.CRON_SECRET;
});

describe("requireStaff", () => {
  it.each([
    ["not signed in", null, null, 401],
    ["no profile", { id: "u" }, null, 403],
    ["inactive profile", { id: "u" }, { role: "principal", is_active: false }, 403],
    ["teacher (read-only role)", { id: "u" }, { role: "teacher", is_active: true }, 403],
  ])("%s -> %i", async (_label, u, p, status) => {
    user = u as typeof user;
    profile = p as Profile;
    expect((await requireStaff())!.status).toBe(status);
  });

  it.each(["principal", "administrator", "office_staff"])("%s is allowed", async (role) => {
    user = { id: "u" };
    profile = { role, is_active: true };
    expect(await requireStaff()).toBeNull();
  });
});

describe("every API route refuses anonymous callers", () => {
  it.each(GUARDED)("%s -> 401", async (_name, call) => {
    const res = await call();
    expect(res.status).toBe(401);
    // nothing but the auth lookup may touch the database
    expect(client.calls.filter((c) => c.table !== "profiles")).toHaveLength(0);
  });

  it.each(GUARDED)("%s -> 403 for a teacher", async (_name, call) => {
    user = { id: "u" };
    profile = { role: "teacher", is_active: true };
    expect((await call()).status).toBe(403);
  });
});

describe("fee-reminder cron", () => {
  it("runs with the right CRON_SECRET and no login", async () => {
    process.env.CRON_SECRET = "s3cret-value";
    const res = await cron.POST(new Request("http://site/x?secret=s3cret-value", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, sentCount: 0 });
  });

  it("a wrong secret falls back to the login check", async () => {
    process.env.CRON_SECRET = "s3cret-value";
    const res = await cron.POST(new Request("http://site/x", { method: "POST", headers: { "x-cron-secret": "nope" } }));
    expect(res.status).toBe(401);
  });
});

describe("signed-in behaviour", () => {
  beforeEach(() => {
    user = { id: "u" };
    profile = { role: "office_staff", is_active: true };
  });

  it("sms/send fills {name} and {amount} into a custom message", async () => {
    process.env.SMS_GATEWAY_ENABLED = "false";
    dataHandler = (c) => (c.table === "sms_logs" ? { data: { id: "l1" } } : { data: [] });
    const res = await smsSend.POST(
      json("POST", {
        recipients: [{ studentId: "s1", fullName: "Ali", parentPhone: "03001234567", pendingDue: 2500 }],
        templateKey: "fee_reminder",
        customMessage: "Dear parent of {name}, PKR {amount} due",
      }),
    );
    expect(await res.json()).toMatchObject({ success: true, sentCount: 1, totalCount: 1 });
    const log = client.calls.find((c) => c.table === "sms_logs")!.payload as Record<string, unknown>;
    expect(log.body).toBe("Dear parent of Ali, PKR 2,500 due");
  });

  it("sms/send rejects an empty recipient list", async () => {
    expect((await smsSend.POST(json("POST", { recipients: [] }))).status).toBe(400);
  });

  it("sms/delete needs ids or all:true", async () => {
    expect((await smsDelete.DELETE(json("DELETE", {}))).status).toBe(400);
  });

  it("students POST validates required fields", async () => {
    expect((await students.POST(json("POST", { fullName: "A" }))).status).toBe(400);
  });

  it("students POST stores trimmed values and the fingerprint ID", async () => {
    dataHandler = (c) => (c.op === "insert" ? { data: { id: "new" } } : { data: [] });
    const res = await students.POST(json("POST", { fullName: "  Ali  ", parentPhone: " 0300 ", zkUserId: 12, monthlyFee: 2500 }));
    expect(res.status).toBe(200);
    const row = client.calls.find((c) => c.op === "insert")!.payload as Record<string, unknown>;
    expect(row).toMatchObject({ full_name: "Ali", parent_phone: "0300", zk_user_id: "12", monthly_fee: "2500", is_active: true });
  });

  it("fees GET computes paid / pending per student", async () => {
    dataHandler = (c) => {
      if (c.table === "students")
        return { data: [
          { id: "a", student_code: "1", full_name: "A", father_name: "", parent_phone: "", monthly_fee: 3000 },
          { id: "b", student_code: "2", full_name: "B", father_name: "", parent_phone: "", monthly_fee: 2000 },
        ] };
      if (c.table === "invoices") return { data: [{ id: "i1", student_id: "a", total_amount: 3000, paid_amount: 3000, status: "paid" }] };
      return { data: [] };
    };
    const body = await (await fees.GET(new Request("http://site/api/fees/update?month=2026-11"))).json();
    expect(body.summary).toEqual({ total: 2, paidCount: 1, unpaidCount: 1, totalExpected: 5000, totalCollected: 3000 });
    expect(body.records[1]).toMatchObject({ studentId: "b", isPaid: false, pendingDue: 2000 });
  });

  it("process-absentees marks punched students present and the rest absent", async () => {
    dataHandler = (c) => {
      if (c.table === "students") return { data: [{ id: "a", zk_user_id: "1" }, { id: "b", zk_user_id: "2" }, { id: "c", zk_user_id: null }] };
      if (c.table === "attendance_logs") return { data: [{ zk_user_id: "1", punched_at: "2026-11-14T03:00:00Z" }] };
      return { data: [] };
    };
    const body = await (await absentees.POST(json("POST", { date: "2026-11-14" }))).json();
    expect(body).toMatchObject({ success: true, processed: 3, present: 1, absent: 2 });
  });
});
