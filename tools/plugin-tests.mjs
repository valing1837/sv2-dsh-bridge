// 插件半边(plugin/index.js)的**行为**测试。
//
// 为什么需要它:`check-plugin.mjs` 只验"工具定义合法"(schema / 路由 / 提示词段),
// 它不跑任何业务逻辑。于是插件侧最容易出错的那部分 —— **状态判断** —— 一直没人守:
// 桥到底算不算在线?面包屑算不算"冻住"?自动快照失败了有没有说出来?
// 这些判断错了,界面和工具会安静地给出**错的结论**(把"桥没在跑"说成"宿主被冻住了"
// 就是本文件第一次跑就抓到的那种)。
//
// 做法:不装插件、不碰真 SV2、不碰你的 profile —— 在 `.harness-run/plugin/` 里造一份
// 假的 home 与通道目录,把心跳 / 面包屑 / 快照栈写成**精心构造的那几种状态**,
// 再用桩 ctx 加载插件、真的去调它的工具,断言输出。
//
//   node plugin-tests.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RUN_ROOT = path.join(HERE, '.harness-run', 'plugin')
const HOME = path.join(RUN_ROOT, 'userprofile')
const DIR = path.join(HOME, '.dsh', 'sv-bridge')

// 默认测仓库里的那份;`--plugin <file>` 可以测**另一个副本** ——
// tools/check-mutants-js.mjs 就是靠它把"故意改坏"的副本喂进来的。
const argv = process.argv.slice(2)
const pi = argv.indexOf('--plugin')
const PLUGIN_FILE =
  pi >= 0 && argv[pi + 1] ? path.resolve(argv[pi + 1]) : path.join(HERE, '..', 'plugin', 'index.js')

// ⚠️ 必须在 import 插件**之前**改环境:插件的 ensureDir() 用的是 os.homedir(),
//    Windows 读 USERPROFILE、POSIX 读 HOME ⇒ 两个都指到运行目录里,
//    否则它会去动你真 home 下的 ~/.dsh/sv-bridge。
fs.rmSync(RUN_ROOT, { recursive: true, force: true })
fs.mkdirSync(DIR, { recursive: true })
process.env.USERPROFILE = HOME
process.env.HOME = HOME
process.env.TEMP = RUN_ROOT
process.env.TMP = RUN_ROOT
process.env.APPDATA = path.join(RUN_ROOT, 'appdata')

const mod = await import(pathToFileURL(PLUGIN_FILE).href)

// ---- 构造"桥正在跑、且第 6 笔没跑完"的状态 --------------------------------
const now = Math.floor(Date.now() / 1000)
const write = (name, obj) => fs.writeFileSync(path.join(DIR, name), JSON.stringify(obj, null, 2))

write('svdsh-hb-sv.json', {
  host: 'sv', hostName: 'Synthesizer V Studio 2 Pro', version: '2.3.0',
  hostVersionNumber: 131840, isSV2: true, indexBase: 1, dir: DIR, bridge: '0.8.0',
  protocol: 1, lua: 'Lua 5.4', timer: 'SV',
  ops: ['ping', 'get_context', 'snapshot', 'restore', 'selftest'],
  panel: true, session: 12345, reqSeen: 6, opsRun: 5, ticks: 999, pollErrors: 0, ts: now,
})
write('svdsh-lastop-sv.json', {
  stage: 'running', id: 'req-6', op: 'quantize', session: 12345, reqSeen: 6, opsRun: 5, ts: now,
})
write('svdsh-snapshots-sv.json', {
  seq: 3,
  items: [
    { id: 's1', ts: now - 300, groupName: 'Main', noteCount: 462, notes: [] },
    { id: 's2', ts: now - 120, label: 'split_notes', groupName: 'Main', noteCount: 464, notes: [] },
    { id: 's3', ts: now - 10, label: 'quantize', groupName: 'Main', noteCount: 462, notes: [] },
  ],
})
write('svdsh-boot-sv.json', { ok: true, bridge: '0.8.0', dir: DIR, ts: now - 60 })

