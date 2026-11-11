import { AppShell } from "@/components/layout/app-shell";
import { SmsHub } from "@/components/sms/sms-hub";
import { getCurrentProfile } from "@/lib/services/auth";
import {
  getAbsenteeRecipients,
  getFeePendingRecipients,
  getSmsLogs,
  isSmsGatewayEnabled,
} from "@/lib/services/sms";
import { AutoRefresh } from "@/components/auto-refresh";
import { todayInKarachi } from "@/lib/utils";

export default async function SmsPage() {
  const [profile, absentees, feePending, logs] = await Promise.all([
    getCurrentProfile(),
    getAbsenteeRecipients(todayInKarachi()),
    getFeePendingRecipients(),
    getSmsLogs(50),
  ]);

  return (
    <AppShell title="SMS Service" profile={profile}>
      <AutoRefresh />
      <SmsHub
        initialAbsentees={absentees}
        initialFeePending={feePending}
        initialLogs={logs}
        currentDate={todayInKarachi()}
        gatewayEnabled={isSmsGatewayEnabled()}
      />
    </AppShell>
  );
}
