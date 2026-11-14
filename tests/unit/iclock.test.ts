import { beforeEach, describe, expect, it, vi } from "vitest";

const findDevice = vi.fn();
const heartbeat = vi.fn();
const savePunches = vi.fn();

vi.mock("@/lib/services/iclock", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/services/iclock")>()),
  findDevice: (...a: unknown[]) => findDevice(...a),
  heartbeat: (...a: unknown[]) => heartbeat(...a),
}));
vi.mock("@/lib/services/punches", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/services/punches")>()),
  savePunches: (...a: unknown[]) => savePunches(...a),
}));

const cdata = await import("@/app/iclock/cdata/route");
const getrequest = await import("@/app/iclock/getrequest/route");
const querydata = await import("@/app/iclock/querydata/route");
const devicecmd = await import("@/app/iclock/devicecmd/route");

const SN = "AF6P210960179";
const ctx = { id: "dev-1", supabase: {} };
const url = (path: string) => `http://relay/iclock/${path}`;

beforeEach(() => {
  findDevice.mockReset();
  heartbeat.mockReset();
  savePunches.mockReset();
  findDevice.mockImplementation(async (sn: string | null) => (sn === SN ? ctx : null));
  savePunches.mockImplementation(async (_s: unknown, _d: unknown, p: unknown[]) => p.length);
});

describe("GET /iclock/cdata (handshake)", () => {
  it("rejects unknown machines", async () => {
    const res = await cdata.GET(new Request(url("cdata?SN=EVIL")));
    expect(res.status).toBe(403);
    expect(heartbeat).not.toHaveBeenCalled();
  });

  it("returns the options block with a correct Content-Length", async () => {
    const res = await cdata.GET(new Request(url(`cdata?SN=${SN}&options=all&pushver=2.4.1`)));
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body.startsWith(`GET OPTION FROM: ${SN}\n`)).toBe(true);
    expect(body).toContain("ATTLOGStamp=0");
    expect(body).toContain("Realtime=1");
    expect(body).toContain("TimeZone=5");
    expect(res.headers.get("content-length")).toBe(String(new TextEncoder().encode(body).length));
    expect(heartbeat).toHaveBeenCalledOnce();
  });

  it("never asks the machine for fingerprint templates or photos", async () => {
    const body = await (await cdata.GET(new Request(url(`cdata?SN=${SN}`)))).text();
    const flag = body.split("\n").find((l) => l.startsWith("TransFlag="));
    expect(flag).toBe("TransFlag=TransData AttLog");
  });
});

describe("POST /iclock/cdata (uploads)", () => {
  const post = (query: string, body: string) =>
    cdata.POST(new Request(url(`cdata?SN=${SN}&${query}`), { method: "POST", body }));

  it("parses ATTLOG lines into punches", async () => {
    const res = await post(
      "table=ATTLOG&Stamp=0",
      "2\t2026-11-14 21:35:55\t0\t1\t0\t0\t0\n7\t2026-11-14 22:10:06\t1\t1\t0\n",
    );
    expect(await res.text()).toBe("OK: 2");
    const punches = savePunches.mock.calls[0][2];
    expect(punches).toEqual([
      { zkUserId: "2", punchedAt: new Date("2026-11-14T16:35:55Z"), punch: 0, status: 1 },
      { zkUserId: "7", punchedAt: new Date("2026-11-14T17:10:06Z"), punch: 1, status: 1 },
    ]);
  });

  it("skips blank and malformed lines", async () => {
    const res = await post("table=ATTLOG", "\n\t\nabc\n5\tnot-a-time\t0\n5\t2026-11-14 08:00:00\r\n");
    expect(await res.text()).toBe("OK: 1");
  });

  it("acknowledges other tables (options, OPERLOG) without saving", async () => {
    const res = await post("table=options", "~DeviceName=MB460/ID,TransactionCount=46");
    expect(await res.text()).toBe("OK");
    expect(savePunches).not.toHaveBeenCalled();
    expect(heartbeat).toHaveBeenCalledOnce();
  });

  it("answers 500 when saving fails, so the machine keeps and resends the records", async () => {
    savePunches.mockRejectedValueOnce(new Error("db down"));
    const res = await post("table=ATTLOG", "2\t2026-11-14 08:00:00\t0");
    expect(res.status).toBe(500);
  });

  it("rejects uploads from unknown machines", async () => {
    const res = await cdata.POST(new Request(url("cdata?SN=EVIL&table=ATTLOG"), { method: "POST", body: "1\t2026-11-14 08:00:00" }));
    expect(res.status).toBe(403);
    expect(savePunches).not.toHaveBeenCalled();
  });
});

describe("other machine endpoints", () => {
  it("getrequest: heartbeat + OK for the real machine, 403 otherwise", async () => {
    const ok = await getrequest.GET(new Request(url(`getrequest?SN=${SN}`)));
    expect(await ok.text()).toBe("OK");
    expect(heartbeat).toHaveBeenCalledOnce();
    expect((await getrequest.GET(new Request(url("getrequest")))).status).toBe(403);
  });

  it("querydata: parses key=value rows with flexible field names", async () => {
    const res = await querydata.POST(
      new Request(url(`querydata?SN=${SN}&type=tablerows`), {
        method: "POST",
        body: "pin=2\ttime=2026-11-14 08:00:00\tstatus=0\nUserID=5\tCheckTime=2026-11-14 09:00:00\nnothing here\n",
      }),
    );
    expect(await res.text()).toBe("OK");
    expect(savePunches.mock.calls[0][2].map((p: { zkUserId: string }) => p.zkUserId)).toEqual(["2", "5"]);
  });

  it("devicecmd: always acknowledges", async () => {
    expect(await (await devicecmd.POST()).text()).toBe("OK");
  });
});
