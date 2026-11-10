# dsh-qq-dice

DSH NEXT 设置里的「🎲 投骰进度」独立插件：查看 QQ 桥接机器人主动消息投骰进度、**统计平均投多少次才命中一次**、以及**在设置界面直接改参数并立即生效**。

1.3.0 起支持三档数据源（自动探测本机桥接 / 自定义契约接其它桥接 / 内置演示引擎），**不装 qq-bridge 也能打开完整面板**。

## 功能

- **投多少次命中一次**：面板顶部显示**每轮命中平均用了几投**（桥接「第几投命中」的均值，**不会超过保底次数**），另列最快 / 最慢和「最近每次命中用了几投」明细表（时间带日期）。每个会话在统计表里也有同一口径的平均间隔列。
- **命中统计表格**：每个会话一行，展示状态、本轮已投、安静 / 保底（前段显示对方已安静几分钟，进入加码段后改显示「距保底 N 投」）、下次命中率、下一投（门控期改显示「还需安静 X 分 / 静音中 / 等新消息」）、待补发、累计命中、投几次中一次、被重置，最后一列是「✕ 移除」按钮。
- **删除 / 恢复不用的会话**：点「✕ 移除」会把该会话写进桥接的 `socialV2.proactive.ignoredKeys`：立刻停掉它的定时投骰、从表格消失，并清除它在本插件里的历史命中统计（统计这一步不可恢复，点之前会弹确认）。不动 QQ 消息收发、DSH 会话映射和令牌，也不用重启。表格下方列出「已忽略 N 个会话」，每个都有「恢复」按钮，一点就重新开始投骰。
- **参数修改界面**：模式、启用开关、保底次数、投骰间隔、安静阈值、**静音时段**、基础命中率、加码起点、每次加码、random 概率、新消息重置计时。静音时段填 `23-8`（本地时间、左闭右开、可跨零点，多段用逗号分隔，留空=不静音），保存后桥接立即按新时段重排定时器，不用重启。保存前会校验参数（如加码起点必须小于保底次数、静音格式与小时范围）；点「保存」即写回桥接端，无需重启机器人。
- **数据源（1.3.0）**：面板顶部「数据源」卡片可切换三档 —— `auto` 自动探测本机桥接控制台（默认 3100，零配置）；`custom` 填任意 base URL + 令牌，按最小 JSON 契约接其它桥接；`demo` 完全不联网，插件内置同规则投骰引擎，面板 / 统计 / 参数页全部可用。令牌只留宿主机，不回显到前端。
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

运行时数据源**可选**，三档任选其一：

| 档位 | 需要什么 | 数据 |
| --- | --- | --- |
| `auto`（默认） | 本机跑着 qq-bridge 控制台（`socialV2.proactive.mode=dice`）；自动找端口与令牌 | 真实投骰进度 |
| `custom` | 任意按契约提供 `/status`、`/config` 的 HTTP 服务 | 真实数据（取决于对方） |
| `demo` | 什么都不需要 | 内置模拟引擎，不发 QQ 消息 |

没有桥接时 `auto` 会给一句可读提示，不会崩；切到 `demo` 即可看到完整面板。主动消息始终由桥接（或你自己的服务）去发，本插件只负责显示与改参数。

## 下载

仓库是**公开**的，任何人无需 GitHub 账号即可获取：

| 方式 | 地址 |
| --- | --- |
| 源码 ZIP | <https://github.com/aooom4/dsh-qq-dice/archive/refs/heads/main.zip> |
| 版本包 | <https://github.com/aooom4/dsh-qq-dice/releases>（推荐，对应固定版本） |
| git clone | `git clone https://github.com/aooom4/dsh-qq-dice.git` |

也可以直接打开仓库页 <https://github.com/aooom4/dsh-qq-dice> → 右上角 **Code → Download ZIP**。

### 下载前请确认（重要）

只需要 **DSH NEXT 桌面宿主**。装完打开「数据源」卡片：

- 本机有 qq-bridge → 保持默认 `auto`，插件自动探测，不用填任何配置；
- 用别的桥接 → 选 `custom`，按下面的契约填地址；
- 只是想看面板 / 先试一试 → 选 `demo`，不用联网、不用桥接。

`qq-bridge` 本身不在本仓库内。三种模式下插件都不会崩，区别只在数据是否真实、以及改动会不会真的让机器人发消息。

## 安装

### 从插件市场 / 命令行安装

```bash
dsh plugin --profile desktop add github:aooom4/dsh-qq-dice
```

`desktop` 换成你自己的 profile 名；若已发到 npm，也可以直接写包名 `dsh-qq-dice`。装完**从系统托盘完全退出 DSH 再重新打开**，设置左侧栏出现「🎲 投骰进度」即成功。

> 默认 `auto` 会自己找本机桥接，一般不用填配置；找不到时在「数据源」里切 `demo` 即可看到完整面板，或切 `custom` 填其它桥接的地址。

### 手动安装（本地开发 / 不用 CLI 时）

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

## 数据源配置

设置保存在 `state/datasource.json`（不进版本库），面板顶部「数据源」卡片可直接切换，不用手编文件：

