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
// 默认测仓库里的那份;`--panel <file>` 可以测**另一个副本**(变异测试用)
const argv = process.argv.slice(2)
const pi = argv.indexOf('--panel')
const PANEL_FILE =
  pi >= 0 && argv[pi + 1]
    ? path.resolve(argv[pi + 1])
    : path.join(HERE, '..', 'plugin', 'sv', 'DSHPanel.js')

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
console.log('\n— 空闲态布局(2026-10-07 大改后的版面)')
const idle = ctx.getSidePanelSectionState()
check('返回 {title, rows} 且 title 纯 ASCII',
  /^[\x20-\x7e]+$/.test(idle.title) && Array.isArray(idle.rows), idle.title)
const idleAreas = areasOf(idle)
// ⚠️⚠️ 这一条是 2026-10-07 那次 bug 的判据(用户实测"回复框里也能打字")。
//      当时我写的是 `readOnly: true` —— 而**宿主没有这个字段**(官方控件示例里只有
//      type / value / height / width / text)。旧断言检查的是"我设了这个标志",
//      不是"用户改不了" ⇒ 它永远是绿的,抓不到这个 bug。
//      现在换成**行为判据**:整个面板只能有**一个**可编辑的文本控件(那个小输入框)。
check('⚠️ 整个面板只有**一个**可编辑的文本控件(那个小输入框)',
  idleAreas.length === 1, idleAreas.map((a) => a.height))
check('小输入框高 56(用户要的是"小"输入框)', idleAreas[0].height === 56, idleAreas[0].height)
check('回复区是**纯文字**(Label 行),不是输入框', labelsOf(idle).length > 0, labelsOf(idle).length)
// 源码级:不许再出现 readOnly(写了只会让人**以为**只读)。注释里提到它是解释历史,剥掉。
const panelSrc = fs.readFileSync(PANEL_FILE, 'utf8')
const panelCode = panelSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1')
check('源码里不再出现 readOnly(宿主不认这个字段)',
  !/readOnly/.test(panelCode), (panelCode.match(/.*readOnly.*/) || [''])[0])
// ⚠️ 用户 2026-10-07:"那些快捷方式可有可无了" ⇒ 面板只剩 发送/刷新/清空 三个按钮。
const idleButtons = buttonsOf(idle).map((b) => b.text)
check('只剩 发送 / 刷新 / 清空 三个按钮', idleButtons.length === 3, idleButtons)
check('六个快捷动作**一个都不在了**',
  !idleButtons.some((t) => /看工程|对齐音频|体检重叠|量化|读转录|填歌词|一键调参/.test(t)), idleButtons)
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
check('这个宽度 ≤ 200px(窄侧栏也还能用)', minWidth <= 200, Math.ceil(minWidth))

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
check('而是挂了个"待刷新"标记', ctx.st.needsRefresh === true)

const ask = ctx.getSidePanelSectionState()
const askAreas = areasOf(ask)
check('有题目时仍然只有一个可编辑控件', askAreas.length === 1, askAreas.length)
check('有题目时小输入框更矮(56 → 44,把地方让给选项)', askAreas[0].height === 44, askAreas[0].height)
check('有题目时回复区让位(最多 9 行 → 4 行)', ctx.st.replyLines.length <= 4, ctx.st.replyLines.length)
const optionRows = rowsOf(ask).filter((r) => r.type === 'Container' && r.columns.length === 1 &&
  r.columns[0].type === 'Button' && !/发送|刷新|清空/.test(r.columns[0].text))
check('4 个选项**竖排、一行一个**(用户明确要求,并排会把文字挤窄)',
  optionRows.length === 4, optionRows.length)
check('选项文字也在标签区重复了一遍(按钮被截断也看得到全貌)',
  labelsOf(ask).some((t) => /这一段怎么处理/.test(t)))

// ⚠️⚠️ 用户 2026-10-07 的新要求:"用户不满意的话就在**选项下面**加个小输入框"。
//      (2026-10-02 那版是反的 —— 输入框在上、选项在下。这一条就是那次改动的判据。)
const rowIndexOf = (state, pred) => rowsOf(state).findIndex(pred)
const isInputRow = (r) => r.type === 'Container' && r.columns.length === 1 &&
  r.columns[0].type === 'TextArea' && r.columns[0].value === ctx.wInput
const inputRow = rowIndexOf(ask, isInputRow)
// 回复区现在是纯文字:第一行状态行之后、题目之前的那批 Label 就是它。
const askLabelRow = rowIndexOf(ask, (r) => r.type === 'Label' && /^请选择:/.test(r.text || ''))
const lastOptionRow = rowsOf(ask).reduce(
  (n, r, i) => (r.type === 'Container' && r.columns.length === 1 && r.columns[0].type === 'Button' &&
    !/发送|刷新|清空/.test(r.columns[0].text) ? i : n), -1)
const hintRow = rowIndexOf(ask, (r) => r.type === 'Label' && /不满意/.test(r.text || ''))
check('版面顺序:回复(纯文字) → 选项 → 小输入框',
  askLabelRow > 1 && lastOptionRow > askLabelRow && inputRow > lastOptionRow,
  { askLabelRow, lastOptionRow, inputRow })
check('选项**下面**有一行"不满意就自己写"的提示(就在输入框上面)',
  hintRow > lastOptionRow && hintRow < inputRow, { lastOptionRow, hintRow, inputRow })
check('选项按钮在发送按钮那一行**之前**(选项不是压在底部按钮下面)',
  lastOptionRow < rowIndexOf(ask, (r) => r.type === 'Container' && r.columns.some((c) => c.text === '发送')),
  lastOptionRow)

