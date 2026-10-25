# Read-only production preflight access

How to give `scripts/production-preflight.mjs` read-only access to the Railway
production database, through the **existing** public endpoint
(`acela.proxy.rlwy.net:17722`, database `railway`). No new network exposure, no
change to any application table.

## 1. What the preflight needs

| Kind | Exactly |
|---|---|
| Database | `CONNECT` on `railway` |
| Schema | `USAGE` on `public`. No `CREATE`. |
| Columns (SELECT) | `_prisma_migrations`: migration_name, finished_at, rolled_back_at |
| | `leads`: id, organization_id, status, deleted_at, assigned_to, next_follow_up_at, email¹, duplicate_acknowledged_at |
| | `follow_ups`: id, organization_id, lead_id, status, assigned_user_id, created_at |
| | `lead_activities`: organization_id, lead_id |
| | `organization_users`: organization_id, user_id, status |
| | `audit_logs`: organization_id, action, entity_id, before², created_at |
| Catalog | `pg_database`, `pg_attribute`, `pg_class`, `pg_enum`, `pg_type`, `pg_roles` and the `has_*_privilege` functions. All readable by every role by default; nothing to grant. |
| Write / DDL | **None.** No INSERT, UPDATE, DELETE, TRUNCATE, CREATE, ALTER or DROP. |

¹ Used only to group duplicate addresses (check F); never printed.
² Used only for `before->>'assignedToId'` (check A).

The role can't read names, phone numbers, notes, addresses, user passwords or
tokens, or any other table. It owns nothing, so it can't ALTER or DROP anything.
Every session it opens is read-only, statements stop after 60 s and lock waits
after 5 s, it can open at most 2 connections, and it **expires on 2026-11-30**.

The SQL is [`preflight-role.sql`](./preflight-role.sql). It was tested on
PostgreSQL 17 at production's exact schema level:
- the verifier passed 12/12;
- the preflight ran fully;
- every write, DDL and private-column read was refused, even with the session's
  read-only default switched off;
- running the file twice fails without changing anything.

## 2. Create the role (owner action — only after approving the SQL)

Use PowerShell. You'll need the database owner's password from Railway:
**Postgres service → Variables → `PGPASSWORD`** (user `postgres`). You type it
when prompted; it is never echoed, saved or added to history.

```powershell
cd C:\Shivaji_Personal\leadflow-workspace
$psql = 'C:\Program Files\PostgreSQL\17\bin\psql.exe'
$env:PGHOST = 'acela.proxy.rlwy.net'; $env:PGPORT = '17722'
$env:PGDATABASE = 'railway';         $env:PGUSER = 'postgres'
$env:PGSSLMODE = 'require'

$s = Read-Host 'Railway postgres password' -AsSecureString
$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
$env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b); Remove-Variable s, b

# Create the role and its grants, in one transaction.
& $psql -v ON_ERROR_STOP=1 --single-transaction -f docs\release\preflight-role.sql

# Set the role's password at the prompt (typed twice, not echoed, not logged):
& $psql -c "\password leadflow_preflight"

Remove-Item Env:PGPASSWORD, Env:PGUSER, Env:PGHOST, Env:PGPORT, Env:PGDATABASE, Env:PGSSLMODE
```

Choose the role password with a password manager: 32 or more random characters.
It's URL-encoded automatically later, so any characters are fine.

## 3. Store the role password locally (not in Git, history, logs or chat)

```powershell
.\scripts\run-preflight.ps1 -SavePassword
```

This prompts for the `leadflow_preflight` password and saves it to
`%LOCALAPPDATA%\LeadFlow\preflight-password.dpapi`, encrypted with Windows DPAPI.
Only your Windows account on this PC can decrypt it, and it lives outside the
repository.

Do **not** use `setx` (stores it in plain text in the registry), a `.env` file, or a
connection string typed on a command line.

## 4. Verify, then run

```powershell
.\scripts\run-preflight.ps1            # before the release
.\scripts\run-preflight.ps1 -After 11  # after #11 is deployed
.\scripts\run-preflight.ps1 -After 12  # after #12 is deployed
```

Each run:
1. Decrypts the password in memory and builds `PREFLIGHT_DATABASE_URL` for that
   process only. It uses `sslmode=require` with libpq semantics: encrypted, but the
   certificate isn't checked, the same as `psql`'s default.
2. Runs `scripts/verify-preflight-role.mjs`. This confirms the role isn't a
   superuser and can't create roles or databases; that sessions are read-only; that
   it has no CREATE on the database or schema and no INSERT, UPDATE, DELETE,
   TRUNCATE, REFERENCES or TRIGGER on any table; that it owns nothing; and that it
   can read exactly the 27 columns above and no others. It uses PostgreSQL's
   privilege functions and attempts no write.
3. Runs the preflight **only if** the role is verified. The preflight checks
   read-only access again itself (P0, P0c) and stops before reading any data if
   the connection could write. That guards against an admin URL used by mistake.
4. Removes the variable.

The output has OK, REVIEW, STOP and INFO lines with counts only. It never contains
the password or the connection string; tested by searching the output for both.

To let Claude run it, approve that explicitly. It then runs the same command; the
password goes nowhere else.

## 5. Remove access after the release

```sql
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM leadflow_preflight;
REVOKE ALL ON SCHEMA public FROM leadflow_preflight;
DO $$ BEGIN EXECUTE format('REVOKE ALL ON DATABASE %I FROM leadflow_preflight', current_database()); END $$;
DROP ROLE leadflow_preflight;
```

Also delete `%LOCALAPPDATA%\LeadFlow\preflight-password.dpapi`. The role expires
on 2026-11-30 regardless.
