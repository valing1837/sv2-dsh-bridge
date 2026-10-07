# Changelog

本项目的所有重要变更都记在这里。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [Unreleased]

### 计划中
- **撤销 / 快照** —— 写入前自动留一份可回滚的状态。目前改错了只能手动撤。
- **`set_voice` 的清空语义** —— 现在只能合并,换声库后旧唱法会一直挂着。
- **`auto_expression` 的风格包** —— 现在规则硬编码,舞曲和抒情只能用同一个系数缩放。

---

## [0.7.1] — 2026-10-07

### 修复
- **路径分隔符不再写死 `\`**(`sepFor` / `joinPath`)。POSIX 上反斜杠是**合法文件名
  字符**,不是分隔符 —— 所以原来的写法不是报错,而是**静默写错地方**:`pickDir` 的
  探测文件会以"名字里带反斜杠"的形式创建成功(桥于是以为目录可用),`boot` / `hb` /
  `lastop` 全落进那个错位文件名,而 DSH 侧在正确路径上永远读不到任何东西。
  CI 的 ubuntu job 就是被这条打红的(实测日志:
  `got ".../userprofile\.dsh\sv-bridge"` / `want ".../userprofile/.dsh/sv-bridge"`)。
  现在按 `dir` 自己用的分隔符拼,并在离线测试台里钉住这条判据(与平台无关)。
- **windows CI 的变异门禁**:仓库缺 `.gitattributes`,Git for Windows 默认
  `core.autocrlf=true` 会把检出换成 CRLF,而 `make-mutants.mjs` 的替换串全都按 `\n`
  写 ⇒ **24 条模式"匹配 0 次"**、生成器 abort、一个变异都跑不到。
  现在有 `.gitattributes`(`* text=auto eol=lf`),生成器也会在开头直接把
  "你的工作树是 CRLF"说出来,而不是打 24 行"匹配 0 次"。

### 修复(测试装置自己的洞)
- `check-mutants.mjs` 把**子进程没跑起来**(`status === null`)当成了"变异被抓到" ——
  环境一坏它会打印 `N/N 被抓到 ✓` 却一个变异都没跑。现在单独计数并判红。
- `check-mutants.mjs` 在 `make-mutants` 起不来时只打 `stdout` / `stderr`(都是空的),
  真正的 `gen.error` 被吞掉;现在会打出来。
- 新增变异 `path-sep-hardcoded-windows`(把上面那条分隔符 bug 原样打回去),
  它在两个平台上都必须被抓到。

### 文档
- README 第 3 步补上 `dsh.profile.bundles` —— 只写 `dependencies` 装上了包但不会挂载。

---

## [0.7.0] — 2026-10-02

### 新增
- **`get_summary`** —— 只回统计量(音符数 · 音高范围 · 时值分布 · **重叠数** · 间隙数 · 音节数 · 无效歌词数)。
  300+ 音符的组,明细有 20~50 KB,会撑爆调用方的上下文;这个 op 解决该问题。
- **`auto_expression`** —— 按**旋律走向逐音符**生成气声 / 张力 / 颤音曲线
  (上行加气声、下行加大张力、长音加颤音、句尾收)。
  这是"参数随歌曲进行"的实现,而不是分段常量。
- **`check_lyrics`** —— 歌词体检。只返回**有问题的音符**,不回全量。
  `context: N` 附带前后各 N 个音符的上下文,便于推断该填什么。
- **`group_ops {action:"list"}`** —— 列出全部轨与全部组。
  此前只有"当前组",而多轨工程里这看不到全局。
- **`trackIndex` / `groupIndex` 参数** —— 加到 5 个 op 上:
  `auto_tone_shift` · `set_automation` · `get_automation` · `get_voice` · `set_voice`。
  官方 API 没有 `setCurrentGroup`,脚本切不了当前组,所以按位置定位是必需的。
- **`tools/check-mutants.mjs`** —— 证明测试套件真的会失败:53 个变异逐个跑,漏一个就退出码 1。
- **`tools/make-package.ps1`** —— 一条命令打出自包含分发包,并自动跑三遍自检。

### 变更
- **`quantize` 现在 fail-closed** —— 会造出重叠就**整批不写**,并报出前几处冲突。
- **批量音符编辑先校验后动手** —— 分数索引、越界、非法键在碰宿主之前就被拒。
- 提示词里加入**调参标准流程**与六条纪律。

### 修复
- `set_meter {clearOthers}` 用不存在的 `getMeasureMarkAtBlick` 反查小节号 ⇒ 改为遍历 `getMeasureMarkAt`。
- `group_ops {action:"move"}` 用了**源轨**的索引作参考位置 ⇒ 会同时复制组并删掉 Main 组。
- `addNote` 按 onset 插入而非追加 ⇒ `split_notes` 多段切分命中错误音符,改为倒序处理。
- `set_automation` 的 `closeShape` 是死代码(边界点与用户点同 blick,`add` 会覆盖)⇒ 边界外移一个保护距离。
- `delete_notes` / `select_notes` 没做整数校验 ⇒ 分数索引会谎报成功。
- 速度标记的位置字段是 `position`,小节标记是 `positionBlick` —— 读错会得到约 1 blick 的垃圾值。
- `addTrack` 返回 1 起的计数 ⇒ `addedIndex` 多报一位。

### 移除
- **`io.popen` 全部封锁** —— 它跑 `dir` 列目录时**阻塞宿主 UI 线程,把 SV2 冻住**。
  桥的 op 在宿主的定时器回调里执行,**绝不做 IO / 进程操作**。所有调用点改为立刻报错的桩。
- `get_group_voice` 停用(它依赖 `io.popen` 读工程文件)。声库名改由用户确认。

---

## [0.6.x] 及更早

早期迭代没有系统记录。主要成果是建立起 43 个 op 的骨架、离线测试装置
(fengari 跑 Lua + 假宿主)、以及四道守卫(语法 / 编码 / ES5 兼容 / emoji)。
