/**
 * DSH 面板(SidePanelSection)  v0.6.0
 * ============================================================================
 * SV2 侧栏里的一个小聊天框:把话发到 DSH,并显示 DSH 那边的回复。
 *
 * ── 2026-10-07 大改(用户四条要求)────────────────────────────────────────
 *   ① "你的回答都要用选项表现出来" ⇒ 助手每次回复都推一组**按钮**(panel_ask),
 *      面板的主要交互从"打字"变成"点一下"。
 *   ② "用户不满意的话就在选项下面加个小输入框" ⇒ 选项**在上面**、小输入框在**下面**。
 *      (注:2026-10-02 那版是反过来的 —— 输入框在上、选项在下。用户现在明确改了顺序。)
 *   ③ "插件界面大改,要好看,美观" ⇒ 分区清楚、每行不超过 3 个控件、
 *      标签文案极短、按钮文案短到不会截断;整体高度收紧(见下面的高度表)。
 *   ④ "那些快捷方式可有可无了" ⇒ **删掉**六个快捷动作与"一键调参"按钮。
 *      想干什么直接在小输入框里说(助手的提示词里本来就有整套流程)。
 *
 * ── 版面(从上到下)───────────────────────────────────────────────────────
 *   [状态行]        一行,极短:组名 · 音符数 · 桥在线
 *   [回复区]        只显示 DSH **最近一条**回复(完整历史在 DSH 那边看)
 *   ── 有选项时 ──
 *   [题目]          一行 Label
 *   [选项 1..8]     竖排、一行一个(并排会把字挤窄截断)
 *   [提示]          "不满意?在下面自己写:"
 *   [小输入框]      44~56px,短
 *   [发送][刷新][清空]  一行三个
 *
 * ⚠️ 侧栏**很窄**(宽度由宿主决定,我们控制不了)⇒ 布局按"最窄"设计:
 *    每行最多 3 个控件;长文案单独占一行;装饰性文字要短。
 *    `tools/panel-tests.mjs` 会**算出**"让所有按钮都不被截断所需的最小宽度"(≈183px)
 *    并把它钉住 —— 侧栏再窄也还有个可测的下限。
 *
 * ⚠️ 为什么面板不直接读写文件:
 *    面板沙箱**没有任何文件能力**(连 Lua 面板里 `io.open` 都返回 nil)。
 *    所以面板只能走 project `scriptData`,由常驻的 DSHBridge.lua 做中继。
 *
 * ⚠️⚠️ 两条硬纪律(用户 2026-10-02 明确要求「面板一重载就清空,.svp 里不留任何东西」):
 *    1. **日志只活在内存里** —— 面板一重载就没了,不写进工程文件。
 *    2. **中继键是临时的** —— 桥写一条,面板取走后**立刻 removeScriptData**;
 *       面板写一条,桥取走后也立刻删。静止状态下工程里不残留本插件的任何键。
 *
 * ⚠️ 面板里**任何错误都会弹宿主对话框并中断脚本** ⇒ 所有入口/回调一律 try/catch,
 *    `getSidePanelSectionState()` 必须永不抛错。
 *
 * ⚠️ JS 侧一律**点调用**(`SV.setTimeout`),Lua 侧才是冒号 —— 两边约定不同。
 *
 * ⚠️ 刷新纪律(用户实测过「不要一直刷新,我没法打字」):
 *    `SV.refreshSidePanel()` 会重建整个面板、冲掉输入框焦点。
 *    ⇒ 只有**结构变化**才刷新;纯文本更新走 `WidgetValue.setValue`;
 *      输入框里有没发出去的字时,一律推迟刷新 —— 包括"题目来了"这种结构变化,
 *      它只挂 `st.needsRefresh`,由轮询那一拍在输入框干净时才真的刷。
 */

