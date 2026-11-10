import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { todayInKarachi, formatPkr } from "@/lib/utils";
import { APP_NAME } from "@/lib/constants";

export type AbsenteeRecipient = {
  studentId: string;
  studentCode: string;
  fullName: string;
  fatherName: string;
  parentPhone: string;
  attendanceDate: string;
  lastSmsSentAt?: string | null;
};

export type FeeRecipient = {
  studentId: string;
  studentCode: string;
  fullName: string;
  fatherName: string;
  parentPhone: string;
  monthlyFee: number;
  pendingDue: number;
  lastSmsSentAt?: string | null;
};

export type SmsLogItem = {
  id: string;
  toPhone: string;
  templateKey: string | null;
  body: string;
  status: "pending" | "queued" | "sent" | "failed";
  provider: string;
  errorMessage?: string | null;
  sentAt: string | null;
  studentName?: string;
  createdAt: string;
};

/**
 * Normalize a Pakistani mobile number to 03XXXXXXXXX
 * (handles +923..., 923..., 00923..., 3XXXXXXXXX).
 */
export function normalizePakistaniPhone(phone: string): string {
  let cleaned = phone.replace(/[^0-9]/g, "");
  if (cleaned.startsWith("0092") && cleaned.length === 14) {
    cleaned = "0" + cleaned.slice(4);
  } else if (cleaned.startsWith("92") && cleaned.length === 12) {
    cleaned = "0" + cleaned.slice(2);
  } else if (cleaned.length === 10 && cleaned.startsWith("3")) {
    cleaned = "0" + cleaned;
  }
  return cleaned;
}

/**
 * Get all students marked 'absent' for a given date
 */
