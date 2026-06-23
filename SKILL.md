---
name: new-erp-after-sale-exporter
description: Use when Codex needs to configure, run, verify, or adapt the New ERP after-sale complaint export script for https://new-erp.sz-jyhc.com/. This covers exporting complaint/customer-complaint after-sale tickets for all brands by default, optionally filtering by brand, backfilling date ranges, troubleshooting login/export/download failures, and producing xlsx files without npm dependencies or browser cookies.
---

# New ERP After-Sale Exporter

Use the bundled `new-erp-after-sale-cron.js` script to export New ERP after-sale complaint tickets and download the completed export as an `.xlsx` file. Default to all brands; filter by brand only when the user asks for a specific brand.

## Core Rules

- Keep the script non-interactive. Do not add `readline`, prompts, browser-cookie flows, copied tokens, or external CLI dependencies.
- Use Node.js >= 18 and native `fetch`.
- Do not print `password`, `token`, or full sensitive config values.
- Keep `baseUrl` as `https://new-erp.sz-jyhc.com/` unless the user explicitly provides another ERP host.
- Preserve configuration priority: command line flags, then environment variables, then config file.

## Configuration

Before the first real run, collect these values from the user:

- ERP username
- ERP password
- Optional brand code, such as `YS`, `JY`, or `HX`; leave unset to include all brands
- Download directory

Create the config file before running the exporter. Never proceed to a real export with placeholder credentials, and never print the password back to the user.

Use this default config path:

```text
~/.config/new-erp-after-sale-cron/config.json
```

Use this config shape:

```json
{
  "baseUrl": "https://new-erp.sz-jyhc.com/",
  "username": "<ERP_USERNAME>",
  "password": "<ERP_PASSWORD>",
  "brand": "",
  "downloadDir": "./downloads"
}
```

`brand` is optional. Leave it empty or omit it to export all brands.

Set permissions when creating config on Unix-like systems:

```bash
mkdir -p ~/.config/new-erp-after-sale-cron
chmod 700 ~/.config/new-erp-after-sale-cron
chmod 600 ~/.config/new-erp-after-sale-cron/config.json
```

Support these environment variables:

```text
ERP_BASE_URL
ERP_USERNAME
ERP_PASSWORD
ERP_BRAND
ERP_DOWNLOAD_DIR
```

`ERP_BRAND` is optional. Leave it unset to export all brands.

## Running

Validate syntax and help first:

```bash
node --check new-erp-after-sale-cron.js
node new-erp-after-sale-cron.js --help
```

Run the first real smoke test with a short range:

```bash
node new-erp-after-sale-cron.js --months 1
```

Use a longer range, such as `--months 6`, only after the login, export-task creation, download-center matching, and xlsx download path have been verified.

Run a backfill:

```bash
node new-erp-after-sale-cron.js --brand YS --start-date 2026-01-01 --end-date 2026-06-30
```

Pass `--brand` only when the user wants a single-brand export.

Use `--start-date` and `--end-date` ahead of `--months` when explicit date ranges are supplied.
For generated month ranges, keep the start date one day inside the boundary. For example, a 6-month run ending on `2026-06-23` should start at `2025-12-24 00:00:00`, not `2025-12-23 00:00:00`, because ERP rejects inclusive ranges that it considers over half a year.

## ERP Contract

Login endpoint:

```text
POST /index.php?r=/user/check-login
```

Login body:

```json
{
  "username": "<ERP_USERNAME>",
  "password": "<ERP_PASSWORD>"
}
```

Read the token from `response.data.token`. Send it on later requests as:

```text
token: <TOKEN>
```

Do not replace this with `Authorization`, `Bearer`, `X-Token`, or a query parameter.

Create the export task with the after-sale order export endpoint:

```text
GET /index.php?r=/customerService/after-sale-order/after-sale-export
```

Required params:

```text
after_type_status=3
created_at=YYYY-MM-DD 00:00:00 & YYYY-MM-DD 23:59:59
search_type=transaction_id
route=/customerService/afterSales
is_hx_export=0
_t=<Date.now()>
```

Use `URLSearchParams` for export params so the `&` inside `created_at` is encoded as `%26`.
Only include `auction_site=<BRAND_CODE>` when a brand filter is requested. Omit `auction_site` for the default all-brand export.

Treat `已存在下载任务，请勿重复操作` as non-fatal. Continue to download-center matching.

## Download Matching

Poll:

```text
GET /index.php?r=/settings/download-center/index&page=<PAGE>&pageSize=100
```

Check at least the first 3 pages with `pageSize=100`. A ready task must match:

- `title = 客服-售后工单-导出`
- `route_url = customerService/after-sale-order/after-sale-export`
- `String(status) === "3"`
- `down_file` is non-empty
- `add_condition` contains `after_type_status=3` and the selected date range
- when filtering by brand, `add_condition` contains the current brand
- when exporting all brands, `add_condition` does not contain a non-empty `auction_site` filter

Check both raw `add_condition` and `decodeURIComponent(add_condition)`. Accept `after_type_status` as raw, JSON-like, or URL-encoded forms. Accept `created_at` with either `&` or `%26`. If multiple tasks match, select the newest by largest `id`, then latest `add_time`.

Download endpoint:

```text
GET /index.php?r=/settings/download-center/download-file&id=<TASK_ID>&type=1
```

Validate the downloaded bytes begin with hex `504b0304` before writing the final file.

## Output

Use this filename:

```text
after-sale-<BRAND_CODE|all-brands>-complaints-<YYYY-MM-DD>-<YYYY-MM-DD>.xlsx
```

Write to a `.tmp` file first, validate, then rename to the final path.

## Troubleshooting

- Missing config: report the missing keys and exit non-zero.
- Login failure or HTTP 401: do not retry blindly; ask the user to verify credentials and permissions.
- Download task timeout: mention the 10-minute polling window and suggest checking the ERP download center.
- Non-xlsx download: summarize the JSON/error body without leaking credentials.
