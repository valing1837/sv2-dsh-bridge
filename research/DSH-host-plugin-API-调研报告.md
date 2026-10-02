# DSH Host 插件 API 调研报告（基于本机安装的 0.2.0-rc.2 实测阅读）

## 0. 调研方法与路径约定

**路径前缀**

- ASAR：`C:\Users\huang\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\`
  下文所有 `@deepseek-ai/<pkg>/...` 均指该前缀下的文件。
- 已安装第三方插件：`C:\Users\huang\.dsh\profiles\desktop\node_modules\`
  下文 `dsh-plugin-github/...`、`dsh-free-search/...`、`dsh-delete-session/...` 指该前缀。

**关键发现（决定了本报告的可靠性等级）**

1. **本机 Desktop 安装里 `.d.ts` 已被剥离**：`@deepseek-ai/dsh-agent/lib/types/index.d.ts` 不存在（实测 `fs.existsSync` → `false`）；`lib/types/**` 只剩运行时 `.js`（多为 `export {}` 的类型壳）。
2. **但 Typert 宿主清单把完整 TypeScript 声明以 JSON 字符串内嵌了**：例如
   `@deepseek-ai/dsh-api-session-controller/lib/typert.host.js:1581` 的
   `"declaration": "export interface Agent { ... }"`。
   这是**权威的接口签名来源**，本报告 Q1/Q2 的接口签名全部来自这里。
   共 23 个包带 `typert.host.js`，提取出 1973 条声明。
3. **`cordis` 包自带 `src/*.ts` 源码**（`@deepseek-ai/cordis/src/context.ts` 等），
   `cordis-plugin-timer` 也带 `src/index.ts`。DSH 自己的包不带 `src/`。
4. `dsh-agent` / `dsh-agent-loop` / `dsh-tools` / `dsh-system-prompt` **没有** typert 清单，
   它们的接口只能从打包后的 `lib/index.js` 中的 JSDoc + 运行时实现 + 真实插件用法推断。
   下文凡属此类，均标注 **【源码推断】**。

**读取方式（Electron asar）**：Electron 以 GUI 子系统链接，`console.log` 不会被父进程捕获，
必须把结果 `fs.writeFileSync` 到文件再读。已验证可用脚本：

```powershell
$exe="C:\Users\huang\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe"
$env:ELECTRON_RUN_AS_NODE="1"
& $exe "C:\path\to\probe.js"      # probe.js 内用 fs.writeFileSync 输出
```

---

## 1. 活的 `Agent` 对象

### 1.1 完整接口（权威，来自 Typert 内嵌声明）

`@deepseek-ai/dsh-api-session-controller/lib/typert.host.js:1581`

```ts
export interface Agent {
    readonly id: SessionId;
    readonly options: AgentOptions;
    readonly session: Session;
    readonly inbox: Inbox;
    readonly status: AgentStatus;
    readonly ctx: Context;
    cancel(cause: AgentCancelCause, options?: CancelOptions): void;
    whenIdle(): Promise<void>;
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>;
    send(message: UserMessage, target: InboxTarget, wakeup: boolean): void;
    followup(message: UserMessage): void;
    steer(message: UserMessage): void;
    inject(message: UserMessage): void;
}
```

配套类型（同文件）：

```ts
// :1593
export interface AgentOptions {
    provider?: string;
    model?: string;
    reasoningEffort?: ReasoningEffortId;
    maxTokens?: number;
    subagentDepth?: number;
}
// :1821
export type InboxTarget = 'next-turn' | 'next-step';
// :107  (AgentStatus 定义见下)
export type AgentStatus = 'idle' | 'running';
// :148
export interface CancelOptions { keepInbox?: boolean | undefined; }
// :30
export type AgentCancelCause =
  | { readonly kind: 'user' }
  | { readonly kind: 'parent' }
  | { readonly kind: 'hook'; readonly reason: string }
  | { readonly kind: 'disposed' };
```

### 1.2 向活着的 agent 发消息：`send` / `followup` / `steer` / `inject`

实现（`@deepseek-ai/dsh-agent-loop/lib/index.js`，`ReactLoopAgent` 类，类声明在 `:747`）：

```js
// :800
send(message, target, wakeup) {
    const wakingAfterAbort = wakeup && this.phase.kind !== "idle" && this.phase.abort.signal.aborted;
    const resolvedTarget = wakingAfterAbort ? "next-turn" : target;
    this.inbox.splice(resolvedTarget, Infinity, 0, [message]);
    if (wakeup) this.wakeDriver(wakingAfterAbort);
}
// :806
followup(input) { this.send(input, "next-turn", true); }
// :809
steer(input)    { this.send(input, "next-step", true); }
// :812
inject(input)   { this.send(input, "next-step", false); }
```

| 方法 | 入队位置 | 是否唤醒 driver | 语义 |
|---|---|---|---|
| `send(msg, target, wakeup)` | 参数指定 | 参数指定 | 底层原语 |
| `followup(msg)` | `next-turn` | **是** | 排一个完整的新 turn（idle 时会直接开新 turn） |
| `steer(msg)` | `next-step` | **是** | 下一步边界插入 |
| `inject(msg)` | `next-step` | **否** | 只注入 model-facing 上下文，等下一次被接纳的 step |

`send/followup/steer/inject` 的**返回值都是 `void`**（声明如此），不返回 Promise、不返回消息 id。
异步等待请用 `await agent.whenIdle()`（`:870`，注意 `dsh-agent/README.md:47` 的警告：
`whenIdle()` 是"整个 agent 静默"，多个输入可能共享同一个 running 区间）。

### 1.3 参数形状：`UserMessage`

`@deepseek-ai/dsh-llm/lib/typert.host.js:417` / `@deepseek-ai/dsh-api-session-controller/lib/typert.host.js:2465`

```ts
export interface MessageBase {
    readonly id: MessageId;          // Branded<'MessageId'>
    readonly content: readonly ContentBlock[];
    readonly source: MessageSource;
}
export interface UserMessage extends MessageBase { readonly role: 'user'; }

export interface TextBlock { type: 'text'; text: string; }        // api-session-controller :2635
export type ContentBlock = ContentBlockMap[ContentBlockType];      // :2991
export interface ContentBlockMap {                                 // :2995
    text: TextBlock; reasoning: ReasoningBlock; image: ImageBlock; file: FileBlock;
    'tool-call': ToolCallBlock; 'tool-addition': ToolAdditionBlock; 'tool-removal': ToolRemovalBlock;
}
```

构造用 `createUserMessage`（`@deepseek-ai/dsh-llm/lib/index.js:59`，它只是
`createMessage({...input, role:'user'})`，`:37`，内部 `structuredClone` + `deepFreeze` 并分配
`id: brandString(randomUUID())`，`:40`）。**注意 `createMessage` 不校验 `source.kind`。**

`MessageSourceMap`（`@deepseek-ai/dsh-llm/lib/typert.host.js:417`）声明的 kind 有：
`user`、`model`、`tool`、`system-prompt`、`model-selection`、`user-approval`、`ptc-mode`、
`tool-registry`、`user-rpc`、`agent-message`、`subagent-settled`、`skill-invocation`、
`cordis-host-runner`、`goal`、`schedule`、`compact-checkpoint`、`session-reference`、
`user-question-reply`。

> ⚠️ **文档缺陷**：`@deepseek-ai/dsh-agent/README.md:54-57` 的示例写了
> `source: { kind: 'plugin', plugin: 'my-plugin' }`，但 **`'plugin'` 不在声明的 union 里**。
> 实测运行时不会报错（`createMessage` 不校验），但**类型层面不合法**。
> 官方插件补 union 的做法是 module augmentation，例如 `dsh-goal` 往 `MessageSourceMap` 里加了
> `goal: GoalMessageSource`（见 `@deepseek-ai/dsh-goal/lib/typert.host.js:830` 的合并后声明），
> 并自定义 `kind: 'webhook'`（`@deepseek-ai/dsh-webhook/lib/index.js:190`）、
> `kind: 'agent-instructions'`（`@deepseek-ai/dsh-agent-instructions/lib/index.js:773`）。
> **建议新插件用 `{ kind: 'user' }`，或自定义 kind 并同时做 declaration merging。**

### 1.4 `Inbox`（`agent.inbox`）

`@deepseek-ai/dsh-api-session-controller/lib/typert.host.js:1817`

```ts
export interface Inbox {
    readonly nextTurn: readonly UserMessage[];
    readonly nextStep: readonly UserMessage[];
    clear(): void;
    append(target: InboxTarget, message: UserMessage): void;
    prepend(target: InboxTarget, message: UserMessage): void;
    replace(messageId: MessageId, newMessage: UserMessage): boolean;
    remove(messageId: MessageId): boolean;
    splice(target: InboxTarget, start: number, deleteCount: number, inserted: UserMessage[]): UserMessage[];
}
```

实现 `ReactLoopInbox`（`@deepseek-ai/dsh-agent-loop/lib/index.js:70`），
`hasPending` getter 在 `:88`，`claim()` 在 `:103`。
`agent.inbox` 是**结构化接口**（`dsh-agent/README.md:89`），durable 投影 `inbox` 由
`dsh-agent-loop` 注册（`:1559`）。

### 1.5 inbox 事件（载荷精确形状）

事件名的**完整受 scope 过滤清单**在
`@deepseek-ai/dsh-scope/lib/invariant.js:9-37`（生成文件，权威）：

```
agent/assistant-stream, agent/created, agent/disposed, agent/error,
agent/inbox/claimed, agent/inbox/discarded, agent/inbox/inserted,
agent/pre-step, agent/request, agent/request-error, agent/status,
agent/turn-stopping, approval/request, goal/changed,
system-prompt/assemble, tools/execute, tools/post-execute, tools/pre-execute,
tools/ptc-dispatch-log, tools/result, user-questions/request
```

载荷（发射点）：

```js
// @deepseek-ai/dsh-agent-loop/lib/index.js:206
for (const message of event.data.inserted) this.dispatch.emit("agent/inbox/inserted", { message });

// @deepseek-ai/dsh-agent-loop/lib/index.js:106
for (const message of claimed) this.dispatch.emit("agent/inbox/claimed", { message, turn });

// @deepseek-ai/dsh-agent-loop/lib/index.js:205
if (discardRemoved) for (const message of removed) this.dispatch.emit("agent/inbox/discarded", { message });

// @deepseek-ai/dsh-agent-loop/lib/index.js:798
this.dispatch.emit("agent/status", { status });
```

`agent` 字段由 fused dispatcher 自动注入（`@deepseek-ai/dsh-agent/lib/index.js:242-246`），
所以监听器实际收到 `{ message, agent }` / `{ message, turn, agent }`。

另有 durable 会话事件 `agent/inbox/spliced`（不是 `agent/*` 作用域事件）：
`@deepseek-ai/dsh-api-session-controller/lib/typert.host.js:1046`
→ `{ target: InboxTarget; start: number; removedCount?: number; inserted: UserMessage[]; outcome?: 'canceled' }`。

### 1.6 **在 agent idle 时"排队但不启动 turn"**

**可以，且是公开 API**：

```js
agent.send(userMessage, 'next-turn', false);   // 入队 next-turn，不 wakeDriver
```

`wakeup === false` 时 `send()` 只做 `inbox.splice(...)`，不会调用 `wakeDriver()`
（`@deepseek-ai/dsh-agent-loop/lib/index.js:800-805`）。消息会一直留在 inbox，
直到下一次有人唤醒（`followup`/`steer` 或正在跑的 turn 收尾时的 `wakeRequested` 重放，
`:898`、`:1035-1039`）。这与 `inject()` 的区别是：`inject()` 进 `next-step`，
只在下一次"已接纳的 step"里出现。

---

## 2. 从插件里以编程方式创建 agent / session

### 2.1 `ctx.agents.create(options)` —— 返回 `AgentHandle`

`@deepseek-ai/dsh-agent/lib/index.js`

```js
// :322   var AgentRegistry = class extends Service
// :332     super(ctx, "agents");
// :451   async create(options) {
// :455       return Reflect.apply(target.createAgent, receiver, [ownerCtx, options]);
// :464   async resume(options) {
// :468       return Reflect.apply(target.resume, receiver, [ownerCtx, options]);
```

`CreateAgentOptions` 的字段**只能从实现读取**（该包无 typert 清单）——
`@deepseek-ai/dsh-agent-loop/lib/index.js:1851-1867`：

```js
async createAgent(ownerCtx, options) {
    const preparation = SessionPreparation.create(this.runtime.ctx.sessions.prepare(options.sessionId, {
        ...options.seed === void 0 ? {} : { seed: options.seed },
        ...options.meta === void 0 ? {} : { meta: options.meta },
        ...options.inheritedEventCount === void 0 ? {} : { inheritedEventCount: options.inheritedEventCount }
    }));
    ...
    return this.setupAndPublish(ownerCtx, options.sessionId, preparation,
        options.agentOptions ?? {}, options.setup, options.signal, "startup", stored, options.parentAgent);
}
```

所以字段为：`sessionId`、`seed`、`meta`、`inheritedEventCount`、`agentOptions`、
`setup(agentCtx, agent)`、`signal`、`parentAgent`。
`ResumeAgentOptions`：`resumeSessionId`、`agentOptions`、`setup`、`signal`、`parentAgent`
（`:1921-1970`）。

**返回 `AgentHandle`**（`@deepseek-ai/dsh-agent-loop/lib/index.js:1754-1757`）：

```js
return {
    agent,
    dispose      // () => Promise<void>
};
```

即 **`AgentHandle = { agent: Agent; dispose: () => Promise<void> }`**。
`dispose()` 的语义见 `@deepseek-ai/dsh-agent/README.md:40`：
"stops the loop, unregisters, removes the session, unwinds the scope"。

### 2.2 `agentLoop.create(id, options, meta)` —— 返回裸 `Agent`（不是 handle）

`@deepseek-ai/dsh-agent-loop/lib/index.js:1781`

```js
async create(id, options = {}, meta = {}) { ... }   // :1800 -> return (...).agent
```

`AgentLoop` 服务名是 `"agentLoop"`（`:1523`、`:1552`）。
它同时是注册给 `ctx.agents` 的 factory（`:1563` `ctx.effect(() => ctx.agents.setFactory(this), ...)`），
但**注意 factory 调用的是 `createAgent`（`agents.create` 路径），不是 `create`**。

- `ctx.agentLoop.create(id, options, meta)` → `Promise<Agent>`（无 dispose 能力）
- `ctx.agents.create(options)` → `Promise<AgentHandle>`（有 dispose）

`options` 是 `AgentOptions`，`meta` 是 session 创建元数据。

### 2.3 `SessionId` 格式

`@deepseek-ai/dsh-session/lib/index.js:13`

```js
function SessionId(id) { return brandString(id); }
```

**只是品牌化字符串，无格式校验**（`brandString` 不做校验）。
`SessionStore.prepare(id, options)`（`:1680-1686`）：

```js
let sessionId;
if (id === void 0) do sessionId = brandString(`session-${++this.counter}`);
                  while (this.store.has(sessionId));
else sessionId = brandString(id);
if (this.store.has(sessionId)) throw new Error(`session "${sessionId}" already exists`);
```

即：**id 省略时自动铸造 `session-<n>`；否则任何非空字符串都合法，但同一进程内不可重复。**
实际磁盘上的 id 形态（`~/.dsh/sessions/<workspace>/<id>/`）是裸 UUID 或 `session-<uuid>`，
例如 `session-30625ba2-62c2-4ea2-902e-9a91b7ba0db5`。
第三方插件生成 id 的真实做法：

```js
// @deepseek-ai/dsh-webhook/lib/index.js:162
const sessionId = brandString(`webhook-${randomUUID()}`);   // brandString 来自 @deepseek-ai/dsh-brand
```

> ⚠️ **【源码推断，未实机验证】** `ctx.agents.create({ ... })` **必须显式传 `sessionId`**。
> 因为 `createAgent` 把 `options.sessionId` 同时用于 `sessions.prepare`（可能铸 `session-1`）
> 和 `setupAndPublish(ownerCtx, options.sessionId, ...)`（`:1867`），而
> `AgentRegistry.enter()` 会校验 `agent.id === agent.session.id`
> （`@deepseek-ai/dsh-agent/lib/index.js:511-512`，逐字：
> `const id = agent.id;` /
> `if (id !== agent.session.id) throw new Error(\`agent id "${id}" does not match session id "${agent.session.id}"\`);`）。
> 若传 `undefined`，`agent.id` 为 `undefined` 而 `session.id` 为 `session-1`，将抛错。
> `ctx.agentLoop.create(id, ...)` 的 `id` 是位置参数，不受此影响。

### 2.4 `AgentOptions` 的 provider/model 实际上必需

`@deepseek-ai/dsh-agent-loop/lib/index.js:1185`

```js
if (!proposedConfig.provider || !proposedConfig.model)
    throw new Error(`agent "${this.id}" has no provider/model: set AgentOptions.provider and AgentOptions.model or supply both via the agent/request waterfall`);
```

拿到默认路由的方法：`ctx.agentDefaultModel.currentSelection()`
→ `{ provider, model, reasoningEffort? }`（`@deepseek-ai/dsh-agent-default-model/lib/index.js`，
`AgentDefaultModelConfig`，服务名 `"agentDefaultModel"`）。

### 2.5 `meta` 字段

`@deepseek-ai/dsh-session/lib/index.js:1699-1709`

```js
const header = {
    version: 4,
    id: sessionId,
    createdAt: meta?.createdAt ?? Date.now(),
    ...meta?.cwd === void 0 ? {} : { cwd: meta.cwd },
    ...meta?.parentSession === void 0 ? {} : { parentSession: meta.parentSession },
    isSeeded: meta?.isSeeded ?? false,
    ...meta?.origin === void 0 ? {} : { origin: meta.origin },
    ...meta?.delegationDepth === void 0 ? {} : { delegationDepth: meta.delegationDepth },
    ...meta?.agentPreset === void 0 ? {} : { agentPreset: meta.agentPreset }
};
```

校验：`delegationDepth` 非负安全整数，`agentPreset` 字符串，`cwd` 必须是绝对路径
（`:1051-1052`，另见 `:1650-1651` 的 `@throws` 说明）。

### 2.6 最小可用代码骨架（逐字取自真实插件）

最权威的完整范例是 `@deepseek-ai/dsh-webhook/lib/index.js:162-198`：

```js
const sessionId = brandString(`webhook-${randomUUID()}`);
const handle = await ctx.agents.create({
    sessionId,
    signal,
    meta: {
        cwd: workspace.path,
        agentPreset: preset.id
    },
    agentOptions: resolved.agentOptions,
    setup: async (agentCtx) => {
        await ctx.agentPresets.mount(agentCtx, preset.id);
        installInitialModelSelection(agentCtx, resolved.modelSelection);
    }
});
// ... 
handle.agent.followup(createUserMessage({
    content: [{ type: "text", text: resolved.prompt }],
    source: { kind: "webhook", /* ... */ form: "notice", summary: boundContextSummary(...) }
}));
// 回滚路径：
// await handle.dispose();
```

`setup(agentCtx, agent)` 的契约（`@deepseek-ai/dsh-agent/README.md:43`）：
在 agent 被 publish **之前**执行，`agentCtx` 拥有注册生命周期；
**setup 里只做组合（注册工具/提示/监听），不要驱动 agent**——要驱动请等 `create` resolve 之后。

`@deepseek-ai/dsh-agent/README.md:35-41` 的最小形态：

```js
const handle = await ctx.agents.create({
  sessionId,
  agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
})
await handle.dispose()
```

---

## 3. 注册工具

### 3.1 注册入口

`@deepseek-ai/dsh-tools/lib/index.js`

```js
// :2704   super(ctx, "tools");          // 服务名 ctx.tools
// :2878   register(definition) {
// :2881       if (output === void 0 || typeof output !== 'object' || typeof output.render !== 'function'
//                || (output.presentationMeta !== void 0 && typeof output.presentationMeta !== 'function'))
//                 throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
// :2882       assertSupportedJsonSchema(output.schema);
// :2883       const timeoutMs = definition.timeoutMs;
// :2884       if (timeoutMs !== void 0 && (!Number.isFinite(timeoutMs) || timeoutMs <= 0))
//                 throw new TypeError(`tool "${name}" timeoutMs must be a positive finite number`);
// :2885       if (name === "run_code") throw new Error(...reserved...);
// :2886       return this.layers.effect(this.ctx, (layer) => layer.tools.insert(name, definition), { label: "tools.register()" });
```

返回**精确的 disposer**。

### 3.2 `ToolDefinition` 形状

**必需**：`name: string`、`description: string`、`parameters`（属性映射 spec）、
`output: { schema, render, presentationMeta? }`、`execute(args, exec)`。

**可选**（`defineTool` 读取的全部字段，`@deepseek-ai/dsh-tools/lib/index.js:838-886`）：
`deferLoading?: boolean`、`timeoutMs?: number`、`finalizeContent?: (exec, result) => ...`、
`projectContent?: (exec, result) => ...`、`presentCall?: (args) => ...`、
`presentResult?: (args, result) => ...`、`isConcurrencySafe?: (args) => boolean`。

`defineTool` 会把 `parameters` / `output.schema` **编译成受限 JSON Schema**，
并在 `execute` 前做参数校验（`:866-870`）：

```js
async execute(args, exec) {
    const violations = validate(args);
    if (violations.length > 0) throw new ToolArgsError(violations);
    return userExecute(args, exec);
}
```

**`parameters` 的授权 DSL**（`@deepseek-ai/dsh-tools/lib/types/schema.js`）：
每个属性节点允许的键 = 注解 `description|title|default|examples`
（+ 在属性映射位置允许 `required: true`，`:78-82` 明确"存在时必须是 `true`"），再加上：

| 写法 | 允许的附加键 | 位置 |
|---|---|---|
| `{ type: 'json' }` | — | `:152` |
| `{ type: 'object', additionalProperties: <bool 必填>, properties? }` | `properties` | `:156-171` |
| `{ type: 'array', items? }` | `items` | `:173-186` |
| `{ type: 'string'\|'number'\|'integer'\|'boolean'\|'null', enum?, const? }` | `enum`/`const` | `:187-205` |
| `{ oneOf: [≥2 个节点] }` | 与 `type` **互斥** | `:130-149` |

根 `parameters` 由 `parameterSchemaSpecToJsonSchema()` 编译为
`{ type: 'object', properties, required? }`（`:238-247`）。
`output.schema` 由 `valueSchemaSpecToJsonSchema()` 编译，**根节点不允许 `required`**（`:216-232`）。
原始 schema 支持的关键字子集（`@deepseek-ai/dsh-tools/lib/types/json-schema.js:209`）：
`type/oneOf/properties/required/additionalProperties/items/enum/const` + 注解。

### 3.3 `output`

- `schema`：结果值的 schema。**运行时强校验**：`createSuccessResult()` 里
  `validateJsonSchemaValue(tool.output.schema, detached, 'value')`，违规抛 `ToolOutputError`
  （`@deepseek-ai/dsh-tools/lib/types/index.js:1190-1193`）。
- `render(args, value)`：**必须返回 `ContentBlock[]`**（model 读到的内容块），
  不能返回裸字符串。返回非无损 JSON 会抛错（`:1202`、`:91-104`）。
- `presentationMeta?(args, value)`：仅当 `exec.parent === undefined`（顶层调用）时执行，
  用于 UI 展示元数据（`:1204-1213`）。
- `finalizeContent(exec, result)` 在 `tools/post-execute` **之后**运行。

### 3.4 `execute(args, exec)` 的 `exec` 形状

`@deepseek-ai/dsh-tools/lib/types/index.js:768-802`（`createExecution`）：

```js
const base = {
    token,                              // Symbol, 同进程关联令牌
    callId,                             // ToolCallId
    rootCallId,                         // exec.rootCallId ?? callId
    name,
    signal,                             // AbortSignal
    ...agent !== undefined ? { agent } : {},
    ...parent !== undefined ? { parent } : {},
    ...exec.schema !== undefined ? { schema: exec.schema } : {},
    deferContext(context) { ... },      // 把额外 UserMessage 排进下一步
    concludeTurn() { ... },
};
const execution = { ...base, arguments: deepFreeze(detached) };
```

所以 `execute(args, exec)` 里最常用的是 `exec.signal`、`exec.agent`、`exec.callId`。
**`ToolExecuteContext` 这个类型名在 asar 里查不到（无声明）**——上述形状来自实现。

### 3.5 逐字示例 1：`dsh-plugin-github`（真实第三方插件）

`dsh-plugin-github/lib/index.js:106-115` 定义输出契约：

```js
/** Content blocks the model reads for an object-shaped result. */
function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** Canonical object result: structured for programs, JSON text for the model. */
const JSON_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: renderJson,
}
```

`:333-368` 注册一个带参数的写工具（完整逐字）：

```js
  ctx.tools.register(
    defineTool({
      name: 'github_create_repo',
      description:
        'Create a GitHub repository. Owner defaults to the authenticated user; pass an organisation name to create it there.',
      parameters: {
        name: { type: 'string', required: true, description: 'Repository name.' },
        owner: { type: 'string', description: 'User or organisation login. Defaults to the authenticated user.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Create as private. Defaults to true.' },
        autoInit: { type: 'boolean', description: 'Initialise with a README so the repo has a first commit.' },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        const owner = args.owner ?? config.defaultOwner
        const body = {
          name: args.name,
          private: args.private ?? true,
          auto_init: args.autoInit ?? false,
        }
        if (args.description !== undefined) body.description = args.description

        const path = owner === undefined ? '/user/repos' : `/orgs/${owner}/repos`
        const repo = await request(ctx, config, 'POST', path, body, exec.signal)
        return {
          fullName: repo.full_name,
          private: repo.private,
          defaultBranch: repo.default_branch,
          cloneUrl: repo.clone_url,
          sshUrl: repo.ssh_url,
          htmlUrl: repo.html_url,
          owner: repo.owner?.login,
        }
      },
    }),
  )