var PANEL = {
  VERSION: '0.6.1',
  K: {
    out: 'svdsh.panel.out', // 面板 → 桥(桥消费后立即删)
    in: 'svdsh.panel.in', // 桥 → 面板(面板消费后立即删)
  },
  POLL_MS: 500,
  // ── 回复区:纯文字(Label 行)────────────────────────────────────────────
  // ⚠️ 为什么不用 TextArea:宿主**没有"只读文本"这个字段**。
  //    官方的控件示例里只有 type / value / height / width / text —— 我们和参考项目
  //    都写过 `readOnly: true`,但那是**猜的**:用户 2026-10-07 实测"回复框里也能打字"
  //    ⇒ 这个字段在 SV2 2.3.0 上不起作用。Label 是纯文字,**天生不可编辑** ⇒ 用它。
  //    代价:Label 的 text 是**静态**的 ⇒ 回复变了必须重建面板(见 st.needsRefresh),
  //    不能像 WidgetValue 那样只改值。这是 API 逼出来的取舍。
  REPLY_COLS: 22, // 自己折行(不赌宿主会不会自动折)
  REPLY_LINES: 9, // 空闲时最多显示几行
  REPLY_LINES_ASK: 4, // 有选项时让位给选项
  // 小输入框:用户 2026-10-07 明确要"**小**输入框" ⇒ 空闲 56(两三行)、有选项时 44(两行)。
  INPUT_HEIGHT: 56,
  INPUT_HEIGHT_ASK: 44,
  // 最多渲染几个选项按钮。
  // ⚠️ 用户 2026-10-02 说过"最多 8 个竖排",但 2026-10-07 又要"界面好看、整体收紧":
  //    6 个 × 宿主默认按钮高(≈34px)≈ 204px,加上回复/输入/按钮刚好不滚;
  //    8 个就要滚了。**超出的选项不会丢** —— 回复区里有全文,小输入框也能直接回。
  MAX_CHOICES: 6,
  LOG_KEEP: 60, // 最多留几条(每条可能很长,条数比字节数更该管)
  // 多久自动问一次"桥还在不在"。
  // 这是**唯一**的周期性 scriptData 活动:一条 key,面板取走后立刻删除,零残留。
  // 没有它,状态行就只能显示"上次应答是 N 分钟前",没法反映"桥已经停了"。
  STATUS_MS: 20000,
}

var wInput = SV.create('WidgetValue')
var wSend = SV.create('WidgetValue')
var wRefresh = SV.create('WidgetValue')
var wClear = SV.create('WidgetValue')

/* ── 控件 ─────────────────────────────────────────────────────────────────
 * ⚠️ 0.8.5 删掉了原来那套"调参滑条 + 预设下拉"(VOICE_PARAMS / wTuningRead /
 *    wTuningApply / wTuningReset / wPresetCombo / wVoiceParams / readVoice /
 *    applyVoice / rebuildModeWidgets / syncSlidersFromVoice / onOpResult / sendOp)。
 *
 * ⚠️ 0.6.0(本次)又删掉了六个**快捷动作**(看工程 / 对齐音频 / 体检重叠 / 量化 /
 *    读转录 / 填歌词)与"一键调参"按钮 —— 用户 2026-10-07:"那些快捷方式可有可无了"。
 *    删掉之后面板只剩:状态行 · 回复区 · 选项 · 小输入框 · 三个按钮。
 *    想干什么直接在小输入框里说;助手的提示词里本来就有整套流程。
 *
 *    ⚠️ 桥那边的能力**保留**:面板直连 op 的白名单(`DSHBridge.lua` 的 PANEL_OP_OK)
 *       与中继协议仍在,并且有测试守着(harness 的「面板中继」一条)。
 */
// 选项按钮:预建 MAX_CHOICES 个复用(控件数量固定,就不用为了选项反复重建面板)
var wAsk = []
for (var wa = 0; wa < PANEL.MAX_CHOICES; wa++) wAsk.push(SV.create('WidgetValue'))

