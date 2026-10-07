// make-mutants-js.mjs — 给**另外三个半边**写"故意改坏"的副本。
//
// 桥那半边有 make-mutants.mjs / check-mutants.mjs:每个真实发生过的 bug 都打进副本,
// 要求测试**必须变红**。这条纪律在桥上是有效的(它抓到过测试自己的失效),
// 但插件 / 面板 / 浏览器那三半**从来没有被证明过** —— 它们的测试可能全是摆设。
//
// 这个文件就是补那一半:每条变异对应一个"真会犯的错",而且**指定由哪个测试抓**。
// check-mutants-js.mjs 逐个跑,漏一个就红。
//
//   node make-mutants-js.mjs              # 从仓库里的三份源码生成
//   node make-mutants-js.mjs --list       # 只列,不写
//
// 每条替换**必须恰好命中一次**(与桥那套同规矩):改了代码导致模式对不上,
// 生成器直接报错,而不是安静地产出一个"什么都没改"的假变异。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.join(HERE, '.mutants-js')

const SRC = {
  plugin: path.join(HERE, '..', 'plugin', 'index.js'),
  panel: path.join(HERE, '..', 'plugin', 'sv', 'DSHPanel.js'),
  client: path.join(HERE, '..', 'plugin', 'client.js'),
}

/**
 * [名字, 为什么(它是什么 bug), 文件, 由哪个测试抓, [[find, replace], …]]
 *
 * ⚠️ test 必须是 tools/ 下真实存在的测试文件;它的**退出码非 0 才算抓到**。
 *    check-client.mjs 收 `argv[2]`,另两个收 `--plugin` / `--panel`。
 */
/**
 * 变异清单。**导出**给 check-mutants-js.mjs 直接用 ——
 * 不靠"跑一次 --list 再解析输出":那需要子进程管道,而管道在受限环境里会 EPERM。
 * 清单只有这一份,谁都不许抄第二份。
 */
