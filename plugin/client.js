// dsh-sv-bridge —— 浏览器半边。
//
// 输入框下面那一枚状态徽标 + 点开的状态卡:SV2 那边的桥在不在线、宿主什么版本、
// 有几条 SV2 的消息还没投递、**现在能不能回滚**、以及"卡在哪个 op"。
// 数据来自宿主半边的只读路由 GET /dsh-sv-bridge/status(仅回环)。
//
// 纪律(来自官方 cordis-plugin-development 技能):
//   · 不 import 任何 Harness Client 包;只用 require('react') 与浏览器原生 fetch。
//   · 只用主题 token(--dsw-alias-*),不写死颜色 —— 亮/暗两套都要对。
//   · 样式随组件一起渲染,卸载即消失;不在组件外碰 DOM、不 append 到 document.body。
//   · 工厂函数保持无副作用;注册写在 apply 里并返回清理函数。
//
// 设计取向(为什么长这样):
//   · **徽标要安静,状态卡才说细节**。输入框下面是高频视线区,徽标只留"一眼能判断"的
//     四态(在线 / 离线 / 需重跑 / 卡住),其余全部收进点开的卡片。
//   · 数字用 tabular-nums:秒数在跳,不等宽会让整行左右抖。
//   · 动画尊重 prefers-reduced-motion:呼吸点只是"活着"的提示,不是装饰。
//   · 异常一律给**能照做的一句话**,不只给一个红点。

