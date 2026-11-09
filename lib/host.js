// DSH「QQ 投骰进度」· 宿主半边
//
// 提供同源路由，由本插件（host 侧，运行在 DSH 主进程里）持有令牌去代理 qq-bridge
// 控制台的接口，**令牌不进前端**，避免泄露。上游地址与令牌来自本机配置（见 README）。
//
// 路由：
//   GET  /dsh-qq-dice/status   → 实时投骰进度
//   GET  /dsh-qq-dice/config   → 读取可编辑参数
//   POST /dsh-qq-dice/config   → 写回参数，立即生效
//   GET  /dsh-qq-dice/hits     → 本地累计的命中次数
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

  // ── 本地累计命中次数（桥接端不记录累计命中，命中后 proactiveDiceCount 归零）──
  const 读命中 = () => {
    try {
      return JSON.parse(readFileSync(命中文件, 'utf8'))
    } catch {
      return { hits: {}, last: {} }
    }
  }
  const 写命中 = (o) => {
    try {
      writeFileSync(命中文件, JSON.stringify(o))
    } catch {
      /* 落盘失败不影响运行 */
    }
  }
  // 上次见到的每个会话快照：{ count, pending }
  let 上次 = {}
  const 刷新命中 = async () => {
    try {
      const r = await 代理('GET', '/api/socialV2/proactive-status')
      if (!r.ok) return
      const j = await r.json()
      if (!j || j.ok !== true || !Array.isArray(j.conversations)) return
      const db = 读命中()
      for (const c of j.conversations) {
        const k = c.key
        const 上次_ = 上次[k] || { count: Number(c.rollCount) || 0, pending: c.pendingFire === true }
        const 本次 = { count: Number(c.rollCount) || 0, pending: c.pendingFire === true }
        // 计数回退（命中后归零）即一次命中；待补发由 true→false 即一次补发命中。
        if (本次.count < 上次_.count) db.hits[k] = (db.hits[k] || 0) + 1
        if (上次_.pending && !本次.pending) db.hits[k] = (db.hits[k] || 0) + 1
        if (db.hits[k] == null) db.hits[k] = 0
        上次[k] = 本次
      }
      写命中(db)
    } catch {
      /* 桥接没开时静默跳过 */
    }
  }
  // 启动即刷一次，之后每 5 秒刷（面板关着也能累计）
  ctx.effect(() => {
    刷新命中()
    const t = setInterval(刷新命中, 5000)
    return () => clearInterval(t)
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

  // ── 本地累计命中次数 ──
  路线(`${路由前缀}/hits`, async (req, res) => {
    const db = 读命中()
    return 回(res, { ok: true, hits: db.hits || {} })
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
