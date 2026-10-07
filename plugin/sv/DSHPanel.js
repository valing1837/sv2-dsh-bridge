/**
 * DSH 面板(SidePanelSection)  v0.5.0
 * ============================================================================
 * SV2 侧栏里的一个小聊天框:把话发到 DSH,并显示 DSH 那边的回复。
 *
 * ⚠️ 侧栏**很窄**(宽度由宿主决定,我们控制不了)⇒ 布局要按"最窄"设计:
 *    · 每行最多 3 个控件(再多文案就被切);
 *    · 长文案单独占一行(一键调参);
 *    · **有选择题时把面板让给题目**:日志降高、快捷动作收起 ——
 *      整块从 ≈662px 降到 ≈450px,题目与竖排选项不用滚就能看全。
 *    · 装饰性文字要短(时间戳分隔行从 22 字符降到 7)。
 *    `tools/panel-tests.mjs` 会**算出**"让所有按钮都不被截断所需的最小宽度"(≈183px)
 *    并把它钉住 —— 侧栏再窄也还有个可测的下限。
 *
 * ⚠️ 为什么面板不直接读写文件:
 *   面板沙箱**没有任何文件能力**(连 Lua 面板里 `io.open` 都返回 nil)。
 *   所以面板只能走 project `scriptData`,由常驻的 DSHBridge.lua 做中继。
 *
 * ⚠️⚠️ 两条硬纪律(用户 2026-10-02 明确要求「面板一重载就清空,.svp 里不留任何东西」):
 *   1. **日志只活在内存里** —— 面板一重载就没了,不写进工程文件。
 *   2. **中继键是临时的** —— 桥写一条,面板取走后**立刻 removeScriptData**;
 *      面板写一条,桥取走后也立刻删。静止状态下工程里不残留本插件的任何键。
 *      这就是为什么这里没有 inRev / log / ackSeq 之类的"状态键":
 *      任何长期存在的键都会被存进 .svp。
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
 *      它只挂 `st.askNeedsRefresh`,由轮询那一拍在输入框干净时才真的刷。
 */

var PANEL = {
  VERSION: '0.5.0',
  K: {
    out: 'svdsh.panel.out', // 面板 → 桥(桥消费后立即删)
    in: 'svdsh.panel.in', // 桥 → 面板(面板消费后立即删)
  },
  POLL_MS: 500,
  // ⚠️ 用户实测反馈:"框太小了,难找到一句话的开头" ⇒ 从 240 提到 460。
  //    现在这个框**只放 DSH 的回复**,所以可以放心做大。
  LOG_HEIGHT: 460,
  // ⚠️ 但**有选择题的时候必须把它让出来**(用户 2026-10-07 再次提醒"侧栏的框挺小的"):
  //    题目 + 最多 8 个选项(竖排一行一个,是用户明确要求的)本来就长,再压一个 460 的
  //    日志框,整个面板就要滚 —— 而在这么窄的侧栏里,"要滚"就等于"看不见、找不到"。
  //    这时候日志降到只够看题目,高度让给选项;答完(st.ask 清空)下一拍自动涨回去。
  LOG_HEIGHT_ASK: 170,
  // 用户要在这个框里打字、也要在里面回答我的选择题 ⇒ 从 44 提到 72
  INPUT_HEIGHT: 72,
  LOG_MAX: 20000, // 只截内存里的显示,不落盘
  LOG_KEEP: 60, // 最多留几条(每条可能很长,条数比字节数更该管)
  // 多久自动问一次"桥还在不在"。
  // 这是**唯一**的周期性 scriptData 活动:一条 key,面板取走后立刻删除,零残留。
  // 没有它,状态行就只能显示"上次应答是 N 分钟前",没法反映"桥已经停了"。
  STATUS_MS: 20000,
}

var wLog = SV.create('WidgetValue')
var wInput = SV.create('WidgetValue')
var wSend = SV.create('WidgetValue')
var wRefresh = SV.create('WidgetValue')
var wClear = SV.create('WidgetValue')