var st = {
  // ★ 只在内存里,重载即清空。
  // ⚠️ 改成**数组**而不是一坨字符串 —— 用户反馈"分不清谁说的",
  //    而字符串拼起来就再也分不出来了。每条:{who:'you'|'dsh'|'sys', text, at}
  log: [],
  sid: String(Date.now()) + '-' + String(Math.floor(Math.random() * 100000)),
  seq: 0,
  waiting: false,
  statusText: '',
  statusAt: 0,
  pingSentAt: 0, // 发过 ping 但还没收到应答的时刻(0 = 没有在等)
  lastPingAt: 0, // 上次发 ping 的时刻
  lastStatus: '',
  // ── 选项(助手推过来的选择题)──
  // ⚠️ 用户 2026-10-02:"在 sv2 作业时,为了追求效率,大多数情况下应该给选项让用户选择"。
  //    所以助手要决策时不是问一句开放题,而是**推一组按钮**过来点。
  ask: null, // {id, prompt, choices[]} 或 null
  askAt: 0,
  // 回复区的**纯文字行**(Label 用;见 renderLog 的说明)。
  replyLines: [],
  // 结构变了(回复变了 / 题目来 / 选项被点掉)但**还没重建面板**。
  // 纯文字是静态的 ⇒ 改它只能靠重建;而重建会冲掉输入框焦点,所以**等输入框干净**再刷。
  needsRefresh: false,
}

var outQueue = [] // 面板 → 桥的待发事件(桥还没取走时先攒着,避免互相覆盖)

function readKey(key) {
  try {
    var v = SV.getProject().getScriptData(key)
    return v === undefined ? undefined : v
  } catch (e) {
    return undefined
  }
}

function writeKey(key, value) {
  try {
    SV.getProject().setScriptData(key, value)
    return true
  } catch (e) {
    return false
  }
}

/** 删键 —— "不残留"的关键。老宿主没有 removeScriptData 时退化成写空串。 */
function removeKey(key) {
  try {
    var proj = SV.getProject()
    if (typeof proj.removeScriptData === 'function') {
      proj.removeScriptData(key)
      return true
    }
    proj.setScriptData(key, '')
    return true
  } catch (e) {
    return false
  }
}

function refresh() {
  try {
    if (typeof SV.refreshSidePanel === 'function') {
      SV.refreshSidePanel()
      return true
    }
    if (SV.refreshSidePanel) {
      SV.refreshSidePanel()
      return true
    }
  } catch (e) {
    /* 老宿主没有这个 API:退化成手动点刷新 */
  }
  return false
}

/** 输入框里还有没发出去的字吗(有就不刷新,免得冲掉焦点) */
function inputDirty() {
  try {
    var t = wInput.getValue()
    return typeof t === 'string' && t.replace(/^\s+|\s+$/g, '').length > 0
  } catch (e) {
    return false
  }
}

/** 往日志里加一条。who: 'you' | 'dsh' | 'sys' */
function logPush(who, text) {
  var t = String(text === undefined || text === null ? '' : text)
  if (!t) return
  st.log.push({ who: who, text: t, at: Date.now() })
  while (st.log.length > PANEL.LOG_KEEP) st.log.shift()
}

function hhmm(ms) {
  var d = new Date(ms)
  var h = d.getHours()
  var m = d.getMinutes()
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m
}

/**
 * 把一段文本折成"面板能显示的行"。
 *
 * ⚠️ **自己折行**,不赌宿主会不会自动折 —— 官方的 Label 示例只有一行短文字,
 *    没有任何"会自动折行"的承诺。折行宽度按侧栏最窄的情况给(REPLY_COLS)。
 * ⚠️ 超过 maxLines 就**截断 + 自述**:最后一行换成"后面还有 N 行,完整在 DSH"。
 *    这是"如实"而不是"悄悄少几行" —— 用户得知道去哪儿看剩下的。
 */
function wrapForPanel(text, cols, maxLines) {
  var src = String(text === undefined || text === null ? '' : text).split('\n')
  var out = []
  for (var i = 0; i < src.length; i++) {
    var line = src[i]
    if (line.length === 0) {
      out.push('')
      continue
    }
    for (var at = 0; at < line.length; at += cols) out.push(line.substr(at, cols))
  }
  var total = out.length
  if (total > maxLines) {
    out = out.slice(0, maxLines)
    out[maxLines - 1] = '…(后面还有 ' + (total - maxLines + 1) + ' 行,完整在 DSH 看)'
  }
  return out.length ? out : ['']
}

