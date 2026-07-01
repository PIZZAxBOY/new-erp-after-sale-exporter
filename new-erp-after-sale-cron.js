#!/usr/bin/env node
'use strict';

const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const process = require('process');
const crypto = require('crypto');
const zlib = require('zlib');

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.config', 'new-erp-after-sale-cron', 'config.json');
const DEFAULT_MONTHS = 6;
const HTTP_TIMEOUT_MS = 30_000;
const HTTP_RETRIES = 2;
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 10 * 60_000;
const DOWNLOAD_PAGE_SIZE = 100;
const DOWNLOAD_PAGES_TO_CHECK = 3;
const AFTER_SALE_LIST_PAGE_SIZE = 100;
const IMAGE_FIELDS = ['after_sale_img_url', 'img_url', 'quality_img_url'];

function usage() {
  return `
New ERP after-sale complaint export cron script

Usage:
  node new-erp-after-sale-cron.js [options]

Options:
  --brand <BRAND_CODE>        Optional brand code for this run. Omit to export all brands.
  --months <N>                Export up to the previous N months. Default: 6.
  --download-dir <DIR>        Directory for downloaded xlsx files.
  --config <PATH>             Custom config file path.
  --start-date YYYY-MM-DD     Explicit start date for backfill.
  --end-date YYYY-MM-DD       Explicit end date for backfill.
  --include-images            Download ERP after-sale images. This is the default.
  --no-images                 Disable ERP after-sale image export.
  --exclude-logistics         With image export, skip tickets whose reason is 物流投诉.
  --help                      Show this help.

Environment variables:
  ERP_BASE_URL
  ERP_USERNAME
  ERP_PASSWORD
  ERP_BRAND
  ERP_DOWNLOAD_DIR
  ERP_INCLUDE_IMAGES
  ERP_EXCLUDE_LOGISTICS

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
    includeImages: true,
    excludeLogistics: false,
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
    const booleanOptions = new Set([
      '--include-images',
      '--no-images',
      '--exclude-logistics',
    ]);

    if (key === '--help') {
      args.help = true;
      continue;
    }

    if (booleanOptions.has(key)) {
      if (value !== undefined) {
        fail(`${key} does not accept a value`);
      }
      if (key === '--include-images') args.includeImages = true;
      if (key === '--no-images') args.includeImages = false;
      if (key === '--exclude-logistics') args.excludeLogistics = true;
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
    includeImages: firstDefined(args.includeImages ? '1' : '0', process.env.ERP_INCLUDE_IMAGES, fileConfig.includeImages),
    excludeLogistics: firstDefined(args.excludeLogistics ? '1' : undefined, process.env.ERP_EXCLUDE_LOGISTICS, fileConfig.excludeLogistics),
    configPath,
  };

  const missing = [];
  for (const key of ['baseUrl', 'username', 'password', 'downloadDir']) {
    if (!config[key]) {
      missing.push(key);
    }
  }
  if (missing.length > 0) {
    fail(`Missing required configuration: ${missing.join(', ')}`);
  }

  config.baseUrl = String(config.baseUrl).replace(/\/+$/, '');
  config.brand = config.brand ? String(config.brand).trim() : '';
  config.downloadDir = path.resolve(String(config.downloadDir));
  config.includeImages = parseBoolean(config.includeImages);
  config.excludeLogistics = parseBoolean(config.excludeLogistics);

  if (!/^https?:\/\//i.test(config.baseUrl)) {
    fail('baseUrl must start with http:// or https://');
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

function parseBoolean(value) {
  if (value === true || value === false) return value;
  const text = String(value || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(text);
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
    const start = addMonthsClamped(end, -args.months);
    start.setDate(start.getDate() + 1);
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

function dateRangeDays(dateRange) {
  const start = localDateFromString(dateRange.startDate);
  const end = localDateFromString(dateRange.endDate);
  return Math.floor((end - start) / 86_400_000) + 1;
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

function addMonthsClamped(date, monthDelta) {
  const target = new Date(date.getFullYear(), date.getMonth() + monthDelta, 1);
  const targetMonthDays = daysInMonth(target.getFullYear(), target.getMonth());
  target.setDate(Math.min(date.getDate(), targetMonthDays));
  return target;
}

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
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
    after_type_status: '3',
    created_at: dateRange.createdAt,
    search_type: 'transaction_id',
    route: '/customerService/afterSales',
    is_hx_export: '0',
    _t: String(Date.now()),
  });
  if (config.brand) {
    params.set('auction_site', config.brand);
  }

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
  const normalizedBrand = String(brand || '').toLowerCase();
  const startVariants = conditionVariants(dateRange.startDateTime);
  const endVariants = conditionVariants(dateRange.endDateTime);

  return variants.some((variant) => {
    const lower = variant.toLowerCase();
    const hasBrand = normalizedBrand
      ? lower.includes(normalizedBrand)
      : !hasNonEmptyAuctionSite(lower);
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

function hasNonEmptyAuctionSite(lowerCondition) {
  return [
    /auction_site=([^&\s"'{}[\],]+)/,
    /auction_site%3d([^&\s"'{}[\],]+)/,
    /auction_site["']?\s*:\s*["']([^"']+)["']/,
  ].some((pattern) => {
    const match = lowerCondition.match(pattern);
    return match && match[1] && !['null', 'undefined'].includes(match[1]);
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
  const scope = exportScopeLabel(config);
  const folderName = `after-sale-${scope}-complaints-${dateRange.startDate}-${dateRange.endDate}`;
  const outputDir = path.join(config.downloadDir, folderName);
  await fsp.mkdir(outputDir, { recursive: true });
  const fileName = `${folderName}.xlsx`;
  const finalPath = path.join(outputDir, fileName);
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


function splitImageUrls(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value.join(',') : String(value);
  return raw
    .split(/[,，;；\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => !['无', '-', 'null', 'undefined'].includes(item.toLowerCase()));
}

function collectTicketImages(ticket) {
  const imageRows = [];
  const children = Array.isArray(ticket.child) ? ticket.child : [];
  for (const child of children) {
    for (const field of IMAGE_FIELDS) {
      for (const url of splitImageUrls(child[field])) {
        imageRows.push({
          field,
          url,
          sku: child.sku || '',
          childId: child.id || '',
        });
      }
    }
  }
  return imageRows;
}

function normalizeUrl(config, url) {
  if (/^https?:\/\//i.test(url)) return url;
  return new URL(String(url).replace(/^\/+/, ''), `${config.baseUrl}/`).toString();
}

function extFromContentType(type) {
  const lower = String(type || '').toLowerCase();
  if (lower.includes('png')) return '.png';
  if (lower.includes('gif')) return '.gif';
  if (lower.includes('webp')) return '.webp';
  if (lower.includes('bmp')) return '.bmp';
  if (lower.includes('jpeg') || lower.includes('jpg')) return '.jpg';
  return '';
}

function extFromUrl(url) {
  const clean = String(url || '').split('?')[0].split('#')[0];
  const ext = path.extname(clean);
  return ext && ext.length <= 8 ? ext : '';
}

function safePathSegment(value, fallback = 'NA') {
  const text = String(value || '').trim() || fallback;
  return text.replace(/[\\/:*?"<>|\r\n]+/g, '_').replace(/\s+/g, ' ').slice(0, 80);
}

async function fetchAfterSaleTickets(config, token, dateRange) {
  const tickets = [];
  for (let page = 1; page < 500; page += 1) {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(AFTER_SALE_LIST_PAGE_SIZE),
      after_type_status: '3',
      created_at: dateRange.createdAt,
    });
    if (config.brand) params.set('auction_site', config.brand);

    const response = await requestJson(config, {
      method: 'GET',
      route: `/index.php?r=/customerService/after-sale-order/index&${params.toString()}`,
      token,
    });
    const data = response && response.data;
    const list = data && Array.isArray(data.list) ? data.list : [];
    tickets.push(...list);
    const total = Number((data && data.totalCount) || 0);
    if (!list.length || (total && tickets.length >= total)) break;
  }
  return tickets;
}

async function downloadImage(config, token, url, outPath) {
  const response = await requestRaw(config, { method: 'GET', route: url, token });
  const bytes = Buffer.from(await response.arrayBuffer());
  await fsp.writeFile(outPath, bytes, { mode: 0o600 });
  return {
    bytes: bytes.length,
    contentType: response.headers.get('content-type') || '',
  };
}

async function exportAfterSaleImages(config, token, dateRange, xlsxPath) {
  const fetchedTickets = await fetchAfterSaleTickets(config, token, dateRange);
  const tickets = config.excludeLogistics
    ? fetchedTickets.filter((ticket) => String(ticket.reason_type_name || '').trim() !== '物流投诉')
    : fetchedTickets;
  const imageFolder = path.join(path.dirname(xlsxPath), 'images');
  await fsp.rm(imageFolder, { recursive: true, force: true });
  await fsp.mkdir(imageFolder, { recursive: true });

  const imageIndex = [];
  const noImageTickets = [];
  const downloaded = new Map();

  for (const ticket of tickets) {
    const ticketImages = collectTicketImages(ticket);
    const uniqueImages = [];
    const seenUrls = new Set();
    for (const image of ticketImages) {
      const fullUrl = normalizeUrl(config, image.url);
      if (seenUrls.has(fullUrl)) continue;
      seenUrls.add(fullUrl);
      uniqueImages.push({ ...image, fullUrl });
    }

    if (!uniqueImages.length) {
      noImageTickets.push({
        id: ticket.id || '',
        after_sale_no: ticket.after_sale_no || '',
        order_id: ticket.order_id || '',
        transaction_id: ticket.transaction_id || '',
        project: ticket.project || '',
        reason_type_name: ticket.reason_type_name || '',
      });
      continue;
    }

    const ticketDir = path.join(
      imageFolder,
      `${safePathSegment(ticket.after_sale_no || ticket.id)}_${safePathSegment(ticket.project || config.brand || 'ALL')}_${safePathSegment(ticket.order_id)}`,
    );
    await fsp.mkdir(ticketDir, { recursive: true });

    let imageNo = 0;
    for (const image of uniqueImages) {
      imageNo += 1;
      const hash = crypto.createHash('sha1').update(image.fullUrl).digest('hex').slice(0, 12);
      let ext = extFromUrl(image.fullUrl) || '.jpg';
      const baseName = `${String(imageNo).padStart(2, '0')}_${safePathSegment(image.sku)}_${hash}`;
      let outPath = path.join(ticketDir, `${baseName}${ext}`);

      if (downloaded.has(image.fullUrl)) {
        await fsp.copyFile(downloaded.get(image.fullUrl), outPath);
      } else {
        const result = await downloadImage(config, token, image.fullUrl, outPath);
        const detected = extFromContentType(result.contentType);
        if (!extFromUrl(image.fullUrl) && detected && detected !== ext) {
          const renamed = path.join(ticketDir, `${baseName}${detected}`);
          await fsp.rename(outPath, renamed);
          outPath = renamed;
          ext = detected;
        }
        downloaded.set(image.fullUrl, outPath);
      }

      imageIndex.push({
        id: ticket.id || '',
        after_sale_no: ticket.after_sale_no || '',
        order_id: ticket.order_id || '',
        transaction_id: ticket.transaction_id || '',
        project: ticket.project || '',
        reason_type_name: ticket.reason_type_name || '',
        sku: image.sku,
        child_id: image.childId,
        image_no: imageNo,
        image_field: image.field,
        image_path: outPath,
        image_url: image.fullUrl,
      });
    }
  }

  await insertImagesIntoComplaintXlsx(xlsxPath, imageIndex);

  log('Downloaded after-sale images', {
    updatedXlsx: xlsxPath,
    imageFolder,
    ticketsFetched: fetchedTickets.length,
    ticketsAfterFilter: tickets.length,
    ticketsWithImages: new Set(imageIndex.map((row) => row.id || row.after_sale_no)).size,
    images: imageIndex.length,
    ticketsWithoutImages: noImageTickets.length,
    dedupe: 'same ticket + same image URL',
  });
  return imageFolder;
}

function relativeImagePath(xlsxPath, imagePath) {
  if (!imagePath) return '';
  return path.relative(path.dirname(xlsxPath), imagePath).split(path.sep).join('/');
}

function ticketKeyFromValues(orderId, transactionId, project) {
  return `${project || ''}|${orderId || ''}|${transactionId || ''}`;
}

async function insertImagesIntoComplaintXlsx(filePath, imageIndex) {
  const parsed = await readFirstWorksheet(filePath);
  const rows = parsed.objects.map((row) => ({ ...row }));
  const byKey = new Map();
  for (const image of imageIndex) {
    const key = ticketKeyFromValues(image.order_id, image.transaction_id, image.project);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(image);
  }

  const imageEntries = [];
  const outputRows = rows.map((row, index) => {
    const key = ticketKeyFromValues(row['系统单号'], row['交易号'], row['项目']);
    const images = byKey.get(key) || [];
    const imagePaths = images
      .map((image) => relativeImagePath(filePath, image.image_path))
      .filter(Boolean)
      .join('；');
    const output = { ...row, 图片地址: imagePaths, 图片预览: '' };
    if (images.length && images[0].image_path) {
      imageEntries.push({
        row: index + 2,
        colName: '图片预览',
        imagePath: images[0].image_path,
      });
    }
    return output;
  });

  await writeRowsWithImagesXlsx(filePath, outputRows, imageEntries, 'complaints');
}

async function readFirstWorksheet(filePath) {
  const entries = readZipEntries(await fsp.readFile(filePath));
  const workbook = entries.get('xl/workbook.xml').toString('utf8');
  const firstSheetMatch = workbook.match(/<sheet\b[^>]*r:id="([^"]+)"/);
  if (!firstSheetMatch) fail(`Cannot find first worksheet in ${filePath}`);
  const rels = entries.get('xl/_rels/workbook.xml.rels').toString('utf8');
  const relPattern = new RegExp(`<Relationship[^>]*Id="${escapeRegExp(firstSheetMatch[1])}"[^>]*Target="([^"]+)"`);
  const relMatch = rels.match(relPattern);
  const sheetPath = relMatch ? `xl/${relMatch[1].replace(/^\/+/, '')}` : 'xl/worksheets/sheet1.xml';
  const sheetXml = entries.get(sheetPath).toString('utf8');
  const sharedStrings = entries.has('xl/sharedStrings.xml')
    ? parseSharedStrings(entries.get('xl/sharedStrings.xml').toString('utf8'))
    : [];
  const matrix = parseWorksheetMatrix(sheetXml, sharedStrings);
  const headers = matrix[0] || [];
  const objects = matrix.slice(1).filter((row) => row.some((value) => value !== '')).map((row) => {
    const object = {};
    headers.forEach((header, index) => {
      object[header || `Column${index + 1}`] = row[index] || '';
    });
    return object;
  });
  return { headers, objects };
}

