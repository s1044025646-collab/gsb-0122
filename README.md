# 高校志愿投档与录取复核后端

本地可运行的投档/录取复核系统：TypeScript + Node.js（内置 `node:sqlite`）+ 内置 HTTP API 与 CLI。
**仅提供 API、CLI、虚构招生数据夹具与自动化测试**，不含网页，也不连接任何真实招生系统。

## 核心机制

- **考生发起的延迟接受（Deferred Acceptance）**：多轮投档，每轮被拒考生顺延下一志愿，专业只“暂留”申请人并在超出容量时按冻结优先序淘汰靠后者；不是一次顺序贪心。
- **一人至多一个专业**，任何专业录取人数不超过容量。
- **不会自动补填**未填报的专业；只检索考生自己按序提交的志愿。
- **资格不符的志愿立即拒绝**，拒绝原因（体检受限、容量为零、优先序靠后等）写入每一步投档轨迹。
- **冻结的专业优先序**：表达式如 `score desc`、`metric.math desc`、`metric.physics asc`，末位固定追加公开确定性并列打破 `tiebreak(anon)`（对规范化匿名号做 SHA-256 前缀），同输入永远同结果，无随机源。
- **完整轨迹**：每次 `apply` / `held` / `reject` 及最终未录取原因逐轮持久化。
- **阻塞对核验**：对结果检查“考生更偏好、资格符合且有空位，或其按优先序优于已录取者”的配对；稳定结果阻塞对数量为 0。
- **规则版本与冻结**：正式录取冻结当时规则版本，之后修改需在新版本进行。
- **轮次不可覆盖**：试投档、正式录取、退档重投、成绩更正后的重投各自生成新轮次；已冻结轮次结果原样保留，实现跨轮次隔离。
- **来源留痕**：志愿修订（`application_revisions`）、成绩/资格更正（`score_revisions`）均记录来源与原因。
- **幂等**：写操作可带 `idempotency_key`，重复提交返回同一轮次并标记 `replayed: true`。
- 时间通过可注入时钟固定（夹具/演示/测试均用 `2026-08-01T08:00:00.000Z`），保证重放确定。

## 依赖

- Node.js >= 22（开发环境为 v25；使用实验性内置模块 `node:sqlite`，无需原生编译）。
- 仅开发依赖：`typescript`、`@types/node`。

```powershell
npm install
npm run build
```

## 测试

```powershell
npm test
```

覆盖：连锁挤出、同分并列、零容量、全部落选、资格变更、并发确认与重复确认幂等；
小规模穷举可行性/稳定性；重放确定性；跨轮次隔离；事务回滚（无效志愿不留轮次）；
关闭重开后的持久化；API 错误码与分页。

## 可重复的端到端演示

```powershell
npm run demo
```

演示在 `data/demo.db` 上依次执行：载入连锁挤出夹具 → 校验志愿 → 试投档 → 稳定性核验 →
正式录取（冻结规则）→ 同幂等键重复确认 → 退档触发新一轮连锁补位 → 展示历史轮次未被覆盖。
重复运行会重建该数据库文件。

## CLI

数据库默认 `data/admission.db`，可用环境变量 `ADMISSION_DB` 覆盖（所有数据都留在本项目目录）。

```powershell
node dist/cli.js init
node dist/cli.js create-batch B2026 "2026 本科批"
node dist/cli.js import B2026 examples/import.json
node dist/cli.js validate B2026
node dist/cli.js trial B2026 招办试投
node dist/cli.js confirm B2026 招办正式 formal-key-1
node dist/cli.js stability B2026
node dist/cli.js correct-score B2026 S3 95 成绩复核 "数学复核加分"
node dist/cli.js rerun B2026 成绩更正后重投
node dist/cli.js withdraw B2026 S1 "档案复查缺失" 招办退档 wd-key-1
node dist/cli.js status B2026
node dist/cli.js fixture
```

`trial` / `confirm` / `rerun` / `withdraw` 都会打印操作前后的批次、专业容量、轮次与录取状态。

## HTTP API

启动服务器（只绑定回环 `127.0.0.1`，端口由操作系统自动分配，实际端口写入 `data/server.port`）：

```powershell
npm start
# 或
node dist/cli.js serve
```

读取端口并调用（PowerShell）：

```powershell
$port = Get-Content data/server.port
Invoke-RestMethod "http://127.0.0.1:$port/batches"
```

主要路由（均有 JSON 参数校验、明确错误码与分页 `?page=&page_size=`）：

- `POST /batches`，`GET /batches`
- `POST /batches/:code/majors`，`GET /batches/:code/majors`
- `POST /batches/:code/priorities`（正式录取前设置冻结优先序）
- `POST /batches/:code/students`，`GET /batches/:code/students`
- `POST /batches/:code/applications`，`GET /batches/:code/applications`
- `POST /batches/:code/validate`
- `POST /batches/:code/rounds/trial|formal|rerun`
- `POST /batches/:code/withdraw`
- `POST /batches/:code/corrections`
- `GET /batches/:code/rounds`，`GET /rounds/:id`（`?detail=0` 仅摘要）

错误码：`VALIDATION(400)`、`NOT_FOUND(404)`、`CONFLICT/RULE_FROZEN/BAD_STATE(409)`、
`QUALIFICATION/CAPACITY(422)`、`INTERNAL(500)`。响应错误形如：

```json
{ "error": { "code": "VALIDATION", "message": "字段 capacity 必须是 >= 0 的整数" } }
```

## 启动与停止（只管理本项目进程）

```powershell
$p = Start-Process node -ArgumentList 'dist/cli.js','serve' -PassThru -WindowStyle Hidden
Stop-Process -Id $p.Id
```

前台运行时也可用 `Ctrl+C`（SIGINT）优雅关闭。

## 数据与清理

- 所有数据库、WAL 与端口文件都位于项目内 `data/`；测试使用系统临时目录中独立的临时库。
- 迁移（表结构）全部 `CREATE TABLE IF NOT EXISTS`，可重复执行。
- 清理本项目生成的数据：删除 `data/` 即可；删除 `dist/` 可清除编译产物。

## 目录结构

- `src/db.ts`：SQLite 连接与可重复迁移
- `src/repo.ts`：批次/专业/考生/志愿/来源留痕的数据访问
- `src/engine.ts`：延迟接受、优先序比较、志愿校验、阻塞对核验
- `src/exhaustive.ts`：小规模可行匹配穷举（测试用）
- `src/service.ts`：轮次生命周期、试投/正式/退档/成绩更正、幂等与持久化
- `src/api.ts`：HTTP API（回环绑定、自动端口、校验、错误码、分页）
- `src/cli.ts`：命令行入口
- `src/fixtures.ts`：六类虚构招生夹具
- `src/demo.ts`：可重复端到端演示
- `src/test/`：自动化测试