/* ── 快捷动作 ──────────────────────────────────────────────────────────────
 * 面板在 SV2 里,**不该逼用户每次都手打一遍常用指令**。这些按钮只是把一段
 * 固定的话塞进输入框再发出去 —— 走的是和手打完全相同的通道(`emit('input')`),
 * 所以 DSH 那边不需要任何特殊处理,也不存在"面板直连桥"的第二条通路。
 *
 * ⚠️ 这里**只放高频、幂等、无破坏性**的动作。像"删组""清音高线"这种就不放 ——
 *    面板上误点一下代价太大。
 * ⚠️ 文案要写成"用户会怎么说",而不是"op 名":DSH 收到的是人话,不是命令。
 */
var QUICK_ACTIONS = [
  {
    text: '看工程',
    tip: '读工程概况:几条轨、有没有音频轨、当前组多少音符',
    msg: '看一下当前 SV2 工程的状况:几条轨、有没有音频轨(在哪条)、当前组是什么、多少音符。',
  },
  {
    text: '对齐音频',
    tip: '测 BPM 与第一拍,把音频挪到第 1 小节并写速度标',
    msg: '把工程里的音频轨对齐到第 1 小节,并写入速度标。先测出 BPM 和第一拍在哪。',
  },
  {
    text: '体检重叠',
    tip: '检查当前组有没有音符重叠(重叠 = 违规)',
    msg: '检查当前组的音符有没有重叠,把结果报给我。',
  },
  {
    text: '量化',
    tip: '吸附到十六分音符,先给计划再写',
    msg: '把当前组的音符量化到十六分音符。先 dry-run 给我看计划,我说可以再写。',
  },
  {
    text: '读转录',
    tip: '读最上面那条轨的音符(SV2 转录的结果落在那)',
    msg: '读一下最上面那条轨上的音符 —— 那应该是 SV2 自带转录出来的结果。先告诉我数量和大致范围。',
  },
  {
    text: '填歌词',
    tip: '把输入框里的文字当歌词,按音符顺序分配',
    msg: '把这段歌词按音符顺序填到当前组:',
    appendInput: true,
  },
]

var wQuick = []
for (var qi = 0; qi < QUICK_ACTIONS.length; qi++) {
  wQuick.push(SV.create('WidgetValue'))
}

/* ── 控件 ─────────────────────────────────────────────────────────────────
 * ⚠️ 0.8.5 删掉了原来那套"调参滑条 + 预设下拉"(VOICE_PARAMS / wTuningRead /
 *    wTuningApply / wTuningReset / wPresetCombo / wVoiceParams / readVoice /
 *    applyVoice / rebuildModeWidgets / syncSlidersFromVoice / onOpResult /
 *    sendOp,以及 st 里的 voice / presets / modeWidgets / opSeq / opWait /
 *    voiceMsg / groupLabel)。
 *
 *    为什么删:用户 2026-10-02 裁定"不要滑条、不要预设"(见下面「一键调参」那段),
 *    之后 getSidePanelSectionState() 就**再也没有渲染过那些控件** ⇒ 回调永远不会触发
 *    ⇒ 整条链子是死代码。而死代码既没有测试、也没有真机路径,留着只会让人以为
 *    "面板能直接调参"。
 *
 *    ⚠️ 桥那边的能力**保留**:面板直连 op 的白名单(`DSHBridge.lua` 的 PANEL_OP_OK)
 *       与中继协议仍在,并且现在有测试守着(harness 的「面板中继」一条)。
 *       将来要加回什么控件,直接 emit({kind:'op', op:'get_voice', ...}) 即可。
 */