function parseSharedStrings(xml) {
  const result = [];
  for (const match of xml.matchAll(/<si[\s\S]*?<\/si>/g)) {
    const text = Array.from(match[0].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g))
      .map((part) => xmlUnescape(part[1]))
      .join('');
    result.push(text);
  }
  return result;
}

function parseWorksheetMatrix(xml, sharedStrings) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const rowIndex = Number(rowMatch[1]);
    const values = [];
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1];
      const body = cellMatch[2];
      const ref = (attrs.match(/r="([A-Z]+)\d+"/) || [])[1];
      if (!ref) continue;
      const col = columnNumber(ref);
      const type = (attrs.match(/t="([^"]+)"/) || [])[1];
      let value = '';
      if (type === 'inlineStr') {
        value = Array.from(body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)).map((part) => xmlUnescape(part[1])).join('');
      } else {
        const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        if (v !== undefined) {
          value = type === 's' ? (sharedStrings[Number(v)] || '') : xmlUnescape(v);
        }
      }
      values[col - 1] = value;
    }
    rows[rowIndex - 1] = values.map((value) => value === undefined ? '' : value);
  }
  return rows.filter(Boolean);
}

function columnNumber(name) {
  let number = 0;
  for (const char of name) {
    number = number * 26 + char.charCodeAt(0) - 64;
  }
  return number;
}

