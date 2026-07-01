---
name: new-erp-after-sale-exporter
description: Export New ERP after-sale complaint xlsx files with customer after-sale images by default.
---

# New ERP 售后客诉导出

使用 `new-erp-after-sale-cron.js` 导出 New ERP 售后客诉数据。

## 规则

- Node.js >= 18，无 npm 依赖。
- 真实运行前必须确认 `baseUrl`、`username`、`password`、`downloadDir` 已配置。
- 配置优先级：命令行参数 > 环境变量 > 配置文件。
- `baseUrl`、`username`、`password` 没有命令行参数，走环境变量或配置文件。
- 登录后把 token 放在 HTTP header `token` 中。
- 不打印密码或 token。
- 支持品牌：`JY`、`YS`、`HX` / `HEX`；请求 ERP 时使用 `HX`。
- 客诉筛选条件是 `after_type_status=3`，不要替换成 `status=3`。
- 默认导出图片；需要关闭时使用 `--no-images`。
- 日期范围超过 31 天时，图片导出会自动关闭并打印提示。

## 配置

默认配置文件：

```text
~/.config/new-erp-after-sale-cron/config.json
```

```json
{
  "baseUrl": "https://new-erp.sz-jyhc.com/",
  "username": "<ERP_USERNAME>",
  "password": "<ERP_PASSWORD>",
  "brand": "",
  "downloadDir": "./downloads"
}
```

常用环境变量：`ERP_BASE_URL`、`ERP_USERNAME`、`ERP_PASSWORD`、`ERP_BRAND`、`ERP_DOWNLOAD_DIR`、`ERP_EXCLUDE_LOGISTICS`。

## 运行

```bash
node --check new-erp-after-sale-cron.js
node new-erp-after-sale-cron.js --help
node new-erp-after-sale-cron.js --brand HX --start-date 2026-06-22 --end-date 2026-06-28
node new-erp-after-sale-cron.js --brand HX --start-date 2026-06-22 --end-date 2026-06-28 --exclude-logistics
node new-erp-after-sale-cron.js --brand HX --start-date 2026-06-22 --end-date 2026-06-28 --no-images
```

## 输出

```text
<downloadDir>/
  after-sale-<BRAND|all-brands>-complaints-<START>-<END>/
    after-sale-<BRAND|all-brands>-complaints-<START>-<END>.xlsx
    images/
```

图片会插入同一份客诉 `.xlsx`：

- `图片地址`：`images/` 下的相对路径。
- `图片预览`：插入第一张预览图。

不要生成额外的图片索引 `.xlsx`、`.json`、`.csv` 或嵌套图片导出目录。
