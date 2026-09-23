/**
 * Post-deploy smoke test.
 *
 * Answers one question against a real deployment: can a salesperson sign in and
 * do their job, and is one tenant's data still invisible to another?
 *
 * Deliberately NOT a second test suite. The E2E suite proves behaviour; this
 * proves that THIS deployment — these environment variables, this database,
 * this build — actually works. Those fail in completely different ways: a green
 * suite and a broken deployment coexist happily when a connection string is
 * wrong.
 *
 *   node scripts/smoke-test.mjs https://api.your-domain.example
 *
 * Credentials come from the environment, never from arguments — an argument
 * lands in shell history and in CI logs:
 *
 *   SMOKE_EMAIL=owner@example.com SMOKE_PASSWORD=... \
 *   SMOKE_EMAIL_B=other@example.com SMOKE_PASSWORD_B=... \
 *   node scripts/smoke-test.mjs https://api.your-domain.example
 *
 * The second tenant is optional but strongly recommended: tenant isolation is
 * the one property whose failure is silent, and the only way to observe it is
 * to hold two tenants at once.
 *
 * Exits non-zero on the first failure, so it can gate a deploy.
 */

const baseUrl = (process.argv[2] ?? process.env.SMOKE_BASE_URL ?? '').replace(/\/+$/, '');

if (!baseUrl) {
  console.error('Usage: node scripts/smoke-test.mjs <base-url>');
  process.exit(2);
}

const results = [];
let failed = 0;

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function request(path, options = {}) {
  const started = Date.now();

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      signal: AbortSignal.timeout(15_000),
    });

    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON. The status is still meaningful.
    }

    return { status: response.status, body, ms: Date.now() - started };
  } catch (error) {
    return { status: 0, body: null, ms: Date.now() - started, error };
  }
}

async function login(email, password) {
  const response = await request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, platform: 'WEB' }),
  });

  return response.body?.data?.tokens?.accessToken ?? null;
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });

console.log(`\nSmoke test — ${baseUrl}\n`);

// --- 1. The process is alive -------------------------------------------------
{
  const health = await request('/health');
  record('liveness /health', health.status === 200, `${health.status} in ${health.ms}ms`);

  /*
   * Readiness is REPORTED, not asserted. A deployment whose Redis is still
   * warming is not a failed deployment, and failing the smoke test on it would
   * teach people to ignore the smoke test.
   */
  const readiness = await request('/readiness');
  const checks = readiness.body?.checks ?? {};
  console.log(
    `        readiness ${readiness.status} — database=${checks.database} cache=${checks.cache}`,
  );
}

// --- 2. Public surface -------------------------------------------------------
{
  const plans = await request('/api/v1/plans');
  record('public /plans reachable', plans.status === 200, `${plans.status} in ${plans.ms}ms`);
}

// --- 3. Protected surface is actually protected ------------------------------
{
  const unauthenticated = await request('/api/v1/leads');
  record(
    'protected route refuses anonymous',
    unauthenticated.status === 401,
    `expected 401, got ${unauthenticated.status}`,
  );

  const metrics = await request('/api/metrics');
  record(
    'metrics endpoint is not public',
    metrics.status === 401,
    `expected 401, got ${metrics.status}`,
  );
}

// --- 4. A person can sign in and work ----------------------------------------
const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;

let token = null;

if (!email || !password) {
  console.log('\n  (SMOKE_EMAIL / SMOKE_PASSWORD unset — skipping authenticated checks)\n');
} else {
  token = await login(email, password);
  record('sign in', Boolean(token), token ? undefined : 'no access token returned');
}

if (token) {
  const pages = [
    ['dashboard', '/api/v1/dashboard'],
    ['leads', '/api/v1/leads?limit=5'],
    ['customers', '/api/v1/accounts?limit=5'],
    ['products', '/api/v1/products?limit=5'],
    ['follow-ups', '/api/v1/follow-ups'],
    ['notifications', '/api/v1/notifications'],
    ['devices', '/api/v1/users/me/devices'],
  ];

  for (const [name, path] of pages) {
    const response = await request(path, { headers: auth(token) });
    record(`read ${name}`, response.status === 200, `${response.status} in ${response.ms}ms`);
  }

  /*
   * The worker's real health signal.
   *
   * A sweep that stopped running produces no errors and no logs — a timestamp
   * that stops moving is the only evidence. Reported rather than asserted,
   * because a freshly deployed worker has legitimately not swept yet.
   */
  const metrics = await request('/api/metrics', { headers: auth(token) });

  if (metrics.status === 200) {
    const worker = metrics.body?.worker ?? {};
    console.log(
      `        worker — sweeps=${worker.sweeps} failures=${worker.failures} ` +
        `lastSweepAt=${worker.lastSweepAt ?? 'never'}`,
    );

    if (!worker.lastSweepAt) {
      console.log(
        '        NOTE: the worker has not swept yet. If this is still null in a\n' +
          '              few minutes, nobody is being reminded of anything — check\n' +
          '              WORKER_ENABLED=true on the worker service.',
      );
    }
  }
}

// --- 5. Tenant isolation — the property whose failure is silent --------------
const emailB = process.env.SMOKE_EMAIL_B;
const passwordB = process.env.SMOKE_PASSWORD_B;

if (token && emailB && passwordB) {
  const tokenB = await login(emailB, passwordB);

  if (!tokenB) {
    record('second tenant sign in', false, 'no access token returned');
  } else {
    const leadsA = await request('/api/v1/leads?limit=50', { headers: auth(token) });
    const leadsB = await request('/api/v1/leads?limit=50', { headers: auth(tokenB) });

    const idsA = new Set((leadsA.body?.data?.items ?? []).map((lead) => lead.id));
    const idsB = (leadsB.body?.data?.items ?? []).map((lead) => lead.id);

    const overlap = idsB.filter((id) => idsA.has(id));

    record(
      'tenant A and tenant B share no leads',
      overlap.length === 0,
      overlap.length ? `${overlap.length} LEAKED ids` : undefined,
    );

    /*
     * Direct fetch of a foreign record. The list not overlapping could be
     * coincidence; a 404 on a known id cannot be.
     */
    const foreignId = idsB[0];
    if (foreignId) {
      const cross = await request(`/api/v1/leads/${foreignId}`, { headers: auth(token) });
      record(
        "tenant A cannot fetch tenant B's lead by id",
        cross.status === 404,
        `expected 404, got ${cross.status}`,
      );
    }
  }
} else if (token) {
  console.log('\n  (SMOKE_EMAIL_B unset — skipping the cross-tenant check)\n');
}

// --- verdict -----------------------------------------------------------------
console.log(
  `\n${failed === 0 ? 'PASS' : 'FAIL'} — ${results.length - failed}/${results.length} checks\n`,
);

process.exit(failed === 0 ? 0 : 1);
