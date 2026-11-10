import { AppShell } from "@/components/layout/app-shell";
import { SmsHub } from "@/components/sms/sms-hub";
import { getCurrentProfile } from "@/lib/services/auth";
import {
  getAbsenteeRecipients,
  getFeePendingRecipients,
  getSmsLogs,
} from "@/lib/services/sms";
import { getAgentOnline } from "@/lib/services/agent-status";
import { AutoRefresh } from "@/components/auto-refresh";
import { todayInKarachi } from "@/lib/utils";

export default async function SmsPage() {
  const [profile, absentees, feePending, logs, agentOnline] = await Promise.all([
    getCurrentProfile(),
    getAbsenteeRecipients(todayInKarachi()),
    getFeePendingRecipients(),
    getSmsLogs(50),
    getAgentOnline(),
  ]);

  return (
    <AppShell title="SMS Service" profile={profile}>
      <AutoRefresh />
      <SmsHub
        initialAbsentees={absentees}
        initialFeePending={feePending}
        initialLogs={logs}
        currentDate={todayInKarachi()}
        agentOnline={agentOnline}
      />
    </AppShell>
  );
}