export async function getAbsenteeRecipients(date = todayInKarachi()): Promise<AbsenteeRecipient[]> {
  if (!isSupabaseConfigured()) return [];

  const supabase = await createClient();

  // 1. Get daily attendance marked absent
  const { data: absents } = await supabase
    .from("daily_attendance")
    .select("student_id, attendance_date")
    .eq("person_type", "student")
    .eq("attendance_date", date)
    .eq("status", "absent");

  if (!absents || absents.length === 0) return [];

  const studentIds = absents
    .map((a) => a.student_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  // 2. Fetch student details with parent phones
  const { data: students } = await supabase
    .from("students")
    .select("id, student_code, full_name, father_name, parent_phone")
    .in("id", studentIds)
    .eq("is_active", true);

  if (!students) return [];

  // 3. Fetch any SMS sent today to these students
  const { data: recentSms } = await supabase
    .from("sms_logs")
    .select("student_id, sent_at")
    .in("student_id", studentIds)
    .eq("template_key", "absence_alert")
    .gte("created_at", `${date}T00:00:00+05:00`);

  const smsMap = new Map((recentSms ?? []).map((s) => [s.student_id, s.sent_at]));

  return students.map((s) => ({
    studentId: s.id,
    studentCode: s.student_code,
    fullName: s.full_name,
    fatherName: s.father_name,
    parentPhone: s.parent_phone,
    attendanceDate: date,
    lastSmsSentAt: smsMap.get(s.id) ?? null,
  }));
}

/**
 * Get all students with pending fees for current billing month.
 * If an invoice exists for the current month and is 'paid', the student has 0 pending due
 * and will NOT receive fee reminders.
 */
export async function getFeePendingRecipients(): Promise<FeeRecipient[]> {
  if (!isSupabaseConfigured()) return [];

  const supabase = await createClient();
  const thisMonth = todayInKarachi().slice(0, 7);
  const billingPeriod = `${thisMonth}-01`;

  // Query all invoices for this month
  const { data: invoices } = await supabase
    .from("invoices")
    .select("student_id, total_amount, paid_amount, status, billing_period")
    .eq("billing_period", billingPeriod);

  // Also query all active students
  const { data: students } = await supabase
    .from("students")
    .select("id, student_code, full_name, father_name, parent_phone, monthly_fee")
    .eq("is_active", true);

  if (!students) return [];

  // Map invoices by student_id
  const invoiceMap = new Map((invoices ?? []).map((inv) => [inv.student_id, inv]));

  // Get recent fee reminders sent this month
  const { data: recentSms } = await supabase
    .from("sms_logs")
    .select("student_id, sent_at")
    .eq("template_key", "fee_reminder")
    .gte("created_at", `${thisMonth}-01T00:00:00+05:00`);

  const smsMap = new Map((recentSms ?? []).map((s) => [s.student_id, s.sent_at]));

  return students
    .map((s) => {
      const inv = invoiceMap.get(s.id);
      let pendingDue = Number(s.monthly_fee ?? 0);

      if (inv) {
        if (inv.status === "paid") {
          pendingDue = 0;
        } else {
          pendingDue = Math.max(0, Number(inv.total_amount ?? 0) - Number(inv.paid_amount ?? 0));
        }
      }

      return {
        studentId: s.id,
        studentCode: s.student_code,
        fullName: s.full_name,
        fatherName: s.father_name,
        parentPhone: s.parent_phone,
        monthlyFee: Number(s.monthly_fee ?? 0),
        pendingDue,
        lastSmsSentAt: smsMap.get(s.id) ?? null,
      };
    })
    .filter((s) => s.pendingDue > 0);
}

/**
 * Queue an SMS. The academy agent (device-service/agent.py) picks up queued rows
 * every few seconds, sends them through the Android gateway phone on the academy
 * network, and marks them sent / failed.
 */
export async function sendSmsNotification({
  toPhone,
  body,
  templateKey,
  studentId,
}: {
  toPhone: string;
  body: string;
  templateKey: "absence_alert" | "fee_reminder" | "general";
  studentId?: string;
}) {
  if (!isSupabaseConfigured()) {
    return { success: false, error: "Supabase not configured" };
  }

  const supabase = await createClient();
  const cleanedPhone = toPhone.trim().replace(/[^0-9+]/g, "");

  if (!cleanedPhone) {
    return { success: false, error: "Invalid phone number" };
  }

  const { data, error } = await supabase
    .from("sms_logs")
    .insert({
      to_phone: normalizePakistaniPhone(cleanedPhone),
      template_key: templateKey,
      body: body.trim(),
      status: "queued",
      provider: "android_gateway",
      student_id: studentId ?? null,
    })
    .select()
    .single();

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, logId: data?.id };
}

/**
 * Fetch recent SMS history logs
 */
export async function getSmsLogs(limit = 50): Promise<SmsLogItem[]> {
  if (!isSupabaseConfigured()) return [];

  const supabase = await createClient();

  const { data } = await supabase
    .from("sms_logs")
    .select(`
      id,
      to_phone,
      template_key,
      body,
      status,
      error_message,
      provider,
      sent_at,
      created_at,
      student_id,
      students ( full_name )
    `)
    .order("created_at", { ascending: false })
    .limit(limit);

  return (data ?? []).map((item: any) => ({
    id: item.id,
    toPhone: item.to_phone,
    templateKey: item.template_key,
    body: item.body,
    status: item.status,
    errorMessage: item.error_message ?? null,
    provider: item.provider,
    sentAt: item.sent_at,
    studentName: item.students?.full_name ?? undefined,
    createdAt: item.created_at,
  }));
}

/**
 * Generate formatted Absentee SMS text
 */
export function formatAbsenteeSms(studentName: string, date: string): string {
  return `Respected Parent, your child ${studentName} was marked ABSENT today (${date}) at ${APP_NAME}. Please contact the academy office if this was unintentional.`;
}

/**
 * Generate formatted Fee Status SMS text
 */
export function formatFeeStatusSms(studentName: string, amount: number): string {
  return `Respected Parent, fee of PKR ${amount.toLocaleString()} for ${studentName} is pending at ${APP_NAME}. Kindly deposit dues at the academy office. Thank you.`;
}