```

`:291-310` 无参数工具的写法：

```js
  ctx.tools.register(
    defineTool({
      name: 'github_status',
      description: 'Report the GitHub plugin configuration and whether a token resolves. ...',
      parameters: {},
      output: JSON_OUTPUT,
      async execute() { /* ... */ },
    }),
  )
```

### 3.6 逐字示例 2：`dsh-free-search`（数组参数 + 结构化 output）

`dsh-free-search/lib/index.js:3051-3139`（节选关键行）：

```js
      const dispose = sctx.tools.register(
        defineTool({
          name: "free_search_test",
          description: "Test every configured web search engine and report which ones work. ...",
          parameters: {
            engines: {
              type: "array",
              description: "Which engines to test (default: all). Options: ddg, ...",
              items: { type: "string" },
            },
            query: { type: "string", description: "Optional search query ..." },
          },
          output: {
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                results: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      engine: { type: "string" },
                      status: { type: "string" },
                      results: { type: "number" },
                      error: { type: "string" },
                      sampleTitle: { type: "string" },
                      sampleUrl: { type: "string" },
                    },
                  },
                },
              },
            },
            render(args, value) { /* ... */ return [{ type: "text", text: `...` }]; },
          },
          async execute(args) { /* ... */ return { results }; },
          finalizeContent(exec, result) { /* 旧路径兼容兜底 */ },
        })
      );
      return () => { dispose(); };
