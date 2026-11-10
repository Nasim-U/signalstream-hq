const state = {
  riskTier: 'All',
  segment: 'All',
  owner: 'All',
  search: '',
  sortBy: 'risk_score',
  sortDir: 'desc',
  selectedAccountId: null,
  lastSimulatedPayload: null,
  ownersInitialized: false,
};

function fmtCurrency(num) {
  return '$' + Number(num || 0).toLocaleString('en-US');
}

function fmtCompactCurrency(num) {
  const n = Number(num || 0);
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${n}`;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function tierBadgeClass(tier) {
  switch (tier) {
    case 'Critical':
      return 'badge-critical';
    case 'High':
      return 'badge-high';
    case 'Moderate':
      return 'badge-moderate';
    default:
      return 'badge-healthy';
  }
}

function riskColor(score) {
  if (score >= 75) return '#f43f5e';
  if (score >= 50) return '#f59e0b';
  if (score >= 28) return '#38bdf8';
  return '#10b981';
}

function renderMiniSparkline(points, strokeColor) {
  const arr = Array.isArray(points) && points.length > 1 ? points : [10, 10];
  const w = 74;
  const h = 24;
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
    <polyline fill="none" stroke="${strokeColor}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" points="${coords}" />
  </svg>`;
}

function renderLargeSparkline(points, velocityPct) {
  const arr = Array.isArray(points) && points.length > 1 ? points : [100, 100];
  const w = 510;
  const h = 110;
  const padX = 14;
  const padY = 14;
  const min = Math.min(...arr) * 0.92;
  const max = Math.max(...arr) * 1.05;
  const span = max - min || 1;
  const color = velocityPct < -10 ? '#f43f5e' : velocityPct >= 10 ? '#10b981' : '#38bdf8';

  const pts = arr.map((v, idx) => {
    const x = padX + (idx / (arr.length - 1)) * (w - padX * 2);
    const y = h - padY - ((v - min) / span) * (h - padY * 2);
    return { x, y, v, week: `W-${arr.length - 1 - idx}` };
  });

  const linePoints = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const areaPoints = `${pts[0].x.toFixed(1)},${h - padY} ${linePoints} ${pts[pts.length - 1].x.toFixed(1)},${h - padY}`;

  const circles = pts
    .map(
      (p) =>
        `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.2" fill="${color}" />
         <text x="${p.x.toFixed(1)}" y="${Math.max(11, p.y - 7).toFixed(1)}" fill="#94a3b8" font-size="9.5" text-anchor="middle" font-family="monospace">${p.v}</text>`
    )
    .join('');

  return `<svg width="100%" viewBox="0 0 ${w} ${h}" role="img" aria-label="8-week usage trend">
    <defs>
      <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.32" />
        <stop offset="100%" stop-color="${color}" stop-opacity="0.0" />
      </linearGradient>
    </defs>
    <polygon points="${areaPoints}" fill="url(#sparkFill)" />
    <polyline fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" points="${linePoints}" />
    ${circles}
  </svg>`;
}

