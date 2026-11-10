# dsh-qq-dice

DSH NEXT 设置里的「🎲 投骰进度」独立插件：查看 QQ 桥接机器人主动消息投骰进度、**统计平均投多少次才命中一次**、以及**在设置界面直接改参数并立即生效**。

## 功能

- **投多少次命中一次**：面板顶部显示**每轮命中平均用了几投**（桥接「第几投命中」的均值，**不会超过保底次数**），另列最快 / 最慢和「最近每次命中用了几投」明细表（时间带日期）。每个会话在统计表里也有同一口径的平均间隔列。
- **命中统计表格**：每个会话一行，展示状态、本轮已投、安静 / 保底（前段显示对方已安静几分钟，进入加码段后改显示「距保底 N 投」）、下次命中率、下一投（门控期改显示「还需安静 X 分 / 静音中 / 等新消息」）、待补发、累计命中、投几次中一次、被重置，最后一列是「✕ 移除」按钮。
- **删除 / 恢复不用的会话**：点「✕ 移除」会把该会话写进桥接的 `socialV2.proactive.ignoredKeys`：立刻停掉它的定时投骰、从表格消失，并清除它在本插件里的历史命中统计（统计这一步不可恢复，点之前会弹确认）。不动 QQ 消息收发、DSH 会话映射和令牌，也不用重启。表格下方列出「已忽略 N 个会话」，每个都有「恢复」按钮，一点就重新开始投骰。
- **参数修改界面**：模式、启用开关、保底次数、投骰间隔、安静阈值、**静音时段**、基础命中率、加码起点、每次加码、random 概率、新消息重置计时。静音时段填 `23-8`（本地时间、左闭右开、可跨零点，多段用逗号分隔，留空=不静音），保存后桥接立即按新时段重排定时器，不用重启。保存前会校验参数（如加码起点必须小于保底次数、静音格式与小时范围）；点「保存」即写回桥接端，无需重启机器人。
- **命中日志**：桥接侧 `state/dice-hits.log`，一次命中一条、记录归零前的整轮状态，每天 19:00 清空；与本插件 `state/hits.json` 的累计统计是两份独立数据。

### 「投多少次命中一次」是怎么算的

桥接端只保存 `proactiveDiceCount`（本轮已投），命中后归零，**不保存总投骰数、也不保存历史命中**。因此本插件轮询 `/api/socialV2/proactive-status`（默认 5 秒；把投骰间隔调到 10 秒以下时自动加密）自行累计：

- 计数正常增长 → 把增长量计入 `rolls`（历史累计总投骰，仅供参考）；
- 计数回退（命中归零）→ 记一次命中，把「本轮第几投」写进 `intervals`：**`本轮 = 命中前最后一次观测到的 rollCount + 1`**，也就是桥接 `state/dice-hits.log` 里的 `roll`；
- **主指标平均 = `intervals` 里每轮投骰数的均值**，与明细表、统计表「投几次中一次」列完全同源。

1.2.4 起改用桥接 `roll` 口径，面板上的数字**永远不会超过保底次数**（默认 90）。此前用 `累计 rolls − 上次命中时的 rolls` 作差，会把被对方消息作废的轮次、DSH / 桥接重启造成的观测断档一起并进同一轮，出现 108、125 这类虚高值；那不是真的投了 100 多次，桥接日志里对应的是第 76、81 投。

1.2.0 之前带旧口径的 `intervals` 记录仍保留在 `state/hits.json` 里，但**不参与平均、也不显示在明细表**（只有带 `v:2` 标记的新口径才显示，面板会提示隐藏了几条）。明细表时间显示 `MM-DD HH:MM`，避免跨天的两条 `19:08` 看起来像重复。命中撞繁忙时只在归零时记一次，补发落地不会重复记。汇总提示不再显示「全局投骰效率」，避免三个不同口径的数字互相打架。

### 重置不会被误算成命中

开启 `resetOnIncoming` 后，**对方发一条消息也会把投骰计数清零并清掉待补发标记**，这和「命中归零」在计数上完全一样。1.1.0 会把这类回退误记成一次命中（还会顺带误记一次「补发命中」），把平均值算歪。

1.1.1 起用两个信号区分：桥接只在收到**对方**消息（`isSelf:false`）时更新 `lastIncomingAt`，命中不会动它；命中要求安静时长已超过 `idleThresholdMs`，而刚收到消息时必然低于阈值。命中不更新这两者、重置必然更新，因此可以把重置准确排除，单独记进 `resets` 并在表格「被重置」列显示。

取舍：极端情况下「机器人刚命中、对方立刻秒回」会漏记这一次命中，但绝不会把重置误算成命中。

改完参数后新节奏不会被历史数据稀释；统计原子落盘 `state/hits.json`（同时保留 `hits.json.bak`），每会话的上次观测快照也一起落盘，**DSH 重启后接着算，不再丢一段采样**；文件损坏时留档并从备份恢复，不会静默清零。1.2.4 起「用了几投」直接取桥接 `rollCount + 1`，不再受插件启动前累计值与断档影响。

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
- `state/hits.json` 是本插件的本地统计文件，含会话维度的累计命中（`hits`）、历史累计总投骰数（`rolls`，1.2.4 起仅供参考）、采样命中数（`sampledHits`）、每轮命中的投骰数与时间（`intervals`）、被重置次数（`resets`）、上次观测快照（`snap`）、兼容旧版保留但不参与计算的 `hitRoll`、补发去重标记（`armed`）。在面板点「✕ 移除」时会顺带删掉该会话在这些字段里的记录。原子写入并保留 `hits.json.bak`。桥接端命中后会把投骰计数归零且不保存历史，因此全部由本插件自行轮询累计。该文件仅从插件开始运行起累计，历史命中不在内。
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
