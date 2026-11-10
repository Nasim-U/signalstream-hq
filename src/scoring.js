import { RISK_TIERS } from './config.js';

/**
 * Clamp a number between min and max.
 */
function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/**
 * Classify risk tier from composite 0-100 risk score.
 */
export function classifyRiskTier(riskScore) {
  if (riskScore >= RISK_TIERS.CRITICAL.min) return RISK_TIERS.CRITICAL.label;
  if (riskScore >= RISK_TIERS.HIGH.min) return RISK_TIERS.HIGH.label;
  if (riskScore >= RISK_TIERS.MODERATE.min) return RISK_TIERS.MODERATE.label;
  return RISK_TIERS.HEALTHY.label;
}

/**
 * Compute composite Account Health & Churn Risk Score (0-100) with explainable
 * risk factor breakdown and automated Expansion Opportunity detection.
 *
 * Weights (Max 100 Risk Points):
 *  1. Usage Velocity Drop        : 0 - 35 pts
 *  2. Billing & Dunning Retries  : 0 - 30 pts
 *  3. Support P1/P2 Backlog      : 0 - 20 pts
 *  4. Seat Adoption & Renewal    : 0 - 15 pts
 */
export function computeAccountIntelligence(account) {
  const usage7d = Math.max(0, Number(account.usage_7d ?? 0));
  const baselineWeekly = Math.max(1, Number(account.usage_30d_weekly_avg ?? 1));
  const failedPayments = Math.max(0, Number(account.failed_payments ?? 0));
  const billingStatus = String(account.billing_status || 'active').toLowerCase();
  const openP1 = Math.max(0, Number(account.open_p1_tickets ?? 0));
  const openP2 = Math.max(0, Number(account.open_p2_tickets ?? 0));
  const seatsActive = Math.max(0, Number(account.seats_active ?? 0));
  const seatsPurchased = Math.max(1, Number(account.seats_purchased ?? 1));
  const renewalDays = Math.max(1, Number(account.renewal_days ?? 180));
  const arr = Math.max(0, Number(account.arr ?? 0));

  // 1. Usage Velocity Factor (0 - 35 pts)
  const rawVelocityPct = ((usage7d - baselineWeekly) / baselineWeekly) * 100;
  const usageVelocityPct = Math.round(rawVelocityPct * 10) / 10;

  let usagePoints = 0;
  let usageSummary = '';
  if (usageVelocityPct <= -55) {
    usagePoints = 35;
    usageSummary = `Severe telemetry contraction (${usageVelocityPct}% vs 30d baseline)`;
  } else if (usageVelocityPct <= -35) {
    usagePoints = 27;
    usageSummary = `Steep product engagement drop (${usageVelocityPct}% vs 30d baseline)`;
  } else if (usageVelocityPct <= -20) {
    usagePoints = 18;
    usageSummary = `Moderate usage deceleration (${usageVelocityPct}% vs 30d baseline)`;
  } else if (usageVelocityPct <= -8) {
    usagePoints = 9;
    usageSummary = `Mild usage softening (${usageVelocityPct}% vs 30d baseline)`;
  } else if (usageVelocityPct >= 15) {
    usagePoints = 0;
    usageSummary = `Accelerating product velocity (+${usageVelocityPct}% vs 30d baseline)`;
  } else {
    usagePoints = 0;
    usageSummary = `Steady product engagement (${usageVelocityPct >= 0 ? '+' : ''}${usageVelocityPct}%)`;
  }

  // 2. Billing & Dunning Retries Factor (0 - 30 pts)
  let billingPoints = 0;
  if (billingStatus === 'uncollectible' || billingStatus === 'canceled') {
    billingPoints = 30;
  } else if (billingStatus === 'past_due') {
    billingPoints = Math.min(30, 14 + failedPayments * 6);
  } else if (failedPayments > 0) {
    billingPoints = Math.min(24, failedPayments * 8);
  }

  let billingSummary = 'Clean billing history — auto-pay active';
  if (billingPoints >= 24) {
    billingSummary = `Critical dunning risk: ${failedPayments} failed retries (${billingStatus})`;
  } else if (billingPoints >= 14) {
    billingSummary = `Past-due invoice with ${failedPayments} failed Stripe retry attempt(s)`;
  } else if (billingPoints > 0) {
    billingSummary = `${failedPayments} recent payment retry warning(s)`;
  }

  // 3. Support Escalation & P1 Backlog Factor (0 - 20 pts)
  const rawSupportPoints = openP1 * 9 + openP2 * 3;
  const supportPoints = clamp(rawSupportPoints, 0, 20);
  let supportSummary = 'Zero open P1/P2 escalations';
  if (openP1 >= 2) {
    supportSummary = `${openP1} unresolved P1 critical escalations (${openP2} P2 open)`;
  } else if (openP1 === 1) {
    supportSummary = `1 active P1 escalation${openP2 > 0 ? ` + ${openP2} P2 ticket(s)` : ''}`;
  } else if (openP2 > 0) {
    supportSummary = `${openP2} open P2 support ticket(s), no P1 blockers`;
  }

  // 4. Seat Utilization & Renewal Proximity Factor (0 - 15 pts)
  const seatUtilization = Math.round((seatsActive / seatsPurchased) * 1000) / 1000;
  const seatPctDisplay = Math.round(seatUtilization * 100);
  let seatPoints = 0;
  if (seatUtilization < 0.35) {
    seatPoints = 12;
  } else if (seatUtilization < 0.55) {
    seatPoints = 8;
  } else if (seatUtilization < 0.7) {
    seatPoints = 4;
  }
  if (seatPoints > 0 && renewalDays <= 45) {
    seatPoints = clamp(seatPoints + 3, 0, 15);
  }

  let seatSummary = `Strong license adoption (${seatsActive}/${seatsPurchased} seats, ${seatPctDisplay}%)`;
  if (seatPoints >= 11) {
    seatSummary = `Severe shelfware risk (${seatPctDisplay}% seats active, renews in ${renewalDays}d)`;
  } else if (seatPoints >= 6) {
    seatSummary = `Underutilized licenses (${seatPctDisplay}% seats active, renews in ${renewalDays}d)`;
  } else if (seatPoints > 0) {
    seatSummary = `Moderate license slack (${seatPctDisplay}% of ${seatsPurchased} seats active)`;
  }

  const riskScore = clamp(
    usagePoints + billingPoints + supportPoints + seatPoints,
    0,
    100
  );
  const healthScore = 100 - riskScore;
  const riskTier = classifyRiskTier(riskScore);

  const severityFor = (pts, max) => {
    const ratio = pts / max;
    if (ratio >= 0.7) return 'critical';
    if (ratio >= 0.35) return 'warning';
    if (pts > 0) return 'watch';
    return 'healthy';
  };

  const riskFactors = [
    {
      key: 'usage_velocity',
      label: 'Product Usage Velocity',
      points: usagePoints,
      max_points: 35,
      severity: severityFor(usagePoints, 35),
      summary: usageSummary,
    },
    {
      key: 'billing_dunning',
      label: 'Billing & Dunning Health',
      points: billingPoints,
      max_points: 30,
      severity: severityFor(billingPoints, 30),
      summary: billingSummary,
    },
    {
      key: 'support_backlog',
      label: 'P1/P2 Support Backlog',
      points: supportPoints,
      max_points: 20,
      severity: severityFor(supportPoints, 20),
      summary: supportSummary,
    },
    {
      key: 'seat_adoption',
      label: 'Seat Utilization & Renewal',
      points: seatPoints,
      max_points: 15,
      severity: severityFor(seatPoints, 15),
      summary: seatSummary,
    },
  ];

  // Automated Expansion Opportunity Detection
  const expansionEligible =
    riskScore <= 25 &&
    billingStatus === 'active' &&
    failedPayments === 0 &&
    openP1 === 0 &&
    seatUtilization >= 0.88 &&
    usageVelocityPct >= 8;

  let expansionArr = 0;
  let expansionReason = null;
  if (expansionEligible) {
    const expansionRate =
      seatUtilization >= 0.98 && usageVelocityPct >= 20 ? 0.32 : 0.22;
    expansionArr = Math.round((arr * expansionRate) / 500) * 500 || Math.round(arr * 0.25);
    expansionReason = `${seatPctDisplay}% seat capacity utilized with +${usageVelocityPct}% usage velocity`;
  }

  return {
    risk_score: riskScore,
    health_score: healthScore,
    risk_tier: riskTier,
    usage_velocity_pct: usageVelocityPct,
    seat_utilization: seatUtilization,
    risk_factors: riskFactors,
    expansion_eligible: expansionEligible,
    expansion_arr: expansionArr,
    expansion_reason: expansionReason,
  };
}
