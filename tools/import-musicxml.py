"""MusicXML 乐谱 → 音符列表(交给桥的 write_notes 写进 SV2)。

为什么解析放在 SV2 之外:
    SV2 的 Lua 桥能**写**音符(`write_notes`),但它没有像样的文件读取能力 ——
    Lua 绑定只有 `io`/`os`,读一个大 XML 既慢又容易把宿主卡住。
    既有实现的 `sv_import_musicxml` 同样把解析放在工具侧(Node),
    只把"音符数组"交给宿主。本工具是那条链路的 Python 版。

链路:
    MuseScore 等导出的 .musicxml/.xml
      → 本工具(纯标准库,不联网、不碰宿主)
      → write_notes_args(onset/duration 单位 = **四分音符数**,不是 blick)
      → DSH 调桥的 write_notes

⚠️ **本工具绝不自己跟 SV2 说话** —— 它只做分析/汇报。真写由 agent 走桥完成,
   而桥的写操作必须先 `sv_notes` 拿指纹(`expectFp`),那是调用方的事。

⚠️ 为什么一切时间都用**四分音符**而不是 blick:
    ① MusicXML 的 `<duration>` 是"divisions 的个数",除以 `<divisions>` 就是四分音符数;
    ② 桥的 `write_notes` 收的 `onset`/`duration` 也正是四分音符数(桥内部乘 SV.QUARTER);
    ③ blick 是 705600000/四分音符,过一遍只会引入取整误差。

护栏(为什么每一条都要有 —— 攻击面见每条注释):
    ① 只收**绝对路径的本地普通文件**;拒 URL / 相对路径 / `.svp` / 目录 / 符号链接 /
       设备名 / 超大文件 —— 防"把 agent 当任意文件读取器"和"误把工程文件当谱子改坏"。
    ② 解析前**按原始字节**拒 `DOCTYPE` / `ENTITY` —— 防 XXE(外部实体注入)与
       billion-laughs(实体炸弹)。刻意不用"配置解析器",因为不同解析器/版本对
       DTD 的默认行为不一样,扫字节才是**与解析器无关**的那道闸。
    ③ 拒 UTF-16/UTF-32 —— 扫字节那道闸对宽字符编码是瞎的,与其留个静默绕过,不如直接拒。
    ④ SHA-256 报告 + **写前重算比对** —— 防 TOCTOU:你预览的是 A,写进去的是 B。
    ⑤ 默认**只读预览** —— 防"看一眼就写"。
    ⑥ 音符数上限(默认 512)—— 防把整部交响乐硬吞进工程。
    ⑦ 复调/和弦默认拒 —— 单声部混着多声部会算错音位(详见 parse_part 的注释)。
    ⑧ 写必须 `--confirm-rights` —— 合规前提:你得**有权使用**这份乐谱。
    ⑨ 源 tempo 只汇报、绝不套用 —— 改速度是用户的决定(参考项目 SV-006 的裁定)。

用法:
    python import-musicxml.py --selftest                       # 自检(造谱 → 解析 → 逐条断言)
    python import-musicxml.py "C:\\谱\\song.musicxml"            # 只读预览(默认)
    python import-musicxml.py "C:\\谱\\song.musicxml" --part 2
    python import-musicxml.py "C:\\谱\\song.musicxml" --json     # 只出 JSON
    python import-musicxml.py "C:\\谱\\song.musicxml" --write --confirm-rights   # 出可写参数
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import unicodedata
import xml.etree.ElementTree as ET

# ---------------------------------------------------------------- 常量
HERE = os.path.dirname(os.path.abspath(__file__))

#: 一个四分音符的 blick 数(SV.QUARTER)。只用于换算"1 拍 = 0.5 秒"这类提示,
#: 以及让读者一眼看到两边口径一致 —— 本工具的输入输出**都不用 blick**。
QUARTER_BLICK = 705600000

#: 音符数上限(与参考项目 NOTE_CAP 同值)。为什么是 512:
#: 桥的 write_notes 是"整批先校验再动手",一次几千个音会让宿主卡顿;
#: 而且写错一次就要用户手动撤销 ⇒ 宁可按声部/乐章拆开导。
MAX_NOTES = 512

#: 预览里最多列几个音(有界预览)。
PREVIEW_CAP = 20

#: 允许的扩展名(小写比较)。
ALLOWED_EXT = (".xml", ".musicxml")

#: 明显不是谱子的扩展名 —— 单独给话术,免得用户以为是"格式不支持"。
PROJECT_EXT = (".svp", ".ixp", ".svip")

#: 安全扫描只看文件头这么多字节。prolog 里的 DTD 一定在前几百字节内;
#: 取 8KB 是给"注释很长 + 编码声明 + 一堆 xmlns"的导出留余量。
SAFETY_SCAN_BYTES = 8192

#: 文件大小上限(32MB)。乐谱(含压缩过的 .mxl 解出来的)也就几百 KB,
#: 超过这个量级说明拿错文件了 —— 读进来只会白占内存。
MAX_FILE_BYTES = 32 * 1024 * 1024

#: 桥的 write_notes 硬性下限(拍):短于这个值桥会整批拒。
MIN_QUARTER = 0.125

#: Windows 保留设备名。`C:\\x\\NUL.xml` 这种路径在某些 API 下会指向设备而不是文件,
#: 读出来是空/异常 —— 直接拒掉,不给"读到奇怪东西"留机会。
_RESERVED_NAMES = {
    "CON", "PRN", "AUX", "NUL",
    *("COM%d" % i for i in range(1, 10)),
    *("LPT%d" % i for i in range(1, 10)),
}

#: 形如 `scheme://` 的前缀(含 file://、http://、ftp://…)。
_URL_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.\-]*://")

#: 音级 → 半音偏移(C=0 D=2 E=4 F=5 G=7 A=9 B=11)。
_STEP_PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}

#: 单声部旋律的合理音域(C-1=0 ~ G9=127 是 MIDI 全域)。
_MIDI_MIN, _MIDI_MAX = 0, 127

#: 音高列表最多回报几条(避免畸形谱子刷屏)。
_SAMPLE_CAP = 8


# ================================================================ 小工具
def _warn(bucket: list, msg: str) -> None:
    """往 warnings 里加一条(**去重**)—— 同一个毛病只报一次,免得刷屏。"""
    if msg not in bucket:
        bucket.append(msg)


def _local(tag) -> str:
    """去掉 XML 命名空间前缀。

    为什么要去:`{http://www.musicxml.org/ns/musicxml}note` 和 `note` 是同一个元素,
    但字符串比较不相等。ElementTree 会把 xmlns 塞进 tag 里,不去掉就一个都匹配不上。
    """
    if not isinstance(tag, str):
        return ""
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _text(el) -> str:
    """元素的全部文本(含子元素文本),去掉首尾空白。"""
    if el is None:
        return ""
    return "".join(el.itertext()).strip()


def _as_int(raw, default=None):
    """把字符串转 int;转不了就返回 default(**不抛异常**,解析器不该为脏数据崩)。"""
    if raw is None:
        return default
    try:
        return int(str(raw).strip())
    except (TypeError, ValueError):
        return default


def _as_float(raw, default=None):
    if raw is None:
        return default
    try:
        return float(str(raw).strip())
    except (TypeError, ValueError):
        return default


def _clean_lyric(raw: str) -> str:
    """歌词清洗:去掉首尾空白 + 零宽字符,再 NFC 归一。

    为什么要 NFC:macOS 导出的谱子常是 NFD("á" = a + 组合重音),直接写进 SV2
    会变成两个字符,声库找不到对应音素。归一化在工具侧做掉最省事。
    为什么去零宽字符:它们**看不见但会占一个字符位**,写进工程后极难排查。
    """
    if not raw:
        return ""
    s = raw.strip()
    s = s.replace("\u200b", "").replace("\u200c", "").replace("\u200d", "").replace("\ufeff", "")
    return unicodedata.normalize("NFC", s)


def _round_q(v: float, nd: int = 6) -> float:
    """拍数取整到 1e-6。

    为什么取整:`<duration>3</duration>` / divisions=7 会得到 0.42857142857142855,
    这种尾巴进了 JSON 既难看又会让"指纹/去重"比较出假差异。
    """
    return round(float(v), nd)


# ================================================================ 护栏 ① 路径
def guard_path(raw) -> tuple[bool, str, str]:
    """① 路径护栏:只收**绝对路径的本地普通文件**。

    挡住的东西(每一条都是真实攻击面):
      · `http(s)://` / `file://` 等 URL —— 否则本工具成了"任意 URL 抓取器"
        (SSRF / 内网探测),而"网上搜得到"的谱子往往也没有使用权。
      · **相对路径** —— 它会随调用方的工作目录漂移:同一句命令在不同 cwd 下
        读到的是不同文件,预览和写入可能不是同一份。绝对路径没有这个歧义。
      · `.svp` / `.ixp` —— 那是 **SV2/IX 工程文件**,不是乐谱。把工程当谱子解析,
        轻则报错,重则误导用户以为"导入成功"。
      · 其他扩展名 —— 白名单外一律拒,不做"猜格式"。
      · Windows 保留设备名(`NUL.xml` 之类)—— 那些路径在部分 API 下不是文件。
      · 目录 / 符号链接 / 非普通文件 —— 符号链接是 **TOCTOU 的经典入口**:
        你预览的是链接指向的 A,写之前有人把链接换成 B,哈希校验也会跟着读到 B。

    返回 (ok, 规范化后的路径, 错误信息)。
    """
    if raw is None or not isinstance(raw, str) or raw.strip() == "":
        return False, "", "必须给乐谱文件路径(绝对路径)"
    p = raw.strip().strip('"')          # 顺手容忍用户从资源管理器复制来的引号

    # URL / 协议前缀 —— 一律拒
    m = _URL_RE.match(p)
    if m:
        return False, "", (
            f"拒绝 URL:`{m.group(0)}` 不是本地文件路径。"
            "先把乐谱下载到本地,再用绝对路径传入(例:C:\\scores\\song.musicxml)"
        )

    # 扩展名白名单
    ext = os.path.splitext(p)[1].lower()
    if ext in PROJECT_EXT:
        return False, "", (
            f"这是**工程文件**(`{ext}`),不是乐谱。读/改工程请走工程路线,本工具只做乐谱导入。"
        )
    if ext not in ALLOWED_EXT:
        return False, "", (
            f"只接受 .xml / .musicxml 乐谱(收到 `{ext or '(无扩展名)'}`)"
        )

    # 绝对性:Windows 盘符 / UNC / POSIX 根。**必须在 isfile 之前判**,
    # 因为相对路径也可能恰好存在,那样就"悄悄读到了别的文件"。
    is_abs = bool(re.match(r"^[a-zA-Z]:[\\/]", p)) or p.startswith("\\\\") or p.startswith("/")
    if not is_abs:
        return False, "", (
            "必须是**绝对路径**(相对路径会随调用方的工作目录漂移,预览与写入可能不是同一份文件)。"
            "例:C:\\Users\\me\\scores\\song.musicxml"
        )

    # 保留设备名
    base = os.path.basename(p)
    stem = os.path.splitext(base)[0].upper()
    if stem in _RESERVED_NAMES:
        return False, "", f"`{base}` 是 Windows 保留设备名,不是普通文件"

    if not os.path.exists(p):
        return False, "", f"文件不存在或读不到:{p}"
    if os.path.islink(p):
        return False, "", (
            "拒绝**符号链接**(预览与写入之间链接可能被换掉 ⇒ 哈希校验会跟着指向别的文件)。"
            "请传真实路径。"
        )
    if os.path.isdir(p):
        return False, "", f"这是一个目录,不是文件:{p}"
    if not os.path.isfile(p):
        return False, "", f"不是普通文件:{p}"

    # 规范化(去掉 `..`、统一分隔符)。realpath 会把链接解开,所以放在 islink 检查**之后**。
    return True, os.path.realpath(p), ""


def guard_size(path: str) -> tuple[bool, int, str]:
    """① 顺带:文件大小体检(空文件 / 超大文件)。"""
    try:
        size = os.path.getsize(path)
    except OSError as e:
        return False, 0, f"读不到文件大小:{e}"
    if size == 0:
        return False, 0, "文件是空的(0 字节)"
    if size > MAX_FILE_BYTES:
        return False, size, (
            f"文件过大({size / 1048576:.1f} MB > {MAX_FILE_BYTES // 1048576} MB 上限)"
        )
    return True, size, ""


def read_raw(path: str) -> bytes:
    with open(path, "rb") as f:
        return f.read()


def sha256_of_bytes(buf: bytes) -> str:
    return hashlib.sha256(buf).hexdigest()


# ================================================================ 护栏 ②③ XML 安全面
def scan_xml_safety(raw: bytes) -> tuple[bool, str]:
    """②③ 解析**之前**,按**原始字节**拒掉危险构造。

    为什么是扫字节而不是"配置解析器":
      · 不同解析器、不同版本对 DTD 的默认行为**不一样**(有的默认展开实体,有的不);
        依赖"某个版本恰好安全"是脆的。扫字节是**与解析器无关**的一道闸。
      · 我们还要在**解析之前**就拒绝 —— 一旦交给解析器,billion-laughs 的膨胀
        已经在解析器内部发生了(内存/CPU 已经被吃),再拦就晚了。

    挡住的攻击:
      · `<!DOCTYPE ... SYSTEM "http://evil/x.dtd">` ⇒ **XXE**:解析器去抓外部 DTD,
        本地文件内容可能被读进文档(SSRF / 任意文件读取)。
      · `<!ENTITY lol "lol">` 嵌套 10 层 ⇒ **billion-laughs**:几个字节的输入
        膨胀成 GB 级文本,进程 OOM。
      · 参数实体 / 外部实体同理,`<!ENTITY` 一出现就够可疑了。

    为什么拒 UTF-16/32:上面是**按 ASCII 字节**匹配的,而 UTF-16 里
    `<!DOCTYPE` 是 `<\x00!\x00D\x00…`,字节匹配**看不见它** ——
    与其留一个静默绕过(编码变了护栏就失效),不如直接说"不支持这种编码,请存成 UTF-8"。
    """
    if not raw:
        return False, "文件内容为空"

    # BOM 检测:UTF-16/32 的 BOM 一定在头几个字节
    for bom, name in ((b"\xff\xfe\x00\x00", "UTF-32LE"), (b"\x00\x00\xfe\xff", "UTF-32BE"),
                      (b"\xff\xfe", "UTF-16LE"), (b"\xfe\xff", "UTF-16BE")):
        if raw.startswith(bom):
            return False, (
                f"拒绝 {name} 编码的 XML:按字节扫描 DOCTYPE/ENTITY 的护栏对宽字符编码**无效**"
                "(会变成静默绕过)。请用 UTF-8 重新导出。"
            )

    head = raw[:SAFETY_SCAN_BYTES]

    # 无 BOM 的 UTF-16:ASCII 文本里会出现 NUL 字节(每字符一个 0x00)。
    # 正常 UTF-8 的 XML prolog 区**不该有 NUL** ⇒ 见到就按编码异常处理。
    if b"\x00" in head:
        return False, (
            "文件头含 NUL 字节(疑似 UTF-16/UTF-32 或二进制文件):"
            "本工具只接受 UTF-8 的 XML 文本。"
        )

    up = head.upper()
    found = []
    if b"<!DOCTYPE" in up:
        found.append("`<!DOCTYPE>`")
    if b"<!ENTITY" in up:
        found.append("`<!ENTITY>`")
    if found:
        return False, (
            f"拒绝含 {' / '.join(found)} 的 MusicXML(外部实体注入 XXE / 实体炸弹 billion-laughs 面)。"
            "用 MuseScore 导出时选「不压缩的 MusicXML(.musicxml)」,"
            "或把 prolog 里的 DTD/实体声明删掉再导。"
        )
    return True, ""


# ================================================================ 护栏 ④ 指纹
def file_fingerprint(path: str) -> dict:
    """④ SHA-256 指纹(哈希 + 字节数)。

    为什么必须报出来、而且**写前再算一次**:
      预览和写入是两次独立的操作,中间隔着人的阅读时间。文件可能被改过
      (你自己又导了一版、编辑器自动保存、云盘同步回滚)。只凭路径写,
      就会出现"我预览的是 A,写进去的是 B" —— 这是典型的 TOCTOU。
      哈希是唯一能把"我确认过的那一份"和"正在写的那一份"绑起来的证据。
    """
    buf = read_raw(path)
    return {"sha256": sha256_of_bytes(buf), "bytes": len(buf)}


# ================================================================ 护栏 ⑥⑦ 计数与复调
def check_note_cap(count: int, cap: int) -> tuple[bool, str]:
    """⑥ 音符数上限。超过就**拒**,不硬吞进工程。"""
    if count > cap:
        return False, (
            f"{count} 个音符超过上限 {cap} ⇒ 拒绝导入(不硬吞进工程)。"
            "按声部/乐章拆成多个文件分别导入,或用 `--part N` 只取一个声部,"
            "或显式 `--max-notes N` 提高上限(自担风险:桥是整批校验,一次几千音会卡宿主)。"
        )
    return True, ""


def detect_polyphony(notes: list) -> dict:
    """⑦ 复调/和弦体检。

    为什么要体检:本解析器(以及参考项目的解析器)是**按顺序在一条时间线上累加 onset** 的。
    多声部混在一条线上,两个声部的时值会互相叠加 ⇒ 后面所有音的位置整体漂移,
    而且**不会报错** —— 用户只会觉得"导进来的谱子全错位了",极难查。

    判据(两条都算"不是单声部 lane"):
      · 出现多于一个 `<voice>`
      · 同一个 onset 上有多个音(和弦)
    """
    by_onset: dict = {}
    voices = set()
    for n in notes:
        if n["rest"] or n["pitch"] < 0:
            continue                      # 休止符不参与复调统计
        if n["voice"] is not None:
            voices.add(n["voice"])
        key = round(n["onset"], 3)        # 量化到 ms 再比,免得浮点尾巴造出假"同时"
        by_onset.setdefault(key, []).append(n["pitch"])

    max_stack, chord_onsets, samples = 0, 0, []
    for onset in sorted(by_onset):
        uniq = sorted(set(by_onset[onset]))
        if len(uniq) > 1:
            chord_onsets += 1
            if len(samples) < 3:
                samples.append({"onset": onset, "pitches": uniq})
        max_stack = max(max_stack, len(uniq))
    return {
        "maxStack": max_stack,
        "chordOnsets": chord_onsets,
        "voices": sorted(voices),
        "samples": samples,
    }


def is_polyphonic(rep: dict) -> bool:
    return len(rep["voices"]) > 1 or rep["chordOnsets"] > 0


# ================================================================ 解析
def _pitch_to_midi(step: str, alter: int, octave: int):
    """`<step>/<alter>/<octave>` → MIDI。返回 (midi, 错误信息);midi=-1 表示不可用。"""
    s = (step or "").strip().upper()
    if s not in _STEP_PC:
        return -1, f"不认识的音级 `{step}`"
    if octave is None:
        return -1, "`<pitch>` 缺 `<octave>`"
    pc = _STEP_PC[s] + (alter or 0)
    midi = 12 * (octave + 1) + pc
    if midi < _MIDI_MIN or midi > _MIDI_MAX:
        return -1, f"音高越界:{s}{alter:+d}/{octave} ⇒ MIDI {midi}(超出 0..127)"
    return midi, ""


def _read_tie(note_el) -> set:
    """读延音线标记 → {"start"} / {"stop"} / {"start","stop"} / 空集。

    为什么要同时看 `<tie>` 和 `<notations><tied>`:
      MusicXML 里这是**两个冗余的字段** —— `<tie>` 是"声音上的连接"
      (播放器用),`<notations><tied>` 是"谱面上的弧线"(排版用)。
      有的导出只写一个(自检里就见过),只看 `<tie>` 会漏掉一半的连音线。
    """
    kinds = set()
    for child in note_el:
        name = _local(child.tag)
        if name not in ("tie", "tied"):
            continue
        t = (child.get("type") or "").strip().lower()
        if t in ("start", "stop", "continue"):
            kinds.add(t)
    # `<tied type="continue">` 语义上同时是 stop 与 start ⇒ 展开
    if "continue" in kinds:
        kinds.discard("continue")
        kinds.update(("start", "stop"))
    return kinds


def _read_lyric(note_el) -> str:
    """取第一个 `<lyric>` 的 `<text>`。

    为什么取第一个:一个音符可能挂多段歌词(number=1/2/…),但 SV2 的一个音符
    **只有一条歌词串** ⇒ 只取第一段(常见做法)。多段歌词本身也会进 warnings。
    """
    for child in note_el:
        if _local(child.tag) != "lyric":
            continue
        for sub in child:
            if _local(sub.tag) == "text":
                return _clean_lyric(_text(sub))
        return ""                          # 有 <lyric> 但没有 <text>(如纯 elision)
    return ""


def parse_part(part_el, part_name: str, part_id: str, warnings: list) -> dict:
    """解析一个 `<part>` → 音符数组 + 属性。

    ⚠️ **这里最容易错的三件事,都显式处理了**:

    ① `<backup>` / `<forward>` 移动游标
       多声部谱子里,声部 1 写完一个小节后会 `<backup>` 回到小节开头,再写声部 2。
       不处理 backup ⇒ 声部 2 的音会从"声部 1 结束处"开始 ⇒ **后面所有音整体右移**。
       `<forward>` 是"往前走但不发声音"(补空拍),同样必须推进游标。
       ⇒ 本实现用**两套位置**:
            · `cursor`      —— 当前插入点,被 `<backup>`/`<forward>` 改写
            · `voice_next`  —— **每个声部各自的下一个位置**,只被该声部自己的音推进
          一个音落在哪里:该声部已经有位置就用它,否则用 `cursor`。
          这样无论声部在 XML 里怎么交错,每个声部的音位都对。
       ⚠️ 一个踩过的坑(自检抓出来的):`<backup>`/`<forward>` **不能**清掉 `voice_next`。
          清了的话,"voice 1 写 3 拍 → backup → voice 2 写 → forward"之后,
          voice 1 的下一个音会从 `cursor`(= backup 之后的位置)重新起算 ⇒ **音位左移**。

    ② `<chord/>` = 与**前一个音同起点**
       和弦音出现在前一个音的后面,时值相同、起点相同 ⇒ 用"该声部上一个音的 onset",
       而且**不推进游标**。

    ③ `<tie type="stop">` = 前面那个音的**延续**,不是新音
       必须**延长前一个音**,而不是新建一个。否则一个两拍的长音会变成两个音,
       用户听到的是"断了一下",而谱面看起来完全正常。
    """
    divisions = 1                    # 每个四分音符有多少个 divisions(遇 <attributes> 更新)
    key_fifths = None
    time_sig = None
    tempo = None
    tempo_pos = None
    notes: list = []
    # `cursor` = 当前插入点(被 backup/forward 改写);
    # `voice_next` = 每个声部**各自**的下一个位置(只被该声部自己的音推进)。
    # 两者分开,是为了让 `<backup>` 只影响"接下来没标声部/新声部的音从哪儿开始",
    # 而不会把已经写了一半的声部拉回去。
    cursor = 0.0
    voice_next: dict = {}
    measure_offset = 0.0             # 本小节起点在整曲里的绝对位置(拍)
    divisions_changes = 0
    lyric_multi = 0

    for measure_el in part_el:
        if _local(measure_el.tag) != "measure":
            continue

        # ⚠️ **游标是"相对小节起点"的** —— 这是 MusicXML 的语义。
        #    所以每个小节开头:① 相对游标归零 ② 声部记录清空 ③ `measure_offset`
        #    已经是"本小节起点在整曲里的绝对位置"(上一小节末尾推进来的)。
        #    三个都要做,少一个就错:
        #      · 不归零 ⇒ 小节越来越长(第 2 小节从第 3 拍开始);
        #      · 不清 voice_next ⇒ 上一小节某声部的位置会串到本小节别的声部上;
        #      · 不累加 offset ⇒ **所有小节都塌回第 0 拍**(自检抓出来的正是这条)。
        cursor = 0.0
        voice_next.clear()
        measure_end = measure_offset     # 本小节走到的**绝对**最远处(决定下一小节的起点)

        # ---- attributes:divisions / key / time ----
        for attr in measure_el:
            if _local(attr.tag) != "attributes":
                continue
            for a in attr:
                name = _local(a.tag)
                if name == "divisions":
                    d = _as_int(_text(a))
                    if d is None or d <= 0:
                        _warn(warnings, f"`<divisions>` 非法({_text(a)!r})⇒ 沿用 {divisions}")
                    elif d != divisions:
                        divisions_changes += 1
                        divisions = d
                elif name == "key":
                    for k in a:
                        if _local(k.tag) == "fifths":
                            key_fifths = _as_int(_text(k), key_fifths)
                elif name == "time":
                    beats = beat_type = None
                    for t in a:
                        if _local(t.tag) == "beats":
                            beats = _text(t)
                        elif _local(t.tag) == "beat-type":
                            beat_type = _text(t)
                    if beats and beat_type:
                        time_sig = f"{beats}/{beat_type}"
                    else:
                        # 复合拍号(beats 里含 "+")或没写全 ⇒ 如实回报,不猜
                        _warn(warnings, "拍号缺 beats/beat-type(或为复合拍号)⇒ 未记录拍号")

        # ---- 速度标记:<direction><sound tempo="N"/> ----
        # ⚠️ 只**读**。改工程速度是用户的决定(参考项目 SV-006),本工具绝不写 tempo 标记。
        for d in measure_el:
            if _local(d.tag) != "direction":
                continue
            for s in d:
                if _local(s.tag) == "sound" and s.get("tempo") is not None:
                    t = _as_float(s.get("tempo"))
                    if t and t > 0:
                        if tempo is None:
                            tempo = t
                            tempo_pos = _round_q(measure_offset + cursor)
                        elif abs(t - tempo) > 1e-9:
                            _warn(warnings, f"谱中有多个速度标记(首个 {tempo:g},还有 {t:g})"
                                            "⇒ 只汇报首个;要变速请显式用 set_tempo / apply_tempo")

        # ---- 音符序列 ----
        for el in measure_el:
            tag = _local(el.tag)

            if tag == "backup":
                ticks = _as_int(_text(el), 0) or 0
                delta = ticks / divisions
                if ticks < 0:
                    _warn(warnings, f"`<backup>` 时值为负({ticks})⇒ 已按 0 处理")
                    delta = 0.0
                if delta > cursor + 1e-9:
                    # 回退超过了"已经走过的量" ⇒ 游标会跑到小节起点之前。
                    # 这通常意味着谱子有错(或 divisions 中途变了),如实报出来。
                    _warn(warnings, f"`<backup>` 回退 {delta:g} 拍超过了本小节已走的 "
                                    f"{cursor:g} 拍 ⇒ 游标夹到小节起点")
                cursor = max(0.0, cursor - delta)
                # ⚠️ 这里**不清 voice_next**:各声部已经写到哪儿,跟"当前插入点回退"
                #    是两件事。清了就会让"写一半的声部"的音位左移(自检抓出来的)。
                continue

            if tag == "forward":
                ticks = _as_int(_text(el), 0) or 0
                delta = ticks / divisions
                if delta < 0:
                    _warn(warnings, f"`<forward>` 时值为负({ticks})⇒ 已按 0 处理")
                    delta = 0.0
                cursor += delta
                continue

            if tag != "note":
                continue

            is_rest = any(_local(c.tag) == "rest" for c in el)
            is_chord = any(_local(c.tag) == "chord" for c in el)
            voice = None
            pitch = -1
            dur_ticks = 0
            for c in el:
                cn = _local(c.tag)
                if cn == "voice":
                    voice = _as_int(_text(c), None)
                elif cn == "duration":
                    dur_ticks = _as_int(_text(c), 0) or 0
                elif cn == "pitch":
                    step, alter, octave = "", 0, None
                    for p in c:
                        pn = _local(p.tag)
                        if pn == "step":
                            step = _text(p)
                        elif pn == "alter":
                            alter = _as_int(_text(p), 0) or 0
                        elif pn == "octave":
                            octave = _as_int(_text(p), None)
                    pitch, err = _pitch_to_midi(step, alter, octave)
                    if err:
                        _warn(warnings, f"第 {len(notes) + 1} 个音符:{err} ⇒ 已跳过")

            dur = dur_ticks / divisions
            if dur_ticks < 0:
                _warn(warnings, f"`<duration>` 为负({dur_ticks})⇒ 已按 0 处理")
                dur = 0.0
            if dur_ticks == 0 and not is_chord:
                # duration 是必填字段。没有它就只能猜时值 —— 而"猜"会让后面全错位。
                # 这里按 0 处理并**大声报出来**,而不是静默挪动时间轴。
                _warn(warnings, "有音符缺 `<duration>`(或为 0)⇒ 该音时值按 0 处理,"
                                "其后音位可能不准,请检查源文件")

            lyrics = _read_lyric(el)
            if sum(1 for c in el if _local(c.tag) == "lyric") > 1:
                lyric_multi += 1

            # ---- onset:该声部已经有位置就接着写,否则从当前插入点起 ----
            # ⚠️ `cur` 是**小节内相对**位置,加 `measure_offset` 才是整曲绝对位置。
            cur = voice_next.get(voice, cursor)
            if is_chord:
                prev = notes[-1] if notes else None
                if prev is None or prev["voice"] != voice:
                    _warn(warnings, "有 `<chord/>` 前面没有同声部的音 ⇒ 已当普通音处理")
                    onset = cur
                else:
                    # 和弦音与**前一个音**同起点。用前一个音的相对位置(去掉 offset),
                    # 这样"和弦音落在哪一小节"完全跟着它的根音走。
                    onset = prev["onset"] - measure_offset
            else:
                onset = cur

            tie = _read_tie(el)
            absolute = measure_offset + onset      # 整曲绝对位置(拍)
            note = {
                "pitch": pitch,
                "onset": _round_q(absolute),
                "duration": _round_q(dur),
                "voice": voice,
                "lyrics": lyrics,
                "rest": bool(is_rest),
                "tie_start": "start" in tie,
                "tie_stop": "stop" in tie,
            }
            notes.append(note)

            # ---- 位置推进(和弦音不推进) ----
            if not is_chord:
                end = onset + dur                      # 小节内相对结束位置
                voice_next[voice] = end                # 该声部自己的下一个位置(仅本小节内有效)
                cursor = max(cursor, end)              # 插入点至少走到这里(不后退)
                measure_end = max(measure_end, measure_offset + end)

        # 小节结束:下一小节的起点 = 本小节走到的绝对最远处。
        # 用"最远处"而不是"某个声部的长度":多声部时各声部长度可能不同,
        # 取最大值才不会让下一小节跟前面重叠。
        measure_offset = measure_end

    # ---- 延音线合并:`<tie type="stop">` 必须**延长**前一个音,而不是新建 ----
    merged: list = []
    for n in notes:
        if n["rest"] or n["pitch"] < 0:
            merged.append(n)
            continue
        if n["tie_stop"]:
            target = None
            for m in reversed(merged):    # 往前找最近的、同声部同音高、还没闭合的 start
                if m["rest"] or m["pitch"] < 0:
                    continue
                if m["pitch"] == n["pitch"] and m["voice"] == n["voice"] and m["tie_start"]:
                    target = m
                    break
            if target is not None:
                gap = n["onset"] - (target["onset"] + target["duration"])
                if gap > 1e-6:
                    # 中间有空隙 ⇒ 严格说不是同一条延音线。仍然合并(用户意图明显),
                    # 但把空隙如实报出来 —— 因为"合了会缩短/拉长总时值"。
                    _warn(warnings, f"延音线中间有空隙 {gap:g} 拍(第 "
                                    f"{target['onset']:g} 拍起)⇒ 已合并,请核对")
                target["duration"] = _round_q(n["onset"] + n["duration"] - target["onset"])
                if n["tie_start"]:
                    target["tie_start"] = True     # 三段以上的长音:a→b→c
                if not target["lyrics"] and n["lyrics"]:
                    target["lyrics"] = n["lyrics"]  # 歌词常只写在延音线的第一段
                continue                            # 不新增音符 —— 这就是"延长"
            _warn(warnings, f"第 {n['onset']:g} 拍有一个 `<tie type=\"stop\">` 找不到对应的起点"
                            "⇒ 已按独立音符处理(请核对源文件)")

        merged.append(n)

    if divisions_changes > 1:
        _warn(warnings, f"谱中 `<divisions>` 变了 {divisions_changes} 次(中途换过基准)"
                        "⇒ 已按各自小节换算,但请核对时值")
    if lyric_multi:
        _warn(warnings, f"有 {lyric_multi} 个音符带多段歌词(number>1)⇒ 只取了第一段")

    # 清掉内部标记,不泄漏到输出
    for n in merged:
        n.pop("tie_start", None)
        n.pop("tie_stop", None)

    merged.sort(key=lambda n: (n["onset"], n["pitch"]))
    return {
        "id": part_id,
        "name": part_name,
        "notes": merged,
        "keyFifths": key_fifths,
        "beatsPerMeasure": time_sig,
        "tempo": tempo,
        "tempoOnset": tempo_pos,
    }


def _key_name(fifths) -> str:
    """调号五度数 → 人话。只做展示,不参与任何计算。"""
    if fifths is None:
        return ""
    names = {0: "C", 1: "G", 2: "D", 3: "A", 4: "E", 5: "B", 6: "F#", 7: "C#",
             -1: "F", -2: "Bb", -3: "Eb", -4: "Ab", -5: "Db", -6: "Gb", -7: "Cb"}
    return names.get(int(fifths), f"fifths={fifths}")


def parse_score(raw: bytes) -> tuple[bool, object, str]:
    """解析整份谱子 → (ok, 结果, 错误信息)。

    ⚠️ 用标准库 `xml.etree.ElementTree`,**不引入新依赖**。
    安全性不靠它:DOCTYPE/ENTITY 已经在 `scan_xml_safety` 里按字节拒掉了,
    而且 ET 的默认解析器本来就不去抓外部 DTD、不做实体展开。
    两层叠起来才算数 —— 只靠解析器的默认行为是脆的(版本一变就可能不同)。
    """
    # 解析器对深嵌套/超大文档没有天然限制,显式提一点余量而不是无限放宽
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as e:
        return False, None, f"XML 解析失败:{e}"

    tag = _local(root.tag)
    if tag == "score-timewise":
        # timewise 是"按时间片组织"的另一种顶层形式。绝大多数导出都是 partwise,
        # 而 timewise 的解析路径完全不同 —— 与其写一条没验证过的分支,
        # 不如明确拒绝,让用户用 MuseScore 重新导出成 partwise。
        return False, None, (
            "`score-timewise` 暂不支持。请在 MuseScore 里导出时选"
            "「未压缩的 MusicXML(.musicxml)」—— 那默认是 `score-partwise`。"
        )
    if tag != "score-partwise":
        return False, None, f"不是 MusicXML 乐谱(根元素是 `<{tag}>`,期望 `<score-partwise>`)"

    # part-list:拿声部名(id → name)
    name_map: dict = {}
    for pl in root:
        if _local(pl.tag) != "part-list":
            continue
        for sp in pl:
            if _local(sp.tag) != "score-part":
                continue
            pid = sp.get("id") or ""
            nm = ""
            for c in sp:
                if _local(c.tag) == "part-name":
                    nm = _text(c)
                    break
            name_map[pid] = nm

    parts = []
    for part_el in root:
        if _local(part_el.tag) != "part":
            continue
        pid = part_el.get("id") or f"P{len(parts) + 1}"
        warnings: list = []
        p = parse_part(part_el, name_map.get(pid, ""), pid, warnings)
        p["warnings"] = warnings
        parts.append(p)

    if not parts:
        return False, None, "MusicXML 里没有 `<part>` 元素"

    warnings: list = []
    for p in parts:
        warnings.extend(p["warnings"])
    return True, {"parts": parts, "warnings": warnings}, ""


# ================================================================ 护栏 ⑤⑧⑨ 预览与写参
def build_note_payload(notes: list, fallback_lyrics: str = "") -> tuple[list, list]:
    """把解析出的音符整理成桥 `write_notes` 能直接吃的形态。

    ⚠️ 桥的 `write_notes` 约束(照抄 DSHBridge.lua 的整批校验):
      · `onset` / `duration` 单位 = **四分音符数**;`duration < 0.125` ⇒ 整批拒
      · `pitch` 必须是 **0..127 的整数**
      · `onset >= 0`
      · 同组内音符**不得重叠**(同 onset 不算重叠 —— 那是和弦)
    这里按同样的规则预检一遍,把问题**提前**说清楚,而不是等桥弹错误框。
    """
    out, problems = [], []
    for i, n in enumerate(notes, 1):
        if n["rest"] or n["pitch"] < 0:
            continue
        dur = max(MIN_QUARTER, _round_q(n["duration"]))   # 短于下限就抬到下限(见下方 problems)
        if n["duration"] < MIN_QUARTER - 1e-9:
            problems.append(f"第 {i} 个音(第 {n['onset']:g} 拍)时值 {n['duration']:g} 拍 "
                            f"< 桥的下限 {MIN_QUARTER} 拍 ⇒ 已抬到 {MIN_QUARTER} 拍")
        if not (_MIDI_MIN <= n["pitch"] <= _MIDI_MAX):
            problems.append(f"第 {i} 个音音高 {n['pitch']} 越界 ⇒ 已跳过")
            continue
        out.append({
            "onset": _round_q(max(0.0, n["onset"])),
            "duration": _round_q(dur),
            "pitch": int(n["pitch"]),
            "lyrics": n["lyrics"] or fallback_lyrics or "",
        })

    # 重叠检查。⚠️ 口径必须与桥**逐字一致**:桥的 write_notes 判据是
    # `end > next.onset`(带 1e-9 容差),而**同 onset 不算重叠** —— 那是和弦/齐奏。
    # 若这里把同 onset 也报成重叠,就会对着一个桥明明能接受的和弦喊"会被拒"。
    ordered = sorted(out, key=lambda x: (x["onset"], x["pitch"]))
    for a, b in zip(ordered, ordered[1:]):
        if abs(a["onset"] - b["onset"]) <= 1e-9:
            continue                                  # 同起点 ⇒ 和弦,不是重叠
        end = a["onset"] + a["duration"]
        if end > b["onset"] + 1e-9:
            problems.append(
                f"重叠:第 {a['onset']:g} 拍起、时值 {a['duration']:g} 拍的音"
                f"(音高 {a['pitch']})与第 {b['onset']:g} 拍起的音(音高 {b['pitch']})重叠 "
                f"⇒ 桥会整批拒写"
            )
    return out, problems


def build_write_args(payload: list, group_name: str, track_index) -> dict:
    """`write_notes_args` —— 可以直接喂给 `sv_call(op="write_notes", args=…)` 的那块。

    ⚠️ 少一样东西:桥的写操作要先 `sv_notes` 拿指纹 `expectFp` 再写。
    那是**调用方(agent)**的步骤,本工具在宿主之外,拿不到也不该伪造 ⇒ 这里不填,
    并在 `note` 里写清楚。别把这块原样当成"已经可以写"的证据。
    """
    return {
        "notes": payload,
        "groupName": group_name,
        "trackIndex": track_index,
        "_note": ("交给桥时用 sv_call(op=\"write_notes\", args=write_notes_args);"
                  "写前必须先 sv_notes 取 fp 并原样回传 expectFp(桥的指纹纪律)。"
                  "onset/duration 单位 = 四分音符数(不是 blick)。"),
    }


def build_report(path: str, fp: dict, score: dict, part_index: int, payload: list,
                 poly: dict, problems: list, warnings: list, group_name: str,
                 track_index, cap: int, voice_no=None) -> dict:
    """汇总报告(预览与写共用同一份结构)。"""
    parts = score["parts"]
    chosen = parts[part_index]
    all_notes = [n for n in chosen["notes"] if not n["rest"] and n["pitch"] >= 0]
    with_lyrics = sum(1 for n in payload if n["lyrics"])

    return {
        "ok": True,
        "dryRun": True,
        "input": path,
        "sha256": fp["sha256"],
        "bytes": fp["bytes"],
        "parts": [
            {
                "index": i + 1,
                "id": p["id"],
                "name": p["name"],
                "noteCount": sum(1 for n in p["notes"] if not n["rest"] and n["pitch"] >= 0),
                "restCount": sum(1 for n in p["notes"] if n["rest"]),
                "voiceCount": len({n["voice"] for n in p["notes"]
                                   if not n["rest"] and n["voice"] is not None}),
            }
            for i, p in enumerate(parts)
        ],
        "selectedPart": {
            "index": part_index + 1,
            "id": chosen["id"],
            "name": chosen["name"],
            "noteCount": len(all_notes),
            "voices": sorted({n["voice"] for n in chosen["notes"]
                              if not n["rest"] and n["voice"] is not None}),
        },
        "voiceFilter": voice_no,
        "source": {
            "tempo": chosen["tempo"],
            "tempoOnsetQuarter": chosen["tempoOnset"],
            # ⑨ 只汇报、不套用。改工程速度是用户的决定(参考项目 SV-006),
            #    真要用速度请显式走桥的 set_tempo / apply_tempo。
            "tempoApplied": False,
            "tempoNote": "源 tempo 只汇报,本工具**不会**改工程速度;要套用请显式调 set_tempo/apply_tempo",
            "keyFifths": chosen["keyFifths"],
            "keyName": _key_name(chosen["keyFifths"]),
            "timeSignature": chosen["beatsPerMeasure"],
        },
        "counts": {
            "notes": len(payload),
            "withLyrics": with_lyrics,
            "maxNotes": cap,
            "polyphony": poly,
        },
        "warnings": warnings,
        "problems": problems,
        "preview": payload[:PREVIEW_CAP],
        "previewTruncated": len(payload) > PREVIEW_CAP,
        "write_notes_args": build_write_args(payload, group_name, track_index),
    }


# ================================================================ 主流程
def run_import(input_path, part_no=None, group_name="MusicXML Import", track_index=0,
               cap=MAX_NOTES, allow_polyphony=False, expect_sha256=None,
               fallback_lyrics="", json_only=False, voice_no=None) -> dict:
    """护栏 → 解析 → 体检 → 报告。**只读**:任何情况下都不碰 SV2。"""
    warnings: list = []
    problems: list = []

    # ① 路径
    ok, path, err = guard_path(input_path)
    if not ok:
        return {"ok": False, "guard": "path", "error": err}
    # ① 体量
    ok, size, err = guard_size(path)
    if not ok:
        return {"ok": False, "guard": "file", "error": err, "input": path}
    raw = read_raw(path)

    # ②③ XML 安全面(**解析之前**)
    ok, err = scan_xml_safety(raw)
    if not ok:
        return {"ok": False, "guard": "xml-safety", "error": err, "input": path}

    # ④ 指纹(预览用;写前会再算一次)
    fp = {"sha256": sha256_of_bytes(raw), "bytes": len(raw)}

    # 解析
    ok, score, err = parse_score(raw)
    if not ok:
        return {"ok": False, "guard": "parse", "error": err,
                "input": path, "sha256": fp["sha256"]}
    parts = score["parts"]

    # part 选择:显式给了就按 1 起下标取;没给就取**第一个有音符的**,并说明
    note_counts = [sum(1 for n in p["notes"] if not n["rest"] and n["pitch"] >= 0) for p in parts]
    if part_no is not None:
        if part_no < 1 or part_no > len(parts):
            return {"ok": False, "guard": "part",
                    "error": f"`--part {part_no}` 越界:这份谱子有 {len(parts)} 个声部",
                    "parts": [{"index": i + 1, "name": p["name"], "noteCount": note_counts[i]}
                              for i, p in enumerate(parts)],
                    "input": path, "sha256": fp["sha256"]}
        part_index = part_no - 1
        if note_counts[part_index] == 0:
            return {"ok": False, "guard": "part",
                    "error": f"`--part {part_no}`(`{parts[part_index]['name']}`)里没有音符",
                    "input": path, "sha256": fp["sha256"]}
    else:
        part_index = next((i for i, c in enumerate(note_counts) if c > 0), 0)
        if len(parts) > 1:
            _warn(warnings, f"谱中有 {len(parts)} 个声部,未指定 `--part` ⇒ "
                            f"已选第 {part_index + 1} 个(`{parts[part_index]['name']}`)"
                            f"(第一个有音符的);要别的请用 `--part N`")
    chosen = parts[part_index]

    # 把该 part 自己的 warnings 也带上(前面 parse 时已汇总,这里保证不漏)
    for w in chosen["warnings"]:
        _warn(warnings, w)

    # 声部过滤:多声部 part 里只想取某一条声部时用。
    # ⚠️ 必须在复调体检**之前**做 —— 否则"我只想要 voice 1"会先被
    #    "这个 part 有多个 voice" 拦下来,用户就没有出路了。
    part_notes = chosen["notes"]
    if voice_no is not None:
        filtered = [n for n in part_notes if n["voice"] == voice_no]
        if not filtered:
            return {"ok": False, "guard": "voice",
                    "error": f"`--voice {voice_no}` 在该声部里没有音符",
                    "availableVoices": sorted({n["voice"] for n in part_notes
                                               if n["voice"] is not None}),
                    "input": path, "sha256": fp["sha256"]}
        part_notes = filtered

    # ⑦ 复调体检(**在音符数上限之前**,这样报错信息更有用)
    poly = detect_polyphony(part_notes)
    if is_polyphonic(poly) and not allow_polyphony:
        return {
            "ok": False, "guard": "polyphony",
            "error": (f"该声部不是单声部旋律:声部 "
                      f"{('[' + ','.join(str(v) for v in poly['voices']) + ']') if poly['voices'] else '(未标 voice)'}"
                      f" · 同 onset 多音处 {poly['chordOnsets']} 个 · 最大同时音数 {poly['maxStack']}"),
            "hint": ("多声部/和弦混在一条时间线上会互相叠加时值 ⇒ 音位整体漂移。"
                     "换一个单声部 part(见 parts),或确要导就显式 `--allow-polyphony`"),
            "detail": poly,
            "parts": [{"index": i + 1, "name": p["name"], "noteCount": note_counts[i]}
                      for i, p in enumerate(parts)],
            "input": path, "sha256": fp["sha256"],
        }

    # ⑥ 音符数上限
    playable = sum(1 for n in part_notes if not n["rest"] and n["pitch"] >= 0)
    ok, err = check_note_cap(playable, cap)
    if not ok:
        return {"ok": False, "guard": "note-cap", "error": err,
                "input": path, "sha256": fp["sha256"],
                "parts": [{"index": i + 1, "name": p["name"], "noteCount": note_counts[i]}
                          for i, p in enumerate(parts)]}

    # 音符载荷 + 预检(重叠 / 下限 / 越界)
    payload, probs = build_note_payload(part_notes, fallback_lyrics)
    problems.extend(probs)
    if not payload:
        return {"ok": False, "guard": "empty", "error": "该声部解析后没有任何可用音符",
                "input": path, "sha256": fp["sha256"]}

    report = build_report(path, fp, score, part_index, payload, poly, problems,
                          warnings, group_name, track_index, cap, voice_no)
    report["sizeBytes"] = size
    if expect_sha256:
        report["expectedSha256"] = expect_sha256
    return report


def recheck_hash(path: str, preview_hash: str, expect_sha256=None) -> tuple[bool, str, str]:
    """④ **写前重算哈希**并与预览时的比对。

    为什么这一步不能省:预览与写入之间隔着人的阅读时间,文件可能被改过。
    只凭路径写,就会出现"我确认的是 A,写进去的是 B"(TOCTOU)。
    哈希是唯一能把两份绑定起来的证据。

    返回 (ok, 当前哈希, 错误信息)。
    """
    try:
        buf = read_raw(path)
    except OSError as e:
        return False, "", f"写前重读失败:{e}"
    now = sha256_of_bytes(buf)
    if now != preview_hash:
        return False, now, (
            f"文件在校验后发生了变化(预览 {preview_hash[:12]}… ≠ 现在 {now[:12]}…)⇒ 拒绝写。"
            "重新跑一次预览,确认内容无误再写。"
        )
    if expect_sha256 and now != expect_sha256.strip().lower():
        return False, now, (
            f"与 `--expect-sha256` 不符(现在 {now[:12]}… ≠ 你给的 "
            f"{expect_sha256.strip()[:12]}…)⇒ 拒绝写"
        )
    return True, now, ""


# ================================================================ 打印
def print_preview(rep: dict, stream=None) -> None:
    out = stream or sys.stdout
    print(f"文件      : {rep['input']}", file=out)
    print(f"SHA-256   : {rep['sha256']}   ({rep['bytes']} 字节)", file=out)
    print(f"声部清单  :", file=out)
    for p in rep["parts"]:
        mark = " ← 已选" if p["index"] == rep["selectedPart"]["index"] else ""
        print(f"    [{p['index']}] {p['name'] or '(无名)'}  "
              f"音符 {p['noteCount']} · 休止 {p['restCount']} · 声部数 {p['voiceCount']}{mark}", file=out)
    s = rep["source"]
    vf = rep.get("voiceFilter")
    print(f"源属性    : tempo={s['tempo'] if s['tempo'] is not None else '(谱中无)'} "
          f"key={s['keyName'] or '(无)'} time={s['timeSignature'] or '(无)'}"
          + (f"   voice 过滤={vf}" if vf is not None else ""), file=out)
    print(f"           ⚠️ {s['tempoNote']}", file=out)
    c = rep["counts"]
    print(f"计数      : 音符 {c['notes']} · 带歌词 {c['withLyrics']} · "
          f"上限 {c['maxNotes']} · 最大同时音数 {c['polyphony']['maxStack']}", file=out)
    if rep.get("warnings"):
        print("提醒      :", file=out)
        for w in rep["warnings"]:
            print(f"    · {w}", file=out)
    if rep.get("problems"):
        print("⚠️ 预检问题(桥可能会拒):", file=out)
        for w in rep["problems"]:
            print(f"    · {w}", file=out)
    print(f"音符预览(前 {len(rep['preview'])} 个"
          f"{',已截断' if rep['previewTruncated'] else ''};单位=四分音符):", file=out)
    print(f"    {'onset':>8} {'dur':>7} {'pitch':>5}  歌词", file=out)
    for n in rep["preview"]:
        print(f"    {n['onset']:>8g} {n['duration']:>7g} {n['pitch']:>5d}  {n['lyrics']}", file=out)
    print("write_notes_args 已生成(见 --json 输出的该字段)", file=out)


def print_json(rep: dict, stream=None) -> None:
    print(json.dumps(rep, ensure_ascii=False, indent=2), file=stream or sys.stdout)


# ================================================================ 自检
def selftest() -> int:
    """自检:造一份**故意刁钻**的谱子 → 解析 → **逐条断言**。

    为什么必须断言而不是"跑一遍没报错":
      解析器最容易犯的错都是**静默**的 —— 少算一个 backup、把延音线拆成两个音、
      和弦音推错了游标……这些都不会抛异常,只会让音符位置悄悄错掉。
      姊妹工具(`extract-notes.py` / `analyze-audio.py`)的自检各抓出两个真 bug,
      靠的就是"期望值写死、逐条比对"。
    """
    import tempfile

    results: list = []

    def check(name: str, cond, got=None, want=None) -> None:
        detail = ""
        if not cond and (got is not None or want is not None):
            detail = f"  期望={want!r} 实得={got!r}"
        results.append((bool(cond), name, detail))
        print(f"  [{'ok' if cond else 'FAIL'}] {name}{detail}")

    def expect_reject(rep: dict, name: str, guard: str, needle: str = "") -> None:
        """断言"被护栏拒了",而且拒的理由对得上(不能是碰巧因为别的原因失败)。"""
        if rep.get("ok") is not False:
            check(name, False, got=rep, want=f"ok=False, guard={guard}")
            return
        if rep.get("guard") != guard:
            check(name, False, got=rep.get("guard"), want=guard)
            return
        if needle and needle not in str(rep.get("error", "")):
            check(name, False, got=rep.get("error"), want=f"含 {needle!r}")
            return
        check(name, True)

    print("自检:造谱 → 解析 → 断言")
    tmp = tempfile.mkdtemp(prefix="svdsh-musicxml-selftest-")
    try:
        # ---------------- 刁钻谱:backup / chord / 延音线 / 休止 / 歌词 全都在 ----------------
        # divisions=4(1 拍 = 4 ticks)。第 1 小节:歌词音(1拍) + 休止(1拍) + 和弦 C4+E4(1拍)
        #   游标:0 → 1 → 2 → 3 ⇒ 小节末 3 拍
        # 第 2 小节:C4 全音符(4 拍,带 tie start) + C4 全音符(tie stop) ⇒ 合成 8 拍
        # 第 3 小节:先写 voice 1(3 拍:第 11/12/13 拍),<backup 12 ticks=3 拍> 回到第 11 拍,
        #           voice 2 写两个音(11/12 拍),<forward 4 ticks=1 拍> 把小节补满,
        #           voice 1 的末音**接着自己**落在第 14 拍(不是回到 backup 后的位置)
        score_xml = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Lead</part-name></score-part>
    <score-part id="P2"><part-name>Harmony</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
      </attributes>
      <direction><sound tempo="96"/></direction>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type><lyric number="1"><syllabic>single</syllabic><text>啊</text></lyric></note>
      <note><rest/><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>16</duration><tie type="start"/><voice>1</voice><type>whole</type><notations><tied type="start"/></notations></note>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>16</duration><tie type="stop"/><voice>1</voice><type>whole</type></note>
    </measure>
    <measure number="3">
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <backup><duration>12</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><voice>2</voice><type>quarter</type></note>
      <note><pitch><step>E</step><octave>3</octave></pitch><duration>4</duration><voice>2</voice><type>quarter</type></note>
      <forward><duration>4</duration></forward>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
    </measure>
  </part>
  <part id="P2">
    <measure number="1">
      <attributes><divisions>4</divisions></attributes>
      <note><pitch><step>G</step><octave>3</octave></pitch><duration>16</duration><voice>1</voice><type>whole</type></note>
    </measure>
  </part>
</score-partwise>
"""
        score_path = os.path.join(tmp, "tricky.musicxml")
        with open(score_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(score_xml)

        # 期望的"voice 1 单声部"音符表(单位:四分音符)
        # ⚠️ 这 8 条是**手算**的,不是把程序输出抄回来 —— 抄回来就等于没断言。
        want_v1 = [
            {"onset": 0.0, "duration": 1.0, "pitch": 60, "lyrics": "啊"},   # C4 带歌词
            {"onset": 2.0, "duration": 1.0, "pitch": 60, "lyrics": ""},     # 和弦根音(休止占掉 1 拍)
            {"onset": 2.0, "duration": 1.0, "pitch": 64, "lyrics": ""},     # 和弦三音(同 onset)
            {"onset": 3.0, "duration": 8.0, "pitch": 60, "lyrics": ""},     # 两个全音符被延音线合成 8 拍(3..11)
            {"onset": 11.0, "duration": 1.0, "pitch": 60, "lyrics": ""},    # 第 3 小节 voice 1 前三个音
            {"onset": 12.0, "duration": 1.0, "pitch": 62, "lyrics": ""},
            {"onset": 13.0, "duration": 1.0, "pitch": 64, "lyrics": ""},
            {"onset": 14.0, "duration": 1.0, "pitch": 67, "lyrics": ""},    # 末音 G4:backup/forward/声部游标都对才落在第 14 拍
        ]

        print("== ① 解析(backup / chord / 延音线 / 休止 / 歌词 / 多声部) ==")
        rep = run_import(score_path, part_no=1, allow_polyphony=True, voice_no=1)
        check("解析成功", rep.get("ok") is True, got=rep.get("error"), want="ok")
        if rep.get("ok") is not True:
            raise SystemExit("解析失败,后续断言无法进行")

        payload = rep["write_notes_args"]["notes"]
        check("voice 1 音符数 = 8(休止被滤掉、延音线合并成一个)",
              len(payload) == 8, got=len(payload), want=8)
        check("onset/duration/pitch/lyrics 逐条精确匹配",
              payload == want_v1, got=payload, want=want_v1)

        # 不过滤时应当把两个声部都解析出来(证明 backup 之后的位置是对的)
        all_rep = run_import(score_path, part_no=1, allow_polyphony=True)
        all_payload = all_rep["write_notes_args"]["notes"]
        check("不过滤 ⇒ 两个声部的 10 个音都在",
              len(all_payload) == 10, got=len(all_payload), want=10)
        check("voice 2 的音落在第 11/12 拍(backup 之后,不是接着 voice 1 往后堆)",
              sorted({n["onset"] for n in all_payload
                      if n["pitch"] in (48, 52)}) == [11.0, 12.0],
              got=sorted({n["onset"] for n in all_payload if n["pitch"] in (48, 52)}),
              want=[11.0, 12.0])

        # 把"精确匹配"拆开说清楚,让失败时一眼看出是哪一类错了
        check("延音线:两个全音符合成**一个** 8 拍长音(不是两个音)",
              len([n for n in payload if n["onset"] == 3.0]) == 1
              and payload[3]["duration"] == 8.0,
              got=[n for n in payload if n["onset"] == 3.0], want="1 个 8 拍音")
        check("和弦:同 onset 两个音(60/64)",
              sorted(n["pitch"] for n in payload if n["onset"] == 2.0) == [60, 64],
              got=[n["pitch"] for n in payload if n["onset"] == 2.0], want=[60, 64])
        check("backup+forward:第 3 小节的 voice 1 末音落在第 14 拍"
              "(backup 算错 ⇒ 会跑到第 11 拍;清了声部游标 ⇒ 会左移到第 12 拍)",
              payload[-1]["onset"] == 14.0, got=payload[-1]["onset"], want=14.0)
        check("小节累加:第 2 小节的音从第 3 拍开始(不累加 measure_offset ⇒ 会塌回第 0 拍)",
              [n["onset"] for n in payload if n["pitch"] == 60 and n["duration"] == 8.0] == [3.0],
              got=[n["onset"] for n in payload if n["duration"] == 8.0], want=[3.0])
        check("歌词:第一音读到「啊」且做了 NFC", payload[0]["lyrics"] == "啊",
              got=payload[0]["lyrics"], want="啊")
        check("休止不产生音符", all(n["pitch"] >= 0 for n in payload))
        check("同 onset 的两个音**不算重叠**(预检不报重叠)",
              not any("重叠" in p for p in rep["problems"]), got=rep["problems"])

        print("== ② 声部选择与源属性 ==")
        check("未指定 --part ⇒ 选第一个有音符的声部并说明",
              run_import(score_path, allow_polyphony=True)["selectedPart"]["index"] == 1)
        rep2 = run_import(score_path, part_no=2)
        check("--part 2 取到 Harmony(1 个全音符)",
              rep2.get("ok") is True and len(rep2["write_notes_args"]["notes"]) == 1,
              got=rep2.get("error") or len(rep2["write_notes_args"]["notes"]), want=1)
        check("--part 越界被拒", run_import(score_path, part_no=9).get("guard") == "part")
        check("声部清单报了 2 个 part", len(rep["parts"]) == 2, got=len(rep["parts"]), want=2)
        check("源 tempo = 96", rep["source"]["tempo"] == 96, got=rep["source"]["tempo"], want=96)
        check("源 tempo **不套用**(tempoApplied=False)",
              rep["source"]["tempoApplied"] is False)
        check("调号 fifths=0 ⇒ C", rep["source"]["keyName"] == "C", got=rep["source"]["keyName"])
        check("拍号 4/4", rep["source"]["timeSignature"] == "4/4",
              got=rep["source"]["timeSignature"], want="4/4")
        check("预览有界(前 20 个,这里 8 个全出)",
              len(rep["preview"]) == 8 and rep["previewTruncated"] is False,
              got=(len(rep["preview"]), rep["previewTruncated"]), want=(8, False))

        print("== ③ 护栏:路径 ==")
        expect_reject(run_import("http://evil.example/a.musicxml"), "拒 URL(http://)", "path", "URL")
        expect_reject(run_import("file:///C:/a.musicxml"), "拒 file:// URL", "path", "URL")
        expect_reject(run_import("tricky.musicxml"), "拒**相对路径**", "path", "绝对路径")
        expect_reject(run_import(os.path.join(tmp, "a.svp")), "拒 `.svp`(工程文件不是谱子)",
                      "path", "工程文件")
        expect_reject(run_import(os.path.join(tmp, "a.mid")), "拒非白名单扩展名(.mid)",
                      "path", ".xml")
        expect_reject(run_import(tmp), "拒目录", "path")
        expect_reject(run_import(os.path.join(tmp, "nope.musicxml")), "拒不存在的文件", "path")
        expect_reject(run_import(""), "拒空路径", "path")
        # 符号链接:预览与写入之间链接可能被换掉(TOCTOU 入口)
        link_path = os.path.join(tmp, "link.musicxml")
        linked = False
        try:
            os.symlink(score_path, link_path)
            linked = True
        except (OSError, NotImplementedError, AttributeError):
            pass                          # Windows 非开发者模式没有权限 ⇒ 跳过这条
        if linked:
            expect_reject(run_import(link_path), "拒符号链接(TOCTOU 入口)", "path", "符号链接")
        else:
            print("  [skip] 符号链接断言(本机无权限创建符号链接)")

        print("== ④ 护栏:XML 安全面(DOCTYPE / ENTITY / 编码) ==")
        # ① DOCTYPE + 外部实体:XXE 的经典载荷。注意**文件确实存在**,
        #    所以这条只能是被 xml-safety 拦下,不可能是"文件不存在"。
        xxe_path = os.path.join(tmp, "xxe.musicxml")
        with open(xxe_path, "w", encoding="utf-8", newline="\n") as f:
            f.write('<?xml version="1.0"?>\n'
                    '<!DOCTYPE score-partwise SYSTEM "http://evil.example/x.dtd">\n'
                    '<score-partwise version="3.1"><part-list>'
                    '<score-part id="P1"><part-name>X</part-name></score-part></part-list>'
                    '<part id="P1"><measure number="1"/></part></score-partwise>\n')
        expect_reject(run_import(xxe_path), "拒 DOCTYPE(XXE 外部实体注入)", "xml-safety", "DOCTYPE")

        bomb_path = os.path.join(tmp, "bomb.musicxml")
        with open(bomb_path, "w", encoding="utf-8", newline="\n") as f:
            f.write('<?xml version="1.0"?>\n'
                    '<!DOCTYPE lolz [<!ENTITY lol "lol">]>\n'
                    '<score-partwise version="3.1"><part-list>'
                    '<score-part id="P1"><part-name>X</part-name></score-part></part-list>'
                    '<part id="P1"><measure number="1"/></part></score-partwise>\n')
        expect_reject(run_import(bomb_path), "拒 ENTITY(实体炸弹 billion-laughs)",
                      "xml-safety", "ENTITY")

        # 小写 + 藏在注释之后:大小写与位置都不该成为绕过
        lower_path = os.path.join(tmp, "lower.musicxml")
        with open(lower_path, "w", encoding="utf-8", newline="\n") as f:
            f.write('<?xml version="1.0"?>\n<!-- 前面垫一段注释 -->\n'
                    '<!doctype score-partwise>\n<score-partwise version="3.1">'
                    '<part-list><score-part id="P1"><part-name>X</part-name></score-part></part-list>'
                    '<part id="P1"><measure number="1"/></part></score-partwise>\n')
        expect_reject(run_import(lower_path), "拒小写 `<!doctype>`(大小写不敏感)", "xml-safety")

        u16_path = os.path.join(tmp, "utf16.musicxml")
        with open(u16_path, "wb") as f:
            f.write('<?xml version="1.0"?><!DOCTYPE x><score-partwise/>'.encode("utf-16"))
        expect_reject(run_import(u16_path), "拒 UTF-16(扫字节护栏对宽字符是瞎的 ⇒ 不留静默绕过)",
                      "xml-safety", "编码")

        empty_path = os.path.join(tmp, "empty.musicxml")
        open(empty_path, "wb").close()
        expect_reject(run_import(empty_path), "拒空文件", "file", "空")

        print("== ⑤ 护栏:SHA-256 指纹 + 写前重算(TOCTOU) ==")
        fp = file_fingerprint(score_path)
        check("SHA-256 是 64 位十六进制", len(fp["sha256"]) == 64 and
              all(c in "0123456789abcdef" for c in fp["sha256"]), got=fp["sha256"][:16])
        check("同一份文件两次哈希一致", file_fingerprint(score_path)["sha256"] == fp["sha256"])
        check("报告里的 sha256 与直接算的一致", rep["sha256"] == fp["sha256"])

        # 改一个音 ⇒ 哈希必须变(这正是"预览的是 A、写的是 B"的判据)
        other_path = os.path.join(tmp, "other.musicxml")
        with open(other_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(score_xml.replace("<step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type><lyric",
                                      "<step>D</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type><lyric"))
        check("改一个音 ⇒ 哈希变(TOCTOU 判据)", file_fingerprint(other_path)["sha256"] != fp["sha256"])

        ok_hash, _, _ = recheck_hash(score_path, fp["sha256"])
        check("写前重算:文件没变 ⇒ 放行", ok_hash is True)
        ok_hash, now_hash, msg = recheck_hash(other_path, fp["sha256"])
        check("写前重算:文件变了 ⇒ 拒写", ok_hash is False and "变化" in msg, got=msg)
        ok_hash, _, msg = recheck_hash(score_path, fp["sha256"], expect_sha256="0" * 64)
        check("--expect-sha256 不符 ⇒ 拒写", ok_hash is False and "expect-sha256" in msg, got=msg)

        print("== ⑥ 护栏:音符上限 / 复调 ==")
        check("上限内通过(10 ≤ 512)", all_rep["ok"] is True)
        cap_rep = run_import(score_path, part_no=1, allow_polyphony=True, cap=10)
        check("上限 10、实际 10 ⇒ 通过(边界是 ≤,不是 <)", cap_rep.get("ok") is True,
              got=cap_rep.get("error"))
        cap_rep = run_import(score_path, part_no=1, allow_polyphony=True, cap=4)
        expect_reject(cap_rep, "超上限(10 > 4)⇒ 拒绝导入", "note-cap", "超过上限")
        check("超限提示里给了拆分/--part 建议",
              "part" in str(cap_rep.get("error", "")), got=cap_rep.get("error"))

        poly_rep = run_import(score_path, part_no=1)          # 不传 allow_polyphony
        expect_reject(poly_rep, "和弦/多声部默认拒(复调体检)", "polyphony", "单声部")
        check("复调详情:voices=[1,2] / maxStack=2 / 三处同 onset 多音(和弦 + 两声部相撞)",
              poly_rep.get("detail", {}).get("voices") == [1, 2]
              and poly_rep.get("detail", {}).get("maxStack") == 2
              and poly_rep.get("detail", {}).get("chordOnsets") == 3,
              got=poly_rep.get("detail"))
        check("--allow-polyphony 放行", run_import(score_path, part_no=1,
              allow_polyphony=True).get("ok") is True)
        # 声部过滤能救回单声部:voice 1 里有和弦 ⇒ 仍会被复调护栏拒(这是对的);
        # voice 2 是纯单声部 ⇒ 不该被误伤
        check("--voice 2(纯单声部)不被复调护栏误伤",
              run_import(score_path, part_no=1, voice_no=2).get("ok") is True,
              got=run_import(score_path, part_no=1, voice_no=2).get("error"))
        check("--voice 9 不存在 ⇒ 明确拒并列出可用声部",
              run_import(score_path, part_no=1, voice_no=9).get("guard") == "voice"
              and run_import(score_path, part_no=1, voice_no=9).get("availableVoices") == [1, 2],
              got=run_import(score_path, part_no=1, voice_no=9))

        # 纯单声部谱:不该被复调护栏误伤
        mono_xml = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Vocal</part-name></score-part></part-list>
  <part id="P1"><measure number="1">
    <attributes><divisions>2</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
    <note><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type></note>
    <note><pitch><step>A</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type></note>
  </measure></part>
</score-partwise>
"""
        mono_path = os.path.join(tmp, "mono.musicxml")
        with open(mono_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(mono_xml)
        mono_rep = run_import(mono_path)
        check("单声部谱不被复调护栏误伤", mono_rep.get("ok") is True, got=mono_rep.get("error"))
        check("divisions=2 也换算正确(G4=67/A4=69,各 1 拍)",
              [ (n["pitch"], n["onset"], n["duration"]) for n in mono_rep["write_notes_args"]["notes"] ]
              == [(67, 0.0, 1.0), (69, 1.0, 1.0)],
              got=mono_rep["write_notes_args"]["notes"])

        print("== ⑦ write_notes_args 符合桥的硬约束 ==")
        args = rep["write_notes_args"]
        check("有 notes/groupName/trackIndex 三个键",
              set(["notes", "groupName", "trackIndex"]) <= set(args.keys()))
        check("每个 duration ≥ 桥下限 0.125 拍",
              all(n["duration"] >= MIN_QUARTER for n in args["notes"]))
        check("每个 pitch 是 0..127 的整数",
              all(isinstance(n["pitch"], int) and 0 <= n["pitch"] <= 127 for n in args["notes"]))
        check("onset 都 ≥ 0 且非递减",
              all(n["onset"] >= 0 for n in args["notes"])
              and all(a["onset"] <= b["onset"] for a, b in zip(args["notes"], args["notes"][1:])))
        check("_note 里写明「先 sv_notes 取 fp」的指纹纪律",
              "expectFp" in args["_note"] and "sv_notes" in args["_note"])
        # 时值下限:短音符被抬到下限并报出来(而不是静默改)
        tiny_xml = mono_xml.replace("<duration>2</duration>", "<duration>1</duration>", 1)
        tiny_path = os.path.join(tmp, "tiny.musicxml")
        with open(tiny_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(tiny_xml)
        tiny_rep = run_import(tiny_path)
        check("时值 0.5 拍 < 0.125? 否(0.5 合法)⇒ 不改动",
              tiny_rep["write_notes_args"]["notes"][0]["duration"] == 0.5,
              got=tiny_rep["write_notes_args"]["notes"][0]["duration"], want=0.5)
        sub_xml = ('<?xml version="1.0"?><score-partwise version="3.1">'
                   '<part-list><score-part id="P1"><part-name>V</part-name></score-part></part-list>'
                   '<part id="P1"><measure number="1"><attributes><divisions>4</divisions></attributes>'
                   '<note><pitch><step>C</step><octave>4</octave></pitch><duration>0</duration>'
                   '<voice>1</voice></note></measure></part></score-partwise>')
        sub_path = os.path.join(tmp, "sub.musicxml")
        with open(sub_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(sub_xml)
        sub_rep = run_import(sub_path)
        check("时值 0 的音被抬到下限 0.125 拍并进 problems",
              sub_rep.get("ok") is True
              and sub_rep["write_notes_args"]["notes"][0]["duration"] == MIN_QUARTER
              and any("下限" in p for p in sub_rep["problems"]),
              got=sub_rep.get("error") or sub_rep.get("problems"), want="含「下限」的问题条目")
        # 有界预览:21 个音 ⇒ 只列前 20 个
        many_xml = ('<?xml version="1.0"?><score-partwise version="3.1">'
                    '<part-list><score-part id="P1"><part-name>V</part-name></score-part></part-list>'
                    '<part id="P1"><measure number="1"><attributes><divisions>4</divisions></attributes>'
                    + "".join('<note><pitch><step>C</step><octave>4</octave></pitch>'
                              '<duration>4</duration><voice>1</voice></note>' for _ in range(21))
                    + '</measure></part></score-partwise>')
        many_path = os.path.join(tmp, "many.musicxml")
        with open(many_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(many_xml)
        many_rep = run_import(many_path)
        check("有界预览:21 个音只列前 20 个并标 truncated",
              len(many_rep["preview"]) == PREVIEW_CAP and many_rep["previewTruncated"] is True,
              got=(len(many_rep["preview"]), many_rep["previewTruncated"]),
              want=(PREVIEW_CAP, True))
        check("21 个音全在 write_notes_args 里(预览有界 ≠ 数据被截断)",
              len(many_rep["write_notes_args"]["notes"]) == 21,
              got=len(many_rep["write_notes_args"]["notes"]), want=21)

        print("== ⑧ 其它顶层形式与错误路径 ==")
        tw_path = os.path.join(tmp, "timewise.musicxml")
        with open(tw_path, "w", encoding="utf-8", newline="\n") as f:
            f.write('<?xml version="1.0"?><score-timewise version="3.1">'
                    '<part-list><score-part id="P1"><part-name>X</part-name></score-part></part-list>'
                    '</score-timewise>')
        expect_reject(run_import(tw_path), "`score-timewise` 明确拒绝并给替代方案",
                      "parse", "score-timewise")
        bad_path = os.path.join(tmp, "bad.musicxml")
        with open(bad_path, "w", encoding="utf-8", newline="\n") as f:
            f.write("<score-partwise><part-list>")     # 故意不闭合
        expect_reject(run_import(bad_path), "坏 XML ⇒ 解析失败被如实报告", "parse", "解析失败")
        wrong_path = os.path.join(tmp, "wrong.musicxml")
        with open(wrong_path, "w", encoding="utf-8", newline="\n") as f:
            f.write('<?xml version="1.0"?><foo><bar/></foo>')
        expect_reject(run_import(wrong_path), "根元素不是 score-partwise ⇒ 拒", "parse", "不是 MusicXML")

        print("== ⑨ CLI(--json / --write 门禁) ==")
        # CLI 这几条会把 JSON 打到 stdout ⇒ 临时接住,免得把自检输出冲乱。
        # (用 contextlib.redirect_stdout 而不是加 --quiet,是为了让被测的仍是**真实**的 CLI 路径)
        import contextlib
        import io

        def run_cli(argv):
            """跑一次 CLI,返回 (退出码, 捕获到的文本)。每次调用都清空缓冲。"""
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
                rc = main(argv)
            return rc, buf.getvalue()

        def run_cli_json(argv):
            """跑一次 CLI,返回 (退出码, 解析后的 JSON)。"""
            rc, text = run_cli(argv)
            try:
                return rc, json.loads(text)
            except ValueError as e:
                return rc, {"_parseError": str(e), "_raw": text[:200]}

        base = [score_path, "--json", "--part", "1", "--allow-polyphony"]
        rc, obj = run_cli_json(base)
        check("CLI --json 预览退出码 0", rc == 0, got=rc, want=0)
        check("CLI --json 输出是可解析的 JSON 且 ok=true/dryRun=true",
              obj.get("ok") is True and obj.get("dryRun") is True, got=obj.get("_parseError"))
        rc, obj = run_cli_json(base + ["--write"])
        check("--write 但没 --confirm-rights ⇒ 非 0 退出(权利门禁)", rc != 0, got=rc, want="≠0")
        check("权利门禁的错误体带 guard=rights", obj.get("guard") == "rights", got=obj)
        rc, obj = run_cli_json(base + ["--write", "--confirm-rights"])
        check("--write --confirm-rights ⇒ 退出码 0", rc == 0, got=rc, want=0)
        check("写入态 dryRun=false 且带下一步说明",
              obj.get("dryRun") is False and "note" in obj, got=obj.get("dryRun"))
        rc, obj = run_cli_json(base + ["--write", "--confirm-rights",
                                       "--expect-sha256", "0" * 64])
        check("写前哈希对不上 ⇒ 非 0 退出(TOCTOU)", rc != 0, got=rc, want="≠0")
        check("TOCTOU 拒绝带 guard=hash-changed", obj.get("guard") == "hash-changed", got=obj)
        rc, obj = run_cli_json([score_path, "--json", "--max-notes", "3", "--allow-polyphony"])
        check("CLI --max-notes 3 ⇒ 非 0 退出(上限)", rc != 0, got=rc, want="≠0")
        rc, obj = run_cli_json([score_path, "--json", "--part", "1", "--voice", "1",
                                "--allow-polyphony"])
        check("CLI --voice 1 正常退出", rc == 0, got=rc, want=0)
        check("CLI --voice 1 ⇒ voiceFilter=1 且 8 个音",
              obj.get("voiceFilter") == 1 and obj.get("counts", {}).get("notes") == 8, got=obj)
        # 非 --json 的人类可读预览也要能跑通(打印路径同样会被测到)
        rc, text = run_cli([score_path, "--part", "1", "--voice", "1", "--allow-polyphony"])
        check("人类可读预览退出码 0 且打印了 SHA-256 与预览表",
              rc == 0 and "SHA-256" in text and "音符预览" in text, got=rc)
        check("人类可读预览里写明了「源 tempo 只汇报」",
              "只汇报" in text and "不会" in text)

    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)

    passed = sum(1 for ok, _, _ in results if ok)
    failed = [(n, d) for ok, n, d in results if not ok]
    print()
    print(f"自检结果:{passed} 通过 / {len(failed)} 失败")
    for n, d in failed:
        print(f"  FAIL: {n}{d}")
    return 0 if not failed else 1


# ================================================================ CLI
def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="MusicXML 乐谱 → 音符列表(交给桥的 write_notes)。默认只读预览,不碰 SV2。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("input", nargs="?", help="MusicXML 文件(**绝对路径**,.xml/.musicxml)")
    ap.add_argument("--part", type=int, default=None,
                    help="取第几个声部(1 起);不传则取第一个有音符的并说明")
    ap.add_argument("--voice", type=int, default=None,
                    help="只要该 `<voice>` 号的音符(多声部 part 里取单声部;过滤在复调体检之前)")
    ap.add_argument("--group-name", default="MusicXML Import", help="写入时新建的组名")
    ap.add_argument("--track-index", type=int, default=0, help="目标轨道下标(0 起)")
    ap.add_argument("--max-notes", type=int, default=MAX_NOTES, help=f"音符数上限(默认 {MAX_NOTES})")
    ap.add_argument("--allow-polyphony", action="store_true",
                    help="放行复调/和弦(默认拒:多声部混一条时间线会让音位漂移)")
    ap.add_argument("--write", action="store_true",
                    help="生成写入参数(默认只读预览)。仍需 --confirm-rights")
    ap.add_argument("--confirm-rights", action="store_true",
                    help="确认你**有权使用**这份乐谱(写入的合规前提)")
    ap.add_argument("--expect-sha256", default=None,
                    help="写前把哈希钉死在这个值上(配合上一次预览的 sha256 使用)")
    ap.add_argument("--lyrics", default="", help="没有歌词的音符统一填这个词")
    ap.add_argument("--json", action="store_true", help="只输出 JSON")
    ap.add_argument("--selftest", action="store_true", help="造谱自检(不需要输入文件)")
    args = ap.parse_args(argv)

    if args.selftest:
        return selftest()
    if not args.input:
        ap.error("需要输入 MusicXML 文件,或用 --selftest")

    # ⑤ 默认只读预览 —— 不显式要求就不做任何"往工程里写"的动作
    if args.write and not args.confirm_rights:
        # ⑧ 权利门禁:写之前必须显式确认有权使用这份乐谱
        msg = ("缺少权利确认 ⇒ 不生成写入参数。合规前提:你须确认**有权使用**这份乐谱"
               "(「网上搜得到」不等于授权;商业谱请购买/取得授权)。确认后加 --confirm-rights。")
        if args.json:
            print(json.dumps({"ok": False, "guard": "rights", "error": msg},
                             ensure_ascii=False, indent=2))
        else:
            print(f"❌ {msg}", file=sys.stderr)
        return 3

    rep = run_import(args.input, part_no=args.part, group_name=args.group_name,
                     track_index=args.track_index, cap=args.max_notes,
                     allow_polyphony=args.allow_polyphony,
                     expect_sha256=args.expect_sha256,
                     fallback_lyrics=args.lyrics, json_only=args.json,
                     voice_no=args.voice)

    if rep.get("ok") is not True:
        if args.json:
            print(json.dumps(rep, ensure_ascii=False, indent=2))
        else:
            print(f"❌ [{rep.get('guard', 'error')}] {rep.get('error')}", file=sys.stderr)
            if rep.get("hint"):
                print(f"   提示:{rep['hint']}", file=sys.stderr)
        return 2

    if args.write:
        # ④ 写前重算哈希 —— 证明"你预览的那一份"和"现在要写的那一份"是同一份
        ok, now_hash, err = recheck_hash(rep["input"], rep["sha256"], args.expect_sha256)
        if not ok:
            out = {"ok": False, "guard": "hash-changed", "error": err,
                   "input": rep["input"], "previewSha256": rep["sha256"], "currentSha256": now_hash}
            if args.json:
                print(json.dumps(out, ensure_ascii=False, indent=2))
            else:
                print(f"❌ {err}", file=sys.stderr)
            return 4
        rep["dryRun"] = False
        rep["note"] = ("write_notes_args 已就绪:由 agent 调桥的 write_notes 完成写入"
                       "(本工具**不会**自己连 SV2)。写前先 sv_notes 取 fp 并回传 expectFp。")

    if args.json:
        print_json(rep)
    else:
        print_preview(rep)
        if args.write:
            print()
            print("✅ 已生成写入参数(--write + --confirm-rights)。")
            print("   下一步(agent 侧):")
            print(f"     1) sv_notes  → 取指纹 fp(把选区/组对到目标轨上)")
            print(f"     2) sv_call(op=\"write_notes\", args=<上面的 write_notes_args>)")
            print(f"        ⚠️ 桥的写操作还要 expectFp;本工具不代填(它在宿主之外,拿不到也不该伪造)")
        else:
            print()
            print("ℹ️ 当前是**只读预览**(默认)。核对 hash / 声部 / 预览无误后,")
            print("   加 `--write --confirm-rights` 生成写入参数。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
