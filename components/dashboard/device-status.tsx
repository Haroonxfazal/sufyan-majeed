import { Fingerprint, Monitor, Wifi } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { displayDateTime } from "@/lib/utils";
import type { Device } from "@/lib/types/database";

export function DeviceStatusCard({
  devices,
  agentOnline,
}: {
  devices: Device[];
  agentOnline: boolean;
}) {
  return (
    <Card className="h-full flex flex-col justify-between">
      <div>
        <CardHeader className="flex flex-row items-center justify-between gap-3 pb-3">
          <div className="space-y-0.5">
            <CardTitle className="text-base font-semibold">Academy Connection</CardTitle>
            <p className="text-xs text-muted-foreground">Academy program + ZKTeco MB460</p>
          </div>
          {agentOnline ? (
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-600 bg-emerald-50 dark:bg-emerald-950/60 dark:text-emerald-400 px-2 py-0.5 rounded-full border border-emerald-200 dark:border-emerald-800">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
              Program running
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground bg-muted px-2 py-0.5 rounded-full border">
              <Monitor className="h-3 w-3" />
              Program closed
            </span>
          )}
        </CardHeader>

        <CardContent className="space-y-3">
          {devices.length === 0 ? (
            <EmptyState
              icon={Fingerprint}
              title="No device registered"
              description="The MB460 appears here the first time the academy program runs."
            />
          ) : (
            devices.map((device) => {
              const isOnline = agentOnline && device.status === "online";
              const label = !agentOnline ? "not checked" : device.status;
              return (
                <div
                  key={device.id}
                  className="rounded-xl border border-border/70 bg-card p-3.5 shadow-2xs"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                      <div
                        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                          isOnline
                            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-400"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        <Wifi className="h-4 w-4" />
                      </div>
                      <div>
                        <p className="font-semibold text-sm leading-tight text-foreground">{device.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {device.model} {device.serial_number ? `· SN: ${device.serial_number}` : ""}
                        </p>
                      </div>
                    </div>
                    <Badge
                      variant={isOnline ? "success" : agentOnline ? "danger" : "secondary"}
                      className="capitalize"
                    >
                      {label}
                    </Badge>
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-muted-foreground border-t pt-2.5">
                    <div>
                      <span className="font-medium text-foreground">IP:</span>{" "}
                      {device.ip_address || "—"}:{device.port || 4370}
                    </div>
                    <div className="text-right">
                      <span className="font-medium text-foreground">Last seen:</span>{" "}
                      {displayDateTime(device.last_seen_at)}
                    </div>
                  </div>

                  {agentOnline && device.last_error && (
                    <p className="mt-2 text-xs text-rose-600 bg-rose-50 dark:bg-rose-950/30 p-2 rounded-md">
                      {device.last_error}
                    </p>
                  )}
                </div>
              );
            })
          )}
        </CardContent>
      </div>

      <div className="p-4 pt-0">
        <p className="text-[11px] text-muted-foreground text-center">
          Open UniqueAcademyAgent.exe on the academy PC during class hours. Punches appear here within seconds.
        </p>
      </div>
    </Card>
  );
}
