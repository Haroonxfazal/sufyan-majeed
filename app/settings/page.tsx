import { AppShell } from "@/components/layout/app-shell";
import { AutoRefresh } from "@/components/auto-refresh";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getCurrentProfile } from "@/lib/services/auth";
import { getAgentOnline } from "@/lib/services/agent-status";

export const metadata = { title: "Settings — Unique Academy" };

export default async function SettingsPage() {
  const [profile, agentOnline] = await Promise.all([getCurrentProfile(), getAgentOnline()]);

  return (
    <AppShell title="Settings" profile={profile}>
      <AutoRefresh />
      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-base">Academy program</CardTitle>
              <Badge variant={agentOnline ? "success" : "secondary"}>
                {agentOnline ? "Running" : "Closed"}
              </Badge>
            </div>
            <CardDescription>
              UniqueAcademyAgent.exe on the academy PC reads the fingerprint machine and uploads
              punches. SMS are sent by this website, not by the program.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="font-medium">Every day</p>
            <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
              <li>When classes start, double-click UniqueAcademyAgent on the academy PC.</li>
              <li>Leave the black window open (you can minimise it).</li>
              <li>When classes end, close the window.</li>
            </ol>
            <p className="text-muted-foreground">
              While it is closed, this website (including SMS) still works. Punches made while it
              was closed are picked up on the next start.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Troubleshooting</CardTitle>
            <CardDescription>If attendance or SMS are not updating.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">Program shows &quot;Closed&quot;:</span> open
              the program on the academy PC and check it has internet.
            </p>
            <p>
              <span className="font-medium text-foreground">Device offline:</span> check the MB460 is
              powered and its IP matches ZKTECO_IP in agent.env.
            </p>
            <p>
              <span className="font-medium text-foreground">SMS failed:</span> check the Android
              phone has internet and the SMS Gateway app is running in Cloud Server mode.
            </p>
            <p>
              <span className="font-medium text-foreground">Check the program&apos;s connections:</span> run
              <code className="mx-1 rounded bg-muted px-1 font-mono text-xs">UniqueAcademyAgent.exe --test</code>
              in a command prompt.
            </p>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