```

### 3.7 作用域：全局 vs 单个 preset vs 单个 agent

`ctx.tools.register` 的落点是 **`scopeOf(this.ctx)` 对应的 layer**
（`@deepseek-ai/dsh-tools/lib/index.js:2886`，`this.layers.effect(this.ctx, ...)`）。

| 目标 | 做法 | 证据 |
|---|---|---|
| **全局**（所有 agent） | 插件行挂在 profile 顶层（`cordis.patch.yml` / bundle patch 的 `insert`），在 `apply(ctx)` 里 `ctx.tools.register(...)` | `@deepseek-ai/dsh-base/cordis.patch.yml:499` 顶层有 `tools` 行 |
| **只给某个 preset** | 把插件行写进该 preset 的 `config.plugins`；插件激活时的 `ctx` 就是 preset scope，preset scope 是 agent scope 的 parent，故被该 preset 的 agent 继承 | `@deepseek-ai/dsh-web-app/presets/standard.patch.yml:5-11`；`@deepseek-ai/dsh-agent-preset-registry/lib/index.js:675-677` `bindScopeParent(key, generation.key)` |
| **只给某个 agent** | 在 `agent/created` 监听器里（或 `setup(agentCtx)` 里）用 `agent.ctx.tools.register(...)` | `@deepseek-ai/dsh-agent/README.md:63`；`@deepseek-ai/dsh-agent-preset-registry/lib/index.js:661-663` 要求有 scope |
| **对某 agent 隐藏全局工具** | `agent.ctx.tools.restrict({ deny: [...] })`（或 `{ allow: [...] }`） | `@deepseek-ai/dsh-tools/lib/index.js:2895-2909` |
| **对某 agent 无条件拒绝** | `agent.ctx.tools.guard(fn)` | `@deepseek-ai/dsh-tools/lib/index.js:2921` |

`tools.restrict()` 的约束（`:2896-2908`）：必须在 scoped ctx 上调用；
`{}` 空过滤会抛错；未知全局工具名会抛错；不能点名保留名 `run_code`。

preset 声明行的真实写法（`@deepseek-ai/dsh-web-app/presets/standard.patch.yml:4-15`）：

```yaml
- insert:
    - id: preset-standard
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: standard
        order: 1
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              suffix: Your working directory is {{cwd}}.
              prefix: You are a coding agent powered by the {{model}} model.
