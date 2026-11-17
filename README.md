# @local/instabox-manager

本机 InstaBox 云沙盒管理插件（web profile，link 安装）：侧栏底部 **InstaBox** 入口 + 全屏面板，
Host 侧注册 `instabox_*` 工具，浏览器不接触 API key。

## 配置

`~/.dsh/instabox-manager.json`（`DSH_INSTABOX_CONFIG` 可换路径）：

```json
{
  "apiBase": "https://api.instabox.sh",
  "accounts": [
    { "alias": "mushi", "apiKey": "ibk_...", "machineId": "m_...", "sshCommand": "ssh -p ... ibssh_..." }
  ]
}
```

## 工具

| 工具 | 用途 |
| --- | --- |
| `instabox_list` | 列出每台沙盒的状态、模板、规格、冷却 |
| `instabox_status` | 单台详情：状态、运行/冷却计时、磁盘、SSH、持租约状态 |
| `instabox_exec` | `bash -lc` 在沙盒里执行一条命令 |
| `instabox_power` | start / stop / suspend / resume / wake |
| `instabox_lease` | 持租约（activity lease keepalive）start / stop / renew / status |

## 持租约（activity lease）

免费档的空闲自动暂停锁在账号级（`PATCH autoSuspendAfterSeconds: 0` → `403 spec_not_allowed`），
唯一的官方口子是 activity lease：

- `start` → `PUT /v1/machines/{id}/activity-leases/keepalive` `{"ttlSeconds":300}`（默认 300，范围 30–3600）
- Host 每 `0.6 × ttl`（默认 180s）续租一次；失败按 30s×次数退避，最多 5 分钟，错误记在台账里
- `stop` → `DELETE` 同一路径，恢复空闲自动暂停
- 台账：`~/.dsh/instabox-manager-lease.json`（0600，`DSH_INSTABOX_LEASE_STATE` 可换路径）；Host 重启后按台账继续续租
- 面板：每张沙盒卡片右侧有 `保活` / `停止保活` 开关，持租约时显示到期时间与续租间隔

注意：租约必须由沙盒外部续（Host 正好在外部）；沙盒自己 suspend 后，里面的 cron/systemd 都是冻住的。

### 检修轮转（避免 max-run 冷却）

免费档一次 run 从 120 分钟起、最多 480 分钟，而**租约不算“使用”、不延长 run**；到点会强制暂停并进入 max-run 冷却（首次 5–20 分钟，连击 60–75 / 120–135），冷却期内 exec/SSH/端口/wake/resume/start 全部 409。

轮转的解法：在 run 到点前主动 `suspend → resume`，这是一次“没有欠冷却的 run 结束”，`runStartedAt` 重置、冷却计数归零，不产生冷却。

- 触发条件：`GET /v1/machines/{id}` 里 `runStartedAt + maxRunMinutes - 20min`（`DSH_INSTABOX_CYCLE_MARGIN_MIN`，1–110）
- 步骤：`POST /suspend`（带 `Idempotency-Key`）→ 轮询到 `state=suspended` → 可选 `DSH_INSTABOX_CYCLE_HOLD_SEC`（0–600）停机 → `POST /resume` → 轮询到 `running` → 重续租约 → 重新读取计时
- 排期每 5s 检查一次；租约每次续期（0.6×ttl）会重新读机器，`maxRunMinutes` 因真实使用变大时下一次轮转自动后移
- 单台可关闭：面板「停止轮转」，或 `instabox_lease` `action=cycle-disable`；`action=cycle` 手动立即轮转一次
- 台账新增 `cycleEnabled` / `maxRunMinutes` / `runMinutesLeft` / `nextCycleAt` / `lastCycleAt` / `cycleCount` / `cycleSummary`（轮转前后 `runStartedAt`、`cooldownUntil`）
- 轮转大约中断 30–60 秒；正在跑的 exec 会失败一次，重要任务避开轮转点
- 调试：`DSH_INSTABOX_CYCLE_DEBUG=1` 往 stderr 打每个 tick 的判定

## 路由

同源、走 Host（信任检查 fail-closed）：

- `GET  /instabox-manager/state` → 机器列表，每台带 `lease` 快照
- `POST /instabox-manager/action` → `{machine, action: start|stop|suspend|resume|wake}`
- `POST /instabox-manager/lease`  → `{machine, action: start|stop|renew|status, ttlSeconds?}`

## 安装 / 验证

```sh
node --check index.js && node --check client.js
```

link 安装后在 web profile 里 `plugin_manager install_bundle`，Host 代码要重启 `dsh web` 才加载；
`client.js` 改动需要刷新页面。路由未挂载时 `POST /instabox-manager/lease` 返回 404，挂载后被信任检查拦成 401。