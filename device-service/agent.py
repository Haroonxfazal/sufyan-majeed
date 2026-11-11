"""
Unique Academy - Academy Agent
==============================
Runs on the academy PC during class hours. Close the window to stop it.

Every 2 seconds it:
  1. Reads new fingerprint punches from the ZKTeco MB460 and saves them to Supabase.
  2. Tells the website it is online (devices.updated_at heartbeat).
SMS are sent by the website itself, not by this program.

Settings are read from agent.env next to the .exe (or ../.env.local when run as a script).

Usage:
  UniqueAcademyAgent.exe            # run
  UniqueAcademyAgent.exe --test     # check Supabase and the device, then exit
  UniqueAcademyAgent.exe --users    # list users enrolled on the device
"""

import argparse
import os
import sys
import time
from datetime import datetime, timedelta, timezone

import requests

PKT = timezone(timedelta(hours=5))  # Asia/Karachi, no DST


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

def app_dir():
    if getattr(sys, "frozen", False):  # running as PyInstaller .exe
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


def load_env_file(path):
    if not os.path.exists(path):
        return False
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            value = value.strip().strip('"').strip("'")
            os.environ.setdefault(key.strip(), value)
    return True


for candidate in (
    os.path.join(app_dir(), "agent.env"),
    os.path.join(app_dir(), "..", ".env.local"),
):
    if load_env_file(candidate):
        break