var wTuningToggle = SV.create('WidgetValue')
// 选项按钮:预建 8 个复用(控件数量固定,就不用为了选项反复重建面板)
var wAsk = []
for (var wa = 0; wa < 8; wa++) wAsk.push(SV.create('WidgetValue'))

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
  // 结构变了(题目来 / 选项被点掉)但**还没重建面板**。等输入框干净了再由 step() 刷 ——
  // 直接刷会冲掉用户正在打的字(文件头第 22-25 行的纪律)。
  askNeedsRefresh: false,
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
 * 渲染日志。
 *
 * ⚠️ **倒序(最新在最上面)** —— 这不是审美选择,是被宿主逼出来的:
 *    TextArea 每次 setValue 都会把滚动条**拉回顶部**,而我们**没有任何 API** 能控制它。
 *    正序时你一发消息就被甩到"历史第一句话"(用户原话),看不到刚说的那句。
 *    倒序之后,"被拉回顶部"**正好等于看到最新的那条** ✓
 *    顺带还解决了"难找到一句话的开头" —— 长消息的开头就在最上面。
 *
 * ⚠️ 另一个修的是**根本性的 bug**:原来 send() 只把消息发出去、**根本没记进日志**,
 *    所以框里只有 DSH 的话 —— 难怪"分不清谁说的"。现在两边都记,而且带发言人标记。
 */
