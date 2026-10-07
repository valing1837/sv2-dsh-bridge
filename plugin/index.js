// dsh-sv-bridge —— DSH 宿主半边。
//
// 职责:
//   ① 把 SV2 里那个常驻 Lua 桥当成本机的一个"外部设备"来驱动:写请求、轮询响应、读心跳。
//   ② 把 SV2 面板里说的话注入 DSH 会话(agent.followup)。
//   ③ 给 agent 一组 sv_* 工具。
//
// 设计约束(都有出处,别改):
//   · **不 import 任何 @deepseek-ai/* 包**。本 bundle 是 `link:` 到工作区的,
//     模块解析链与 profile 完全不同,bundled 包能不能解析到没有保证。
//     所有宿主能力都走 `ctx.get(...)`。
//   · ⚠️ **`ctx.tools.register` 要的是"编译后"的 definition,不是作者侧的 DSL。**
//     官方工具用 `defineTool({parameters: {x: {...}}})` 包一层,由它编译成
//     `{type:'object', properties, required}`(dsh-tools/lib/types/schema.js:238-247、295-301)。
//     直接把属性表交给 register,模型看到的 schema 就**没有 type:"object"**,
//     provider 会直接拒绝整轮请求(实测:会话里所有对话都 400,
//     报 "Invalid schema for function 'sv_bind': ... got 'type: null'")。
//     这里用 `objectSchema()` 手写等价的编译结果,不引入依赖。
//     `tools/check-plugin.mjs` 会离线守住这条。
//   · `agent.followup()` **不做消息归一化**(dsh-agent-loop/lib/index.js:806 → send → inbox.splice),
//     所以必须自己构造完整的 UserMessage:`{ id, role:'user', content, source }`。
//   · `source.kind` 用 `'user'`:`'plugin'` 不在 MessageSourceMap 里。
//   · `ctx.setInterval` 是 `timer` 服务的 mixin,不声明 inject 就访问会抛
//     `cannot get property "timer" without inject` ⇒ 用 `ctx.inject(['timer'], ...)`。
//   · 同一时刻只允许一个在途请求(Lua 桥只有一个 req 槽),所以这里串行化。
//   · apply() 阶段**不能抛错**:预设里任何一个插件激活失败,整个预设都会挂。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-sv-bridge'

/** 工具注册表是硬依赖;其余服务都在调用时用 ctx.get 取,缺失就优雅降级。 */
export const inject = ['tools']

const PROTOCOL = 1
/** 心跳多久算过期。桥的轮询间隔是 250ms、心跳 5s,15s 留了余量。 */
const HB_STALE_MS = 15000

const FILE = {
  req: 'svdsh-req-sv.json',
  res: 'svdsh-res-sv.json',
  hb: 'svdsh-hb-sv.json',
  boot: 'svdsh-boot-sv.json',
  chatIn: 'svdsh-chat-in.jsonl',
  chatOut: 'svdsh-chat-out.json',
  state: 'svdsh-plugin-state.json',
  /** 桥写的快照栈(最近 8 份)。插件只读它 —— 不必为"能不能回滚"多跑一次桥。 */
  snapshots: 'svdsh-snapshots-sv.json',
  /** 桥的肇事面包屑:每笔请求执行前写 stage=running,跑完改 done。 */
  lastOp: 'svdsh-lastop-sv.json',
}

/**
 * 这些 op 会改**一个组里的音符**,所以调用前先自动留一份快照。
 *
 * ⚠️ 为什么只列这些:`restore`/`snapshot` 自己不能触发(否则回滚会先把"要回滚的状态"
 *    再存一份,第二次回滚就回不去了);组级操作(新建/删除组)、自动化曲线、声音属性
 *    也不在里面 —— 快照只覆盖音符层,列进来会给人"回滚能救它"的错觉。
 */
const SNAPSHOT_BEFORE = new Set([
  'delete_notes',
  'split_notes',
  'transpose_selected',
  'set_lyrics',
  'apply_lyrics',
  'align_lyrics',
  'set_note_attrs',
  'quantize',
  'apply_ornaments',
  'write_pit',
  'clear_pit',
  'auto_tone_shift',
  'auto_expression',
  // 0.8.3 起快照也存**编排布局**(每条轨的引用清单)⇒ 组级操作同样能回滚:
  //   · write_notes 建出来的组 → 回滚把它从轨上摘掉;
  //   · group_ops delete 摘掉的引用 → 回滚挂回去(组还在库里);
  //   · group_ops move 挪到别的轨 → 回滚挪回来;
  //   · 时间范围 / 时间与音高偏移变了 → 回滚改回去。
  // ⚠️ `track_ops remove` **不在**名单里:删掉一整条轨(连同它的名字/颜色/混音)回滚不了,
  //    列进来只会给人"能救"的错觉 —— 那条路靠它自己的守卫。
  'write_notes',
  'group_ops',
])

const DEFAULTS = {
  pollMs: 40,
  timeoutMs: 12000,
  watchMs: 1000,
  maxPending: 50,
}

// ---------------------------------------------------------------------------
// 模型面向的 JSON Schema
// ---------------------------------------------------------------------------

/**
 * 把"属性表 + required"编译成模型面向的对象 schema。
 *
 * 等价于 `defineTool` 内部做的 `parameterSchemaSpecToJsonSchema`,但不需要 import。
 * 见文件头:直接交属性表会让 schema 缺 `type:"object"`,provider 会拒绝整轮请求。
 */
function objectSchema(properties, required) {
  return {
    type: 'object',
    properties: properties ?? {},
    ...(Array.isArray(required) && required.length > 0 ? { required } : {}),
  }
}

/** 结果统一按 JSON 文本回给模型。`render` 必须返回 ContentBlock[],不能返回裸字符串。 */
const JSON_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

// ---------------------------------------------------------------------------
// 目录:必须与 Lua 桥的 pickDir() 用**同一套顺序**,否则就是"两端目录不一致"那个头号故障
// ---------------------------------------------------------------------------

function candidateDirs() {
  const out = []
  const home = os.homedir()
  if (home) out.push(path.join(home, '.dsh', 'sv-bridge'))
  const tmp = process.env.TEMP || process.env.TMP
  if (tmp) out.push(path.join(tmp, 'dsh-sv-bridge'))
  return out
}