function showToast(message, isDedup = false) {
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = `toast ${isDedup ? 'toast-dedup' : ''}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 4200);
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

async function loadSummary() {
  const res = await fetch('/api/summary');
  const s = await res.json();

  document.getElementById('kpiTotalArr').textContent = fmtCompactCurrency(s.total_arr);
  document.getElementById('kpiAccountCount').textContent = `${s.total_accounts} accounts`;
  document.getElementById('kpiAvgHealth').textContent = `Portfolio avg health: ${s.avg_health_score}/100`;

  document.getElementById('kpiAtRiskArr').textContent = fmtCompactCurrency(s.at_risk_arr);
  document.getElementById('kpiAtRiskCount').textContent = `${s.at_risk_accounts} at-risk`;
  const pctExposed = s.total_arr > 0 ? Math.round((s.at_risk_arr / s.total_arr) * 100) : 0;
  document.getElementById('kpiRiskBreakdown').textContent =
    `${pctExposed}% of ARR (${s.tiers.Critical.count} Critical, ${s.tiers.High.count} High)`;

  document.getElementById('kpiExpansionArr').textContent = `+${fmtCompactCurrency(s.expansion_pipeline_arr)}`;
  document.getElementById('kpiExpansionCount').textContent = `${s.expansion_accounts} eligible`;

  document.getElementById('kpiPlaybooksFired').textContent = String(s.playbooks_fired);
  document.getElementById('kpiDedupBlocked').textContent = `${s.duplicates_blocked} deduped`;
  document.getElementById('kpiEventsIngested').textContent =
    `${s.events_ingested} unique webhooks ingested`;

  if (!state.ownersInitialized && Array.isArray(s.owners)) {
    const ownerSelect = document.getElementById('ownerSelect');
    ownerSelect.innerHTML =
      '<option value="All">All Owners</option>' +
      s.owners.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('');
    state.ownersInitialized = true;
  }
}

async function loadAccounts() {
  const qs = buildFilterQuery();
  const res = await fetch(`/api/accounts?${qs}`);
  const data = await res.json();
  const tbody = document.getElementById('accountsTableBody');
  document.getElementById('tableResultCount').textContent = `Showing ${data.count} account${data.count === 1 ? '' : 's'}`;

  if (!data.accounts.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">No accounts match the active filters.</td></tr>';
    return;
  }

  tbody.innerHTML = data.accounts
    .map((a) => {
      const color = riskColor(a.risk_score);
      const velSign = a.usage_velocity_pct > 0 ? '+' : '';
      const velColor =
        a.usage_velocity_pct <= -15
          ? '#fb7185'
          : a.usage_velocity_pct >= 12
          ? '#34d399'
          : '#94a3b8';
      const sparkColor =
        a.usage_velocity_pct <= -15
          ? '#f43f5e'
          : a.usage_velocity_pct >= 12
          ? '#10b981'
          : '#38bdf8';

      const billingMeta =
        a.billing_status !== 'active' || a.failed_payments > 0
          ? `<div class="billing-warn">${escapeHtml(a.billing_status)} · ${a.failed_payments} retry fail</div>`
          : `<div class="sub-meta">Billing active</div>`;

      const expBadge = a.expansion_eligible
        ? `<span class="badge badge-expansion">+${fmtCompactCurrency(a.expansion_arr)} EXPANSION</span>`
        : '';

      const seatPct = Math.round(a.seat_utilization * 100);

      return `<tr class="account-row" data-account-id="${escapeHtml(a.id)}">
        <td>
          <div class="acct-name">${escapeHtml(a.name)} ${expBadge}</div>
          <div class="acct-domain">${escapeHtml(a.domain)} · ${escapeHtml(a.id)}</div>
        </td>
        <td>
          <div>${escapeHtml(a.segment)}</div>
          <div class="sub-meta">${escapeHtml(a.owner)}</div>
        </td>
        <td>
          <div style="font-weight:700;font-family:var(--font-mono)">${fmtCurrency(a.arr)}</div>
          ${billingMeta}
        </td>
        <td>
          <div class="risk-cell">
            <div class="risk-top">
              <span class="risk-num" style="color:${color}">${a.risk_score}/100</span>
              <span class="badge ${tierBadgeClass(a.risk_tier)}">${escapeHtml(a.risk_tier)}</span>
            </div>
            <div class="progress-track">
              <div class="progress-fill" style="width:${a.risk_score}%;background:${color}"></div>
            </div>
          </div>
        </td>
        <td>
          <div class="velocity-cell">
            ${renderMiniSparkline(a.usage_history, sparkColor)}
            <span style="font-family:var(--font-mono);font-size:12px;font-weight:600;color:${velColor}">
              ${velSign}${a.usage_velocity_pct}%
            </span>
          </div>
        </td>
        <td>
          <div>${a.seats_active}/${a.seats_purchased} seats (${seatPct}%)</div>
          <div class="sub-meta">Renews in ${a.renewal_days}d${a.open_p1_tickets > 0 ? ` · <span class="text-rose">${a.open_p1_tickets} P1</span>` : ''}</div>
        </td>
      </tr>`;
    })
    .join('');
}

async function loadDispatches() {
  const res = await fetch('/api/playbooks/dispatches?limit=20');
  const { dispatches } = await res.json();
  const container = document.getElementById('dispatchFeed');

  if (!dispatches.length) {
    container.innerHTML = '<div class="empty-feed">No playbooks dispatched yet.</div>';
    return;
  }

  container.innerHTML = dispatches
    .map(
      (d) => `<div class="dispatch-card prio-${escapeHtml(d.priority)}" data-account-id="${escapeHtml(d.account_id)}">
        <div class="dispatch-top">
          <span class="dispatch-rule">${escapeHtml(d.rule_name)}</span>
          <span class="badge ${d.priority === 'P1' ? 'badge-critical' : d.priority === 'P2' ? 'badge-high' : 'badge-healthy'}">${escapeHtml(d.priority)}</span>
        </div>
        <div class="dispatch-summary">${escapeHtml(d.summary)}</div>
        <div class="dispatch-footer">
          <span>${escapeHtml(d.channel.split('+')[0].trim())}</span>
          <span>${escapeHtml(d.dispatch_key)}</span>
        </div>
      </div>`
    )
    .join('');
}

async function loadRules() {
  const res = await fetch('/api/playbooks/rules');
  const { rules } = await res.json();
  const container = document.getElementById('rulesList');

  container.innerHTML = rules
    .map(
      (r) => `<div class="rule-item">
        <div class="rule-head">
          <span class="rule-name">${escapeHtml(r.name)}</span>
          <label class="toggle-label">
            <input type="checkbox" class="rule-toggle" data-rule-id="${escapeHtml(r.id)}" ${r.enabled ? 'checked' : ''} />
            Active
          </label>
        </div>
        <div class="sub-meta">${escapeHtml(r.channel)}</div>
        <div class="rule-cond">${escapeHtml(r.condition_summary)}</div>
      </div>`
    )
    .join('');
}

async function openAccountDrawer(accountId) {
  state.selectedAccountId = accountId;
  const res = await fetch(`/api/accounts/${encodeURIComponent(accountId)}`);
  if (!res.ok) return;
  const { account: a, events, dispatches } = await res.json();

  document.getElementById('drawerBackdrop').classList.remove('hidden');
  document.getElementById('accountDrawer').classList.remove('hidden');

  document.getElementById('drawerBadges').innerHTML = `
    <span class="badge ${tierBadgeClass(a.risk_tier)}">${escapeHtml(a.risk_tier)} Risk (${a.risk_score}/100)</span>
    <span class="badge badge-moderate">${escapeHtml(a.segment)}</span>
    ${a.expansion_eligible ? '<span class="badge badge-expansion">Expansion Ready</span>' : ''}
  `;
  document.getElementById('drawerAccountName').textContent = a.name;
  document.getElementById('drawerMeta').textContent = `${a.domain} · CSM: ${a.owner} · Account ID: ${a.id}`;

  document.getElementById('drawerStats').innerHTML = `
    <div class="mini-stat">
      <div class="mini-stat-label">Current ARR</div>
      <div class="mini-stat-val">${fmtCurrency(a.arr)}</div>
    </div>
    <div class="mini-stat">
      <div class="mini-stat-label">Health Score</div>
      <div class="mini-stat-val" style="color:${riskColor(a.risk_score)}">${a.health_score}/100</div>
    </div>
    <div class="mini-stat">
      <div class="mini-stat-label">Active Seats</div>
      <div class="mini-stat-val">${a.seats_active}/${a.seats_purchased}</div>
    </div>
    <div class="mini-stat">
      <div class="mini-stat-label">Renewal Window</div>
      <div class="mini-stat-val">${a.renewal_days}d</div>
    </div>
  `;

  const expBanner = document.getElementById('drawerExpansionBanner');
  if (a.expansion_eligible) {
    expBanner.classList.remove('hidden');
    expBanner.innerHTML = `<strong>Expansion Opportunity Detected (+${fmtCurrency(a.expansion_arr)} ARR):</strong> ${escapeHtml(a.expansion_reason)}.`;
  } else {
    expBanner.classList.add('hidden');
  }

  const velBadge = document.getElementById('drawerVelocityBadge');
  const sign = a.usage_velocity_pct > 0 ? '+' : '';
  velBadge.textContent = `${sign}${a.usage_velocity_pct}% vs 30d avg`;
  velBadge.style.background =
    a.usage_velocity_pct < -10 ? 'rgba(244,63,94,0.18)' : 'rgba(16,185,129,0.18)';
  velBadge.style.color = a.usage_velocity_pct < -10 ? '#fda4af' : '#6ee7b7';

  document.getElementById('drawerSparkline').innerHTML = renderLargeSparkline(
    a.usage_history,
    a.usage_velocity_pct
  );

  document.getElementById('drawerTotalRiskLabel').textContent = `${a.risk_score} / 100 risk pts`;
  document.getElementById('drawerRiskFactors').innerHTML = a.risk_factors
    .map((f) => {
      const pct = Math.round((f.points / f.max_points) * 100);
      const barColor =
        f.severity === 'critical'
          ? '#f43f5e'
          : f.severity === 'warning'
          ? '#f59e0b'
          : f.severity === 'watch'
          ? '#38bdf8'
          : '#10b981';
      return `<div class="factor-row">
        <div class="factor-head">
          <span>${escapeHtml(f.label)}</span>
          <span class="factor-pts" style="color:${barColor}">${f.points} / ${f.max_points} pts</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="width:${pct}%;background:${barColor}"></div>
        </div>
        <div class="factor-summary">${escapeHtml(f.summary)}</div>
      </div>`;
    })
    .join('');

  // Render merged timeline of recent events & dispatches
  const items = [
    ...dispatches.map((d) => ({
      kind: 'dispatch',
      headLeft: `PLAYBOOK · ${d.rule_name}`,
      headRight: d.dispatch_key,
      body: d.summary,
    })),
    ...events.map((e) => ({
      kind: 'event',
      headLeft: `${e.source.toUpperCase()} · ${e.event_type}`,
      headRight: `risk ${e.risk_before} → ${e.risk_after}`,
      body: `Idempotency key: ${e.idempotency_key}`,
    })),
  ];

  const timelineEl = document.getElementById('drawerTimeline');
  if (!items.length) {
    timelineEl.innerHTML = '<div class="sub-meta">No recent webhook events recorded for this account yet.</div>';
  } else {
    timelineEl.innerHTML = items
      .slice(0, 10)
      .map(
        (it) => `<div class="timeline-item">
          <div class="timeline-head">
            <span style="color:${it.kind === 'dispatch' ? '#38bdf8' : '#cbd5e1'}">${escapeHtml(it.headLeft)}</span>
            <span style="color:#94a3b8">${escapeHtml(it.headRight)}</span>
          </div>
          <div class="sub-meta">${escapeHtml(it.body)}</div>
        </div>`
      )
      .join('');
  }
}

function closeDrawer() {
  state.selectedAccountId = null;
  document.getElementById('drawerBackdrop').classList.add('hidden');
  document.getElementById('accountDrawer').classList.add('hidden');
}

async function refreshAll() {
  await Promise.all([loadSummary(), loadAccounts(), loadDispatches()]);
  if (state.selectedAccountId) {
    await openAccountDrawer(state.selectedAccountId);
  }
}

async function simulateWebhook(eventType, replay = false) {
  if (!state.selectedAccountId) return;

  let body;
  if (replay && state.lastSimulatedPayload) {
    body = { ...state.lastSimulatedPayload };
  } else {
    const rand = Math.random().toString(36).slice(2, 9);
    body = {
      idempotency_key: `evt_sim_${eventType.replace(/\./g, '_')}_${rand}`,
      account_id: state.selectedAccountId,
      event_type: eventType,
      payload:
        eventType === 'telemetry.usage_drop'
          ? { drop_pct: 38 }
          : eventType === 'telemetry.seat_spike'
          ? { boost_pct: 24, added_seats: 8 }
          : eventType === 'support.ticket_escalated'
          ? { severity: 'P1', subject: 'Production API latency spike' }
          : { attempt_count: 2 },
    };
    state.lastSimulatedPayload = body;
    document.getElementById('btnReplayDuplicate').disabled = false;
  }

  const res = await fetch('/api/events/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await res.json();

  if (result.deduplicated) {
    showToast(
      `Idempotency Guard Blocked Duplicate! Key "${result.idempotency_key}" returned 200 OK with zero duplicate alerts.`,
      true
    );
  } else {
    const firedMsg =
      result.dispatches.length > 0
        ? ` → Fired ${result.dispatches.length} playbook(s)!`
        : '';
    showToast(
      `Ingested ${eventType} (Risk ${result.event.risk_before} → ${result.event.risk_after})${firedMsg}`
    );
  }

  await refreshAll();
}

async function runPlaybookForSelected() {
  if (!state.selectedAccountId) return;
  const ruleId = document.getElementById('drawerPlaybookSelect').value;
  const payload = {
    account_id: state.selectedAccountId,
  };
  if (ruleId) payload.rule_id = ruleId;

  const res = await fetch('/api/playbooks/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (data.ok) {
    showToast(`Dispatched "${data.dispatch.rule_name}" (${data.dispatch.dispatch_key})`);
    await refreshAll();
  }
}

// Wire up UI Event Listeners
document.getElementById('tierPills').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tier]');
  if (!btn) return;
  document.querySelectorAll('#tierPills .pill').forEach((p) => p.classList.remove('active'));
  btn.classList.add('active');
  state.riskTier = btn.dataset.tier;
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

document.getElementById('accountsTableBody').addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-account-id]');
  if (row) openAccountDrawer(row.dataset.accountId);
});

document.getElementById('dispatchFeed').addEventListener('click', (e) => {
  const card = e.target.closest('.dispatch-card[data-account-id]');
  if (card) openAccountDrawer(card.dataset.accountId);
});

document.getElementById('rulesList').addEventListener('change', async (e) => {
  const input = e.target.closest('.rule-toggle');
  if (!input) return;
  const ruleId = input.dataset.ruleId;
  await fetch(`/api/playbooks/rules/${encodeURIComponent(ruleId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: input.checked }),
  });
  showToast(`Routing rule ${input.checked ? 'enabled' : 'paused'}.`);
});

document.getElementById('btnCloseDrawer').addEventListener('click', closeDrawer);
document.getElementById('drawerBackdrop').addEventListener('click', closeDrawer);

document.querySelectorAll('button[data-sim]').forEach((btn) => {
  btn.addEventListener('click', () => simulateWebhook(btn.dataset.sim, false));
});

document.getElementById('btnReplayDuplicate').addEventListener('click', () => {
  simulateWebhook(null, true);
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
  state.lastSimulatedPayload = null;
  document.getElementById('btnReplayDuplicate').disabled = true;
  showToast('Demo SaaS portfolio reset to baseline (44 accounts).');
  await refreshAll();
});

// Initial Boot
Promise.all([loadSummary(), loadAccounts(), loadDispatches(), loadRules()]);
