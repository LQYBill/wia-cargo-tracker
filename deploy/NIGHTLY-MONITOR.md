# 夜间官网监控 · IT部署补充

此版本默认 `TRACKING_SOURCE=website`，无需17TRACK API token。Node.js 24+，依赖 Playwright 1.62.1（package-lock锁定）。只运行一个服务实例；本地数据库和浏览器均由VM运行。

## 安装

1. 先停旧服务，备份数据库、全部labels文件、私有配置。不要覆盖或打包用户数据目录。
2. 在源码目录运行 `npm ci`。
3. 由实际运行服务的Linux用户执行 `npx playwright install --with-deps chromium`，按提示安装系统依赖。安装浏览器的用户需与 systemd 服务运行用户相同；若IT预装到其他目录，统一设置 `PLAYWRIGHT_BROWSERS_PATH`。
4. 私有环境文件（权限600）配置以下内容，保留原有账号、数据目录、HTTPS源地址配置：

```dotenv
TRACKING_SOURCE=website
MONITOR_TIMEZONE=Europe/Paris
MONITOR_HOUR=22
TRACKING_BROWSER_CHANNEL=
```

5. 按原 `cargo-tracker.service` 启动。服务必须持续运行，用户注销后运行需IT配置用户级systemd linger。不要把Node服务绑定到公网，也不要把数据库或labels目录直接挂到Nginx静态站点。
6. 登录物流专员或ADMIN，点击“立即检查全部”，核对运行结果、`last_sync`、实际官网轨迹和多箱数量；首次成功后再验收当晚任务。`/health`仅证明服务在线，不证明官网查询成功。

Ubuntu浏览器安装参考：https://playwright.dev/docs/browsers 。Windows本地预览可用已安装Microsoft Edge，`TRACKING_BROWSER_CHANNEL=msedge`；VM生产默认使用Playwright安装的Chromium。

## 调度与状态

- 按Europe/Paris每天22:00入队，随夏令时变化；后台每10秒取一票，串行执行，不开并发抓取。默认新运单加入夜间计划，首次升级为现有未删除运单开启计划；已签收整票不重复查询，删除/暂停单不参加定时任务。
- 当晚失败后约30分钟重试，第二次失败约60分钟后再试，最多3次。失败保留历史轨迹，最终失败生成站内提醒。运行和逐票尝试状态保存在数据库，不把失败当成“无变化”。
- 重启会恢复未完成的查询项；错过当晚任务后补跑最近一期，避免把服务器上传时间当成物流建单时间。
- UPS读取快递官网历史事件，与17TRACK网页交叉核验；官网和17TRACK日期冲突时采用快递官网数据并显示核验提示。暂未实现FedEx/DHL官网的单独详情解析，这些承运商先尝试17TRACK网页。网页事件时区仅在可确认的地点范围内转换；未知地点报人工核验，不猜时间。
- UPS多箱列表会翻页获取同票包裹状态；整票费用仍记录一次。下方时效对应当前主查单号，不把单箱签收当整票7箱完成。
- 遇到验证码、限流、需要登录、无法读到节点、网络失败时不尝试绕过，也不伪造成功时间。普通浏览器能打开不代表无人值守浏览器可成功。

## 当前实测范围

32项自动测试通过（调度、时区、恢复、退避、网页文本解析及原业务回归）。本机后台浏览器可启动；首次无人值守外网请求实际失败：UPS导航返回下载响应，17TRACK返回HTTP403（随后请求明确确认）。交互式浏览器查询曾成功；二者不能等同。尚未在Ubuntu VM上验证稳定查询，**不能把浏览器组件已就绪或定时队列已启动当成真实数据链路已通过上线验收**。IT需检查VM出网、网站限制、浏览器版本和页面变化；若官网长期拒绝自动查询，需重新选择官方API数据源。

## 数据与备份

monitor_runs、monitor_items保存任务；package_tracks保存同票箱号状态；snapshots保存查询结果或失败诊断。费用、发票、账号权限沿用现有规则。全部随原SQLite备份；源代码发布包排除node_modules、data、私有env及浏览器缓存，IT用npm ci和浏览器安装命令重建运行环境。
