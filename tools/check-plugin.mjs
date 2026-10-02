// 插件定义离线校验。
//
// 为什么必须存在:
//   `ctx.tools.register` 要的是**编译后**的 definition。把作者侧的属性表直接交进去,
//   模型看到的 schema 就没有 `type:"object"`,provider 会拒绝**整轮请求** ——
//   实测后果是整个会话所有对话都 400:
//     Invalid schema for function 'sv_bind': schema must be a JSON Schema of
//     'type: "object"', got 'type: null'.
//   这个错误只会在真机、而且是在模型请求那一刻才出现,排查代价极高。
//   ⇒ 在本地把每个工具的定义按模型面向的 schema 规则走一遍。
//
//   `plugin/index.js` 只 import node 内置模块,所以这里可以在**纯 Node** 里直接加载它,
//   用桩 ctx 调 apply(),拿到与真机**同一批**工具定义。
//
//   node check-plugin.mjs [plugin/index.js]
import fs from 'node:fs'
import path from 'node:path'

const entry = path.resolve(process.argv[2] ?? path.join('..', 'plugin', 'index.js'))

let failed = 0
const fail = (msg) => {
  failed += 1
  console.log(`FAIL  ${msg}`)
}

// JSON Schema 允许的 type 值。作者侧的 `json` 不在其中 —— 它必须编译成"无类型约束"。
const VALID_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
// 允许出现在 schema 节点上的键(对应 dsh-tools 的 DSL 词汇表)。
const ALLOWED_NODE_KEYS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'oneOf',
  'description',
  'title',
  'default',
  'examples',
])

/** 递归检查一个 schema 节点。path 只用于报错定位。 */
function checkSchema(node, where) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    fail(`${where} 必须是对象,实际是 ${Array.isArray(node) ? 'array' : typeof node}`)
    return
  }
  for (const key of Object.keys(node)) {
    if (!ALLOWED_NODE_KEYS.has(key)) fail(`${where}.${key} 不是合法的 schema 键`)
  }
  if (Object.hasOwn(node, 'type')) {
    if (!VALID_TYPES.has(node.type)) {
      fail(
        `${where}.type = ${JSON.stringify(node.type)} 不是合法的 JSON Schema 类型` +
          (node.type === 'json' ? '(作者侧的 "json" 要编译成无类型约束,即删掉 type)' : ''),
      )
    }
  }
  if (Object.hasOwn(node, 'properties')) {
    if (node.type !== 'object') fail(`${where} 有 properties 但 type 不是 "object"`)
    for (const [key, child] of Object.entries(node.properties)) {
      checkSchema(child, `${where}.properties.${key}`)
    }
  }
  if (Object.hasOwn(node, 'items')) checkSchema(node.items, `${where}.items`)
  if (Object.hasOwn(node, 'oneOf')) {
    if (node.type !== undefined) fail(`${where} 不能同时有 type 和 oneOf`)
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) fail(`${where}.oneOf 至少要有两项`)
    else node.oneOf.forEach((child, i) => checkSchema(child, `${where}.oneOf[${i}]`))
  }
  if (Object.hasOwn(node, 'required')) {
    if (!Array.isArray(node.required) || node.required.length === 0) {
      fail(`${where}.required 存在时必须是**非空**数组(空数组应当省略)`)
    } else if (Object.hasOwn(node, 'properties')) {
      for (const name of node.required) {
        if (!Object.hasOwn(node.properties, name)) fail(`${where}.required 提到未声明的属性 ${name}`)
      }
    }
  }
}

// ---------------------------------------------------------------------------

const source = fs.readFileSync(entry, 'utf8')
console.log(`check-plugin: ${entry}`)
console.log(`  ${source.split('\n').length} 行`)

let mod
try {
  mod = await import(`file://${entry.replace(/\\/g, '/')}`)
} catch (error) {
  fail(`无法加载插件模块:${error.message}`)
  process.exit(1)
}

for (const key of ['name', 'apply']) {
  if (!(key in mod)) fail(`缺少导出:${key}`)
}
if (Array.isArray(mod.inject) && !mod.inject.includes('tools')) {
  fail('inject 必须包含 "tools"(工具注册表是硬依赖)')
}

// 用桩 ctx 跑一遍 apply,拿到真机同一批工具定义。
// 桩必须覆盖 apply 用到的**每一个** ctx 成员 —— 缺一个就会在这里暴露出来
// (真机上那会是插件激活失败,而预设里的失败还会被吞掉,更难查)。
const registered = []
const listeners = []
const routes = []
const promptSections = []
const injected = []

const makeEffect = () => (fn) => {
  const disposer = fn()
  return typeof disposer === 'function' ? disposer : () => {}
}
const makeOn = () => (event, listener) => {
  listeners.push({ event, listener })
  return () => {}
}

