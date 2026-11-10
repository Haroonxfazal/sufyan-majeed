-- One-time cleanup. Run once in the Supabase SQL Editor.
--
-- Old punches were saved without device_id, so the "no duplicates" rule never matched
-- and every restart of the sync saved all punches again. This removes those copies and
-- attaches the old punches to the MB460 so new syncs recognise them.

-- 1. Remove duplicate copies among punches with no device (keeps one of each)
delete from public.attendance_logs a
using public.attendance_logs b
where a.device_id is null
  and b.device_id is null
  and a.zk_user_id = b.zk_user_id
  and a.punched_at = b.punched_at
  and a.id > b.id;

-- 2. Remove no-device punches that already exist with the device set
delete from public.attendance_logs a
using public.attendance_logs b
where a.device_id is null
  and b.device_id is not null
  and a.zk_user_id = b.zk_user_id
  and a.punched_at = b.punched_at;

-- 3. Attach the remaining old punches to the MB460
update public.attendance_logs
set device_id = (select id from public.devices where serial_number = 'AF6P210960179')
where device_id is null;

-- 4. (Optional) Find days where a student was marked present only because an OLD punch
--    was replayed (check-in time is on a different day than the attendance date).
select d.attendance_date, s.full_name, d.check_in_at
from public.daily_attendance d
join public.students s on s.id = d.student_id
where d.source = 'device'
  and (d.check_in_at at time zone 'Asia/Karachi')::date <> d.attendance_date
order by d.attendance_date desc;

-- If the list above looks wrong, uncomment and run this to remove those rows
-- (those students go back to "unmarked" for that day):
-- delete from public.daily_attendance
-- where source = 'device'
--   and (check_in_at at time zone 'Asia/Karachi')::date <> attendance_date;
