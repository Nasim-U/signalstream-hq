import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './config.js';
import { seedPortfolio } from './seed.js';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, statusCode, data, extraHeaders = {}) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function readJsonBody(req, maxBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        const err = new Error('Request payload too large');
        err.statusCode = 413;
        req.destroy();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        const err = new Error('Malformed JSON request body');
        err.statusCode = 400;
        reject(err);
      }
    });

    req.on('error', reject);
  });
}

function serveStaticFile(res, baseDir, relativeFile) {
  const safeTarget = path.resolve(baseDir, relativeFile);
  if (!safeTarget.startsWith(path.resolve(baseDir))) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  if (!fs.existsSync(safeTarget) || !fs.statSync(safeTarget).isFile()) {
    sendJson(res, 404, { error: 'Not Found' });
    return;
  }

  const ext = path.extname(safeTarget).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const content = fs.readFileSync(safeTarget);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache',
  });
  res.end(content);
}

export function createAppServer(store) {
  const publicDir = path.join(PROJECT_ROOT, 'public');
  const docsDir = path.join(PROJECT_ROOT, 'docs');

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const pathname = url.pathname;
      const method = (req.method || 'GET').toUpperCase();

      // Health check
      if (method === 'GET' && pathname === '/api/health') {
        sendJson(res, 200, {
          status: 'ok',
          service: 'signalstream-hq',
          version: '1.0.0',
          accounts_monitored: store.countAccounts(),
        });
        return;
      }

      // Portfolio Summary KPIs
      if (method === 'GET' && pathname === '/api/summary') {
        sendJson(res, 200, store.getPortfolioSummary());
        return;
      }

      // CSV / JSON Report Export (must match before /api/accounts/:id)
      if (method === 'GET' && pathname === '/api/accounts/export') {
        const format = (url.searchParams.get('format') || 'csv').toLowerCase();
        const filters = {
          riskTier: url.searchParams.get('riskTier') || 'All',
          segment: url.searchParams.get('segment') || 'All',
          owner: url.searchParams.get('owner') || 'All',
          search: url.searchParams.get('search') || '',
          expansionOnly: url.searchParams.get('expansionOnly') || 'false',
          sortBy: url.searchParams.get('sortBy') || 'risk_score',
          sortDir: url.searchParams.get('sortDir') || 'desc',
        };

        if (format === 'json') {
          const accounts = store.listAccounts(filters);
          const report = {
            exported_at: new Date().toISOString(),
            filters,
            count: accounts.length,
            summary: store.getPortfolioSummary(),
            accounts,
          };
          sendJson(res, 200, report, {
            'Content-Disposition':
              'attachment; filename="signalstream-accounts.json"',
          });
          return;
        }

        if (format === 'csv') {
          const csv = store.exportAccountsCsv(filters);
          res.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition':
              'attachment; filename="signalstream-accounts.csv"',
            'Cache-Control': 'no-store',
          });
          res.end(csv);
          return;
        }

        sendJson(res, 400, {
          error: `Unsupported export format "${format}". Expected "csv" or "json".`,
        });
        return;
      }

      // List & Filter Accounts
      if (method === 'GET' && pathname === '/api/accounts') {
        const filters = {
          riskTier: url.searchParams.get('riskTier') || 'All',
          segment: url.searchParams.get('segment') || 'All',
          owner: url.searchParams.get('owner') || 'All',
          search: url.searchParams.get('search') || '',
          expansionOnly: url.searchParams.get('expansionOnly') || 'false',
          sortBy: url.searchParams.get('sortBy') || 'risk_score',
          sortDir: url.searchParams.get('sortDir') || 'desc',
        };
        const accounts = store.listAccounts(filters);
        sendJson(res, 200, {
          count: accounts.length,
          accounts,
        });
        return;
      }

      // Account Detail Drawer Endpoint
      const accountMatch = pathname.match(/^\/api\/accounts\/([^/]+)$/);
      if (method === 'GET' && accountMatch) {
        const accountId = decodeURIComponent(accountMatch[1]);
        const detail = store.getAccountDetail(accountId);
        if (!detail) {
          sendJson(res, 404, { error: `Account not found: ${accountId}` });
          return;
        }
        sendJson(res, 200, detail);
        return;
      }

      // Multi-Channel Idempotent Event Ingestion
      if (method === 'POST' && pathname === '/api/events/ingest') {
        const body = await readJsonBody(req);
        const headerIdempKey = req.headers['idempotency-key'];
        if (!body.idempotency_key && headerIdempKey) {
          body.idempotency_key = String(headerIdempKey);
        }

        const result = store.ingestEvent(body);
        const statusCode = result.deduplicated ? 200 : 201;
        sendJson(res, statusCode, result);
        return;
      }

      // List Playbook Dispatches Feed
      if (method === 'GET' && pathname === '/api/playbooks/dispatches') {
        const limit = Number(url.searchParams.get('limit') || 25);
        sendJson(res, 200, {
          dispatches: store.listDispatches(limit),
        });
        return;
      }

      // List Playbook Routing Rules
      if (method === 'GET' && pathname === '/api/playbooks/rules') {
        sendJson(res, 200, {
          rules: store.listRules(),
        });
        return;
      }

      // Toggle Playbook Rule
      const ruleMatch = pathname.match(/^\/api\/playbooks\/rules\/([^/]+)$/);
      if (method === 'PATCH' && ruleMatch) {
        const ruleId = decodeURIComponent(ruleMatch[1]);
        const body = await readJsonBody(req);
        const updated = store.toggleRule(ruleId, Boolean(body.enabled));
        if (!updated) {
          sendJson(res, 404, { error: `Rule not found: ${ruleId}` });
          return;
        }
        sendJson(res, 200, { ok: true, rule: updated });
        return;
      }

      // Trigger Playbook Action (One-Click or API)
      if (method === 'POST' && pathname === '/api/playbooks/run') {
        const body = await readJsonBody(req);
        const headerIdempKey = req.headers['idempotency-key'];
        if (!body.idempotency_key && headerIdempKey) {
          body.idempotency_key = String(headerIdempKey);
        }
        if (!body.account_id) {
          sendJson(res, 400, { error: 'Missing required field: account_id' });
          return;
        }
        const result = store.runManualPlaybook(body);
        sendJson(res, result.deduplicated ? 200 : 201, result);
        return;
      }

      // Reset Demo Portfolio
      if (method === 'POST' && pathname === '/api/admin/reset') {
        seedPortfolio(store, { reset: true });
        sendJson(res, 200, {
          ok: true,
          summary: store.getPortfolioSummary(),
        });
        return;
      }

      // Static Assets
      if (method === 'GET') {
        if (pathname === '/' || pathname === '/index.html') {
          serveStaticFile(res, publicDir, 'index.html');
          return;
        }
        if (pathname.startsWith('/docs/')) {
          serveStaticFile(res, docsDir, pathname.slice('/docs/'.length));
          return;
        }
        const relativeAsset = pathname.replace(/^\/+/, '');
        if (relativeAsset && !relativeAsset.startsWith('api/')) {
          serveStaticFile(res, publicDir, relativeAsset);
          return;
        }
      }

      sendJson(res, 404, { error: `Route not found: ${method} ${pathname}` });
    } catch (err) {
      const status = Number(err.statusCode) || 500;
      sendJson(res, status, {
        error: err.message || 'Internal Server Error',
      });
    }
  });

  return server;
}
