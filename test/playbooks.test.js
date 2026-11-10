import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDispatchKey,
  doesRuleMatch,
  evaluatePlaybookRules,
} from '../src/playbooks.js';
import { DEFAULT_PLAYBOOK_RULES } from '../src/config.js';
import { createStore } from '../src/db.js';

test('buildDispatchKey is deterministic and collision-resistant across triggers', () => {
  const keyA1 = buildDispatchKey('rule_ent_churn_rescue', 'acct_001', 'evt_100');
  const keyA2 = buildDispatchKey('rule_ent_churn_rescue', 'acct_001', 'evt_100');
  const keyB = buildDispatchKey('rule_ent_churn_rescue', 'acct_001', 'evt_101');

  assert.equal(keyA1, keyA2);
  assert.notEqual(keyA1, keyB);
  assert.match(keyA1, /^dsp_[0-9a-f]{16}$/);
});

test('routing rules match Enterprise churn, dunning, P1 swarm, and expansion accurately', () => {
  const criticalEnt = {
    id: 'acct_ent',
    name: 'Global Corp',
    segment: 'Enterprise',
    owner: 'Maya Lin',
    arr: 220000,
    risk_score: 82,
    risk_tier: 'Critical',
    failed_payments: 3,
    billing_status: 'past_due',
    open_p1_tickets: 2,
    expansion_eligible: false,
    expansion_arr: 0,
    seat_utilization: 0.45,
  };

  const matched = evaluatePlaybookRules(criticalEnt, 'evt_test_1');
  const matchedIds = matched.map((m) => m.rule_id);
  assert.ok(matchedIds.includes('rule_ent_churn_rescue'));
  assert.ok(matchedIds.includes('rule_dunning_recovery'));
  assert.ok(matchedIds.includes('rule_p1_support_swarm'));
  assert.ok(!matchedIds.includes('rule_expansion_upsell'));

  // Growth segment should NOT trigger Enterprise-only rule
  assert.equal(
    doesRuleMatch('rule_ent_churn_rescue', { ...criticalEnt, segment: 'Growth' }),
    false
  );
});

test('disabled playbook rules are skipped during evaluation', () => {
  const rulesWithPaused = DEFAULT_PLAYBOOK_RULES.map((r) =>
    r.id === 'rule_dunning_recovery' ? { ...r, enabled: false } : r
  );

  const pastDueAccount = {
    id: 'acct_mid',
    name: 'MidCo',
    segment: 'Mid-Market',
    owner: 'Devon Brooks',
    arr: 60000,
    risk_score: 45,
    risk_tier: 'Moderate',
    failed_payments: 2,
    billing_status: 'past_due',
    open_p1_tickets: 0,
    expansion_eligible: false,
    expansion_arr: 0,
    seat_utilization: 0.75,
  };

  const actions = evaluatePlaybookRules(pastDueAccount, 'evt_99', rulesWithPaused);
  assert.equal(actions.length, 0);
});

test('store.ingestEvent enforces strict idempotency across duplicate webhook deliveries', () => {
  const store = createStore(':memory:');
  try {
    store.upsertAccount({
      id: 'acct_test',
      name: 'Test Cloud Inc',
      domain: 'testcloud.io',
      segment: 'Enterprise',
      owner: 'Maya Lin',
      arr: 180000,
      seats_purchased: 100,
      seats_active: 40,
      usage_7d: 300,
      usage_30d_weekly_avg: 800,
      usage_history: [800, 780, 600, 300],
      billing_status: 'past_due',
      failed_payments: 1,
      open_p1_tickets: 1,
      open_p2_tickets: 0,
      renewal_days: 30,
    });

    const webhookPayload = {
      idempotency_key: 'evt_stripe_dup_check_001',
      account_id: 'acct_test',
      source: 'stripe',
      event_type: 'invoice.payment_failed',
      payload: { invoice_id: 'in_555', amount_due: 15000 },
    };

    const first = store.ingestEvent(webhookPayload);
    assert.equal(first.deduplicated, false);
    assert.equal(first.account.failed_payments, 2);
    assert.ok(first.dispatches.length >= 1);

    const scoreAfterFirst = first.account.risk_score;
    const dispatchCountAfterFirst = store.listDispatches().length;

    // Deliver exact duplicate webhook twice more
    const second = store.ingestEvent(webhookPayload);
    const third = store.ingestEvent(webhookPayload);

    assert.equal(second.deduplicated, true);
    assert.equal(third.deduplicated, true);
    assert.equal(third.account.failed_payments, 2);
    assert.equal(third.account.risk_score, scoreAfterFirst);
    assert.equal(store.listDispatches().length, dispatchCountAfterFirst);

    const summary = store.getPortfolioSummary();
    assert.equal(summary.duplicates_blocked, 2);
    assert.equal(summary.events_ingested, 1);
  } finally {
    store.close();
  }
});
