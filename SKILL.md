---
name: new-erp-after-sale-exporter
description: Export New ERP after-sale complaint xlsx files with customer after-sale images by default.
---

# New ERP After-Sale Exporter

Use `new-erp-after-sale-cron.js` for New ERP complaint exports.

## Rules

- Node.js >= 18 only; no npm dependencies.
- Config priority: CLI flags > env vars > config file.
- Token must be sent in HTTP header `token`.
- Do not print password/token.
- Supported brands: `JY`, `YS`, `HX`/`HEX`; use `HX` for ERP `--brand`.
- Complaint filter is `after_type_status=3`.
- Images are exported by default; use `--no-images` to disable.
- If date range is longer than 31 days, images are disabled and the script logs a warning.

## Config

Before a real run, check required config. If `baseUrl`, `username`, `password`, or `downloadDir` is missing, ask the user or tell them to set config/env vars. Never run with placeholder credentials.

Default config: `~/.config/new-erp-after-sale-cron/config.json`

```json
{
  "baseUrl": "https://new-erp.sz-jyhc.com/",
  "username": "<ERP_USERNAME>",
  "password": "<ERP_PASSWORD>",
  "brand": "",
  "downloadDir": "./downloads"
}
```

Env vars: `ERP_BASE_URL`, `ERP_USERNAME`, `ERP_PASSWORD`, `ERP_BRAND`, `ERP_DOWNLOAD_DIR`, `ERP_INCLUDE_IMAGES`, `ERP_EXCLUDE_LOGISTICS`.

## Run

```bash
node --check new-erp-after-sale-cron.js
node new-erp-after-sale-cron.js --help
node new-erp-after-sale-cron.js --brand HX --start-date 2026-06-22 --end-date 2026-06-28
node new-erp-after-sale-cron.js --brand HX --start-date 2026-06-22 --end-date 2026-06-28 --exclude-logistics
node new-erp-after-sale-cron.js --brand HX --start-date 2026-06-22 --end-date 2026-06-28 --no-images
```

## Output

```text
<downloadDir>/
  after-sale-<BRAND|all-brands>-complaints-<START>-<END>/
    after-sale-<BRAND|all-brands>-complaints-<START>-<END>.xlsx
    images/
```

Images are inserted into the same complaints xlsx in a `图片预览` column. Original complaint image files are saved directly under that export folder's `images/` directory. Do not generate separate image xlsx/json/csv files or nested image export folders.
