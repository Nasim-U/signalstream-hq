import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/db.js';
import { seedPortfolio } from '../src/seed.js';
import { createAppServer } from '../src/app.js';

async function startTestServer() {
  const store = createStore(':memory:');
  seedPortfolio(store, { reset: true });
  const server = createAppServer(store);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    store,
    baseUrl,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      store.close();
    },
  };
}

test('GET /api/health and GET /api/summary expose seeded 44-account SaaS portfolio', async () => {
  const ctx = await startTestServer();
  try {
    const healthRes = await fetch(`${ctx.baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.status, 'ok');
    assert.ok(health.accounts_monitored >= 44);

    const sumRes = await fetch(`${ctx.baseUrl}/api/summary`);
    assert.equal(sumRes.status, 200);
    const summary = await sumRes.json();
    assert.equal(summary.total_accounts, 44);
    assert.ok(summary.total_arr > 3_000_000);
    assert.ok(summary.at_risk_arr > 500_000);
    assert.ok(summary.expansion_pipeline_arr > 100_000);
    assert.ok(summary.playbooks_fired >= 5);
    assert.equal(summary.duplicates_blocked, 2);
  } finally {
    await ctx.close();
  }
});

test('GET /api/accounts supports tier, segment, owner, expansion, and search filtering', async () => {
  const ctx = await startTestServer();
  try {
    const critRes = await fetch(`${ctx.baseUrl}/api/accounts?riskTier=Critical`);
    const crit = await critRes.json();
    assert.ok(crit.count >= 3);
    assert.ok(crit.accounts.every((a) => a.risk_tier === 'Critical'));

    const entRes = await fetch(`${ctx.baseUrl}/api/accounts?segment=Enterprise&owner=Maya%20Lin`);
    const ent = await entRes.json();
    assert.ok(ent.count >= 2);
    assert.ok(
      ent.accounts.every((a) => a.segment === 'Enterprise' && a.owner === 'Maya Lin')
    );

    const expRes = await fetch(`${ctx.baseUrl}/api/accounts?riskTier=Expansion`);
    const exp = await expRes.json();
    assert.ok(exp.count >= 6);
    assert.ok(exp.accounts.every((a) => a.expansion_eligible === true));

    const searchRes = await fetch(`${ctx.baseUrl}/api/accounts?search=QuantumScale`);
    const search = await searchRes.json();
    assert.equal(search.count, 1);
    assert.equal(search.accounts[0].id, 'acct_019');
  } finally {
    await ctx.close();
  }
});

test('GET /api/accounts/:id returns explainable risk breakdown, sparkline history, and 404 on unknown', async () => {
  const ctx = await startTestServer();
  try {
    const detailRes = await fetch(`${ctx.baseUrl}/api/accounts/acct_001`);
    assert.equal(detailRes.status, 200);
    const detail = await detailRes.json();
    assert.equal(detail.account.id, 'acct_001');
    assert.equal(detail.account.risk_factors.length, 4);
    assert.ok(Array.isArray(detail.account.usage_history));
    assert.ok(detail.events.length >= 1);

    const missingRes = await fetch(`${ctx.baseUrl}/api/accounts/acct_nonexistent`);
    assert.equal(missingRes.status, 404);
  } finally {
    await ctx.close();
  }
});

test('POST /api/events/ingest processes new events (201) and deduplicates retries (200)', async () => {
  const ctx = await startTestServer();
  try {
    const body = {
      account_id: 'acct_011',
      source: 'stripe',
      event_type: 'invoice.payment_failed',
      payload: { invoice_id: 'in_api_test_1', amount_due: 11800 },
    };

    const res1 = await fetch(`${ctx.baseUrl}/api/events/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'evt_header_idemp_9001',
      },
      body: JSON.stringify(body),
    });
    assert.equal(res1.status, 201);
    const data1 = await res1.json();
    assert.equal(data1.deduplicated, false);
    assert.ok(data1.event.risk_after > data1.event.risk_before);

    // Retry with same Idempotency-Key header
    const res2 = await fetch(`${ctx.baseUrl}/api/events/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'evt_header_idemp_9001',
      },
      body: JSON.stringify(body),
    });
    assert.equal(res2.status, 200);
    const data2 = await res2.json();
    assert.equal(data2.deduplicated, true);
    assert.equal(data2.account.risk_score, data1.account.risk_score);

    // Invalid event_type returns 400
    const badRes = await fetch(`${ctx.baseUrl}/api/events/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idempotency_key: 'evt_bad_type',
        account_id: 'acct_011',
        event_type: 'unknown.event',
      }),
    });
    assert.equal(badRes.status, 400);
  } finally {
    await ctx.close();
  }
});