function xmlUnescape(value) {
  return String(value || '')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readZipEntries(buffer) {
  const eocdOffset = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdOffset < 0) fail('Invalid xlsx: EOCD not found');
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = new Map();
  let offset = centralOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) fail('Invalid xlsx: central directory is corrupt');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + fileNameLength).toString('utf8');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    let data;
    if (method === 0) data = compressed;
    else if (method === 8) data = zlib.inflateRawSync(compressed);
    else fail(`Unsupported xlsx compression method ${method} for ${name}`);
    entries.set(name, data);
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

async function writeRowsWithImagesXlsx(filePath, rows, imageEntries, sheetName) {
  const matrix = rowsToMatrix(rows);
  const headers = matrix[0];
  const colByName = new Map(headers.map((header, index) => [header, index + 1]));
  const files = new Map();
  const drawingEntries = [];
  const mediaExtensions = [];

  for (const entry of imageEntries) {
    const col = colByName.get(entry.colName);
    if (!col || !entry.imagePath) continue;
    let bytes;
    try {
      bytes = await fsp.readFile(entry.imagePath);
    } catch (_error) {
      continue;
    }
    const ext = (extFromUrl(entry.imagePath) || '.jpg').replace(/^\./, '').toLowerCase();
    const mediaPath = `xl/media/image${drawingEntries.length + 1}.${ext}`;
    files.set(mediaPath, bytes);
    mediaExtensions.push(ext);
    drawingEntries.push({
      row: entry.row,
      col,
      relId: `rId${drawingEntries.length + 1}`,
      mediaPath,
    });
  }

  const sheets = [{ name: safeSheetName(sheetName || 'complaints') }];
  files.set('[Content_Types].xml', contentTypesXml(1, mediaExtensions));
  files.set('_rels/.rels', rootRelsXml());
  files.set('xl/workbook.xml', workbookXml(sheets));
  files.set('xl/_rels/workbook.xml.rels', workbookRelsXml(1));
  files.set('xl/styles.xml', stylesXml());
  files.set('xl/worksheets/sheet1.xml', worksheetXml(matrix, {
    drawingRelId: drawingEntries.length ? 'rId1' : undefined,
    imageRows: new Set(drawingEntries.map((entry) => entry.row)),
  }));
  if (drawingEntries.length) {
    files.set('xl/worksheets/_rels/sheet1.xml.rels', sheetDrawingRelsXml());
    files.set('xl/drawings/drawing1.xml', drawingXml(drawingEntries));
    files.set('xl/drawings/_rels/drawing1.xml.rels', drawingRelsXml(drawingEntries));
  }
  await fsp.writeFile(filePath, buildZip(files), { mode: 0o600 });
}

function sheetDrawingRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`;
}

function drawingXml(entries) {
  const anchors = entries.map((entry, index) => {
    const col = entry.col - 1;
    const row = entry.row - 1;
    const id = index + 1;
    return `<xdr:oneCellAnchor><xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="1524000" cy="1047750"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${id}" name="Image ${id}"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="${entry.relId}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors}</xdr:wsDr>`;
}

function drawingRelsXml(entries) {
  const rels = entries.map((entry) => `<Relationship Id="${entry.relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${path.basename(entry.mediaPath)}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;
}

function rowsToMatrix(rows) {
  if (!rows.length) return [['说明'], ['无']];
  const headers = Object.keys(rows[0]);
  const matrix = [headers];
  for (const row of rows) {
    matrix.push(headers.map((header) => row[header]));
  }
  return matrix;
}

function safeSheetName(value) {
  const cleaned = String(value || 'Sheet').replace(/[\\/?*:[\]]/g, ' ').trim() || 'Sheet';
  return cleaned.slice(0, 31);
}

function contentTypesXml(sheetCount, mediaExtensions = []) {
  const mediaDefaults = Array.from(new Set(mediaExtensions.map((ext) => ext.replace(/^\./, '').toLowerCase()).filter(Boolean)))
    .map((ext) => `<Default Extension="${xmlEscape(ext)}" ContentType="${imageContentType(ext)}"/>`)
    .join('');
  const sheetOverrides = Array.from({ length: sheetCount }, (_, index) => (
    `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  )).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${mediaDefaults}<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheetOverrides}</Types>`;
}

function imageContentType(ext) {
  const lower = String(ext || '').replace(/^\./, '').toLowerCase();
  if (lower === 'png') return 'image/png';
  if (lower === 'gif') return 'image/gif';
  if (lower === 'bmp') return 'image/bmp';
  if (lower === 'webp') return 'image/webp';
  return 'image/jpeg';
}

function rootRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
}

function workbookXml(sheets) {
  const sheetXml = sheets.map((sheet, index) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetXml}</sheets></workbook>`;
}

function workbookRelsXml(sheetCount, drawingCount = 0) {
  const rels = Array.from({ length: sheetCount }, (_, index) => (
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
  ));
  rels.push(`<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`);
  for (let index = 0; index < drawingCount; index += 1) {
    rels.push(`<Relationship Id="rId${sheetCount + 2 + index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="drawings/drawing${index + 1}.xml"/>`);
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`;
}

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9EAF7"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
}

function worksheetXml(rows, options = {}) {
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const cols = Array.from({ length: columnCount }, (_, index) => {
    const width = Math.min(60, Math.max(12, rows.slice(0, 80).reduce((max, row) => Math.max(max, String(row[index] ?? '').length), 0) + 2));
    return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`;
  }).join('');
  const rowXml = rows.map((row, rowIndex) => {
    const cells = row.map((value, colIndex) => cellXml(value, rowIndex + 1, colIndex + 1, rowIndex === 0)).join('');
    const height = options.imageRows && options.imageRows.has(rowIndex + 1) ? ' ht="95" customHeight="1"' : '';
    return `<row r="${rowIndex + 1}"${height}>${cells}</row>`;
  }).join('');
  const ref = columnCount ? `A1:${columnName(columnCount)}${Math.max(rows.length, 1)}` : 'A1:A1';
  const drawing = options.drawingRelId ? `<drawing r:id="${options.drawingRelId}"/>` : '';
  const relNs = options.drawingRelId ? ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"${relNs}><dimension ref="${ref}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${rowXml}</sheetData><autoFilter ref="${ref}"/>${drawing}</worksheet>`;
}

function cellXml(value, row, col, isHeader) {
  const ref = `${columnName(col)}${row}`;
  const style = isHeader ? ' s="1"' : '';
  if (value === undefined || value === null || value === '') {
    return `<c r="${ref}"${style}/>`;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"${style}><v>${value}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"${style}><is><t>${xmlEscape(String(value))}</t></is></c>`;
}

