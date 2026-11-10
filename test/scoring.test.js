import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRiskTier, computeAccountIntelligence } from '../src/scoring.js';

test('healthy steady account scores 0 risk and 100 health', () => {
  const intel = computeAccountIntelligence({
    arr: 120000,
    usage_7d: 920,
    usage_30d_weekly_avg: 900,
    billing_status: 'active',
    failed_payments: 0,
    open_p1_tickets: 0,
    open_p2_tickets: 0,
    seats_purchased: 100,
    seats_active: 82,
    renewal_days: 150,
  });

  assert.equal(intel.risk_score, 0);
  assert.equal(intel.health_score, 100);
  assert.equal(intel.risk_tier, 'Healthy');
  assert.equal(intel.risk_factors.length, 4);
  assert.equal(intel.expansion_eligible, false);
});

test('severe usage contraction contributes 35 risk points', () => {
  const intel = computeAccountIntelligence({
    arr: 80000,
    usage_7d: 200,
    usage_30d_weekly_avg: 600, // -66.7%
    billing_status: 'active',
    failed_payments: 0,
    open_p1_tickets: 0,
    open_p2_tickets: 0,
    seats_purchased: 50,
    seats_active: 42,
    renewal_days: 120,
  });

  const usageFactor = intel.risk_factors.find((f) => f.key === 'usage_velocity');
  assert.equal(usageFactor.points, 35);
  assert.equal(usageFactor.severity, 'critical');
  assert.equal(intel.risk_score, 35);
  assert.equal(intel.risk_tier, 'Moderate');
});

test('past_due billing with multiple dunning retries and P1 backlog triggers Critical tier', () => {
  const intel = computeAccountIntelligence({
    arr: 200000,
    usage_7d: 320,
    usage_30d_weekly_avg: 800, // -60% -> 35 pts
    billing_status: 'past_due',
    failed_payments: 3, // min(30, 14 + 18) -> 30 pts
    open_p1_tickets: 2, // 18 pts
    open_p2_tickets: 1, // +3 -> capped 20 pts
    seats_purchased: 100,
    seats_active: 30, // 30% -> 12 pts + 3 renewal proximity = 15 pts
    renewal_days: 25,
  });

  assert.equal(intel.risk_score, 100);
  assert.equal(intel.health_score, 0);
  assert.equal(intel.risk_tier, 'Critical');
});

test('automated expansion opportunity detector identifies high-seat velocity accounts', () => {
  const eligible = computeAccountIntelligence({
    arr: 150000,
    usage_7d: 1320,
    usage_30d_weekly_avg: 1050, // +25.7%
    billing_status: 'active',
    failed_payments: 0,
    open_p1_tickets: 0,
    open_p2_tickets: 0,
    seats_purchased: 100,
    seats_active: 99, // 99%
    renewal_days: 90,
  });

  assert.equal(eligible.expansion_eligible, true);
  assert.ok(eligible.expansion_arr >= 33000);
  assert.match(eligible.expansion_reason, /99% seat capacity/);

  // Disqualified if past_due or P1 open
  const disqualified = computeAccountIntelligence({
    arr: 150000,
    usage_7d: 1320,
    usage_30d_weekly_avg: 1050,
    billing_status: 'past_due',
    failed_payments: 1,
    open_p1_tickets: 1,
    open_p2_tickets: 0,
    seats_purchased: 100,
    seats_active: 99,
    renewal_days: 90,
  });
  assert.equal(disqualified.expansion_eligible, false);
  assert.equal(disqualified.expansion_arr, 0);
});

test('classifyRiskTier maps boundary values accurately', () => {
  assert.equal(classifyRiskTier(0), 'Healthy');
  assert.equal(classifyRiskTier(27), 'Healthy');
  assert.equal(classifyRiskTier(28), 'Moderate');
  assert.equal(classifyRiskTier(50), 'High');
  assert.equal(classifyRiskTier(75), 'Critical');
  assert.equal(classifyRiskTier(100), 'Critical');
});
