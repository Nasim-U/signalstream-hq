const state = {
  activeView: 'all',
  riskTier: 'All',
  segment: 'All',
  owner: 'All',
  search: '',
  sortBy: 'arr',
  sortDir: 'desc',
  selectedAccountId: null,
  replayEventPayload: null,
  ownersInitialized: false,
};

function fmtCurrency(num) {
  return '$' + Math.round(Number(num || 0)).toLocaleString('en-US');
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function statusDotClass(score) {
  if (score >= 75) return 'dot-critical';
  if (score >= 28) return 'dot-elevated';
  return 'dot-healthy';
}

function strokeForVelocity(velPct, riskScore) {
  if (velPct <= -15 || riskScore >= 75) return '#DC2626';
  if (velPct < -5 || riskScore >= 28) return '#D97706';
  if (velPct >= 10) return '#16A34A';
  return '#2563EB';
}

function formatBillingLabel(status, retries) {
  const retryWord = retries === 1 ? 'retry' : 'retries';
  if (status === 'past_due') {
    return retries > 0 ? `Past due (${retries} ${retryWord})` : 'Past due';
  }
  if (status === 'uncollectible') {
    return `Uncollectible (${retries} ${retryWord})`;
  }
  if (retries > 0) {
    return `Active (${retries} ${retryWord})`;
  }
  return 'Active';
}

function renderInlineSparkline(points, strokeColor) {
  const arr = Array.isArray(points) && points.length > 1 ? points : [10, 10];
  const w = 64;
  const h = 20;
  const min = Math.min(...arr);
  const max = Math.max(...arr);
  const span = max - min || 1;
  const coords = arr
    .map((v, i) => {
      const x = (i / (arr.length - 1)) * (w - 4) + 2;
      const y = h - 3 - ((v - min) / span) * (h - 6);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <polyline fill="none" stroke="${strokeColor}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" points="${coords}" />
  </svg>`;
}

function renderUsageChart(points, baselineAvg, velocityPct, riskScore) {
  const arr = Array.isArray(points) && points.length > 1 ? points : [100, 100];
  const w = 516;
  const h = 98;
  const padLeft = 18;
  const padRight = 18;
  const padTop = 16;
  const padBottom = 18;

  const allVals = baselineAvg ? [...arr, baselineAvg] : arr;
  const min = Math.min(...allVals) * 0.88;
  const max = Math.max(...allVals) * 1.06;
  const span = max - min || 1;
  const stroke = strokeForVelocity(velocityPct, riskScore);

  const yFor = (val) =>
    h - padBottom - ((val - min) / span) * (h - padTop - padBottom);

  const pts = arr.map((v, idx) => {
    const x =
      padLeft + (idx / (arr.length - 1)) * (w - padLeft - padRight);
    const y = yFor(v);
    const label = idx === arr.length - 1 ? 'Now' : `W-${arr.length - 1 - idx}`;
    return { x, y, v, label };
  });

  const linePoints = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const areaPoints = `${pts[0].x.toFixed(1)},${(h - padBottom).toFixed(1)} ${linePoints} ${pts[pts.length - 1].x.toFixed(1)},${(h - padBottom).toFixed(1)}`;
  const baselineY = yFor(baselineAvg || arr[0]).toFixed(1);

  const markers = pts
    .map(
      (p) => `
      <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.6" fill="${stroke}" />
      <text x="${p.x.toFixed(1)}" y="${Math.max(10, p.y - 6).toFixed(1)}" fill="#5A5F6B" font-size="9.5" text-anchor="middle" font-family="JetBrains Mono, monospace">${p.v.toLocaleString('en-US')}</text>
      <text x="${p.x.toFixed(1)}" y="${h - 4}" fill="#7C8290" font-size="9" text-anchor="middle" font-family="JetBrains Mono, monospace">${p.label}</text>`
    )
    .join('');

  return `<svg width="100%" viewBox="0 0 ${w} ${h}" role="img" aria-label="8-week active usage chart">
    <defs>
      <linearGradient id="usageAreaFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${stroke}" stop-opacity="0.12" />
        <stop offset="100%" stop-color="${stroke}" stop-opacity="0.01" />
      </linearGradient>
    </defs>
    <line x1="${padLeft}" y1="${padTop}" x2="${w - padRight}" y2="${padTop}" stroke="#EEF0F4" stroke-width="1" />
    <line x1="${padLeft}" y1="${h - padBottom}" x2="${w - padRight}" y2="${h - padBottom}" stroke="#E2E4E9" stroke-width="1" />
    <line x1="${padLeft}" y1="${baselineY}" x2="${w - padRight}" y2="${baselineY}" stroke="#9CA3AF" stroke-width="1" stroke-dasharray="3 3" />
    <polygon points="${areaPoints}" fill="url(#usageAreaFill)" />
    <polyline fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="${linePoints}" />
    ${markers}
  </svg>`;
}

function showToast(message, isDedup = false) {
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = `toast-item ${isDedup ? 'toast-dedup' : ''}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 4000);
}

function buildFilterQuery() {
  const params = new URLSearchParams();
  if (state.riskTier !== 'All') params.set('riskTier', state.riskTier);
  if (state.segment !== 'All') params.set('segment', state.segment);
  if (state.owner !== 'All') params.set('owner', state.owner);
  if (state.search.trim()) params.set('search', state.search.trim());
  params.set('sortBy', state.sortBy);
  params.set('sortDir', state.sortDir);
  return params.toString();
}

function syncHeaderCopy(totalAccounts = 44) {
  const titleEl = document.getElementById('workspaceTitle');
  const subEl = document.getElementById('workspaceSubtitle');

  if (state.activeView === 'webhooks') {
    titleEl.textContent = 'Webhook ingestion log';
    subEl.textContent =
      'Stripe, Zendesk, and product telemetry events deduplicated in SQLite WAL alongside routed dispatches';
  } else if (state.activeView === 'rules') {
    titleEl.textContent = 'Automated routing rules';
    subEl.textContent =
      'Thresholds evaluated inside each webhook transaction before dispatching Slack, PagerDuty, or CRM tasks';
  } else if (state.riskTier === 'Critical') {
    titleEl.textContent = 'Critical risk accounts';
    subEl.textContent =
      'Subscriptions scoring 75 or higher across usage contraction, dunning retries, and open P1 incidents';
  } else if (state.riskTier === 'Expansion') {
    titleEl.textContent = 'Expansion candidates';
    subEl.textContent =
      'Healthy subscriptions at 88% or higher seat utilization with positive 7-day usage growth';
  } else {
    titleEl.textContent = 'Account health ledger';
    subEl.textContent = `Billing, product usage, and support signals across ${totalAccounts} B2B subscriptions`;
  }
}

async function loadSummary() {
  const res = await fetch('/api/summary');
  const s = await res.json();

  document.getElementById('kpiTotalArr').textContent = fmtCurrency(s.total_arr);
  document.getElementById('kpiAccountCount').textContent = `${s.total_accounts} accounts`;

  document.getElementById('kpiAtRiskArr').textContent = fmtCurrency(s.at_risk_arr);
  document.getElementById('kpiAtRiskCount').textContent = `${s.at_risk_accounts} accounts`;

  document.getElementById('kpiExpansionArr').textContent = `+${fmtCurrency(s.expansion_pipeline_arr)}`;
  document.getElementById('kpiExpansionCount').textContent = `${s.expansion_accounts} eligible`;

  document.getElementById('kpiEventsIngested').textContent = String(s.events_ingested);
  document.getElementById('kpiDedupBlocked').textContent = `${s.duplicates_blocked} duplicates blocked`;

  document.getElementById('kpiPlaybooksFired').textContent = String(s.playbooks_fired);
  document.getElementById('kpiAvgHealth').textContent = `Avg health ${s.avg_health_score} / 100`;

  document.getElementById('navCountAll').textContent = String(s.total_accounts);
  document.getElementById('navCountCritical').textContent = String(s.tiers.Critical.count);
  document.getElementById('navCountExpansion').textContent = String(s.expansion_accounts);
  document.getElementById('navCountWebhooks').textContent = String(s.events_ingested);
  document.getElementById('railDedupStat').textContent = `${s.duplicates_blocked} duplicate keys blocked`;

  syncHeaderCopy(s.total_accounts);

  if (!state.ownersInitialized && Array.isArray(s.owners)) {
    const ownerSelect = document.getElementById('ownerSelect');
    ownerSelect.innerHTML =
      '<option value="All">All owners</option>' +
      s.owners
        .map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`)
        .join('');
    state.ownersInitialized = true;
  }
}

async function loadAccounts() {
  const qs = buildFilterQuery();
  const res = await fetch(`/api/accounts?${qs}`);
  const data = await res.json();
  const tbody = document.getElementById('accountsTableBody');

  document.getElementById('tableResultCount').textContent =
    `Showing ${data.count} ${data.count === 1 ? 'account' : 'accounts'}`;

  if (!data.accounts.length) {
    tbody.innerHTML =
      '<tr><td colspan="9" class="empty-state">No accounts match the selected filters. Reset filters or search terms to view all subscriptions.</td></tr>';
    return;
  }

  tbody.innerHTML = data.accounts
    .map((a) => {
      const dotClass = statusDotClass(a.risk_score);
      const sparkColor = strokeForVelocity(a.usage_velocity_pct, a.risk_score);
      const velSign = a.usage_velocity_pct > 0 ? '+' : '';
      const velClass =
        a.usage_velocity_pct <= -15
          ? 'text-critical'
          : a.usage_velocity_pct >= 12
          ? 'text-healthy'
          : '';

      const isBadBilling =
        a.billing_status !== 'active' || a.failed_payments > 0;
      const billingText = formatBillingLabel(a.billing_status, a.failed_payments);

      const expFlag = a.expansion_eligible
        ? `<span class="inline-flag">+${fmtCurrency(a.expansion_arr)}</span>`
        : '';

      const p1Flag =
        a.open_p1_tickets > 0
          ? `<span class="inline-flag inline-flag-p1">${a.open_p1_tickets} P1</span>`
          : '';

      const selectedClass =
        state.selectedAccountId === a.id ? 'is-selected' : '';

      return `<tr class="account-row ${selectedClass}" data-account-id="${escapeHtml(a.id)}">
        <td>
          <div class="acct-primary">
            <span class="acct-name">${escapeHtml(a.name)}</span>
            ${expFlag}
          </div>
          <div class="acct-sub">${escapeHtml(a.domain)}</div>
        </td>
        <td>${escapeHtml(a.segment)}</td>
        <td>${escapeHtml(a.owner)}</td>
        <td>
          <span class="${isBadBilling ? 'billing-past-due' : 'billing-ok'}">${escapeHtml(billingText)}</span>
        </td>
        <td class="num-col mono-strong">${fmtCurrency(a.arr)}</td>
        <td class="num-col mono-num">
          ${a.seats_active} / ${a.seats_purchased}
        </td>
        <td class="num-col">
          <div class="usage-trend-cell">
            ${renderInlineSparkline(a.usage_history, sparkColor)}
            <span class="usage-delta ${velClass}">${velSign}${a.usage_velocity_pct.toFixed(1)}%</span>
          </div>
        </td>
        <td class="num-col mono-num">
          ${a.renewal_days}d${p1Flag}
        </td>
        <td class="num-col">
          <div class="risk-readout">
            <span class="status-dot ${dotClass}" aria-hidden="true"></span>
            <span class="risk-score-strong">${a.risk_score}</span>
            <span class="risk-denom">/ 100</span>
          </div>
        </td>
      </tr>`;
    })
    .join('');
}

async function loadWebhookLogView() {
  const [eventsRes, dispRes] = await Promise.all([
    fetch('/api/events?limit=40'),
    fetch('/api/playbooks/dispatches?limit=30'),
  ]);
  const { events } = await eventsRes.json();
  const { dispatches } = await dispRes.json();

  const eventsBody = document.getElementById('eventsLogBody');
  if (!events.length) {
    eventsBody.innerHTML =
      '<tr><td colspan="5" class="empty-state">No webhook events ingested yet.</td></tr>';
  } else {
    eventsBody.innerHTML = events
      .map(
        (e) => `<tr class="account-row" data-account-id="${escapeHtml(e.account_id)}">
          <td><span class="event-source-tag">${escapeHtml(e.source)}</span></td>
          <td class="mono-num">${escapeHtml(e.event_type)}</td>
          <td>
            <span class="acct-name">${escapeHtml(e.account_name)}</span>
            <span class="cell-secondary">(${escapeHtml(e.account_id)})</span>
          </td>
          <td class="mono-num cell-secondary">${escapeHtml(e.idempotency_key)}</td>
          <td class="num-col mono-num">${e.risk_before} to ${e.risk_after}</td>
        </tr>`
      )
      .join('');
  }

  const dispBody = document.getElementById('dispatchesLogBody');
  if (!dispatches.length) {
    dispBody.innerHTML =
      '<tr><td colspan="5" class="empty-state">No playbooks dispatched yet.</td></tr>';
  } else {
    dispBody.innerHTML = dispatches
      .map(
        (d) => `<tr class="account-row" data-account-id="${escapeHtml(d.account_id)}">
          <td class="mono-strong">${escapeHtml(d.priority)}</td>
          <td>
            <div class="acct-name">${escapeHtml(d.rule_name)}</div>
            <div class="acct-sub">${escapeHtml(d.summary)}</div>
          </td>
          <td>${escapeHtml(d.account_name)}</td>
          <td class="mono-num cell-secondary">${escapeHtml(d.channel)}</td>
          <td class="mono-num cell-secondary">${escapeHtml(d.dispatch_key)}</td>
        </tr>`
      )
      .join('');
  }
}

async function loadRulesView() {
  const res = await fetch('/api/playbooks/rules');
  const { rules } = await res.json();
  document.getElementById('navCountRules').textContent = String(
    rules.filter((r) => r.enabled).length
  );

  const tbody = document.getElementById('rulesTableBody');
  tbody.innerHTML = rules
    .map(
      (r) => `<tr>
        <td class="mono-strong">${escapeHtml(r.priority)}</td>
        <td>
          <div class="acct-name">${escapeHtml(r.name)}</div>
          <div class="acct-sub">${escapeHtml(r.description)}</div>
        </td>
        <td class="mono-num cell-secondary">${escapeHtml(r.condition_summary)}</td>
        <td class="mono-num cell-secondary">${escapeHtml(r.channel)}</td>
        <td class="num-col">
          <label class="rule-toggle-wrap">
            <input type="checkbox" class="rule-toggle" data-rule-id="${escapeHtml(r.id)}" ${r.enabled ? 'checked' : ''} />
            <span>${r.enabled ? 'Enabled' : 'Paused'}</span>
          </label>
        </td>
      </tr>`
    )
    .join('');
}

function setView(viewName) {
  state.activeView = viewName;

  document.querySelectorAll('.rail-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });

  const accountsView = document.getElementById('accountsView');
  const webhooksView = document.getElementById('webhooksView');
  const rulesView = document.getElementById('rulesView');

  accountsView.classList.toggle(
    'hidden',
    viewName === 'webhooks' || viewName === 'rules'
  );
  webhooksView.classList.toggle('hidden', viewName !== 'webhooks');
  rulesView.classList.toggle('hidden', viewName !== 'rules');

  if (viewName === 'all') {
    state.riskTier = 'All';
    state.sortBy = 'arr';
    state.sortDir = 'desc';
    document.getElementById('sortSelect').value = 'arr:desc';
    syncTierTabButtons();
    loadAccounts();
  } else if (viewName === 'critical') {
    state.riskTier = 'Critical';
    state.sortBy = 'risk_score';
    state.sortDir = 'desc';
    document.getElementById('sortSelect').value = 'risk_score:desc';
    syncTierTabButtons();
    loadAccounts();
  } else if (viewName === 'expansion') {
    state.riskTier = 'Expansion';
    state.sortBy = 'arr';
    state.sortDir = 'desc';
    document.getElementById('sortSelect').value = 'arr:desc';
    syncTierTabButtons();
    loadAccounts();
  } else if (viewName === 'webhooks') {
    loadWebhookLogView();
  } else if (viewName === 'rules') {
    loadRulesView();
  }

  syncHeaderCopy();
}

function syncTierTabButtons() {
  document.querySelectorAll('#tierTabs .tier-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tier === state.riskTier);
  });
}

async function openAccountDrawer(accountId) {
  state.selectedAccountId = accountId;
  document.querySelectorAll('#accountsTableBody tr.account-row').forEach((tr) => {
    tr.classList.toggle('is-selected', tr.dataset.accountId === accountId);
  });

  const res = await fetch(`/api/accounts/${encodeURIComponent(accountId)}`);
  if (!res.ok) return;
  const { account: a, events, dispatches } = await res.json();

  document.getElementById('drawerBackdrop').dataset.open = 'true';
  document.getElementById('accountDrawer').dataset.open = 'true';

  document.getElementById('drawerAccountName').textContent = a.name;
  document.getElementById('drawerRiskReadout').innerHTML = `
    <span class="status-dot ${statusDotClass(a.risk_score)}" aria-hidden="true"></span>
    <span>${escapeHtml(a.risk_tier)}</span>
    <span class="risk-score-strong">${a.risk_score} / 100</span>
  `;
  document.getElementById('drawerMeta').textContent =
    `${a.domain}, ${a.segment}, owner ${a.owner}, ID ${a.id}`;

  const seatPct = Math.round(a.seat_utilization * 100);
  const billingLabel = formatBillingLabel(a.billing_status, a.failed_payments);

  document.getElementById('drawerStats').innerHTML = `
    <div class="drawer-metric-cell">
      <span class="drawer-metric-label">Annual contract</span>
      <span class="drawer-metric-val">${fmtCurrency(a.arr)}</span>
    </div>
    <div class="drawer-metric-cell">
      <span class="drawer-metric-label">Billing status</span>
      <span class="drawer-metric-val ${a.billing_status !== 'active' ? 'text-critical' : ''}">${escapeHtml(billingLabel)}</span>
    </div>
    <div class="drawer-metric-cell">
      <span class="drawer-metric-label">Seat usage</span>
      <span class="drawer-metric-val">${a.seats_active} / ${a.seats_purchased} (${seatPct}%)</span>
    </div>
    <div class="drawer-metric-cell">
      <span class="drawer-metric-label">Renewal window</span>
      <span class="drawer-metric-val">${a.renewal_days} days</span>
    </div>
  `;

  const expBanner = document.getElementById('drawerExpansionBanner');
  if (a.expansion_eligible) {
    expBanner.classList.remove('hidden');
    expBanner.innerHTML =
      `<strong>Expansion candidate (+${fmtCurrency(a.expansion_arr)} ARR):</strong> ${escapeHtml(a.expansion_reason)}.`;
  } else {
    expBanner.classList.add('hidden');
  }

  const velSign = a.usage_velocity_pct > 0 ? '+' : '';
  document.getElementById('drawerVelocityLabel').textContent =
    `${velSign}${a.usage_velocity_pct.toFixed(1)}% vs 30d avg (${a.usage_30d_weekly_avg.toLocaleString('en-US')} wk)`;

  document.getElementById('drawerSparkline').innerHTML = renderUsageChart(
    a.usage_history,
    a.usage_30d_weekly_avg,
    a.usage_velocity_pct,
    a.risk_score
  );

  document.getElementById('drawerTotalRiskLabel').textContent =
    `${a.risk_score} / 100 risk points`;

  document.getElementById('drawerRiskFactors').innerHTML = a.risk_factors
    .map((f) => {
      const pct = Math.round((f.points / f.max_points) * 100);
      const barColor =
        f.severity === 'critical'
          ? '#DC2626'
          : f.severity === 'warning' || f.severity === 'watch'
          ? '#D97706'
          : '#16A34A';

      return `<div class="factor-item">
        <div class="factor-line">
          <span class="factor-name">${escapeHtml(f.label)}</span>
          <div class="factor-bar-track">
            <div class="factor-bar-fill" style="width:${pct}%;background-color:${barColor}"></div>
          </div>
          <span class="factor-score">${f.points} / ${f.max_points}</span>
        </div>
        <div class="factor-reason">${escapeHtml(f.summary)}</div>
      </div>`;
    })
    .join('');

  if (
    !state.replayEventPayload ||
    state.replayEventPayload.account_id !== a.id
  ) {
    if (events.length > 0) {
      const latest = events[0];
      state.replayEventPayload = {
        idempotency_key: latest.idempotency_key,
        account_id: a.id,
        source: latest.source,
        event_type: latest.event_type,
        payload: latest.payload || {},
      };
    } else {
      state.replayEventPayload = null;
    }
  }

  const replayBtn = document.getElementById('btnReplayDuplicate');
  const keyLabel = document.getElementById('activeIdempKeyLabel');
  if (state.replayEventPayload) {
    replayBtn.disabled = false;
    keyLabel.textContent = `Key: ${state.replayEventPayload.idempotency_key}`;
  } else {
    replayBtn.disabled = true;
    keyLabel.textContent = 'No prior key recorded';
  }

  const combinedLog = [
    ...events.map((e) => ({
      kind: 'event',
      tag: e.source,
      title: e.event_type,
      key: e.idempotency_key,
      delta: `risk ${e.risk_before} to ${e.risk_after}`,
    })),
    ...dispatches.map((d) => ({
      kind: 'dispatch',
      tag: 'playbook',
      title: d.rule_name,
      key: d.dispatch_key,
      delta: `${d.priority} dispatched`,
    })),
  ];

  document.getElementById('drawerEventCountLabel').textContent =
    `${events.length} events, ${dispatches.length} dispatches`;

  const timelineEl = document.getElementById('drawerTimeline');
  if (!combinedLog.length) {
    timelineEl.innerHTML =
      '<div class="cell-secondary">No webhook events or dispatches recorded for this account yet.</div>';
  } else {
    timelineEl.innerHTML = combinedLog
      .slice(0, 5)
      .map(
        (item) => `<div class="event-log-row">
          <span class="event-source-tag ${item.kind === 'dispatch' ? 'event-source-dispatch' : ''}">${escapeHtml(item.tag)}</span>
          <div class="event-main">
            <span class="event-title">${escapeHtml(item.title)}</span>
            <span class="event-key-inline">${escapeHtml(item.key)}</span>
          </div>
          <span class="event-delta">${escapeHtml(item.delta)}</span>
        </div>`
      )
      .join('');
  }
}

function closeDrawer() {
  state.selectedAccountId = null;
  document.getElementById('drawerBackdrop').dataset.open = 'false';
  document.getElementById('accountDrawer').dataset.open = 'false';
  document.querySelectorAll('#accountsTableBody tr.account-row').forEach((tr) => {
    tr.classList.remove('is-selected');
  });
}

async function refreshAll() {
  const tasks = [loadSummary(), loadAccounts()];
  if (state.activeView === 'webhooks') tasks.push(loadWebhookLogView());
  if (state.activeView === 'rules') tasks.push(loadRulesView());
  await Promise.all(tasks);

  if (state.selectedAccountId) {
    await openAccountDrawer(state.selectedAccountId);
  }
}

async function sendWebhook(replay = false) {
  if (!state.selectedAccountId) return;

  let body;
  if (replay && state.replayEventPayload) {
    body = { ...state.replayEventPayload };
  } else {
    const eventType = document.getElementById('simEventSelect').value;
    const suffix = Math.random().toString(36).slice(2, 8);
    body = {
      idempotency_key: `evt_live_${eventType.replace(/\./g, '_')}_${suffix}`,
      account_id: state.selectedAccountId,
      event_type: eventType,
      payload:
        eventType === 'telemetry.usage_drop'
          ? { drop_pct: 38 }
          : eventType === 'telemetry.seat_spike'
          ? { boost_pct: 24, added_seats: 8 }
          : eventType === 'support.ticket_escalated'
          ? { severity: 'P1', subject: 'API gateway timeout spike' }
          : { attempt_count: 2 },
    };
    state.replayEventPayload = body;
  }

  const res = await fetch('/api/events/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await res.json();

  if (result.deduplicated) {
    showToast(
      `Duplicate key ${result.idempotency_key} ignored (HTTP 200). Account score unchanged at ${result.account.risk_score} / 100.`,
      true
    );
  } else {
    const dispatchNote =
      result.dispatches.length > 0
        ? `, ${result.dispatches.length} playbook dispatched`
        : '';
    showToast(
      `Processed ${body.event_type} (risk ${result.event.risk_before} to ${result.event.risk_after}${dispatchNote}).`
    );
  }

  await refreshAll();
}

async function runPlaybookForSelected() {
  if (!state.selectedAccountId) return;
  const ruleId = document.getElementById('drawerPlaybookSelect').value;
  const payload = { account_id: state.selectedAccountId };
  if (ruleId) payload.rule_id = ruleId;

  const res = await fetch('/api/playbooks/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (data.ok) {
    showToast(`Dispatched ${data.dispatch.rule_name} (${data.dispatch.dispatch_key}).`);
    await refreshAll();
  }
}

/* Event Listeners */
document.querySelector('.rail-nav').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (!btn) return;
  setView(btn.dataset.view);
});

document.getElementById('tierTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tier]');
  if (!btn) return;
  state.riskTier = btn.dataset.tier;
  syncTierTabButtons();

  if (state.riskTier === 'Critical') {
    state.activeView = 'critical';
  } else if (state.riskTier === 'Expansion') {
    state.activeView = 'expansion';
  } else {
    state.activeView = 'all';
  }
  document.querySelectorAll('.rail-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.view === state.activeView);
  });

  syncHeaderCopy();
  loadAccounts();
});

document.getElementById('searchInput').addEventListener('input', (e) => {
  state.search = e.target.value;
  loadAccounts();
});

document.getElementById('segmentSelect').addEventListener('change', (e) => {
  state.segment = e.target.value;
  loadAccounts();
});

document.getElementById('ownerSelect').addEventListener('change', (e) => {
  state.owner = e.target.value;
  loadAccounts();
});

document.getElementById('sortSelect').addEventListener('change', (e) => {
  const [col, dir] = e.target.value.split(':');
  state.sortBy = col;
  state.sortDir = dir;
  loadAccounts();
});

document.addEventListener('click', (e) => {
  const row = e.target.closest('tr.account-row[data-account-id]');
  if (row && !e.target.closest('input, button, label')) {
    openAccountDrawer(row.dataset.accountId);
  }
});

document.getElementById('rulesTableBody').addEventListener('change', async (e) => {
  const input = e.target.closest('.rule-toggle');
  if (!input) return;
  const ruleId = input.dataset.ruleId;
  await fetch(`/api/playbooks/rules/${encodeURIComponent(ruleId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: input.checked }),
  });
  showToast(`Routing rule ${input.checked ? 'enabled' : 'paused'}.`);
  await loadRulesView();
});

document.getElementById('btnCloseDrawer').addEventListener('click', closeDrawer);
document.getElementById('drawerBackdrop').addEventListener('click', closeDrawer);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.selectedAccountId) {
    closeDrawer();
  }
});

document.getElementById('btnSendWebhook').addEventListener('click', () => {
  sendWebhook(false);
});

document.getElementById('btnReplayDuplicate').addEventListener('click', () => {
  sendWebhook(true);
});

document.getElementById('btnRunPlaybook').addEventListener('click', runPlaybookForSelected);

document.getElementById('btnExportCsv').addEventListener('click', () => {
  window.location.href = `/api/accounts/export?format=csv&${buildFilterQuery()}`;
});

document.getElementById('btnExportJson').addEventListener('click', () => {
  window.location.href = `/api/accounts/export?format=json&${buildFilterQuery()}`;
});

document.getElementById('btnResetDemo').addEventListener('click', async () => {
  await fetch('/api/admin/reset', { method: 'POST' });
  state.replayEventPayload = null;
  showToast('Portfolio reset to seeded 44-account baseline.');
  await refreshAll();
});

Promise.all([loadSummary(), loadAccounts(), loadRulesView()]);