/**
 * 渲染回复区(纯文字)。
 *
 * ⚠️ 用户 2026-10-02 的裁决:"别从下往上了,改回从上往下,并且回复前清空历史消息,
 *    反正原历史在 dsh 上面" ⇒ ① 正序;② **每次回复前清空** —— 面板里永远只有
 *    **当前这一条**,不和旧消息混。完整历史在 DSH 那边看。
 * ⚠️ 也不要用 emoji:SV2 的侧栏字体不渲染,会显示成乱码(用户实测)。
 * ⚠️ 纯文字是**静态**的 ⇒ 这里必须挂 needsRefresh,由 step() 在输入框干净时重建面板。
 */
function renderLog() {
  var parts = []
  if (st.waiting) parts.push('· 已发送,等待 DSH 回复…')
  for (var i = 0; i < st.log.length; i++) {
    var e = st.log[i]
    if (e.who === 'you') continue // 你自己说的话不进回复区
    if (parts.length > 0) parts.push('')
    // ⚠️ 分隔行要**短**:侧栏很窄,原来那行 `======== 12:34 ========` 有 22 个字符,
    //    在这么窄的面板里等于白占一整行(用户 2026-10-07 提醒过"框挺小的")。
    parts.push('[' + hhmm(e.at) + ']')
    parts.push(e.text)
  }
  var text = parts.length
    ? parts.join('\n')
    : '(这里显示 DSH 的回复。在下面选一个,或者自己写一句。)'
  var maxLines = st.ask ? PANEL.REPLY_LINES_ASK : PANEL.REPLY_LINES
  st.replyLines = wrapForPanel(text, PANEL.REPLY_COLS, maxLines)
  st.needsRefresh = true
}

function statusLine() {
  if (!st.statusText) {
    if (st.pingSentAt && Date.now() - st.pingSentAt > 3000) {
      return '桥没有应答 —— 去 [脚本] > [DSH] 里运行 DSH Bridge'
    }
    return '正在确认桥的状态…'
  }
  var age = Math.floor((Date.now() - st.statusAt) / 1000)
  var when =
    age <= 25
      ? '在线'
      : age < 60
        ? '上次应答 ' + age + ' 秒前'
        : age < 3600
          ? '上次应答 ' + Math.floor(age / 60) + ' 分钟前'
          : '上次应答 ' + Math.floor(age / 3600) + ' 小时前'
  // 超过一个心跳周期(5s)的三倍还没新应答 ⇒ 明确提示可能已经停了,
  // 而不是一直挂着"已连接"骗用户。
  // ⚠️ 这里**不能用 ⚠ 这个字符** —— 它属于 U+26A0,面板字体不渲染,会变乱码
  //    (用户实测反馈过)。用纯 ASCII 的 [!] 代替。
  var tail = age > 30 ? '  [!] 可能已停止' : ''
  return st.statusText + '  ·  ' + when + tail
}

/** 把一条事件排进待发队列,并尝试立刻交给桥 */
function emit(kind, payload) {
  st.seq = st.seq + 1
  var ev = {
    v: 1,
    seq: st.seq,
    sid: st.sid,
    kind: kind,
    at: Math.floor(Date.now() / 1000),
    panel: PANEL.VERSION,
  }
  if (payload) {
    for (var k in payload) {
      if (Object.prototype.hasOwnProperty.call(payload, k)) ev[k] = payload[k]
    }
  }
  outQueue.push(ev)
  flushOut()
  return ev
}

/** 槽位空着才写:桥一次只取一条,互相覆盖会丢消息 */
function flushOut() {
  try {
    if (outQueue.length === 0) return
    var cur = readKey(PANEL.K.out)
    if (typeof cur === 'string' && cur.length > 0) return // 桥还没取走
    writeKey(PANEL.K.out, JSON.stringify(outQueue.shift()))
  } catch (e) {
    /* 忽略 */
  }
}