function renderLog() {
  // ⚠️ 用户 2026-10-02 的最终裁决(推翻了我之前的倒序方案):
  //    "别从下往上了,改回从上往下,并且回复前清空历史消息,反正原历史在 dsh 上面"
  //    ⇒ ① **正序**(从上往下读,和正常文字一样)
  //      ② **每次回复前清空** —— 框里永远只有**当前这一条**,不会和旧消息混在一起
  //         (这才是"都挤一块了,还和前面的消息混一起"的真正解法:
  //          不是调整顺序,而是**根本不留旧的**。完整历史在 DSH 那边看。)
  // ⚠️ 也不要用 emoji:SV2 的侧栏字体不渲染,会显示成乱码(用户实测)。
  var parts = []
  if (st.waiting) parts.push('· 已发送,等待 DSH 回复…')
  for (var i = 0; i < st.log.length; i++) {
    var e = st.log[i]
    if (e.who === 'you') continue // 你自己说的话不进这个框
    if (parts.length > 0) parts.push('')
    // ⚠️ 分隔行要**短**:侧栏很窄,原来那行 `======== 12:34 ========` 有 22 个字符,
    //    在这么窄的框里等于白占一整行(用户 2026-10-07 提醒过"框挺小的")。
    parts.push('[' + hhmm(e.at) + ']')
    parts.push(e.text)
  }
  var text = parts.length
    ? parts.join('\n')
    : '(这里显示 DSH 的回复。在下面输入一句话发给它。)'
  try {
    wLog.setValue(text)
  } catch (e2) {
    /* 忽略 */
  }
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

/**
 * 快捷动作:把一段固定的话塞进输入框再走正常的发送通道。
 * `appendInput` 为真时保留用户已经打好的内容(例如"填歌词"要带上歌词正文)。
 * ⚠️ 面板回调里**绝不抛错** —— 抛一次就是弹框 + 脚本中断。
 */
function quickSend(action) {
  try {
    var msg = String(action.msg || '')
    if (action.appendInput) {
      var typed = String(wInput.getValue() === undefined ? '' : wInput.getValue())
      typed = typed.replace(/^\s+|\s+$/g, '')
      msg = msg + (typed ? '\n' + typed : '(歌词我打在输入框里了)')
    }
    wInput.setValue(msg)
    send()
  } catch (e) {
    /* 忽略 */
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
        // ⚠️ **兜底**:同时把题目与选项写进日志框。
        //    用户实测反馈过"没看到选项" —— 按钮是控件,要面板重载才会出现;
        //    而文字一定看得见,而且用户可以直接打字回答(走的是同一条通道)。
        //    两条路并存:按钮能点就点,点不了就打字。
        var lines = ['【请选择】' + st.ask.prompt]
        for (var li2 = 0; li2 < st.ask.choices.length && li2 < 8; li2++) {
          lines.push('  ' + String(st.ask.choices[li2]))
        }
        lines.push('(点下面的按钮,或者直接在这里打字回答)')
        st.log = [{ who: 'dsh', text: lines.join('\n'), at: Date.now() }]
        renderLog()
        // 选项出现/消失会改行数 ⇒ 需要重建面板。
        // ⚠️ 但**不能在这里直接重建**:用户可能正在输入框里打字,`refreshSidePanel()`
        //    会连焦点带没发出去的字一起冲掉 —— 这正是文件头第 22-25 行的纪律
        //    (「不要一直刷新,我没法打字」)。⇒ 交给 step():输入框干净时它才真的刷。
        st.askNeedsRefresh = true
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
  // 结构变化(来了一道选择题 / 用户点掉了选项)要重建面板 —— 但**只在输入框干净时**。
  // 用户正在打字就等着,下一拍再看;这样"题目来了"永远不会吃掉没发出去的字。
  try {
    if (st.askNeedsRefresh && !inputDirty()) {
      st.askNeedsRefresh = false
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

/* 快捷动作按钮 —— 每个都独立包一层:某一个绑不上,其余照样能用 */
for (var ci = 0; ci < QUICK_ACTIONS.length; ci++) {
  try {
    wQuick[ci].setValueChangeCallback(
      (function (action) {
        return function () {
          quickSend(action)
        }
      })(QUICK_ACTIONS[ci])
    )
  } catch (e) {
    /* 忽略 */
  }
}

/* 调参控件的回调 —— 每个都独立包 try/catch,一个绑不上不影响其余 */
/* 一键调参 —— 只发一句话给 DSH,由助手去读工程、判断、再调。
 * ⚠️ 用户 2026-10-02 两次纠正过这个按钮的定位:
 *    ① "不需要预设,不需要我再在下面调参数,我自己要调的话就直接用歌声模块来调了"
 *    ② "这个一键调参的功能应该是前面这些快捷动作的总和"
 *    ⇒ 所以它**不是**"打开一堆滑条",而是"把整条流水线跑一遍"的总开关:
 *      看工程 → 读转录 → 体检 → 量化 → 填歌词 → 调声库参数,该做的都做。
 * ⚠️ 文案里不出现 emoji —— SV2 侧栏字体不渲染,会变乱码。 */
try {
  wTuningToggle.setValueChangeCallback(function () {
    try {
      quickSend({
        msg:
          '一键调参(把整条流水线走一遍,等于前面所有快捷动作的总和):\n'
          + '① 看工程状况:几条轨、音频轨在哪、当前组是什么、多少音符\n'
          + '② 读「人声」轨上 SV2 转录出来的音符,做一次布局体检(有没有重叠)\n'
          + '③ 量化到十六分音符 —— 先给我 dry-run 计划\n'
          + '④ 按这首歌的风格 + 当前这一组用的声库,把这组的声音属性和 vocal mode 调好\n'
          + '⑤ 该补的歌词、该加的装饰音,你判断\n'
          + '每一步都先说要做什么、为什么,再动手;拿不准的先问我。',
      })
    } catch (e) {
      /* 忽略 */
    }
  })
} catch (e) {
  /* 忽略 */
}

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
            st.askNeedsRefresh = true
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

function getSidePanelSectionState() {
  var rows = []
  try {
    // ⚠️ 有选择题时**把面板让给题目**(用户 2026-10-07 提醒"侧栏的框挺小的"):
    //    日志降高、快捷动作与一键调参先收起来 —— 它们答题期间用不上,
    //    而每一行都在跟选项抢这块很小的侧栏。答完下一拍自动回来。
    var asking = !!st.ask
    var logHeight = asking ? PANEL.LOG_HEIGHT_ASK : PANEL.LOG_HEIGHT

    // 快捷动作分两行排(一行塞 6 个按钮在侧栏里太挤)。
    // ⚠️ 按钮文案必须是纯 ASCII?—— 不是。受限的是 **Section 的 name/title**;
    //    按钮文字用中文没问题(现有"发送给 DSH"一直如此)。
    var quickRows = []
    if (!asking) {
      for (var r = 0; r < QUICK_ACTIONS.length; r += 3) {
        var cols = []
        for (var c = r; c < r + 3 && c < QUICK_ACTIONS.length; c++) {
          cols.push({
            type: 'Button',
            text: QUICK_ACTIONS[c].text,
            value: wQuick[c],
            width: 1.0,
          })
        }
        quickRows.push({ type: 'Container', columns: cols })
      }
    }

    rows = [
      { type: 'Label', text: statusLine() },
    ]

    rows.push(
      {
        type: 'Container',
        columns: [
          { type: 'TextArea', value: wLog, height: logHeight, width: 1.0, readOnly: true },
        ],
      },
      {
        type: 'Container',
        columns: [{ type: 'TextArea', value: wInput, height: PANEL.INPUT_HEIGHT, width: 1.0 }],
      },
      {
        type: 'Container',
        columns: [
          { type: 'Button', text: '发送给 DSH', value: wSend, width: 2.0 },
          { type: 'Button', text: '刷新', value: wRefresh, width: 1.0 },
          { type: 'Button', text: '清空', value: wClear, width: 1.0 },
        ],
      }
    )
    for (var q = 0; q < quickRows.length; q++) rows.push(quickRows[q])

    /* ── 一键调参 ─────────────────────────────────────────────────────────
     * ⚠️ 用户 2026-10-02 明确纠正过设计:
     *    "我说的一键调参是让你自己根据对这首歌的理解来自动调,并且根据我选择的声库
     *      来调整这个声库的唱法之类的,**不需要预设,不需要我再在下面调参数**,
     *      我自己要调的话就直接用歌声模块来调了。"
     *    ⇒ 所以这里**只有一个按钮**,点了就把请求发给 DSH,由**助手**去读工程、
     *      判断这首歌该怎么唱、再调这一组的声音属性与 vocal mode。
     *      **不做滑条、不做预设下拉** —— 那是在跟 SV2 自带的歌声面板抢活。
     */
    if (!asking) {
      rows.push({
        type: 'Container',
        columns: [
          {
            type: 'Button',
            text: '一键调参(整条流水线跑一遍)',
            value: wTuningToggle,
            width: 1.0,
          },
        ],
      })
    }

    /* ── 选择题(助手推来的)—— 放在**最下面**,竖排 ────────────────────────
     * ⚠️ 用户 2026-10-02 的三条要求:
     *   ① "选项应该放下面,不是有用户的输入框吗?" ⇒ 放在**输入框之下**
     *   ② "选项应该按竖排排放" ⇒ **一行一个**(并排会把文字挤窄、被截断)
     *   ③ "用户要是不满意你给的选项,应该可以让用户手动输入"
     *      ⇒ 上面的输入框**始终可用**,不满意就直接打字发 ——
     *        走的是和点选项**完全相同**的通道(都是 emit('input'))。
     */
    if (st.ask) {
      rows.push({ type: 'Label', text: '— 请选择(也可以直接在上面打字)—' })
      rows.push({ type: 'Label', text: st.ask.prompt })
      for (var a = 0; a < st.ask.choices.length && a < 8; a++) {
        rows.push({
          type: 'Container',
          columns: [
            {
              type: 'Button',
              text: String(st.ask.choices[a]),
              value: wAsk[a],
              width: 1.0,
            },
          ],
        })
      }
    }
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
    // 立刻 ping 一次,确认桥在不在(桥的应答走 svdsh.panel.in,读走即删)
    st.lastPingAt = Date.now()
    st.pingSentAt = st.lastPingAt
    emit('status', {})
    SV.setTimeout(PANEL.POLL_MS, step)
  } catch (e) {
    /* 忽略 */
  }
})()
