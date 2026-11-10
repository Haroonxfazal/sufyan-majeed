"""
Unique Academy - Academy Agent
==============================
Runs on the academy PC during class hours. Close the window to stop it.

Every 2 seconds it:
  1. Reads new fingerprint punches from the ZKTeco MB460 and saves them to Supabase.
  2. Sends SMS that the website has queued, through the Android SMS gateway phone.
  3. Tells the website it is online (devices.updated_at heartbeat).

Settings are read from agent.env next to the .exe (or ../.env.local when run as a script).

Usage:
  UniqueAcademyAgent.exe            # run
  UniqueAcademyAgent.exe --test     # check Supabase, device and SMS phone, then exit
  UniqueAcademyAgent.exe --users    # list users enrolled on the device
"""

import argparse
import base64
import os
import sys
import threading
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
SMS_URL = os.getenv("SMS_GATEWAY_URL", "").rstrip("/")
SMS_TOKEN = os.getenv("SMS_GATEWAY_AUTH_TOKEN", "")
SMS_DEVICE_ID = os.getenv("SMS_GATEWAY_DEVICE_ID", "")
SMS_ENABLED = os.getenv("SMS_GATEWAY_ENABLED", "true").lower() == "true"
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
# SMS outbox
# ---------------------------------------------------------------------------

class PhoneOffline(Exception):
    pass


def normalize_phone(phone):
    digits = "".join(ch for ch in phone if ch.isdigit())
    if digits.startswith("0092") and len(digits) == 14:
        return "0" + digits[4:]
    if digits.startswith("92") and len(digits) == 12:
        return "0" + digits[2:]
    if len(digits) == 10 and digits.startswith("3"):
        return "0" + digits
    return digits


def auth_header():
    if not SMS_TOKEN:
        return {}
    if SMS_TOKEN.lower().startswith(("basic ", "bearer ")):
        return {"Authorization": SMS_TOKEN}
    if ":" in SMS_TOKEN:
        return {"Authorization": "Basic " + base64.b64encode(SMS_TOKEN.encode()).decode()}
    return {"Authorization": f"Bearer {SMS_TOKEN}"}


_working_sms_url = None


def send_via_phone(phone, message):
    """Returns provider message id. Raises PhoneOffline if the phone can't be reached."""
    global _working_sms_url
    phone = normalize_phone(phone)
    body = {
        "phoneNumbers": [phone], "message": message,
        "phone_number": phone, "phone": phone, "number": phone, "to": phone,
        "text": message, "body": message,
    }
    if SMS_DEVICE_ID:
        body.update({"device_id": SMS_DEVICE_ID, "device": SMS_DEVICE_ID})
    headers = {"Content-Type": "application/json", **auth_header()}

    candidates = [SMS_URL] + [f"{SMS_URL}{p}" for p in ("/message", "/v1/message", "/api/v1/message", "/send")
                              if not SMS_URL.endswith(p)]
    if _working_sms_url:
        candidates.insert(0, _working_sms_url)

    last_error, reached = "", False
    for url in dict.fromkeys(candidates):
        try:
            res = requests.post(url, json=body, headers=headers, timeout=8)
        except requests.RequestException as e:
            last_error = str(e)
            continue
        reached = True
        if res.ok:
            _working_sms_url = url
            try:
                data = res.json()
            except ValueError:
                data = {}
            return str(data.get("id") or data.get("message_id") or data.get("messageId") or f"GW-{int(time.time() * 1000)}")
        last_error = f"Gateway returned {res.status_code}: {res.text[:150]}"

    try:  # MacroDroid webhook fallback
        res = requests.get(f"{SMS_URL}/trigger", params={"id": "send_sms", "phone": phone, "message": message}, timeout=8)
        reached = True
        if res.ok:
            return f"MACRO-{int(time.time() * 1000)}"
    except requests.RequestException:
        pass

    if not reached:
        raise PhoneOffline(last_error)
    raise RuntimeError(last_error or "SMS gateway rejected the message")


def sms_loop(stop):
    offline_logged = False
    while not stop.is_set():
        try:
            queued = db("GET", "sms_logs", {
                "select": "id,to_phone,body", "status": "eq.queued",
                "order": "created_at.asc", "limit": "20",
            })
            for sms in queued:
                if not SMS_ENABLED:
                    update = {"status": "sent", "provider": "local_demo", "sent_at": now_iso(),
                              "provider_message_id": f"DEMO-{int(time.time() * 1000)}"}
                else:
                    try:
                        msg_id = send_via_phone(sms["to_phone"], sms["body"])
                        update = {"status": "sent", "provider": "android_gateway", "sent_at": now_iso(),
                                  "provider_message_id": msg_id, "error_message": None}
                        offline_logged = False
                    except PhoneOffline as e:
                        if not offline_logged:
                            log(f"SMS phone not reachable at {SMS_URL} - will keep retrying. ({e})")
                            offline_logged = True
                        break  # leave the rest queued, retry next round
                    except Exception as e:
                        update = {"status": "failed", "provider": "android_gateway", "error_message": str(e)[:250]}
                db("PATCH", "sms_logs", {"id": f"eq.{sms['id']}"}, json=update, prefer="return=minimal")
                log(f"SMS to {sms['to_phone']}: {update['status'].upper()}")
        except Exception as e:
            log(f"SMS check failed: {e}")
        stop.wait(INTERVAL if not offline_logged else 10)


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
    print("  UNIQUE ACADEMY - ACADEMY AGENT")
    print("  Keep this window open during class hours. Close it to stop.")
    print("=" * 62, flush=True)

    device_id = get_device_id()
    people = PeopleCache()
    people.refresh(force=True)
    log(f"Supabase OK. {len(people.students)} students linked to fingerprint IDs.")
    log(f"SMS: {'sending through ' + SMS_URL if SMS_ENABLED else 'DEMO mode (SMS only logged)'}")

    stop = threading.Event()
    threading.Thread(target=sms_loop, args=(stop,), daemon=True).start()

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
        stop.set()
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
    if SMS_ENABLED:
        try:
            requests.get(SMS_URL, timeout=5)
            print(f"[OK]   SMS phone reachable at {SMS_URL}")
        except requests.RequestException as e:
            ok = False
            print(f"[FAIL] SMS phone at {SMS_URL}: {e}")
    else:
        print("[INFO] SMS is in DEMO mode (SMS_GATEWAY_ENABLED=false)")
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
