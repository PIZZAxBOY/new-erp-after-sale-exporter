#!/usr/bin/env node
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const process = require('process');

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.config', 'new-erp-after-sale-cron', 'config.json');
const DEFAULT_MONTHS = 6;
const HTTP_TIMEOUT_MS = 30_000;
const HTTP_RETRIES = 2;
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 10 * 60_000;
const DOWNLOAD_PAGE_SIZE = 100;
const DOWNLOAD_PAGES_TO_CHECK = 3;

function usage() {
  return `
New ERP after-sale complaint export cron script

Usage:
  node new-erp-after-sale-cron.js [options]

Options:
  --brand <BRAND_CODE>        Brand code for this run. Overrides config/env.
  --months <N>                Export the previous N months. Default: 6.
  --download-dir <DIR>        Directory for downloaded xlsx files.
  --config <PATH>             Custom config file path.
  --start-date YYYY-MM-DD     Explicit start date for backfill.
  --end-date YYYY-MM-DD       Explicit end date for backfill.
  --help                      Show this help.

Environment variables:
  ERP_BASE_URL
  ERP_USERNAME
  ERP_PASSWORD
  ERP_BRAND
  ERP_DOWNLOAD_DIR

Default config file:
  ${DEFAULT_CONFIG_PATH}
`.trim();
}

function log(message, details) {
  const suffix = details === undefined ? '' : ` ${JSON.stringify(details)}`;
  console.log(`[${new Date().toISOString()}] ${message}${suffix}`);
}

function fail(message) {
  const error = new Error(message);
  error.isUserFacing = true;
  throw error;
}

function parseArgs(argv) {
  const args = {
    months: DEFAULT_MONTHS,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      fail(`Unknown argument: ${token}`);
    }

    const eqIndex = token.indexOf('=');
    const key = eqIndex >= 0 ? token.slice(0, eqIndex) : token;
    let value = eqIndex >= 0 ? token.slice(eqIndex + 1) : undefined;

    const needsValue = new Set([
      '--brand',
      '--months',
      '--download-dir',
      '--config',
      '--start-date',
      '--end-date',
    ]);

    if (key === '--help') {
      args.help = true;
      continue;
    }

    if (!needsValue.has(key)) {
      fail(`Unknown option: ${key}`);
    }

    if (value === undefined) {
      i += 1;
      value = argv[i];
    }
    if (!value || value.startsWith('--')) {
      fail(`Missing value for ${key}`);
    }

    switch (key) {
      case '--brand':
        args.brand = value;
        break;
      case '--months':
        args.months = parsePositiveInteger(value, '--months');
        break;
      case '--download-dir':
        args.downloadDir = value;
        break;
      case '--config':
        args.config = value;
        break;
      case '--start-date':
        args.startDate = parseDateOnly(value, '--start-date');
        break;
      case '--end-date':
        args.endDate = parseDateOnly(value, '--end-date');
        break;
      default:
        fail(`Unknown option: ${key}`);
    }
  }

  return args;
}