window.__ModuleLoader__.load({
  id: 'dsh-sv-bridge',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const STATUS_URL = '/dsh-sv-bridge/status'
    const POLL_MS = 5000

    // ---------------------------------------------------------------------
    // 样式(全部走主题 token)
    // ---------------------------------------------------------------------
    const CSS = `
.svdb-root { position: relative; display: inline-flex; align-items: center; }

/* ---- 徽标 ---- */
.svdb-chip {
  display: inline-flex; align-items: center; gap: 6px;
  height: 22px; padding: 0 8px 0 7px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px; line-height: 1; letter-spacing: .01em;
  font-variant-numeric: tabular-nums;
  user-select: none; cursor: pointer;
  transition: background-color .15s ease, border-color .15s ease, color .15s ease;
}
.svdb-chip:hover { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); }
.svdb-chip:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.svdb-chip[data-open='true'] { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); }

.svdb-dot { position: relative; width: 6px; height: 6px; border-radius: 50%; flex: 0 0 auto;
  background: var(--dsw-alias-state-idle-primary); }
.svdb-dot[data-state='online'] { background: var(--dsw-alias-state-success-primary); }
.svdb-dot[data-state='stale']  { background: var(--dsw-alias-state-warn-primary); }
.svdb-dot[data-state='down']   { background: var(--dsw-alias-state-error-primary); }
.svdb-dot[data-state='online']::after {
  content: ''; position: absolute; inset: -3px; border-radius: 50%;
  border: 1px solid var(--dsw-alias-state-success-primary);
  opacity: .45; animation: svdb-breathe 2.4s ease-in-out infinite;
}
@keyframes svdb-breathe { 0%,100% { transform: scale(.8); opacity: .35 } 50% { transform: scale(1.15); opacity: .1 } }
@media (prefers-reduced-motion: reduce) { .svdb-dot[data-state='online']::after { animation: none } }

.svdb-label { white-space: nowrap; }
.svdb-chip .svdb-warn { color: var(--dsw-alias-state-warn-primary); }
.svdb-caret { width: 8px; height: 8px; flex: 0 0 auto; opacity: .55; transition: transform .15s ease; }
.svdb-chip[data-open='true'] .svdb-caret { transform: rotate(180deg); }

/* ---- 状态卡 ---- */
.svdb-card {
  position: absolute; right: 0; bottom: calc(100% + 8px);
  width: 306px; max-width: min(306px, 78vw);
  padding: 10px 12px 11px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-overlay);
  box-shadow: 0 10px 28px rgba(0,0,0,.22); /* client-style-allow:主题 token 里没有阴影 */
  color: var(--dsw-alias-label-primary);
  font-size: 12px; line-height: 1.5;
  text-align: left; cursor: default; user-select: text;
  z-index: 40;
}
.svdb-head { display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding-bottom: 7px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.svdb-title { font-size: 12px; font-weight: 600; letter-spacing: .01em; }
.svdb-state { display: inline-flex; align-items: center; gap: 5px;
  font-size: 11px; color: var(--dsw-alias-label-secondary); }
.svdb-sec { padding-top: 8px; }
.svdb-secname { font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase;
  color: var(--dsw-alias-label-secondary); opacity: .75; margin-bottom: 3px; }
.svdb-row { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.svdb-row + .svdb-row { margin-top: 2px; }
.svdb-k { color: var(--dsw-alias-label-secondary); flex: 0 0 auto; }
.svdb-v { text-align: right; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.svdb-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; }
.svdb-note { margin-top: 8px; padding: 7px 9px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-label-primary); font-size: 11.5px; }
.svdb-note[data-kind='error'] { border-color: var(--dsw-alias-state-error-primary); }
.svdb-note[data-kind='ok'] { border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.svdb-foot { display: flex; align-items: center; justify-content: space-between;
  gap: 8px; margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l1); }
.svdb-actions { display: inline-flex; gap: 6px; }
.svdb-btn { height: 22px; padding: 0 9px; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-size: 11.5px; line-height: 1; cursor: pointer;
  transition: background-color .15s ease, border-color .15s ease; }
.svdb-btn:hover { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); }
.svdb-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.svdb-stamp { font-size: 10.5px; color: var(--dsw-alias-label-secondary); opacity: .8;
  font-variant-numeric: tabular-nums; }
`

    // ---------------------------------------------------------------------
    // 状态 → 展示
    // ---------------------------------------------------------------------

    /** 四态 + 一句人话。徽标只显示最短的那部分。 */
    function describe(state, failed) {
      if (failed) {
        return { dot: 'down', short: 'SV 插件未响应', tone: 'warn',
          note: '读不到 /dsh-sv-bridge/status —— 插件可能没激活(重启 DSH 后再看),或端口被别的进程占了。' }
      }
      if (!state) return { dot: 'stale', short: 'SV …', tone: 'muted', note: null }

      const online = Boolean(state.online)
      const stale = Boolean(state.scriptStale)
      const mismatch = state.dirMatches === false
      const frozen = state.frozen || null
      const snapErr = state.lastSnapshotError || null
      const age = Number.isFinite(state.heartbeatAgeSeconds) ? state.heartbeatAgeSeconds : null

      if (online && frozen) {
        return { dot: 'stale', short: 'SV 卡住了', tone: 'warn',
          note: `宿主可能被 **${frozen.op}** 弹的模态框冻住了。到 SV2 里关掉那个错误框,` +
            '存盘,然后 [中止所有脚本] 再重跑 DSH Bridge。' }
      }
      if (online && mismatch) {
        return { dot: 'stale', short: 'SV 目录不一致', tone: 'warn',
          note: '插件与桥用的不是同一个目录 ⇒ 请求会被永远忽略。重启插件(它会重建目录),再在宿主里重跑桥。' }
      }
      if (online && stale) {
        return { dot: 'stale', short: 'SV 需重跑桥', tone: 'warn',
          note: '部署的脚本文件比桥的启动时间新 —— 宿主里跑的是**旧实例**。' +
            '在 SV2 里 [脚本] > [中止所有脚本],再重新运行 DSH Bridge。' }
      }
      if (online) {
        return { dot: 'online', short: `SV ${state.hostVersion || '?'}`, tone: 'ok',
          note: snapErr
            ? `上一次写操作前的自动快照失败了(${snapErr.op}):${snapErr.message} —— 那一次写没有回滚点。`
            : null }
      }
      return { dot: 'stale', short: age === null ? 'SV 未连接' : `SV 已离线 ${age}s`, tone: 'muted',
        note: '桥不在线:在 SV2 里运行 [脚本] > [DSH] > [DSH Bridge]。' +
          '常驻脚本不会热更,改过桥要重跑。' }
    }

    /** 徽标上那一行字:短、稳定、不跳。 */
    function chipText(state, d) {
      const parts = [d.short]
      if (state) {
        if (state.online && state.bridgeVersion) parts.push(`桥 ${state.bridgeVersion}`)
        const queued = Number(state.queuedFromSv) || 0
        if (queued > 0) parts.push(`${queued} 条待投递`)
      }
      return parts.join(' · ')
    }

    function Row({ k, v, mono }) {
      return h('div', { className: 'svdb-row' },
        h('span', { className: 'svdb-k' }, k),
        h('span', { className: 'svdb-v' + (mono ? ' svdb-mono' : '') }, v))
    }

    function Sec({ name, children }) {
      return h('div', { className: 'svdb-sec' },
        h('div', { className: 'svdb-secname' }, name),
        children)
    }

    // ---------------------------------------------------------------------
    // 组件
    // ---------------------------------------------------------------------

    function StatusChip() {
      const [state, setState] = useState(null)
      const [failed, setFailed] = useState(false)
      const [open, setOpen] = useState(false)
      const [stamp, setStamp] = useState(null)
      const rootRef = useRef(null)
      const aliveRef = useRef(true)

      const load = useCallback(() => {
        fetch(STATUS_URL, { headers: { accept: 'application/json' } })
          .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
          .then((data) => {
            if (!aliveRef.current) return
            setState(data)
            setFailed(false)
            setStamp(Date.now())
          })
          .catch(() => {
            if (!aliveRef.current) return
            setFailed(true)
          })
      }, [])

      useEffect(() => {
        aliveRef.current = true
        load()
        const timer = setInterval(load, POLL_MS)
        return () => {
          aliveRef.current = false
          clearInterval(timer)
        }
      }, [load])

      // 打开时立刻刷新一次:卡片里的数字不该是 5 秒前的
      useEffect(() => { if (open) load() }, [open, load])

      // 点外面 / Esc 关掉。监听器挂在 document 上,但**只在打开期间**存在,卸载即清掉。
      useEffect(() => {
        if (!open) return undefined
        const onDown = (e) => {
          const el = rootRef.current
          if (el && !el.contains(e.target)) setOpen(false)
        }
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      const d = useMemo(() => describe(state, failed), [state, failed])
      const snapshots = (state && state.snapshots) || null
      const lastOp = state && state.lastOp ? state.lastOp : null
      const frozen = state && state.frozen ? state.frozen : null

      const title = failed
        ? '读不到 /dsh-sv-bridge/status。'
        : state && state.online
          ? `桥在线 · ${state.hostName || 'Synthesizer V Studio'} ${state.hostVersion || ''} · 桥 ${state.bridgeVersion || '?'}`
          : '桥不在线:在 SV2 里运行 [脚本] > [DSH] > [DSH Bridge]。'

      const caret = h('svg', { className: 'svdb-caret', viewBox: '0 0 10 6', 'aria-hidden': 'true' },
        h('path', { d: 'M1 1l4 4 4-4', fill: 'none', stroke: 'currentColor', strokeWidth: '1.4',
          strokeLinecap: 'round', strokeLinejoin: 'round' }))

      const chip = h('button', {
        type: 'button',
        className: 'svdb-chip',
        'data-open': open ? 'true' : 'false',
        title,
        'aria-expanded': open ? 'true' : 'false',
        'aria-label': 'Synthesizer V 桥状态',
        onClick: () => setOpen((v) => !v),
      },
        h('span', { className: 'svdb-dot', 'data-state': d.dot }),
        h('span', { className: 'svdb-label' + (d.tone === 'warn' ? ' svdb-warn' : '') },
          chipText(state, d)),
        caret)

      if (!open) {
        return h('div', { className: 'svdb-root', ref: rootRef }, h('style', null, CSS), chip)
      }

      const card = h('div', { className: 'svdb-card', role: 'dialog', 'aria-label': 'SV 桥状态' },
        h('div', { className: 'svdb-head' },
          h('span', { className: 'svdb-title' }, 'Synthesizer V 桥'),
          h('span', { className: 'svdb-state' },
            h('span', { className: 'svdb-dot', 'data-state': d.dot }),
            state && state.online ? '在线' : failed ? '未响应' : '离线')),

        state
          ? h('div', null,
              h(Sec, { name: '桥' },
                h(Row, { k: '版本', v: state.bridgeVersion || '—' }),
                h(Row, { k: '心跳', v: Number.isFinite(state.heartbeatAgeSeconds)
                  ? `${state.heartbeatAgeSeconds} 秒前` : '—' }),
                h(Row, { k: 'op 数', v: (state.ops && state.ops.length) || 0 }),
                h(Row, { k: '目录一致', v: state.dirMatches === null ? '—' : state.dirMatches ? '是' : '否' })),
              h(Sec, { name: '宿主' },
                h(Row, { k: '名称', v: state.hostName || '—' }),
                h(Row, { k: '版本', v: state.hostVersion || '—' })),
              h(Sec, { name: '回滚' },
                snapshots && snapshots.count > 0
                  ? h('div', null,
                      h(Row, { k: '可用快照', v: `${snapshots.count} / ${snapshots.max || '—'}` }),
                      snapshots.latest
                        ? h(Row, { k: '最近一份', v: `${snapshots.latest.id}` +
                            (snapshots.latest.label ? ` · ${snapshots.latest.label}` : '') +
                            (snapshots.latest.noteCount !== null ? ` · ${snapshots.latest.noteCount} 音` : '') })
                        : null)
                  : h(Row, { k: '可用快照', v: '暂无(写一次就有了)' })),
              h(Sec, { name: '投递' },
                h(Row, { k: '待投递', v: Number(state.queuedFromSv) || 0 }),
                h(Row, { k: '绑定会话', v: state.boundSession || '未绑定' })),
              lastOp
                ? h(Sec, { name: '最近一笔' },
                    h(Row, { k: 'op', v: lastOp.op, mono: true }),
                    h(Row, { k: '状态', v: lastOp.stage === 'running' && frozen ? '未跑完(疑似卡住)' : lastOp.stage || '—' }))
                : null,
              state.dir ? h('div', { className: 'svdb-sec' },
                h('div', { className: 'svdb-secname' }, '通道目录'),
                h('div', { className: 'svdb-v svdb-mono' }, state.dir)) : null)
          : h('div', { className: 'svdb-note', 'data-kind': 'error' },
              '读不到插件状态。先在 DSH 里确认 dsh-sv-bridge 已激活(必要时重启 DSH)。'),

        d.note
          ? h('div', { className: 'svdb-note', 'data-kind': d.tone === 'ok' ? 'ok' : 'warn' }, d.note)
          : null,

        h('div', { className: 'svdb-foot' },
          h('span', { className: 'svdb-stamp' },
            stamp ? `更新于 ${new Date(stamp).toLocaleTimeString()}` : '—'),
          h('div', { className: 'svdb-actions' },
            h('button', { type: 'button', className: 'svdb-btn', onClick: load }, '刷新'))))

      return h('div', { className: 'svdb-root', ref: rootRef },
        h('style', null, CSS), chip, card)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'dsh-sv-bridge-status',
              order: 20,
              label: 'SV2 桥状态',
            },
            StatusChip,
          ),
        )
      },
    }
  },
})
