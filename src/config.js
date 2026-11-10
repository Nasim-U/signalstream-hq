import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..');

export const DEFAULT_PORT = Number(process.env.PORT || 8763);
export const DEFAULT_DB_PATH =
  process.env.SIGNALSTREAM_DB_PATH ||
  path.join(PROJECT_ROOT, 'data', 'signalstream.db');

export const RISK_TIERS = {
  CRITICAL: { label: 'Critical', min: 75 },
  HIGH: { label: 'High', min: 50 },
  MODERATE: { label: 'Moderate', min: 28 },
  HEALTHY: { label: 'Healthy', min: 0 },
};

export const DEFAULT_PLAYBOOK_RULES = [
  {
    id: 'rule_ent_churn_rescue',
    name: 'Enterprise Critical Churn Rescue',
    channel: 'slack:#revops-escalations + crm:renewal-rescue-task',
    priority: 'P1',
    description:
      'Triggers executive CS intervention and creates a renewal rescue task when an Enterprise account exceeds 75 churn risk.',
    condition_summary: 'segment == "Enterprise" AND risk_score >= 75',
  },
  {
    id: 'rule_dunning_recovery',
    name: 'Automated Billing & Dunning Recovery',
    channel: 'webhook:billing-dunning-orchestrator + slack:#finance-ar',
    priority: 'P1',
    description:
      'Launches smart payment retry cadence and billing outreach when past-due accounts accumulate failed Stripe dunning attempts.',
    condition_summary: 'failed_payments >= 2 OR (billing_status == "past_due" AND arr >= 30000)',
  },
  {
    id: 'rule_p1_support_swarm',
    name: 'P1 Support Escalation Swarm',
    channel: 'pagerduty:customer-incident + slack:#support-swarm',
    priority: 'P2',
    description:
      'Mobilizes support engineering pod when P1 ticket backlog compounds elevated account churn risk.',
    condition_summary: 'open_p1_tickets >= 2 OR (open_p1_tickets >= 1 AND risk_score >= 60)',
  },
  {
    id: 'rule_expansion_upsell',
    name: 'Expansion Capacity & Upsell Signal',
    channel: 'crm:ae-expansion-opportunity + slack:#revenue-expansion',
    priority: 'P3',
    description:
      'Notifies Account Executive when healthy accounts exceed 88% seat capacity alongside strong product velocity.',
    condition_summary: 'expansion_eligible == true AND seat_utilization >= 0.88',
  },
];