```

`agentPresets` 服务（`@deepseek-ai/dsh-agent-preset-registry/lib/index.js`）：

```js
// :603  async resolve(id)          -> Promise<{ id: string; broken?: string }>
// :693  async mount(ctx, id)       -> Promise<{ id: string }>     // ctx = agent setup 的 agentCtx
// :708  composeFrom(ctx, parent)   -> string | undefined          // 子 agent 继承父 preset
// :776  async acquireScope(id)     -> Promise<revision lease>     // 用完 dispose
```

`AgentPreset` / `AgentPresetRow` 的声明形状见
`@deepseek-ai/dsh-agent-preset-registry/lib/typert.host.js:52-103`。

---

## 4. 注入 prompt 上下文（`ctx.systemPrompt`）

服务名 `"systemPrompt"`（`@deepseek-ai/dsh-system-prompt/lib/index.js:213`）。

### 4.1 四个注册方法（逐字，含 JSDoc）

```js
// @deepseek-ai/dsh-system-prompt/lib/index.js:240
section(section) {
    if (!Number.isFinite(section.order)) throw new TypeError(`prompt section "${section.name}" order must be a finite number`);
    return this.layers.effect(this.ctx, (layer) => layer.sections.insert(section.name, section), { label: "systemPrompt.section()" });
}

