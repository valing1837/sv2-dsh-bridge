// 面板半边(plugin/sv/DSHPanel.js)的离线测试。
//
// 为什么需要它:面板是**手写的宿主脚本**(没有构建、没有类型检查、真机才能看),
// 而它最容易错的两件事都看不见:
//   ① **文字被截断** —— SV2 的侧栏很窄,按钮文案放不下就是被切掉,而"切掉"不报错;
//   ② **刷新时机** —— `SV.refreshSidePanel()` 会重建面板、冲掉输入框焦点与没发出去的字
//      (用户实测抱怨过"不要一直刷新,我没法打字")。这类错只有"正在打字时题目来了"
//      才现形,真机上极难复现。
//
// 做法:用一个**假 SV**(只有 create / getProject / refreshSidePanel / setTimeout),
// 把面板脚本真的加载起来,然后调它自己的 `getSidePanelSectionState()` 看交出来的 rows ——
// 与桥那套离线测试台同一个思路:能离线跑绿的,绝不留给真机。
//
//   node panel-tests.mjs
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PANEL_FILE = path.join(HERE, '..', 'plugin', 'sv', 'DSHPanel.js')

// SV2 侧栏大约这么宽。真机宽度由宿主决定,我们控制不了 —— 所以判据是
// "**最窄**要能撑到多少像素":测试会算出让每个按钮都不被截断所需的最小宽度。
const PANEL_WIDTH = 236
const OUTER_PAD = 16 // 侧栏左右内边距(估)
const CELL_PAD = 10 // 控件自身内边距(估)
const CJK_PX = 12 // 一个汉字的宽度(按侧栏字号估)
const ASCII_PX = 6.2 // 一个西文字符的宽度(估)

// ---------------------------------------------------------------------------
// 假 SV
// ---------------------------------------------------------------------------
function makeFakeSV() {
  const log = { refreshes: 0, timeouts: [] }
  const project = {
    _sd: {},
    getScriptData(k) {
      return Object.prototype.hasOwnProperty.call(this._sd, k) ? this._sd[k] : undefined
    },
    setScriptData(k, v) {
      this._sd[k] = v
    },
    removeScriptData(k) {
      delete this._sd[k]
    },
  }
  const SV = {
    create(type) {
      return {
        type,
        _v: 0,
        _cb: null,
        setValue(v) {
          this._v = v
        },
        getValue() {
          return this._v
        },
        setValueChangeCallback(cb) {
          this._cb = cb
        },
      }
    },
    getProject() {
      return project
    },
    refreshSidePanel() {
      log.refreshes += 1
    },
    setTimeout(ms, cb) {
      log.timeouts.push({ ms, cb })
    },
  }
  return { SV, log, project }
}

const { SV, log, project } = makeFakeSV()
const ctx = vm.createContext({ SV, console, JSON, Date, Math, Object, String, Array, Number, RegExp })
new vm.Script(fs.readFileSync(PANEL_FILE, 'utf8'), { filename: PANEL_FILE }).runInContext(ctx)

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------
let failed = 0
const check = (label, cond, got) => {
  if (cond) console.log(`  PASS  ${label}`)
  else {
    failed += 1
    console.log(`  FAIL  ${label}${got === undefined ? '' : `  (got ${JSON.stringify(got)})`}`)
  }
}

