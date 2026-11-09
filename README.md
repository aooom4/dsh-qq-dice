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

## 下载

仓库是**公开**的，任何人无需 GitHub 账号即可获取：

| 方式 | 地址 |
| --- | --- |
| 源码 ZIP | <https://github.com/aooom4/dsh-qq-dice/archive/refs/heads/main.zip> |
| 版本包 | <https://github.com/aooom4/dsh-qq-dice/releases>（推荐，对应固定版本） |
| git clone | `git clone https://github.com/aooom4/dsh-qq-dice.git` |

也可以直接打开仓库页 <https://github.com/aooom4/dsh-qq-dice> → 右上角 **Code → Download ZIP**。

### 下载前请确认（重要）

这个插件是 **DSH NEXT 桌面端 + qq-bridge** 这套环境的配套设置面板，不是装了就能用的通用工具。你需要：

1. 本机已安装 **DSH NEXT**（Windows 桌面宿主）；
2. 本机正在运行 **qq-bridge 控制台**（默认端口 3100），且 `socialV2.proactive.mode` 为 `dice`；
3. 按下面的「安装」「配置」两步填好**你自己本机**的路径与令牌位置。

如果只装了 DSH 而没有这套桥接，面板会显示「读不到桥接状态」，不会崩，但也不会有数据。`qq-bridge` 本身不在本仓库内。

## 安装

1. 把本仓库放到 DSH 插件目录，例如 `~/.dsh/plugins/dsh-qq-dice`（Windows 下通常是 `C:\Users\<你的用户名>\.dsh\plugins\dsh-qq-dice`）。
2. 在 `~/.dsh/profiles/desktop/package.json` 里**追加**两项（注意是合并进已有的 `dependencies` 和 `bundles` 数组，不要覆盖原有内容）：

   ```json
   "dependencies": {
     "dsh-qq-dice": "link:C:/Users/<你的用户名>/.dsh/plugins/dsh-qq-dice"
   },
   "dsh": { "profile": { "bundles": [ "dsh-qq-dice" ] } }
   ```

   `link:` 后面必须换成**你本机的绝对路径**，照抄示例不会生效。
3. 在 `~/.dsh/profiles/desktop/node_modules/` 下建一个指向插件目录的 junction（Windows 管理员或开发者模式）：

   ```cmd
   mklink /J "node_modules\dsh-qq-dice" "C:\Users\<你的用户名>\.dsh\plugins\dsh-qq-dice"
   ```

   也可以用 `pnpm install` 让包管理器按 `link:` 自动建链。
4. **从系统托盘完全退出 DSH 再重新打开**（点窗口右上角 X 只是缩到托盘，不会重载插件）。设置左侧栏出现「🎲 投骰进度」即成功；没有的话去看 `~/.dsh/logs/` 里当天的日志有没有 `dsh-qq-dice` 的加载记录。

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