// :249
getSectionOrder(name) { return SECTION_ORDERS[name]; }   // 见 :10-43
// :257
getContextOrder(name) { return CONTEXT_ORDERS[name]; }   // 见 :44-48

// :266
context(context) {
    if (!Number.isFinite(context.order)) throw new TypeError(`prompt context "${context.name}" order must be a finite number`);
    return this.layers.effect(this.ctx, (layer) => layer.contexts.insert(context.name, context), { label: "systemPrompt.context()" });
}

// :286
tools(provider) {
    return this.layers.effect(this.ctx, (layer) => layer.toolProviders.append(provider), { label: "systemPrompt.tools()" });
}

// :297
variable(name, provider) {
    if (!VARIABLE_NAME.test(name)) throw new Error(`invalid prompt variable name "${name}" (must match ${String(VARIABLE_NAME)})`);
    return this.layers.effect(this.ctx, (layer) => layer.variables.insert(name, provider), { label: "systemPrompt.variable()" });
}
```

四者都返回**精确 disposer**，且都是**作用域敏感**的
（scoped 同名注册 shadow 全局；`@deepseek-ai/dsh-system-prompt/lib/index.js:190-192` 的重复注册错误文案
明确说"for a per-agent override, register through that agent's `agent.ctx` instead"）。

变量名规则：`VARIABLE_NAME = /^[a-z][a-z0-9_]*$/`（`:59`）。

### 4.2 `PromptSection` / `PromptContext` 形状

**无 `.d.ts`，从 `assemble()` 的读取点反推**（`@deepseek-ai/dsh-system-prompt/lib/index.js:334-351`）：

```js
const sectionDefinitions = [...sectionByName.values()].sort(comparePromptSections);
const completeSections = sectionDefinitions.filter((section) => section.complete === true);
if (completeSections.length > 1) throw new Error(`multiple complete prompt sections are active: ...`);
...
sections: sectionDefinitions.map((section) => {
    const assembled = {
        name: section.name,
        text: typeof section.text === "function" ? section.text(context) : section.text,
        ...section.interpolate !== void 0 ? { interpolate: section.interpolate } : {}
    };
    if (section.complete === true) completeSection = { ...assembled };
    return assembled;
}),
contexts: runtimeContextSuppressed ? [] : [...contextByName.values()].sort((a, b) => a.order - b.order).map((entry) => ({
    name: entry.name,
    text: typeof entry.text === "function" ? entry.text(context) : entry.text
})),
```

```ts
// 【源码推断】@deepseek-ai/dsh-system-prompt/lib/index.js:240-242, :266-268, :334-351
interface PromptSection {
  name: string;
  order: number;                       // 必须有限，否则 throw
  text: string | ((context: PromptAssemblyContext) => string);
  interpolate?: boolean;               // false = 不做 {{var}} 替换，保留字面量
  complete?: boolean;                  // true = 该 section 独占整个 system prompt（同时最多 1 个）
}

