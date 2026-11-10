import crypto from 'node:crypto';
import { DEFAULT_PLAYBOOK_RULES } from './config.js';

/**
 * Create a deterministic idempotent dispatch key.
 */
export function buildDispatchKey(ruleId, accountId, triggerKey) {
  const digest = crypto
    .createHash('sha256')
    .update(`${ruleId}:${accountId}:${triggerKey}`)
    .digest('hex')
    .slice(0, 16);
  return `dsp_${digest}`;
}

/**
 * Evaluate whether an account's current intelligence state matches a specific routing rule.
 */
export function doesRuleMatch(ruleId, account) {
  switch (ruleId) {
    case 'rule_ent_churn_rescue':
      return account.segment === 'Enterprise' && account.risk_score >= 75;

    case 'rule_dunning_recovery':
      return (
        account.failed_payments >= 2 ||
        (account.billing_status === 'past_due' && account.arr >= 30000) ||
        account.billing_status === 'uncollectible'
      );

    case 'rule_p1_support_swarm':
      return (
        account.open_p1_tickets >= 2 ||
        (account.open_p1_tickets >= 1 && account.risk_score >= 60)
      );

    case 'rule_expansion_upsell':
      return (
        Boolean(account.expansion_eligible) &&
        Number(account.seat_utilization) >= 0.88
      );

    default:
      return false;
  }
}

/**
 * Build an actionable human-readable dispatch summary and webhook payload for a matched rule.
 */
export function buildPlaybookAction(rule, account, triggerEventKey) {
  let summary = '';
  let recommendedAction = '';

  switch (rule.id) {
    case 'rule_ent_churn_rescue':
      summary = `Enterprise rescue triggered for ${account.name} ($${account.arr.toLocaleString()} ARR, risk ${account.risk_score}/100). Assigned to ${account.owner}.`;
      recommendedAction = 'Schedule executive sponsor health review & freeze renewal risk within 24h';
      break;
    case 'rule_dunning_recovery':
      summary = `Dunning recovery started for ${account.name} (${account.failed_payments} failed charge retries, status: ${account.billing_status}).`;
      recommendedAction = 'Send smart payment update link to billing contact & pause seat suspension';
      break;
    case 'rule_p1_support_swarm':
      summary = `Support engineering swarm paged for ${account.name} (${account.open_p1_tickets} open P1s, risk ${account.risk_score}/100).`;
      recommendedAction = 'Assign dedicated incident lead & post 2-hour SLA status updates';
      break;
    case 'rule_expansion_upsell':
      summary = `Expansion opportunity flagged for ${account.name} (+$${account.expansion_arr.toLocaleString()} est. ARR, ${Math.round(account.seat_utilization * 100)}% seats active).`;
      recommendedAction = 'Create CRM expansion opp & send multi-year tier upgrade proposal';
      break;
    default:
      summary = `Playbook "${rule.name}" executed for ${account.name} (risk ${account.risk_score}/100).`;
      recommendedAction = 'Review account telemetry and follow up with customer stakeholder';
  }

  const dispatchKey = buildDispatchKey(rule.id, account.id, triggerEventKey);

  return {
    dispatch_key: dispatchKey,
    rule_id: rule.id,
    rule_name: rule.name,
    account_id: account.id,
    account_name: account.name,
    channel: rule.channel,
    priority: rule.priority,
    trigger_event_key: triggerEventKey,
    status: 'dispatched',
    summary,
    payload: {
      dispatch_key: dispatchKey,
      rule_id: rule.id,
      account_id: account.id,
      account_name: account.name,
      segment: account.segment,
      owner: account.owner,
      arr: account.arr,
      risk_score: account.risk_score,
      risk_tier: account.risk_tier,
      expansion_arr: account.expansion_arr,
      recommended_action: recommendedAction,
      trigger_event_key: triggerEventKey,
    },
  };
}

/**
 * Evaluate all enabled routing rules for an account and return candidate playbook actions.
 */
export function evaluatePlaybookRules(
  account,
  triggerEventKey,
  rules = DEFAULT_PLAYBOOK_RULES
) {
  const actions = [];
  for (const rule of rules) {
    if (rule.enabled === 0 || rule.enabled === false) continue;
    if (doesRuleMatch(rule.id, account)) {
      actions.push(buildPlaybookAction(rule, account, triggerEventKey));
    }
  }
  return actions;
}
