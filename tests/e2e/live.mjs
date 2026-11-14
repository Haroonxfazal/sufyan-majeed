/**
 * Live end-to-end test of the deployed site, database and fingerprint relay.
 *
 *   SUPABASE_SERVICE_ROLE_KEY=... node tests/e2e/live.mjs
 *
 * Creates a temporary login and students named "TEST-…", exercises every page and API,
 * then deletes everything it created (also when a check fails). Never sends a real SMS:
 * the only students it creates are paid or fee-free, and it never posts real recipients.
 */
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const SITE = process.env.SITE_URL ?? "https://unique-academy.haroonxfazal.workers.dev";
const RELAY = process.env.RELAY_URL ?? "http://161.118.179.2";
const SERIAL = "AF6P210960179";
const env = Object.fromEntries(
  readFileSync(new URL("../../.env.production", import.meta.url), "utf8")
    .split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const SUPA = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE) throw new Error("Set SUPABASE_SERVICE_ROLE_KEY");
const REF = new URL(SUPA).hostname.split(".")[0];

// ---------------------------------------------------------------- helpers
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}
function expect(cond, msg) { if (!cond) throw new Error(msg); }

const admin = (path, init = {}) =>
  fetch(`${SUPA}${path}`, {
    ...init,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
const rest = async (path, init) => {
  const r = await admin(`/rest/v1/${path}`, init);
  const t = await r.text();
  if (!r.ok) throw new Error(`REST ${path} -> ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
};

let cookie = "";
const site = async (path, init = {}) => {
  const r = await fetch(`${SITE}${path}`, { redirect: "manual", ...init, headers: { cookie, ...(init.headers ?? {}) } });
  if (process.env.E2E_DEBUG && path.startsWith("/api") && !(r.headers.get("content-type") ?? "").includes("json")) {
    const t = await r.clone().text();
    const title = (t.match(/<title>([^<]*)/) ?? [])[1] ?? t.slice(0, 120);
    console.log(`        [debug] ${init.method ?? "GET"} ${path} -> ${r.status} ${r.headers.get("location") ?? ""} ${title}`);
  }
  return r;
};
const siteJson = (path, method, body) =>
  site(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function pktNow(offsetMinutes = 0) {
  const d = new Date(Date.now() + 5 * 3600_000 + offsetMinutes * 60_000);
  return d.toISOString().replace("T", " ").slice(0, 19); // "YYYY-MM-DD HH:MM:SS" Pakistan time
}
const today = pktNow().slice(0, 10);

// ---------------------------------------------------------------- state for cleanup
const created = { userId: null, studentIds: [], zkIds: ["9901", "9902"] };

async function cleanup() {
  console.log("\nCleanup");
  const ids = created.studentIds;
  const steps = [];
  if (ids.length) {
    const inList = `in.(${ids.join(",")})`;
    steps.push(["invoices", () => rest(`invoices?student_id=${inList}`, { method: "DELETE" })]);
    steps.push(["sms_logs", () => rest(`sms_logs?student_id=${inList}`, { method: "DELETE" })]);
    steps.push(["daily_attendance", () => rest(`daily_attendance?student_id=${inList}`, { method: "DELETE" })]);
  }
  steps.push(["attendance_logs", () => rest(`attendance_logs?zk_user_id=in.(${created.zkIds.join(",")})`, { method: "DELETE" })]);
  if (ids.length) steps.push(["students", () => rest(`students?id=in.(${ids.join(",")})`, { method: "DELETE" })]);
  if (created.userId) steps.push(["auth user", async () => {
    const r = await admin(`/auth/v1/admin/users/${created.userId}`, { method: "DELETE" });
    if (!r.ok) throw new Error(`${r.status}`);
  }]);
  for (const [name, fn] of steps) {
    try { await fn(); console.log(`  removed ${name}`); } catch (e) { console.log(`  !! could not remove ${name}: ${e.message}`); }
  }
  const left = await rest(`students?select=id&full_name=like.TEST-*`);
  const logs = await rest(`attendance_logs?select=id&zk_user_id=in.(${created.zkIds.join(",")})`);
  console.log(`  leftover TEST students: ${left.length}, leftover TEST punches: ${logs.length}`);
}

// ---------------------------------------------------------------- tests
async function main() {
  console.log(`Site ${SITE}\nRelay ${RELAY}\nToday (PKT) ${today}\n`);

  console.log("Public / anonymous");
  await check("login page renders", async () => {
    const r = await site("/login");
    expect(r.status === 200, `status ${r.status}`);
    expect(/password/i.test(await r.text()), "no password field");
  });
  await check("health endpoint reports Supabase connected", async () => {
    const r = await site("/api/health");
    const j = await r.json();
    expect(r.status === 200 && j.ok === true && j.supabaseConfigured === true, JSON.stringify(j).slice(0, 120));
  });
  for (const p of ["/", "/students", "/attendance", "/fees", "/sms"]) {
    await check(`anonymous ${p} redirects to login`, async () => {
      const r = await site(p);
      expect(r.status === 307 && (r.headers.get("location") ?? "").includes("/login"), `status ${r.status} -> ${r.headers.get("location")}`);
    });
  }
  for (const [m, p, b] of [["GET", "/api/students"], ["POST", "/api/sms/send", { recipients: [] }], ["GET", "/api/fees/update"],
    ["DELETE", "/api/sms/delete", { ids: ["x"] }], ["POST", "/api/attendance/punch", { zk_user_id: "1" }],
    ["POST", "/api/attendance/process-absentees", {}], ["POST", "/api/sms/cron/fee-reminders", {}]]) {
    await check(`anonymous ${m} ${p} -> 401`, async () => {
      const r = b ? await siteJson(p, m, b) : await site(p, { method: m });
      expect(r.status === 401, `status ${r.status}`);
    });
  }
  await check("relay rejects unknown machine serials", async () => {
    const r = await fetch(`${RELAY}/iclock/getrequest?SN=NOT-OURS`);
    expect(r.status === 403, `status ${r.status}`);
  });
  await check("relay exposes nothing outside /iclock", async () => {
    expect((await fetch(`${RELAY}/api/students`)).status === 404, "not 404");
  });
  await check("relay handshake for the real machine", async () => {
    const t = await (await fetch(`${RELAY}/iclock/cdata?SN=${SERIAL}&options=all`)).text();
    expect(t.startsWith(`GET OPTION FROM: ${SERIAL}`) && t.includes("ATTLOGStamp="), t.slice(0, 80));
  });

  console.log("\nLogin");
  const email = `e2e-test-${Date.now()}@example.com`;
  const password = randomBytes(18).toString("base64url");
  await check("create temporary staff login", async () => {
    const r = await admin("/auth/v1/admin/users", {
      method: "POST",
      body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name: "TEST E2E" } }),
    });
    const j = await r.json();
    expect(r.ok, JSON.stringify(j).slice(0, 150));
    created.userId = j.id;
  });
  await check("new login gets an active office_staff profile", async () => {
    const [p] = await rest(`profiles?id=eq.${created.userId}&select=role,is_active`);
    expect(p?.role === "office_staff" && p.is_active, JSON.stringify(p));
  });
  await check("wrong password is refused", async () => {
    const r = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
      method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "wrong-password" }),
    });
    expect(r.status === 400, `status ${r.status}`);
  });
  await check("correct password signs in", async () => {
    const r = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
      method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const session = await r.json();
    expect(r.ok && session.access_token, JSON.stringify(session).slice(0, 150));
    // Same cookie format @supabase/ssr writes in the browser
    const value = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
    const name = `sb-${REF}-auth-token`;
    const chunks = value.match(/.{1,3180}/g);
    cookie = chunks.length === 1 ? `${name}=${value}` : chunks.map((c, i) => `${name}.${i}=${c}`).join("; ");
  });
  await check("signed-in visitor of /login is sent to the dashboard", async () => {
    const r = await site("/login");
    expect(r.status === 307 && new URL(r.headers.get("location"), SITE).pathname === "/", `status ${r.status} -> ${r.headers.get("location")}`);
  });

  console.log("\nPages (signed in)");
  for (const p of ["/", "/attendance", "/fees", "/sms", "/students", "/device", "/settings", "/classes", "/parents", "/staff", "/reports"]) {
    await check(`page ${p} loads without errors`, async () => {
      const r = await site(p);
      const html = await r.text();
      expect(r.status === 200, `status ${r.status} -> ${r.headers.get("location") ?? ""}`);
      expect(!/Application error|Internal Server Error|NEXT_HTTP_ERROR|digest:/i.test(html), "error text in page");
    });
  }

  console.log("\nStudents");
  for (const [name, zk, fee] of [["TEST-Alpha", "9901", 2500], ["TEST-Bravo", "9902", 0]]) {
    await check(`create student ${name}`, async () => {
      const r = await siteJson("/api/students", "POST", {
        fullName: name, fatherName: "TEST", parentPhone: "03000000000", zkUserId: zk, monthlyFee: fee,
        studentCode: `T${zk}`,
      });
      const j = await r.json();
      expect(r.ok && j.success, JSON.stringify(j).slice(0, 150));
      created.studentIds.push(j.student.id);
    });
  }
  const [alpha, bravo] = created.studentIds;
  await check("student list includes both TEST students", async () => {
    const list = await (await site("/api/students")).json();
    const names = list.map((s) => s.full_name);
    expect(names.includes("TEST-Alpha") && names.includes("TEST-Bravo"), names.join(", "));
  });
  await check("missing name/phone is rejected", async () => {
    expect((await siteJson("/api/students", "POST", { fullName: "TEST-x" })).status === 400, "not 400");
  });

  console.log("\nFingerprint path (machine -> relay -> website -> database)");
  const punchAt = pktNow(-1);
  await check("machine-format ATTLOG upload through the relay is accepted", async () => {
    const r = await fetch(`${RELAY}/iclock/cdata?SN=${SERIAL}&table=ATTLOG&Stamp=0`, {
      method: "POST", body: `9901\t${punchAt}\t0\t1\t0\t0\t0\n`,
    });
    const t = await r.text();
    expect(r.status === 200 && t === "OK: 1", `status ${r.status}: ${t}`);
  });
  await check("punch stored and linked to TEST-Alpha", async () => {
    const rows = await rest(`attendance_logs?zk_user_id=eq.9901&select=student_id,punched_at`);
    expect(rows.length === 1 && rows[0].student_id === alpha, JSON.stringify(rows));
  });
  await check("TEST-Alpha marked present today with that check-in", async () => {
    const [d] = await rest(`daily_attendance?student_id=eq.${alpha}&attendance_date=eq.${today}&select=status,check_in_at`);
    expect(d?.status === "present", JSON.stringify(d));
    expect(new Date(d.check_in_at).getTime() === new Date(punchAt.replace(" ", "T") + "+05:00").getTime(), d.check_in_at);
  });
  await check("re-sending the same punch does not duplicate it", async () => {
    await fetch(`${RELAY}/iclock/cdata?SN=${SERIAL}&table=ATTLOG`, { method: "POST", body: `9901\t${punchAt}\t0\t1\n` });
    const rows = await rest(`attendance_logs?zk_user_id=eq.9901&select=id`);
    expect(rows.length === 1, `${rows.length} rows`);
  });
  await check("manual punch API moves check-in earlier", async () => {
    const early = `${today} 00:01:00`;
    const r = await siteJson("/api/attendance/punch", "POST", { zk_user_id: "9901", punched_at: early });
    const j = await r.json();
    expect(r.ok && j.matchedStudents === 1, JSON.stringify(j));
    const [d] = await rest(`daily_attendance?student_id=eq.${alpha}&attendance_date=eq.${today}&select=check_in_at`);
    expect(new Date(d.check_in_at).getTime() === new Date(`${today}T00:01:00+05:00`).getTime(), d.check_in_at);
  });

  // These steps act on ALL active students; only run them when the TEST ones are the only ones.
  const onlyTestStudents = async () => {
    const active = await rest("students?select=full_name&is_active=eq.true");
    const real = active.filter((s) => !s.full_name.startsWith("TEST-"));
    if (real.length) throw new Error(`skipped: ${real.length} real active students exist (would affect them)`);
  };

  console.log("\nAttendance processing");
  await check("process absentees: Alpha present, Bravo absent", async () => {
    await onlyTestStudents();
    const r = await siteJson("/api/attendance/process-absentees", "POST", { date: today });
    const j = await r.json();
    expect(r.ok && j.success, JSON.stringify(j));
    const rows = await rest(`daily_attendance?student_id=in.(${alpha},${bravo})&attendance_date=eq.${today}&select=student_id,status`);
    const by = Object.fromEntries(rows.map((x) => [x.student_id, x.status]));
    expect(by[alpha] === "present" && by[bravo] === "absent", JSON.stringify(by));
  });
  await check("a later punch flips Bravo from absent to present", async () => {
    await fetch(`${RELAY}/iclock/cdata?SN=${SERIAL}&table=ATTLOG`, { method: "POST", body: `9902\t${pktNow(-1)}\t0\t1\n` });
    const [d] = await rest(`daily_attendance?student_id=eq.${bravo}&attendance_date=eq.${today}&select=status`);
    expect(d?.status === "present", JSON.stringify(d));
    // put Bravo back to absent for the SMS absentee check below
    await rest(`daily_attendance?student_id=eq.${bravo}&attendance_date=eq.${today}`, { method: "PATCH", body: JSON.stringify({ status: "absent" }) });
  });
  await check("calendar day view shows both statuses", async () => {
    const j = await (await site(`/api/attendance/calendar?date=${today}`)).json();
    const by = Object.fromEntries(j.students.map((s) => [s.fullName, s.status]));
    expect(by["TEST-Alpha"] === "present" && by["TEST-Bravo"] === "absent", JSON.stringify(by));
  });
  await check("calendar month view counts today", async () => {
    const j = await (await site(`/api/attendance/calendar?month=${today.slice(0, 7)}`)).json();
    const day = j.dayStats?.[today];
    expect(day && day.present >= 1 && day.absent >= 1, JSON.stringify(day));
  });
  await check("Attendance page shows the TEST students", async () => {
    const html = await (await site("/attendance")).text();
    expect(html.includes("TEST-Alpha") && html.includes("TEST-Bravo"), "names missing from page");
  });
  await check("SMS page lists Bravo as an absentee", async () => {
    const html = await (await site("/sms")).text();
    expect(html.includes("TEST-Bravo"), "absentee missing");
  });

  console.log("\nFees");
  const month = today.slice(0, 7);
  await check("fees list shows Alpha unpaid (PKR 2500 pending)", async () => {
    const j = await (await site(`/api/fees/update?month=${month}`)).json();
    const a = j.records.find((r) => r.studentId === alpha);
    expect(a && !a.isPaid && a.pendingDue === 2500, JSON.stringify(a));
  });
  await check("mark Alpha paid", async () => {
    const r = await siteJson("/api/fees/update", "POST", { studentId: alpha, month, isPaid: true });
    expect(r.ok, `status ${r.status}`);
    const a = (await (await site(`/api/fees/update?month=${month}`)).json()).records.find((x) => x.studentId === alpha);
    expect(a.isPaid && a.pendingDue === 0, JSON.stringify(a));
  });
  await check("fee-reminder run sends nothing when nobody owes (no real SMS)", async () => {
    await onlyTestStudents();
    const j = await (await siteJson("/api/sms/cron/fee-reminders", "POST", {})).json();
    expect(j.success && j.sentCount === 0 && (j.totalPending ?? 0) === 0, JSON.stringify(j).slice(0, 200));
  });
  await check("mark Alpha unpaid again", async () => {
    await siteJson("/api/fees/update", "POST", { studentId: alpha, month, isPaid: false });
    const a = (await (await site(`/api/fees/update?month=${month}`)).json()).records.find((x) => x.studentId === alpha);
    expect(!a.isPaid && a.pendingDue === 2500, JSON.stringify(a));
  });
  await check("fees page shows Alpha", async () => {
    expect((await (await site("/fees")).text()).includes("TEST-Alpha"), "missing");
  });

  console.log("\nSMS (validation only)");
  await check("sending to nobody is rejected", async () => {
    expect((await siteJson("/api/sms/send", "POST", { recipients: [] })).status === 400, "not 400");
  });
  await check("deleting with no ids is rejected", async () => {
    expect((await siteJson("/api/sms/delete", "DELETE", {})).status === 400, "not 400");
  });

  console.log("\nRoles");
  await check("teacher role is refused by write APIs", async () => {
    await rest(`profiles?id=eq.${created.userId}`, { method: "PATCH", body: JSON.stringify({ role: "teacher" }) });
    try {
      expect((await site("/api/students")).status === 403, "teacher not refused");
    } finally {
      await rest(`profiles?id=eq.${created.userId}`, { method: "PATCH", body: JSON.stringify({ role: "office_staff" }) });
    }
  });
  await check("deactivated login is refused", async () => {
    await rest(`profiles?id=eq.${created.userId}`, { method: "PATCH", body: JSON.stringify({ is_active: false }) });
    try {
      expect((await site("/api/students")).status === 403, "inactive not refused");
    } finally {
      await rest(`profiles?id=eq.${created.userId}`, { method: "PATCH", body: JSON.stringify({ is_active: true }) });
    }
  });
}

try {
  await main();
} finally {
  await cleanup();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    for (const f of failed) console.log(`  - ${f.name}: ${f.error}`);
    process.exitCode = 1;
  }
}