export const MUTANTS = [
  // ---- 插件半边(plugin-tests.mjs)----------------------------------------
  ['plugin-frozen-ignores-missing-heartbeat',
    'frozenCrumb: 没有心跳也照判"冻住"(把"桥没在跑"误报成"宿主被模态框冻住")',
    'plugin', 'plugin-tests.mjs',
    [['    if (!hb) return null\n', '    if (false) return null   // MUTANT: 没心跳也判\n']]],

  ['plugin-snapshot-before-misses-transpose',
    'SNAPSHOT_BEFORE: 写操作名单里漏掉 transpose_selected(那一次写没有回滚点)',
    'plugin', 'plugin-tests.mjs',
    [["  'transpose_selected',\n", '']]],

  ['plugin-panel-text-keeps-backticks',
    'toPanelText: 不去掉行内反引号(窄面板里只是多出来的噪音)',
    'plugin', 'plugin-tests.mjs',
    [["  t = t.replace(/`([^`\\n]*)`/g, '$1') // 行内代码\n", '']]],

  ['plugin-cap-silent',
    'capPanelText: 截断了却**不说**(用户以为那就是全部 —— 本仓库最忌的静默)',
    'plugin', 'plugin-tests.mjs',
    [['  return s.slice(0, max) + `\\n…(面板只显示到这里,还有 ${s.length - max} 字 —— 完整回复在 DSH 里看)`',
      '  return s.slice(0, max)   // MUTANT: 静默截断']]],

  ['plugin-doctor-drops-frozen',
    'sv_doctor: nextSteps 不再提"可能被模态框冻住"(最该说的那条不说了)',
    'plugin', 'plugin-tests.mjs',
    [['      const frozen = frozenCrumb(hb)\n      if (frozen) {\n        nextSteps.push(',
      '      const frozen = frozenCrumb(hb)\n      if (false) {\n        nextSteps.push(']]],

  // ---- 面板半边(panel-tests.mjs)-----------------------------------------
  ['panel-log-no-shrink',
    '面板:有选择题时日志框不让位(460 顶着,题目与选项被挤到要滚)',
    'panel', 'panel-tests.mjs',
    [['    var logHeight = asking ? PANEL.LOG_HEIGHT_ASK : PANEL.LOG_HEIGHT',
      '    var logHeight = PANEL.LOG_HEIGHT   // MUTANT: 不让位']]],

  ['panel-keeps-quick-actions-while-asking',
    '面板:答题期间仍把快捷动作排上去(跟选项抢这块很小的侧栏)',
    'panel', 'panel-tests.mjs',
    [['    var quickRows = []\n    if (!asking) {', '    var quickRows = []\n    if (true) {   // MUTANT: 答题时也排']]],

  ['panel-ask-refreshes-immediately',
    '面板:题目一到就重建面板(冲掉用户正在输入框里打的字 —— 文件头纪律第 3 条)',
    'panel', 'panel-tests.mjs',
    [['        st.askNeedsRefresh = true\n        return true',
      '        try { SV.refreshSidePanel() } catch (e9) {}\n        return true   // MUTANT: 当场重建']]],

  ['panel-step-refreshes-while-typing',
    '面板:step() 不等输入框干净就重建(同样会冲掉没发出去的字)',
    'panel', 'panel-tests.mjs',
    [['    if (st.askNeedsRefresh && !inputDirty()) {', '    if (st.askNeedsRefresh) {   // MUTANT: 不等输入框干净']]],

  ['panel-long-separator',
    '面板:时间戳分隔行又变回 22 个字符(窄框里等于白占一整行)',
    'panel', 'panel-tests.mjs',
    [["    parts.push('[' + hhmm(e.at) + ']')",
      "    parts.push('======== ' + hhmm(e.at) + ' ========')   // MUTANT: 长分隔行"]]],

  // ---- 浏览器半边(check-client.mjs)--------------------------------------
  ['client-hardcoded-color',
    'client.js: 写死一个颜色(亮色下看不出来,暗色下就是一块瞎眼的白)',
    'client', 'check-client.mjs',
    [['  background: var(--dsw-alias-bg-layer-1);\n  color: var(--dsw-alias-label-secondary);',
      '  background: #ffffff;\n  color: var(--dsw-alias-label-secondary);']]],

  ['client-emoji-in-ui',
    'client.js: 界面上出现 emoji(和 DSH 自己的界面不是一套)',
    'client', 'check-client.mjs',
    [["h('span', { className: 'svdb-title' }, 'Synthesizer V 桥')",
      "h('span', { className: 'svdb-title' }, '🎹 Synthesizer V 桥')"]]],

  // ---- 随包文档(plugin-tests.mjs / check-file.mjs)------------------------
  // 起因:用户问"工作区清空对插件有没有影响"。prompt 里原来指向的是**工作区相对**
  // 路径,工作区一清空那句话就失效了。这三条钉住"文档随包发 + 路径运行时算"。

  ['plugin-resolve-doc-guesses',
    'plugin: resolveDoc 对不存在的文档也返回路径(于是 prompt 里会印出一个不存在的文件,agent 白跑一步)',
    'plugin', 'plugin-tests.mjs',
    [['  const p = path.join(DOCS_DIR, fileName)\n  try {\n    return fs.existsSync(p) ? p : null',
      '  const p = path.join(DOCS_DIR, fileName)\n  try {\n    return p   // MUTANT: 不检查存在性']]],

  ['plugin-docs-not-bundled',
    'plugin: BUNDLED_DOCS 里写一个包里没有的名字(清单与文件脱节)',
    'plugin', 'check-file.mjs',
    [["export const BUNDLED_DOCS = ['全参流程.md', '音频转音符.md']",
      "export const BUNDLED_DOCS = ['查无此文档.md']   // MUTANT: 清单与文件脱节"]]],

  ['plugin-prompt-hardcoded-doc-path',
    'plugin: prompt 里又把文档路径写死成工作区相对路径(工作区一清空就变成空话)',
    'plugin', 'check-file.mjs',
    [["          fullDoc\n            ? `完整版见 ${fullDoc} —— **动手前先读它**。同目录还有 音频转音符.md。要点:`\n            : '完整版流程文档**没有随包发出**(插件目录里没有 docs/)—— 按下面要点做。要点:',",
      "          '完整版见 sv-dsh/docs/全参流程.md —— **动手前先读它**。要点:',   // MUTANT: 写死工作区相对路径"]]],

  // ---- 配置夹取(plugin-tests.mjs)------------------------------------------
  // profile 里那几项配置是裸值。写错类型坏的是**行为**,而报错完全看不出原因。
  ['plugin-config-nan-passthrough',
    'plugin: 配置给了非数字也照收 ⇒ NaN 一路传到 setTimeout,每次调用瞬间"超时"且报错看不懂',
    'plugin', 'plugin-tests.mjs',
    [['      notes.push(`${key}=${JSON.stringify(cfg[key])} 不是数字 ⇒ 用默认 ${DEFAULTS[key]}`)\n      cfg[key] = DEFAULTS[key]\n      return',
      '      notes.push(`${key}=${JSON.stringify(cfg[key])} 不是数字`)\n      return   // MUTANT: 不回落到默认']]],

  ['plugin-config-not-clamped',
    'plugin: 配置超范围也不夹 ⇒ 例如 pollMs=99999 直接把轮询拖死',
    'plugin', 'plugin-tests.mjs',
    [['    const fixed = Math.min(max, Math.max(min, Math.trunc(value)))',
      '    const fixed = value   // MUTANT: 不夹范围']]],
]

