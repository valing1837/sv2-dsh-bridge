# P0 能力探针 —— 跑一次,消掉设计里剩下的猜测

> ✅ **已于 2026-10-02 在本机 SV2 2.3.0tp1 上跑过**,结果见
> [`../docs/研究与方案.md`](../docs/研究与方案.md) §3.3。
> 两个结论值得先知道:
> ① **面板沙箱其实有文件能力**(`io.open` 可用)—— 与参考项目的结论相反,但我们仍保留
>    scriptData 中继,因为它版本无关;
> ② **SidePanelSection 的脚本名必须纯 ASCII** —— 名字含中文时宿主会直接拒绝加载。
>    这条已加进 `../tools/check-lua.mjs` 的守卫,本地就能拦下。

## 为什么要单独跑这个

新桥的架构建立在几个**从参考实现里读来、但只在旧宿主/旧版本上验过**的假设上。
其中两条会直接决定文件怎么拆:

1. **面板脚本能不能碰文件?** 参考实现说不能(连 Lua 面板里 `io.open` 都返回 nil)。
   如果这条在你机器上不成立,面板就能直接读写通道文件,**可以省掉 scriptData 中继这一跳**。
2. **`io.popen` / `os.execute` 在不在?** 如果在,某些"同步问一句外部进程"的场景可以不靠轮询;
   如果不在(或调用即弹框),就老老实实走纯文件通道。

其余是版本相关的细节:`.dsh\sv-bridge` 目录能不能写、`scriptData` 往返是否可靠、
`SV.setTimeout` 暴露成什么类型、宿主版本号到底是什么。

## 怎么跑

```
1. 建目录(不存在的话):
   %APPDATA%\Dreamtonics\Synthesizer V Studio 2\scripts\DSH\

2. 复制两个文件进去:
   Probe.lua        ← 菜单脚本(必须)
   ProbePanel.lua   ← 侧栏面板(可选,但建议跑,验的就是第 1 条)

3. 宿主里 [脚本] > [重新扫描]

4. 从侧栏打开「DSH 面板探针」(只看一眼即可)

5. 菜单 [脚本] > [DSH] > [DSH 能力探针]  ← 运行它

6. 结果:
   · 一个摘要框
   · %TEMP%\dsh-sv-probe.json  ← 完整结果,把它贴回来即可
```

## 安全性

- **不写工程**:不建撤销点、不改音符、不改歌词、不动参数。
- 只在 `%TEMP%` 与 `%USERPROFILE%\.dsh\sv-bridge\` 里建/删**自己的探针文件**。
- 面板探针只往 project `scriptData` 写一个 `svdsh.probe.panel` 键(项目另存时会被一起保存,
  不影响任何音乐数据;想清掉就在工程里删掉这个键)。
- 两个脚本里所有调用都被 `pcall` 包住;**任何一步失败都只报告、不抛错**
  —— 因为面板/脚本抛错会弹宿主对话框并中断脚本。

## 读结果的要点

| 字段 | 期望 | 不满足意味着什么 |
|---|---|---|
| `file.writeOk` / `readBackOk` / `appendOk` | 全 `true` | 桥的文件通道不成立,整个方案要重想 |
| `file.renameOverwriteOk` | `"needs-remove-first"` | 若是 `"overwrote"` 可简化原子写;若是 `false` 要换落盘策略 |
| `file.ioPopen` / `file.osExecute` | 类型名(存在与否) | `nil` = 不存在,只能轮询 |
| `file.bridgeDirExists` | `true` | `false` 说明插件还没建过目录,先跑一次插件或手工建 |
| `host.hostVersionNumber` | 数字 | 用来定 `minEditorVersion` 与版本闸 |
| `api.scriptDataRoundTrip` | `true` | `false` 则面板中继不成立 |
| `api.panelProbe` | `fileWrite=...` 的串 | `(未运行面板探针)` = 第 4 步没做 |
| `api.panelProbe` 里的 `fileWrite` | `no-io` 或 `io.open-returned-nil` | 这正是预期:面板没有文件能力 ⇒ 必须保留 scriptData 中继 |
