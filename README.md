# dsh-qq-dice

DSH NEXT 设置里的「🎲 投骰进度」独立插件：查看 QQ 桥接机器人主动消息投骰进度、**统计平均投多少次才命中一次**、以及**在设置界面直接改参数并立即生效**。

## 功能

- **投多少次命中一次**：面板顶部直接显示平均值（`累计投骰次数 ÷ 命中次数`），并给出最快 / 最慢命中间隔和「最近每次命中用了几投」明细表（含时间）。每个会话在统计表里也有自己的平均间隔列。
- **命中统计表格**：每个会话一行，展示状态、本轮已投、距保底、下次命中率、下一投倒计时、待补发、累计命中、投几次中一次。
- **参数修改界面**：模式、启用开关、保底次数、投骰间隔、安静阈值、基础命中率、加码起点、每次加码、random 概率、新消息重置计时。点「保存」即写回桥接端，桥接会立刻按新节奏重排定时器，无需重启机器人。

### 「投多少次命中一次」是怎么算的

桥接端只保存 `proactiveDiceCount`（本轮已投），命中后归零，**不保存总投骰数、也不保存历史命中**。因此本插件每 5 秒轮询 `/api/socialV2/proactive-status`，自行累计：

- 计数正常增长 → 把增长量计入 `rolls`（总投骰次数）；
- 计数回退（命中归零）或待补发 `true→false` → 记一次命中，并把这一轮用的投骰数写进 `intervals`；
- 平均 = `rolls ÷ sampledHits`，两者都是**同一次采样口径**（1.0 版只存了命中数、没有投骰数，所以旧命中只保留在「累计命中」，不参与平均计算，避免把平均值算歪）。

改完参数后新节奏不会被历史数据稀释；统计落盘 `state/hits.json`，DSH 重启不丢。

## 依赖

**不依赖任何第三方 DSH 插件。** 只用到 DSH 宿主内置的能力（设置槽位 `slots`、Web 服务 `webServer`、React、`__ModuleLoader__`）以及 Node 内置模块。

运行时的数据源是 **qq-bridge 的控制台**（一个独立进程，不是 DSH 插件），需要它正在运行且其 `socialV2.proactive.mode` 为 `dice`。桥接没开时面板只会提示读不到状态，不会报错崩溃。

## 安装

1. 把本仓库放到 DSH 插件目录，例如 `~/.dsh/plugins/dsh-qq-dice`。
2. 在 `~/.dsh/profiles/desktop/package.json` 里登记：

   ```json
   "dependencies": {
     "dsh-qq-dice": "link:C:/你的路径/.dsh/plugins/dsh-qq-dice"
   },
   "dsh": { "profile": { "bundles": [ "dsh-qq-dice" ] } }
   ```

3. 在 `~/.dsh/profiles/desktop/node_modules/` 建一个指向插件目录的 junction（Windows）：

   ```cmd
   mklink /J "node_modules\dsh-qq-dice" "C:\你的路径\.dsh\plugins\dsh-qq-dice"
   ```

4. **从系统托盘完全退出 DSH 再重新打开**（关窗口不会重载插件）。设置左侧栏出现「🎲 投骰进度」即成功。

## 配置（重要）

插件需要知道桥接控制台的地址和令牌位置。**这些信息属于本机私有数据，不进版本库**，有两种提供方式：

- **本地配置文件（推荐）**：把 `local.config.example.json` 复制为 `local.config.json` 并填写：

  ```json
  {
    "stateDir": "你的 qq-bridge/state 目录绝对路径",
    "consolePort": 3100,
    "tokenFile": "console-token"
  }
  ```

- **环境变量**：`QQ_BRIDGE_STATE_DIR`、`QQ_BRIDGE_CONSOLE_PORT`、`QQ_BRIDGE_TOKEN_FILE`，或直接给 `QQ_BRIDGE_CONSOLE_TOKEN`。

优先级：环境变量 > `local.config.json` > 内置默认值（端口 3100）。令牌在运行时从本机文件读取，host 侧代理请求，**不会下发到前端**。

## 隐私说明

- 仓库内**不含任何 API 密钥、令牌、本机绝对路径、QQ 号或群号**。
- `local.config.json` 与 `state/`（命中统计，含会话标识）已被 `.gitignore` 排除。
- `state/hits.json` 是本插件的本地统计文件，含会话维度的累计命中（`hits`）、总投骰数（`rolls`）、参与平均计算的命中数（`sampledHits`）、每次命中的投骰数与时间（`intervals`）。桥接端命中后会把投骰计数归零且不保存历史，因此全部由本插件每 5 秒轮询自行累计。该文件仅从插件开始运行起累计，历史命中不在内。
- 代码里出现的桥接接口路径是接口名而非凭据；上游地址、端口、令牌全部来自上面的本机配置。

## 参数含义

| 参数 | 说明 |
| --- | --- |
| `mode` | `dice` 投骰命中才发 / `always` 安静够就发 / `random` 小概率主动 |
| `diceGuaranteeCount` | 投满多少次强制命中（面板里的「/90」） |
| `diceIntervalMs` | 安静后每隔多久投一次，至少 1 秒 |
| `idleThresholdMs` | 对方安静多久才开始投骰 |
| `diceBaseProbability` | 加码起点之前的恒定命中率（0~1） |
| `diceRampStart` | 从第几次开始逐次累加命中率 |
| `diceRampStep` | 每次累加的概率（0~1） |

## License

MIT