// ---- 桩 ctx --------------------------------------------------------------
const tools = []
const routes = []
// 捕获提示词段 —— 这样"prompt 里到底写了什么"也能被断言,而不只是工具定义。
const sections = []
const makeEffect = () => (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} }
const ctx = {
  get: () => undefined,
  effect: makeEffect(),
  on: () => () => {},
  inject: (_names, cb) => cb({
    effect: makeEffect(), on: () => () => {}, get: () => undefined,
    webServer: { register: (r) => { routes.push(r); return () => {} } },
    systemPrompt: { section: (s) => { sections.push(s); return () => {} } },
    interval: () => () => {}, setInterval: () => () => {},
  }),
  tools: { register: (def) => { tools.push(def); return () => {} } },
}
// 超时压到 400ms:桥是模拟的(没有对端),别让每一步都等满 12 秒
mod.apply(ctx, { timeoutMs: 400, pollMs: 20 })

const exec = { agent: { id: 'session-plugin-tests' }, signal: new AbortController().signal }
const call = async (name, args) => {
  const t = tools.find((x) => x.name === name)
  try {
    return { ok: true, value: await t.execute(args ?? {}, exec) }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

let failed = 0
const check = (label, cond, got) => {
  if (cond) console.log(`  PASS  ${label}`)
  else {
    failed += 1
    console.log(`  FAIL  ${label}${got === undefined ? '' : `  (got ${JSON.stringify(got)})`}`)
  }
}
/** 工具抛错时给个空对象 —— 让断言干净地报"值不对",而不是在测试里再炸一次 */
const val = (r) => (r && r.ok ? r.value : {})

console.log('plugin-tests — 插件半边行为测试(模拟的桥状态)')
console.log(`  假 home: ${HOME}`)
console.log(`  通道目录: ${DIR}`)
console.log('')

console.log('— 桥在线 + 有快照 + 面包屑停在 running')
const st = val(await call('sv_status'))
check('online 判为真', st.online === true, st.online)
check('读到 3 份快照', st.snapshots.count === 3, st.snapshots.count)
check('最近一份是 s3 / quantize / 462 音',
  st.snapshots.latest.id === 's3' && st.snapshots.latest.label === 'quantize' &&
  st.snapshots.latest.noteCount === 462, st.snapshots.latest)
check('判成"冻住"并指名 op=quantize', st.frozen && st.frozen.op === 'quantize', st.frozen)
check('hint 给出可照做的处置', /模态框|中止所有脚本/.test(st.hint), st.hint)
check('lastOp 一起回出来', st.lastOp && st.lastOp.op === 'quantize' && st.lastOp.stage === 'running',
  st.lastOp)

console.log('\n— 自动快照失败必须被记下来(而不是静默)')
const tr = await call('sv_transpose', { semitones: 2, expectFp: 'deadbeef' })
check('写操作本身失败(模拟的桥没有响应)', tr.ok === false)
const st2 = val(await call('sv_status'))
check('lastSnapshotError 被记下且指名 op=transpose_selected',
  st2.lastSnapshotError && st2.lastSnapshotError.op === 'transpose_selected', st2.lastSnapshotError)

console.log('\n— sv_doctor:桥"在线"但自检打不通 ⇒ 如实报错 + nextSteps')
const doc = val(await call('sv_doctor'))
check('verdict 是告警而不是 OK', /有问题/.test(doc.verdict), doc.verdict)
check('仍然报告了快照与肇事 op',
  doc.snapshots.count === 3 && doc.frozen && doc.frozen.op === 'quantize')
check('selftest 打不通时不假装通过',
  doc.selftest === null && typeof doc.selftestError === 'string', doc.selftestError)
check('nextSteps 里含"冻住"那条', doc.nextSteps.some((s) => /模态框|冻住/.test(s)), doc.nextSteps)

console.log('\n— 桥离线(心跳被删掉):不能再说是"冻住"')
fs.rmSync(path.join(DIR, 'svdsh-hb-sv.json'), { force: true })
const st3 = val(await call('sv_status'))
check('online 判为假', st3.online === false, st3.online)
check('frozen 归 null —— 面包屑是上次运行的残留,不是证据', st3.frozen === null, st3.frozen)
check('hint 告诉用户去哪里跑桥', /运行 \[脚本\]/.test(st3.hint), st3.hint)
const doc2 = val(await call('sv_doctor'))
check('doctor 的 nextSteps 第一条是"没有心跳文件"',
  /心跳文件/.test(((doc2.nextSteps || [])[0]) || ''), doc2.nextSteps)

console.log('\n— 状态路由(浏览器半边拿的就是它)')
const route = routes.find((r) => r.path === '/dsh-sv-bridge/status')
check('路由注册了', Boolean(route))
const ask = (addr) => new Promise((resolve) => {
  route.handler({ socket: { remoteAddress: addr } },
    { writeHead: () => {}, end: (t) => resolve(t) })
})
const snap = JSON.parse(await ask('127.0.0.1'))
check('回环来源能拿到 JSON', snap.ok === true)
check('JSON 里有 snapshots / lastOp / frozen 三件',
  'snapshots' in snap && 'lastOp' in snap && 'frozen' in snap, Object.keys(snap))
check('非回环来源被 403 挡掉', /loopback only/.test(await ask('10.0.0.7')))

console.log('\n— 发给面板的那份文本:markdown 要变回纯文本(面板不渲染它)')
const { toPanelText, capPanelText, PANEL_TEXT_MAX } = mod
check('导出了 toPanelText / capPanelText', typeof toPanelText === 'function' && typeof capPanelText === 'function')
const md = [
  '## 结论',
  '',
  '**量化会造出 3 处重叠**,所以整批没写。',
  '',
  '- 第 50 拍 与 55 拍 冲突',
  '- 用 `quantize {dryRun:false}` 重来',
  '',
  '```lua',
  'print("hi")',
  '```',
].join('\n')
const plain = toPanelText(md)
check('去掉粗体星号', !plain.includes('**'), plain.slice(0, 40))
check('去掉标题号', !/^#/m.test(plain))
check('去掉行内反引号', !plain.includes('`'))
check('去掉代码围栏', !plain.includes('```'))
check('列表符换成省宽度的点', /^· /m.test(plain))
check('正文一字不少', /量化会造出 3 处重叠/.test(plain) && /print\("hi"\)/.test(plain))
check('空行不炸开(最多留一个空行)', !/\n{3,}/.test(plain))
check('纯文本输入原样通过', toPanelText('就一句话。') === '就一句话。')
const long = '字'.repeat(PANEL_TEXT_MAX + 500)
const capped = capPanelText(long)
check('超长回复会截断', capped.length < long.length && capped.length < PANEL_TEXT_MAX + 120)
check('⚠️ 截断必须自述(说清还剩多少字、去哪儿看)',
  /还有 500 字/.test(capped) && /DSH/.test(capped), capped.slice(-60))
check('不超长就不动它', capPanelText('短回复') === '短回复')

console.log('\n— 随包文档:prompt 点名的文件必须真的在包里,且路径是算出来的')
// 起因(2026-10-07,用户问"工作区清空对插件有没有影响"):prompt 里原本写的是
// `sv-dsh/docs/全参流程.md` —— 一个**工作区相对**路径。用户清空工作区之后,
// 那句话就成了空话(agent 会去找一个不存在的文件)。现在文档随包发、路径运行时算。
const { resolveDoc, BUNDLED_DOCS } = mod
check('导出了 resolveDoc / BUNDLED_DOCS',
  typeof resolveDoc === 'function' && Array.isArray(BUNDLED_DOCS))
check('清单非空', (BUNDLED_DOCS ?? []).length > 0, BUNDLED_DOCS)
for (const n of BUNDLED_DOCS ?? []) {
  const p = resolveDoc(n)
  check(`resolveDoc("${n}") 指到一个真实文件`, typeof p === 'string' && fs.existsSync(p), p)
}
check('解析出来的路径在插件自己的 docs/ 里(不是工作区)',
  String(resolveDoc('全参流程.md')).includes(`${path.sep}docs${path.sep}`),
  resolveDoc('全参流程.md'))
check('⚠️ 不在包里的文档名返回 null —— 不猜一个"看起来对"的路径',
  resolveDoc('不存在的文档.md') === null, resolveDoc('不存在的文档.md'))
// 提示词段:拿到的应该是**绝对路径**,而不是老那句工作区相对路径
const promptSection = sections.find((s) => s && s.name === 'sv-dsh-bridge')
const promptText = promptSection ? [].concat(promptSection.text).join('\n') : ''
check('提示词段拿到了', promptText.length > 0, promptSection && promptSection.name)
check('提示词里给的是解析后的绝对路径',
  promptText.includes(resolveDoc('全参流程.md')), promptText.slice(0, 0) || '')
check('提示词里不再有工作区相对的 sv-dsh/docs/ 路径',
  !promptText.includes('sv-dsh/docs/'))

console.log('\n— 配置夹取:sanitizeConfig 不许让一个写错的值变成"行为怪"')
// 起因:profile 里那几项配置是裸值。最典型的是 timeoutMs 给成 "abc" ⇒ NaN ⇒
// setTimeout(NaN) 立刻触发 ⇒ 每次调用都"超时",而报错完全看不出原因。
const { sanitizeConfig } = mod
check('导出了 sanitizeConfig', typeof sanitizeConfig === 'function')
const good = sanitizeConfig({ timeoutMs: 500, pollMs: 10 })
check('正常值原样通过', good.cfg.timeoutMs === 500 && good.cfg.pollMs === 10, good.cfg)
check('正常值不产生噪音', good.notes.length === 0, good.notes)
const badCfg = sanitizeConfig({ timeoutMs: 'abc' })
check('⚠️ 非数字 ⇒ 回落到默认(而不是 NaN)', badCfg.cfg.timeoutMs === 12000, badCfg.cfg.timeoutMs)
check('并且如实记下原因', /不是数字/.test(badCfg.notes.join(' ')), badCfg.notes)
const clamped = sanitizeConfig({ pollMs: 99999, maxPending: 0 })
check('超上限 ⇒ 夹住', clamped.cfg.pollMs === 2000, clamped.cfg.pollMs)
check('低于下限 ⇒ 夹住', clamped.cfg.maxPending === 1, clamped.cfg.maxPending)
check('夹取也记下来', /夹到/.test(clamped.notes.join(' ')), clamped.notes)
const emptyCfg = sanitizeConfig(undefined)
check('没给配置 ⇒ 全默认', emptyCfg.cfg.timeoutMs === 12000 && emptyCfg.notes.length === 0, emptyCfg.cfg)
const st0 = val(await call('sv_status'))
check('sv_status 会报出配置改动(这里是空数组)', Array.isArray(st0.configNotes), st0.configNotes)

console.log('\n— 自动快照:该拍的才拍')
// 起因:用户 2026-10-07 在 sv_status 里看到 5 份快照,而那轮**只做过 dry-run** ——
// dry-run 不改工程 ⇒ 白占快照位(上限 8),还会把真正要用的那份挤出去。
const { shouldSnapshot } = mod
check('导出了 shouldSnapshot', typeof shouldSnapshot === 'function')
check('写操作 + dryRun:true ⇒ **不拍**', shouldSnapshot('quantize', { dryRun: true }) === false)
check('写操作 + dryRun:false ⇒ 拍', shouldSnapshot('quantize', { dryRun: false }) === true)
check('写操作 + 没给 dryRun ⇒ 拍', shouldSnapshot('quantize', {}) === true)
check('写操作 + 连 args 都没有 ⇒ 拍', shouldSnapshot('quantize', undefined) === true)
check('只读 op ⇒ 不拍', shouldSnapshot('get_notes', {}) === false)
check('snapshot / restore 自己 ⇒ 不拍(否则回滚会把"要回滚的状态"再存一份)',
  shouldSnapshot('snapshot', {}) === false && shouldSnapshot('restore', {}) === false)
check('dryRun 只认布尔真(dryRun: 1 不算)', shouldSnapshot('quantize', { dryRun: 1 }) === true)

console.log('')
if (failed === 0) {
  console.log('OK: 插件半边行为全部通过')
  process.exit(0)
}
console.log(`${failed} 项失败`)
process.exit(1)
