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
- the verifier passed 16/16;
- the preflight ran fully;
- every write, DDL and private-column read was refused, even with the session's
  read-only default switched off;
- running the file twice fails without changing anything;
- the undo (`DROP OWNED BY`, then `DROP ROLE`) works.

### Effective privileges, including PUBLIC's defaults

Every role also holds whatever PUBLIC holds. Measured with the role created,
with its read-only default and with read-only deliberately switched off:

| Capability | Source | Read-only (default) | Read-only switched off |
|---|---|---|---|
| Write any application row | none granted | refused | **refused** (permission denied) |
| CREATE, ALTER or DROP tables, views, sequences or schemas | none granted; PostgreSQL 15+ gives PUBLIC no CREATE on `public` | refused | **refused** |
| `SET ROLE` to another role; server programs; extensions | no membership or attribute | refused | **refused** |
| Run a function with its owner's rights | the app's two functions are SECURITY INVOKER | n/a | n/a |
| Temporary table or function, gone at disconnect | PUBLIC's default **TEMP** on the database | refused | possible, capped at **16 MB** (`temp_file_limit`, which the role can't raise) |
| Create a large object | any role, by PostgreSQL design | refused | possible; **detected** (the verifier fails) and removed by the undo |

The last two can't be removed for one role. PostgreSQL has no per-role deny, and
revoking from PUBLIC would change every existing user, which is deliberately not
done. Neither touches any application object or row. They need the session to
switch read-only off on purpose, which the preflight never does. The password exists
only in your DPAPI file. Nothing granted to PUBLIC is changed.

Production is **checked, not assumed**. The verifier tests effective privileges
across every non-system schema, including anything an older database might grant
PUBLIC. Each of the following fails the check, and the preflight then refuses to
read data:
- CREATE on a schema through PUBLIC;
- a SECURITY DEFINER function;
- a large object owned by the role.

All three were provoked locally to prove they fire.

## TLS: why `verify-ca`, not `verify-full`

Inspected on 2026-10-25 (TLS handshake only, no login):
`node scripts/inspect-db-tls.cjs acela.proxy.rlwy.net 17722`.

- **Encryption:** TLS 1.3, `TLS_AES_256_GCM_SHA384`.
- **Server certificate:** `CN=localhost`, SAN `localhost` and
  `postgres-17.railway.internal`, valid until 2028-12-21. It's issued by a private,
  self-signed `CN=root-ca` that Railway's PostgreSQL image generated for this
  database.
- **`verify-full` is not possible.** No public certificate authority signs the
  certificate, and the proxy host `acela.proxy.rlwy.net` isn't among its names, so
  the hostname check fails even with the root trusted. Both were tested and
  rejected.
- **The safest supported mode is `verify-ca`, pinned to this database's own root:**
  [`railway-postgres-root-ca.pem`](./railway-postgres-root-ca.pem), SHA-256
  `0F:76:EB:ED:2E:4C:55:3F:F7:03:84:CA:1B:C0:D6:FD:D9:05:F8:83:B9:63:C9:DB:FD:35:80:20:4E:02:69:10`.
  A server is accepted only if it proves possession of a key this root signed, so
  an impostor with a different root is rejected before the password is sent (tested).
  The only check skipped is the hostname comparison, which can't succeed against
  this proxy.
- **Confirm the pin once from a different network** (for example a phone hotspot):
  run the inspector and compare the `cert[1]` SHA-256 with the value above. A match
  rules out interception at the time it was saved.
- **If Railway regenerates the certificate,** pinned connections fail safely. Re-run
  the inspector, confirm the new root from two networks, then replace the `.pem`.
  `-SslMode require` (encrypted, server not authenticated) is available only as an
  explicit fallback and prints a warning.

## 2. Create the role (owner action — only after approving the SQL)

> **Status 2026-10-25: BLOCKED — admin credentials unavailable.** The role has
> not been created. Nothing below has been run against production.

Use PowerShell. You'll need the database owner's password from Railway:
**Postgres service → Variables → `PGPASSWORD`** (user `postgres`). You type it
when prompted; it is never echoed, saved or added to history.

```powershell
cd C:\Shivaji_Personal\leadflow-workspace
$psql = 'C:\Program Files\PostgreSQL\17\bin\psql.exe'
$env:PGHOST = 'acela.proxy.rlwy.net'; $env:PGPORT = '17722'
$env:PGDATABASE = 'railway';         $env:PGUSER = 'postgres'
$env:PGSSLMODE = 'verify-ca'          # pinned: see "TLS" above
$env:PGSSLROOTCERT = (Resolve-Path docs\release\railway-postgres-root-ca.pem).Path

$s = Read-Host 'Railway postgres password' -AsSecureString
$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
$env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b); Remove-Variable s, b

# Create the role and its grants, in one transaction.
& $psql -v ON_ERROR_STOP=1 --single-transaction -f docs\release\preflight-role.sql

# Set the role's password at the prompt (typed twice, not echoed, not logged):
& $psql -c "\password leadflow_preflight"

Remove-Item Env:PGPASSWORD, Env:PGUSER, Env:PGHOST, Env:PGPORT, Env:PGDATABASE, Env:PGSSLMODE, Env:PGSSLROOTCERT
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
   process only, with TLS `verify-ca` pinned to `railway-postgres-root-ca.pem`. An
   impostor server is rejected before the password is sent.
2. Runs `scripts/verify-preflight-role.mjs` (16 checks). It confirms:
   - the role isn't a superuser, can't create roles or databases, and is a member
     of no other role;
   - sessions are read-only;
   - no CREATE on the database or any schema, including through PUBLIC;
   - no INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER on any table, view
     or sequence;
   - no executable SECURITY DEFINER function;
   - it owns no object or large object;
   - it can read exactly the 27 columns above and no others.

   It also reports PUBLIC's TEMP residual and the temporary-disk cap. It uses
   PostgreSQL's privilege functions and attempts no write.
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
DROP OWNED BY leadflow_preflight;   -- revokes its grants and drops anything it created (temp/large objects)
DROP ROLE leadflow_preflight;
```

Also delete `%LOCALAPPDATA%\LeadFlow\preflight-password.dpapi`. The role expires
on 2026-11-30 regardless.
