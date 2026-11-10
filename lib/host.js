// DSH「QQ 投骰进度」· 宿主半边
//
// 提供同源路由，由本插件（host 侧，运行在 DSH 主进程里）持有令牌去代理 qq-bridge
// 控制台的接口，**令牌不进前端**，避免泄露。上游地址与令牌来自本机配置（见 README）。
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

  // ── 桥接连接信息：全部来自「本机私有配置」或环境变量，源码里不含任何本机路径/密钥 ──
  // 优先级：环境变量 > local.config.json（该文件不进版本库）> 内置默认值。
  const 读本机配置 = () => {
    try {
      return JSON.parse(readFileSync(join(根目录, 'local.config.json'), 'utf8'))
    } catch {
      return {}
    }
  }
  const 连接 = () => {
    const c = 读本机配置()
    const 状态目录 = process.env.QQ_BRIDGE_STATE_DIR || c.stateDir || ''
    const 端口 = Number(process.env.QQ_BRIDGE_CONSOLE_PORT || c.consolePort || 3100)
    const 令牌文件 = process.env.QQ_BRIDGE_TOKEN_FILE || c.tokenFile || 'console-token'
    let 令牌 = process.env.QQ_BRIDGE_CONSOLE_TOKEN || ''
    if (!令牌 && 状态目录) {
      try {
        令牌 = readFileSync(join(状态目录, 令牌文件), 'utf8').trim()
      } catch {
        /* 未找到令牌文件则留空，下面会给出明确提示 */
      }
    }
    return { 状态目录, 端口, 令牌 }
  }

  const 代理 = async (方法, 路径名, 体 = null) => {
    const { 端口, 令牌 } = 连接()
    if (!令牌) throw new Error('尚未配置桥接连接信息：请按 README 创建 local.config.json，或设置 QQ_BRIDGE_STATE_DIR / QQ_BRIDGE_CONSOLE_TOKEN')
    const 头 = { 'cache-control': 'no-store', 'x-console-token': 令牌 }
    const 选项 = { method: 方法, headers: 头 }
    if (体 !== null) {
      头['content-type'] = 'application/json'
      选项.body = JSON.stringify(体)
    }
    return fetch(`http://127.0.0.1:${端口}${路径名}`, 选项)
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
    if (!existsSync(命中文件)) return 空统计()
    try {
      return 解析命中(readFileSync(命中文件, 'utf8'))
    } catch (error) {
      // 文件损坏：留档（不静默清空），优先从上一份原子写留下的备份恢复。
      try {
        if (existsSync(命中文件)) renameSync(命中文件, 命中文件 + '.corrupt-' + Date.now())
      } catch { /* 留档失败不阻断 */ }
      console.warn('[qq-dice] hits.json 解析失败，已留档并尝试从备份恢复：', String(error))
      try { return 解析命中(readFileSync(命中文件 + '.bak', 'utf8')) } catch { return 空统计() }
    }
  }
  const 写命中 = (o) => {
    try {
      const 文本 = JSON.stringify(o)
      const 临时 = 命中文件 + '.tmp'
      writeFileSync(临时, 文本)
      try { renameSync(临时, 命中文件) } catch { writeFileSync(命中文件, 文本) }
      // 成功落盘后同步一份完整备份；主文件万一损坏可直接恢复，不丢最后一轮采样。
      try { copyFileSync(命中文件, 命中文件 + '.bak') } catch { /* 备份失败不影响运行 */ }
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
      return 回(res, { ok: false, 说: '读不到桥接投骰状态（桥接可能没开）：' + String((error && error.message) || error) })
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
        return 回(res, { ok: false, 说: '读不到桥接配置：' + String((error && error.message) || error) })
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
