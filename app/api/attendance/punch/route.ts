import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth/api";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Manual / test punches from the website (the academy agent writes to Supabase directly).
 * Body: one punch or an array of { zk_user_id, punched_at?, punch_type? }.
 */

function toKarachiIso(val?: string) {
  if (!val) return new Date().toISOString();
  if (val.endsWith("Z") || val.includes("+") || (val.length > 10 && val.slice(10).includes("-"))) {
    return val;
  }
  return `${val}+05:00`;
}

function karachiDate(iso: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

export async function POST(request: Request) {
  const denied = await requireStaff();
  if (denied) return denied;

  try {
    const payload = await request.json();
    const punches = Array.isArray(payload) ? payload : [payload];

    if (punches.length === 0) {
      return NextResponse.json({ error: "Empty punch payload" }, { status: 400 });
    }

    const supabase = createAdminClient();

    const { data: device } = await supabase
      .from("devices")
      .select("id")
      .eq("is_active", true)
      .order("created_at")
      .limit(1)
      .maybeSingle();

    const zkUserIds = punches.map((p) => String(p.zk_user_id)).filter(Boolean);
    const { data: students } = await supabase
      .from("students")
      .select("id, zk_user_id")
      .in("zk_user_id", zkUserIds);

    const studentMap = new Map((students ?? []).map((s) => [s.zk_user_id, s.id]));

    const logRows = punches.map((p) => {
      const zkId = String(p.zk_user_id);
      return {
        device_id: device?.id ?? null,
        zk_user_id: zkId,
        punched_at: toKarachiIso(p.punched_at),
        punch_type: p.punch_type || "check_in",
        person_type: "student" as const,
        student_id: studentMap.get(zkId) ?? null,
        raw_payload: p,
      };
    });

    const { error: logErr } = await supabase
      .from("attendance_logs")
      .upsert(logRows, { onConflict: "device_id,zk_user_id,punched_at", ignoreDuplicates: true });

    if (logErr) {
      return NextResponse.json({ error: logErr.message }, { status: 500 });
    }

    // Mark each student present on the day of their punch (not "today"), keeping the earliest check-in.
    for (const log of logRows) {
      if (!log.student_id) continue;
      const date = karachiDate(log.punched_at);

      const { data: existing } = await supabase
        .from("daily_attendance")
        .select("id, status, check_in_at")
        .eq("student_id", log.student_id)
        .eq("attendance_date", date)
        .maybeSingle();

      if (!existing) {
        await supabase.from("daily_attendance").insert({
          person_type: "student",
          student_id: log.student_id,
          attendance_date: date,
          status: "present",
          check_in_at: log.punched_at,
          source: "device",
        });
        continue;
      }

      const earlier =
        !existing.check_in_at || new Date(log.punched_at) < new Date(existing.check_in_at);
      if (existing.status === "absent" || earlier) {
        await supabase
          .from("daily_attendance")
          .update({
            status: existing.status === "absent" ? "present" : existing.status,
            check_in_at: earlier ? log.punched_at : existing.check_in_at,
            source: "device",
          })
          .eq("id", existing.id);
      }
    }

    return NextResponse.json({
      success: true,
      processed: logRows.length,
      matchedStudents: logRows.filter((l) => l.student_id !== null).length,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to record punch" },
      { status: 500 }
    );
  }
}
