# New ERP 售后客诉导出工具

用于导出 New ERP 售后客诉数据，生成 `.xlsx` 文件。默认导出全部品牌；只有需要单独导出某个品牌时，才传入 `--brand`。

默认开启售后图片导出：图片会写入同一个导出目录，并插入到同一个 `.xlsx` 文件的 `图片预览` 列。

## 文件

```text
new-erp-after-sale-cron.js  主脚本
SKILL.md                   Agent 使用规则
README.md                  使用说明
```

## 运行要求

- Node.js >= 18
- 无 npm 依赖
- 不需要浏览器 Cookie、手动复制 token 或外部 CLI

## 配置

真实运行前，需要配置以下字段：

- `baseUrl`
- `username`
- `password`
- `downloadDir`

默认配置文件：

```text
~/.config/new-erp-after-sale-cron/config.json
```

示例：

```json
{
  "baseUrl": "https://new-erp.sz-jyhc.com/",
  "username": "<ERP_USERNAME>",
  "password": "<ERP_PASSWORD>",
  "brand": "",
  "downloadDir": "./downloads"
}
```

建议权限：

```bash
chmod 700 ~/.config/new-erp-after-sale-cron
chmod 600 ~/.config/new-erp-after-sale-cron/config.json
```

配置优先级：

```text
命令行参数 > 环境变量 > 配置文件
```

说明：`baseUrl`、`username`、`password` 当前没有命令行参数，建议通过环境变量或配置文件设置。

常用环境变量：

```text
ERP_BASE_URL
ERP_USERNAME
ERP_PASSWORD
ERP_BRAND
ERP_DOWNLOAD_DIR
ERP_EXCLUDE_LOGISTICS
```

`brand` / `ERP_BRAND` 可留空，表示导出全部品牌。支持 `JY`、`YS`、`HX` / `HEX`；请求 ERP 时使用 `HX`。

## 用法

```bash
# 导出全部品牌，默认最近 6 个月
node new-erp-after-sale-cron.js

# 导出单个品牌
node new-erp-after-sale-cron.js --brand YS

# 指定日期范围
node new-erp-after-sale-cron.js --brand HX --start-date 2026-06-22 --end-date 2026-06-28

# 图片导出时跳过物流投诉
node new-erp-after-sale-cron.js --brand JY --start-date 2026-06-22 --end-date 2026-06-28 --exclude-logistics

# 不下载图片，只导出客诉表格
node new-erp-after-sale-cron.js --brand JY --start-date 2026-06-22 --end-date 2026-06-28 --no-images
```

支持参数：

```text
--brand <BRAND_CODE>        品牌代码；不传则导出全部品牌
--months <N>                导出最近 N 个月，默认 6
--download-dir <DIR>        下载目录
--config <PATH>             自定义配置文件路径
--start-date YYYY-MM-DD     开始日期
--end-date YYYY-MM-DD       结束日期
--include-images            下载售后图片，默认开启
--no-images                 关闭售后图片导出
--exclude-logistics         图片导出时跳过售后原因为「物流投诉」的记录
--help                      查看帮助
```

如果传入 `--start-date` 或 `--end-date`，日期参数优先于 `--months`。

如果日期范围超过 31 天，脚本会自动关闭图片导出并打印提示，避免图片任务过大。

## 输出

默认输出结构：

```text
<downloadDir>/
  after-sale-<BRAND_CODE|all-brands>-complaints-<START>-<END>/
    after-sale-<BRAND_CODE|all-brands>-complaints-<START>-<END>.xlsx
    images/
```

说明：

- `.xlsx` 会包含 `图片地址` 和 `图片预览` 列。
- `图片地址` 使用相对路径，例如 `images/<ticket-folder>/<file>.jpg`。
- `图片预览` 插入同一份 `.xlsx`，不会额外生成图片索引表。
- 使用 `--no-images` 时，只生成 `.xlsx`，不生成 `images/` 目录。

脚本会先校验下载结果是否为 `.xlsx` 文件，再写入临时文件并重命名，避免留下不完整文件。

## 校验

```bash
node --check new-erp-after-sale-cron.js
node new-erp-after-sale-cron.js --help
```

首次真实运行建议使用短日期范围：

```bash
node new-erp-after-sale-cron.js --brand JY --start-date 2026-06-22 --end-date 2026-06-28 --no-images
```

确认登录、导出任务、下载中心匹配和 `.xlsx` 下载都正常后，再按需启用图片导出或扩大日期范围。

## 注意事项

- 日志不得打印密码或 token。
- 客诉筛选条件是 `after_type_status=3`，不要替换成 `status=3`。
- ERP 请求需要把登录返回值放在名为 `token` 的 HTTP header 中。
- 导出流程会先创建售后订单导出任务，再轮询下载中心，找到匹配任务后下载文件。
