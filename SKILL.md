---
name: new-erp-after-sale-exporter
description: Use when Codex needs to configure, run, verify, or adapt the New ERP after-sale complaint export script for https://new-erp.sz-jyhc.com/. This covers exporting complaint/customer-complaint after-sale tickets by brand, backfilling date ranges, troubleshooting login/export/download failures, and producing xlsx files without npm dependencies or browser cookies.
---

# New ERP After-Sale Exporter

Use the bundled `new-erp-after-sale-cron.js` script to export New ERP after-sale complaint tickets by brand and download the completed export as an `.xlsx` file.

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
- Default brand code, such as `YS`, `JY`, or `HX`
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
  "brand": "<BRAND_CODE>",
  "downloadDir": "./downloads"
}
```

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

## Running

Validate syntax and help first:

```bash
node --check new-erp-after-sale-cron.js
node new-erp-after-sale-cron.js --help
```

Run a normal export:

```bash
node new-erp-after-sale-cron.js --brand YS --months 6
```

Run a backfill:

```bash
node new-erp-after-sale-cron.js --brand YS --start-date 2026-01-01 --end-date 2026-06-30
```

Use `--start-date` and `--end-date` ahead of `--months` when explicit date ranges are supplied.

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
auction_site=<BRAND_CODE>
after_type_status=3
created_at=YYYY-MM-DD 00:00:00 & YYYY-MM-DD 23:59:59
search_type=transaction_id
route=/customerService/afterSales
is_hx_export=0
_t=<Date.now()>
```

Use `URLSearchParams` for export params so the `&` inside `created_at` is encoded as `%26`.

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
- `add_condition` contains the current brand, `after_type_status=3`, and the selected date range

Check both raw `add_condition` and `decodeURIComponent(add_condition)`. Accept `after_type_status` as raw, JSON-like, or URL-encoded forms. Accept `created_at` with either `&` or `%26`. If multiple tasks match, select the newest by largest `id`, then latest `add_time`.

Download endpoint:

```text
GET /index.php?r=/settings/download-center/download-file&id=<TASK_ID>&type=1
```

Validate the downloaded bytes begin with hex `504b0304` before writing the final file.

## Output

Use this filename:

```text
after-sale-<BRAND_CODE>-complaints-<YYYY-MM-DD>-<YYYY-MM-DD>.xlsx
```

Write to a `.tmp` file first, validate, then rename to the final path.

## Troubleshooting

- Missing config: report the missing keys and exit non-zero.
- Login failure or HTTP 401: do not retry blindly; ask the user to verify credentials and permissions.
- Download task timeout: mention the 10-minute polling window and suggest checking the ERP download center.
- Non-xlsx download: summarize the JSON/error body without leaking credentials.