interface PromptContext {              // 动态运行时快照，注入 "Current runtime context." 段
  name: string;
  order: number;                       // 必须有限
  text: string | ((context: PromptAssemblyContext) => string);
}
```

`context` 参数就是 `assemble(context)` 的入参；`agent-loop` 构造它的是
`assembleContextFor(agent, signal)`（`@deepseek-ai/dsh-agent/lib/index.js:291-297`）：

```js
function assembleContextFor(agent, signal) {
    return { agent, scope: agent, ...signal === void 0 ? {} : { signal } };
}
```

**排序常量**（`@deepseek-ai/dsh-system-prompt/lib/index.js:10-48`）：`SECTION_ORDERS` 含
`HARNESS_IDENTITY: -1000`、`DEPLOYMENT_PERSONA_PREFIX: 0`、`PLAN_POLICY: 500`、`TEAM_POLICY: 600`、
`PTC_ONLY: 800`、`FILE_REFERENCE: 900`、`TOOL_BASH: 1000` … `TOOLS_SDK: 5000`、
`HARNESS_SOURCE: 10000`、`WEB_SURFACE: 10100`、`DEPLOYMENT_PERSONA_SUFFIX: 10200`；
`CONTEXT_ORDERS` 含 `SANDBOX_POLICY: 110`、`APPROVAL_POLICY: 115`、`SUBAGENT_DELEGATION: 120`。

**插值规则**（`:113-115`、`:153-177`）：`{{name}}` 严格替换；未知/未定义变量**抛错**；
`interpolate: false` 的 section 保留字面量；空文本 section 会被丢弃；渲染后 `join("\n\n")`。

**`tools(provider)` 的 provider 返回值**（`@deepseek-ai/dsh-system-prompt/lib/index.js:322-333`）：

```js
const result = provider(context);
const schemas = result.schemas.map(({ name, description, parameters, deferLoading }) => ({...}));
const acceptedKnownNames = result.knownNames ?? schemas.map((tool) => tool.name);
```

真实用法：`@deepseek-ai/dsh-tools/lib/index.js:2707`
`ctx.systemPrompt.tools((context) => this.wireSchemas(context.scope));`
→ 返回 `{ schemas, knownNames }`（`:2831-2848`）。

**`variable(name, provider)` 真实用法**（`@deepseek-ai/dsh-agent-loop/lib/index.js:1564-1566`）：

```js
ctx.systemPrompt.variable("provider", (context) => context.agent?.options.provider);
ctx.systemPrompt.variable("model",    (context) => context.agent?.options.model);
ctx.systemPrompt.variable("cwd",      (context) => context.agent?.session.header.cwd);
```

### 4.3 为某一个 preset 追加常驻指令（推荐做法）

**最佳模板就是 `@deepseek-ai/dsh-persona`** —— 它整个包就是"preset 作用域的常驻提示词行"。
逐字（`@deepseek-ai/dsh-persona/lib/index.js:1-50`）：

```js
import z from "@deepseek-ai/schemastery";
import { PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION } from "@deepseek-ai/dsh-system-prompt";
/** Cordis plugin name. */
const name = "persona";
/** The prompt registry this row contributes to. */
const inject = ["systemPrompt"];
/** Runtime schema for the persona row. */
const Config = z.object({
  prefix: z.string().required(),
  suffix: z.string().default(""),
  complete: z.boolean().default(false),
  includeRuntimeContext: z.boolean().default(true)
});
function apply(ctx, config) {
  ctx.effect(() => ctx.systemPrompt.section({
    name: PERSONA_PREFIX_SECTION,
    order: ctx.systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_PREFIX"),
    text: config.prefix,
    ...config.complete ? { complete: true } : {}
  }), "persona.section()");
  ctx.effect(() => ctx.systemPrompt.section({
    name: PERSONA_SUFFIX_SECTION,
    order: ctx.systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_SUFFIX"),
    text: config.suffix ?? ""
  }), "persona.suffix()");
  if (!(config.includeRuntimeContext ?? true)) ctx.systemPrompt.suppressRuntimeContext();
}
export { Config, PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION, apply, inject, name };
```

文件头注释（`:4-16`）明确说明：**该行是 "scope-only" 的，挂进 agent preset 才会 shadow 部署级 persona；
挂在全局会与 registry 自身注册冲突并报错。**

所以你要做的 "you are controlling Synthesizer V Studio"：

```js
// my-sv-plugin/lib/index.js  —— 作为 preset 的一个 plugins 行挂载
export const name = 'sv-studio'
export const inject = ['systemPrompt']

export function apply(ctx) {
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'sv-studio:role',                 // 唯一名；同名会 shadow 全局同名 section
    order: 500,                             // 或 ctx.systemPrompt.getSectionOrder('PLAN_POLICY')
    text: 'You are controlling Synthesizer V Studio through the sv_* tools. '
        + 'Never edit .svp files by hand; always go through the tools.',
  }), 'sv-studio.section()')
}
```

然后在 preset 里插入该行（`cordis.patch.yml` / bundle patch）：

```yaml
- insert:
    - id: preset-standard
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: standard
        order: 1
        plugins:
          - id: sv-studio
            name: '@local/my-sv-plugin'
