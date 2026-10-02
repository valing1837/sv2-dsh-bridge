# DSH 插件打包/安装 与 Agent Preset 声明 — 实测报告

- 环境: DSH Desktop `0.2.0-rc.2`（实测 `dsh.cmd --version` → `0.2.0-rc.2`）
- 源码根（下文简写为 `<ASAR>`）: `C:\Users\huang\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`
- 内置包根（下文简写为 `<PKG>`）: `<ASAR>\dsh\node_modules\@deepseek-ai\`
- Profile: `C:\Users\huang\.dsh\profiles\desktop`
- 读取 asar 的方法（PowerShell 不能直接读 asar）:
  ```powershell
  $env:ELECTRON_RUN_AS_NODE="1"
  & "C:\Users\huang\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe" -e "const fs=require('fs');console.log(fs.readFileSync('<PKG>/dsh-plugin-manager/lib/types/index.js','utf8'))"
  ```
  ⚠️ 该 exe 是 GUI 子系统程序，PowerShell **不会等待**它；必须把输出写进文件再轮询读取，否则会拿到上一次的陈旧结果。

---

## 1. 安装插件

### 1.1 `dsh plugin` 到底提供什么

`dsh` 的 CLI 解析器只有一个 `plugin` 子命令，其余全部转发给 pnpm：

`<PKG>dsh/lib/bin.js:107-121`
```js
if (first === "plugin") {
    const plugin = program.command("plugin")
        .description("manage a profile's plugins by forwarding the remaining arguments to pnpm in the profile directory");
    plugin.requiredOption("--profile <name>", "the profile whose plugins to manage (initialized on first use)", selectProfile)
        .allowUnknownOption()
        .argument("[args...]", "pnpm arguments, forwarded verbatim (add <pkg>, remove <pkg>, why <pkg>, ...)")
        .action((args, options) => {
            ...
            if (!manageDesktopProfile) rejectElectronProfile(plugin, options.profile);
            if (args.length === 0) program.error("error: plugin needs pnpm arguments to forward (e.g. add <package>)");
            resolved = { mode: "plugin", profile: ..., args };
        });
}
```

- 用法串（`bin.js` 的 `usage()`）: `dsh plugin --profile <name> <pnpm-args...>`
- `bin.js:38-46` 的 HELP_EXAMPLES 里有 `dsh plugin --profile tui add <package>`。
- **没有** `dsh plugin add/remove/list` 这种 DSH 自己的子命令；`add`/`remove`/`why`/`install` 全是 pnpm 的。
- DSH 只截获 3 个自有命令：`allow-version` / `revoke-version` / `version-exemptions`（`<PKG>dsh/lib/plugin-BGnVfe_D.js:16`），用途是版本兼容豁免，不是安装。
- `plugin` 子命令**没有 help**：实测 `dsh plugin --help` → `error: required option '--profile <name>' not specified`（因为 `helpOption(false)` + `requiredOption`）。
- `--profile` 必须写在 pnpm 参数**之前**（`enablePositionalOptions()` + `passThroughOptions()`）。

### 1.2 ⛔ desktop profile 无法用 CLI 管理（实测）

`<PKG>dsh/lib/bin.js:119` → `if (!manageDesktopProfile) rejectElectronProfile(plugin, options.profile);`
`<PKG>dsh/lib/bin.js:252` → `if (import.meta.main) await runCli();`（无参数 ⇒ `manageDesktopProfile = false`）

`C:\Users\huang\bin\dsh.cmd` 正是直接跑 `lib/bin.js`，所以：

```
> dsh plugin --profile desktop list
error: profile "desktop" is managed exclusively by the Electron application
```

**结论：`dsh plugin --profile desktop add <path-or-spec>` 不工作。** 只有 Desktop 载体自己调用 `runCli({ manageDesktopProfile: true, packageManager })` 时才放行（`<PKG>dsh/README.md:62`：「The Desktop carrier also enables plugin operations for its initialized profile; npm launches omit these options.」）。

### 1.3 本地文件夹插件的受支持路径 = `plugin_manager` 工具 / Web 侧栏 Plugins 页

工具定义在 `<PKG>dsh-plugin-manager/lib/types/tools.js`：
- `:7` `export const inject = ['tools', 'pluginManager', 'sandboxPolicy'];`
- `:13` `name: 'plugin_manager'`
- `:16` `enum: ['list_plugins','list_bundles','set_plugin','set_bundle','install_bundle','remove_bundle','list_version_exemptions','set_version_exemption']`
- `:32-34` 每次调用都走 `approveEscalation({ requestedMode: 'danger-full-access', ... })`

调用方式：
```
plugin_manager { action: "install_bundle", target: "<本地插件目录的绝对路径>" }
```

`installBundle` 的实际行为（`<PKG>dsh-plugin-manager/lib/types/index.js`）：
- `:528` `run = await this.runPnpm(['add', spec, ...registryArguments(registry)], ...)`
- `:704` `const cwd = this.profile.dir;` ⇒ **相对路径以 profile 目录为基准，本地目录请传绝对路径**
- `:580-581` 包必须声明 `dsh.bundle`，否则 `ManagementFailure('not-bundle')`（普通依赖装不进来）
- `:582-584` `engines.dsh` 与本运行时冲突 → `incompatible-version`，拒绝安装
- `:599-600` `if (options?.enabled !== false) await this.selectBundle(name, true);`（默认即启用）
- `:588-592` 失败/取消/无 bundle patch → 回滚 `package.json` + `pnpm-lock.yaml`
- 返回字段含 `application`（`'applied' | 'restart-required' | 'cancelled' | 'failed'`，`:814-828`）、`warnings`、`stage`、`bundle`、`target`、`packageResult`、`pendingBuilds`、`failedAt`、`registries`

### 1.4 落盘变化

安装一个本地 bundle 后：

1. `C:\Users\huang\.dsh\profiles\desktop\package.json` 的 `dependencies` 新增一条（pnpm 写）。
2. **同一文件的 `dsh.profile.bundles` 自动追加该包名** — `reconcile()`，`<PKG>dsh-plugin-manager/lib/types/operations.js:44-71`：
   ```js
   const metadata = bundleManifest(name, dir, anchor);
   if (metadata?.dsh?.bundle === undefined) { options.onOutput?.(`dsh: warning: ${name} declares no dsh.bundle — installed as a plain dependency, not a profile layer`); continue; }
   for (const file of bundlePatchPaths(...)) loadOverlayPatches('dsh', file);
   if (!bundles.includes(name)) bundles.push(name);          // :65
   ...
   after.dsh = { ...after.dsh, profile: { ...after.dsh?.profile, bundles } };   // :70
   await saveManifest(dir, after);                                             // :71
   ```
3. `pnpm-lock.yaml` + `node_modules/<包名>`。
4. **不写 `cordis.patch.yml`**：插件行来自插件包**自己的** `cordis.patch.yml`（bundle 层）。
5. CLI 路径（非 desktop profile）行为相同：`runProfilePnpm` 里 `options.activateNewBundles !== false`（`operations.js:503`）即执行 `reconcile`。

`dsh plugin` 的 CLI 入口：`<PKG>dsh/lib/plugin-BGnVfe_D.js:65-93`，`execution: "cli"`，`installAnchor: INSTALL_ANCHOR`。
相对路径锚定只在 `.`/`..` 形式生效（`operations.js:19-25` `anchorPathSpec`，正则 `^(?:(file|link):)?(\.{1,2}([/\\].*)?)$`）；裸相对路径 `my-plugin` 会被当成包名。

### 1.5 启用 / 禁用：服务 API 与精确标识符

底层服务是 Cordis Service，key = `pluginManager`：

`<PKG>dsh-plugin-manager/lib/types/index.js:143-158`
```js
let PluginManager = (() => {
    let _classSuper = TypertRemoteService;
    ...
    return class PluginManager extends _classSuper {
```
- `:187` `static inject = ['loader', 'profileContext'];`
- `:188-197` `static Config = z.object({ pnpmCommand, outputBytes, lockWaitMs, inspectTimeoutMs, githubConnectionTimeoutMs, idleTimeoutMs, registry, fallbackRegistries })`
- 方法（全部标 `@Remote`，:161-172）：
  | 方法 | 行 | 说明 |
  |---|---|---|
  | `listPlugins()` | :260 | 返回行数组 |
  | `setPluginEnabled(id, enabled)` | :438 | `id` = **entryId** |
  | `listBundles()` | :282 | bundle 行 + 声明行 |
  | `setBundleEnabled(name, enabled)` | :456 | `name` = 包名 |
  | `installBundle(spec, options)` | :473 | `spec` = 安装 spec |
  | `removeBundle(name)` | :640 | |
  | `inspect(spec, options, signal)` | :342 | 安装前探察 |
  | `registries()` | :328 | |
  | `waitForInstall(requestId)` | :616 / `cancelInstall(requestId)` | :624 |
  | `listVersionExemptions()` | :236 / `setVersionExemption(...)` | :252 |

**精确标识符（这是最容易搞错的点）：**

- `set_plugin` 的 `target` = `listPlugins()` 行里的 **`entryId`**
  （`:440` `const row = (await this.listPlugins()).find(item => item.entryId === id);`）
- 行字段：`entryId`、`moduleName`、`enabled`、`fiberPhase`、`meta?`，外加 `patchId`（可寻址）或 `readOnlyReason`
  - `:263-275`：`readOnlyReason: 'management-required'`（管理器自身 / 受保护包）、`'unaddressable'`（profile patch 里找不到唯一匹配行，或不在 `include` 树里）
  - `entryId` 就是 Loader entry id（`<PKG>dsh-host-plugin-inventory/lib/types/index.js:42-44` `pluginEntryId(value){ return value; }`）
  - 行 schema：`<PKG>dsh-host-plugin-inventory/lib/typert.host.js:5-22`
- `set_bundle` / `remove_bundle` 的 `target` = **bundle 包名**（package.json 的 `name`）
- `install_bundle` 的 `target` = 安装 spec：绝对路径 / 包名 / `link:` / tarball / git
- 写盘位置：
  - `set_plugin` → `:445` `writePluginEnabled(this.profile.patchPath, row.patchId, row.moduleName, enabled)`
    → `<PKG>dsh-plugin-manager/lib/types/patch.js` 改 profile `cordis.patch.yml` 中**最后一个**匹配 override 的 `disabled`；没有匹配就 append `{ id, disabled: !enabled }`
  - `patchPath = join(profileDir, 'cordis.patch.yml')` — `<PKG>dsh-app-boot/lib/index.js:487` `const PROFILE_PATCH_FILENAME = "cordis.patch.yml";`、`:946` `const patchPath = join(dir, PROFILE_PATCH_FILENAME);`
  - `set_bundle` → 改 `package.json` 的 `dsh.profile.bundles`
  - home 级 `<DSH_HOME>\cordis.patch.yml` 优先级高于 profile 级（`dsh-app-boot/lib/index.js:1027-1028`）

**权限**：每一个 action（**包括 `list_plugins` / `list_bundles`**）都需要 `danger-full-access` 或当次批准（`tools.js:32-34`）。本会话审批被禁用，因此我**没有调用** `plugin_manager`（会直接被拒），上面全部来自源码。

---

## 2. 最小插件包结构（Host 半边，可选带浏览器半边）

权威模板：`<PKG>dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md`

### 2.1 Host-only 最小包（无需依赖、无需构建、无需 install 脚本）

`package.json`
```json
{
  "name": "@local/my-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml`
```yaml
- insert:
    - id: my-plugin
      name: '@local/my-plugin'
      config: {}
```

`index.js`（三种导出形态，**不要混用**）
```js
// A) 函数式
export function apply(ctx, config) {}
export const inject = ['tools'];            // 可选
export const Config = z.object({ ... });    // 可选，来自 @deepseek-ai/schemastery

// B) 默认导出 Service class
// export default class MyService { ... }
```

要点：
- `dsh.bundle.patch` 可以是**单个路径**，也可以是**有序数组**（`<PKG>dsh-package-manifest/README.md:46`：「one patch file path or an ordered list of them」）。`dsh-web-app` 就是数组（`dsh-web-app/package.json:34-37,45-48`）。
- `exports` 存在时 Node 用 `exports`；`main` 是回退。真实包两者都写。
- 所有资源注册都要在 `apply` 内用 `ctx.effect` / `ctx.on`，并返回清理函数（`host-plugin.md` "Host plugin export forms"）。

### 2.2 真实例子（可直接对照）

**`dsh-delete-session`**（Host + Client，手写 JS，无构建）
- `C:\Users\huang\.dsh\profiles\desktop\node_modules\dsh-delete-session\package.json:2-9`
  ```json
  "name": "dsh-delete-session",
  "version": "0.1.8",
  "type": "module",
  "main": "src/index.js",
  "exports": { ".": "./src/index.js", "./client": "./src/client.js", "./package.json": "./package.json" }
  ```
- 同文件 `:30-39`
  ```json
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "inject": ["@deepseek-ai/dsh-client-runtime"], "platform": "web" }
  }
  ```
- `...\dsh-delete-session\cordis.patch.yml:5-7`
  ```yaml
  - insert:
      - id: dsh-delete-session
        name: 'dsh-delete-session'
  ```
- Host 导出：`...\src\index.js:29` `export const name = 'dsh-delete-session'`，`:422` `export function apply(ctx) {`（**没有** `inject`、**没有** `Config`）；服务用 `ctx.get('agents'|'sessions'|'sessionPersistence'|'workspaceRegistry'|'webServer')`（:138,162,188,278,509）和 `ctx.inject(['webServer'], sub => ...)`（:515）。

**`dsh-plugin-github`**（纯 Host）：`...\node_modules\dsh-plugin-github\package.json` — `main: lib/index.js`，有 `peerDependencies`，`dsh.bundle.patch: "./cordis.patch.yml"`，**无** `dsh.client`。

**`@aiwayds/dsh-web-search-tavily`**（Host + 展示元数据）：`...\node_modules\@aiwayds\dsh-web-search-tavily\package.json` — 顶层 `"icon": "./icon.svg"`，`files` 含 `locale/*.json`；`dsh.bundle.patch: "./cordis.patch.yml"`（注意没有 `./` 前缀也合法）。

### 2.3 展示元数据（Plugins 页面卡片）

来自 `host-plugin.md` "Display metadata and icon"：
```json
{
  "icon": "./icon.svg",
  "exports": { "./package.json": "./package.json", "./locale/*.json": "./locale/*.json" },
  "files": ["locale/*.json", "icon.svg"]
}
```
```json
{ "meta": { "title": "My Decoration", "description": "Draws a badge under the composer." } }
```
`icon` 相对 manifest 目录；SVG/PNG/JPEG/WebP，≤256 KiB；绝对路径、URL、目录外路径、越界符号链接会被拒绝。`meta.title` / `meta.description` 也可以写成 `{ "en": "...", "zh": "..." }`（见 `dsh-host-plugin-inventory/lib/typert.host.js:10-19`）。

---

## 3. 客户端（浏览器）半边

### 3.1 声明

`package.json` 两处：
```json
"exports": { ".": "./index.js", "./client": "./client.js" },
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "platform": "web",
    "immediately": true,
    "inject": ["@deepseek-ai/dsh-client-ui-conversation"],
    "external": []
  }
}
```

`dsh.client` 的校验器 `<PKG>dsh-client-modules/lib/index.js:61-75`：
```js
function parseDshClient(pkgName, value) {
	if (value === void 0) return void 0;
	if (typeof value !== "object" || value === null) throw ...;
	const decl = value;
	if (typeof decl.platform !== "string") throw new Error(`... dsh.client.platform must be a string`);
	const inject   = optionalStringArray(pkgName, "dsh.client.inject", decl.inject);
	const external = optionalStringArray(pkgName, "dsh.client.external", decl.external);
	if (decl.immediately !== void 0 && typeof decl.immediately !== "boolean") throw ...;
	return { platform, ...inject, ...external, ...immediately };
}
```
- `platform` **必填且必须是 string**；`:714-717` 只有 `platform === "web"` 才会产出浏览器 bundle。
- `inject` = 必须先于本模块就位的**客户端包名**（浏览器侧 `arriveGraphRow`，`dsh-client-modules/lib/client.js:656-659`）。
- `external` = 模块解析依赖，决定图排序（`lib/index.js:415-437` `orderByModuleGraph`，会因自请求/环报错）。
- `immediately` = 是否在启动批次里立刻加载。

### 3.2 构建与服务

- `exports["./client"]` 解析：`<PKG>dsh-client-modules/lib/index.js:170-181` `clientExportOf` — 接受字符串，或 `{ default: string }`。
- `:718-719` 声明了 `dsh.client` 但没有 `./client` export → 抛错。
- `:723` `clientPath: join(dirname(pkgPath), clientRel)` — **文件被原样读取**，没有任何编译步骤。
- 路由：`:201` `const PLUGIN_ROUTE = "/plugins";`；单资源 URL `/plugins/<id>/client.js?rev=<rev>`（`:259`、`:293`、`:918`），`<id>` = 包名。
- `dsh-client-modules/README.md:50` 说「`pnpm run build` 必须已产出每个 `lib/client.js`」——那是**针对 dsh 自身 monorepo 的包**；第三方插件的 `exports["./client"]` 指向哪个文件就服务哪个文件。

### 3.3 手写纯 JS 客户端 bundle：**完全可行，无强制构建**

证据：`dsh-delete-session` 就是手写的纯 JS：
- `...\dsh-delete-session\src\client.js`（30304 字节，纯 JS，无 tsdown/tsc）
- `:17-19`
  ```js
  window.__ModuleLoader__.load({
    id: 'dsh-delete-session',
    factory: () => {
      ...
  ```
- `:691-705`
  ```js
  function apply(ctx) {
    sessionsSvc = ctx.get('sessions') || null
    if (!sessionsSvc) { try { ctx.inject(['sessions'], (sub) => { sessionsSvc = sub.sessions }) } catch {} }
    localeSvc = ctx.get('locale') || null
    ...
    const dispose = install()
    if (dispose) ctx.effect(() => dispose)
  }
  return { apply }
  ```

官方模板（React 版）`<PKG>dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/client.js`：
```js
window.__ModuleLoader__.load({
  id: '@local/my-decoration',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    function Decoration() { return h('svg', { viewBox: '0 0 64 64', width: 48, height: 48, 'aria-hidden': true, style: { display: 'block', pointerEvents: 'none' } }, h('circle', { cx: 32, cy: 32, r: 24, fill: '#247bbf' })); }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: 'my-decoration', order: 5 }, Decoration));
      },
    };
  },
});
```

协议要点：
- `window.__ModuleLoader__.load({ id, factory })`；`id` **必须等于包名**。
- `factory(require)` 返回 `{ apply(ctx) }` 或 `{ inject: [...], apply(ctx) }`。
- `factory` 体在**首次 materialize 时才执行**（`dsh-client-modules/README.md:66-68`），只注册工厂；副作用放进 `apply` 并用 `ctx.effect` 管理。
- `require('react')` 由平台种子表 `PLATFORM_MODULES` 提供（`README.md:46`）；非基线模块必须在 `dsh.client.external` 里声明。
- 编译版源码用 `import()` 会被 tsdown 拆成 `require.async("./client.<name>.js")`（`README.md:38`）——手写版不需要。

### 3.4 客户端半边可用的全局/API

权威清单本应由 **Client `Builtin` inspect provider**（`listBuiltins`，"Plain-JavaScript symbols available to a dynamic Client half"）给出，但本次查询超时（无已连接页面）：

```
Error: Builtin.listBuiltins: Client inspect query Builtin.listBuiltins timed out after 10000ms.
Error: Service.listService: ... timed out after 10000ms.
```

因此以下来自模板与真实插件（**非权威穷举**）：
`window.__ModuleLoader__`、`require`、`React`（`require('react')`）、`fetch`、`localStorage`、`document`/`MutationObserver`、`window`、`Event`；
Cordis 侧：`ctx.get(name)`、`ctx.inject([...], cb)`、`ctx.effect(fn)`、`ctx.on(...)`、`ctx.slots.inject(key, cb)`、`ctx.slots.register(spec, Component)`。

Slot 体系：`<PKG>dsh-client-ui-slots/README.md:28` — 四种槽：`single` / `list` / `keyed` / `chain`；`:46` 「声明即占有」：注册进未声明的槽、重复声明子槽、无 `select` 的 chain 都会在加载时报错。

> 拿到权威清单的办法：打开/重连 Harness 页面后重跑 `cordis_inspect_query({platform:"client", provider:"Builtin", method:"listBuiltins"})`。

---

## 4. Agent Preset

### 4.1 声明形式 = 一条普通 Cordis 插件行

`<PKG>dsh-agent-preset/lib/index.js:7-27`（全文 30 行，这是唯一实现）
```js
var AgentPreset = class {
	ctx; config;
	static inject = ["agentPresets"];
	static [EntryGroup.key] = true;          // 保留子插件里的 !!js 表达式
	static Config = z.object({
		id: z.string().required(),
		name: z.string(),
		description: z.string(),
		order: z.number(),
		plugins: z.array(z.any()).required()
	});
	constructor(ctx, config) { this.ctx = ctx; this.config = config; }
	async *[Service.init]() {
		yield await this.ctx.agentPresets.register(this.config);
	}
};
export { AgentPreset as default };
```

**YAML 格式**（`<PKG>dsh-web-app/presets/minimal.patch.yml:4-15` 为真实最短样例）
```yaml
- insert:
    - id: preset-minimal                 # Loader 行 id，约定 preset-<id>
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: minimal                      # ← 会话保存的 preset 身份
        order: 3
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: You are a helpful software engineer assistant.
              complete: true
              includeRuntimeContext: false
```

字段表（`<PKG>dsh-agent-preset/README.md` "Use this package"）：
| 字段 | 默认 | 含义 |
|---|---|---|
| `id` | 必填 | 稳定 preset 标识（会话保存它） |
| `plugins` | 必填 | 子插件 entry 列表 |
| `name` | 无 | 显示名 |
| `description` | 无 | 显示描述 |
| `order` | 无 | 名单排序 |

### 4.2 `PresetDefinition`（程序化注册的精确类型）

`<PKG>dsh-agent-preset-registry/lib/typert.host.js:574-575`
```ts
export interface PresetDefinition {
    readonly id: string;
    readonly name?: string;
    readonly description?: string;
    readonly order?: number;
    readonly plugins: readonly (Omit<EntryOptions, 'id' | 'disabled'> & { id?: string; disabled?: EntryOptions['disabled'] | JsExpr; })[];
}
```

`plugins` 行校验：`<PKG>dsh-agent-preset-registry/lib/types/definition.js:6-28` `entryListProblem`
- 必须是数组（顶层或 group 的 `config`）
- 每行必须是 map，且 `name` 是非空字符串
- `group === true` 时递归校验 `config`
- 没有别的限制（`disabled: !!js ...` 由 Loader 在激活时求值）

### 4.3 服务 `agentPresets`

`<PKG>dsh-agent-preset-registry/lib/types/index.js:54-70`
```js
return class AgentPresetRegistry extends _classSuper {
    static inject = ['loader', 'sessionProjections'];
    static Config = z.object({ default: z.string().required(), selectedDefault: z.string().volatile() });
```
- `:88` `get defaultId() { return this.config.selectedDefault.get() ?? this.config.default; }`
- `:80` 注册 `agentPresetProjectionDefinition` 会话投影
- `:82-85` 转发 `agent-preset/selected` 会话事件

方法签名（`<PKG>dsh-agent-preset-registry/lib/typert.host.js:120-200`）：
| 成员 | 签名 | 行 |
|---|---|---|
| `defaultId` | `get defaultId(): string` | :132 |
| `register` | `async register(definition: PresetDefinition): Promise<() => Promise<void>>` | :139 |
| `list` | `async list(): Promise<AgentPreset[]>` | :146 |
| `remoteExportList` | `@Remote('list')` | :153 |
| `resolve` | `async resolve(id?): Promise<AgentPreset>` | :160 |
| `readDocument` | `@Remote('read') readDocument(agentPreset): Promise<AgentPresetDocument>` | :167 |
| `mount` | `async mount(ctx, id?): Promise<AgentPreset>` | :174 |
| `composeFrom` | `composeFrom(ctx, parent)` | :181 |
| `composedPreset` | `composedPreset(ctx)` | :188 |
| `serviceFor` | `serviceFor(agent, name)` | :195 |

**`register` 的校验只有两条**（`lib/types/index.js:95-98`）：
```js
if (!definition.id.trim()) throw new Error('Preset id must not be empty');
if (this.definitions.has(definition.id)) throw new Error(`Duplicate agent preset: ${definition.id}`);
```
⇒ **没有 id 正则**（skill 里说的「lowercase letters, digits and hyphens」是约定，不是本版本强制）；`name` 是自由字符串，**中文可以**。

激活失败不会抛给调用者，而是记进 `record.broken` 并 `logger.warn`（`:130-134`），roster 里保持可见。

### 4.4 文件位置：**没有 preset 文件**

- preset 是 **bundle patch 里的一行**。`<PKG>dsh-agent-preset-registry/README.md:46`：「Definitions are ordinary plugin rows; the registry **neither scans directories nor accepts preset paths**.」
- 随发行版：`<PKG>dsh-web-app/presets/{standard,ptc,minimal,cordis}.patch.yml`，由 `dsh-web-app/package.json:34-37` 与 `:45-48` 的 `dsh.bundle.patch` 数组按序应用。
- 行 id 约定 `preset-<id>`：`standard.patch.yml:5`、`ptc.patch.yml:5`、`minimal.patch.yml:5`、`cordis.patch.yml:5`。
- 注册表默认 `standard`：`<PKG>dsh-web-app/cordis.patch.yml:561-565`
  ```yaml
  - insert:
      - id: agent-preset-registry
        name: '@deepseek-ai/dsh-agent-preset-registry'
        config:
          default: standard
  ```
- **已废弃**：旧的 `$DSH_HOME/.agent-presets/<id>/preset.yml` + `agent.cordis.yml` 目录格式，`<PKG>dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md` 的 "Migrate a legacy preset" 明确写「Nothing reads that directory any more.」
- 实测 `C:\Users\huang\.dsh` 全树（排除 node_modules/sessions）：**不存在任何 preset 文件或 `.agent-presets` 目录**；与 preset 相关的只有 `profiles\desktop\cordis.patch.yml`（无 `preset-*` 覆盖）。

### 4.5 能否 pin 模型 / 权限 / 系统提示词

| 想 pin | 能否 | 怎么做 / 证据 |
|---|---|---|
| **系统提示词** | ✅ 可以 | preset 里挂 `@deepseek-ai/dsh-persona` 行。`standard.patch.yml:11-15`：`config: { prefix: 'You are a coding agent powered by the {{model}} model.', suffix: 'Your working directory is {{cwd}}.' }`。字段：`prefix`(必填) / `suffix` / `complete` / `includeRuntimeContext`（`<PKG>dsh-persona/README.md:38-44`）。**该行只能挂在 preset 作用域内**，全局挂会与 prompt registry 冲突并 fail loud（同文件 :12, :28, :117） |
| **模型** | ⚠️ 间接 | `PresetDefinition` **没有** model 字段（见 4.2）。只能往 `plugins` 里挂一行提供默认模型选择的插件，例如 `@deepseek-ai/dsh-agent-default-model`（`config: { provider, model, reasoningEffort? }`，`<PKG>dsh-agent-default-model/README.md:34-46`）。但该包 README `:116` 说「**One process-wide default**」，且 `saveSelection()` 会写 profile patch — **它能否安全地放进 preset 作用域，未验证**（见 §7） |
| **权限模式** | ❌ 不能（按文档） | `@deepseek-ai/dsh-permission-presets` 是**进程级**服务：`config: { presets: {...}, defaultPreset }`（`<PKG>dsh-permission-presets/README.md:34-52`），默认值经 `permission` settings namespace 作用于**未来会话**（:64）。其 `PresetSpec` 只 bundle sandbox + approval 两个旋钮，README `:134` 明说「an agent/profile choice is **not** part of `PresetSpec`」。选择入口是 `/permission` 命令与 Settings 的 Permissions 选择器（:56） |

### 4.6 人类在 Web GUI 里怎么选

- 入口行：`<PKG>dsh-web-app/cordis.patch.yml:391-394`
  ```yaml
  # The agent-preset row in General settings: the default preset for
  # sessions created later. Absent a roster it renders nothing.
  - id: ui-agent-preset
    name: '@deepseek-ai/dsh-client-ui-agent-preset'
  ```
- 行为（`<PKG>dsh-client-ui-agent-preset/README.md`）：
  - `:28` Settings 显示内置/自定义卡片组，含默认高亮与卡片体选择；每张卡有「View configuration」只读 YAML 查看器；**页面不编辑任何东西**，Creator 入口会开一个 Creator-mode 任务
  - `:30` General Settings 里的 **Coding Tools** 决定模式能否被选择：关掉 → 新会话选择器消失，但 Settings 卡片仍能改保存的默认值；打开 → 选择健康的默认值会同步当前空白会话
  - `:40` 底层用 `agentPresets/list` 拿 roster、`agentPresets/read` 读某个声明的 YAML；改默认值写 `agent-preset-registry` 的 settings namespace
  - `:58` 选择只影响**之后**创建的任务；已存在会话不变
  - `:64` Web **不创建也不编辑** preset

---

## 5. 为一个插件建专属 preset（"SV 控制台"）

### 5.1 最小正确做法 = 一个两文件 bundle + `install_bundle`

权威依据：`<PKG>dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md` 的 "Create a preset"。

`sv-console\package.json`
```json
{
  "name": "@local/dsh-sv-console-preset",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`sv-console\cordis.patch.yml`
```yaml
- insert:
    # ① 我的插件本体（Host 平面；若它只是工具/提示词提供者，见下方说明）
    - id: sv-console
      name: '@local/dsh-sv-console'
      config: {}

    # ② 专属 preset
    - id: preset-sv-console
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: sv-console
        name: SV 控制台
        description: 标准编码 agent + SV 控制台插件。
        order: 50
        plugins:
          # —— 逐条复制 <PKG>dsh-web-app/presets/standard.patch.yml:11-143 的完整列表 ——
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: You are a coding agent powered by the {{model}} model.
              suffix: Your working directory is {{cwd}}.
          - id: agent-instructions
            name: '@deepseek-ai/dsh-agent-instructions'
            config: { maxBytes: 65536 }
          - id: tool-pwsh
            name: '@deepseek-ai/dsh-tool-pwsh'
            disabled: !!js process.platform !== 'win32'
          # … tool-fs / tool-fs-search / tool-jobs / skill-filesystem / tool-skill /
          #   command-goal / tool-goal / planning(group) / compaction(group) /
          #   delegation(group) / tool-ask-user / tool-todo / tool-web / present /
          #   tool-plugin-manager  —— 全部照抄
          # —— 追加我的插件 ——
          - id: sv-console-tool
            name: '@local/dsh-sv-console'
```

**关键约束：**
1. **preset 的 `plugins` 是完整列表，不是增量。** 新建 preset 不继承任何东西；覆盖随发行版的 preset（`- id: preset-standard` 同 id 覆盖）会替换**整个 `config`**（`editing-cordis-compositions/SKILL.md` "Change a shipped preset"）。
2. preset 行里的插件名解析基准 = **声明行的 baseUrl**：`<PKG>dsh-agent-preset-registry/lib/types/index.js:124` `const context = scope.ctx.extend({ baseUrl: record.context.baseUrl });`。
3. **放在 Host 平面还是 preset 平面**（`editing-cordis-compositions/SKILL.md` "Choose plugin placement"）：
   - 提供**共享服务**（工具/提示词注册表、Agent loop、session、持久化、settings、sandbox 策略、模型路由、subagent 后端）→ Host 平面（bundle patch 的 `insert` 里，profile 级，所有 agent 可见）
   - 只给 agent **增加 scoped 工具 / persona / 提示词段落 / 策略** → 放进 preset 的 `plugins`
   - 一个在 preset 里提供服务的插件，必须把 provider 与全部 consumer 隔离在**同一个 realm**（用 `isolate`）
4. 我给的例子同时做了 ① 和 ②：如果 `@local/dsh-sv-console` 其实是工具提供者，把它从 ① 删掉、只保留在 preset 的 `plugins` 里即可（避免重复挂载）。

### 5.2 安装

```
plugin_manager { action: "install_bundle", target: "C:\\Users\\huang\\Desktop\\deepseek harness\\sv-console" }
```
- 必须传**绝对路径**（服务侧 cwd = profile 目录，见 §1.3）。
- 想保留源码实时编辑，可用 `target: "link:C:\\Users\\huang\\Desktop\\deepseek harness\\sv-console"`（`anchorPathSpec` 支持 `link:`/`file:` 前缀，`operations.js:19-25`）。
- 只有返回 `application: "applied"` 才算生效；`restart-required` 说明需要重启。
- 验证：`plugin_manager { action: "list_plugins" }` 应看到 `preset-sv-console` 行（`editing-cordis-compositions/SKILL.md` "Verify"）。

### 5.3 用户怎么选

1. 打开 Web GUI → **Settings → General → Agent preset**（`ui-agent-preset` 卡片）→ 选 **SV 控制台**。这会写 `agent-preset-registry` 的 `selectedDefault`，成为**之后新建会话**的默认。
2. 或者在 General Settings 里打开 **Coding Tools**，新会话选择器就会出现，可以在建任务时直接选（`dsh-client-ui-agent-preset/README.md:30`）。
3. 已存在的会话保持原 preset（`dsh-agent-preset-registry/README.md:58,89`），需要在**新会话**里验证。

---

## 6. 推荐的新本地插件目录结构

```
C:\Users\huang\Desktop\deepseek harness\sv-console\
├─ package.json            # name/version/type/exports/dsh.bundle[.patch]/dsh.client/icon/meta
├─ cordis.patch.yml        # bundle 层：- insert: [{ id, name, config? }, ...]
├─ index.js                # Host 半边：export const name / export const inject / export const Config / export function apply(ctx, config)
├─ client.js               # 可选，浏览器半边：window.__ModuleLoader__.load({ id: '<包名>', factory })
├─ icon.svg                # 可选，≤256 KiB
├─ locale\
│  ├─ en.json              # 可选，展示元数据
│  └─ zh.json
└─ README.md
```

对照最小实例（可整份复制）：
- Host-only: `<PKG>dsh-agent-preset/skills/cordis-plugin-development/templates/mcp/{package.json,cordis.patch.yml}`
- Host + Client: `<PKG>dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/{package.json,cordis.patch.yml,index.js,client.js}`
- 真实无构建实例：`C:\Users\huang\.dsh\profiles\desktop\node_modules\dsh-delete-session\`

---

## 6.1 附：与当前 workspace 的 `sv-dsh\` 对齐

workspace 里已存在（仅列出，未修改）：

```
sv-dsh\
├─ README.md
├─ docs\研究与方案.md
├─ plugin\sv\DSHBridge.lua      (39553 字节)
├─ probe\{Probe.lua,ProbePanel.lua,README.md}
└─ tools\{check-lua.mjs,package.json,pnpm-lock.yaml,node_modules}
```

要让 `sv-dsh` 成为一个可 `install_bundle` 的 DSH 插件包，**包根目录**（即含 `package.json` 的那一层）必须出现 `package.json` + `cordis.patch.yml` + Host 半边入口 JS。两个可选落法：

- **A（推荐，改动最小）**：把 `package.json` / `cordis.patch.yml` / `index.js` 直接放在 `sv-dsh\` 根目录，`DSHBridge.lua` 继续待在 `plugin\sv\` 下，由 `index.js` 用 `path.join(import.meta.dirname, 'plugin', 'sv', 'DSHBridge.lua')` 定位。
- **B**：把 `sv-dsh\` 当作**preset bundle**（只含 `package.json` + `cordis.patch.yml`），preset 行里用 `@local/dsh-sv-console` 之类的名字引用另一个真正含 `index.js` 的插件包。

注意：`sv-dsh\tools\` 已经有自己的 `package.json` + `pnpm-lock.yaml` + `node_modules` —— 如果包根目录设在 `sv-dsh\`，pnpm 会把它当成包内容的一部分；建议把 `tools\` 移出包根，或写进 `files` 白名单之外并加 `.npmignore`。

---

## 7. 未验证 / 不确定

1. **Client `Builtin.listBuiltins` 权威清单未取得** — `cordis_inspect_query` 对 Client `Builtin` / `Service` 均 10s 超时（无已连接页面）。§3.4 的全局符号来自模板与真实插件，**不是**权威穷举。重连页面后应重跑。
2. **`plugin_manager` 未实际调用** — 本会话审批被禁用，任何 action 都会被自动拒绝。§1.3/§1.5 的 action 语义、返回值字段全部来自源码，未做端到端实测。
3. **`install_bundle` 传本地绝对路径的端到端行为未实测** — 代码路径（`namedSpecs` → `anchorPathSpec` → `pnpm add <abs>` → `reconcile`）已读通，但未真正安装过一个本地目录插件。pnpm 落进 `dependencies` 的具体 spec 形式（`file:` / `link:` / 相对路径）未验证。
4. **`link:` 协议未实测** — 只确认 `anchorPathSpec`（`operations.js:19-25`）与 `parseInstallSpec` 不会破坏 `link:` 前缀。
5. **`@deepseek-ai/dsh-agent-default-model` 能否安全放进 preset 的 `plugins`** — 未验证。该包 README 自述「One process-wide default」（:116）且 `saveSelection()` 写 profile patch，与 preset 的 scoped realm 可能冲突。要用模型 pin，请先在测试 profile 里验证。
6. **preset `id` 的字符集** — 本版本 `register()` 只校验非空 + 唯一（`dsh-agent-preset-registry/lib/types/index.js:95-98`），**没有正则**。skill 文档说的「lowercase letters, digits and hyphens」在本版本**未被强制**；但为兼容性建议遵守。
7. **`name: "SV 控制台"` 的中文显示** — schema 是 `z.string()`，语法上允许；但 Web 端是否对 roster `name` 走 locale 服务、中文卡片是否正常渲染，未实测。
8. **`dsh plugin --profile desktop` 是否在「Desktop 载体内部」可用** — `dsh/README.md:62` 说 Desktop 载体会传 `manageDesktopProfile`，但我在 `<ASAR>\lib\main.js` 里 grep `manageDesktopProfile` **0 命中**（可能被压缩/改名或位于其他 chunk），未定位到调用点。
9. **`dsh plugin --profile <非 desktop>` 的实际效果未实测** — 会初始化 profile 目录（`runPluginCommand` → `initProfile`），有副作用，故未运行。
10. **profile 里的异常状态** — `profiles\desktop\package.json` 的 `dsh.profile.bundles` 含 `dsh-plugin-github` 与 `@deepseek-ai/dsh-experimental-auto-review`，但 `dependencies` 里**没有**这两个（且存在 `package.json.bak-github-plugin-20261001-150313`）。`reconcile()` 的过滤逻辑（`operations.js:47-53`）会**保留**这类「不在 dependencies 里」的名字，因此这类残留会一直留在 bundles 列表里、加载时变成 `error` 行。这是手工改 profile 的典型后果，未进一步诊断。
