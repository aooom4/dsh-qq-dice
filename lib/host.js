// DSH「QQ 投骰进度」· 宿主半边
//
// 提供同源路由，由本插件（host 侧，运行在 DSH 主进程里）持有令牌去代理 qq-bridge
// 控制台的接口，**令牌不进前端**，避免泄露。上游地址与令牌来自本机配置（见 README）。
//
// 路由：
//   GET  /dsh-qq-dice/status   → 实时投骰进度
//   GET  /dsh-qq-dice/config   → 读取可编辑参数
//   POST /dsh-qq-dice/config   → 写回参数，立即生效
//   GET  /dsh-qq-dice/hits     → 本地累计的命中次数、投骰次数、每命中间隔（含平均）
//
// ⚠ 为什么不直接改 dsh-qq-bridge：
//   dsh-qq-bridge 是 GitHub 上独立安装的插件，DSH 一更新就会覆盖。
//   本插件是独立目录，跟它互不干扰，所以它更新也不会回退这里的投骰进度 / 修改界面。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
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
  //  hits        累计命中次数（历史值，兼容 1.0 的旧文件）
  //  rolls       自采样起累计投骰次数 —— 用来算「投多少次命中一次」
  //  sampledHits 自采样起命中次数（与 rolls 同一口径；旧文件没有投骰数，不能混算）
  //  intervals   每次命中实际用了几投：{ r: 投骰数, t: 时间戳 }，每会话保留最近 50 条
  //  resets      本轮投骰被「对方来消息」重置的次数（不算命中，也不算投骰）
  const 空统计 = () => ({ hits: {}, last: {}, rolls: {}, sampledHits: {}, intervals: {}, resets: {} })
  const 读命中 = () => {
    try {
      const d = JSON.parse(readFileSync(命中文件, 'utf8'))
      return {
        hits: d.hits || {},
        last: d.last || {},
        rolls: d.rolls || {},
        sampledHits: d.sampledHits || {},
        intervals: d.intervals || {},
        resets: d.resets || {},
      }
    } catch {
      return 空统计()
    }
  }
  const 写命中 = (o) => {
    try {
      writeFileSync(命中文件, JSON.stringify(o))
    } catch {
      /* 落盘失败不影响运行 */
    }
  }
  // 上次见到的每个会话快照：{ count, pending, incoming }
  let 上次 = {}
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
      const 现在 = Date.now()
      for (const c of j.conversations) {
        const k = c.key
        const 本次 = {
          count: Number(c.rollCount) || 0,
          pending: c.pendingFire === true,
          incoming: Number(c.lastIncomingAt) || 0,
          idle: Number(c.idleMs) || 0,
        }
        const 上次_ = 上次[k]
        // 首次观测（或插件刚重启）只建立基线，不算投骰也不算命中
        if (!上次_) {
          上次[k] = 本次
          if (db.hits[k] == null) db.hits[k] = 0
          continue
        }
        db.hits[k] = db.hits[k] || 0
        db.rolls[k] = db.rolls[k] || 0
        db.sampledHits[k] = db.sampledHits[k] || 0
        db.resets[k] = db.resets[k] || 0
        db.intervals[k] = Array.isArray(db.intervals[k]) ? db.intervals[k] : []

        // 计数正常增长：把增长量计入总投骰
        if (本次.count > 上次_.count) db.rolls[k] += 本次.count - 上次_.count

        const 归零 = 本次.count < 上次_.count
        const 补发 = 上次_.pending && !本次.pending
        if (归零 || 补发) {
          // ⚠ 核心修复：resetOnIncoming 收到对方消息时也会把 count 清零、并清掉 pendingFire，
          //   但那是「本轮作废」，不是命中。桥接只在收到对方消息（isSelf:false）时更新
          //   lastIncomingAt，命中不会动它，也不会让 idleMs 掉到安静阈值以下。
          //   取舍：宁可在「命中后对方秒回」的极端情况漏记一次，也绝不把重置误算成命中。
          const 收到新消息 = 本次.incoming > (上次_.incoming || 0)
          const 安静不足 = 安静阈值 > 0 && 本次.idle < 安静阈值
          if (收到新消息 || 安静不足) {
            db.resets[k] += 1
            // 归零后到本次观测之间新投的次数仍是真实投骰；重置动作本身不算投骰。
            if (归零) db.rolls[k] += 本次.count
          } else {
            // 补上被归零抹掉的那一投，以及归零后新投的次数（短间隔时可能 >0）
            if (归零) db.rolls[k] += 1 + 本次.count
            db.hits[k] += 1
            db.sampledHits[k] += 1
            const 用了几投 = 归零 ? 上次_.count + 1 : Math.max(1, 上次_.count || 本次.count || 1)
            db.intervals[k].push({ r: 用了几投, t: 现在 })
            if (db.intervals[k].length > 50) db.intervals[k] = db.intervals[k].slice(-50)
          }
        }
        上次[k] = 本次
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

  // ── 本地累计统计：命中次数 + 投多少次命中一次 ──
  路线(`${路由前缀}/hits`, async (req, res) => {
    const db = 读命中()
    const 加总 = (o) => Object.values(o || {}).reduce((a, b) => a + (Number(b) || 0), 0)
    const 间隔 = Object.values(db.intervals || {})
      .flat()
      .map((x) => Number(x && x.r) || 0)
      .filter((n) => n > 0)
    const 总投骰 = 加总(db.rolls)
    const 采样命中 = 加总(db.sampledHits)
    return 回(res, {
      ok: true,
      hits: db.hits || {},
      rolls: db.rolls || {},
      sampledHits: db.sampledHits || {},
      intervals: db.intervals || {},
      resets: db.resets || {},
      // 全局汇总：平均 = 累计投骰次数 ÷ 命中次数（同口径采样数据）
      summary: {
        totalRolls: 总投骰,
        sampledHits: 采样命中,
        totalHits: 加总(db.hits),
        totalResets: 加总(db.resets),
        avg: 采样命中 > 0 ? Math.round((总投骰 / 采样命中) * 10) / 10 : null,
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