SUPABASE_URL = os.getenv("NEXT_PUBLIC_SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
DEVICE_IP = os.getenv("ZKTECO_IP", "192.168.100.30")
DEVICE_PORT = int(os.getenv("ZKTECO_PORT") or 4370)
DEVICE_PASSWORD = int(os.getenv("ZKTECO_PASSWORD") or 0)
DEVICE_TIMEOUT = int(os.getenv("ZKTECO_TIMEOUT") or 5)
DEVICE_SERIAL = os.getenv("ZKTECO_DEVICE_SERIAL", "AF6P210960179")
INTERVAL = float(os.getenv("AGENT_INTERVAL_SECONDS") or 2)
CATCHUP_DAYS = int(os.getenv("AGENT_CATCHUP_DAYS") or 2)


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


# ---------------------------------------------------------------------------
# Supabase REST helpers
# ---------------------------------------------------------------------------

session = requests.Session()
session.headers.update({
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
})


def db(method, table, params=None, json=None, prefer=None):
    headers = {"Prefer": prefer} if prefer else {}
    res = session.request(
        method, f"{SUPABASE_URL}/rest/v1/{table}",
        params=params, json=json, headers=headers, timeout=15,
    )
    if res.status_code >= 400:
        raise RuntimeError(f"Supabase {method} {table} failed ({res.status_code}): {res.text[:200]}")
    return res.json() if res.text else None


def in_list(values):
    return "in.(" + ",".join(f'"{v}"' for v in values) + ")"


def now_iso():
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Attendance
# ---------------------------------------------------------------------------

class PeopleCache:
    """zk_user_id -> student/staff id, refreshed every minute so new enrollments work."""

    def __init__(self):
        self.students, self.staff, self.loaded_at = {}, {}, 0.0

    def refresh(self, force=False):
        if not force and time.time() - self.loaded_at < 60:
            return
        rows = db("GET", "students", {"select": "id,zk_user_id", "zk_user_id": "not.is.null"})
        self.students = {str(r["zk_user_id"]): r["id"] for r in rows}
        rows = db("GET", "staff", {"select": "id,zk_user_id", "zk_user_id": "not.is.null"})
        self.staff = {str(r["zk_user_id"]): r["id"] for r in rows}
        self.loaded_at = time.time()


def save_punches(records, device_id, people):
    """records: list of pyzk Attendance objects. Saves logs and marks students present."""
    people.refresh()

    log_rows = []
    earliest = {}  # (student_id, date) -> earliest punch iso
    for att in records:
        ts = att.timestamp if att.timestamp.tzinfo else att.timestamp.replace(tzinfo=PKT)
        ts_iso = ts.astimezone(PKT).isoformat()
        zk_id = str(att.user_id)
        student_id = people.students.get(zk_id)
        staff_id = None if student_id else people.staff.get(zk_id)
        log_rows.append({
            "device_id": device_id,
            "zk_user_id": zk_id,
            "punched_at": ts_iso,
            "punch_type": "check_in" if att.punch == 0 else "check_out",
            "punch_status_raw": str(att.status),
            "person_type": "student" if student_id else ("staff" if staff_id else None),
            "student_id": student_id,
            "staff_id": staff_id,
            "raw_payload": {"zk_user_id": zk_id, "punched_at": ts_iso, "punch": att.punch, "status": att.status},
        })
        if student_id:
            key = (student_id, ts.astimezone(PKT).date().isoformat())
            if key not in earliest or ts_iso < earliest[key]:
                earliest[key] = ts_iso

    if not log_rows:
        return 0

    db("POST", "attendance_logs", {"on_conflict": "device_id,zk_user_id,punched_at"},
       json=log_rows, prefer="resolution=ignore-duplicates,return=minimal")

    if earliest:
        student_ids = sorted({k[0] for k in earliest})
        dates = sorted({k[1] for k in earliest})
        existing_rows = db("GET", "daily_attendance", {
            "select": "id,student_id,attendance_date,status,check_in_at",
            "student_id": in_list(student_ids),
            "attendance_date": in_list(dates),
        })
        existing = {(r["student_id"], r["attendance_date"]): r for r in existing_rows}

        inserts = []
        for (student_id, date), punch_iso in earliest.items():
            row = existing.get((student_id, date))
            if row is None:
                inserts.append({
                    "person_type": "student", "student_id": student_id, "attendance_date": date,
                    "status": "present", "check_in_at": punch_iso, "source": "device",
                })
                continue
            old_checkin = row.get("check_in_at")
            earlier = old_checkin is None or datetime.fromisoformat(punch_iso) < datetime.fromisoformat(old_checkin)
            if row["status"] == "absent" or earlier:
                db("PATCH", "daily_attendance", {"id": f"eq.{row['id']}"}, json={
                    "status": "present" if row["status"] in ("absent", "present") else row["status"],
                    "check_in_at": punch_iso if earlier else old_checkin,
                    "source": "device",
                }, prefer="return=minimal")
        if inserts:
            db("POST", "daily_attendance", json=inserts, prefer="return=minimal")

    return len(log_rows)


class DeviceReader:
    def __init__(self):
        self.conn = None
        self.last_count = None
        self.sent = set()  # (user_id, timestamp) already saved

    def connect(self):
        from zk import ZK
        zk = ZK(DEVICE_IP, port=DEVICE_PORT, timeout=DEVICE_TIMEOUT,
                password=DEVICE_PASSWORD, force_udp=False, ommit_ping=True)
        self.conn = zk.connect()
        try:
            self.conn.set_time(datetime.now())  # keep device clock = PC clock
        except Exception:
            pass
        self.last_count = None
        log(f"Connected to fingerprint machine at {DEVICE_IP}:{DEVICE_PORT}")

    def disconnect(self):
        if self.conn:
            try:
                self.conn.disconnect()
            except Exception:
                pass
        self.conn = None

    def new_records(self):
        """Returns punches not yet saved (only re-reads the log when the count changes)."""
        if self.conn is None:
            self.connect()
        self.conn.read_sizes()
        count = self.conn.records
        if count == self.last_count:
            return []
        records = self.conn.get_attendance()
        cutoff = datetime.now() - timedelta(days=CATCHUP_DAYS)
        fresh = [
            a for a in records
            if a.timestamp.replace(tzinfo=None) >= cutoff and (str(a.user_id), a.timestamp) not in self.sent
        ]
        self.pending_count = count
        if not fresh:
            self.last_count = count
        return fresh

    def mark_saved(self, records):
        # only now accept the new count, so a failed save is retried next round
        for a in records:
            self.sent.add((str(a.user_id), a.timestamp))
        self.last_count = self.pending_count


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def heartbeat(device_ok, error=None):
    update = {"status": "online" if device_ok else "offline", "last_error": error,
              "ip_address": DEVICE_IP, "updated_at": now_iso()}
    if device_ok:
        update["last_seen_at"] = now_iso()
    db("PATCH", "devices", {"serial_number": f"eq.{DEVICE_SERIAL}"}, json=update, prefer="return=minimal")


def get_device_id():
    rows = db("GET", "devices", {"select": "id", "serial_number": f"eq.{DEVICE_SERIAL}"})
    if rows:
        return rows[0]["id"]
    rows = db("POST", "devices", json={"name": "Main Gate MB460", "model": "MB460/ID",
                                       "serial_number": DEVICE_SERIAL, "port": DEVICE_PORT},
              prefer="return=representation")
    return rows[0]["id"]


def run():
    print("=" * 62)
    print("  UNIQUE ACADEMY - ATTENDANCE AGENT")
    print("  Keep this window open during class hours. Close it to stop.")
    print("=" * 62, flush=True)

    device_id = get_device_id()
    people = PeopleCache()
    people.refresh(force=True)
    log(f"Supabase OK. {len(people.students)} students linked to fingerprint IDs.")

    reader = DeviceReader()
    last_beat, last_error_logged = 0.0, None
    try:
        while True:
            device_ok, error = True, None
            try:
                fresh = reader.new_records()
                if fresh:
                    saved = save_punches(fresh, device_id, people)
                    reader.mark_saved(fresh)
                    if len(fresh) <= 10:
                        for a in fresh:
                            log(f"Punch saved: device user {a.user_id} at {a.timestamp.strftime('%H:%M:%S')}")
                    else:
                        log(f"Caught up {saved} punches from the last {CATCHUP_DAYS} day(s).")
                last_error_logged = None
            except Exception as e:
                device_ok, error = False, str(e)[:250]
                reader.disconnect()
                if error != last_error_logged:
                    log(f"Problem: {error} (retrying...)")
                    last_error_logged = error

            if time.time() - last_beat >= 5 or not device_ok:
                try:
                    heartbeat(device_ok, error)
                    last_beat = time.time()
                except Exception as e:
                    log(f"Could not reach Supabase: {e}")
            time.sleep(INTERVAL)
    except KeyboardInterrupt:
        pass
    finally:
        reader.disconnect()
        try:
            heartbeat(False, "Academy agent stopped")
        except Exception:
            pass
        log("Stopped.")


def test():
    ok = True
    try:
        people = PeopleCache()
        people.refresh(force=True)
        print(f"[OK]   Supabase: {len(people.students)} students linked to fingerprint IDs")
    except Exception as e:
        ok = False
        print(f"[FAIL] Supabase: {e}")
    try:
        reader = DeviceReader()
        reader.connect()
        reader.conn.read_sizes()
        print(f"[OK]   Fingerprint machine: serial {reader.conn.get_serialnumber()}, {reader.conn.records} punches stored")
        reader.disconnect()
    except Exception as e:
        ok = False
        print(f"[FAIL] Fingerprint machine at {DEVICE_IP}:{DEVICE_PORT}: {e}")
    return ok


def list_users():
    reader = DeviceReader()
    reader.connect()
    users = reader.conn.get_users()
    print(f"\n{len(users)} users enrolled on the device:")
    for u in users:
        print(f"  ID: {u.user_id:<10} {u.name or ''}")
    reader.disconnect()


def main():
    parser = argparse.ArgumentParser(description="Unique Academy agent")
    parser.add_argument("--test", action="store_true", help="check connections and exit")
    parser.add_argument("--users", action="store_true", help="list users enrolled on the device")
    args = parser.parse_args()

    if not SUPABASE_URL or not SUPABASE_KEY:
        print("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Put them in agent.env next to this program.")
        input("Press Enter to close...")
        sys.exit(1)

    if args.test:
        test()
        input("\nPress Enter to close...")
    elif args.users:
        list_users()
        input("\nPress Enter to close...")
    else:
        while True:  # if startup fails (no internet yet), retry instead of closing
            try:
                run()
                break
            except Exception as e:
                log(f"Startup failed: {e}. Retrying in 10 seconds...")
                time.sleep(10)


if __name__ == "__main__":
    main()
