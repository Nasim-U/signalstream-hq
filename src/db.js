import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_DB_PATH, DEFAULT_PLAYBOOK_RULES } from './config.js';
import { computeAccountIntelligence } from './scoring.js';
import {
  buildPlaybookAction,
  evaluatePlaybookRules,
} from './playbooks.js';

const SUPPORTED_EVENT_TYPES = new Set([
  'invoice.payment_failed',
  'invoice.paid',
  'customer.subscription.updated',
  'telemetry.usage_drop',
  'telemetry.seat_spike',
  'telemetry.feature_adoption',
  'support.ticket_escalated',
  'support.ticket_resolved',
]);

function hydrateAccountRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    segment: row.segment,
    owner: row.owner,
    arr: row.arr,
    seats_purchased: row.seats_purchased,
    seats_active: row.seats_active,
    usage_7d: row.usage_7d,
    usage_30d_weekly_avg: row.usage_30d_weekly_avg,
    usage_history: JSON.parse(row.usage_history_json || '[]'),
    billing_status: row.billing_status,
    failed_payments: row.failed_payments,
    open_p1_tickets: row.open_p1_tickets,
    open_p2_tickets: row.open_p2_tickets,
    renewal_days: row.renewal_days,
    risk_score: row.risk_score,
    health_score: row.health_score,
    risk_tier: row.risk_tier,
    usage_velocity_pct: row.usage_velocity_pct,
    seat_utilization: row.seat_utilization,
    risk_factors: JSON.parse(row.risk_factors_json || '[]'),
    expansion_eligible: Boolean(row.expansion_eligible),
    expansion_arr: row.expansion_arr,
    expansion_reason: row.expansion_reason,
    updated_at: row.updated_at,
  };
}

function hydrateEventRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    idempotency_key: row.idempotency_key,
    account_id: row.account_id,
    source: row.source,
    event_type: row.event_type,
    payload: JSON.parse(row.payload_json || '{}'),
    risk_before: row.risk_before,
    risk_after: row.risk_after,
    created_at: row.created_at,
  };
}

function hydrateDispatchRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    dispatch_key: row.dispatch_key,
    rule_id: row.rule_id,
    rule_name: row.rule_name,
    account_id: row.account_id,
    account_name: row.account_name,
    channel: row.channel,
    priority: row.priority,
    trigger_event_key: row.trigger_event_key,
    status: row.status,
    summary: row.summary,
    payload: JSON.parse(row.payload_json || '{}'),
    created_at: row.created_at,
  };
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function createStore(dbPath = DEFAULT_DB_PATH) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  function initSchema() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        domain TEXT NOT NULL,
        segment TEXT NOT NULL,
        owner TEXT NOT NULL,
        arr INTEGER NOT NULL,
        seats_purchased INTEGER NOT NULL,
        seats_active INTEGER NOT NULL,
        usage_7d INTEGER NOT NULL,
        usage_30d_weekly_avg INTEGER NOT NULL,
        usage_history_json TEXT NOT NULL,
        billing_status TEXT NOT NULL DEFAULT 'active',
        failed_payments INTEGER NOT NULL DEFAULT 0,
        open_p1_tickets INTEGER NOT NULL DEFAULT 0,
        open_p2_tickets INTEGER NOT NULL DEFAULT 0,
        renewal_days INTEGER NOT NULL DEFAULT 180,
        risk_score INTEGER NOT NULL DEFAULT 0,
        health_score INTEGER NOT NULL DEFAULT 100,
        risk_tier TEXT NOT NULL DEFAULT 'Healthy',
        usage_velocity_pct REAL NOT NULL DEFAULT 0,
        seat_utilization REAL NOT NULL DEFAULT 0,
        risk_factors_json TEXT NOT NULL DEFAULT '[]',
        expansion_eligible INTEGER NOT NULL DEFAULT 0,
        expansion_arr INTEGER NOT NULL DEFAULT 0,
        expansion_reason TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ingested_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT NOT NULL UNIQUE,
        account_id TEXT NOT NULL,
        source TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        risk_before INTEGER NOT NULL,
        risk_after INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_events_account_created
        ON ingested_events(account_id, id DESC);

      CREATE TABLE IF NOT EXISTS playbook_rules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        channel TEXT NOT NULL,
        priority TEXT NOT NULL,
        description TEXT NOT NULL,
        condition_summary TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS playbook_dispatches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dispatch_key TEXT NOT NULL UNIQUE,
        rule_id TEXT NOT NULL,
        rule_name TEXT NOT NULL,
        account_id TEXT NOT NULL,
        account_name TEXT NOT NULL,
        channel TEXT NOT NULL,
        priority TEXT NOT NULL,
        trigger_event_key TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_dispatches_created
        ON playbook_dispatches(id DESC);

      CREATE TABLE IF NOT EXISTS system_metrics (
        metric_key TEXT PRIMARY KEY,
        metric_value INTEGER NOT NULL DEFAULT 0
      );

      INSERT OR IGNORE INTO system_metrics (metric_key, metric_value)
        VALUES ('duplicates_blocked', 0);
    `);

    const insertRuleStmt = db.prepare(`
      INSERT OR IGNORE INTO playbook_rules (
        id, name, channel, priority, description, condition_summary, enabled
      ) VALUES (?, ?, ?, ?, ?, ?, 1)
    `);
    for (const rule of DEFAULT_PLAYBOOK_RULES) {
      insertRuleStmt.run(
        rule.id,
        rule.name,
        rule.channel,
        rule.priority,
        rule.description,
        rule.condition_summary
      );
    }
  }

  initSchema();

  function countAccounts() {
    const row = db.prepare('SELECT COUNT(*) AS cnt FROM accounts').get();
    return Number(row?.cnt ?? 0);
  }

  function resetAll() {
    db.exec(`
      DELETE FROM playbook_dispatches;
      DELETE FROM ingested_events;
      DELETE FROM accounts;
      UPDATE system_metrics SET metric_value = 0 WHERE metric_key = 'duplicates_blocked';
    `);
  }

  function upsertAccount(input) {
    const intel = computeAccountIntelligence(input);
    const now = input.updated_at || new Date().toISOString();
    const usageHistory = Array.isArray(input.usage_history)
      ? input.usage_history
      : [
          input.usage_30d_weekly_avg,
          input.usage_30d_weekly_avg,
          input.usage_7d,
        ];

    const stmt = db.prepare(`
      INSERT INTO accounts (
        id, name, domain, segment, owner, arr,
        seats_purchased, seats_active, usage_7d, usage_30d_weekly_avg,
        usage_history_json, billing_status, failed_payments,
        open_p1_tickets, open_p2_tickets, renewal_days,
        risk_score, health_score, risk_tier,
        usage_velocity_pct, seat_utilization, risk_factors_json,
        expansion_eligible, expansion_arr, expansion_reason, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        domain = excluded.domain,
        segment = excluded.segment,
        owner = excluded.owner,
        arr = excluded.arr,
        seats_purchased = excluded.seats_purchased,
        seats_active = excluded.seats_active,
        usage_7d = excluded.usage_7d,
        usage_30d_weekly_avg = excluded.usage_30d_weekly_avg,
        usage_history_json = excluded.usage_history_json,
        billing_status = excluded.billing_status,
        failed_payments = excluded.failed_payments,
        open_p1_tickets = excluded.open_p1_tickets,
        open_p2_tickets = excluded.open_p2_tickets,
        renewal_days = excluded.renewal_days,
        risk_score = excluded.risk_score,
        health_score = excluded.health_score,
        risk_tier = excluded.risk_tier,
        usage_velocity_pct = excluded.usage_velocity_pct,
        seat_utilization = excluded.seat_utilization,
        risk_factors_json = excluded.risk_factors_json,
        expansion_eligible = excluded.expansion_eligible,
        expansion_arr = excluded.expansion_arr,
        expansion_reason = excluded.expansion_reason,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      input.id,
      input.name,
      input.domain,
      input.segment,
      input.owner,
      Math.round(Number(input.arr)),
      Math.round(Number(input.seats_purchased)),
      Math.round(Number(input.seats_active)),
      Math.round(Number(input.usage_7d)),
      Math.round(Number(input.usage_30d_weekly_avg)),
      JSON.stringify(usageHistory),
      input.billing_status || 'active',
      Math.round(Number(input.failed_payments || 0)),
      Math.round(Number(input.open_p1_tickets || 0)),
      Math.round(Number(input.open_p2_tickets || 0)),
      Math.round(Number(input.renewal_days || 180)),
      intel.risk_score,
      intel.health_score,
      intel.risk_tier,
      intel.usage_velocity_pct,
      intel.seat_utilization,
      JSON.stringify(intel.risk_factors),
      intel.expansion_eligible ? 1 : 0,
      intel.expansion_arr,
      intel.expansion_reason,
      now
    );

    return getAccountById(input.id);
  }

  function getAccountById(accountId) {
    const row = db
      .prepare('SELECT * FROM accounts WHERE id = ?')
      .get(accountId);
    return hydrateAccountRow(row);
  }

  function listRules() {
    const rows = db
      .prepare('SELECT * FROM playbook_rules ORDER BY priority ASC, id ASC')
      .all();
    return rows.map((r) => ({
      ...r,
      enabled: Boolean(r.enabled),
    }));
  }

  function toggleRule(ruleId, enabled) {
    const res = db
      .prepare('UPDATE playbook_rules SET enabled = ? WHERE id = ?')
      .run(enabled ? 1 : 0, ruleId);
    if (res.changes === 0) return null;
    const row = db
      .prepare('SELECT * FROM playbook_rules WHERE id = ?')
      .get(ruleId);
    return { ...row, enabled: Boolean(row.enabled) };
  }

  function insertDispatchIfNew(action, createdAt) {
    const existing = db
      .prepare('SELECT * FROM playbook_dispatches WHERE dispatch_key = ?')
      .get(action.dispatch_key);
    if (existing) {
      return { dispatch: hydrateDispatchRow(existing), deduplicated: true };
    }

    db.prepare(`
      INSERT INTO playbook_dispatches (
        dispatch_key, rule_id, rule_name, account_id, account_name,
        channel, priority, trigger_event_key, status, summary, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      action.dispatch_key,
      action.rule_id,
      action.rule_name,
      action.account_id,
      action.account_name,
      action.channel,
      action.priority,
      action.trigger_event_key,
      action.status,
      action.summary,
      JSON.stringify(action.payload),
      createdAt
    );

    const inserted = db
      .prepare('SELECT * FROM playbook_dispatches WHERE dispatch_key = ?')
      .get(action.dispatch_key);
    return { dispatch: hydrateDispatchRow(inserted), deduplicated: false };
  }

  function applyEventMutation(account, eventType, payload = {}) {
    const next = {
      ...account,
      usage_history: Array.isArray(account.usage_history)
        ? [...account.usage_history]
        : [],
    };

    switch (eventType) {
      case 'invoice.payment_failed': {
        next.failed_payments = Number(next.failed_payments || 0) + 1;
        next.billing_status =
          next.failed_payments >= 4 ? 'uncollectible' : 'past_due';
        break;
      }

      case 'invoice.paid': {
        next.failed_payments = 0;
        next.billing_status = 'active';
        break;
      }

      case 'customer.subscription.updated': {
        if (payload.seats_purchased !== undefined) {
          next.seats_purchased = Math.max(1, Number(payload.seats_purchased));
        }
        if (payload.seats_active !== undefined) {
          next.seats_active = Math.max(0, Number(payload.seats_active));
        }
        if (payload.arr !== undefined) {
          next.arr = Math.max(0, Number(payload.arr));
        }
        if (payload.billing_status) {
          next.billing_status = String(payload.billing_status);
        }
        break;
      }

      case 'telemetry.usage_drop': {
        const dropPct = Math.min(
          85,
          Math.max(10, Number(payload.drop_pct ?? 38))
        );
        next.usage_7d = Math.max(
          5,
          Math.round(next.usage_7d * (1 - dropPct / 100))
        );
        if (payload.seat_drop) {
          next.seats_active = Math.max(
            1,
            next.seats_active - Number(payload.seat_drop)
          );
        } else {
          next.seats_active = Math.max(
            1,
            Math.round(next.seats_active * 0.88)
          );
        }
        next.usage_history = [...next.usage_history.slice(-7), next.usage_7d];
        break;
      }

      case 'telemetry.seat_spike':
      case 'telemetry.feature_adoption': {
        const boostPct = Math.min(
          100,
          Math.max(8, Number(payload.boost_pct ?? 24))
        );
        next.usage_7d = Math.round(next.usage_7d * (1 + boostPct / 100));
        const addedSeats =
          payload.added_seats !== undefined
            ? Number(payload.added_seats)
            : Math.max(2, Math.round(next.seats_purchased * 0.14));
        next.seats_active = Math.min(
          Math.ceil(next.seats_purchased * 1.05),
          next.seats_active + addedSeats
        );
        next.usage_history = [...next.usage_history.slice(-7), next.usage_7d];
        break;
      }

      case 'support.ticket_escalated': {
        const severity = String(payload.severity || 'P1').toUpperCase();
        if (severity === 'P2') {
          next.open_p2_tickets = Number(next.open_p2_tickets || 0) + 1;
        } else {
          next.open_p1_tickets = Number(next.open_p1_tickets || 0) + 1;
        }
        break;
      }

      case 'support.ticket_resolved': {
        const severity = String(payload.severity || 'P1').toUpperCase();
        if (severity === 'P2') {
          next.open_p2_tickets = Math.max(
            0,
            Number(next.open_p2_tickets || 0) - 1
          );
        } else if (next.open_p1_tickets > 0) {
          next.open_p1_tickets = next.open_p1_tickets - 1;
        } else {
          next.open_p2_tickets = Math.max(
            0,
            Number(next.open_p2_tickets || 0) - 1
          );
        }
        break;
      }

      default:
        break;
    }

    return next;
  }

  /**
   * Ingest a multi-channel webhook or telemetry event with strict idempotency.
   */
  function ingestEvent(rawEvent) {
    const idempotencyKey = String(
      rawEvent.idempotency_key || rawEvent.id || ''
    ).trim();
    const accountId = String(rawEvent.account_id || '').trim();
    const eventType = String(rawEvent.event_type || rawEvent.type || '').trim();
    const source = String(
      rawEvent.source ||
        (eventType.startsWith('invoice.') || eventType.startsWith('customer.')
          ? 'stripe'
          : eventType.startsWith('support.')
          ? 'zendesk'
          : 'telemetry')
    ).trim();
    const payload =
      rawEvent.payload && typeof rawEvent.payload === 'object'
        ? rawEvent.payload
        : {};

    if (!idempotencyKey) {
      const err = new Error('Missing required field: idempotency_key');
      err.statusCode = 400;
      throw err;
    }
    if (!accountId) {
      const err = new Error('Missing required field: account_id');
      err.statusCode = 400;
      throw err;
    }
    if (!SUPPORTED_EVENT_TYPES.has(eventType)) {
      const err = new Error(
        `Unsupported event_type "${eventType}". Supported types: ${[...SUPPORTED_EVENT_TYPES].join(', ')}`
      );
      err.statusCode = 400;
      throw err;
    }

    // Check idempotency key BEFORE mutating state
    const existingRow = db
      .prepare('SELECT * FROM ingested_events WHERE idempotency_key = ?')
      .get(idempotencyKey);

    if (existingRow) {
      db.prepare(
        "UPDATE system_metrics SET metric_value = metric_value + 1 WHERE metric_key = 'duplicates_blocked'"
      ).run();
      const account = getAccountById(existingRow.account_id);
      const priorDispatches = db
        .prepare(
          'SELECT * FROM playbook_dispatches WHERE trigger_event_key = ? ORDER BY id ASC'
        )
        .all(idempotencyKey)
        .map(hydrateDispatchRow);

      return {
        ok: true,
        deduplicated: true,
        idempotency_key: idempotencyKey,
        event: hydrateEventRow(existingRow),
        account,
        dispatches: priorDispatches,
      };
    }

    const currentAccount = getAccountById(accountId);
    if (!currentAccount) {
      const err = new Error(`Account not found: ${accountId}`);
      err.statusCode = 404;
      throw err;
    }

    const now = rawEvent.occurred_at || new Date().toISOString();
    const riskBefore = currentAccount.risk_score;

    db.exec('BEGIN IMMEDIATE');
    try {
      const mutated = applyEventMutation(currentAccount, eventType, payload);
      mutated.updated_at = now;
      const updatedAccount = upsertAccount(mutated);
      const riskAfter = updatedAccount.risk_score;

      db.prepare(`
        INSERT INTO ingested_events (
          idempotency_key, account_id, source, event_type,
          payload_json, risk_before, risk_after, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        idempotencyKey,
        accountId,
        source,
        eventType,
        JSON.stringify(payload),
        riskBefore,
        riskAfter,
        now
      );

      const eventRow = db
        .prepare('SELECT * FROM ingested_events WHERE idempotency_key = ?')
        .get(idempotencyKey);

      const rules = listRules();
      const candidateActions = evaluatePlaybookRules(
        updatedAccount,
        idempotencyKey,
        rules
      );

      const firedDispatches = [];
      for (const action of candidateActions) {
        const { dispatch, deduplicated } = insertDispatchIfNew(action, now);
        if (!deduplicated) {
          firedDispatches.push(dispatch);
        }
      }

      db.exec('COMMIT');

      return {
        ok: true,
        deduplicated: false,
        idempotency_key: idempotencyKey,
        event: hydrateEventRow(eventRow),
        account: updatedAccount,
        dispatches: firedDispatches,
      };
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Manually or programmatically trigger a playbook for an account with idempotency protection.
   */
  function runManualPlaybook({ account_id, rule_id, idempotency_key }) {
    const account = getAccountById(account_id);
    if (!account) {
      const err = new Error(`Account not found: ${account_id}`);
      err.statusCode = 404;
      throw err;
    }

    const rules = listRules();
    let selectedRule = rule_id
      ? rules.find((r) => r.id === rule_id)
      : null;

    if (rule_id && !selectedRule) {
      const err = new Error(`Playbook rule not found: ${rule_id}`);
      err.statusCode = 404;
      throw err;
    }

    if (!selectedRule) {
      if (account.expansion_eligible) {
        selectedRule = rules.find((r) => r.id === 'rule_expansion_upsell');
      } else if (account.failed_payments > 0 || account.billing_status !== 'active') {
        selectedRule = rules.find((r) => r.id === 'rule_dunning_recovery');
      } else if (account.open_p1_tickets > 0) {
        selectedRule = rules.find((r) => r.id === 'rule_p1_support_swarm');
      } else {
        selectedRule = rules.find((r) => r.id === 'rule_ent_churn_rescue') || rules[0];
      }
    }

    const triggerKey =
      idempotency_key || `manual_${crypto.randomUUID().slice(0, 12)}`;
    const action = buildPlaybookAction(selectedRule, account, triggerKey);
    const now = new Date().toISOString();
    const { dispatch, deduplicated } = insertDispatchIfNew(action, now);

    if (deduplicated) {
      db.prepare(
        "UPDATE system_metrics SET metric_value = metric_value + 1 WHERE metric_key = 'duplicates_blocked'"
      ).run();
    }

    return {
      ok: true,
      deduplicated,
      dispatch,
      account,
    };
  }

  /**
   * List accounts with filtering, search, and sorting.
   */
  function listAccounts(filters = {}) {
    const clauses = [];
    const params = [];

    if (filters.riskTier && filters.riskTier !== 'All') {
      if (filters.riskTier === 'Expansion') {
        clauses.push('expansion_eligible = 1');
      } else {
        clauses.push('risk_tier = ?');
        params.push(filters.riskTier);
      }
    }

    if (filters.segment && filters.segment !== 'All') {
      clauses.push('segment = ?');
      params.push(filters.segment);
    }

    if (filters.owner && filters.owner !== 'All') {
      clauses.push('owner = ?');
      params.push(filters.owner);
    }

    if (filters.expansionOnly === true || filters.expansionOnly === 'true') {
      clauses.push('expansion_eligible = 1');
    }

    if (filters.search && String(filters.search).trim()) {
      const q = `%${String(filters.search).trim().toLowerCase()}%`;
      clauses.push(
        '(LOWER(name) LIKE ? OR LOWER(domain) LIKE ? OR LOWER(id) LIKE ? OR LOWER(owner) LIKE ?)'
      );
      params.push(q, q, q, q);
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    const allowedSorts = {
      risk_score: 'risk_score',
      arr: 'arr',
      usage_velocity_pct: 'usage_velocity_pct',
      seat_utilization: 'seat_utilization',
      renewal_days: 'renewal_days',
      name: 'name',
    };
    const sortCol = allowedSorts[filters.sortBy] || 'risk_score';
    const sortDir =
      String(filters.sortDir || 'desc').toLowerCase() === 'asc'
        ? 'ASC'
        : 'DESC';

    const rows = db
      .prepare(
        `SELECT * FROM accounts ${whereSql} ORDER BY ${sortCol} ${sortDir}, arr DESC`
      )
      .all(...params);

    return rows.map(hydrateAccountRow);
  }

  function getAccountDetail(accountId) {
    const account = getAccountById(accountId);
    if (!account) return null;

    const events = db
      .prepare(
        'SELECT * FROM ingested_events WHERE account_id = ? ORDER BY id DESC LIMIT 20'
      )
      .all(accountId)
      .map(hydrateEventRow);

    const dispatches = db
      .prepare(
        'SELECT * FROM playbook_dispatches WHERE account_id = ? ORDER BY id DESC LIMIT 15'
      )
      .all(accountId)
      .map(hydrateDispatchRow);

    return {
      account,
      events,
      dispatches,
    };
  }

  function listDispatches(limit = 25) {
    const safeLimit = Math.min(100, Math.max(1, Number(limit || 25)));
    return db
      .prepare('SELECT * FROM playbook_dispatches ORDER BY id DESC LIMIT ?')
      .all(safeLimit)
      .map(hydrateDispatchRow);
  }

  function listEvents(limit = 50) {
    const safeLimit = Math.min(100, Math.max(1, Number(limit || 50)));
    return db
      .prepare(`
        SELECT e.*, a.name AS account_name
        FROM ingested_events e
        LEFT JOIN accounts a ON a.id = e.account_id
        ORDER BY e.id DESC
        LIMIT ?
      `)
      .all(safeLimit)
      .map((row) => ({
        ...hydrateEventRow(row),
        account_name: row.account_name || row.account_id,
      }));
  }

  function getPortfolioSummary() {
    const totals = db
      .prepare(`
        SELECT
          COUNT(*) AS total_accounts,
          COALESCE(SUM(arr), 0) AS total_arr,
          COALESCE(SUM(CASE WHEN risk_tier IN ('Critical', 'High') THEN arr ELSE 0 END), 0) AS at_risk_arr,
          COALESCE(SUM(CASE WHEN risk_tier IN ('Critical', 'High') THEN 1 ELSE 0 END), 0) AS at_risk_accounts,
          COALESCE(SUM(CASE WHEN expansion_eligible = 1 THEN expansion_arr ELSE 0 END), 0) AS expansion_pipeline_arr,
          COALESCE(SUM(CASE WHEN expansion_eligible = 1 THEN 1 ELSE 0 END), 0) AS expansion_accounts,
          ROUND(AVG(health_score), 1) AS avg_health_score,
          ROUND(AVG(risk_score), 1) AS avg_risk_score
        FROM accounts
      `)
      .get();

    const tierRows = db
      .prepare(
        'SELECT risk_tier, COUNT(*) AS count, COALESCE(SUM(arr), 0) AS arr FROM accounts GROUP BY risk_tier'
      )
      .all();

    const tiers = {
      Critical: { count: 0, arr: 0 },
      High: { count: 0, arr: 0 },
      Moderate: { count: 0, arr: 0 },
      Healthy: { count: 0, arr: 0 },
    };
    for (const r of tierRows) {
      if (tiers[r.risk_tier]) {
        tiers[r.risk_tier] = { count: Number(r.count), arr: Number(r.arr) };
      }
    }

    const playbooksCount = Number(
      db.prepare('SELECT COUNT(*) AS cnt FROM playbook_dispatches').get()?.cnt ?? 0
    );
    const eventsCount = Number(
      db.prepare('SELECT COUNT(*) AS cnt FROM ingested_events').get()?.cnt ?? 0
    );
    const duplicatesBlocked = Number(
      db
        .prepare(
          "SELECT metric_value FROM system_metrics WHERE metric_key = 'duplicates_blocked'"
        )
        .get()?.metric_value ?? 0
    );

    const owners = db
      .prepare('SELECT DISTINCT owner FROM accounts ORDER BY owner ASC')
      .all()
      .map((r) => r.owner);

    const segments = ['Enterprise', 'Mid-Market', 'Growth'];

    return {
      total_accounts: Number(totals.total_accounts || 0),
      total_arr: Number(totals.total_arr || 0),
      at_risk_arr: Number(totals.at_risk_arr || 0),
      at_risk_accounts: Number(totals.at_risk_accounts || 0),
      expansion_pipeline_arr: Number(totals.expansion_pipeline_arr || 0),
      expansion_accounts: Number(totals.expansion_accounts || 0),
      avg_health_score: Number(totals.avg_health_score || 0),
      avg_risk_score: Number(totals.avg_risk_score || 0),
      playbooks_fired: playbooksCount,
      events_ingested: eventsCount,
      duplicates_blocked: duplicatesBlocked,
      tiers,
      owners,
      segments,
    };
  }

  function exportAccountsCsv(filters = {}) {
    const accounts = listAccounts(filters);
    const headers = [
      'account_id',
      'name',
      'domain',
      'segment',
      'owner',
      'arr_usd',
      'risk_score',
      'health_score',
      'risk_tier',
      'billing_status',
      'failed_payments',
      'usage_7d',
      'usage_velocity_pct',
      'seats_active',
      'seats_purchased',
      'seat_utilization_pct',
      'open_p1_tickets',
      'open_p2_tickets',
      'renewal_days',
      'expansion_eligible',
      'expansion_arr_usd',
    ];

    const lines = [headers.join(',')];
    for (const a of accounts) {
      lines.push(
        [
          a.id,
          a.name,
          a.domain,
          a.segment,
          a.owner,
          a.arr,
          a.risk_score,
          a.health_score,
          a.risk_tier,
          a.billing_status,
          a.failed_payments,
          a.usage_7d,
          a.usage_velocity_pct,
          a.seats_active,
          a.seats_purchased,
          Math.round(a.seat_utilization * 100),
          a.open_p1_tickets,
          a.open_p2_tickets,
          a.renewal_days,
          a.expansion_eligible ? 'true' : 'false',
          a.expansion_arr,
        ]
          .map(csvEscape)
          .join(',')
      );
    }
    return lines.join('\n');
  }

  function close() {
    db.close();
  }

  return {
    db,
    countAccounts,
    resetAll,
    upsertAccount,
    getAccountById,
    getAccountDetail,
    listAccounts,
    ingestEvent,
    runManualPlaybook,
    listDispatches,
    listEvents,
    listRules,
    toggleRule,
    getPortfolioSummary,
    exportAccountsCsv,
    close,
  };
}