function send() {
  try {
    var text = String(wInput.getValue() === undefined ? '' : wInput.getValue())
    text = text.replace(/^\s+|\s+$/g, '')
    if (!text) return
    // ⚠️ 原来这里**没有**这一行 —— 用户的话根本没进日志,所以框里只有 DSH 的回复,
    //    看起来就是"分不清谁说的"。必须两边都记。
    logPush('you', text)
    emit('input', { text: text })
    st.waiting = true
    try {
      wInput.setValue('')
    } catch (e) {
      /* 忽略 */
    }
    renderLog()
  } catch (e) {
    /* 回调里绝不抛 */
  }
}

/** 拉取桥送来的一行(取走就删键) */
function pull() {  try {
    var chunk = readKey(PANEL.K.in)
    if (typeof chunk !== 'string' || chunk.length === 0) return false
    // 先取走再显示:保证"不残留"这条不会因为后面出问题而失效
    removeKey(PANEL.K.in)

    // 控制消息(桥发来的指令,不是聊天内容)
    if (chunk.charAt(0) === '{') {
      var ctl = null
      try {
        ctl = JSON.parse(chunk)
      } catch (e) {
        ctl = null
      }
      if (ctl && ctl.ctl === 'clear') {
        // 桥检测到换工程 ⇒ 清空本地日志(面板脚本不会因为换工程而重载,
        // 所以只能由桥来通知)
        st.log = []
        st.waiting = false
        renderLog()
        return true
      }
      if (ctl && ctl.ctl === 'ask') {
        // 助手推来的**选择题** ⇒ 渲染成按钮让用户点。
        st.ask = {
          id: String(ctl.id || ''),
          prompt: String(ctl.prompt || '请选择'),
          choices: ctl.choices || [],
        }
        st.askAt = Date.now()
        // ⚠️ **兜底**:同时把题目与选项写进回复区。
        //    用户实测反馈过"没看到选项" —— 按钮是控件,要面板重载才会出现;
        //    而文字一定看得见,而且用户可以直接在下面的小输入框里打字回答
        //    (走的是同一条通道)。两条路并存:按钮能点就点,点不了就打字。
        var lines = ['【请选择】' + st.ask.prompt]
        for (var li2 = 0; li2 < st.ask.choices.length && li2 < PANEL.MAX_CHOICES; li2++) {
          lines.push('  ' + String(st.ask.choices[li2]))
        }
        st.log = [{ who: 'dsh', text: lines.join('\n'), at: Date.now() }]
        renderLog()
        // 选项出现/消失会改行数 ⇒ 需要重建面板。
        // ⚠️ 但**不能在这里直接重建**:用户可能正在输入框里打字,`refreshSidePanel()`
        //    会连焦点带没发出去的字一起冲掉 —— 这正是文件头那条纪律
        //    (「不要一直刷新,我没法打字」)。⇒ 交给 step():输入框干净时它才真的刷。
        st.needsRefresh = true
        return true
      }
      // 不是控制消息 ⇒ 当普通文本继续往下走
    }

    if (chunk.indexOf('· 桥 ') === 0) {
      st.statusText = chunk
      st.statusAt = Date.now()
      st.pingSentAt = 0 // 收到应答,不再"等"
      st.waiting = false
      return false // 状态应答不写进聊天记录
    }

    // ⚠️ **过滤掉"自己那句话的回显"**。
    //    桥/插件会把面板发出去的话原样回灌一次(带 "你: " 前缀),面板若照收,
    //    就会出现"同一句话既是你说的、又是 DSH 说的"这种鬼影 —— 用户实测反馈过。
    //    上面那个框现在只放 DSH 的话,所以这种回显必须吞掉。
    var echo = chunk.replace(/^你[:：]\s*/, '')
    var isEcho = /^你[:：]/.test(chunk)
    if (!isEcho) {
      for (var li = st.log.length - 1; li >= 0 && li > st.log.length - 6; li--) {
        if (st.log[li].who === 'you' && st.log[li].text === echo) {
          isEcho = true
          break
        }
      }
    }
    if (isEcho) return true // 吞掉,不显示

    // DSH 的回复 —— **清空历史,只留这一条**。
    // 用户要求:"回复前清空历史消息,反正原历史在 dsh 上面" —— 完整对话在 DSH 里看,
    // 面板只负责显示**当前这一条**,这样永远不会挤在一起、也不会和旧消息混。
    st.log = [{ who: 'dsh', text: chunk, at: Date.now() }]
    st.waiting = false
    renderLog()
    return true
  } catch (e) {
    return false
  }
}

