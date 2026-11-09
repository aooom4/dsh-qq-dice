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
    })

    const 短key = (k) => {
      if (typeof k !== 'string') return String(k)
      const i = k.indexOf(':')
      return i >= 0 ? k.slice(i + 1) : k
    }

    // ── 每会话「投几次中一次」──
    const 每会话均值 = (k, 效率) => {
      const 命中数 = 效率 && 效率.sampledHits ? Number(效率.sampledHits[k]) || 0 : 0
      const 投骰数 = 效率 && 效率.rolls ? Number(效率.rolls[k]) || 0 : 0
      return 命中数 > 0 ? (Math.round((投骰数 / 命中数) * 10) / 10).toFixed(1) : '—'
    }

    // ── 命中统计表格 ──
    function 命中表格(状态, 命中, 效率) {
      const 列表 = 状态 && Array.isArray(状态.conversations) ? 状态.conversations : []
      if (列表.length === 0) return h('div', { style: S.dim }, '（暂无会话数据）')
      const th = (t) => h('th', { style: 表头样式 }, t)
      const 行们 = 列表.map((c) =>
        h(
          'tr',
          { key: c.key },
          h('td', { style: 表体样式, title: c.key }, 短key(c.key)),
          h('td', { style: 表体样式 }, 状态中文[c.status] || c.status),
          h('td', { style: 表体样式 }, String(Number(c.rollCount) || 0)),
          h('td', { style: 表体样式 }, c.guaranteeLeft != null ? String(c.guaranteeLeft) : '—'),
          h('td', { style: 表体样式 }, c.nextProbability != null ? (Number(c.nextProbability) * 100).toFixed(1) + '%' : '—'),
          h('td', { style: 表体样式 }, c.nextRollInMs != null ? Math.ceil(c.nextRollInMs / 1000) + ' 秒' : c.timerActive ? '计时中' : '—'),
          h('td', { style: 表体样式 }, c.pendingFire ? '⚠ 待补发' : '—'),
          h('td', { style: { ...表体样式, fontWeight: 600 } }, String((命中 && 命中[c.key]) || 0)),
          h('td', { style: { ...表体样式, fontWeight: 600 } }, 每会话均值(c.key, 效率)),
        ),
      )
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
              th('距保底'),
              th('下次命中率'),
              th('下一投'),
              th('待补发'),
              th('累计命中'),
              th('投几次中一次'),
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
      const 有均值 = s.avg != null && s.sampledHits > 0

      // 把所有会话的命中记录合并，按时间倒序取最近 10 条
      const 记录 = []
      const iv = (效率 && 效率.intervals) || {}
      for (const k of Object.keys(iv)) {
        const arr = Array.isArray(iv[k]) ? iv[k] : []
        for (const it of arr) 记录.push({ k, r: Number(it && it.r) || 0, t: Number(it && it.t) || 0 })
      }
      记录.sort((a, b) => b.t - a.t)
      const 最近 = 记录.slice(0, 10)
      const 时间 = (t) => {
        if (!t) return '—'
        try {
          return new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
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
            ? `累计投骰 ${s.totalRolls || 0} 次 ÷ 命中 ${s.sampledHits} 次 · 最快 ${s.best} 投 · 最慢 ${s.worst} 投 · 共 ${s.records} 次命中记录`
            : '还没有命中记录：等第一次命中后，这里会算出平均要投多少次才中一次。',
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
      React.useEffect(() => {
        const 拉 = async () => {
          const s = await get('/status')
          if (s) 设状态(s)
          const hh = await get('/hits')
          if (hh && hh.ok) {
            设命中(hh.hits || {})
            设效率({
              rolls: hh.rolls || {},
              sampledHits: hh.sampledHits || {},
              intervals: hh.intervals || {},
              summary: hh.summary || {},
            })
          }
        }
        拉()
        const t = setInterval(拉, 3000)
        return () => clearInterval(t)
      }, [])

      // 取完整配置（用于编辑），进页面拉一次
      React.useEffect(() => {
        get('/config')
          .then((r) => {
            if (r && r.ok) 设编辑(规范(r.proactive || {}))
          })
          .catch(() => {})
      }, [])

      const 改 = (k, v) => 设编辑((e) => (e ? { ...e, [k]: v } : e))
      const 保存 = async () => {
        设存中(true)
        设消息(null)
        const r = await post('/config', { proactive: 编辑 })
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
          '主动消息投骰进度（dice 模式）：没人发消息时，每安静 ' +
            Math.round((状态 ? 状态.idleThresholdMs || 60000 : 60000) / 1000) +
            ' 秒投一次，命中才发；投满 ' +
            (状态 ? 状态.guaranteeCount || 90 : 90) +
            ' 次强制命中。',
        ),

        // ── 1) 投多少次命中一次 ──
        h(
          'div',
          { style: S.card },
          h('div', { style: S.h }, '投多少次命中一次'),
          效率 == null ? h('div', { style: S.dim }, '读取中…') : 命中效率(效率),
          h(
            'div',
            { style: S.提示 },
            '平均 = 累计投骰次数 ÷ 命中次数，由本插件每 5 秒轮询采样（落盘 state/hits.json）；与「累计命中」旧数据分开统计，改参数后的新节奏不会被历史数据稀释。',
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
              : 命中表格(状态, 命中, 效率),
          h(
            'div',
            { style: S.提示 },
            '「本轮已投」= 距上次命中已投的次数（桥接命中后归零）；「累计命中」由本插件本地轮询统计（DSH 重启不丢）；「投几次中一次」是该会话的平均命中间隔。',
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
                行('保底次数', 整数输入('diceGuaranteeCount'), '投满这么多次后强制命中（面板里的「/90」就是它）'),
                行('投骰间隔(秒)', 秒输入('diceIntervalMs'), '每安静这么久投一次骰，至少 1 秒'),
                行('安静阈值(秒)', 秒输入('idleThresholdMs'), '对方安静这么久才开始投骰'),
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