/** 估一行文字要多宽(汉字按整字、其余按西文) */
const textPx = (s) =>
  [...String(s)].reduce((n, ch) => n + (/[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? CJK_PX : ASCII_PX), 0)

/** 从 rows 里把控件摊平,方便统计 */
function widgets(rows) {
  const out = []
  for (const row of rows) {
    if (row.type === 'Container' && Array.isArray(row.columns)) {
      const total = row.columns.reduce((n, c) => n + (c.width || 1), 0)
      for (const c of row.columns) out.push({ ...c, share: (c.width || 1) / total, columns: row.columns.length })
    } else out.push({ ...row, share: 1, columns: 1 })
  }
  return out
}

const rowsOf = (state) => state.rows || []
const labelsOf = (state) => rowsOf(state).filter((r) => r.type === 'Label').map((r) => r.text)
const buttonsOf = (state) => widgets(rowsOf(state)).filter((w) => w.type === 'Button')
const areasOf = (state) => widgets(rowsOf(state)).filter((w) => w.type === 'TextArea')

console.log('panel-tests — 面板半边离线测试(假 SV)')
console.log(`  面板文件: ${path.relative(process.cwd(), PANEL_FILE)}`)
console.log(`  假设侧栏宽: ${PANEL_WIDTH}px`)
console.log('')

// ---------------------------------------------------------------------------
console.log('— getClientInfo:宿主强制要求的那几条')
const info = ctx.getClientInfo()
check('type 是 SidePanelSection', info.type === 'SidePanelSection', info.type)
check('name 纯 ASCII(含中文会被宿主拒绝加载)', /^[\x20-\x7e]+$/.test(info.name), info.name)
check('category 纯 ASCII', /^[\x20-\x7e]+$/.test(info.category), info.category)
check('minEditorVersion ≥ 131330(官方对侧栏的下限)', info.minEditorVersion >= 131330, info.minEditorVersion)

// ---------------------------------------------------------------------------
console.log('\n— 空闲态布局')
const idle = ctx.getSidePanelSectionState()
check('返回 {title, rows} 且 title 纯 ASCII',
  /^[\x20-\x7e]+$/.test(idle.title) && Array.isArray(idle.rows), idle.title)
const idleAreas = areasOf(idle)
check('有日志框与输入框', idleAreas.length >= 2, idleAreas.length)
check('日志框是 readOnly(只放 DSH 的回复)', idleAreas[0].readOnly === true)
check('日志框高 460(用户要求的大框)', idleAreas[0].height === 460, idleAreas[0].height)
check('输入框高 72(用户要在里面打字/答题)', idleAreas[1].height === 72, idleAreas[1].height)
check('快捷动作 6 个按钮都在', buttonsOf(idle).length >= 6 + 3 + 1, buttonsOf(idle).length)
check('一键调参按钮在', buttonsOf(idle).some((b) => /一键调参/.test(b.text)))
check('每行最多 3 列(侧栏里再多就挤了)', widgets(rowsOf(idle)).every((w) => w.columns <= 3),
  Math.max(...widgets(rowsOf(idle)).map((w) => w.columns)))

// ---------------------------------------------------------------------------
console.log('\n— 文字会不会被截断(按最窄的侧栏算)')
let worst = null
for (const b of buttonsOf(idle)) {
  const avail = (PANEL_WIDTH - OUTER_PAD) * b.share - CELL_PAD
  const need = textPx(b.text)
  if (!worst || need - avail > worst.need - worst.avail) worst = { text: b.text, need, avail }
}
check(`每个按钮文案都放得下(最紧的是「${worst.text}」:需 ${worst.need.toFixed(0)}px / 有 ${worst.avail.toFixed(0)}px)`,
  worst.need <= worst.avail, worst)

// 反推:让所有按钮都放得下所需的最小侧栏宽度 —— 这个数就是"面板最窄能撑到多少"
let minWidth = 0
for (const b of buttonsOf(idle)) {
  // need ≤ (W - OUTER_PAD) * share - CELL_PAD  ⇒  W ≥ need/share + CELL_PAD + OUTER_PAD
  minWidth = Math.max(minWidth, textPx(b.text) / b.share + CELL_PAD + OUTER_PAD)
}
console.log(`  [--]   全部按钮都不被截断所需的最小侧栏宽度 ≈ ${Math.ceil(minWidth)}px`)
check('这个宽度 ≤ 260px(窄侧栏也还能用)', minWidth <= 260, Math.ceil(minWidth))

// ---------------------------------------------------------------------------
console.log('\n— 选择题:题目来了(用户 2026-10-02 的三条要求)')
const before = log.refreshes
project.setScriptData('svdsh.panel.in', JSON.stringify({
  ctl: 'ask', id: 'q1', prompt: '这一段怎么处理?',
  choices: ['保持原样', '升八度', '降八度', '你决定'],
}))
const pulled = ctx.pull()
check('pull() 认出了这道题', pulled === true)
check('st.ask 被填上', ctx.st && ctx.st.ask && ctx.st.ask.choices.length === 4, ctx.st && ctx.st.ask)
check('题目/选项同时写进了日志框(按钮要重建才出现,文字一定看得见)',
  ctx.st.log.length > 0 && /请选择/.test(ctx.st.log[0].text))
check('⚠️ 题目来了**没有**当场重建面板(那会冲掉用户正在打的字)',
  log.refreshes === before, { before, after: log.refreshes })
check('而是挂了个"待刷新"标记', ctx.st.askNeedsRefresh === true)

const ask = ctx.getSidePanelSectionState()
const askAreas = areasOf(ask)
check('有题目时日志框让位(460 → 170)', askAreas[0].height === 170, askAreas[0].height)
check('输入框高度不变(答题也要打字)', askAreas[1].height === 72, askAreas[1].height)
check('快捷动作先收起来(答题期间用不上,别跟选项抢地方)',
  !buttonsOf(ask).some((b) => /看工程|对齐音频|体检重叠|量化|读转录|填歌词/.test(b.text)),
  buttonsOf(ask).map((b) => b.text))
check('一键调参也收起来', !buttonsOf(ask).some((b) => /一键调参/.test(b.text)))
const optionRows = rowsOf(ask).filter((r) => r.type === 'Container' && r.columns.length === 1 &&
  r.columns[0].type === 'Button' && !/发送给 DSH|刷新|清空/.test(r.columns[0].text))
check('4 个选项**竖排、一行一个**(用户明确要求,并排会把文字挤窄)',
  optionRows.length === 4, optionRows.length)
check('选项文字也在标签区重复了一遍(按钮被截断也看得到全貌)',
  labelsOf(ask).some((t) => /这一段怎么处理/.test(t)))

// ⚠️ 判据是**总高度**,不是行数:题目会让行数变多(选项一行一个),
//    但日志让出了 290px —— 在这么窄的侧栏里,决定"要不要滚"的是总高度。
const ROW_PX = 26
const totalHeight = (state) => rowsOf(state).reduce((n, r) => {
  if (r.type === 'Container' && r.columns.length === 1 && r.columns[0].type === 'TextArea') {
    return n + (r.columns[0].height || ROW_PX)
  }
  return n + ROW_PX
}, 0)
const hIdle = totalHeight(idle)
const hAsk = totalHeight(ask)
console.log(`  [--]   估算总高:空闲 ${hIdle}px · 有题目 ${hAsk}px(差 ${hIdle - hAsk}px)`)
check('有题目时整块**更矮**(把高度让给了题目与选项)', hAsk < hIdle, { hIdle, hAsk })
check('有题目时能塞进一个典型侧栏高度(≤560px,不用滚就能看全题目与选项)',
  hAsk <= 560, hAsk)

// 输入框干净之后,step() 才真的重建
const refreshesBefore = log.refreshes
ctx.step()
check('输入框干净 ⇒ step() 完成那次重建', log.refreshes === refreshesBefore + 1, log.refreshes)

// 正在打字时:不许刷
ctx.st.askNeedsRefresh = true
const typed = ctx.SV.create('WidgetValue')
ctx.wInput.setValue('我正在打字')
const r2 = log.refreshes
ctx.step()
check('输入框里有字 ⇒ 即便有待刷新也不动面板(不冲掉焦点)',
  log.refreshes === r2, { before: r2, after: log.refreshes })
check('标记留着,等下一拍', ctx.st.askNeedsRefresh === true)
ctx.wInput.setValue('')

// ---------------------------------------------------------------------------
console.log('\n— 日志框里放什么')
ctx.st.log = [{ who: 'you', text: '我自己说的话', at: Date.now() },
              { who: 'dsh', text: 'DSH 的回复', at: Date.now() }]
ctx.renderLog()
const shown = ctx.wLog.getValue()
check('只显示 DSH 的回复,不回显用户自己的话', !/我自己说的话/.test(shown), shown)
check('时间戳是**短**分隔行(原来 22 个字符的装饰行等于白占一行)',
  /^\[\d\d:\d\d\]$/m.test(shown), shown.split('\n')[0])
check('回复正文在', /DSH 的回复/.test(shown))

console.log('')
if (failed === 0) {
  console.log('OK: 面板半边全部通过(结构 / 最窄宽度 / 选择题让位 / 刷新纪律 / 日志)')
  process.exit(0)
}
console.log(`${failed} 项失败`)
process.exit(1)
