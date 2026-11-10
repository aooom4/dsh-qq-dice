// DSH「QQ 投骰进度」· 网页半边
//
// 在 **DSH 设置** 左侧栏加一项「🎲 投骰进度」，包含三块：
//   1) 投多少次命中一次 —— 平均命中间隔、每次命中的实际投骰数（本地采样）
//   2) 命中统计表格 —— 每个会话的投骰 / 命中进度（实时）
//   3) 参数修改界面 —— 直接改 proactive 参数，保存即写回桥接端立即生效
//
// ⚠ 这里**不碰会话、不发消息**，只读 /dsh-qq-dice/status、/hits，写 /dsh-qq-dice/config。
//   真正的状态来自 qq-bridge 控制台，由 host.js 代理（令牌不外泄）。

window.__ModuleLoader__.load({
  id: 'dsh-qq-dice',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const inject = ['slots']
    const h = React.createElement

    const B = '/dsh-qq-dice'
    const get = (p) => fetch(B + p, { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
    const post = (p, body) =>
      fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
        .then((r) => r.json())
        .catch(() => ({ ok: false, 说: '网络错误' }))

    // ── 样式（跟 DSH 主题变量对齐）──
    const S = {
      card: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        padding: '12px 14px',
        marginBottom: 12,
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      h: { fontSize: 14, fontWeight: 600, margin: '2px 0 10px' },
      dim: { opacity: 0.6, fontSize: 12 },
      lab: { minWidth: 150, paddingTop: 4, fontSize: 12.5, opacity: 0.9 },
      ctl: { flex: '1 1 200px', minWidth: 180 },
      提示: { fontSize: 11.5, opacity: 0.55, marginTop: 3 },
      消息: { margin: '6px 0 10px', fontSize: 12, fontWeight: 600 },
    }
    const 输入框样式 = {
      padding: '5px 8px',
      borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'inherit',
      width: '100%',
      boxSizing: 'border-box',
      fontSize: 13,
    }
    const 表样式 = { width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }
    const 表头样式 = {
      textAlign: 'left',
      padding: '7px 9px',
      borderBottom: '1px solid var(--dsw-alias-border-l2)',
      whiteSpace: 'nowrap',
      opacity: 0.78,
      fontWeight: 600,
    }
    const 表体样式 = { padding: '7px 9px', borderBottom: '1px solid var(--dsw-alias-border-l2)', whiteSpace: 'nowrap' }
    const 小按钮样式 = {
      padding: '2px 7px',
      borderRadius: 5,
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'inherit',
      cursor: 'pointer',
      fontSize: 11.5,
      lineHeight: 1.6,
    }

    const 状态中文 = {
      rolling: '投骰中',
      disabled: '已关闭',
      'non-dice': '非投骰模式',
      'not-allowed': '当前模式不允许',
      'pending-retry': '待补发',
      'idle-not-enough': '安静不够',
      'quiet-hours': '静音时段',
      'deferred-chat': '被延后',
    }

    // 静音时段：界面用 "23-8" 文本，写回桥接时转成 [[23,8], ...]
    const 静音转文本 = (q) =>
      Array.isArray(q) ? q.filter((r) => Array.isArray(r) && r.length >= 2).map((r) => `${r[0]}-${r[1]}`).join(', ') : ''
    const 解析静音 = (s) => {
      const t = String(s || '').trim()
      if (!t) return []
      const 段 = t.split(/[,，;；]/).map((x) => x.trim()).filter(Boolean)
      const 结果 = []
      for (const 一项 of 段) {
        const m = /^(\d{1,2})(?::\d{2})?\s*[-~～至]\s*(\d{1,2})(?::\d{2})?$/.exec(一项)
        if (!m) return null
        const a = Number(m[1]); const b = Number(m[2])
        if (a > 23 || b > 23 || a === b) return null
        结果.push([a, b])
      }
      return 结果
    }

    // 把桥接返回的 proactive 段规整成可编辑表单的初始值
    const 规范 = (p) => ({
      mode: p.mode || 'dice',
      enabled: p.enabled !== false,
      diceGuaranteeCount: Number(p.diceGuaranteeCount) || 90,
      diceIntervalMs: Math.max(1000, Number(p.diceIntervalMs) || 60000),
      idleThresholdMs: Math.max(0, Number(p.idleThresholdMs) || 60000),
      diceBaseProbability: Number(p.diceBaseProbability != null ? p.diceBaseProbability : 0.006),
      diceRampStart: Number(p.diceRampStart || 74),
      diceRampStep: Number(p.diceRampStep != null ? p.diceRampStep : 0.06),
      probability: Number(p.probability != null ? p.probability : 0.3),
      resetOnIncoming: p.resetOnIncoming !== false,
      quietHoursText: 静音转文本(p.quietHours),
      skipGatedTicks: p.skipGatedTicks !== false,
      // 保存参数时会一起原样写回，避免把「已删除」的名单冲掉
      ignoredKeys: Array.isArray(p.ignoredKeys) ? p.ignoredKeys.filter((x) => typeof x === 'string') : [],
    })

    const 短key = (k) => {
      if (typeof k !== 'string') return String(k)
      const i = k.indexOf(':')
      return i >= 0 ? k.slice(i + 1) : k
    }

    // ── 每会话「投几次中一次」：用每轮命中间隔的均值，与汇总、明细同口径 ──
    const 每会话均值 = (k, 效率) => {
      const arr = 效率 && 效率.intervals ? 效率.intervals[k] : null
      if (!Array.isArray(arr) || arr.length === 0) return '—'
      const 值 = arr.filter((x) => x && x.v === 2).map((x) => Number(x.r) || 0).filter((n) => n > 0)
      if (!值.length) return '—'
      return (Math.round((值.reduce((a, b) => a + b, 0) / 值.length) * 10) / 10).toFixed(1)
    }

    // ── 命中统计表格 ──
    function 命中表格(状态, 命中, 效率, 编辑, 操作) {
      const 列表 = 状态 && Array.isArray(状态.conversations) ? 状态.conversations : []
      if (列表.length === 0) return h('div', { style: S.dim }, '（暂无会话数据）')
      const th = (t) => h('th', { style: 表头样式 }, t)
      const 安静阈值 = Number(状态 && 状态.idleThresholdMs) || 0
      // 进加码段之前「距保底」只是个倒数，没有信息量：改显示「本轮已安静多久」，
      // 等真正接近保底、概率开始爬升时再显示还剩几投。
      const 加码起点 = Math.max(1, Number(编辑 && 编辑.diceRampStart) || 74)
      const 行们 = 列表.map((c) => {
        // 门控不放行时定时器仍会跑但计数冻结，不能显示「下一投 / 命中率」造成推进的错觉。
        const 投骰中 = c.status === 'rolling' || c.status === 'pending-retry'
        const 还差 = Math.max(0, 安静阈值 - (Number(c.idleMs) || 0))
        const 下一投 = !投骰中
          ? (c.status === 'idle-not-enough' ? '还需安静 ' + Math.ceil(还差 / 60000) + ' 分'
            : c.status === 'quiet-hours' ? '静音中'
            : c.status === 'deferred-chat' ? '等新消息'
            : '暂停中')
          : (c.nextRollInMs != null ? Math.ceil(c.nextRollInMs / 1000) + ' 秒' : (c.timerActive ? '计时中' : '—'))
        const 命中率 = !投骰中 ? '—'
          : (c.nextProbability != null ? (Number(c.nextProbability) * 100).toFixed(1) + '%' : '—')
        const 已投 = Number(c.rollCount) || 0
        const 安静保底 = 投骰中 && 已投 >= 加码起点 && c.guaranteeLeft != null
          ? '距保底 ' + c.guaranteeLeft + ' 投'
          : '安静 ' + Math.floor((Number(c.idleMs) || 0) / 60000) + ' 分'
        return h(
          'tr',
          { key: c.key },
          h('td', { style: 表体样式, title: c.key }, 短key(c.key)),
          h('td', { style: 表体样式 }, 状态中文[c.status] || c.status),
          h('td', { style: 表体样式 }, String(Number(c.rollCount) || 0)),
          h('td', { style: 表体样式, title: c.guaranteeLeft != null ? '距保底 ' + c.guaranteeLeft + ' 投' : undefined }, 安静保底),
          h('td', { style: 表体样式 }, 命中率),
          h('td', { style: 表体样式 }, 下一投),
          h('td', { style: 表体样式 }, c.pendingFire ? '⚠ 待补发' : '—'),
          h('td', { style: { ...表体样式, fontWeight: 600 } }, String((命中 && 命中[c.key]) || 0)),
          h('td', { style: { ...表体样式, fontWeight: 600 } }, 每会话均值(c.key, 效率)),
          h('td', { style: 表体样式 }, String((效率 && 效率.resets && 效率.resets[c.key]) || 0)),
          h('td', { style: 表体样式 },
            h('button', {
              type: 'button',
              title: '移除该会话：停止定时投骰、从表格消失并清除它的统计（可在下方恢复）',
              disabled: 操作.名单中 === c.key,
              style: 小按钮样式,
              onClick: () => 操作.删(c.key),
            }, 操作.名单中 === c.key ? '…' : '✕ 移除'),
          ),
        )
      })
      return h(
        'div',
        { style: { overflowX: 'auto' } },
        h(
          'table',
          { style: 表样式 },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              th('会话'),
              th('状态'),
              th('本轮已投'),
              th('安静 / 保底'),
              th('下次命中率'),
              th('下一投'),
              th('待补发'),
              th('累计命中'),
              th('投几次中一次'),
              th('被重置'),
              th('操作'),
            ),
          ),
          h('tbody', null, 行们),
        ),
      )
    }

    // ── 「投多少次命中一次」汇总 + 最近每次命中的实际投骰数 ──
    function 命中效率(效率) {
      const s = (效率 && 效率.summary) || {}
      const th = (t) => h('th', { style: 表头样式 }, t)
      const 有均值 = s.avg != null

      // 只显示新口径（v:2）记录：升级前的旧记录数值不可信，混进来会让「共 N 轮」和明细对不上。
      const 记录 = []
      let 隐藏旧记录 = 0
      const iv = (效率 && 效率.intervals) || {}
      for (const k of Object.keys(iv)) {
        const arr = Array.isArray(iv[k]) ? iv[k] : []
        for (const it of arr) {
          if (!it || it.v !== 2) { 隐藏旧记录 += 1; continue }
          记录.push({ k, r: Number(it.r) || 0, t: Number(it.t) || 0 })
        }
      }
      记录.sort((a, b) => b.t - a.t)
      const 最近 = 记录.slice(0, 10)
      // 带日期：只写「19:08」会把昨天和今天两条混在一起，看起来像重复 / 顺序错乱。
      const 时间 = (t) => {
        if (!t) return '—'
        try {
          const d = new Date(t)
          const 补 = (n) => String(n).padStart(2, '0')
          return `${补(d.getMonth() + 1)}-${补(d.getDate())} ${补(d.getHours())}:${补(d.getMinutes())}`
        } catch {
          return '—'
        }
      }

      return h(
        'div',
        null,
        h(
          'div',
          { style: { display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', marginBottom: 6 } },
          h(
            'span',
            { style: { fontSize: 26, fontWeight: 700, color: 'var(--dsw-alias-state-business-primary)' } },
            有均值 ? String(s.avg) : '—',
          ),
          h('span', { style: S.dim }, '次投骰命中一次（平均）'),
        ),
        h(
          'div',
          { style: S.提示 },
            有均值
              ? `共 ${s.records || 0} 轮命中 · 最快 ${s.best} 投 · 最慢 ${s.worst} 投 · 被重置 ${s.totalResets || 0} 次（与桥接「第几投命中」同源，不超过保底次数）`
              : s.totalHits > 0
              ? `已有 ${s.totalHits} 次历史命中（1.2.0 之前的旧口径，仍保留在下方明细里）。新口径从升级后重新采样，等下一次命中就会显示平均。`
              : `还没有命中记录：等第一次命中后，这里会算出平均要投多少次才中一次。${s.totalResets ? ` 期间本轮投骰被对方消息重置了 ${s.totalResets} 次，已正确排除。` : ''}`,
        ),
        h('div', { style: { ...S.h, fontSize: 12.5, margin: '14px 0 6px' } }, '最近每次命中用了几投'),
        最近.length === 0
          ? h('div', { style: S.dim }, '（暂无记录）')
          : h(
              'div',
              { style: { overflowX: 'auto' } },
              h(
                'table',
                { style: 表样式 },
                h('thead', null, h('tr', null, th('会话'), th('用了几投'), th('时间'))),
                h(
                  'tbody',
                  null,
                  最近.map((it, i) =>
                    h(
                      'tr',
                      { key: it.k + '-' + it.t + '-' + i },
                      h('td', { style: 表体样式, title: it.k }, 短key(it.k)),
                      h('td', { style: { ...表体样式, fontWeight: 600 } }, String(it.r)),
                      h('td', { style: 表体样式 }, 时间(it.t)),
                    ),
                  ),
                ),
              ),
            ),
        隐藏旧记录 > 0
          ? h('div', { style: { ...S.提示, marginTop: 4 } },
              `已隐藏 ${隐藏旧记录} 条升级前的旧口径记录（数值不可信，仍保留在 state/hits.json 里，不计入平均）`)
          : null,
      )
    }

    function Section() {
      const [状态, 设状态] = React.useState(null)
      const [命中, 设命中] = React.useState({})
      const [效率, 设效率] = React.useState(null)
      const [编辑, 设编辑] = React.useState(null)
      const [存中, 设存中] = React.useState(false)
      const [消息, 设消息] = React.useState(null)

      // 拉状态 + 累计命中/效率，每 3 秒刷新（栏目打开才挂载，关掉即卸载）
      // 提到组件作用域，删除 / 恢复后也能立即重拉一次，不用等下一轮轮询。
      const 拉 = React.useCallback(async () => {
        const s = await get('/status')
        if (s) 设状态(s)
        const hh = await get('/hits')
        if (hh && hh.ok) {
          设命中(hh.hits || {})
          设效率({
            rolls: hh.rolls || {},
            sampledHits: hh.sampledHits || {},
            intervals: hh.intervals || {},
            resets: hh.resets || {},
            summary: hh.summary || {},
          })
        }
      }, [])
      React.useEffect(() => {
        拉()
        const t = setInterval(拉, 3000)
        return () => clearInterval(t)
      }, [拉])

      // 取完整配置（用于编辑），进页面拉一次
      React.useEffect(() => {
        get('/config')
          .then((r) => {
            if (r && r.ok) 设编辑(规范(r.proactive || {}))
          })
          .catch(() => {})
      }, [])

      const [名单中, 设名单中] = React.useState('')

      // 删除 = 加入桥接的忽略名单（停投骰 + 从表格消失 + 清统计）；恢复 = 从名单移除。
      // 只动 proactive.ignoredKeys 这一项，不动 DSH 会话映射 / 消息收发 / 令牌。
      const 改名单 = async (key, 动作) => {
        const 清统计 = 动作 === 'add'
        if (清统计 && !window.confirm(
          `确定移除会话 ${key} 吗？\n\n` +
          '· 立刻停止它的定时投骰，并从本表格消失\n' +
          '· 同时清除它在本插件里的历史命中统计（不可恢复）\n' +
          '· 不影响 QQ 消息收发与 DSH 会话映射\n\n' +
          '会话本身可在下方「已忽略」里一键恢复。'
        )) return
        设名单中(key)
        设消息(null)
        const r = await post('/ignored', { key, action: 动作, purgeHits: 清统计 })
        设名单中('')
        if (r && r.ok) {
          设编辑((e) => (e ? { ...e, ignoredKeys: r.ignoredKeys || [] } : e))
          设消息({ ok: true, 说: 动作 === 'add' ? '已移除：该会话不再定时投骰，历史统计已清除' : '已恢复：该会话重新开始定时投骰' })
          await 拉()
        } else {
          设消息({ ok: false, 说: (r && r.说) || '操作失败' })
        }
      }
      const 忽略名单 = Array.isArray(编辑 && 编辑.ignoredKeys)
        ? 编辑.ignoredKeys
        : (Array.isArray(状态 && 状态.ignoredKeys) ? 状态.ignoredKeys : [])

      const 改 = (k, v) => 设编辑((e) => (e ? { ...e, [k]: v } : e))
      const 校验 = (e) => {
        if (!e) return '配置还没读到'
        if (e.mode === 'dice') {
          if (!(e.diceIntervalMs >= 1000)) return '投骰间隔至少 1 秒'
          if (!(e.diceGuaranteeCount >= 1)) return '保底次数至少 1 次'
          if (e.diceRampStart >= e.diceGuaranteeCount) return '加码起点必须小于保底次数，否则加码段永远到不了、会提前保底'
        }
        return null
      }
      const 保存 = async () => {
        const 错 = 校验(编辑)
        if (错) { 设消息({ ok: false, 说: 错 }); return }
        const 静音 = 解析静音(编辑 && 编辑.quietHoursText)
        if (静音 === null) {
          设消息({ ok: false, 说: '静音时段格式应为 23-8（也可写 23:00-08:00），多段用逗号分隔，小时 0~23 且起止不能相同' })
          return
        }
        const 提交 = { ...编辑, quietHours: 静音 }
        delete 提交.quietHoursText
        设存中(true)
        设消息(null)
        const r = await post('/config', { proactive: 提交 })
        设存中(false)
        if (r && r.ok) {
          设编辑(规范(r.proactive || 编辑))
          设消息({ ok: true, 说: '已保存，桥接已按新节奏重排，立即生效' })
        } else {
          设消息({ ok: false, 说: (r && r.说) || '保存失败' })
        }
      }

      // ── 输入控件 ──
      const 秒输入 = (k) =>
        h('input', {
          type: 'number',
          min: 0,
          step: 1,
          value: Math.max(0, Math.round((编辑[k] || 0) / 1000)),
          style: 输入框样式,
          onChange: (e) => 改(k, Math.max(0, Number(e.target.value) || 0) * 1000),
        })
      const 概率输入 = (k, step) =>
        h('input', {
          type: 'number',
          min: 0,
          max: 1,
          step,
          value: Number(编辑[k] != null ? 编辑[k] : 0),
          style: 输入框样式,
          onChange: (e) => 改(k, Math.min(1, Math.max(0, Number(e.target.value) || 0))),
        })
      const 整数输入 = (k) =>
        h('input', {
          type: 'number',
          min: 0,
          step: 1,
          value: Math.max(0, Math.floor(Number(编辑[k]) || 0)),
          style: 输入框样式,
          onChange: (e) => 改(k, Math.max(0, Math.floor(Number(e.target.value) || 0))),
        })
      const 勾选 = (k) =>
        h('input', {
          type: 'checkbox',
          checked: 编辑[k] === true,
          style: { width: 16, height: 16 },
          onChange: (e) => 改(k, e.target.checked),
        })

      const 行 = (标签, 控件, 说明) =>
        h(
          'div',
          { style: { display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 9, flexWrap: 'wrap' } },
          h('div', { style: S.lab }, 标签),
          h('div', { style: S.ctl }, 控件, 说明 ? h('div', { style: S.提示 }, 说明) : null),
        )

      const 间隔秒 = (状态 && 状态.diceIntervalMs) || 60000

      return h(
        'div',
        null,
        h(
          'div',
          { style: S.dim },
          '主动消息投骰进度（dice 模式）：对方安静满 ' +
            Math.round((状态 ? 状态.idleThresholdMs || 300000 : 300000) / 60000) +
            ' 分钟后，每 ' + Math.round(间隔秒 / 1000) +
            ' 秒投一次，命中才触发一次主动冒泡（AI 可能选择不回）；投满 ' +
            (状态 ? 状态.guaranteeCount || 90 : 90) +
            ' 次强制命中。',
        ),
        消息
          ? h('div', { style: { ...S.消息, color: 消息.ok ? '#2e7d32' : '#c0392b' } }, (消息.ok ? '✓ ' : '⚠ ') + 消息.说)
          : null,

        // ── 1) 投多少次命中一次 ──
        h(
          'div',
          { style: S.card },
          h('div', { style: S.h }, '投多少次命中一次'),
          效率 == null ? h('div', { style: S.dim }, '读取中…') : 命中效率(效率),
          h(
            'div',
            { style: S.提示 },
            '平均 = 每轮命中实际用了几投的均值，与下方明细、表格同一口径；自适应轮询采样、原子落盘 state/hits.json，DSH 重启续算不丢。「命中」指触发了一次主动唤醒，不等于真的发出消息。',
          ),
        ),

        // ── 2) 命中统计表格 ──
        h(
          'div',
          { style: S.card },
          h('div', { style: S.h }, '命中统计'),
          状态 == null
            ? h('div', { style: S.dim }, '读取中…')
            : 状态.ok !== true
              ? h('div', { style: { ...S.消息, color: '#c0392b' } }, '⚠ ' + (状态.说 || '读不到桥接状态（桥接可能没开）'))
              : 命中表格(状态, 命中, 效率, 编辑, { 删: (k) => 改名单(k, 'add'), 名单中 }),
          忽略名单.length > 0
            ? h(
                'div',
                { style: { marginTop: 10, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, fontSize: 12 } },
                h('span', { style: S.dim }, `已忽略 ${忽略名单.length} 个会话（不再投骰，可随时恢复）：`),
                忽略名单.map((k) =>
                  h(
                    'span',
                    { key: k, style: { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 6px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2)' } },
                    h('span', { style: { fontFamily: 'monospace' }, title: k }, 短key(k)),
                    h('button', { type: 'button', title: '恢复定时投骰', disabled: 名单中 === k, style: 小按钮样式, onClick: () => 改名单(k, 'remove') }, '恢复'),
                  ),
                ),
              )
            : null,
          h(
            'div',
            { style: S.提示 },
            '「本轮已投」= 距上次命中已投的次数；「投几次中一次」是该会话每轮命中间隔的均值，与上方汇总同源。「安静 / 保底」在前段显示对方已安静多久，进入加码段后改显示距保底还剩几投。门控期（安静不够 / 静音 / 延后）不投也不计数，故不显示倒计时与命中率。「被重置」= 对方发消息导致本轮作废的次数。不用定时对话的会话点「✕ 移除」即可停投并从表格清掉，历史统计会一并清除，可在下方「已忽略」里恢复。',
          ),
        ),

        // ── 3) 参数修改界面 ──
        h(
          'div',
          { style: S.card },
          h('div', { style: S.h }, '参数修改（保存即生效）'),
          编辑 == null
            ? h('div', { style: S.dim }, '配置读取中…')
            : h(
                'div',
                null,
                行('模式', h('select', { value: 编辑.mode || 'dice', style: 输入框样式, onChange: (e) => 改('mode', e.target.value) },
                  h('option', { value: 'dice' }, 'dice（投骰，命中才发）'),
                  h('option', { value: 'always' }, 'always（安静够就发）'),
                  h('option', { value: 'random' }, 'random（小概率主动）'),
                )),
                行('启用投骰', 勾选('enabled')),
                行('保底次数', 整数输入('diceGuaranteeCount'), '投满这么多次后强制命中（进入加码段后表格会显示「距保底 N 投」）'),
                行('投骰间隔(秒)', 秒输入('diceIntervalMs'), '每安静这么久投一次骰，至少 1 秒'),
                行('安静阈值(秒)', 秒输入('idleThresholdMs'), '对方安静这么久才开始投骰'),
                行('静音时段', h('input', { type: 'text', value: 编辑.quietHoursText || '', placeholder: '23-8，留空=不静音', style: 输入框样式, onChange: (e) => 改('quietHoursText', e.target.value) }), '本地时间，左闭右开、可跨零点；多段用逗号分隔。保存后立即生效，不用重启'),
                行('基础命中率', 概率输入('diceBaseProbability', '0.001'), '前 diceRampStart-1 次恒为这个概率（0~1）'),
                行('加码起点(次)', 整数输入('diceRampStart'), '从第几次开始每次累加命中率，至少第 2 次'),
                行('每次加码', 概率输入('diceRampStep', '0.01'), '第加码起点次起，每次 +这个概率（0~1）'),
                行('random 概率', 概率输入('probability', '0.01'), 'random 模式下的主动概率（0~1）'),
                行('新消息重置计时', 勾选('resetOnIncoming'), 'always 模式下，收到新消息就把主动计时重置'),
                h(
                  'div',
                  { style: { marginTop: 4, display: 'flex', gap: 10, alignItems: 'center' } },
                  h(
                    'button',
                    {
                      onClick: 保存,
                      disabled: 存中,
                      style: {
                        padding: '7px 16px',
                        borderRadius: 6,
                        border: '1px solid var(--dsw-alias-state-business-primary)',
                        background: 'var(--dsw-alias-state-business-primary)',
                        color: '#fff',
                        fontWeight: 600,
                        cursor: 存中 ? 'default' : 'pointer',
                        opacity: 存中 ? 0.6 : 1,
                      },
                    },
                    存中 ? '保存中…' : '保存',
                  ),
                  消息
                    ? h('span', { style: { ...S.消息, color: 消息.ok ? '#2e7d32' : '#c0392b' } }, (消息.ok ? '✓ ' : '⚠ ') + 消息.说)
                    : null,
                ),
              ),
        ),
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () =>
        slots.register(
          { name: 'settings.section', id: 'qq-dice', order: 56, label: () => '🎲 投骰进度' },
          Section,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