```

**注意**：patch 是**整行替换**语义——覆盖已存在的 `preset-standard` 行会替换它**整个** `config`
（`@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md:3`：
"a matching override replaces the complete `config`"），所以要复制 `plugins` 全表再追加。

另一个"动态、按状态刷新"的 section 范例见 `dsh-free-search/lib/index.js:3407-3428`
（先 `disposeSection()` 再重新 `section()`）。

---

## 5. 从工具调用之外向会话推消息

**结论：可以。** 只要该会话在本进程里有一个 **live Agent**，即使它当前没有在跑 turn，
`agent.followup(userMessage)` 就会**启动一个新 turn**。

### 5.1 机制（源码证据）

```js
// @deepseek-ai/dsh-agent-loop/lib/index.js:806
followup(input) { this.send(input, "next-turn", true); }

// :854
wakeDriver(wakeAfterAbort = false) {
    if (this.phase.kind !== "idle") { ... return; }        // 非 idle：只置 wakeRequested
    const driver = Promise.withResolvers();
    this.activityDone = driver.promise;
    this.setPhase({ kind: "running", abort: new AbortController(), turn: this.phase.lastTurn, step: 0, wakeRequested: false });
    this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject);
}
// :887
async kick() { try { while (await this.turn()); } catch (_error) {} finally { ... } }
```

`status` 为 `'idle'` 时 `wakeDriver` 直接开新 driver → 新 turn。
`@deepseek-ai/dsh-agent/README.md:47` 与
`@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:29`
都明确写了这条契约：

> "A timer that starts work calls `agent.followup()`, which wakes the agent;
> `agent.inject()` does not wake it, so injected context can wait in the inbox until other input arrives."

### 5.2 会话不在本进程时：先 resolve / resume

`ctx.agents.get(id)` 只返回**本进程已注册**的 agent
（`@deepseek-ai/dsh-agent/lib/index.js:594`，`this.store.get(id)?.agent`）。
冷会话必须先加载：

- 低层：`await ctx.agents.resume({ resumeSessionId, agentOptions, setup })`
  （`@deepseek-ai/dsh-agent/lib/index.js:464` → `@deepseek-ai/dsh-agent-loop/lib/index.js:1921`）。
  **依赖 `sessionPersistence` 服务**，缺失时抛
  `"cannot resume: session persistence is not configured"`（`:1922-1923`）。
- 高层（推荐）：`ctx.sessionController.resolveAgent(sessionId)`
  → `Agent | { error }`（`@deepseek-ai/dsh-api-session-controller/lib/index.js:208-244`，
  内部对并发 resume 做去重）。

### 5.3 两个真实的"外部推消息"范例

**(a) 定时提醒**（`@deepseek-ai/dsh-schedule/lib/index.js:1576-1597`）：

```js
const resolved = await this.ctx.sessionController.resolveAgent(task.sessionId);
if ("error" in resolved) throw resolved.error;
...
const message = createUserMessage({
    content: [{ type: "text", text: /* ... */ }],
    source: { kind: "schedule" }
});
resolved.agent.followup(message);
if (!await this.ctx.sessions.flush(resolved.agent.session)) throw new Error("Session persistence did not acknowledge the reminder");
```

**(b) Webhook 触发**（`@deepseek-ai/dsh-webhook/lib/index.js:163-198`）：见 §2.6，
`ctx.agents.create(...)` 拿到 `handle`，随后 `handle.agent.followup(createUserMessage({...}))`。

### 5.4 边界

- **只在工具调用里可行吗？** 不是。`agent.followup()` 是 `Agent` 的公开方法，
  任何持有 live `Agent`（或 `AgentHandle`）的 host 插件代码都可以调，包括定时器回调、
  HTTP handler（见 `dsh-delete-session/src/index.js:422-516` 的 `ctx.get('webServer').register(...)` 模式）。
- 但**必须有 live Agent**。没有 live Agent 的会话只能读日志，无法被"推"起来。
- `cancel()` **默认清空 inbox**（`@deepseek-ai/dsh-agent-loop/lib/index.js:815-821`）；
  想只中止当前 turn 保留队列用 `cancel(cause, { keepInbox: true })`。

---

## 6. Host 插件里的定时器 / 后台工作

### 6.1 `timer` 服务已挂载（本机 desktop profile 确定）

`@deepseek-ai/dsh-base/cordis.patch.yml:24-25`

```yaml
    - id: timer
      name: '@deepseek-ai/cordis-plugin-timer'