function step() {
  try {
    flushOut()
  } catch (e) {
    /* 忽略 */
  }
  try {
    pull()
  } catch (e) {
    /* 单次失败不影响下一轮 */
  }
  try {
    // 周期性问一次"桥还在不在"。没有它,状态行无法反映"桥已经停了"。
    var now = Date.now()
    if (now - st.lastPingAt >= PANEL.STATUS_MS) {
      st.lastPingAt = now
      st.pingSentAt = now
      emit('status', {})
    }
  } catch (e) {
    /* 忽略 */
  }
  try {
    var line = statusLine()
    if (line !== st.lastStatus && !inputDirty()) {
      st.lastStatus = line
      refresh()
    }
  } catch (e) {
    /* 忽略 */
  }
  // 结构变化(回复变了 / 来了一道选择题 / 用户点掉了选项)要重建面板 ——
  // 但**只在输入框干净时**。用户正在打字就等着,下一拍再看;
  // 这样"回复来了"和"题目来了"都永远不会吃掉没发出去的字。
  try {
    if (st.needsRefresh && !inputDirty()) {
      st.needsRefresh = false
      refresh()
    }
  } catch (e) {
    /* 忽略 */
  }
  try {
    SV.setTimeout(PANEL.POLL_MS, step)
  } catch (e) {
    /* 定时器没了就停 */
  }
}

/* ── 回调(全部包 try/catch:面板回调抛错 = 弹框 + 脚本中断) ── */
try {
  wSend.setValueChangeCallback(function () {
    send()
  })
} catch (e) {
  /* 忽略 */
}

try {
  wRefresh.setValueChangeCallback(function () {
    try {
      pull()
      st.lastPingAt = Date.now()
      st.pingSentAt = st.lastPingAt
      emit('status', {}) // 手动问一次"桥在不在"
      refresh()
    } catch (e) {
      /* 忽略 */
    }
  })
} catch (e) {
  /* 忽略 */
}

try {
  wClear.setValueChangeCallback(function () {
    try {
      // 只清内存里的显示。工程里本来就没有东西可清 —— 日志从不落盘。
      st.log = []
      st.waiting = false
      renderLog()
    } catch (e) {
      /* 忽略 */
    }
  })
} catch (e) {
  /* 忽略 */
}

/* 快捷动作 / 一键调参的回调在 0.6.0 一并删掉了(用户 2026-10-07:"那些快捷方式可有可无了")。
 * 想跑"全参"那套流水线,直接在小输入框里说一句"全参"即可 ——
 * 助手的常驻提示词里本来就写着整套八步流程。 */

/* 选项按钮的回调 —— 点了就把那个选项当成一句话发出去,并清掉选项。
 * ⚠️ 这样用户**不用打字**:点一下就等于回答了。 */
for (var ai = 0; ai < wAsk.length; ai++) {
  try {
    wAsk[ai].setValueChangeCallback(
      (function (idx) {
        return function () {
          try {
            if (!st.ask) return
            var pick = st.ask.choices[idx]
            if (pick === undefined) return
            st.ask = null
            logPush('you', pick)
            emit('input', { text: pick })
            st.waiting = true
            renderLog()
            // 同上:选项要消失,但重建面板得等输入框干净(别吃掉用户打的字)
            st.needsRefresh = true
          } catch (e) {
            /* 忽略 */
          }
        }
      })(ai)
    )
  } catch (e) {
    /* 忽略 */
  }
}

function getClientInfo() {
  return {
    // ⚠️ SidePanelSection 的 name / title **必须是纯 ASCII**:
    //    含中文会被宿主直接拒绝加载(「SidePanelSection 脚本名称必须仅包含 ASCII 字符」)。
    //    中文只能出现在 Label / Button 的 text 等内容字段里。
    name: 'DSH Panel',
    category: 'DSH',
    author: 'dsh-sv-bridge',
    versionNumber: 2,
    // 官方要求 SidePanelSection >= 131330(2.1.2)。本插件只面向 SV2,所以照官方写。
    minEditorVersion: 131330,
    type: 'SidePanelSection',
  }
}

