import type { SupabaseClient } from "@supabase/supabase-js";

export type Punch = { zkUserId: string; punchedAt: Date; punch?: number; status?: number };

function pktDate(d: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** "2026-11-14 08:05:33" (device local time, Pakistan) -> Date. Returns null if malformed. */
export function parseDeviceTime(value: string): Date | null {
  const m = value.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}+05:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Saves punches the same way the academy agent (device-service/agent.py) does:
 * every raw punch goes to attendance_logs (duplicates ignored), and the student is marked
 * present for the day of the punch, keeping the earliest check-in. Absent -> present.
 */
export async function savePunches(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  deviceId: string,
  punches: Punch[],
) {
  if (punches.length === 0) return 0;

  const [{ data: students }, { data: staff }] = await Promise.all([
    supabase.from("students").select("id, zk_user_id").not("zk_user_id", "is", null),
    supabase.from("staff").select("id, zk_user_id").not("zk_user_id", "is", null),
  ]);
  const studentMap = new Map((students ?? []).map((s) => [String(s.zk_user_id), s.id as string]));
  const staffMap = new Map((staff ?? []).map((s) => [String(s.zk_user_id), s.id as string]));

  const logRows = [];
  const earliest = new Map<string, { studentId: string; date: string; iso: string }>();

  for (const p of punches) {
    const iso = p.punchedAt.toISOString();
    const studentId = studentMap.get(p.zkUserId) ?? null;
    const staffId = studentId ? null : (staffMap.get(p.zkUserId) ?? null);
    logRows.push({
      device_id: deviceId,
      zk_user_id: p.zkUserId,
      punched_at: iso,
      punch_type: p.punch === 1 ? "check_out" : "check_in",
      punch_status_raw: p.status !== undefined ? String(p.status) : null,
      person_type: studentId ? "student" : staffId ? "staff" : null,
      student_id: studentId,
      staff_id: staffId,
      raw_payload: { zk_user_id: p.zkUserId, punched_at: iso, punch: p.punch ?? 0, source: "adms" },
    });
    if (studentId) {
      const date = pktDate(p.punchedAt);
      const key = `${studentId}|${date}`;
      const cur = earliest.get(key);
      if (!cur || iso < cur.iso) earliest.set(key, { studentId, date, iso });
    }
  }

  const { error: logErr } = await supabase
    .from("attendance_logs")
    .upsert(logRows, { onConflict: "device_id,zk_user_id,punched_at", ignoreDuplicates: true });
  if (logErr) throw new Error(logErr.message);

  if (earliest.size > 0) {
    const entries = [...earliest.values()];
    const { data: existingRows, error: exErr } = await supabase
      .from("daily_attendance")
      .select("id, student_id, attendance_date, status, check_in_at")
      .in("student_id", [...new Set(entries.map((e) => e.studentId))])
      .in("attendance_date", [...new Set(entries.map((e) => e.date))]);
    if (exErr) throw new Error(exErr.message);
    const existing = new Map(
      (existingRows ?? []).map((r) => [`${r.student_id}|${r.attendance_date}`, r]),
    );

    const inserts = [];
    for (const e of entries) {
      const row = existing.get(`${e.studentId}|${e.date}`);
      if (!row) {
        inserts.push({
          person_type: "student",
          student_id: e.studentId,
          attendance_date: e.date,
          status: "present",
          check_in_at: e.iso,
          source: "device",
        });
        continue;
      }
      const earlier = !row.check_in_at || new Date(e.iso) < new Date(row.check_in_at);
      if (row.status === "absent" || earlier) {
        await supabase
          .from("daily_attendance")
          .update({
            status: row.status === "absent" ? "present" : row.status,
            check_in_at: earlier ? e.iso : row.check_in_at,
            source: "device",
          })
          .eq("id", row.id);
      }
    }
    if (inserts.length) {
      const { error } = await supabase.from("daily_attendance").insert(inserts);
      if (error) throw new Error(error.message);
    }
  }

  return logRows.length;
}