function columnName(index) {
  let name = '';
  let n = index;
  while (n > 0) {
    const remainder = (n - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function buildZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, content] of files.entries()) {
    const nameBuffer = Buffer.from(name, 'utf8');
    const dataBuffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const crc = crc32(dataBuffer);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(dataBuffer.length, 18);
    localHeader.writeUInt32LE(dataBuffer.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBuffer, dataBuffer);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(dataBuffer.length, 20);
    centralHeader.writeUInt32LE(dataBuffer.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuffer);
    offset += localHeader.length + nameBuffer.length + dataBuffer.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const localData = Buffer.concat(localParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localData.length, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([localData, centralDirectory, end]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = (() => {
  const table = new Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

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
  const safeScope = exportScopeLabel(config).replace(/[^a-zA-Z0-9_-]/g, '_');
  const lockPath = path.join(config.downloadDir, `.new-erp-after-sale-${safeScope}.lock`);

  try {
    const handle = await fsp.open(lockPath, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({
      pid: process.pid,
      brand: config.brand || null,
      scope: exportScopeLabel(config),
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

    fail(`Lock file exists for export scope ${exportScopeLabel(config)}: ${lockPath}`);
  }
}

function exportScopeLabel(config) {
  return config.brand || 'all-brands';
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
  const days = dateRangeDays(dateRange);
  if (config.includeImages && days > 31) {
    log('Image export disabled because the selected date range is longer than one month', {
      start: dateRange.startDate,
      end: dateRange.endDate,
      days,
    });
    config.includeImages = false;
  }
  let lockPath;

  try {
    lockPath = await acquireLock(config);
    log('Starting export', {
      baseUrl: config.baseUrl,
      brand: config.brand || 'ALL',
      start: dateRange.startDateTime,
      end: dateRange.endDateTime,
      downloadDir: config.downloadDir,
      includeImages: config.includeImages,
      excludeLogistics: config.excludeLogistics,
    });

    const token = await login(config);
    log('Login succeeded');

    await createExportTask(config, token, dateRange);
    const task = await waitForTask(config, token, dateRange);
    const filePath = await downloadXlsx(config, token, task, dateRange);
    let imageFolder;
    if (config.includeImages) {
      imageFolder = await exportAfterSaleImages(config, token, dateRange, filePath);
    }
    log('Finished', { file: filePath, imageFolder });
  } finally {
    await releaseLock(lockPath);
  }
}

if (require.main === module) {
  main().catch((error) => {
    const message = error && error.message ? error.message : String(error);
    console.error(`[${new Date().toISOString()}] ERROR ${message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildDateRange,
  parseArgs,
  splitImageUrls,
  collectTicketImages,
  insertImagesIntoComplaintXlsx,
};
