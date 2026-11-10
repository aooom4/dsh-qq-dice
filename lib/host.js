// DSH「QQ 投骰进度」· 宿主半边
//
// 提供同源路由，由本插件（host 侧，运行在 DSH 主进程里）持有令牌去访问数据源，
// **令牌不进前端**。1.3.0 起数据源可插拔：auto 自动探测本机 qq-bridge、
// custom 按最小契约访问任意 HTTP 服务、demo 完全本地模拟（见 README）。
//
// 路由：
//   GET  /dsh-qq-dice/status   → 实时投骰进度
//   GET  /dsh-qq-dice/config   → 读取可编辑参数
//   POST /dsh-qq-dice/config   → 写回参数，立即生效
//   POST /dsh-qq-dice/ignored  → 删除 / 恢复「不用定时对话」的会话（可恢复）
//   GET  /dsh-qq-dice/hits     → 本地累计的命中次数、投骰次数、每命中间隔（含平均）
//
// ⚠ 为什么不直接改 dsh-qq-bridge：
//   dsh-qq-bridge 是 GitHub 上独立安装的插件，DSH 一更新就会覆盖。
//   本插件是独立目录，跟它互不干扰，所以它更新也不会回退这里的投骰进度 / 修改界面。

import { readFileSync, writeFileSync, mkdirSync, renameSync, copyFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件的对外名字（也是路由前缀、日志前缀）。 */
export const name = 'qq-dice'

/** 需要宿主提供的服务。缺了会在 install 时报错（早炸早发现）。 */
export const inject = ['webServer']

export function apply(ctx) {
  const 路由前缀 = '/dsh-qq-dice'
  const 根目录 = dirname(dirname(fileURLToPath(import.meta.url)))
  const 命中文件 = join(根目录, 'state', 'hits.json')
  const 演示命中文件 = join(根目录, 'state', 'demo-hits.json')
  // 演示模式的统计单独存一份，切回真实数据源时不会把模拟记录混进平均值 / 明细表。
  const 当前命中文件 = () => (读源().mode === 'demo' ? 演示命中文件 : 命中文件)
  mkdirSync(dirname(命中文件), { recursive: true })

  const 回 = (res, o, 状态 = 200) => {
    res.writeHead(状态, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(o))
  }
  const 路线 = (路径, 处理器) =>
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: 路径,
        handler: async (req, res) => {
          try {
            await 处理器(req, res)
          } catch (error) {
            回(res, { ok: false, 说: String((error && error.message) || error) })
          }
        },
      }),
    )

  // ── 1.3.0 可插拔数据源 ──────────────────────────────────────────────
  //  上层路由仍只认 qq-bridge 的 /api/socialV2/* 形状；这里决定「去哪儿拿」：
  //    auto   自动探测本机桥接控制台（默认端口 3100 + 环境变量 / 旧配置 / 常见位置的令牌）
  //    custom 按最小 JSON 契约访问任意 base URL，别的桥接写个转发就能接
  //    demo   完全不联网，插件内置同规则的投骰模拟引擎，谁装了都有完整面板
  //  令牌只留在宿主机里：面板读到的永远是「已设置 / 未设置」，不回显明文。
  const 数据源文件 = join(根目录, 'state', 'datasource.json')
  const 演示文件 = join(根目录, 'state', 'demo-state.json')
  const 默认源 = () => ({ mode: 'auto', baseUrl: '', token: '', tokenHeader: 'x-console-token' })
  const 读源 = () => {
    try {
      const d = JSON.parse(readFileSync(数据源文件, 'utf8'))
      return {
        mode: ['auto', 'custom', 'demo'].includes(d.mode) ? d.mode : 'auto',
        baseUrl: String(d.baseUrl || '').trim().replace(/\/+$/, ''),
        token: String(d.token || ''),
        tokenHeader: String(d.tokenHeader || 'x-console-token').trim() || 'x-console-token',
      }
    } catch {
      return 默认源()
    }
  }
  const 写源 = (o) => {
    const 文本 = JSON.stringify(o, null, 2)
    const 临时 = 数据源文件 + '.tmp'
    writeFileSync(临时, 文本)
    try { renameSync(临时, 数据源文件) } catch { writeFileSync(数据源文件, 文本) }
  }
  const 公开源 = (o) => ({ mode: o.mode, baseUrl: o.baseUrl, tokenHeader: o.tokenHeader, hasToken: !!o.token })
  const 超时信号 = () => (typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(1500) : undefined)

  // 旧版 local.config.json 仍作为 auto 的回退来源，升级后不用重填。
  const 读本机配置 = () => {
    try {
      return JSON.parse(readFileSync(join(根目录, 'local.config.json'), 'utf8'))
    } catch {
      return {}
    }
  }
  const 候选端口 = () => {
    const c = 读本机配置()
    return Array.from(new Set([
      Number(process.env.QQ_BRIDGE_CONSOLE_PORT), Number(c.consolePort), 3100,
    ].filter((n) => Number.isInteger(n) && n > 0 && n < 65536)))
  }
  const 候选令牌 = (源) => {
    const c = 读本机配置()
    const 文件名 = process.env.QQ_BRIDGE_TOKEN_FILE || c.tokenFile || 'console-token'
    const 目录 = [
      process.env.QQ_BRIDGE_STATE_DIR, c.stateDir,
      join(homedir(), '.dsh', 'state'),
      join(homedir(), '.dsh', 'qq-bridge', 'state'),
      join(homedir(), '.dsh', 'plugins', 'dsh-qq-bridge', 'state'),
      join(process.cwd(), 'state'), join(process.cwd(), 'qq-bridge', 'state'),
    ].filter(Boolean)
    const 出 = [process.env.QQ_BRIDGE_CONSOLE_TOKEN, 源.token].filter(Boolean)
    for (const d of 目录) {
      try { 出.push(readFileSync(join(d, 文件名), 'utf8').trim()) } catch { /* 没这个文件就换下一个 */ }
    }
    return Array.from(new Set(出.filter(Boolean)))
  }
  // 探测结果只缓存 60 秒；失败 10 秒内不反复敲端口，面板切到 auto 时会强制重探。
  let 探测缓存 = { at: 0, ok: false, 端口: 0, 令牌: '', 说: '' }
  const 自动探测 = async (强制 = false) => {
    const 现在 = Date.now()
    if (!强制 && 探测缓存.ok && 现在 - 探测缓存.at < 60000) return 探测缓存
    if (!强制 && !探测缓存.ok && 现在 - 探测缓存.at < 10000) return 探测缓存
    const 源 = 读源()
    for (const 端口 of 候选端口()) {
      const 地址 = `http://127.0.0.1:${端口}/api/socialV2/proactive-status`
      // 先不带令牌敲一下：端口没开就立刻跳过，避免 × 令牌候选数的超时等待。
      // 返回 401/403 也算「服务在」，接着用候选令牌重试。
      try {
        const r0 = await fetch(地址, { cache: 'no-store', signal: 超时信号() })
        if (r0.status === 404) continue
        if (r0.ok) {
          const j0 = await r0.json()
          if (j0 && j0.ok === true && Array.isArray(j0.conversations)) {
            探测缓存 = { at: 现在, ok: true, 端口, 令牌: '', 说: `已连接 127.0.0.1:${端口}（无需令牌）` }
            return 探测缓存
          }
        }
      } catch { continue }
      for (const 令牌 of 候选令牌(源)) {
        try {
          const r = await fetch(地址, {
            headers: { 'x-console-token': 令牌 },
            cache: 'no-store',
            signal: 超时信号(),
          })
          if (!r.ok) continue
          const j = await r.json()
          if (j && j.ok === true && Array.isArray(j.conversations)) {
            探测缓存 = { at: 现在, ok: true, 端口, 令牌, 说: `已连接 127.0.0.1:${端口}` }
            return 探测缓存
          }
        } catch { /* 换下一个候选 */ }
      }
    }
    探测缓存 = { at: 现在, ok: false, 端口: 0, 令牌: '', 说: '未发现本机 qq-bridge 控制台（默认端口 3100）' }
    return 探测缓存
  }

  // ── demo：内置投骰模拟引擎（只出数据，不往 QQ 发任何消息）──
  const 演示默认参数 = () => ({
    mode: 'dice', enabled: true,
    diceGuaranteeCount: 90, diceIntervalMs: 5000, idleThresholdMs: 60000,
    diceBaseProbability: 0.006, diceRampStart: 74, diceRampStep: 0.06,
    probability: 0.3, resetOnIncoming: true, quietHours: [],
    skipGatedTicks: true, ignoredKeys: [],
  })
  const 演示初始 = () => ({
    proactive: 演示默认参数(),
    conversations: [
      { key: 'private:10001', rollCount: 0, lastIncomingAt: Date.now() - 3600000 },
      { key: 'group:20001', rollCount: 0, lastIncomingAt: Date.now() - 3600000 },
    ],
  })
  let 演示 = (() => {
    try {
      const d = JSON.parse(readFileSync(演示文件, 'utf8'))
      const 基 = 演示初始()
      return {
        proactive: { ...基.proactive, ...(d.proactive || {}) },
        conversations: Array.isArray(d.conversations) && d.conversations.length ? d.conversations : 基.conversations,
      }
    } catch { return 演示初始() }
  })()
  const 存演示 = () => { try { writeFileSync(演示文件, JSON.stringify(演示)) } catch { /* 落盘失败不影响运行 */ } }
  const 演示概率 = (roll, p) => {
    const 保底 = Math.max(1, Number(p.diceGuaranteeCount) || 90)
    if (roll >= 保底) return 1
    const 基础 = Number(p.diceBaseProbability != null ? p.diceBaseProbability : 0.006)
    const 起点 = Math.max(1, Number(p.diceRampStart) || 74)
    const 步长 = Number(p.diceRampStep != null ? p.diceRampStep : 0.06)
    return roll < 起点 ? 基础 : Math.min(1, 基础 + (roll - 起点 + 1) * 步长)
  }
  const 演示状态 = () => {
    const p = 演示.proactive
    const 忽略 = Array.isArray(p.ignoredKeys) ? p.ignoredKeys : []
    const 保底 = Math.max(1, Number(p.diceGuaranteeCount) || 90)
    const 现在 = Date.now()
    return {
      ok: true, demo: true,
      conversations: 演示.conversations
        .filter((c) => !忽略.includes(c.key))
        .map((c) => {
          const 已投 = Number(c.rollCount) || 0
          return {
            key: c.key,
            status: p.enabled === false ? 'disabled' : 'rolling',
            rollCount: 已投,
            pendingFire: false,
            idleMs: 现在 - (Number(c.lastIncomingAt) || 现在 - 3600000),
            lastIncomingAt: Number(c.lastIncomingAt) || 0,
            nextProbability: 演示概率(已投 + 1, p),
            nextRollInMs: Math.max(1000, Number(p.diceIntervalMs) || 5000),
            timerActive: p.enabled !== false,
            guaranteeLeft: Math.max(0, 保底 - 已投),
          }
        }),
      diceIntervalMs: Math.max(1000, Number(p.diceIntervalMs) || 5000),
      idleThresholdMs: Number(p.idleThresholdMs) || 60000,
      guaranteeCount: 保底,
      quietHours: Array.isArray(p.quietHours) ? p.quietHours : [],
      ignoredKeys: 忽略,
    }
  }
  const 假响应 = (obj, 状态 = 200) => ({
    ok: 状态 >= 200 && 状态 < 300,
    status: 状态,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  })
  const 演示响应 = (方法, 路径名, 体) => {
    if (路径名 === '/api/socialV2/proactive-status') return 假响应(演示状态())
    if (路径名 === '/api/socialV2/config') {
      if (方法 === 'POST' && 体 && 体.proactive) {
        演示.proactive = { ...演示.proactive, ...体.proactive }
        存演示()
      }
      return 假响应({ ok: true, config: { proactive: 演示.proactive } })
    }
    return 假响应({ ok: false, error: '演示模式不支持该接口' }, 404)
  }
  // 递归 setTimeout：参数页改了投骰间隔后下一轮就按新间隔跑，不用重启。
  ctx.effect(() => {
    let 停止 = false
    let 定时器 = null
    const 跑 = () => {
      if (停止) return
      if (读源().mode === 'demo' && 演示.proactive.enabled !== false) {
        for (const c of 演示.conversations) {
          const roll = (Number(c.rollCount) || 0) + 1
          c.rollCount = Math.random() < 演示概率(roll, 演示.proactive) ? 0 : roll
        }
        存演示()
      }
      定时器 = setTimeout(跑, Math.max(1000, Number(演示.proactive.diceIntervalMs) || 5000))
    }
    定时器 = setTimeout(跑, 1000)
    return () => { 停止 = true; if (定时器) clearTimeout(定时器) }
  })

  // 自定义数据源的契约路径；auto 仍走 qq-bridge 原生路径。
  const 契约路径 = (路径名) =>
    路径名 === '/api/socialV2/proactive-status' ? '/status'
      : 路径名 === '/api/socialV2/config' ? '/config' : 路径名

  const 代理 = async (方法, 路径名, 体 = null) => {
    const 源 = 读源()
    if (源.mode === 'demo') return 演示响应(方法, 路径名, 体)
    const 头 = { 'cache-control': 'no-store' }
    const 选项 = { method: 方法, headers: 头, signal: 超时信号() }
    if (体 !== null) {
      头['content-type'] = 'application/json'
      选项.body = JSON.stringify(体)
    }
    if (源.mode === 'custom') {
      if (!源.baseUrl) throw new Error('自定义数据源还没填地址：在「数据源」里填 base URL，或切回自动 / 演示模式')
      if (源.token) 头[源.tokenHeader] = 源.token
      return fetch(源.baseUrl + 契约路径(路径名), 选项)
    }
    const 连 = await 自动探测()
    if (!连.ok) throw new Error(连.说 + '；可切到「演示模式」先看完整面板，或在「数据源」里填自定义地址')
    if (连.令牌) 头['x-console-token'] = 连.令牌
    return fetch(`http://127.0.0.1:${连.端口}${路径名}`, 选项)
  }

  // ── 本地累计统计（桥接端不保存累计命中 / 总投骰，命中后 proactiveDiceCount 归零）──
  //  hits / rolls / sampledHits / intervals / resets 见 1.1.1
  //  snap     每会话上次观测快照 —— 落盘，DSH 重启后接着算，不再丢一段采样
  //  hitRoll  1.2.3 及以前用「累计增量」算本轮投数，1.2.4 起只保留字段兼容，不再参与计算
  //  armed    本轮命中撞繁忙（pending=true）已记过，补发落下时不再重复记一次
  //  1.2.4 口径：本轮用了几投 = 命中前最后一次观测到的 rollCount + 1，
  //  与桥接 dice-hits.log 的 roll 同源，天然 ≤ diceGuaranteeCount，不会虚高到 100+。
  const 空统计 = () => ({ hits: {}, last: {}, rolls: {}, sampledHits: {}, intervals: {}, resets: {}, snap: {}, hitRoll: {}, armed: {} })
  const 解析命中 = (原始) => {
    const d = JSON.parse(原始)
    return {
      hits: d.hits || {}, last: d.last || {}, rolls: d.rolls || {},
      sampledHits: d.sampledHits || {}, intervals: d.intervals || {}, resets: d.resets || {},
      snap: d.snap || {},
      // 1.1.x 旧文件没有 hitRoll：用当时的累计投骰做起点，别把插件启动前投的次数算进新口径第一轮。
      hitRoll: (d.hitRoll && Object.keys(d.hitRoll).length) ? d.hitRoll : { ...(d.rolls || {}) },
      armed: d.armed || {},
    }
  }
  const 读命中 = () => {
    const 文件 = 当前命中文件()
    if (!existsSync(文件)) return 空统计()
    try {
      return 解析命中(readFileSync(文件, 'utf8'))
    } catch (error) {
      // 文件损坏：留档（不静默清空），优先从上一份原子写留下的备份恢复。
      try {
        if (existsSync(文件)) renameSync(文件, 文件 + '.corrupt-' + Date.now())
      } catch { /* 留档失败不阻断 */ }
      console.warn('[qq-dice] 统计文件解析失败，已留档并尝试从备份恢复：', String(error))
      try { return 解析命中(readFileSync(文件 + '.bak', 'utf8')) } catch { return 空统计() }
    }
  }
  const 写命中 = (o) => {
    const 文件 = 当前命中文件()
    try {
      const 文本 = JSON.stringify(o)
      const 临时 = 文件 + '.tmp'
      writeFileSync(临时, 文本)
      try { renameSync(临时, 文件) } catch { writeFileSync(文件, 文本) }
      // 成功落盘后同步一份完整备份；主文件万一损坏可直接恢复，不丢最后一轮采样。
      try { copyFileSync(文件, 文件 + '.bak') } catch { /* 备份失败不影响运行 */ }
    } catch {
      /* 落盘失败不影响运行 */
    }
  }
  const 刷新命中 = async () => {
    let 投骰间隔 = 60000
    try {
      const r = await 代理('GET', '/api/socialV2/proactive-status')
      if (!r.ok) return 投骰间隔
      const j = await r.json()
      if (!j || j.ok !== true || !Array.isArray(j.conversations)) return 投骰间隔
      投骰间隔 = Number(j.diceIntervalMs) || 60000
      const 安静阈值 = Number(j.idleThresholdMs) || 0
      const db = 读命中()
      // 1.2.4 迁移：旧算法（累计增量）会把作废轮 / 重启断档并进同一轮，写出 108、125 这类
      // 超过保底的虚高记录。桥接真实 roll 不可能 > 保底，把它们降级为旧口径（不再显示、不参与平均），
      // 原始数据仍留在 hits.json 里；降级后 v !== 2，只会执行一次。
      const 保底 = Math.max(1, Number(j.guaranteeCount) || 90)
      for (const k of Object.keys(db.intervals || {})) {
        const arr = db.intervals[k]
        if (!Array.isArray(arr)) continue
        for (const it of arr) {
          if (it && it.v === 2 && Number(it.r) > 保底) it.v = 1
        }
      }
      const 现在 = Date.now()
      for (const c of j.conversations) {
        const k = c.key
        const 本次 = {
          count: Number(c.rollCount) || 0,
          pending: c.pendingFire === true,
          incoming: Number(c.lastIncomingAt) || 0,
          idle: Number(c.idleMs) || 0,
        }
        // 快照落盘 = 重启前的「上次」。只有全新会话才建基线，DSH 重启不再丢一段采样。
        const 上次_ = db.snap[k]
        if (!上次_) {
          db.snap[k] = 本次
          if (db.hits[k] == null) db.hits[k] = 0
          continue
        }
        db.hits[k] = db.hits[k] || 0
        db.rolls[k] = db.rolls[k] || 0
        db.sampledHits[k] = db.sampledHits[k] || 0
        db.resets[k] = db.resets[k] || 0
        db.hitRoll[k] = Number(db.hitRoll[k]) || 0
        db.intervals[k] = Array.isArray(db.intervals[k]) ? db.intervals[k] : []

        // 计数正常增长：把增长量计入总投骰
        if (本次.count > 上次_.count) db.rolls[k] += 本次.count - 上次_.count

        const 归零 = 本次.count < 上次_.count
        const 补发 = 上次_.pending === true && !本次.pending
        if (归零 || 补发) {
          // resetOnIncoming 收到对方消息也会把 count 清零、清掉 pendingFire，那是「本轮作废」。
          // 桥接只在收到对方消息时更新 lastIncomingAt，命中不会动它，也不会让 idle 掉到阈值以下。
          const 收到新消息 = 本次.incoming > (上次_.incoming || 0)
          const 安静不足 = 安静阈值 > 0 && 本次.idle < 安静阈值
          if (收到新消息 || 安静不足) {
            db.resets[k] += 1
            if (归零) db.rolls[k] += 本次.count
            db.armed[k] = false
          } else if (!归零) {
            // 纯补发：那一枪在计数归零时已经记过（或那时 DSH 没开），不再凭空补一次命中。
            db.armed[k] = false
          } else {
            if (归零) db.rolls[k] += 1 + 本次.count
            db.hits[k] += 1
            db.sampledHits[k] += 1
            // 口径 = 桥接本轮第几投：命中发生在「上次观测到的计数 + 1」投，
            // 与桥接 dice-hits.log 的 roll 同源，因此永远不会超过保底次数。
            // 不再用 rolls − hitRoll：那条累计账会把作废轮、DSH 重启断档并进同一轮，虚高到 100+。
            const 用了几投 = Math.max(1, (Number(上次_.count) || 0) + 1)
            db.intervals[k].push({ r: 用了几投, t: 现在, v: 2 })
            if (db.intervals[k].length > 50) db.intervals[k] = db.intervals[k].slice(-50)
            db.hitRoll[k] = db.rolls[k] // 兼容旧字段，1.2.4 起不再用于计算
            db.armed[k] = 本次.pending === true
          }
        }
        db.snap[k] = 本次
      }
      写命中(db)
    } catch {
      /* 桥接没开时静默跳过 */
    }
    return 投骰间隔
  }
  // 轮询间隔跟随投骰间隔：默认 5 秒；把 diceIntervalMs 调到 10 秒以下时自动加密，
  // 避免「命中 + 同一窗口内又投了几次」被合并成一次观测而漏算投骰数。
  ctx.effect(() => {
    let 停止 = false
    let 定时器 = null
    const 定间隔 = (投骰间隔) => Math.max(500, Math.min(5000, Math.floor(投骰间隔 / 2)))
    const 循环 = async () => {
      if (停止) return
      const 实际 = await 刷新命中()
      if (停止) return
      定时器 = setTimeout(循环, 定间隔(实际))
    }
    循环()
    return () => {
      停止 = true
      if (定时器) clearTimeout(定时器)
    }
  })

  // ── 实时投骰进度：代理 qq-bridge 控制台（自带 token，不外泄）──
  路线(`${路由前缀}/status`, async (req, res) => {
    try {
      const r = await 代理('GET', '/api/socialV2/proactive-status')
      if (!r.ok) throw new Error('桥接返回 ' + r.status)
      const j = await r.json()
      if (!j || j.ok !== true) throw new Error((j && j.error) || '桥接状态不可用')
      return 回(res, { ok: true, ...j })
    } catch (error) {
      return 回(res, { ok: false, 说: '读不到投骰状态：' + String((error && error.message) || error) })
    }
  })

  // ── 取 / 写回 proactive 配置 ──
  //   GET  → 取完整 proactive 配置（用于编辑界面）
  //   POST → 写回，桥接保存后立即按新节奏重排（即「生效」）
  路线(`${路由前缀}/config`, async (req, res) => {
    if (req.method === 'GET' || req.method == null) {
      try {
        const r = await 代理('GET', '/api/socialV2/config')
        if (!r.ok) throw new Error('桥接返回 ' + r.status)
        const j = await r.json()
        if (!j || j.ok !== true) throw new Error((j && j.error) || '桥接配置不可用')
        return 回(res, { ok: true, proactive: (j.config && j.config.proactive) || {} })
      } catch (error) {
        return 回(res, { ok: false, 说: '读不到配置：' + String((error && error.message) || error) })
      }
    }
    // POST
    let 体 = {}
    try {
      const d = await 读体(req)
      体 = d || {}
    } catch {
      /* ignore */
    }
    try {
      const r = await 代理('POST', '/api/socialV2/config', { proactive: 体.proactive || {} })
      const txt = await r.text()
      let j
      try {
        j = JSON.parse(txt)
      } catch {
        j = { ok: false, 说: txt.slice(0, 200) }
      }
      if (!r.ok) return 回(res, { ok: false, 说: '桥接返回 ' + r.status + (j && j.error ? ' ' + j.error : '') }, r.status)
      if (!j || j.ok !== true) return 回(res, { ok: false, 说: (j && j.error) || '保存失败' })
      return 回(res, { ok: true, proactive: (j.config && j.config.proactive) || {} })
    } catch (error) {
      return 回(res, { ok: false, 说: '保存失败：' + String((error && error.message) || error) })
    }
  })

  // ── 删除 / 恢复「不用定时对话」的会话 ──────────────────────────────────
  //  只写桥接 proactive.ignoredKeys 这一项（上游 merge，不动其它参数）。
  //  桥接保存后会遍历会话 cancel + schedule，被忽略的会话立即停掉投骰定时器。
  //  绝不调用 /api/socialV2/reset（那是全量重置：停 DSH 会话、归档、轮换令牌）。
  路线(`${路由前缀}/ignored`, async (req, res) => {
    if (req.method !== 'POST' && req.method != null) return 回(res, { ok: false, 说: '只支持 POST' }, 405)
    let 体 = {}
    try { 体 = (await 读体(req)) || {} } catch { /* 空体按校验失败处理 */ }
    const key = String(体.key || '').trim()
    const 动作 = String(体.action || '').trim()
    if (!/^(private|group):\d{1,15}$/.test(key)) return 回(res, { ok: false, 说: '会话 key 不合法' }, 400)
    if (动作 !== 'add' && 动作 !== 'remove') return 回(res, { ok: false, 说: 'action 只能是 add / remove' }, 400)
    try {
      const r0 = await 代理('GET', '/api/socialV2/config')
      const j0 = await r0.json()
      const 当前 = (j0 && j0.config && j0.config.proactive && Array.isArray(j0.config.proactive.ignoredKeys))
        ? j0.config.proactive.ignoredKeys.filter((x) => typeof x === 'string') : []
      const m = /^(private|group):(\d+)$/.exec(key)
      const 规范key = `${m[1]}:${Number(m[2])}`
      const 新名单 = 动作 === 'add'
        ? Array.from(new Set([...当前, 规范key]))
        : 当前.filter((x) => x !== 规范key && x !== key)
      const r1 = await 代理('POST', '/api/socialV2/config', { proactive: { ignoredKeys: 新名单 } })
      const txt = await r1.text()
      let j1
      try { j1 = JSON.parse(txt) } catch { j1 = { ok: false, 说: txt.slice(0, 200) } }
      if (!r1.ok || !j1 || j1.ok !== true) {
        return 回(res, { ok: false, 说: '桥接保存失败：' + ((j1 && (j1.error || j1.说)) || r1.status) })
      }
      // 删除时顺带清掉这个会话在本插件里的历史统计，避免汇总残留已移除会话的数字。
      // 这一步不可恢复，所以只在前端确认框里明确告知后才带 purgeHits=true。
      if (动作 === 'add' && 体.purgeHits === true) {
        const db = 读命中()
        for (const 字段 of Object.keys(db)) {
          if (db[字段] && typeof db[字段] === 'object' && !Array.isArray(db[字段])) delete db[字段][key]
        }
        写命中(db)
      }
      const 生效名单 = (j1.config && j1.config.proactive && j1.config.proactive.ignoredKeys) || 新名单
      return 回(res, { ok: true, ignoredKeys: 生效名单 })
    } catch (error) {
      return 回(res, { ok: false, 说: String((error && error.message) || error) })
    }
  })

  // ── 数据源读 / 写：令牌只留在宿主机，面板只拿得到「已设置 / 未设置」──
  路线(`${路由前缀}/datasource`, async (req, res) => {
    if (req.method === 'POST') {
      let 体 = {}
      try { 体 = (await 读体(req)) || {} } catch { /* 空体按原值处理 */ }
      const 旧 = 读源()
      const 模式 = ['auto', 'custom', 'demo'].includes(体.mode) ? 体.mode : 旧.mode
      const 新 = {
        mode: 模式,
        baseUrl: String(体.baseUrl != null ? 体.baseUrl : 旧.baseUrl).trim().replace(/\/+$/, ''),
        token: 体.clearToken === true ? ''
          : (String(体.token || '').trim() ? String(体.token).trim() : 旧.token),
        tokenHeader: String(体.tokenHeader || 旧.tokenHeader || 'x-console-token').trim(),
      }
      // 只允许 http(s)，避免面板把任意字符串当成 URL 发出去（SSRF 面）。
      if (新.baseUrl && !/^https?:\/\//i.test(新.baseUrl)) {
        return 回(res, { ok: false, 说: '地址必须以 http:// 或 https:// 开头' }, 400)
      }
      try { 写源(新) } catch (error) {
        return 回(res, { ok: false, 说: '保存失败：' + String((error && error.message) || error) }, 500)
      }
      探测缓存 = { at: 0, ok: false, 端口: 0, 令牌: '', 说: '' }
      let probe = null
      if (模式 === 'auto') {
        const 连 = await 自动探测(true)
        probe = { ok: 连.ok, 说: 连.说, 端口: 连.端口 }
      }
      return 回(res, { ok: true, datasource: 公开源(读源()), probe })
    }
    const 源 = 读源()
    let probe = null
    if (源.mode === 'auto') {
      const 连 = await 自动探测()
      probe = { ok: 连.ok, 说: 连.说, 端口: 连.端口 }
    }
    return 回(res, { ok: true, datasource: 公开源(源), probe })
  })

  // ── 本地累计统计：命中次数 + 投多少次命中一次 ──
  路线(`${路由前缀}/hits`, async (req, res) => {
    const db = 读命中()
    const 加总 = (o) => Object.values(o || {}).reduce((a, b) => a + (Number(b) || 0), 0)
    // 只统计 1.2.0 起的新口径记录；1.1.x 历史记录仍留在文件里，但不参与汇总、也不再显示在明细表。
    const 间隔 = Object.values(db.intervals || {})
      .flat()
      .filter((x) => x && x.v === 2)
      .map((x) => Number(x.r) || 0)
      .filter((n) => n > 0)
    const 总投骰 = 加总(db.rolls)
    // 主指标：每轮命中实际用了几投的均值（1.2.4 起 = 桥接 roll，与明细表、表格同口径）。
    const 每轮均值 = 间隔.length
      ? Math.round((间隔.reduce((a, b) => a + b, 0) / 间隔.length) * 10) / 10 : null
    return 回(res, {
      ok: true,
      hits: db.hits || {},
      rolls: db.rolls || {},
      sampledHits: db.sampledHits || {},
      intervals: db.intervals || {},
      resets: db.resets || {},
      summary: {
        totalRolls: 总投骰,
        sampledHits: 加总(db.sampledHits),
        totalHits: 加总(db.hits),
        totalResets: 加总(db.resets),
        avg: 每轮均值,
        // 1.2.4 起移除「全局投骰效率」：它与 avg 不同源，留着只会让面板出现第三个打架的数字。
        best: 间隔.length ? Math.min(...间隔) : null,
        worst: 间隔.length ? Math.max(...间隔) : null,
        records: 间隔.length,
      },
    })
  })
}

function 读体(req) {
  return new Promise((resolve) => {
    let d = ''
    req.on('data', (c) => (d += c))
    req.on('end', () => {
      try {
        resolve(d ? JSON.parse(d) : {})
      } catch {
        resolve({})
      }
    })
  })
}
