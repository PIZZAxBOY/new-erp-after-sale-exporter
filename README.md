# New ERP After-Sale Complaint Exporter

Pure Node.js script for exporting New ERP after-sale complaint tickets by brand and downloading the result as an `.xlsx` file.

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
  "brand": "<BRAND_CODE>",
  "downloadDir": "./downloads"
}
```

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
```

## Usage

```bash
node new-erp-after-sale-cron.js --brand YS
node new-erp-after-sale-cron.js --brand HX --months 3 --download-dir ./exports
node new-erp-after-sale-cron.js --config ./config.json --brand JY
node new-erp-after-sale-cron.js --brand YS --start-date 2026-01-01 --end-date 2026-06-30
```

Supported flags:

```text
--brand <BRAND_CODE>        Brand code for this run
--months <N>                Previous N months, default 6
--download-dir <DIR>        Download directory for this run
--config <PATH>             Custom config file path
--start-date YYYY-MM-DD     Explicit start date for backfill
--end-date YYYY-MM-DD       Explicit end date for backfill
--help                      Show help
```

When `--start-date` or `--end-date` is provided, date flags take priority over `--months`.

## Output

File naming rule:

```text
after-sale-<BRAND_CODE>-complaints-<YYYY-MM-DD>-<YYYY-MM-DD>.xlsx
```

The script validates the downloaded file header as `504b0304` before writing the final `.xlsx`. It writes a temporary file first and then renames it to avoid partial files.

## Validation

```bash
node --check new-erp-after-sale-cron.js
node new-erp-after-sale-cron.js --help
```

Run a real smoke test only when valid ERP credentials and network access are available:

```bash
node new-erp-after-sale-cron.js --brand <BRAND_CODE> --months 6
```

## Notes

- Logs must not print passwords or tokens.
- `after_type_status=3` means complaint after-sale type. Do not replace it with `status=3`.
- Business requests must send the token in the HTTP header named `token`.
- The export flow uses the after-sale order export endpoint, then polls download center pages for a completed matching task.