/** 建目录(Lua 不能 mkdir,所以这一步必须由插件做)并返回第一个可写的。 */
function ensureDir() {
  for (const dir of candidateDirs()) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.accessSync(dir, fs.constants.W_OK)
      return dir
    } catch {
      // 换下一个候选
    }
  }
  throw new Error(
    '找不到可写的工作目录。请确认 %USERPROFILE%\\.dsh 存在且可写,或 %TEMP% 可用。',
  )
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** 原子替换:先写 .tmp 再 rename(Node 的 rename 在 Windows 上可以覆盖目标)。 */
function atomicWrite(file, text) {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// "宿主里跑的是不是旧实例" —— 自动检测
//
// 常驻脚本不会热更:把新脚本复制进 SV2 的 scripts 目录之后,如果没在宿主里
// [中止所有脚本] 再重新运行,跑着的仍然是旧代码 —— 而它自报的版本号不会变,
// 光看版本号看不出来。
//
// 判据很简单也很可靠:**部署文件的修改时间 > 桥的启动时间 ⇒ 跑的是旧实例**。
// 两个时间我们都有:文件 mtime 由插件读,桥的启动时间在 boot 文件里。
// ---------------------------------------------------------------------------

function deployedBridgePath() {
  const appData = process.env.APPDATA
  if (!appData) return undefined
  return path.join(
    appData,
    'Dreamtonics',
    'Synthesizer V Studio 2',
    'scripts',
    'DSH',
    'DSHBridge.lua',
  )
}

function scriptStaleness(bootTs) {
  const file = deployedBridgePath()
  if (!file) return { known: false }
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    return { known: true, exists: false, path: file }
  }
  const mtimeSec = Math.floor(stat.mtimeMs / 1000)
  const boot = Number(bootTs ?? 0)
  return {
    known: true,
    exists: true,
    path: file,
    size: stat.size,
    modifiedAt: mtimeSec,
    bridgeStartedAt: boot > 0 ? boot : null,
    // +2s 容忍"写完文件 → 立刻启动"的先后抖动
    stale: boot > 0 && mtimeSec > boot + 2,
  }
}

// ---------------------------------------------------------------------------
// 插件状态:绑定到哪个会话、队列里还有几条、聊天文件读到哪了
// ---------------------------------------------------------------------------

function loadState(dir) {
  const raw = readJson(path.join(dir, FILE.state))
  return {
    boundSession: typeof raw?.boundSession === 'string' ? raw.boundSession : undefined,
    chatOffset: Number.isInteger(raw?.chatOffset) ? raw.chatOffset : 0,
    pending: Array.isArray(raw?.pending) ? raw.pending.slice(0, DEFAULTS.maxPending) : [],
    outRev: Number.isInteger(raw?.outRev) ? raw.outRev : 0,
    // 是否正等着把这一轮的回复送回 SV2 面板(见 session/event 监听器)
    awaitingReplyFromSv: raw?.awaitingReplyFromSv === true,
  }
}

function saveState(dir, state) {
  try {
    atomicWrite(
      path.join(dir, FILE.state),
      JSON.stringify(
        {
          boundSession: state.boundSession,
          chatOffset: state.chatOffset,
          pending: state.pending,
          outRev: state.outRev,
          awaitingReplyFromSv: state.awaitingReplyFromSv === true,
        },
        null,
        2,
      ),
    )
  } catch {
    // 状态落盘失败不该让工具调用失败
  }
}

// ---------------------------------------------------------------------------
// 桥调用(串行化:桥只有一个 req 槽)
// ---------------------------------------------------------------------------

let chain = Promise.resolve()
function serialize(work) {
  const run = chain.then(work, work)
  chain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

let seqCounter = 0

function describeOffline(dir, hb) {
  const boot = readJson(path.join(dir, FILE.boot))
  const lines = ['SV2 那边的桥不在线。']
  if (!hb) {
    lines.push(
      `没有心跳文件(${path.join(dir, FILE.hb)})。`,
      '请确认:① 在 SV2 里运行过 [脚本] > [DSH] > [DSH Bridge];',
      '② 它没被 [脚本] > [中止所有脚本] 杀掉;',
      '③ 脚本目录是 %APPDATA%\\Dreamtonics\\Synthesizer V Studio 2\\scripts。',
    )
  } else {
    const age = Math.round((Date.now() - Number(hb.ts ?? 0) * 1000) / 1000)
    lines.push(
      `心跳已过期(${age}s 前,阈值 ${HB_STALE_MS / 1000}s)。桥可能被关掉了,或宿主被模态框冻住了。`,
    )
    if (boot && boot.ok === false) lines.push(`上次启动失败:${boot.reason ?? '(无原因)'}`)
  }
  lines.push(`插件实际使用的目录:${dir}`)
  if (hb?.dir && hb.dir !== dir) {
    lines.push(`⚠️ 桥自报的目录是 ${hb.dir} —— 两端目录不一致,请求会被永远忽略。`)
  }
  return lines.join('\n')
}

function callBridge(dir, op, args, signal, cfg) {
  return serialize(async () => {
    const hb = readJson(path.join(dir, FILE.hb))
    if (!hb) throw new Error(describeOffline(dir, undefined))
    const age = Date.now() - Number(hb.ts ?? 0) * 1000
    if (!Number.isFinite(age) || age > HB_STALE_MS) throw new Error(describeOffline(dir, hb))
    if (Array.isArray(hb.ops) && !hb.ops.includes(op)) {
      throw new Error(
        `桥不支持 op "${op}"(它自报的能力:${hb.ops.join(', ')})。` +
          '如果你刚改过桥,记得在宿主里重跑它 —— 常驻脚本不会热更。',
      )
    }

    const id = `svdsh-${Date.now()}-${seqCounter++}`
    const seq = Date.now() * 1000 + (seqCounter % 1000)
    const reqFile = path.join(dir, FILE.req)
    const resFile = path.join(dir, FILE.res)

    // 先删旧响应,否则可能读到上一轮的
    try {
      fs.rmSync(resFile, { force: true })
    } catch {
      /* 删不掉就靠 id 比对兜底 */
    }
    atomicWrite(reqFile, JSON.stringify({ v: PROTOCOL, id, seq, op, args: args ?? {} }))

    const deadline = Date.now() + cfg.timeoutMs
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('调用被取消')
      const res = readJson(resFile)
      if (res && String(res.id) === id) {
        if (res.ok) return res.result
        throw new Error(`桥拒绝了 ${op}:${res.error}`)
      }
      await sleep(cfg.pollMs)
    }

    // 超时是"模糊"的:宿主可能仍在写。别急着重试写操作。
    throw new Error(
      `${op} 在 ${cfg.timeoutMs}ms 内没有响应。\n` +
        '超时只代表"我们不等了",宿主可能仍在处理 —— **不要立刻重试写操作**,先读一次看有没有落盘。\n' +
        `桥日志:${path.join(dir, 'svdsh-log-sv.txt')}`,
    )
  })
}

