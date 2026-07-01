# New ERP After-Sale Complaint Exporter

Pure Node.js script for exporting New ERP after-sale complaint tickets and downloading the result as an `.xlsx` file. By default it exports all brands; pass `--brand` only when a single brand is needed.

ERP base URL:

```text
https://new-erp.sz-jyhc.com/
```

## Files

```text
new-erp-after-sale-cron.js  Main Node.js script
SKILL.md                   Codex skill instructions for using the script
README.md                  Human-facing usage notes
```

## Requirements

- Node.js >= 18
- No npm dependencies
- Uses Node native `fetch`, `fs`, `path`, `os`, and `process`
- Does not require browser cookies, copied tokens, or external CLI tools

## Configuration

Before a real run, make sure `baseUrl`, `username`, `password`, and `downloadDir` are configured. If any required value is missing, ask the user for it or set it through config/env vars; do not run with placeholder credentials.

Configuration priority:

```text
command line flags > environment variables > config file
```

Default config file:

```text
~/.config/new-erp-after-sale-cron/config.json
```

Example:

```json
{
  "baseUrl": "https://new-erp.sz-jyhc.com/",
  "username": "<ERP_USERNAME>",
  "password": "<ERP_PASSWORD>",
  "brand": "",
  "downloadDir": "./downloads"
}
```

`brand` is optional. Leave it empty or omit it to include all brands. Supported brand codes are `JY`, `YS`, and `HX`/`HEX`; use `HX` for the ERP `--brand` parameter, while `HEX` can be used as the display name.

Recommended permissions:

```bash
chmod 700 ~/.config/new-erp-after-sale-cron
chmod 600 ~/.config/new-erp-after-sale-cron/config.json
```

Environment variables:

```text
ERP_BASE_URL
ERP_USERNAME
ERP_PASSWORD
ERP_BRAND
ERP_DOWNLOAD_DIR
ERP_INCLUDE_IMAGES
ERP_EXCLUDE_LOGISTICS
```

`ERP_BRAND` is optional. Leave it unset to include all brands. Supported values are `JY`, `YS`, and `HX`/`HEX`; use `HX` for ERP requests. Image export is on by default; set `ERP_INCLUDE_IMAGES=0` or pass `--no-images` to disable it. Set `ERP_EXCLUDE_LOGISTICS=1` to skip tickets whose售后原因 is `物流投诉` when downloading images.

## Usage

```bash
node new-erp-after-sale-cron.js
node new-erp-after-sale-cron.js --brand YS
node new-erp-after-sale-cron.js --brand HX --months 3 --download-dir ./exports
node new-erp-after-sale-cron.js --config ./config.json --brand JY
node new-erp-after-sale-cron.js --brand YS --start-date 2026-01-01 --end-date 2026-06-30
node new-erp-after-sale-cron.js --brand JY --start-date 2026-06-22 --end-date 2026-06-28 --exclude-logistics
node new-erp-after-sale-cron.js --brand JY --start-date 2026-06-22 --end-date 2026-06-28 --no-images
```

Supported flags:

```text
--brand <BRAND_CODE>        Optional brand code for this run; omit for all brands
--months <N>                Up to previous N months, default 6
--download-dir <DIR>        Download directory for this run
--config <PATH>             Custom config file path
--start-date YYYY-MM-DD     Explicit start date for backfill
--end-date YYYY-MM-DD       Explicit end date for backfill
--include-images            Download ERP after-sale images; enabled by default
--no-images                 Disable ERP after-sale image export
--exclude-logistics         With image export, skip tickets whose reason is 物流投诉
--help                      Show help
```

When `--start-date` or `--end-date` is provided, date flags take priority over `--months`.
For generated month ranges, the start date is moved one day inside the boundary. For example, a 6-month run ending on `2026-06-23` starts at `2025-12-24 00:00:00`, avoiding ERP's "超过半年无法导出" limit.

## Output

File naming rule:

```text
<downloadDir>/
  after-sale-<BRAND_CODE|all-brands>-complaints-<YYYY-MM-DD>-<YYYY-MM-DD>/
    after-sale-<BRAND_CODE|all-brands>-complaints-<YYYY-MM-DD>-<YYYY-MM-DD>.xlsx
```

The script validates the downloaded file header as `504b0304` before writing the final `.xlsx`. It writes a temporary file first and then renames it to avoid partial files.

Images are enabled by default. When enabled, the script inserts image previews into the same complaints xlsx in a `图片预览` column and writes relative image paths in a `图片地址` column. Original downloaded image files are kept directly under the same export folder:

```text
<downloadDir>/
  after-sale-<BRAND_CODE|all-brands>-complaints-<YYYY-MM-DD>-<YYYY-MM-DD>/
    images/
```

No separate image index/preview xlsx/json/csv files or nested image export folders are generated. If the selected date range is longer than 31 days, the script disables image export and logs a warning.

## Validation

```bash
node --check new-erp-after-sale-cron.js
node new-erp-after-sale-cron.js --help
```

Run a real smoke test only when valid ERP credentials and network access are available. Start with a short range so the first run finishes quickly:

```bash
node new-erp-after-sale-cron.js --months 1
```

After the first run verifies login, export creation, download-center matching, and xlsx download, increase the range as needed.

## Notes

- Logs must not print passwords or tokens.
- `after_type_status=3` means complaint after-sale type. Do not replace it with `status=3`.
- Business requests must send the token in the HTTP header named `token`.
- The export flow uses the after-sale order export endpoint, then polls download center pages for a completed matching task.