| 字段 | 说明 |
| --- | --- |
| `mode` | `auto` / `custom` / `demo` |
| `baseUrl` | 仅 `custom` 用，如 `http://127.0.0.1:8080/dice`，只允许 http(s) |
| `token` | 可选，放在 `tokenHeader` 指定的 header 里；只存宿主机，面板只显示「已设置」 |
| `tokenHeader` | 默认 `x-console-token` |

### auto：零配置怎么找桥接

按顺序试：环境变量 `QQ_BRIDGE_CONSOLE_PORT` / `QQ_BRIDGE_CONSOLE_TOKEN` → 旧版 `local.config.json` 的 `consolePort` / `stateDir` + `tokenFile` → 默认端口 `3100` 与几个常见目录里的 `console-token`。先不带令牌敲一下端口，返回 401 也算「服务在」，再逐个试令牌；第一个返回 `{ok:true, conversations:[...]}` 的组合会被缓存 60 秒。**旧版 `local.config.json` 继续有效**，升级不用重填；实在找不到令牌时，在 `custom` 里填一次即可（存进 `datasource.json`，以后不再问）。

### custom：最小 JSON 契约

只要有服务按下面三个接口应答，就能接任意桥接（OneBot 插件、Aurabot、自建服务都行）。路径都拼在 `{base}` 后面：

| 接口 | 说明 |
| --- | --- |
| `GET {base}/status` | `{ ok:true, conversations:[{ key, rollCount, pendingFire, idleMs, lastIncomingAt, status, nextProbability?, nextRollInMs?, guaranteeLeft? }], diceIntervalMs, idleThresholdMs, guaranteeCount, quietHours, ignoredKeys }` |
| `GET {base}/config` | `{ ok:true, config:{ proactive:{...} } }` |
| `POST {base}/config` | 请求 `{ proactive:{...} }`，返回同上 |
| 令牌 | 可选，放在 `x-console-token`（或面板里改的 header 名） |

`ignoredKeys` 通过 `config.proactive.ignoredKeys` 读写，所以「✕ 移除 / 恢复」也自动可用，不需要额外接口。

最小适配器示例（约 25 行，把任意桥接的状态转成上面的契约）：

```js
import http from 'node:http'
let proactive = { mode: 'dice', enabled: true, diceGuaranteeCount: 90,
  diceIntervalMs: 60000, idleThresholdMs: 300000, diceBaseProbability: 0.006,
  diceRampStart: 74, diceRampStep: 0.06, quietHours: [], ignoredKeys: [] }
const status = () => ({ ok: true, conversations: [{ key: 'private:10001',
  rollCount: 12, pendingFire: false, idleMs: 600000, status: 'rolling',
  lastIncomingAt: Date.now() - 600000, nextProbability: 0.006,
  nextRollInMs: 60000, timerActive: true, guaranteeLeft: 78 }],
  diceIntervalMs: 60000, idleThresholdMs: 300000, guaranteeCount: 90,
  quietHours: proactive.quietHours, ignoredKeys: proactive.ignoredKeys })
http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  if (req.url === '/status' && req.method === 'GET') return res.end(JSON.stringify(status()))
  if (req.url === '/config' && req.method === 'GET')
    return res.end(JSON.stringify({ ok: true, config: { proactive } }))
  if (req.url === '/config' && req.method === 'POST') {
    let b = ''; req.on('data', (c) => (b += c))
    return req.on('end', () => {
      try { proactive = { ...proactive, ...(JSON.parse(b).proactive || {}) } } catch {}
      res.end(JSON.stringify({ ok: true, config: { proactive } }))
    })
  }
  res.statusCode = 404; res.end(JSON.stringify({ ok: false, error: 'not found' }))
}).listen(8080)
```

### demo：内置模拟引擎

不联网、不读桥接、**不往 QQ 发任何消息**。插件自己按同一套规则投骰：基础 `diceBaseProbability`、`diceRampStart` 起每投 +`diceRampStep`、第 `diceGuaranteeCount` 投 100% 命中；命中即把 `rollCount` 归零，现有统计采样逻辑照常记入 `hits.json`。默认两个演示会话（`private:10001`、`group:20001`）和 5 秒间隔，参数页改完下一轮就生效，状态存在 `state/demo-state.json`，DSH 重启续跑。

边界：demo 不实现静音时段 / 新消息重置 / 门控跳过这些桥接侧逻辑，也不发消息；它只是让「谁装了都能看到完整面板」。演示统计单独落在 `state/demo-hits.json`，与真实 `state/hits.json` 完全隔离，切回 `auto` 后平均值与明细表不会被模拟记录污染。

## 隐私说明

- 仓库内**不含任何 API 密钥、令牌、本机绝对路径、QQ 号或群号**。
- `local.config.json` 与 `state/`（命中统计含会话标识、`datasource.json` 可能含自定义数据源令牌、`demo-state.json` / `demo-hits.json` 演示状态与统计）已被 `.gitignore` 排除。面板读取数据源时只返回 `hasToken`，令牌不会下发前端。
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
