import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "../helpers/fake-supabase";

let fake = createFakeSupabase();
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fake }));
vi.mock("@/lib/supabase/env", () => ({ isSupabaseConfigured: () => true }));

async function loadSms() {
  vi.resetModules(); // the module caches the gateway URL that worked
  return import("@/lib/services/sms");
}

const GATEWAY = "https://api.sms-gate.app/3rdparty/v1/messages";

beforeEach(() => {
  fake = createFakeSupabase((call) =>
    call.table === "sms_logs" && call.op === "insert" ? { data: { id: "log-1" } } : { data: [] },
  );
  process.env.SMS_GATEWAY_URL = GATEWAY;
  process.env.SMS_GATEWAY_AUTH_TOKEN = "AS2-Y3:abcdefghijklmn";
  process.env.SMS_GATEWAY_DEVICE_ID = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SMS_GATEWAY_ENABLED;
});

describe("normalizePakistaniPhone", () => {
  it.each([
    ["+92 300 1234567", "03001234567"],
    ["923001234567", "03001234567"],
    ["00923001234567", "03001234567"],
    ["3001234567", "03001234567"],
    ["0300-1234567", "03001234567"],
  ])("%s -> %s", async (input, expected) => {
    const { normalizePakistaniPhone } = await loadSms();
    expect(normalizePakistaniPhone(input)).toBe(expected);
  });
});

describe("message templates", () => {
  it("absentee SMS names the student and date", async () => {
    const { formatAbsenteeSms } = await loadSms();
    const text = formatAbsenteeSms("Ali", "2026-11-14");
    expect(text).toContain("Ali");
    expect(text).toContain("ABSENT");
    expect(text).toContain("2026-11-14");
  });

  it("fee SMS shows the amount with separators", async () => {
    const { formatFeeStatusSms } = await loadSms();
    expect(formatFeeStatusSms("Ali", 2500)).toContain("PKR 2,500");
  });
});

describe("sendSmsNotification", () => {
  it("demo mode: logs as sent without calling the gateway", async () => {
    process.env.SMS_GATEWAY_ENABLED = "false";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { sendSmsNotification } = await loadSms();

    const res = await sendSmsNotification({ toPhone: "+923001234567", body: " hi ", templateKey: "general" });

    expect(res).toEqual({ success: true, logId: "log-1" });
    expect(fetchMock).not.toHaveBeenCalled();
    const log = fake.calls.find((c) => c.op === "insert")!.payload as Record<string, unknown>;
    expect(log).toMatchObject({ to_phone: "03001234567", body: "hi", status: "sent", provider: "local_demo" });
  });

  it("live mode: posts the correct request and logs it as sent", async () => {
    process.env.SMS_GATEWAY_ENABLED = "true";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "gw-9" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { sendSmsNotification } = await loadSms();

    const res = await sendSmsNotification({ toPhone: "03001234567", body: "Hello", templateKey: "fee_reminder", studentId: "s1" });

    expect(res.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe(`${GATEWAY}?skipPhoneValidation=true`);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("AS2-Y3:abcdefghijklmn").toString("base64")}`,
    );
    expect(JSON.parse(String(init.body))).toEqual({ textMessage: { text: "Hello" }, phoneNumbers: ["03001234567"] });
    const log = fake.calls.find((c) => c.op === "insert")!.payload as Record<string, unknown>;
    expect(log).toMatchObject({ status: "sent", provider: "android_gateway", provider_message_id: "gw-9", student_id: "s1" });
  });

  it("wrong credentials: fails with a hint that never reveals the password", async () => {
    process.env.SMS_GATEWAY_ENABLED = "true";
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"message":"Unauthorized"}', { status: 401 })));
    const { sendSmsNotification } = await loadSms();

    const res = await sendSmsNotification({ toPhone: "03001234567", body: "x", templateKey: "general" });

    expect(res.success).toBe(false);
    expect(res.error).toContain("401");
    expect(res.error).toContain('token username "AS2-Y3", password length 14');
    expect(res.error).not.toContain("abcdefghijklmn");
    const log = fake.calls.find((c) => c.op === "insert")!.payload as Record<string, unknown>;
    expect(log.status).toBe("failed");
  });

  it("empty token is reported clearly", async () => {
    process.env.SMS_GATEWAY_ENABLED = "true";
    process.env.SMS_GATEWAY_AUTH_TOKEN = "";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    const { sendSmsNotification } = await loadSms();
    const res = await sendSmsNotification({ toPhone: "03001234567", body: "x", templateKey: "general" });
    expect(res.error).toContain("SMS_GATEWAY_AUTH_TOKEN is empty");
  });

  it("gateway unreachable: fails and logs the reason", async () => {
    process.env.SMS_GATEWAY_ENABLED = "true";
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const { sendSmsNotification } = await loadSms();
    const res = await sendSmsNotification({ toPhone: "03001234567", body: "x", templateKey: "general" });
    expect(res.success).toBe(false);
    expect(res.error).toContain("Could not reach the SMS gateway");
  });

  it("rejects an empty phone number without calling the gateway", async () => {
    process.env.SMS_GATEWAY_ENABLED = "true";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { sendSmsNotification } = await loadSms();
    const res = await sendSmsNotification({ toPhone: "  ", body: "x", templateKey: "general" });
    expect(res).toEqual({ success: false, error: "Invalid phone number" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("recipient lists", () => {
  it("fee recipients exclude paid students and use the remaining balance", async () => {
    fake = createFakeSupabase((call) => {
      if (call.table === "invoices")
        return { data: [
          { student_id: "paid", total_amount: 3000, paid_amount: 3000, status: "paid" },
          { student_id: "partial", total_amount: 3000, paid_amount: 1000, status: "partial" },
        ] };
      if (call.table === "students")
        return { data: [
          { id: "paid", student_code: "1", full_name: "P", father_name: "", parent_phone: "1", monthly_fee: 3000 },
          { id: "partial", student_code: "2", full_name: "Q", father_name: "", parent_phone: "2", monthly_fee: 3000 },
          { id: "noinvoice", student_code: "3", full_name: "R", father_name: "", parent_phone: "3", monthly_fee: 2000 },
          { id: "free", student_code: "4", full_name: "S", father_name: "", parent_phone: "4", monthly_fee: 0 },
        ] };
      return { data: [] };
    });
    const { getFeePendingRecipients } = await loadSms();
    const list = await getFeePendingRecipients();
    expect(list.map((r) => [r.studentId, r.pendingDue])).toEqual([
      ["partial", 2000],
      ["noinvoice", 2000],
    ]);
  });

  it("absentee recipients come from today's absent marks", async () => {
    fake = createFakeSupabase((call) => {
      if (call.table === "daily_attendance") return { data: [{ student_id: "a1", attendance_date: "2026-11-14" }] };
      if (call.table === "students")
        return { data: [{ id: "a1", student_code: "1", full_name: "Ali", father_name: "F", parent_phone: "0300" }] };
      return { data: [] };
    });
    const { getAbsenteeRecipients } = await loadSms();
    const list = await getAbsenteeRecipients("2026-11-14");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ studentId: "a1", fullName: "Ali", lastSmsSentAt: null });
  });
});