// ⚠️ 判据变了(2026-10-07 回复区改纯文字之后):
//    旧的"有题目时整块更矮"是给**固定高度的日志框**设计的 —— 那时日志让出 290px,
//    总高当然变小。现在回复是**文字行**、选项是**新增的行** ⇒ 有题目时总高必然更大 ✓,
//    所以"更矮"这个比较已经不成立。真正该钉的是:**同样的回复内容,有题目时行数更少**。
const ROW_PX = 26
const totalHeight = (state) => rowsOf(state).forEach ? rowsOf(state).reduce((n, r) => {
  if (r.type === 'Container' && r.columns.length === 1 && r.columns[0].type === 'TextArea') {
    return n + (r.columns[0].height || ROW_PX)
  }
  return n + ROW_PX
}, 0) : 0
const hIdle = totalHeight(idle)
const hAsk = totalHeight(ask)
console.log(`  [--]   估算总高:空闲 ${hIdle}px · 有题目 ${hAsk}px(有题目时多了选项那几行)`)
check('有题目时能塞进一个典型侧栏高度(≤560px,不用滚就能看全题目与选项)',
  hAsk <= 560, hAsk)

// 公平比较:同一段回复,在"空闲"和"有题目"两种状态下各渲染一次
const savedAsk = ctx.st.ask
const savedLog = ctx.st.log
ctx.st.log = [{ who: 'dsh', text: '第一行\n第二行\n第三行\n第四行\n第五行\n第六行', at: Date.now() }]
ctx.st.ask = null
ctx.renderLog()
const idleReplyLines = ctx.st.replyLines.length
ctx.st.ask = { id: 'x', prompt: 'p', choices: ['a', 'b'] }
ctx.renderLog()
const askReplyLines = ctx.st.replyLines.length
check('同一段回复:有题目时**行数更少**(把地方让给选项)',
  askReplyLines < idleReplyLines, { idleReplyLines, askReplyLines })
ctx.st.ask = savedAsk
ctx.st.log = savedLog
ctx.renderLog()

// ---------------------------------------------------------------------------
console.log('\n— 点选项之后:把你选的显示在回复区(用户 2026-10-07)')
ctx.wAsk[0]._cb() // 假装用户点了第一个选项
check('点了选项 ⇒ 选项消失', ctx.st.ask === null)
check('选中项被记下来(带 picked 标记)',
  ctx.st.log.length === 1 && ctx.st.log[0].picked === true && ctx.st.log[0].text === '保持原样', ctx.st.log)
check('回复区显示「你选:保持原样」',
  ctx.st.replyLines.join('\n').includes('你选:保持原样'), ctx.st.replyLines)
check('原来那一大段"题目 + 选项列表"被替换掉了(不然回复区被刷满)',
  !ctx.st.replyLines.join('\n').includes('请选择'), ctx.st.replyLines)
check('并且挂了待刷新(纯文字要重建才看得到)', ctx.st.needsRefresh === true)
check('仍然只有一个小输入框(点选项不会多出输入位)', areasOf(ctx.getSidePanelSectionState()).length === 1)

// 输入框干净之后,step() 才真的重建
const refreshesBefore = log.refreshes
ctx.step()
check('输入框干净 ⇒ step() 完成那次重建', log.refreshes === refreshesBefore + 1, log.refreshes)

// 正在打字时:不许刷
ctx.st.needsRefresh = true
ctx.wInput.setValue('我正在打字')
const r2 = log.refreshes
ctx.step()
check('输入框里有字 ⇒ 即便有待刷新也不动面板(不冲掉焦点)',
  log.refreshes === r2, { before: r2, after: log.refreshes })
check('标记留着,等下一拍', ctx.st.needsRefresh === true)
ctx.wInput.setValue('')

// ---------------------------------------------------------------------------
console.log('\n— 回复区里放什么(纯文字行)')
ctx.st.log = [{ who: 'you', text: '我自己说的话', at: Date.now() },
              { who: 'dsh', text: 'DSH 的回复', at: Date.now() }]
ctx.renderLog()
const lines = ctx.st.replyLines
check('回复渲染成了纯文字行', Array.isArray(lines) && lines.length > 0, lines)
const shown = lines.join('\n')
check('只显示 DSH 的回复,不回显用户自己的话', !/我自己说的话/.test(shown), shown)
check('时间戳是**短**分隔行(原来 22 个字符的装饰行等于白占一行)',
  lines.some((t) => /^\[\d\d:\d\d\]$/.test(t)), lines)
check('回复正文在', /DSH 的回复/.test(shown))
check('⚠️ 回复变了会挂"待刷新"(纯文字是静态的,不重建就看不到)',
  ctx.st.needsRefresh === true)
check('每行不超过折行宽度(不赌宿主会自动折行)',
  lines.every((t) => t.length <= 22), Math.max(...lines.map((t) => t.length)))

// 长回复:截断 + **自述**(不能悄悄少几行)
ctx.st.log = [{ who: 'dsh', text: '很长的一句话,一直说下去。'.repeat(60), at: Date.now() }]
ctx.renderLog()
const longLines = ctx.st.replyLines
check('长回复被截断到上限', longLines.length <= 9, longLines.length)
check('⚠️ 而且**自述**还有多少行、去哪儿看',
  /后面还有 \d+ 行/.test(longLines[longLines.length - 1]), longLines[longLines.length - 1])

console.log('')
if (failed === 0) {
  console.log('OK: 面板半边全部通过(结构 / 最窄宽度 / 唯一可编辑控件 / 版面顺序 / 刷新纪律 / 回复)')
  process.exit(0)
}
console.log(`${failed} 项失败`)
process.exit(1)