function apply(src, subs, name) {
  let out = src
  for (const [find, repl] of subs) {
    const n = out.split(find).length - 1
    if (n !== 1) {
      throw new Error(`${name}: 模式命中 ${n} 次(要求恰好 1 次): ${JSON.stringify(find.slice(0, 70))}`)
    }
    out = out.replace(find, repl)
  }
  return out
}

function main() {
  const listOnly = process.argv.includes('--list')
  for (const [file, p] of Object.entries(SRC)) {
    if (!fs.existsSync(p)) {
      console.error(`缺文件:${file} → ${p}`)
      process.exit(2)
    }
  }

  // ⚠️ 和桥那套一样:替换串都按 "\n" 写,文件一旦是 CRLF 就会**整片**"匹配 0 次"。
  //    工作树被 Git 的换行转换改过(或某个工具顺手写成了 CRLF)时,先把原因说出来。
  for (const [file, p] of Object.entries(SRC)) {
    if (fs.readFileSync(p, 'utf8').includes('\r\n')) {
      console.error(`✗ ${file}(${p})是 CRLF —— 替换串都按 "\\n" 写,会整片匹配不上。`)
      console.error('  仓库根目录的 .gitattributes 强制 eol=lf;已有的工作树请重新 checkout,')
      console.error('  或者用只写 LF 的方式重写该文件(别用 PowerShell 的 WriteAllLines)。')
      process.exit(2)
    }
  }

  if (!listOnly) {
    fs.rmSync(OUT_DIR, { recursive: true, force: true })
    fs.mkdirSync(OUT_DIR, { recursive: true })
  }

  const rows = []
  let failed = 0
  for (const [name, why, which, test, subs] of MUTANTS) {
    let text
    try {
      text = apply(fs.readFileSync(SRC[which], 'utf8'), subs, name)
    } catch (e) {
      console.error(`✗ ${name}: ${e.message}`)
      failed += 1
      continue
    }
    if (!listOnly) fs.writeFileSync(path.join(OUT_DIR, `${name}.js`), text)
    rows.push({ name, why, which, test, file: `.mutants-js/${name}.js` })
  }

  if (listOnly) {
    for (const r of rows) console.log(`${r.name}\n    [${r.which} → ${r.test}] ${r.why}`)
  } else {
    console.log(`wrote ${rows.length} mutants to .mutants-js/`)
    console.log('')
    for (const r of rows) {
      console.log(`${r.name.padEnd(42)} ${r.which} → ${r.test}`)
      console.log(`    ${r.why}`)
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} 条模式没对上 —— 源码改过之后,变异清单要跟着改`)
    process.exit(1)
  }
}

// 只在**被直接运行**时生成;被 import 时(检查器读清单)什么都不做。
const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()
