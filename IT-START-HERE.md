# IT 部署入口 · 货迹 v1.6.0

本包为完整源代码，不包含本机业务数据库、账户密码、面单、发票、产品附件、node_modules 或浏览器程序。全新部署会初始化一个 ADMIN 账户；不会自动迁移本机已有用户和运单。请勿在正式环境运行演示数据导入脚本。

## 先确认当前交付状态

业务系统、本地存储、三角色权限、面单OCR、内部费用与已付标记、附件权限、编辑/回收站、夜间调度均已实现。最近32项自动测试通过。

**官网数据链路尚未通过上线验收。** 后台浏览器能启动，但本机实测17TRACK返回HTTP403，UPS没有返回有效物流网页。程序会记录失败、重试并保留历史，不会伪报成功。请先在目标VM验通真实官网查询；不能仅凭服务启动或健康检查就认定自动监控可用。FedEx/DHL目前仅尝试17TRACK网页，没有各自官网的独立解析。

## 文件索引

- `README.md`：功能、权限、数据连接边界、升级和备份说明。
- `deploy/NIGHTLY-MONITOR.md`：夜间官网监控的安装和验收重点，先阅读。
- `.env.example`：私有环境文件模板；需自行填写正式域名、绝对数据路径及ADMIN密码散列。
- `deploy/cargo-tracker.service`：用户级systemd服务模板。
- `deploy/nginx.conf`：独立HTTPS站点的反向代理片段。
- `package.json` / `package-lock.json`：Node依赖及固定版本。
- `scripts/password.mjs`：交互式生成ADMIN初始密码散列。
- `scripts/backup.mjs`：数据库与全部附件备份。
- `RELEASE-MANIFEST.json`：本包源码文件的SHA256清单。

## 推荐上线顺序

1. 使用 Node.js 24+，按服务模板将源码放在运行用户的 `~/.local/opt/cargo-tracker`。
2. 在源码目录执行 `npm ci`，由实际服务运行用户执行 `npx playwright install --with-deps chromium`。为Ubuntu OCR安装 `tesseract-ocr` 与 `imagemagick`。
3. 将 `.env.example` 复制到仓库外的 `~/.config/cargo-tracker/app.env`，权限600。填写 `APP_ORIGIN`、`CARGO_DATA_DIR`；运行 `node scripts/password.mjs` 生成新的 `ADMIN_PASSWORD_HASH`。不使用聊天里的本地预览密码。
4. 默认 `TRACKING_SOURCE=website`、`MONITOR_TIMEZONE=Europe/Paris`、`MONITOR_HOUR=22`。无需17TRACK API token；若将来切换API，按README另配置。
5. 核对systemd模板中Node路径、源码路径和环境文件路径，启用服务。仅监听回环地址5187；配置HTTPS反向代理，请求体上限24m。不要替换现有其他业务系统配置。
6. 用 `ADMIN`＋第3步密码登录，创建物流专员与销售账号，录入一票用于验收的真实运单，分配销售。
7. 点击“立即检查全部”，确认出现真实查询成功时间，并与官网核对建单时间、时区、揽收及多箱状态。官网返回验证码、403或非物流页面时，必须保留失败状态并处理连通性，不能以系统录入日期代替物流建单日期。
8. 验证销售只能看本人运单和产品Excel，看不到费用、付款和发票；物流专员能改但不能删除；ADMIN能删除和恢复。确认22:00夜间任务、失败重试、重启补跑和备份恢复。

## 已有环境升级或迁移

先停止服务并备份数据库、附件、私有配置，再替换源码及安装依赖。数据库运行时执行增量迁移；不要以空库或演示库覆盖正式库。若需要将当前电脑已有运单和账号迁至VM，应另行交付受控数据备份，本源码包不承担数据迁移。

源码发布排除node_modules，IT应使用锁文件安装依赖。`npm test` 可重跑测试；Linux浏览器、OCR、Nginx、systemd及官网出网仍需在VM实机验收。
