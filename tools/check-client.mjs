// 浏览器半边(client.js)的守卫。
//
// 为什么需要它:client.js 是**手写的**浏览器模块(没有构建步骤、没有类型检查),
// 它错了不会有人告诉你 —— 只会在 DSH 界面里安静地难看,或者干脆不渲染。
// 而"难看"这件事我们是有要求的,所以把要求写成可执行的判据:
//
//   ① 语法:文件必须能被 node 解析(它用的是 window.__ModuleLoader__.load,不是 ESM)。
//   ② **不写死颜色**:所有 var(--…) 必须是 --dsw-* 主题 token。
//      写死 #fff / rgb() 在亮色下看不出来,到暗色下就是一块瞎眼的白 —— 这个坑很贵。
//      唯一豁免:box-shadow 的 rgba()(主题 token 里没有阴影),且必须带 allow 标记。
//   ③ **不用 emoji**:SV2 侧栏字体不渲染 emoji(会变成豆腐块);DSH 界面里也不统一。
//   ④ **不碰组件外的 DOM**:不 document.body.appendChild、不 document.write。
//      样式随组件渲染、卸载即消失(官方技能里的纪律)。
//   ⑤ 槽位注册的形状:name / id / order 都要在,且 id 是稳定的。
//
//   node check-client.mjs [plugin/client.js]
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const entry = path.resolve(process.argv[2] ?? path.join('..', 'plugin', 'client.js'))

let failed = 0
const fail = (msg) => {
  failed += 1
  console.log(`FAIL  ${msg}`)
}
const ok = (msg) => console.log(`OK    ${msg}`)

if (!fs.existsSync(entry)) {
  fail(`找不到 ${entry}`)
  process.exit(1)
}
const src = fs.readFileSync(entry, 'utf8')

/**
 * 去掉注释后的代码。
 * ⚠️ 有些判据(emoji / 碰 DOM)只该看**真正会跑的那部分**:注释里写
 * "不要 document.body.appendChild" 不该被判违规,注释里画个箭头也不该。
 */
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
const code = stripComments(src)

console.log(`check-client: ${entry}`)
console.log(`  ${src.split('\n').length} 行 / ${(src.length / 1024).toFixed(1)} KB`)
console.log('')

// ---- ① 语法 ---------------------------------------------------------------
try {
  new vm.Script(src, { filename: entry })
  ok('语法:可被 node 解析')
} catch (error) {
  fail(`语法错误:${error.message}`)
}

// ---- ② 不写死颜色 ---------------------------------------------------------
const HARDCODED = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\bcolor\(/g
const lines = src.split('\n')
let hardcoded = 0
lines.forEach((line, i) => {
  // 豁免:带 client-style-allow 标记的行(目前只有 box-shadow 的 rgba)
  if (line.includes('client-style-allow')) return
  const hits = line.match(HARDCODED)
  if (hits) {
    hardcoded += hits.length
    fail(`第 ${i + 1} 行写死了颜色:${hits.join(', ')} —— 请改用 var(--dsw-alias-*)`)
  }
})
if (hardcoded === 0) ok('颜色:没有写死的色值(全部走主题 token)')

// var() 里引用的必须都是 --dsw-* token
const vars = new Set()
for (const m of src.matchAll(/var\((--[a-z0-9-]+)/gi)) vars.add(m[1])
const foreign = [...vars].filter((v) => !v.startsWith('--dsw-'))
if (foreign.length > 0) fail(`用了非 DSH 主题变量:${foreign.join(', ')}`)
else ok(`主题变量:${vars.size} 个,全部是 --dsw-*`)

// ---- ③ 不用 emoji(只看会跑的代码:注释里无所谓)-------------------------
// 与 check-lua.mjs 同一套区间。check-lua 只管面板(宿主侧栏字体不渲染 emoji);
// 这里是 DSH 浏览器界面,emoji 能渲染,但**混进 DSH 自己的界面里不统一** ⇒ 同样禁用。
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/gu
const emojiHits = code.match(EMOJI)
if (emojiHits) fail(`出现 emoji / 装饰符号(界面里不统一):${[...new Set(emojiHits)].join(' ')}`)
else ok('字形:会跑的代码里没有 emoji / 装饰符号')

// ---- ④ 不碰组件外的 DOM ---------------------------------------------------
const domHits = ['document.body', 'document.write', 'document.head'].filter((bad) =>
  code.includes(bad))
if (domHits.length > 0) {
  fail(`出现了 ${domHits.join(', ')} —— 样式与节点必须随组件走,卸载即消失`)
} else {
  ok('DOM:没有碰组件外的节点')
}
if (!code.includes('document.addEventListener')) {
  console.log('  [--]   没有 document 监听器(允许;有关闭卡片的需求才需要)')
} else if (!code.includes('removeEventListener')) {
  fail('挂了 document 监听器却没有 removeEventListener —— 卸载后会泄漏')
} else {
  ok('DOM:document 监听器带清理')
}

// ---- ⑤ 槽位注册的形状 -----------------------------------------------------
for (const need of ["'conversation.composer.dock'", "id: 'dsh-sv-bridge-status'", 'order:']) {
  if (!src.includes(need)) fail(`缺少槽位注册要素:${need}`)
}
if (src.includes("'conversation.composer.dock'")) ok('槽位:注册到 conversation.composer.dock')

// 状态卡要显示的三件事(0.8.0 的新信息):能不能回滚 · 卡在哪个 op · 快照失败过没有
for (const need of ['snapshots', 'lastOp', 'lastSnapshotError']) {
  if (!src.includes(need)) fail(`状态卡没有展示 ${need} —— 0.8.0 的三条信息应当可见`)
}
if (src.includes('snapshots') && src.includes('lastOp') && src.includes('lastSnapshotError')) {
  ok('信息:回滚 / 肇事 op / 快照失败 三件都在卡片里')
}

console.log('')
if (failed === 0) {
  console.log('OK: client.js 通过(语法 / 主题 token / 字形 / DOM 纪律 / 槽位)')
  process.exit(0)
}
console.log(`${failed} 项不合法`)
process.exit(1)