// ---------------------------------------------------------------------------
// 聊天通道:SV2 → DSH
// ---------------------------------------------------------------------------

/** 读 jsonl 的**完整行**,返回 { lines, newOffset }。半行留给下一轮。 */
function readCompleteLines(file, offset) {
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    return { lines: [], newOffset: 0 }
  }
  if (stat.size < offset) offset = 0 // 文件被重建/截断
  if (stat.size === offset) return { lines: [], newOffset: offset }

  const length = stat.size - offset
  const buffer = Buffer.alloc(length)
  const fd = fs.openSync(file, 'r')
  try {
    fs.readSync(fd, buffer, 0, length, offset)
  } finally {
    fs.closeSync(fd)
  }

  const text = buffer.toString('utf8')
  const parts = text.split('\n')
  const tail = parts.pop() ?? ''
  const consumed = length - Buffer.byteLength(tail, 'utf8')
  return { lines: parts.filter((line) => line.trim().length > 0), newOffset: offset + consumed }
}

function makeUserMessage(text) {
  // 见文件头:followup 不归一化,必须给完整的 UserMessage。
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

async function deliverToSession(ctx, sessionId, text) {
  let agent = ctx.get('agents')?.get(sessionId)
  if (!agent) {
    // 冷会话:没有 live Agent。试着把它唤醒(需要会话持久化服务)。
    const controller = ctx.get('sessionController')
    if (controller && typeof controller.resolveAgent === 'function') {
      try {
        const resolved = await controller.resolveAgent(sessionId)
        if (resolved && !('error' in resolved)) agent = resolved.agent
      } catch {
        /* 下面统一报错 */
      }
    }
  }
  if (!agent) {
    throw new Error(
      `绑定的会话 ${sessionId} 当前没有活动 agent。请在 DSH 里打开那个会话(或重新用 sv_bind 绑定当前会话)。`,
    )
  }
  agent.followup(makeUserMessage(text))
}

// ---------------------------------------------------------------------------

/**
 * 把回复压成"窄面板友好"的纯文本。
 *
 * 为什么需要:SV2 侧栏那个 TextArea **不渲染 markdown** —— `**粗体**`、`` `代码` ``、
 * `## 标题` 到了那儿只是一串**多出来的字符**,在两百多像素宽的框里既占宽度又是噪音。
 * 面板本来就窄(用户 2026-10-07 提醒过"框挺小的"),所以这里先把它变回纯文本。
 *
 * ⚠️ 只处理**发给面板的那一份**;DSH 界面里看到的回复原样不动。
 */
export function toPanelText(text) {
  let t = String(text ?? '')
  t = t.replace(/```[a-zA-Z0-9_+-]*\n?/g, '') // 代码围栏
  t = t.replace(/`([^`\n]*)`/g, '$1') // 行内代码
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '$1') // 粗体
  t = t.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1$2') // 斜体(别吃掉列表符)
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '') // 标题号
  t = t.replace(/^\s*[-*+]\s+/gm, '· ') // 列表符换成最省宽度的点
  t = t.replace(/\n{3,}/g, '\n\n')
  return t.trim()
}

/** 面板里一屏大概能看多少字(≈236px 宽 × 460px 高)。超了就如实截断并指路。 */
export const PANEL_TEXT_MAX = 1200

/**
 * 太长的回复截断 —— 但**绝不静默**:把还剩多少字、去哪儿看写清楚。
 * 面板是"扫一眼"的地方,完整内容在 DSH 里(面板自己的设计就是这么定的)。
 */
export function capPanelText(t, max = PANEL_TEXT_MAX) {
  const s = String(t ?? '')
  if (s.length <= max) return s
  return s.slice(0, max) + `\n…(面板只显示到这里,还有 ${s.length - max} 字 —— 完整回复在 DSH 里看)`
}

// ---------------------------------------------------------------------------

/**
 * 构建工具清单。
 *
 * 抽成独立函数是为了让 `tools/check-plugin.mjs` 能**离线**拿到同一批定义并校验 schema ——
 * 「schema 缺 type:object 会打爆整个会话」这个坑不该再靠真机发现。
 */
export function buildTools(deps) {
  const {
    dir, state, cfg, setupError, requireDir, saveStateNow, pushToPanel, autoBind, callOp,
    readSnapshots, readLastOp, frozenCrumb, getLastSnapshotError,
  } = deps
  void cfg
  void requireDir

  const statusTool = {
    name: 'sv_status',
    description:
      'Report the Synthesizer V Studio bridge: whether the in-host bridge is running, the host version, the ops it advertises, which DSH session receives messages typed in SV2, how many SV2 messages are still queued, and whether a rollback snapshot is available. Call this first when anything SV-related misbehaves.',
    parameters: objectSchema({}),
    output: JSON_OUTPUT,
    async execute(_args, exec) {
      autoBind(exec)
      const base = dir
      const hb = base ? readJson(path.join(base, FILE.hb)) : undefined
      const boot = base ? readJson(path.join(base, FILE.boot)) : undefined
      const ageMs = hb ? Date.now() - Number(hb.ts ?? 0) * 1000 : undefined
      const online = Boolean(hb) && Number.isFinite(ageMs) && ageMs <= HB_STALE_MS
      const staleness = scriptStaleness(boot?.ts)
      const frozen = frozenCrumb(hb)
      return {
        online,
        dir: base ?? null,
        dirReady: Boolean(base),
        setupError: setupError ? String(setupError.message ?? setupError) : null,
        bridgeDirReported: hb?.dir ?? null,
        dirMatches: base && hb?.dir ? path.resolve(hb.dir) === path.resolve(base) : null,
        bridgeVersion: hb?.bridge ?? null,
        hostName: hb?.hostName ?? null,
        hostVersion: hb?.version ?? null,
        heartbeatAgeSeconds: Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : null,
        ops: Array.isArray(hb?.ops) ? hb.ops : [],
        panelRelay: hb?.panel ?? null,
        // 部署的脚本文件比桥的启动时间还新 ⇒ 宿主里跑的是旧实例
        scriptStaleness: staleness,
        lastBoot: boot ?? null,
        boundSession: state.boundSession ?? null,
        queuedFromSv: state.pending.length,
        // 可回滚性:桥写的快照栈(只读文件,不用再跑一次桥)
        snapshots: readSnapshots(),
        // 自动快照失败过就说出来 —— "以为能回滚"是最坏的那种静默
        lastSnapshotError: (() => {
          const e = getLastSnapshotError ? getLastSnapshotError() : null
          return e ? { op: e.op, message: e.message } : null
        })(),
        // 肇事面包屑:被模态框冻住时,这一条能指名是哪个 op
        lastOp: readLastOp(),
        frozen,
        hint: frozen
          ? `⚠️ 宿主可能被 **${frozen.op}** 弹的模态框冻住了(面包屑停在 stage=running)。` +
            '请到 SV2 里关掉那个错误框,存盘后 [中止所有脚本] 再重跑 DSH Bridge。'
          : !online
            ? '桥离线:在 SV2 里运行 [脚本] > [DSH] > [DSH Bridge]。注意常驻脚本不会热更,改过桥要重跑。'
            : staleness.stale
              ? '⚠️ 部署的脚本文件比桥的启动时间新 —— 宿主里跑的是**旧实例**。' +
                '请在 SV2 里 [脚本] > [中止所有脚本],再重新运行 DSH Bridge。'
              : '桥在线,可以直接用 sv_context / sv_notes 等工具。',
      }
    },
  }

  const contextTool = {
    name: 'sv_context',
    description:
      'Read what is currently open in Synthesizer V Studio: project file, track, current group, note count, tempo, and how many notes are selected. Use it to orient before reading or writing notes.',
    parameters: objectSchema({}),
    output: JSON_OUTPUT,
    async execute(_args, exec) {
      autoBind(exec)
      return callOp('get_context', {}, exec)
    },
  }

  const notesTool = {
    name: 'sv_notes',
    description:
      'Read the notes currently selected in Synthesizer V Studio. Returns each note plus an `fp` fingerprint for the whole selection. Any write tool requires that `fp` back as `expectFp`: if the user edited the project in the meantime the write is refused with STALE_SELECTION instead of hitting the wrong notes.',
    parameters: objectSchema({
      limit: {
        type: 'number',
        description:
          'Maximum notes to return. Defaults to 512. The result reports `truncated` when it cut off.',
      },
    }),
    output: JSON_OUTPUT,
    async execute(args, exec) {
      autoBind(exec)
      return callOp('get_selected_notes', args ?? {}, exec)
    },
  }

  const transposeTool = {
    name: 'sv_transpose',
    description:
      'Transpose the notes currently selected in Synthesizer V Studio by a number of semitones. Requires the `expectFp` fingerprint from the most recent sv_notes call; pitches that would leave 0..127 are skipped and reported.',
    parameters: objectSchema(
      {
        semitones: { type: 'number', description: 'Integer semitones, -48..48.' },
        expectFp: {
          type: 'string',
          description: 'The `fp` from the most recent sv_notes result, unchanged.',
        },
      },
      ['semitones', 'expectFp'],
    ),
    output: JSON_OUTPUT,
    async execute(args, exec) {
      autoBind(exec)
      return callOp('transpose_selected', args, exec)
    },
  }

  const lyricsTool = {
    name: 'sv_lyrics',
    description:
      'Write lyrics onto the notes currently selected in Synthesizer V Studio, either one string for every note (`lyrics`) or one string per note (`lyricsList`). Requires the `expectFp` fingerprint from the most recent sv_notes call.',
    parameters: objectSchema(
      {
        lyrics: { type: 'string', description: 'One syllable/word written to every selected note.' },
        lyricsList: {
          type: 'array',
          items: { type: 'string' },
          description:
            'One entry per selected note, in selection order. Must match the selection count exactly.',
        },
        expectFp: {
          type: 'string',
          description: 'The `fp` from the most recent sv_notes result, unchanged.',
        },
      },
      ['expectFp'],
    ),
    output: JSON_OUTPUT,
    async execute(args, exec) {
      autoBind(exec)
      return callOp('set_lyrics', args, exec)
    },
  }

  const attrsTool = {
    name: 'sv_note_attrs',
    description:
      'Batch-edit selected notes in Synthesizer V Studio. Each update addresses a note by its 0-based index within the current selection and may set pitch, duration (blicks), and/or lyrics. The whole batch is validated before anything is written: an unknown field or an out-of-range value rejects the entire call.',
    parameters: objectSchema(
      {
        updates: {
          type: 'array',
          // ⚠️ 这里是"任意 JSON"。作者侧写作 `type:'json'`,但它**不是**合法的 JSON Schema 类型;
          //    defineTool 会把它编译成"无类型约束"的节点。手写 schema 就必须留空。
          items: {},
          description:
            'Array of { index, pitch?, duration?, lyrics? }. `index` is 0-based within the selection.',
        },
        expectFp: {
          type: 'string',
          description: 'The `fp` from the most recent sv_notes result, unchanged.',
        },
      },
      ['updates', 'expectFp'],
    ),
    output: JSON_OUTPUT,
    async execute(args, exec) {
      autoBind(exec)
      return callOp('set_note_attrs', args, exec)
    },
  }

  const bindTool = {
    name: 'sv_bind',
    description:
      'Choose which DSH session receives messages typed in the Synthesizer V Studio panel. Defaults to the session calling this tool. Any sv_* call binds automatically, so use this only to point the bridge at a different session or to inspect the binding.',
    parameters: objectSchema({
      sessionId: {
        type: 'string',
        description: 'Session id to bind. Omit to bind the calling session. Pass "none" to unbind.',
      },
    }),
    output: JSON_OUTPUT,
    async execute(args, exec) {
      const requested = typeof args?.sessionId === 'string' ? args.sessionId.trim() : ''
      if (requested === 'none' || requested === '-') {
        state.boundSession = undefined
      } else if (requested.length > 0) {
        state.boundSession = requested
      } else if (exec?.agent?.id) {
        state.boundSession = exec.agent.id
      }
      saveStateNow()
      return { boundSession: state.boundSession ?? null, queuedFromSv: state.pending.length }
    },
  }

  const sayTool = {
    name: 'sv_say',
    description:
      'Show a short line of text in the Synthesizer V Studio side panel. Use it to report progress or ask the user something while they are looking at SV2 rather than at DSH.',
    parameters: objectSchema(
      { text: { type: 'string', description: 'Plain text, one or two lines.' } },
      ['text'],
    ),
    output: JSON_OUTPUT,
    async execute(args) {
      pushToPanel(String(args?.text ?? ''))
      return { delivered: true, rev: state.outRev }
    },
  }

  const callTool = {
    name: 'sv_call',
    description:
      'Call an op on the Synthesizer V Studio bridge directly. Use sv_status to see which ops the running bridge advertises. Prefer the dedicated tools (sv_context, sv_notes, sv_transpose, sv_lyrics, sv_note_attrs) when they cover the task.',
    parameters: objectSchema(
      {
        op: { type: 'string', description: 'Op name, e.g. get_context.' },
        // 任意 JSON:见 sv_note_attrs 的说明,作者侧的 type:'json' 编译后是"无类型约束"。
        args: { description: 'Arguments object for the op.' },
      },
      ['op'],
    ),
    output: JSON_OUTPUT,
    async execute(args, exec) {
      autoBind(exec)
      return callOp(args.op, args.args ?? {}, exec)
    },
  }

  const undoTool = {
    name: 'sv_undo',
    description:
      'Roll the current Synthesizer V Studio project back to a snapshot. A snapshot is taken AUTOMATICALLY before every note-level or group-level write (delete/split/transpose/lyrics/attrs/quantize/pitch curves/ornaments/auto-tune/write_notes/group_ops), so this is the safety net for "the write was valid but wrong". With no `id` it restores the most recent snapshot; sv_status lists what is available. Coverage: the note layer (onset/duration/pitch/lyrics) of the snapshot\'s group PLUS the arrangement layout (which groups are mounted on which track, their order, time range and offsets — so a created group is unmounted, a deleted one is re-mounted, a moved one comes back). NOT covered: the attribute layer, orphaned data in the group library, automation curves, voice settings, tempo/meter marks.',
    parameters: objectSchema({
      id: {
        type: 'string',
        description:
          'Snapshot id from sv_status (e.g. "s3"). Omit to roll back to the most recent one.',
      },
    }),
    output: JSON_OUTPUT,
    async execute(args, exec) {
      autoBind(exec)
      const payload = {}
      if (typeof args?.id === 'string' && args.id.trim().length > 0) payload.id = args.id.trim()
      return callOp('restore', payload, exec)
    },
  }

  const doctorTool = {
    name: 'sv_doctor',
    description:
      'Diagnose the Synthesizer V Studio bridge end to end and return a checklist plus the next action to take. Runs an active self-test inside the host (channel dir writable, atomic rename-over-existing, read-back, delete, heartbeat, log, timer chain, host/project readable, snapshot store) and adds what only this side can see: heartbeat freshness, whether the deployed script is newer than the running bridge, whether both ends agree on the channel directory, whether the host is frozen behind a modal dialog, and whether a rollback snapshot exists. Use it instead of guessing whenever the bridge looks offline or a tool times out.',
    parameters: objectSchema({}),
    output: JSON_OUTPUT,
    async execute(_args, exec) {
      autoBind(exec)
      const base = dir
      const hb = base ? readJson(path.join(base, FILE.hb)) : undefined
      const boot = base ? readJson(path.join(base, FILE.boot)) : undefined
      const ageMs = hb ? Date.now() - Number(hb.ts ?? 0) * 1000 : undefined
      const online = Boolean(hb) && Number.isFinite(ageMs) && ageMs <= HB_STALE_MS
      const staleness = scriptStaleness(boot?.ts)
      const dirMatches = base && hb?.dir ? path.resolve(hb.dir) === path.resolve(base) : null

      let selftest = null
      let selftestError = null
      if (online) {
        try {
          selftest = await callOp('selftest', {}, exec)
        } catch (error) {
          selftestError = String(error?.message ?? error)
        }
      }

      const nextSteps = []
      if (!base) {
        nextSteps.push(
          '插件没能准备好通道目录:' +
            (setupError ? String(setupError.message ?? setupError) : '未知原因') +
            ' —— 确认 %USERPROFILE%\\.dsh(或 macOS 的 ~/.dsh)可写,然后重装/重启插件。',
        )
      }
      if (!hb) {
        nextSteps.push(
          '没有心跳文件 ⇒ 宿主里还没运行过桥:SV2 → [脚本] > [DSH] > [DSH Bridge]。',
        )
      } else if (!online) {
        nextSteps.push(
          `心跳已过期(${Math.round((ageMs ?? 0) / 1000)}s,阈值 ${HB_STALE_MS / 1000}s)` +
            ' ⇒ 桥被关掉了、或宿主被模态框冻住。先在 SV2 里关掉错误框,再重跑桥。',
        )
      }
      if (dirMatches === false) {
        nextSteps.push(
          `⚠️ 两端目录不一致:插件用 ${base},桥自报 ${hb?.dir} ⇒ 请求会被永远忽略。` +
            '让插件重新建目录(重启插件)后在宿主里重跑桥。',
        )
      }
      if (staleness.stale) {
        nextSteps.push(
          '部署的脚本文件比桥的启动时间新 ⇒ 宿主里跑的是**旧实例**:' +
            '[中止所有脚本] 再重新运行 DSH Bridge。',
        )
      }
      const frozen = frozenCrumb(hb)
      if (frozen) {
        nextSteps.push(
          `宿主可能被 **${frozen.op}** 弹的模态框冻住了(面包屑停在 stage=running,id=${frozen.id})。`,
        )
      }
      if (selftest && selftest.ok === false) {
        for (const c of selftest.checks ?? []) {
          if (c.ok !== true) nextSteps.push(`桥自检未通过:${c.name} —— ${c.detail}`)
        }
      }
      if (selftestError) nextSteps.push(`自检本身失败:${selftestError}`)
      if (nextSteps.length === 0) {
        nextSteps.push('没发现问题。要动工程就直接用 sv_context / sv_notes。')
      }

      return {
        verdict:
          online && dirMatches !== false && !staleness.stale && !frozen && (!selftest || selftest.ok)
            ? 'OK:桥在线且自检通过'
            : '⚠️ 有问题 —— 看 nextSteps',
        online,
        dir: base ?? null,
        dirMatches,
        bridgeVersion: hb?.bridge ?? null,
        hostName: hb?.hostName ?? null,
        hostVersion: hb?.version ?? null,
        heartbeatAgeSeconds: Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : null,
        opCount: Array.isArray(hb?.ops) ? hb.ops.length : 0,
        scriptStaleness: staleness,
        frozen,
        lastOp: readLastOp(),
        snapshots: readSnapshots(),
        lastSnapshotError: (() => {
          const e = getLastSnapshotError ? getLastSnapshotError() : null
          return e ? { op: e.op, message: e.message } : null
        })(),
        lastBoot: boot ?? null,
        selftest,
        selftestError,
        nextSteps,
      }
    },
  }

  return [
    statusTool,
    contextTool,
    notesTool,
    transposeTool,
    lyricsTool,
    attrsTool,
    bindTool,
    sayTool,
    undoTool,
    doctorTool,
    callTool,
  ]
}

// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }

  // ⚠️ 目录准备**不能**在 apply 阶段抛错:预设里的任何一个插件激活失败,
  //    整个预设(连 persona 和其它工具)都会跟着挂。所以这里只记下错误,
  //    等真正要用的时候再以清晰的报错抛出去。
  let dir
  let state = {
    boundSession: undefined,
    chatOffset: 0,
    pending: [],
    outRev: 0,
    awaitingReplyFromSv: false,
  }
  let setupError
  try {
    dir = ensureDir()
    state = loadState(dir)
  } catch (error) {
    setupError = error
  }

  function requireDir() {
    if (!dir) {
      throw new Error(
        `sv-dsh-bridge 没能准备好工作目录:${setupError?.message ?? '未知原因'}\n` +
          '请在 DSH 里确认 %USERPROFILE%\\.dsh 或 %TEMP% 可写,然后重装/重启插件。',
      )
    }
    return dir
  }

  const saveStateNow = () => {
    if (dir) saveState(dir, state)
  }

  // ---- 通道目录里的两个只读观察点(不跑桥,直接读文件) ----------------------

  /** 桥写的快照栈。sv_status / sv_doctor / 状态路由共用。 */
  function readSnapshots() {
    if (!dir) return { count: 0, max: null, latest: null }
    const raw = readJson(path.join(dir, FILE.snapshots))
    const items = Array.isArray(raw?.items) ? raw.items : []
    const latest = items.length > 0 ? items[items.length - 1] : null
    return {
      count: items.length,
      max: 8,
      latest: latest
        ? {
            id: latest.id ?? null,
            ts: latest.ts ?? null,
            label: latest.label ?? null,
            groupName: latest.groupName ?? null,
            noteCount: latest.noteCount ?? null,
          }
        : null,
    }
  }

  /** 桥的肇事面包屑:每笔请求执行前写 stage=running,跑完改 done。 */
  function readLastOp() {
    if (!dir) return null
    const raw = readJson(path.join(dir, FILE.lastOp))
    if (!raw || typeof raw.op !== 'string') return null
    return {
      stage: raw.stage ?? null,
      op: raw.op,
      id: raw.id ?? null,
      ts: raw.ts ?? null,
      session: raw.session ?? null,
      reqSeen: raw.reqSeen ?? null,
      opsRun: raw.opsRun ?? null,
    }
  }

  /**
   * 这条面包屑是不是「**当前这次桥运行**、且那一笔**没跑完**」?
   *
   * ⚠️ 没有心跳就**不下这个结论**(返回 null)。面包屑是桥自己写的,它留在盘上
   *    不会自己消失 —— 桥被正常停掉、或者用户根本没跑桥时,盘上照样有一份
   *    stage=running 的旧文件。只看面包屑会把"桥没在跑"误判成"宿主被冻住了",
   *    而这两件事的处置完全不同(前者去跑桥,后者去关模态框)。
   *
   * 三条互校,缺了就会冤枉人:
   *   · 没有心跳 ⇒ 不判(不知道);
   *   · 面包屑的 session ≠ 心跳的 session ⇒ 那是**上一次**桥运行留下的;
   *   · 心跳的 opsRun ≥ 面包屑的 reqSeen ⇒ 那一笔**已经跑完了**(opsRun 在 op 跑完才自增)。
   * 返回 null 或 { op, id, ts }。
   */
  function frozenCrumb(hb) {
    if (!hb) return null
    const c = readLastOp()
    if (!c || c.stage !== 'running') return null
    if (typeof hb.session === 'number' && typeof c.session === 'number' &&
        hb.session !== c.session) {
      return null
    }
    if (typeof hb.opsRun === 'number' && typeof c.reqSeen === 'number' &&
        hb.opsRun >= c.reqSeen) {
      return null
    }
    return { op: c.op, id: c.id, ts: c.ts }
  }

  let lastSnapshotError = null
  const getLastSnapshotError = () => lastSnapshotError

  const callBridgeRaw = (op, args, exec) => callBridge(requireDir(), op, args, exec?.signal, cfg)

  /**
   * 写操作之前**自动留一份快照**(见 SNAPSHOT_BEFORE)。
   *
   * ⚠️ 快照失败**不阻断写入**:桥偶尔读不到组(比如当前没有可编辑的组)不该让
   *    "什么都干不了"。但**绝不静默** —— 记在 lastSnapshotError 里,sv_status /
   *    sv_doctor 都会显示出来。用户以为能回滚、其实回不去,是最坏的一种。
   */
  const callOp = async (op, args, exec) => {
    if (SNAPSHOT_BEFORE.has(op)) {
      try {
        const snapArgs = { label: op }
        if (args && typeof args === 'object') {
          if (args.trackIndex !== undefined) snapArgs.trackIndex = args.trackIndex
          if (args.groupIndex !== undefined) snapArgs.groupIndex = args.groupIndex
        }
        await callBridgeRaw('snapshot', snapArgs, exec)
        lastSnapshotError = null
      } catch (error) {
        lastSnapshotError = { op, message: String(error?.message ?? error), ts: Date.now() }
      }
    }
    return callBridgeRaw(op, args, exec)
  }

  /** 往 SV2 侧栏的信息框追加一行。桥隔拍把 chat-out.json 并进 scriptData。 */
  function pushToPanel(text) {
    state.outRev += 1
    atomicWrite(
      path.join(requireDir(), FILE.chatOut),
      JSON.stringify({ rev: state.outRev, ts: Date.now(), text: String(text ?? '') }),
    )
    saveStateNow()
  }

  /** 任何 sv_* 工具被调用 ⇒ 顺手把当前会话绑成"SV 控制会话"(用户不用手动绑)。 */
  function autoBind(exec) {
    const id = exec?.agent?.id
    if (typeof id === 'string' && id.length > 0 && state.boundSession !== id) {
      state.boundSession = id
      saveStateNow()
    }
  }

  const tools = buildTools({
    dir,
    state,
    cfg,
    setupError,
    requireDir,
    saveStateNow,
    pushToPanel,
    autoBind,
    callOp,
    readSnapshots,
    readLastOp,
    frozenCrumb,
    getLastSnapshotError,
  })

  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool))
  }

  // ---- 只读状态路由(给浏览器半边的状态徽标用) ---------------------------
  // 只读、只回环:任何非本机来源直接 403,不给它任何工程信息。

  function statusSnapshot() {
    const base = dir
    const hb = base ? readJson(path.join(base, FILE.hb)) : undefined
    const boot = base ? readJson(path.join(base, FILE.boot)) : undefined
    const ageMs = hb ? Date.now() - Number(hb.ts ?? 0) * 1000 : undefined
    const online = Boolean(hb) && Number.isFinite(ageMs) && ageMs <= HB_STALE_MS
    const staleness = scriptStaleness(boot?.ts)
    return {
      online,
      dirReady: Boolean(base),
      hostName: hb?.hostName ?? null,
      hostVersion: hb?.version ?? null,
      bridgeVersion: hb?.bridge ?? null,
      heartbeatAgeSeconds: Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : null,
      dirMatches: base && hb?.dir ? path.resolve(hb.dir) === path.resolve(base) : null,
      scriptStale: staleness.stale === true,
      boundSession: state.boundSession ?? null,
      queuedFromSv: state.pending.length,
      // 徽标要多显示的三件事:能回滚吗 · 卡在哪个 op · 自动快照有没有失败过
      snapshots: readSnapshots(),
      lastOp: readLastOp(),
      frozen: frozenCrumb(hb),
      lastSnapshotError: lastSnapshotError
        ? { op: lastSnapshotError.op, message: lastSnapshotError.message }
        : null,
    }
  }

  function isLoopback(req) {
    const address = req.socket?.remoteAddress
    if (typeof address !== 'string' || address.length === 0) return false
    return (
      address === '127.0.0.1' ||
      address === '::1' ||
      address === '::ffff:127.0.0.1' ||
      address.startsWith('127.')
    )
  }

  // ⚠️ 必须用 ctx.inject,不能在 apply 里 `ctx.get('webServer')` 然后"取不到就算了":
  //    插件的激活顺序不保证在 webServer 之前还是之后。实测重启后插件先激活 ⇒
  //    ctx.get('webServer') 拿到 undefined ⇒ 路由**静默没注册** ⇒ 前端徽标永远"插件未响应"。
  //    (这是第二次踩同一类坑:上一次是 `ctx.setInterval` 的 timer mixin。)
  //    ctx.inject 会在服务出现时回调,顺序问题自动消失。
  ctx.inject(['webServer'], (sub) => {
    sub.effect(() =>
      sub.webServer.register({
        kind: 'exact',
        path: '/dsh-sv-bridge/status',
        handler: (req, res) => {
          if (!isLoopback(req)) {
            res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
            res.end('{"ok":false,"error":"loopback only"}')
            return
          }
          const body = JSON.stringify({ ok: true, ...statusSnapshot() })
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(body),
            'cache-control': 'no-store',
          })
          res.end(body)
        },
      }),
    )
  })

  // ---- 常驻提示词 --------------------------------------------------------
  // 同样用 ctx.inject:在 apply 里 ctx.get('systemPrompt') 也可能因为激活顺序拿不到。

  ctx.inject(['systemPrompt'], (sub) => {
    sub.effect(() =>
      sub.systemPrompt.section({
        name: 'sv-dsh-bridge',
        order: 300,
        text: [
          'Synthesizer V Studio 2 通过 dsh-sv-bridge 插件接入。',
          '先 sv_status 看桥在不在线;不在线就让用户去 SV2 里运行 [脚本] > [DSH] > [DSH Bridge]。',
          '桥"看起来不对"时用 **sv_doctor** —— 它会跑一次宿主内自检,并给出下一步该做什么,',
          '比你逐条猜(没跑 / 被关 / 目录不一致 / 脚本过期 / 被模态框冻住)快得多。',
          '任何写入之前先 sv_notes 拿到 fp,并把同一个 fp 原样作为 expectFp 传回去;',
          '被拒成 STALE_SELECTION 说明用户在宿主里改过工程,重新读一次再写,不要重试同一个 fp。',
          '桥一次只能处理一个请求,不要并发下发;写操作不要"超时就重试"。',
          '**每个改音符/改组的写操作之前,插件会自动留一份快照**;写错了(写得对但结果不对)用',
          '**sv_undo** 回到写之前 —— 别急着手动反向改。快照覆盖**音符层**(onset/时值/音高/歌词)',
          '与**编排布局**(哪条轨挂了哪些组、顺序、时间范围与偏移 ⇒ 新建的组会摘掉、删掉的组会挂回来、',
          '挪走的组会挪回来);不含属性层、组库里的孤儿数据、自动化曲线和声音属性,别把它当万能撤销。',
          '',
          '## SV2 调参标准流程("全参")',
          '完整版见 sv-dsh/docs/全参流程.md —— **动手前先读它**。要点:',
          '① group_ops {action:"list"} 看**全部**轨与组 —— 不能只看当前组(踩过:漏了 76% 的音符)',
          '②③ quantize {dryRun:true} 顺带做布局体检;delta 全 0 ⇒ 本来就量化好,别动',
          '④ auto_tone_shift:先查声库官方音域;maxAbsCents ≤100 可补,>400 说明方案不成立(该换声库)',
          '⑤ check_lyrics {context:5}:`.xx` 是宿主漏出的音素记号(客观错误);基准歌词必须查证',
          '⑥ auto_expression:逐音符按旋律走向生成气声/张力/颤音 —— 这才是"参数随歌曲进行"',
          '⑦⑧ set_automation:分段曲线 + 声线交叉淡化',
          '',
          '## 纪律(每条都是踩过的坑)',
          '· **一次只加一样,每步让用户听** —— 十几个变量一起上,出问题定位不了',
          '· **绝不覆盖用户的手工调校** —— 只微调,不重做',
          '· **和声轨不碰**,除非用户明确要求',
          '· **唱法总和 ≤150** —— 同时给多个 vocal mode 高值会挤压变形出"大烟嗓"(踩过)',
          '· **换声库后旧唱法会一直挂着** —— 用 `sv_call {op:"set_voice", args:{resetModes:["<模式名>"]}}`',
          '  把它们拨回中性;`clearModes` 是"真删掉",但**能不能删掉取决于宿主**,返回里会如实报',
          '· **索引基数**:sv_context 是 1 起,group_ops list 是 0 起 —— 差一位就改错轨',
          '· **宿主回调里不做 IO** —— io.popen 跑 dir 把 SV2 冻住过;已永久封锁',
          '· **不猜声库名/唱法名** —— API 读不到就问用户(panel_ask)',
        ].join('\n'),
      }),
    )
  })

  // ---- 把回答送回 SV2 面板 ------------------------------------------------
  //
  // 光有"面板 → DSH"只是半场对话:用户在 SV2 里打字,答案却只出现在 DSH。
  // 这里把回答也送回去,面板才是一个真正的聊天框。
  //
  // 两个必要的约束(否则面板会被刷屏):
  //   · 只回显**纯文本**回答 —— 带工具调用的中间步骤不是最终答复;
  //   · 只回显**由 SV2 消息触发的那一轮** —— 否则在这个会话里聊的任何东西
  //     都会跑到用户的面板里(这个会话本身就是绑定会话,不设限就会失控)。
  //
  // 事件契约:`SessionEventMap['assistant/message'] = { turn, step, message, … }`,
  // 取文本的方式与官方 `dsh-subagent` 的 AssistantOutputFold 一致
  // (dsh-subagent/lib/index.js:151-157)。
  ctx.on('session/event', (session, event) => {
    if (!state.awaitingReplyFromSv) return
    // session.id 取不到时不做拦截:宁可在绑定的会话里多回显一次,也不要整个功能失效
    const sid = typeof session?.id === 'string' ? session.id : undefined
    if (sid && state.boundSession && sid !== state.boundSession) return

    // 这一轮结束了还没拿到纯文本回答(比如最后一步是工具调用)⇒ 撤销等待,不再误回显
    if (event?.type === 'turn/end') {
      state.awaitingReplyFromSv = false
      saveStateNow()
      return
    }
    if (event?.type !== 'assistant/message') return

    const blocks = event.data?.message?.content
    if (!Array.isArray(blocks)) return
    if (blocks.some((b) => b?.type === 'tool-call' || b?.type === 'tool_use')) return

    const text = blocks
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim()
    if (text.length === 0) return

    const panelText = capPanelText(toPanelText(text))
    pushToPanel(`DSH: ${panelText}`)
    state.awaitingReplyFromSv = false
    saveStateNow()
  })

  // ---- SV2 → DSH 的看门狗 ------------------------------------------------
  //
  // ⚠️ `ctx.setInterval` 是 `timer` 服务的 **mixin**:不声明 inject 就直接访问,
  //    cordis 会抛 `cannot get property "timer" without inject`(实测踩过,
  //    而且当时插件是挂在预设里的 —— 预设的 activate() 会把子插件的错误吞进
  //    record.broken,于是"预设行 active、插件其实完全没挂",非常难查)。
  //    ⇒ 用 ctx.inject 声明成**可选依赖**:timer 不在时插件照样激活,
  //      只是没有看门狗(工具仍然可用)。

  ctx.inject(['timer'], (sub) => {
    const schedule =
      typeof sub.setInterval === 'function'
        ? sub.setInterval.bind(sub)
        : typeof sub.interval === 'function'
          ? (fn, ms) => sub.interval(fn, ms)
          : undefined

    if (!schedule) return

    let busy = false
    const tick = async () => {
      if (busy || !dir) return // 上一拍还没跑完(注入是异步的),或目录没准备好
      busy = true
      try {
        const { lines, newOffset } = readCompleteLines(
          path.join(dir, FILE.chatIn),
          state.chatOffset,
        )
        if (newOffset !== state.chatOffset) {
          state.chatOffset = newOffset
          saveStateNow()
        }
        for (const line of lines) {
          let event
          try {
            event = JSON.parse(line)
          } catch {
            continue
          }
          const text = typeof event?.text === 'string' ? event.text.trim() : ''
          // 面板发的是 'input',桥自己的 chat_send op 发的是 'user' —— 两个都收
          const kind = event?.kind
          if ((kind !== 'user' && kind !== 'input') || text.length === 0) continue

          // 回显进面板日志:面板只显示桥写的日志,不回显的话用户看不到自己发过什么
          pushToPanel(`你: ${text}`)

          if (!state.boundSession) {
            state.pending.push({ text, ts: event.ts ?? Math.floor(Date.now() / 1000), attempts: 0 })
            if (state.pending.length > cfg.maxPending) state.pending.shift()
            saveStateNow()
            continue
          }
          try {
            await deliverToSession(ctx, state.boundSession, text)
            // 这一轮的回答要送回面板(见下面的 session/event 监听器)
            state.awaitingReplyFromSv = true
            saveStateNow()
          } catch (error) {
            state.pending.push({
              text,
              ts: event.ts ?? Math.floor(Date.now() / 1000),
              attempts: 1,
              error: String(error?.message ?? error),
            })
            if (state.pending.length > cfg.maxPending) state.pending.shift()
            saveStateNow()
          }
        }

        // 绑定了会话就把积压的投出去;投不动的限次放弃,绝不无限重试
        if (state.boundSession && state.pending.length > 0) {
          const still = []
          for (const item of state.pending) {
            const attempts = (item.attempts ?? 0) + 1
            if (attempts > 5) continue
            try {
              await deliverToSession(ctx, state.boundSession, item.text)
            } catch (error) {
              still.push({ ...item, attempts, error: String(error?.message ?? error) })
            }
          }
          state.pending = still
          saveStateNow()
        }
      } catch {
        // 看门狗绝不能把宿主拖垮
      } finally {
        busy = false
      }
    }

    sub.effect(() => {
      const stop = schedule(() => void tick(), cfg.watchMs)
      return () => {
        if (typeof stop === 'function') stop()
      }
    })
  })
}