test('POST /api/playbooks/run and PATCH /api/playbooks/rules/:id operate cleanly', async () => {
  const ctx = await startTestServer();
  try {
    const runRes = await fetch(`${ctx.baseUrl}/api/playbooks/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_id: 'acct_019',
        rule_id: 'rule_expansion_upsell',
        idempotency_key: 'manual_exp_test_1',
      }),
    });
    assert.equal(runRes.status, 201);
    const runData = await runRes.json();
    assert.equal(runData.deduplicated, false);
    assert.equal(runData.dispatch.rule_id, 'rule_expansion_upsell');

    // Duplicate manual playbook run with same key returns 200 deduplicated
    const dupRes = await fetch(`${ctx.baseUrl}/api/playbooks/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_id: 'acct_019',
        rule_id: 'rule_expansion_upsell',
        idempotency_key: 'manual_exp_test_1',
      }),
    });
    assert.equal(dupRes.status, 200);
    const dupData = await dupRes.json();
    assert.equal(dupData.deduplicated, true);

    // Toggle rule off and back on
    const toggleRes = await fetch(
      `${ctx.baseUrl}/api/playbooks/rules/rule_p1_support_swarm`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      }
    );
    assert.equal(toggleRes.status, 200);
    const toggleData = await toggleRes.json();
    assert.equal(toggleData.rule.enabled, false);
  } finally {
    await ctx.close();
  }
});

test('GET /api/accounts/export exports valid CSV and JSON reports and serves UI static assets', async () => {
  const ctx = await startTestServer();
  try {
    const csvRes = await fetch(
      `${ctx.baseUrl}/api/accounts/export?format=csv&segment=Enterprise`
    );
    assert.equal(csvRes.status, 200);
    assert.match(csvRes.headers.get('content-type') || '', /text\/csv/);
    const csvText = await csvRes.text();
    const lines = csvText.trim().split('\n');
    assert.ok(lines.length >= 10);
    assert.match(lines[0], /^account_id,name,domain,segment,owner,arr_usd/);

    const jsonRes = await fetch(`${ctx.baseUrl}/api/accounts/export?format=json`);
    assert.equal(jsonRes.status, 200);
    const jsonReport = await jsonRes.json();
    assert.equal(jsonReport.count, 44);
    assert.ok(Array.isArray(jsonReport.accounts));

    // Verify UI static routes
    const htmlRes = await fetch(`${ctx.baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.match(html, /SignalStream HQ/);

    const svgRes = await fetch(`${ctx.baseUrl}/docs/ui-preview.svg`);
    assert.equal(svgRes.status, 200);
    assert.match(svgRes.headers.get('content-type') || '', /image\/svg\+xml/);

    // Unsupported export format returns 400
    const badExport = await fetch(`${ctx.baseUrl}/api/accounts/export?format=xml`);
    assert.equal(badExport.status, 400);
  } finally {
    await ctx.close();
  }
});

test('multi-channel lifecycle: usage drop -> P1 escalation -> invoice paid recovery -> reset', async () => {
  const ctx = await startTestServer();
  try {
    // 1. Telemetry drop on steady healthy account acct_028
    const dropRes = await fetch(`${ctx.baseUrl}/api/events/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idempotency_key: 'evt_lifecycle_drop_1',
        account_id: 'acct_028',
        event_type: 'telemetry.usage_drop',
        payload: { drop_pct: 60 },
      }),
    });
    assert.equal(dropRes.status, 201);
    const dropData = await dropRes.json();
    assert.ok(dropData.account.risk_score >= 35);

    // 2. Subscription update on acct_028
    const subRes = await fetch(`${ctx.baseUrl}/api/events/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idempotency_key: 'evt_lifecycle_sub_2',
        account_id: 'acct_028',
        event_type: 'customer.subscription.updated',
        payload: { seats_purchased: 140, arr: 165000 },
      }),
    });
    assert.equal(subRes.status, 201);
    const subData = await subRes.json();
    assert.equal(subData.account.arr, 165000);
    assert.equal(subData.account.seats_purchased, 140);

    // 3. Invoice paid on past_due acct_001 lowers risk score
    const beforeAcct1 = await (await fetch(`${ctx.baseUrl}/api/accounts/acct_001`)).json();
    const paidRes = await fetch(`${ctx.baseUrl}/api/events/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idempotency_key: 'evt_lifecycle_paid_3',
        account_id: 'acct_001',
        event_type: 'invoice.paid',
      }),
    });
    assert.equal(paidRes.status, 201);
    const paidData = await paidRes.json();
    assert.equal(paidData.account.billing_status, 'active');
    assert.equal(paidData.account.failed_payments, 0);
    assert.ok(paidData.account.risk_score < beforeAcct1.account.risk_score);

    // 4. Ticket resolved lowers open_p1_tickets
    const resolveRes = await fetch(`${ctx.baseUrl}/api/events/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idempotency_key: 'evt_lifecycle_resolve_4',
        account_id: 'acct_001',
        event_type: 'support.ticket_resolved',
        payload: { severity: 'P1' },
      }),
    });
    assert.equal(resolveRes.status, 201);
    const resolveData = await resolveRes.json();
    assert.equal(resolveData.account.open_p1_tickets, 0);

    // 5. Admin reset restores clean 44-account demo baseline
    const resetRes = await fetch(`${ctx.baseUrl}/api/admin/reset`, {
      method: 'POST',
    });
    assert.equal(resetRes.status, 200);
    const resetData = await resetRes.json();
    assert.equal(resetData.summary.total_accounts, 44);
  } finally {
    await ctx.close();
  }
});

test('API handles malformed JSON (400) and unknown routes (404) gracefully', async () => {
  const ctx = await startTestServer();
  try {
    const badJson = await fetch(`${ctx.baseUrl}/api/events/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad json',
    });
    assert.equal(badJson.status, 400);

    const unknownApi = await fetch(`${ctx.baseUrl}/api/does-not-exist`);
    assert.equal(unknownApi.status, 404);
  } finally {
    await ctx.close();
  }
});

