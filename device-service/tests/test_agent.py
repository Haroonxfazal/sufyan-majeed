"""
Tests for the academy agent's save logic (no network, no device).
Run:  python -m unittest discover -s device-service/tests -v
"""
import os
import sys
import unittest
from datetime import datetime
from types import SimpleNamespace

os.environ.setdefault("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import agent  # noqa: E402


class FakeDb:
    """Records every call to agent.db and answers from canned data."""

    def __init__(self, daily=None):
        self.calls = []
        self.daily = daily or []

    def __call__(self, method, table, params=None, json=None, prefer=None):
        self.calls.append((method, table, params, json))
        if method == "GET" and table == "students":
            return [{"id": "stu-ali", "zk_user_id": "2"}, {"id": "stu-sara", "zk_user_id": 5}]
        if method == "GET" and table == "staff":
            return [{"id": "staff-1", "zk_user_id": "90"}]
        if method == "GET" and table == "daily_attendance":
            return self.daily
        return None

    def find(self, method, table):
        return [c for c in self.calls if c[0] == method and c[1] == table]


def punch(user_id, ts, punch_type=0):
    return SimpleNamespace(user_id=user_id, timestamp=datetime.fromisoformat(ts), punch=punch_type, status=1)


class SavePunchesTest(unittest.TestCase):
    def run_save(self, records, daily=None):
        fake = FakeDb(daily)
        original = agent.db
        agent.db = fake
        try:
            people = agent.PeopleCache()
            saved = agent.save_punches(records, "dev-1", people)
        finally:
            agent.db = original
        return saved, fake

    def test_empty_batch_writes_nothing(self):
        saved, fake = self.run_save([])
        self.assertEqual(saved, 0)
        self.assertEqual(fake.find("POST", "attendance_logs"), [])

    def test_logs_all_punches_and_marks_present_with_earliest_time(self):
        saved, fake = self.run_save([
            punch("2", "2026-11-14 09:10:00"),
            punch("2", "2026-11-14 08:05:00"),
            punch("2", "2026-11-14 13:00:00", punch_type=1),
        ])
        self.assertEqual(saved, 3)
        (_, _, params, rows), = fake.find("POST", "attendance_logs")
        self.assertEqual(params, {"on_conflict": "device_id,zk_user_id,punched_at"})
        self.assertEqual([r["punch_type"] for r in rows], ["check_in", "check_in", "check_out"])
        self.assertTrue(all(r["student_id"] == "stu-ali" for r in rows))
        (_, _, _, inserts), = fake.find("POST", "daily_attendance")
        self.assertEqual(inserts, [{
            "person_type": "student", "student_id": "stu-ali", "attendance_date": "2026-11-14",
            "status": "present", "check_in_at": "2026-11-14T08:05:00+05:00", "source": "device",
        }])

    def test_numeric_ids_from_database_still_match(self):
        _, fake = self.run_save([punch(5, "2026-11-14 08:00:00")])
        (_, _, _, rows), = fake.find("POST", "attendance_logs")
        self.assertEqual(rows[0]["student_id"], "stu-sara")

    def test_absent_becomes_present(self):
        _, fake = self.run_save(
            [punch("2", "2026-11-14 10:00:00")],
            daily=[{"id": "d1", "student_id": "stu-ali", "attendance_date": "2026-11-14", "status": "absent", "check_in_at": None}],
        )
        (_, _, params, body), = fake.find("PATCH", "daily_attendance")
        self.assertEqual(params, {"id": "eq.d1"})
        self.assertEqual(body["status"], "present")
        self.assertEqual(fake.find("POST", "daily_attendance"), [])

    def test_later_punch_does_not_move_check_in(self):
        _, fake = self.run_save(
            [punch("2", "2026-11-14 10:00:00")],
            daily=[{"id": "d1", "student_id": "stu-ali", "attendance_date": "2026-11-14", "status": "present",
                    "check_in_at": "2026-11-14T08:00:00+05:00"}],
        )
        self.assertEqual(fake.find("PATCH", "daily_attendance"), [])

    def test_unknown_and_staff_ids_are_logged_but_mark_no_student(self):
        _, fake = self.run_save([punch("77", "2026-11-14 08:00:00"), punch("90", "2026-11-14 08:01:00")])
        (_, _, _, rows), = fake.find("POST", "attendance_logs")
        self.assertEqual((rows[0]["person_type"], rows[0]["student_id"]), (None, None))
        self.assertEqual((rows[1]["person_type"], rows[1]["staff_id"]), ("staff", "staff-1"))
        self.assertEqual(fake.find("GET", "daily_attendance"), [])


class DeviceReaderTest(unittest.TestCase):
    def test_only_new_records_are_returned_and_failed_saves_are_retried(self):
        recent = datetime.now().replace(microsecond=0)
        records = [SimpleNamespace(user_id="2", timestamp=recent, punch=0, status=1)]
        conn = SimpleNamespace(records=1, read_sizes=lambda: None, get_attendance=lambda: records)
        reader = agent.DeviceReader()
        reader.conn = conn

        first = reader.new_records()
        self.assertEqual(len(first), 1)
        # save failed -> not marked -> the same record comes back next round
        self.assertEqual(len(reader.new_records()), 1)
        reader.mark_saved(first)
        self.assertEqual(reader.new_records(), [])


if __name__ == "__main__":
    unittest.main()
