# Unique Academy Management System

Production application for one academy in Pakistan (up to 250 students and staff). The principal manages students, staff, ZKTeco MB460 attendance, fees, SMS, classes, and reports.

This repository is being built in phases. **Phase 1 is complete:** Next.js app shell, Supabase clients, authentication, SQL schema, and a live dashboard (no hardcoded sample people or fees).

## Stack

- Next.js App Router, TypeScript, Tailwind CSS, shadcn/ui
- Supabase PostgreSQL, Auth, Row Level Security
- `@supabase/supabase-js` and `@supabase/ssr`
- Zod, React Hook Form, Recharts, Lucide
- Python + pyzk for the MB460 (Phase 3, `device-service/`)

Prisma is not used. There is no local PostgreSQL server. All database work goes through Supabase.

## Phase status

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | App shell, auth, migrations, dashboard | Done |
| 2 | Students, staff, parents, classes | Next |
| 3 | ZKTeco connection test and attendance sync | Planned |
| 4 | Attendance calculations and reports | Planned |
| 5 | Fees, invoices, payments, receipts | Planned |
| 6 | SMS templates, preferences, logs | Planned |
| 7 | Final reports, settings, security review, deploy | Planned |

## Setup

### 1. Prerequisites

- Node.js 20 or later
- npm
- A Supabase project (cloud)
- Python 3.11+ (needed from Phase 3)

### 2. Supabase project

1. Create a project in the [Supabase dashboard](https://supabase.com/dashboard).
2. Turn **off** public sign-ups (Authentication → Providers → Email → disable new user sign-ups if you invite staff yourself).
3. Open SQL Editor and run `supabase/migrations/20261031120000_init.sql`.
4. Create the principal Auth user: Authentication → Users → Add user (email + password).
5. Promote that user:

```sql
update public.profiles
set role = 'principal',
    full_name = 'Principal',
    is_active = true
where email = 'principal@your-academy.com';
```

Students do not receive login accounts.

### 3. How it runs

```
Academy PC (class hours)                 Cloud                     Anyone, anywhere
UniqueAcademyAgent.exe  --writes-->  Supabase  <--reads--  Website on Cloudflare Workers
 - MB460 punches every 2s             (database)               (refreshes every 2s)
 - sends queued SMS via phone  <--sms queue--   "Send SMS" queues rows in sms_logs
```

- The **website** runs on Cloudflare and talks only to Supabase.
- The **academy agent** (`device-service/agent.py`, built as `UniqueAcademyAgent.exe`) is the only part
  that needs the academy network: it reads the MB460 and sends SMS through the Android gateway phone.
- Daily: open `UniqueAcademyAgent.exe` when classes start, close its window when they end.
  While it is closed, SMS wait in the queue and punches are picked up on the next start.

### 4. Website (deploy from any PC)

```powershell
copy .env.example .env.local   # fill in the Supabase values
npm install
npm run dev                    # local development, http://localhost:3000
npx wrangler login             # once
npm run deploy                 # build + upload to Cloudflare Workers
```

`npm run deploy` reads `.env.local` at build time and bundles the values into the Worker.
After deploying, the site is at `https://unique-academy.<your-subdomain>.workers.dev`
(add a custom domain in the Cloudflare dashboard if you want one).

### 5. Academy agent (build once, copy to the academy PC)

```powershell
device-service\build_exe.bat
```

This makes `device-service\dist\UniqueAcademyAgent.exe`. Copy it with `agent.env` (from
`device-service\agent.env.example`) to the academy PC, fill in `agent.env`, and make a desktop shortcut.

- `UniqueAcademyAgent.exe --test` checks Supabase, the fingerprint machine and the SMS phone.
- `UniqueAcademyAgent.exe --users` lists users enrolled on the machine.
- For development without building: `device-service\run_agent.bat` (reads `.env.local`).

### Environment notes

| Variable | Where it is used |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_*` | Website and agent |
| `SUPABASE_SERVICE_ROLE_KEY` | Website server code and agent |
| `ZKTECO_*` | Agent only (`agent.env`) |
| `SMS_GATEWAY_*` | Agent only (`agent.env`) |
| `AGENT_INTERVAL_SECONDS`, `AGENT_CATCHUP_DAYS` | Agent polling speed and start-up catch-up window |

Do not expose port 4370 to the internet; the agent reaches the MB460 over the academy network.

## Database

Migrations live in `supabase/migrations/`. They create:

`profiles`, `students`, `staff`, `parents`, `student_parents`, `classes`, `enrollments`, `devices`, `biometric_users`, `attendance_logs`, `daily_attendance`, `shifts`, `holidays`, `leave_requests`, `fee_structures`, `invoices`, `invoice_items`, `payments`, `fee_adjustments`, `sms_templates`, `sms_logs`, `notification_preferences`, `system_settings`, `audit_logs`, `device_sync_checkpoints`

Money columns use `numeric(12,2)`. Payments are recorded atomically with `public.record_payment(...)`.

After the schema is applied, generate TypeScript types when the Supabase CLI is logged in:

```powershell
npx supabase gen types typescript --project-id YOUR_PROJECT_ID > lib/types/database.generated.ts
```

Hand-written types in `lib/types/database.ts` match Phase 1 and can be replaced by generated types later.

## Roles

- Principal
- Administrator
- Office Staff
- Teacher (optional)

RLS allows active staff to read operational data. Writes are limited to principal, administrator, and office staff. Device and system settings writes are principal/administrator only.

## MB460

- Model: MB460/ID
- Serial: AF6P210960179
- MAC: 00:17:61:11:9e:86
- TCP/IP port: 4370

A device row is seeded without an IP address. Phase 3 will start with a standalone Python connection test before full sync. Device logs are never deleted automatically.

## Scripts

```powershell
npm run dev       # local development
npm run build     # Next.js build check
npm run preview   # run the Cloudflare build locally
npm run deploy    # deploy to Cloudflare Workers
```