```

`dsh-base` 是 desktop profile 的第一个 bundle
（`~/.dsh/profiles/desktop/package.json:12-20` 的 `dsh.profile.bundles` 首项）。

### 6.2 签名

`@deepseek-ai/cordis-plugin-timer/lib/index.js:4-14`（`ctx.mixin` 把方法直接混入 `ctx`）：

```js
var TimerService = class extends Service {
	constructor(ctx) {
		super(ctx, "timer");
		ctx.mixin("timer", ["timeout", "interval", "throttle", "debounce", "setTimeout", "setInterval"]);
	}
```

```js
// :17  @deprecated use ctx.timeout()
setTimeout(callback, delay)  -> disposer
// :21  @deprecated use ctx.interval()
setInterval(callback, delay) -> disposer
// :24
timeout(callback, delay)     -> () => void        // 一次性，返回 disposer
timeout(delay)               -> Promise<void>     // 等待 delay
// :48
interval(callback, delay)    -> () => void        // 周期，返回 disposer
interval(delay)              -> AsyncIterable-ish { next(): Promise<IteratorResult> }
// :131  throttle(callback, delay, noTrailing?) -> WithDispose<F>
// :144  debounce(callback, delay)              -> WithDispose<F>
```

`setTimeout` / `setInterval` 是 **deprecated 别名**，内部转调 `timeout` / `interval`
（`:16-23`；`cordis-plugin-timer/README.md:35-36`）。
所有 timer 都通过 `this.ctx.effect(...)` 注册，**随当前 fiber 一起销毁**
（`:28-34`、`:51-54`）。

`cordis` 的 `Context` 接口扩展（`@deepseek-ai/cordis-plugin-timer/src/index.ts:3-5`）：

```ts
declare module '@deepseek-ai/cordis' {
  interface Context extends Pick<TimerService, 'interval' | 'timeout' | 'throttle' | 'debounce' | 'setTimeout' | 'setInterval'> {
    timer: TimerService
  }
}
```

**结论：`ctx.setInterval(...)` / `ctx.timeout(...)` 可用。**
> 说明：`ctx.setInterval` 是 `ctx.interval` 的 deprecated 别名，两者都可用；
> 本机所有随包插件里**没有**任何一处实际调用 `ctx.setInterval`（已全量 grep 确认），
> 因此"在真实插件中被使用过"这一点**未验证**；可用性由 mixin 声明与服务挂载保证。

### 6.3 node 内置模块

**可以，且随包/第三方插件都在用：**

| 模块 | 使用处 |
|---|---|
| `node:child_process` | `dsh-plugin-github/lib/index.js:19`（`import { execFile } from 'node:child_process'`）、`dsh-free-search/lib/index.js:7`（`exec`） |
| `node:fs` | `dsh-plugin-github/lib/index.js:20`、`dsh-delete-session/src/index.js:25` |
| `node:os` / `node:path` | `dsh-delete-session/src/index.js:26-27` |
| `node:crypto` (`randomUUID`) | `@deepseek-ai/dsh-webhook/lib/index.js:4` |
| `node:util` (`promisify`) | `dsh-plugin-github/lib/index.js:21` |

**建议**：定时器用 `ctx.interval` / `ctx.timeout`（自动随 fiber 清理），
不要用裸 `setInterval`（`@deepseek-ai/dsh-schedule/lib/index.js:1559/1641` 用了裸
`setTimeout`，但那是它自己在 `clearTimer()` 里手动管理，并在 disposal 里 await
`this.running`）。`practices.md:29` 的规则："Clear the timer in the owning effect."

### 6.4 Host 插件的导出形式（写新插件时的模板）

`@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md:47-54`：

> `index.js` exports one of these forms; do not mix them:
> - `export function apply(ctx, config) {}` with optional `export const inject = ['tools']` and `export const Config`.
> - A service class as the default export.
>
> Register every resource inside `apply` with `ctx.effect` or `ctx.on` and return its cleanup.

真实对照：`dsh-plugin-github/lib/index.js:38-41`（`export const name`、`export const inject = ['tools']`）、
`:52`（`export const Config = Schema.object({...})`，`@deepseek-ai/schemastery`）、
`:288`（`export function apply(ctx, config)`）；
`dsh-delete-session/src/index.js:29/422`（`export const name` + `export function apply(ctx)`）；
`@deepseek-ai/dsh-persona/lib/index.js:19-35`（`name`/`inject`/`Config`/`apply`）。

可选依赖用 `ctx.inject([...], (sub) => {...})` 延迟激活，避免在没有该服务的 profile 里抛错
（`dsh-delete-session/src/index.js:515`、`dsh-free-search/lib/index.js:3049`、
`practices.md:20`）。

---

## 7. 未验证 / 不确定

以下条目**没有**达到"源码逐字可引 + 语义确定"的标准，请勿当作既定事实：

1. **`ctx.agents.create({ sessionId: undefined })` 会抛错** —— §2.3 的警告。
   结论由三处代码交叉推断（`dsh-agent-loop:1852/1867` 的 `options.sessionId` 双用 +
   `dsh-agent:511-512` 的 `agent.id !== agent.session.id` 断言），**未实机运行验证**。
2. **`source: { kind: 'plugin', ... }`** —— `@deepseek-ai/dsh-agent/README.md:54-57` 的示例写法。
   该 kind **不在** `MessageSourceMap` 声明里；`createMessage`（`dsh-llm/lib/index.js:37`）
   不校验 source，故**运行时应可通过但类型不合法**，且我不知道是否有下游消费者会按
   `kind` 分支而失配。**未验证**。建议改用 `{ kind: 'user' }` 或做 declaration merging。
3. **`ToolExecuteContext` 的确切类型名与完整字段** —— asar 中不存在该类型声明。
   §3.4 的字段来自 `createExecution()` 的实现（`dsh-tools/lib/types/index.js:768-802`）。
   实现与声明之间可能有未导出的差异。
4. **`PromptSection` / `PromptContext` 的官方类型名与完整字段** —— `dsh-system-prompt`
   无 `.d.ts`、无 typert 清单。§4.2 的形状由 `assemble()` 的读取点反推，
   不排除存在未读取的可选字段（例如 `complete` 只在 `:335` 被读，`interpolate` 在 `:343`）。
5. **`CreateAgentOptions` / `ResumeAgentOptions` / `AgentHandle` 的官方类型名** ——
   这些名字出现在 JSDoc 引用中（`dsh-agent/lib/index.js:446` 提到 `{@link AgentHandle}`，
   `:1848` 提到 options 字段），但**没有可读的声明**。字段清单来自实现读取。
6. **`ctx.setInterval` 在真实插件中的使用** —— 未在任何随包/已装插件中找到调用点（§6.2）。
7. **`agent.ctx` 注册是否在插件 unload 时自动清理** ——
   `practices.md:19` 明确说"unloading the plugin does not dispose `agent.ctx` registrations by itself"，
   要求把 disposer 也保留在插件自己的 effect 里。我**没有**在源码里找到该行为的直接证据
   （即没有读到 `agent.ctx` 的父 fiber 与插件 fiber 的关联代码），仅依据官方文档。
8. **`agent.send()` 的 JSDoc / 官方文档描述** —— `Agent` 接口里有 `send`，但
   `dsh-agent/README.md:47` 只宣传 `followup/steer/inject/cancel/whenIdle`。
   `send` 是否算"稳定公开 API"**未验证**；若只求稳，请用 `followup/steer/inject`。
   但 §1.6 的"入队不唤醒"**只能**通过 `send(msg,'next-turn',false)` 表达。
9. **`sessionId` 的字符集/长度限制** —— `SessionId()`（`dsh-session:13`）只做 `brandString`，
   无校验。但持久化后端（`dsh-session-persistence-jsonl`）把 id 当**目录名**使用，
   实际可能存在文件系统层面的字符限制。**未验证**。
10. **`dsh-agent-preset` 的 `config.plugins` 行覆盖语义** ——
    "a matching override replaces the complete `config`" 来自官方 skill 文档
    （`references/host-plugin.md:3`），我没有实机验证 patch 合并行为。
11. **本报告未覆盖**：Client/UI 插件 API、`ctx.sessionProjections` 投影单元、
    `tools/pre-execute` / `tools/post-execute` / `tools/execute` waterfall 的完整载荷、
    `ctx.commands`、`ctx.jobs`、`ctx.webServer` 路由契约。