const ctx = {
  get: () => undefined,
  effect: makeEffect(),
  // ⚠️ 桩必须**真的调用回调并给出所请求的服务**。
  //    如果这里写成空函数,那么"忘了用 ctx.inject、改成在 apply 里 ctx.get 然后静默跳过"
  //    这类 bug 就测不出来 —— 而那正是真机上"路由 404、前端永远显示未响应"的成因。
  inject: (names, callback) => {
    injected.push(...names)
    callback({
      effect: makeEffect(),
      on: makeOn(),
      get: () => undefined,
      webServer: {
        register: (route) => {
          routes.push(route)
          return () => {}
        },
      },
      systemPrompt: {
        section: (section) => {
          promptSections.push(section)
          return () => {}
        },
      },
      setInterval: () => () => {},
      interval: () => () => {},
    })
  },
  on: makeOn(),
  tools: {
    register: (definition) => {
      registered.push(definition)
      return () => {}
    },
  },
}

try {
  mod.apply(ctx, {})
} catch (error) {
  fail(`apply() 抛错(真机上会让整个预设挂掉):${error.message}`)
}

if (registered.length === 0) fail('apply() 没有注册任何工具')

const seen = new Set()
for (const tool of registered) {
  const where = tool?.name ?? '(未命名工具)'

  if (typeof tool.name !== 'string' || tool.name.length === 0) {
    fail('工具缺少 name')
    continue
  }
  if (seen.has(tool.name)) fail(`工具名重复:${tool.name}`)
  seen.add(tool.name)

  if (typeof tool.description !== 'string' || tool.description.trim().length === 0) {
    fail(`${where} 缺少 description`)
  }
  if (typeof tool.execute !== 'function') fail(`${where} 缺少 execute()`)

  // ★ 最关键的一条
  if (tool.parameters === undefined || tool.parameters === null) {
    fail(`${where} 缺少 parameters(即使是空参数也必须给 {type:'object',properties:{}})`)
  } else {
    if (tool.parameters.type !== 'object') {
      fail(
        `${where}.parameters.type 必须是 "object",实际是 ${JSON.stringify(tool.parameters.type)}` +
          '(直接把作者侧属性表交给 register 就会这样)',
      )
    }
    checkSchema(tool.parameters, `${where}.parameters`)
  }

  // output
  const output = tool.output
  if (!output || typeof output !== 'object') {
    fail(`${where} 缺少 output`)
  } else {
    if (!output.schema) fail(`${where}.output 缺少 schema`)
    else checkSchema(output.schema, `${where}.output.schema`)
    if (typeof output.render !== 'function') {
      fail(`${where}.output.render 必须是函数`)
    } else {
      let rendered
      try {
        rendered = output.render({}, { ok: true, sample: 1 })
      } catch (error) {
        fail(`${where}.output.render 抛错:${error.message}`)
      }
      if (rendered !== undefined) {
        if (!Array.isArray(rendered)) {
          fail(`${where}.output.render 必须返回 ContentBlock[](数组),实际是 ${typeof rendered}`)
        } else if (rendered.length === 0) {
          fail(`${where}.output.render 返回了空数组`)
        } else {
          for (const block of rendered) {
            if (!block || typeof block !== 'object' || typeof block.type !== 'string') {
              fail(`${where}.output.render 返回的元素不是 ContentBlock`)
              break
            }
          }
        }
      }
    }
  }
}

// 回复回显的监听器:没有它,SV2 面板里的"对话"就只有半场(只出不进)
if (!listeners.some((entry) => entry.event === 'session/event')) {
  fail('没有注册 session/event 监听器 —— SV2 面板里说的话收不到回答')
}

// 状态路由:没有它,DSH 输入框下面那枚徽标永远显示"插件未响应"
if (!routes.some((route) => route.path === '/dsh-sv-bridge/status')) {
  fail('没有注册 /dsh-sv-bridge/status 路由 —— 前端徽标会一直显示"插件未响应"')
}
for (const route of routes) {
  if (typeof route.handler !== 'function') fail(`路由 ${route.path} 没有 handler`)
}

// 常驻提示词:没有它,模型不知道要先读指纹
if (!promptSections.some((section) => section.name === 'sv-dsh-bridge')) {
  fail('没有注册 sv-dsh-bridge 提示词段')
}

// 可选依赖必须用 ctx.inject 声明,不能在 apply 里 ctx.get 然后静默跳过
for (const service of ['webServer', 'systemPrompt', 'timer']) {
  if (!injected.includes(service)) {
    fail(
      `没有用 ctx.inject 声明可选依赖 "${service}" —— ` +
        '在 apply 里 ctx.get 会因为激活顺序拿不到,而且会**静默跳过**注册',
    )
  }
}

console.log('')
if (failed === 0) {
  console.log(`OK: ${registered.length} 个工具的定义都合法`)
  console.log(`    ${registered.map((t) => t.name).join(', ')}`)
  console.log(`    监听器:${listeners.map((l) => l.event).join(', ') || '(无)'}`)
  console.log(`    路由:${routes.map((r) => r.path).join(', ') || '(无)'}`)
  console.log(`    提示词段:${promptSections.map((s) => s.name).join(', ') || '(无)'}`)
  console.log(`    可选依赖:${[...new Set(injected)].join(', ') || '(无)'}`)
  process.exit(0)
}
console.log(`${failed} 项不合法`)
process.exit(1)