function parsePositiveInteger(value, label) {
  if (!/^\d+$/.test(String(value))) {
    fail(`${label} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    fail(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseDateOnly(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail(`${label} must use YYYY-MM-DD`);
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    fail(`${label} is not a valid calendar date`);
  }
  return value;
}

async function loadConfig(args) {
  const configPath = args.config ? path.resolve(args.config) : DEFAULT_CONFIG_PATH;
  const fileConfig = await readJsonIfExists(configPath);

  const config = {
    baseUrl: firstDefined(undefined, process.env.ERP_BASE_URL, fileConfig.baseUrl),
    username: firstDefined(undefined, process.env.ERP_USERNAME, fileConfig.username),
    password: firstDefined(undefined, process.env.ERP_PASSWORD, fileConfig.password),
    brand: firstDefined(args.brand, process.env.ERP_BRAND, fileConfig.brand),
    downloadDir: firstDefined(args.downloadDir, process.env.ERP_DOWNLOAD_DIR, fileConfig.downloadDir),
    configPath,
  };

  const missing = [];
  for (const key of ['baseUrl', 'username', 'password', 'brand', 'downloadDir']) {
    if (!config[key]) {
      missing.push(key);
    }
  }
  if (missing.length > 0) {
    fail(`Missing required configuration: ${missing.join(', ')}`);
  }

  config.baseUrl = String(config.baseUrl).replace(/\/+$/, '');
  config.brand = String(config.brand).trim();
  config.downloadDir = path.resolve(String(config.downloadDir));

  if (!/^https?:\/\//i.test(config.baseUrl)) {
    fail('baseUrl must start with http:// or https://');
  }
  if (!config.brand) {
    fail('brand must not be empty');
  }

  return config;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return undefined;
}

async function readJsonIfExists(filePath) {
  try {
    const text = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }
    if (error instanceof SyntaxError) {
      fail(`Config file is not valid JSON: ${filePath}`);
    }
    throw error;
  }
}

function buildDateRange(args) {
  const today = new Date();
  const endDate = args.endDate || formatLocalDate(today);

  let startDate;
  if (args.startDate) {
    startDate = args.startDate;
  } else {
    const end = localDateFromString(endDate);
    const start = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    start.setMonth(start.getMonth() - args.months);
    startDate = formatLocalDate(start);
  }

  if (new Date(`${startDate}T00:00:00`) > new Date(`${endDate}T00:00:00`)) {
    fail('start-date must be earlier than or equal to end-date');
  }

  return {
    startDate,
    endDate,
    startDateTime: `${startDate} 00:00:00`,
    endDateTime: `${endDate} 23:59:59`,
    createdAt: `${startDate} 00:00:00 & ${endDate} 23:59:59`,
  };
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function localDateFromString(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

async function login(config) {
  const response = await requestJson(config, {
    method: 'POST',
    route: '/index.php?r=/user/check-login',
    body: {
      username: config.username,
      password: config.password,
    },
    retryAuthFailures: false,
  });

  const token = response && response.data && response.data.token;
  if (!token) {
    fail(`Login failed: ${safeMsg(response)}`);
  }
  return token;
}

async function createExportTask(config, token, dateRange) {
  const params = new URLSearchParams({
    auction_site: config.brand,
    after_type_status: '3',
    created_at: dateRange.createdAt,
    search_type: 'transaction_id',
    route: '/customerService/afterSales',
    is_hx_export: '0',
    _t: String(Date.now()),
  });

  const response = await requestJson(config, {
    method: 'GET',
    route: `/index.php?r=/customerService/after-sale-order/after-sale-export&${params.toString()}`,
    token,
  });

  const message = safeMsg(response);
  log('Export task response', {
    code: response && response.code,
    msg: message,
  });

  if (response && response.code === 200) {
    return response;
  }
  if (message.includes('已存在下载任务') || message.toLowerCase().includes('already')) {
    return response;
  }
  fail(`Create export task failed: ${message}`);
}

async function waitForTask(config, token, dateRange) {
  const startedAt = Date.now();
  let attempt = 0;

  while (Date.now() - startedAt <= POLL_TIMEOUT_MS) {
    attempt += 1;
    const result = await findDownloadTask(config, token, dateRange);

    if (result.task) {
      log('Download task is ready', {
        id: result.task.id,
        add_time: result.task.add_time,
      });
      return result.task;
    }

    if (result.incompleteCount > 0) {
      log('Matching download task found but not complete yet', {
        attempt,
        incompleteCount: result.incompleteCount,
      });
    } else {
      log('No matching download task found yet', { attempt });
    }

    await sleep(POLL_INTERVAL_MS);
  }

  fail('Timed out waiting for download task to complete');
}

async function findDownloadTask(config, token, dateRange) {
  const completeMatches = [];
  let incompleteCount = 0;

  for (let page = 1; page <= DOWNLOAD_PAGES_TO_CHECK; page += 1) {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(DOWNLOAD_PAGE_SIZE),
    });
    const response = await requestJson(config, {
      method: 'GET',
      route: `/index.php?r=/settings/download-center/index&${params.toString()}`,
      token,
    });

    const tasks = extractDownloadTasks(response);
    for (const task of tasks) {
      if (!matchesBaseDownloadTask(task)) {
        continue;
      }
      if (!matchesAddCondition(task.add_condition, config.brand, dateRange)) {
        continue;
      }
      if (String(task.status) === '3' && task.down_file) {
        completeMatches.push(task);
      } else {
        incompleteCount += 1;
      }
    }
  }

  completeMatches.sort(compareTasksNewestFirst);
  return {
    task: completeMatches[0],
    incompleteCount,
  };
}

function extractDownloadTasks(response) {
  const candidates = [
    response && response.data,
    response && response.data && response.data.list,
    response && response.data && response.data.data,
    response && response.data && response.data.rows,
    response && response.list,
    response && response.rows,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }
  return [];
}

function matchesBaseDownloadTask(task) {
  return (
    task &&
    task.title === '客服-售后工单-导出' &&
    task.route_url === 'customerService/after-sale-order/after-sale-export'
  );
}

function matchesAddCondition(addCondition, brand, dateRange) {
  const variants = conditionVariants(addCondition);
  const lowerBrand = String(brand).toLowerCase();
  const startVariants = conditionVariants(dateRange.startDateTime);
  const endVariants = conditionVariants(dateRange.endDateTime);

  return variants.some((variant) => {
    const lower = variant.toLowerCase();
    const hasBrand = lower.includes(lowerBrand);
    const hasAfterType = [
      'after_type_status=3',
      'after_type_status%3d3',
      'after_type_status":"3',
      'after_type_status":3',
      'after_type_status:3',
    ].some((needle) => lower.includes(needle));
    const hasStart = startVariants.some((needle) => lower.includes(needle.toLowerCase()));
    const hasEnd = endVariants.some((needle) => lower.includes(needle.toLowerCase()));
    return hasBrand && hasAfterType && hasStart && hasEnd;
  });
}

function conditionVariants(value) {
  const raw = stringifyCondition(value);
  const variants = new Set([raw]);
  const encoded = encodeURIComponent(raw);
  variants.add(encoded);
  variants.add(encoded.replace(/%20/g, '+'));

  let decoded = raw;
  for (let i = 0; i < 3; i += 1) {
    try {
      decoded = decodeURIComponent(decoded);
      variants.add(decoded);
      variants.add(decoded.replace(/\+/g, ' '));
    } catch (_error) {
      break;
    }
  }

  return Array.from(variants).filter(Boolean);
}

function stringifyCondition(value) {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
}

function compareTasksNewestFirst(a, b) {
  const aId = Number(a.id);
  const bId = Number(b.id);
  if (Number.isFinite(aId) && Number.isFinite(bId) && aId !== bId) {
    return bId - aId;
  }

  const aTime = Date.parse(a.add_time || '');
  const bTime = Date.parse(b.add_time || '');
  if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
    return bTime - aTime;
  }

  return 0;
}

async function downloadXlsx(config, token, task, dateRange) {
  const response = await requestRaw(config, {
    method: 'GET',
    route: `/index.php?r=/settings/download-center/download-file&id=${encodeURIComponent(String(task.id))}&type=1`,
    token,
  });

  const bytes = Buffer.from(await response.arrayBuffer());
  const headerHex = bytes.subarray(0, 4).toString('hex');
  const contentType = response.headers.get('content-type') || '';

  if (headerHex !== '504b0304') {
    const text = bytes.toString('utf8', 0, Math.min(bytes.length, 500));
    fail(`Download response is not an xlsx file. content-type=${contentType}; body=${text}`);
  }

  await fsp.mkdir(config.downloadDir, { recursive: true });
  const fileName = `after-sale-${config.brand}-complaints-${dateRange.startDate}-${dateRange.endDate}.xlsx`;
  const finalPath = path.join(config.downloadDir, fileName);
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;

  await fsp.writeFile(tmpPath, bytes, { mode: 0o600 });
  await fsp.rm(finalPath, { force: true });
  await fsp.rename(tmpPath, finalPath);

  log('Downloaded xlsx file', {
    taskId: task.id,
    file: finalPath,
    contentType,
    bytes: bytes.length,
  });

  return finalPath;
}

async function requestJson(config, options) {
  const response = await requestRaw(config, options);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (_error) {
    fail(`Expected JSON response from ${options.route}, got: ${text.slice(0, 300)}`);
  }
}

async function requestRaw(config, options) {
  const url = new URL(options.route, `${config.baseUrl}/`);
  const method = options.method || 'GET';
  const headers = {
    Accept: '*/*',
    ...(options.headers || {}),
  };
  let body;

  if (options.token) {
    headers.token = options.token;
  }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  let lastError;
  for (let attempt = 0; attempt <= HTTP_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.status === 401) {
        fail(`HTTP 401 from ${url.pathname}${url.search}`);
      }
      if (response.status >= 500 && attempt < HTTP_RETRIES) {
        await sleep(retryDelayMs(attempt));
        continue;
      }
      if (!response.ok) {
        const text = await response.text();
        fail(`HTTP ${response.status} from ${url.pathname}${url.search}: ${text.slice(0, 300)}`);
      }
      return response;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (error.isUserFacing) {
        throw error;
      }
      if (attempt < HTTP_RETRIES) {
        await sleep(retryDelayMs(attempt));
        continue;
      }
    }
  }

  fail(`Request failed after retries: ${method} ${url.pathname}${url.search}; ${lastError.message}`);
}

function retryDelayMs(attempt) {
  return 1_000 * (attempt + 1);
}

function safeMsg(response) {
  if (!response) {
    return 'empty response';
  }
  if (typeof response.msg === 'string') {
    return response.msg;
  }
  if (typeof response.message === 'string') {
    return response.message;
  }
  return JSON.stringify(response, (_key, value) => {
    if (typeof value === 'string' && value.length > 120) {
      return `${value.slice(0, 117)}...`;
    }
    return value;
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(config) {
  await fsp.mkdir(config.downloadDir, { recursive: true });
  const safeBrand = config.brand.replace(/[^a-zA-Z0-9_-]/g, '_');
  const lockPath = path.join(config.downloadDir, `.new-erp-after-sale-${safeBrand}.lock`);

  try {
    const handle = await fsp.open(lockPath, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({
      pid: process.pid,
      brand: config.brand,
      startedAt: new Date().toISOString(),
    }));
    await handle.close();
    return lockPath;
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }

    const stat = await fsp.stat(lockPath).catch(() => null);
    const stale = stat && Date.now() - stat.mtimeMs > 12 * 60 * 60_000;
    if (stale) {
      await fsp.rm(lockPath, { force: true });
      return acquireLock(config);
    }

    fail(`Lock file exists for brand ${config.brand}: ${lockPath}`);
  }
}

async function releaseLock(lockPath) {
  if (lockPath) {
    await fsp.rm(lockPath, { force: true }).catch(() => {});
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const config = await loadConfig(args);
  const dateRange = buildDateRange(args);
  let lockPath;

  try {
    lockPath = await acquireLock(config);
    log('Starting export', {
      baseUrl: config.baseUrl,
      brand: config.brand,
      start: dateRange.startDateTime,
      end: dateRange.endDateTime,
      downloadDir: config.downloadDir,
    });

    const token = await login(config);
    log('Login succeeded');

    await createExportTask(config, token, dateRange);
    const task = await waitForTask(config, token, dateRange);
    const filePath = await downloadXlsx(config, token, task, dateRange);
    log('Finished', { file: filePath });
  } finally {
    await releaseLock(lockPath);
  }
}

main().catch((error) => {
  const message = error && error.message ? error.message : String(error);
  console.error(`[${new Date().toISOString()}] ERROR ${message}`);
  process.exitCode = 1;
});