/**
 * 面板版面(2026-10-07 大改后的顺序,**从上到下**):
 *   ① 状态行(一行,极短)
 *   ② 回复区(**纯文字**,一行一个 Label —— 天生不可编辑)
 *   ③ 有选项时:题目 → 选项(竖排、一行一个)→ "不满意?在下面自己写:" 提示
 *   ④ 小输入框(有选项时更矮)
 *   ⑤ [发送][刷新][清空]
 *
 * ⚠️ 选项**在输入框上面** —— 用户 2026-10-07 明确要求"选项下面加个小输入框"
 *    (2026-10-02 那版是反的,已按新要求改过来)。
 * ⚠️ 每行最多 3 个控件;选项一行一个(并排会把字挤窄、被截断)。
 * ⚠️ 这个函数必须**永不抛错** —— 抛一次就是宿主弹框 + 脚本中断。
 */
function getSidePanelSectionState() {
  var rows = []
  try {
    var asking = !!(st.ask && st.ask.choices && st.ask.choices.length > 0)
    var inputHeight = asking ? PANEL.INPUT_HEIGHT_ASK : PANEL.INPUT_HEIGHT

    // ① 状态行
    rows.push({ type: 'Label', text: statusLine() })

    // ② 回复区:**纯文字**(一行一个 Label)⇒ 天生不可编辑。
    //    为什么不用 TextArea:宿主没有"只读"字段(见 PANEL 那段注释)。
    var reply = st.replyLines && st.replyLines.length ? st.replyLines : ['']
    for (var r2 = 0; r2 < reply.length; r2++) {
      rows.push({ type: 'Label', text: reply[r2] })
    }

    // ③ 选项区:助手推来的选择题 ⇒ 竖排按钮,一行一个
    if (asking) {
      rows.push({ type: 'Label', text: '请选择:' + st.ask.prompt })
      var n = Math.min(st.ask.choices.length, PANEL.MAX_CHOICES)
      for (var a = 0; a < n; a++) {
        rows.push({
          type: 'Container',
          columns: [
            { type: 'Button', text: String(st.ask.choices[a]), value: wAsk[a], width: 1.0 },
          ],
        })
      }
      // ④ 选项下面就是那个"小输入框"的入口提示
      rows.push({ type: 'Label', text: '不满意?在下面自己写:' })
    }

    // ⑤ 小输入框(有选项时更矮 —— 把地方让给选项)
    rows.push({
      type: 'Container',
      columns: [{ type: 'TextArea', value: wInput, height: inputHeight, width: 1.0 }],
    })

    // ⑥ 三个按钮:发送占两份宽(它是最常用的)
    rows.push({
      type: 'Container',
      columns: [
        { type: 'Button', text: '发送', value: wSend, width: 2.0 },
        { type: 'Button', text: '刷新', value: wRefresh, width: 1.0 },
        { type: 'Button', text: '清空', value: wClear, width: 1.0 },
      ],
    })
  } catch (e) {
    rows = [{ type: 'Label', text: '面板构建失败(已捕获)' }]
  }
  return { title: 'DSH Panel', rows: rows }
}

/* 文件加载期起轮询:面板脚本**没有 main()**,官方用 getSidePanelSectionState() 取代它 */
;(function boot() {
  try {
    st.lastStatus = statusLine()
    renderLog()
    // ⚠️ 面板正在用这些行构建 ⇒ 把"待刷新"清掉,别让第一拍白刷一次。
    st.needsRefresh = false
    // 立刻 ping 一次,确认桥在不在(桥的应答走 svdsh.panel.in,读走即删)
    st.lastPingAt = Date.now()
    st.pingSentAt = st.lastPingAt
    emit('status', {})
    SV.setTimeout(PANEL.POLL_MS, step)
  } catch (e) {
    /* 忽略 */
  }
})()
