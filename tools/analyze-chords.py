"""测音频的和弦进行 → 输出可以直接喂给桥 write_notes 的音符表。

为什么在 SV2 之外做:
    SV2 脚本 API 里**没有任何音频类**(官方 26 个类里没有音频 I/O),所以听不出和弦。
    能做的是"把音符写进去" —— 所以链路是:
        ① analyze-audio.py 测出 BPM + 第一拍  ② **本工具**算和弦 + 配和声
        → ③ 桥的 write_notes 把 block chord 写进一个新组。
    和 extract-notes.py 的分工一样:音频分析在 Python,DAW 操作在桥。

算法(纯 numpy,不依赖 librosa):
    ① STFT → **谱峰提取**(局部极大 + 抛物线插值)⇒ 只把"真的存在"的峰折进 chroma
       —— 见下面 pick_peaks 的注释:直接对 FFT 频点求和会把能量抹到相邻半音上,
         大/小三和弦于是分不开,这是参考项目点名的"频谱泄漏"。
    ② **基频加权**:泛音按 1/h 打折 —— 见 fundamental_weight 的注释。
       一个音的泛音列本身就长得像七和弦(5 次泛音=大三度、7 次=小七度),
       不处理的话 C/G/F 全被认成 Cmaj7/Gmaj7/Fmaj7(实测 4 个全错)。
    ③ 每帧 chroma **逐帧归一化**后再平均 —— 不这么做的话,一小节里响的那一帧会独占整段。
    ④ 按 `--bpm` / `--first-beat-sec` 切段(默认一小节 = 4 拍,`--seg-beats` 可改)。
    ⑤ 每段平均 chroma 与和弦模板做**余弦相似度 × 复杂度先验**,取最佳;顺带报亚军和候选表。
    ⑥ 按和弦音做**根音位密集排列**(close voicing)的 block chord,写进 write_notes_args。

用法:
    python analyze-chords.py --selftest                  # 合成 6 条已知进行自检(要求精确匹配)
    python analyze-chords.py 伴奏.wav --bpm 91.45 --first-beat-sec 0.2554
    python analyze-chords.py 伴奏.wav --bpm 91.45 --first-beat-sec 0.2554 --json
    python analyze-chords.py 伴奏.wav --bpm 91.45 --first-beat-sec 0.2554 --triads-only
    python analyze-chords.py 伴奏.wav                    # 不给 --bpm ⇒ 现场调 analyze-audio 的逻辑

⚠️ 关于和弦类型(默认含七和弦):
    dom7 的音集里含一个减三和弦(C7 的 {E,G,A#} = Edim),所以模板里**没有** dom7 时,
    素材里每个 V7 都会被标成"根音差大三度的 dim" —— 那是根音都错了的错标。
    默认因此包含七和弦;要更干净但会错标 V7 的读法用 `--triads-only`。
    实测数字与取舍见 DEFAULT_QUALITIES 的注释。
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DEPS = os.path.join(os.path.dirname(HERE), "py-deps")
if os.path.isdir(DEPS) and DEPS not in sys.path:
    sys.path.insert(0, DEPS)

# ---- STFT 参数 ----
# FRAME 取 4096:低音区(C2≈65Hz)一个半音约 4Hz,22050Hz 下 4096 点 FFT 的频点间隔
# 是 5.38Hz —— 再小就分不开低音区的相邻半音了。HOP 取 1024(≈46ms 一帧),
# 对"一小节一个和弦"这种尺度绰绰有余(91BPM 下一小节 ≈ 2.6 秒 ≈ 56 帧)。
FRAME = 4096
HOP = 1024
SR = 22050

# ---- 谱峰提取 ----
PEAK_NEIGH = 2          # 局部极大的半窗(频点数):峰必须比左右各 2 个频点都高
PEAK_ABS = 1e-4         # 绝对底噪门限(相对每帧最大值,压掉纯噪声帧的碎峰)
PEAK_REL = 1e-3         # 相对门限:低于本帧最强峰 0.1% 的峰不算峰

# ---- chroma ----
FMIN = 55.0             # A1:比它更低的基本音(钢琴最低 A0=27.5Hz)在 4096 点 FFT 下
                        # 一个频点就跨好几个半音,折进 chroma 只会制造误差,不如丢掉
FMAX = 8000.0           # 默认**不限**上界:真正的泛音问题由 fundamental_weight 逐个峰解决
                        # (见它的注释 —— 试过"砍高频上界",泛音多的时候会失效)。
                        # 留这个上界只是挡住镲片/齿音这类**没有谐波结构**的高频噪声。
SILENCE_REL = 0.15      # 段内 RMS < 全局中位数 × 0.15 ⇒ 判 N(太安静)
SILENCE_ABS = 0.004     # 绝对下限:整轨都极轻时别把所有段都判成 N

# ---- 和弦模板 ----
# ⚠️ **模板里只放和弦音本身(不放它们的泛音),因为观测侧已经把泛音打下去了。**
#    这是试出来的自洽组合,不是随手选的:
#      · 观测侧 fundamental_weight 把"是别人泛音"的峰按 1/h 打折;
#      · 模板侧如果还按满幅期待泛音,两边的配比对不上,余弦相似度反而变差。
#    实测(6 个进行 × 4 个和弦 × 泛音数 2/4/6/8/12 = 120 个判定,根音位 C3 区):
#        观测打折 + 模板含泛音  91/120
#        观测打折 + 模板只放和弦音 **102/120**  ← 选这个
#        观测不打折 + 模板含泛音  95/120
#        观测不打折 + 模板只放和弦音 72/120
#    高音区(根音 C4,96 个判定):90/96 对 84/96,同样是这个组合最好。
HARMONIC_AMPS = {1: 1.0}    # 模板只用基频(留成 dict 是为了以后要试"含泛音"时改一行)
HARMONIC_CUTOFF = 3500.0    # 只用于判断泛音是否越界(当前只放基频,基本用不到)

TEMPLATES = [
    ("maj",  (0, 4, 7)),
    ("min",  (0, 3, 7)),
    ("dom7", (0, 4, 7, 10)),
    ("min7", (0, 3, 7, 10)),
    ("maj7", (0, 4, 7, 11)),
    ("dim",  (0, 3, 6)),
    ("sus4", (0, 5, 7)),
]

PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# 复杂度先验:音越多的模板乘得越小 ⇒ "证据接近时取更简单的和弦"。
# 数值是试出来的:0.95 足以压掉真实素材上 0.001 级别的噪声排名,
# 又不足以压掉合成自检里真实七音那 ~0.07 的差距(所以 C7/F7/G7/Cmaj7 仍被认对)。
# 详见 match_chord 的注释。
COMPLEXITY_PRIOR = {"maj": 1.0, "min": 1.0, "dom7": 0.95, "min7": 0.95,
                    "maj7": 0.95, "dim": 0.97, "sus4": 0.97}

# 和弦后缀:大三和弦按惯例**不写后缀**(C 而不是 Cmaj),其余照常。
# 小调写 `m` 而不是 `min` —— 谱面上 `Am` 才是常规写法。
QUALITY_SUFFIX = {"maj": "", "min": "m", "dom7": "7", "min7": "m7",
                  "maj7": "maj7", "dim": "dim", "sus4": "sus4"}

# 尾段过滤:音频末尾常常剩一个**不到一帧长**的碎片段(自检里 9.90..9.95s),
# 它必然是 N,却会白白占一段、还会让"块和弦数 == 期望和弦数"这类断言失败。
# 只丢弃"短于半段"的尾段,而且是**从末尾**丢 —— 中间段再短也是真实内容。
MIN_TAIL_RATIO = 0.5

# write_notes 的音高范围(桥接受 0..127,这里默认收在钢琴中音区附近)
PITCH_LO = 36           # C2
PITCH_HI = 84           # C6
ROOT_BASE = 48          # C3:根音位的起始八度


def _load_analyze_audio():
    """把兄弟脚本 analyze-audio.py 当模块载进来(文件名带连字符,不能直接 import)。"""
    spec = importlib.util.spec_from_file_location(
        "analyze_audio_mod", os.path.join(HERE, "analyze-audio.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def read_mono(path: str, target_sr: int = SR):
    """读音频 → 单声道 float32 @ target_sr。

    直接复用 analyze-audio.py 的 read_mono:
      优先 **soundfile**(libsndfile):直接解 FLAC / OGG / MP3 —— SV2 工程里的素材
      常常就是 `.flac`,而标准库 `wave` 读不了;没有 soundfile 时它自己回落到
      extract-notes.py 的内置 WAV 解析。
    """
    return _load_analyze_audio().read_mono(path, target_sr)


# ---------------------------------------------------------------- chroma
def pick_peaks(mag: np.ndarray, freqs: np.ndarray, fmin: float, fmax: float):
    """从一帧幅度谱里挑谱峰 → (频率, 幅度) 两个数组。

    ⚠️ **为什么必须挑峰,而不是直接对频点求和** —— 这是参考项目的笔记里点名的那条
    ("谱峰提取 + log1p 压缩消除频谱泄漏"):

        4096 点 FFT 的频点间隔约 5.4Hz,而低音区一个半音只有 4~8Hz(C2 处 3.9Hz、
        C3 处 7.8Hz)—— 频点间隔已经和半音间距一个量级了,而每个乐音的谱能量是一个
        **有宽度的瓣**(加窗之后主瓣就有好几个频点宽)。
        于是"把每个频点按它自己的音高折进 chroma"会把一个音的能量**同时**抹到相邻半音上:
        E 被抹到 D#/F,而 C 大三和弦的 E 与 C 小三和弦的 D#/F 正好在这一带打架
        ⇒ **大/小和弦分不开**。挑出真正的峰、只折峰的位置,一个音就只落进一格。

    抛物线插值用对数幅度、在频点序号上做(峰是平滑的,插值能把位置精度提高一个量级,
    低音区尤其明显:一个频点 5.4Hz 在 C2 上就是 1.4 个半音,不插值等于音高乱跳)。
    """
    n = len(mag)
    if n < 2 * PEAK_NEIGH + 1:
        return np.zeros(0), np.zeros(0)

    # 局部极大:比左右各 PEAK_NEIGH 个频点都大(向量化,不写循环)
    is_peak = np.ones(n, dtype=bool)
    for d in range(1, PEAK_NEIGH + 1):
        is_peak[d:n - d] &= (mag[d:n - d] > mag[:n - 2 * d])
        is_peak[d:n - d] &= (mag[d:n - d] >= mag[2 * d:])
    is_peak[:PEAK_NEIGH] = False
    is_peak[n - PEAK_NEIGH:] = False

    fmin_i = int(np.searchsorted(freqs, fmin))
    fmax_i = int(np.searchsorted(freqs, fmax))
    is_peak[:max(0, fmin_i)] = False
    is_peak[min(n, fmax_i):] = False
    if mag.max() > 0:
        is_peak &= (mag > mag.max() * PEAK_REL) & (mag > PEAK_ABS)

    idx = np.flatnonzero(is_peak)
    if len(idx) == 0:
        return np.zeros(0), np.zeros(0)
    idx = idx[(idx > 0) & (idx < n - 1)]          # 插值要左右邻居
    if len(idx) == 0:
        return np.zeros(0), np.zeros(0)

    y0 = np.log(mag[idx - 1] + 1e-12)
    y1 = np.log(mag[idx] + 1e-12)
    y2 = np.log(mag[idx + 1] + 1e-12)
    denom = y0 - 2.0 * y1 + y2
    shift = np.where(np.abs(denom) > 1e-12, 0.5 * (y0 - y2) / np.where(denom == 0, 1e-12, denom), 0.0)
    shift = np.clip(shift, -0.5, 0.5)

    df = freqs[1] - freqs[0] if n > 1 else 1.0
    peak_freq = freqs[idx] + shift * df
    # 峰的幅度用线性幅度(插值只在位置上做),log1p 压缩留到折 chroma 时统一做
    peak_mag = mag[idx]
    keep = (peak_freq >= fmin) & (peak_freq <= fmax)
    return peak_freq[keep], peak_mag[keep]


def fundamental_weight(pf: np.ndarray, pm: np.ndarray):
    """每个谱峰"是基频而不是泛音"的把握 → 权重数组(0..1)。

    ⚠️ **这是整个工具最要命的一个坑:泛音列本身就长得像一个和弦。**

        一个乐音的泛音落在这些音级上(相对根音的半音数):
            2 次 = +12(八度)          → 同一个音级,无害
            3 次 = +19(纯五度)        → 多了个五音
            **5 次 = +27.9(大三度)**  → 凭空多出**大三度**!
            **7 次 = +33.7(小七度)**  → 凭空多出**小七度**!
            9 次 = +38(大二度)、11 次 = +41.5(增四度)…
        于是**单独一个 C 音的泛音就点亮了 C、G、E、A#、B、D**,
        而 B 正是 Cmaj7 与 C 的**唯一**区别、E 正是 C 与 Cm 的区别。

        实测(合成 6 个泛音的 C-G-Am-F,4 个和弦全错):
            C → Cmaj7,G → Gmaj7,Am → Am7,F → Fmaj7
        真实钢琴/吉他/弦乐的泛音比 6 个多得多 ⇒ 不处理的话这个工具在真素材上不可用。

    也试过"按素材里峰的分布自适应砍高频上界",**失败了**:泛音越多,上界被推得越高
    (8 个泛音时到 1600Hz),泛音又回来了。根因是"用所有峰定上界"本身就是被泛音牵着走。
    正确的问题是**逐个峰**问:你是某个更低、更强、频率成整数倍的峰的泛音吗?
    """
    w = np.ones(len(pf), dtype=np.float64)
    if len(pf) == 0:
        return w
    order = np.argsort(pf)                       # 从低到高扫,低的先当"基频候选"
    pf_s, pm_s = pf[order], pm[order]
    # 幅度门限:整帧最强峰的 15% —— 比这还弱的峰不足以"解释"掉别人
    floor = pm_s.max() * 0.15 if pm_s.max() > 0 else 0.0
    for i in range(len(pf_s)):
        if pm_s[i] < floor:
            continue                             # 自己太弱,当不了基频
        for h in range(2, 7):
            target = pf_s[i] * h
            if target > pf_s[-1] * 1.02:
                break
            j = int(np.searchsorted(pf_s, target))
            for cand in (j - 1, j):              # 最近的峰(半音容差)
                if 0 <= cand < len(pf_s) and cand != i:
                    if abs(pf_s[cand] - target) <= target * 0.02:   # ±2% ≈ 1/3 半音
                        w[order[cand]] = min(w[order[cand]], 1.0 / h)
                        break
    return w


def harmonic_band(signal: np.ndarray, sr: int, fmin: float = FMIN,
                  fmax: float = None):
    """chroma 的分析上界(默认 8kHz ≈ 不限)。

    留这个上界只是为了挡住"根本不是乐音"的高频(镲片、齿音、宽带噪声):
    它们没有谐波结构,折进 chroma 就是往每一格里加噪声。

    ⚠️ **不要用"砍高频"来解决泛音问题。** 试过一版按素材里峰的分布自适应定上界,
        结果泛音越多、上界被推得越高(8 个泛音时到 1600Hz),泛音又回来了。
        根因是"用所有峰定上界"本身就是被泛音牵着走。
        正确做法是逐个峰判断它是不是别人的泛音 —— 见 fundamental_weight。
    """
    return float(fmax) if fmax is not None else FMAX


def chroma_and_rms(signal: np.ndarray, sr: int, fmin: float = FMIN, fmax: float = FMAX):
    """STFT → 每帧 chroma(12 维,已归一化) + 每帧 RMS。"""
    n = (len(signal) - FRAME) // HOP + 1
    if n < 4:
        raise SystemExit("音频太短(至少要有 4 帧)")
    win = np.hanning(FRAME).astype(np.float32)
    idx = np.arange(n)[:, None] * HOP + np.arange(FRAME)[None, :]
    frames = signal[idx] * win
    rms = np.sqrt((frames ** 2).mean(axis=1))

    spec = np.abs(np.fft.rfft(frames, axis=1))
    freqs = np.fft.rfftfreq(FRAME, 1.0 / sr)

    chroma = np.zeros((n, 12), dtype=np.float64)
    for i in range(n):
        pf, pm = pick_peaks(spec[i], freqs, fmin, fmax)
        if len(pf) == 0:
            continue
        # 峰频率 → MIDI → 音级。四舍五入到最近半音(插值之后峰位置足够准)。
        midi = 69.0 + 12.0 * np.log2(pf / 440.0)
        pc = np.mod(np.round(midi).astype(np.int64), 12)
        # log1p 压缩:压掉"基频峰比泛音峰强几十倍"的动态差,免得 chroma 只剩根音。
        # 再乘"是基频的把握":泛音打折,见 fundamental_weight。
        w = np.log1p(pm * 10.0) * fundamental_weight(pf, pm)
        np.add.at(chroma[i], pc, w)
        s = chroma[i].sum()
        if s > 0:
            chroma[i] /= s
    return chroma, rms


# ---------------------------------------------------------------- 模板
def build_templates(qualities=None):
    """→ [(label, rootPc, quality, 12 维单位向量)]

    qualities 只放哪些和弦类型(默认全部 7 种);主流程默认传 DEFAULT_QUALITIES。
    HARMONIC_AMPS 目前只放基频(见它上面的注释:观测侧已经把泛音打下去了,
    模板侧跟着只放和弦音,两边才自洽)。留成 dict 是为了以后要试"含泛音"时改一行。
    """
    if qualities is None:
        qualities = [q for q, _ in TEMPLATES]
    out = []
    for root in range(12):
        for quality, intervals in TEMPLATES:
            if quality not in qualities:
                continue
            v = np.zeros(12, dtype=np.float64)
            for itv in intervals:
                # 以 C3(48)为参考音高,只用来判断泛音频率是否越界
                midi = 48 + itv
                for h, amp in HARMONIC_AMPS.items():
                    f = 440.0 * 2 ** ((midi - 69) / 12.0) * h
                    if f > HARMONIC_CUTOFF:
                        break
                    # ⚠️ 泛音 h 落在哪个音级,必须**按 MIDI 算**(mod 12),不能写
                    #    `itv + 12*round(log2(h))` —— 那个式子是错的:
                    #    log2(5)=2.32,四舍五入成 2 ⇒ 算出 +24 半音(还是根音),
                    #    而 5 次泛音实际在 +27.86 半音(大三度,音级 +4)。
                    #    同理 3 次泛音 +19 半音(纯五度)、7 次 +33.7(小七度)。
                    #    这个错曾经让"泛音模板"整个变成空操作,白白调了一轮。
                    pc = int(round(midi + 12.0 * np.log2(h))) % 12
                    v[(root + pc) % 12] += amp
            # 归一到单位长度(余弦相似度);与观测 chroma 的处理一致。
            # 只有 HARMONIC_AMPS 非空时才有分量,否则这里会 0/0。
            if v.sum() > 0:
                v /= np.linalg.norm(v)
            out.append((PITCH_NAMES[root] + QUALITY_SUFFIX[quality],
                        root, quality, v))
    return out


# 默认**包含**七和弦;`--triads-only` 可以关掉。
#
# ⚠️ 为什么默认包含七和弦 —— 这是自检抓出来的一个**系统性错标**,不是偏好问题:
#    dom7 的音集是 {根, 3, 5, m7},而 {3, 5, m7} 恰好是一个**减三和弦**
#    (C7 = C-E-G-A# = Edim 的音集)。所以只要模板里没有 dom7,
#    素材里每一个 V7 都会被报成"根音差大三度的 dim":
#        C7 → Edim、F7 → Adim、G7 → Bdim   (自检里就是这么报的)
#    实测「送别」默认档(A# 大调):序列里冒出 Bdim、Fdim —— 那两个位置其实是
#    C7 / F7。把 V7 标成 dim 是**根音都错了**的错标,比"多标一个七音"严重得多。
#
# ⚠️ 代价要如实说:真实密集织体上七和弦模板"音多占便宜",
#    实测「送别」伴奏(64 段):
#        含七和弦:  置信(冠亚军差)中位数 0.011,42/60 段 < 0.02
#        只三和弦:  置信中位数 0.021,28/60 段 < 0.02,分布收敛到 A#/D#/Gm/F
#    也就是说"只三和弦"读起来更干净 —— 但那个干净是靠把 V7 错标成 dim 换来的。
#    宁可要一个"多标了七音但根音对"的结果,也不要"根音错了"的结果。
#    要那个干净版本就加 --triads-only,并知道它会怎么错。
DEFAULT_QUALITIES = ("maj", "min", "dom7", "min7", "maj7", "dim", "sus4")
TRIAD_QUALITIES = ("maj", "min", "dim", "sus4")

TEMPLATE_TABLE = build_templates(DEFAULT_QUALITIES)


def match_chord(seg_chroma: np.ndarray, max_candidates: int, template_table=None):
    """一段的平均 chroma → 最佳和弦 + 候选表。

    得分 = **余弦相似度 × 复杂度先验**。

    ⚠️ 为什么要有复杂度先验(试过两轮才定下来):
        真实钢琴伴奏的织体很密(实测某帧 198 个谱峰),12 格 chroma 几乎被填平
        (每格 0.07~0.10)。这种"什么都有一点"的输入下,**音更多的模板天生占便宜** ——
        七和弦比三和弦多一个音,恰好又能蹭到那个音的泛音能量,于是冠亚军差 0.001
        也能让 A#7 压过 A#。余弦绝对值 0.62~0.76、差距 0.001 的排名是**噪声**,
        不是判断。
        反过来,只按"单位和的点积"又走到另一个极端:它把七音当成必须**真的占一份**
        才有分,结果真实存在的 dom7 被系统性地降级成三和弦(实测 C7→C 全错)。

        所以用**温和的先验**折中:三和弦 1.0、七和弦 0.95、sus4/dim 0.97。
        含义是"证据接近时取简单的那个"(奥卡姆),但真实七音的证据只要够强
        (合成自检里七音是实打实的基频,差距 ~0.07)就能翻过来。
        这不是权宜之计:和弦识别本来就是"在同等解释力下取更简单的和弦"。

    ⚠️ 置信度 = 与亚军的**得分差**。为什么不用得分本身:同一段音频里所有模板的
        余弦都挤在 0.6~0.9,绝对值几乎不携带信息;而"比亚军高多少"直接回答
        "这个判断有没有把握" —— 三和弦与它的七和弦只差一个音,差距天然就小。
    """
    norm = np.linalg.norm(seg_chroma)
    if norm <= 1e-9:
        return None, []
    v = seg_chroma / norm
    table = TEMPLATE_TABLE if template_table is None else template_table
    scored = []
    for label, root, quality, tv in table:
        scored.append((float(np.dot(v, tv)) * COMPLEXITY_PRIOR.get(quality, 1.0),
                       label, root, quality))
    scored.sort(key=lambda x: -x[0])
    top = [{"label": s[1], "rootPc": int(s[2]), "quality": s[3], "score": round(s[0], 4)}
           for s in scored[:max(1, max_candidates)]]
    return top[0], top


# ---------------------------------------------------------------- 分段
def segment_bounds(duration: float, bpm: float, first_beat: float, seg_beats: float):
    """→ [(i, startSec, endSec, startQuarter, endQuarter)]。

    ⚠️ **首拍补偿**:第一拍可能落在音频开头**之前**(前奏没从拍点上开始),
    此时 first_beat < 0。直接 `ceil` 会把它折到 0,于是整条网格平移半拍以上。
    先按 first_beat 平移再取整,得到"第一段覆盖第一个拍点"的网格。
    """
    beat_sec = 60.0 / bpm
    seg_sec = beat_sec * seg_beats
    # 第一段的起点:不超过 first_beat 的最大格点(允许为负 ⇒ 音频开头那一小截算进第 1 段)
    k0 = int(np.ceil((0.0 - first_beat) / seg_sec)) if seg_sec > 0 else 0
    start0 = first_beat + k0 * seg_sec
    n_seg = int(np.ceil((duration - start0) / seg_sec)) if duration > start0 else 0
    out = []
    for i in range(max(0, n_seg)):
        s = start0 + i * seg_sec
        e = s + seg_sec
        if s >= duration:
            break
        # 拍号:段起点相对第一拍的拍数(可能是负的 —— 前奏那一截)
        sq = (s - first_beat) / beat_sec
        out.append((i, s, min(e, duration), sq, sq + seg_beats))
    # 丢掉末尾那个不满半段的碎片(见 MIN_TAIL_RATIO 的注释);只从末尾丢,且至少留一段
    while len(out) > 1 and (out[-1][2] - out[-1][1]) < seg_sec * MIN_TAIL_RATIO:
        out.pop()
    return out


def segment_chroma(chroma, rms, sr, bounds):
    """把帧平均到每段里 → (每段平均 chroma, 每段 RMS)。"""
    n = chroma.shape[0]
    fps = sr / HOP
    seg_ch = np.zeros((len(bounds), 12), dtype=np.float64)
    seg_rms = np.zeros(len(bounds), dtype=np.float64)
    for j, (_i, s, e, _sq, _eq) in enumerate(bounds):
        f0 = int(np.floor(s * fps))
        f1 = int(np.ceil(e * fps))
        f0 = max(0, min(n, f0))
        f1 = max(f0, min(n, f1))
        if f1 <= f0:
            continue
        seg_ch[j] = chroma[f0:f1].mean(axis=0)
        seg_rms[j] = float(np.median(rms[f0:f1]))
    return seg_ch, seg_rms


# ---------------------------------------------------------------- 配和声
def voice_chord(root_pc: int, quality: str, octave_shift: int = 0,
                lo: int = PITCH_LO, hi: int = PITCH_HI):
    """根音位密集排列(close voicing)→ MIDI 音高列表。

    为什么是"密集排列"而不是"低音 + 宽音域铺开":
        密集排列的音都挤在一个八度里,写在 SV2 里看得清、也不容易和主旋律打架;
        宽排列(根音沉到 C2、五音飘到 C5)听起来更"铺",但一旦声库音域或工程里
        已有轨道重叠就很难收拾。默认保守,需要更宽的音域用 `--octave` 平移。
    """
    intervals = dict(TEMPLATES)[quality]
    base = ROOT_BASE + ((root_pc - ROOT_BASE) % 12)
    pitches = [base + itv for itv in intervals]
    # 越界就整组降/升八度(而不是逐个 clip —— clip 会把三和弦压成同度)
    while max(pitches) > hi and min(pitches) - 12 >= lo:
        pitches = [p - 12 for p in pitches]
    while min(pitches) < lo and max(pitches) + 12 <= hi:
        pitches = [p + 12 for p in pitches]
    pitches = [p + 12 * octave_shift for p in pitches]
    return sorted(pitches)


def build_write_notes(chords, seg_beats: float, octave: int, group_name: str):
    """和弦表 → write_notes 的参数。"""
    notes = []
    for c in chords:
        if c["quality"] == "N":
            continue
        for p in voice_chord(c["rootPc"], c["quality"], octave):
            if p < 0 or p > 127:
                continue
            notes.append({
                "onset": round(float(c["startQuarter"]), 6),
                "duration": round(float(c["endQuarter"] - c["startQuarter"]), 6),
                "pitch": int(p),
                # 歌词写和弦名:在 SV2 里一眼能看出这句是什么和弦
                "lyrics": c["label"],
            })
    notes.sort(key=lambda x: (x["onset"], x["pitch"]))
    return {
        "groupName": group_name,
        "notes": notes,
        # 显式钉住时间偏移:音频对齐用的是绝对秒 → 工程拍,所以和弦组也必须落在
        # 工程第 0 拍起的绝对位置上。不给这一项的话桥会**复制当前组的时间偏移**
        # (见 DSHBridge.lua 的 write_notes),结果整组跟着当前组平移 —— 对不上音频。
        "timeOffsetQuarter": 0,
    }


def check_write_notes_args(args):
    """按**桥自己的** write_notes 规则体检输出 → 问题列表(空 = 可以安全下发)。

    桥的 OPS.write_notes 会先整批校验再动手,拒掉这些情况:
      · onset < 0;duration < 0.125 拍(MIN_Q);pitch 不是整数或不在 0..127
      · **发声组内音符不得重叠**(同 onset 不算重叠 —— 那正是和弦/齐奏)
    这里逐条复刻,好让"分析出错了"在**本工具里**就暴露,而不是等桥报一个错。
    """
    notes = args.get("notes") or []
    problems = []
    if not notes:
        problems.append("没有任何音符(整轨都是 N?)")
        return problems
    for i, n in enumerate(notes):
        if n["onset"] < 0:
            problems.append(f"notes[{i}].onset < 0")
        if n["duration"] < 0.125:
            problems.append(f"notes[{i}].duration {n['duration']} < 0.125 拍(桥的下限)")
        if float(n["pitch"]) != int(n["pitch"]) or not (0 <= n["pitch"] <= 127):
            problems.append(f"notes[{i}].pitch {n['pitch']} 非法")
    # 重叠:按 onset 分组,组内(同 onset)永远合法;组间要求前一组全部收尾后才允许下一组起音
    groups = []
    for onset in sorted({n["onset"] for n in notes}):
        same = [n for n in notes if n["onset"] == onset]
        groups.append((onset, onset + max(n["duration"] for n in same)))
    for i in range(len(groups) - 1):
        if groups[i][1] > groups[i + 1][0] + 1e-9:
            problems.append(f"块 {groups[i][0]}..{groups[i][1]} 与下一块 "
                            f"{groups[i + 1][0]}.. 重叠 —— 桥会整批拒写")
    return problems


# ---------------------------------------------------------------- 主分析
def analyze(signal: np.ndarray, sr: int, bpm: float, first_beat: float,
            seg_beats: float = 4.0, octave: int = 0, max_candidates: int = 3,
            group_name: str = "和弦进行", chroma_max_hz: float = None,
            chroma_min_hz: float = FMIN, qualities=None):
    duration = len(signal) / sr
    beat_sec = 60.0 / bpm
    table = build_templates(qualities) if qualities else TEMPLATE_TABLE
    fmax = harmonic_band(signal, sr, chroma_min_hz, chroma_max_hz)
    chroma, rms = chroma_and_rms(signal, sr, chroma_min_hz, fmax)
    bounds = segment_bounds(duration, bpm, first_beat, seg_beats)
    if not bounds:
        raise SystemExit("音频比第一拍还短,切不出段")
    seg_ch, seg_rms = segment_chroma(chroma, rms, sr, bounds)

    # 静音判据:相对全局中位数 + 一个绝对地板
    ref = float(np.median(seg_rms[seg_rms > 0])) if np.any(seg_rms > 0) else 0.0
    thr = max(SILENCE_ABS, ref * SILENCE_REL)

    chords = []
    for j, (_i, s, e, sq, eq) in enumerate(bounds):
        cand = None
        cands = []
        if seg_rms[j] > thr:
            cand, cands = match_chord(seg_ch[j], max_candidates, table)
        if cand is None:
            chords.append({
                "label": "N", "rootPc": None, "quality": "N",
                "startQuarter": round(sq, 6), "endQuarter": round(eq, 6),
                "startSec": round(s, 4), "endSec": round(e, 4),
                "confidence": 0.0, "score": 0.0, "runnerUp": None,
                "rms": round(float(seg_rms[j]), 5),
                "candidates": cands,
            })
            continue
        runner = cands[1] if len(cands) > 1 else None
        # 置信度 = 与亚军的**得分差**(不是得分本身)。
        # 同一段音频里所有模板的余弦都挤在 0.6~0.9,绝对值几乎不携带信息;
        # 而"比亚军高多少"直接回答"这个判断有没有把握" —— 三和弦与它的七和弦
        # 只差一个音,差距天然就小,所以真实素材上这个值本来就偏小(见 main 的告警)。
        conf = round(float(cand["score"] - (runner["score"] if runner else 0.0)), 4)
        chords.append({
            "label": cand["label"], "rootPc": cand["rootPc"], "quality": cand["quality"],
            "startQuarter": round(sq, 6), "endQuarter": round(eq, 6),
            "startSec": round(s, 4), "endSec": round(e, 4),
            "confidence": conf, "score": cand["score"],
            "runnerUp": ({"label": runner["label"], "score": runner["score"]}
                         if runner else None),
            "rms": round(float(seg_rms[j]), 5),
            "candidates": cands,
        })

    result = {
        "bpm": round(float(bpm), 2),
        "firstBeatSec": round(float(first_beat), 4),
        "beatSec": round(float(beat_sec), 4),
        "segBeats": seg_beats,
        "segSec": round(float(beat_sec * seg_beats), 4),
        "sampleRate": sr,
        "durationSec": round(duration, 3),
        "frameCount": int(chroma.shape[0]),
        "segCount": len(chords),
        "chromaBandHz": [chroma_min_hz, round(fmax, 1)],
        "qualities": [q for q, _ in TEMPLATES if q in (qualities or DEFAULT_QUALITIES)],
        "silenceThreshold": round(float(thr), 5),
        "chords": chords,
        "write_notes_args": build_write_notes(chords, seg_beats, octave, group_name),
    }
    return result


# ---------------------------------------------------------------- 合成自检素材
def synth_chords(prog, bpm: float, offset: float, bars: int, sr: int = SR,
                 tail_sec: float = 0.05, nharm: int = 4):
    """合成一段已知和弦进行 → (信号, 每段期望标签)。

    prog 是 [(根音音级, 和弦类型)]。每个和弦弹一小节,一小节 4 拍。
    每个音用"基频 + nharm 个泛音"叠加(不是纯正弦):
      ⚠️ 纯正弦**太容易**了 —— 只有基频,chroma 干净得像模板本身,什么算法都能过。
        加了泛音之后 5 度/3 度会被泛音重复计一次,正是"把 maj 和 min 认混"的现实条件。
        这也和 extract-notes.py 的自检同一个思路(合成类人声,不用纯正弦)。
      ⚠️ 但泛音**不能只加 4 个就以为够了**:泛音越多越难,而"泛音伪造七音"这个坑
        只有在泛音够多(≥6)时才暴露。自检里跑 4 与 8 两档,以难的那档为准。
    """
    beat = 60.0 / bpm
    bar = beat * 4.0
    total = int(sr * (offset + bars * bar + tail_sec))
    sig = np.zeros(total, dtype=np.float64)
    labels = []
    for b, (root_pc, quality) in enumerate(prog):
        labels.append(PITCH_NAMES[root_pc] + QUALITY_SUFFIX[quality])
        t0 = offset + b * bar
        # 三和弦/七和弦用根音位密集排列,落在 C3 附近(和 voice_chord 同一个思路)
        intervals = dict(TEMPLATES)[quality]
        base = 48 + ((root_pc - 48) % 12)
        pitches = [base + itv for itv in intervals]
        n = int(sr * bar)
        t = np.arange(n) / sr
        # 起落包络:不做淡入淡出的话,小节边界会有一个宽带冲击,
        # 而冲击的频谱是**平的** ⇒ 会把一小段的 chroma 拉向"什么都有一点"。
        env = np.minimum(1.0, t / 0.02) * np.minimum(1.0, (bar - t) / 0.05)
        env = np.clip(env, 0.0, 1.0)
        wave = np.zeros(n, dtype=np.float64)
        for p in pitches:
            f0 = 440.0 * 2 ** ((p - 69) / 12.0)
            for h in range(1, nharm + 1):
                wave += (1.0 / h) * np.sin(2 * np.pi * f0 * h * t)
        wave *= env / max(1, len(pitches))
        i0 = int(t0 * sr)
        seg = min(n, total - i0)
        if seg > 0:
            sig[i0:i0 + seg] += wave[:seg] * 0.3
    return sig.astype(np.float32), labels


def _selftest_one(name: str, prog, bpm: float, offset: float, nharm: int,
                  seg_beats: float = 4.0, qualities=None, expect_override=None):
    """跑一条已知进行 → (是否全过, 实测标签)。"""
    expect = (expect_override if expect_override is not None
              else [PITCH_NAMES[rp] + QUALITY_SUFFIX[q] for rp, q in prog])
    sig, _ = synth_chords(prog, bpm, offset, bars=len(prog), nharm=nharm)
    print(f"自检:{name}  ——  {' - '.join(expect)}")
    print(f"      {bpm:g} BPM,第一拍 {offset:.2f}s,一小节一个,每个音 {nharm} 个泛音")
    r = analyze(sig, SR, bpm, offset, seg_beats=seg_beats, qualities=qualities)
    got = [c["label"] for c in r["chords"]]
    print(f"  段数 {r['segCount']}  静音门限 {r['silenceThreshold']}  "
          f"chroma 频段 {r['chromaBandHz'][0]:.0f}..{r['chromaBandHz'][1]:.0f}Hz")
    for c in r["chords"]:
        ru = c["runnerUp"]["label"] if c["runnerUp"] else "-"
        ru_s = c["runnerUp"]["score"] if c["runnerUp"] else 0.0
        print(f"    {c['startSec']:>6.2f}s..{c['endSec']:>6.2f}s  "
              f"{c['startQuarter']:>5.2f}..{c['endQuarter']:>5.2f} 拍  "
              f"{c['label']:<6} (得分 {c['score']:.3f}, 亚军 {ru} "
              f"{ru_s:.3f}, 置信 {c['confidence']:.3f})")

    # 判据 1:标签逐个精确匹配(顺序 + 内容)
    labels_ok = got == expect
    # 判据 2:块和弦的音高都在范围内、且每个和弦都是"同时起音、同时收尾"的块
    notes = r["write_notes_args"]["notes"]
    pitches_ok = bool(notes) and all(PITCH_LO <= n["pitch"] <= PITCH_HI for n in notes)
    on_onset = {}
    for n in notes:
        on_onset.setdefault(n["onset"], []).append(n)
    block_ok = len(on_onset) == len(expect) and all(len(v) >= 3 for v in on_onset.values())
    # 判据 3:能过桥自己的 write_notes 校验(尤其是"组内不得重叠"这条硬规则)
    problems = check_write_notes_args(r["write_notes_args"])
    bridge_ok = not problems
    # 判据 4:**第一段真的落在给定的第一拍上**。
    #   为什么必须单列这一条:段边界算错(比如把 first_beat 当成 0、或者忘了首拍可能是负数)
    #   不会让标签立刻变错 —— 0.3s 的偏移摊到 2.4s 的小节里,段内多数帧仍然是正确的和弦,
    #   分类器照样给出对的标签。自检要抓的是"网格对齐"这件事本身,不能指望标签替它报警。
    first_start = r["chords"][0]["startSec"] if r["chords"] else float("nan")
    align_ok = abs(first_start - offset) < 0.05

    print(f"  期望 {expect}")
    print(f"  实测 {got}")
    for label, ok in (("标签按序精确匹配", labels_ok),
                      ("音高都在 %d..%d" % (PITCH_LO, PITCH_HI), pitches_ok),
                      ("每个和弦都是同时起音的块(>=3 音)", block_ok),
                      ("能过桥的 write_notes 校验(不重叠等)", bridge_ok),
                      (f"第一段起点落在第一拍上({first_start:.3f}s ≈ {offset:.2f}s)",
                       align_ok)):
        print(f"  {'PASS' if ok else 'FAIL'}  {label}")
    for p in problems:
        print(f"        · {p}")
    print()
    return (labels_ok and pitches_ok and block_ok and bridge_ok and align_ok), got


def selftest() -> int:
    """合成已知和弦进行,看能不能把标签**按序精确**认回来。

    ⚠️ 判据必须是**逐个标签精确匹配**,不能只看"跑通了":
        analyze-audio.py 的自检就是靠"要求精确"才逼出了半速/倍速歧义与分析窗延迟
        两个真 bug。这里的等价物是**泛音伪造七音** —— 一个不做基频加权的实现
        会把 C/G/F 认成 Cmaj7/Gmaj7/Fmaj7(实测 4 个全错),
        而"跑通了、输出了 4 个标签"这种弱判据完全看不见。

    ⚠️ 三条进行各压一个方向,缺一条自检就是空的:
        ① 纯三和弦 C-G-Am-F  —— 压"别把三和弦认成七和弦"(泛音伪造)
        ② 真七和弦 C7-F7-G7-C7 / Dm7-G7-Cmaj7 —— 压"别把真七和弦降级成三和弦"
           (只加复杂度先验、不验这一条,就会悄悄把 C7 全变成 C)
        ③ 升号调 D-A-Bm-G    —— 压"根音算错"(模板忘了加 root 那类 bug 只在非 C 调露头)
    ⚠️ 泛音数跑两档:4 个泛音时朴素实现也能过,**8 个泛音时才暴露** ——
        只跑一档的自检有一半是空的。真实乐器的泛音比 8 个还多,以难的那档为准。
    """
    bpm = 100.0
    offset = 0.30
    cases = [
        ("① 纯三和弦", [(0, "maj"), (7, "maj"), (9, "min"), (5, "maj")], 4, None, None),
        ("① 纯三和弦", [(0, "maj"), (7, "maj"), (9, "min"), (5, "maj")], 8, None, None),
        # 默认档必须能认对真七和弦(dom7/min7/maj7 三种都压)。
        ("② 真七和弦(默认档)", [(0, "dom7"), (5, "dom7"), (7, "dom7"), (0, "dom7")],
         8, None, None),
        ("② 真七和弦(默认档)", [(2, "min7"), (7, "dom7"), (0, "maj7"), (0, "maj7")],
         8, None, None),
        # 反向:关掉七和弦之后,dom7 **必然**读成它的减三和弦替身 ——
        #   这不是"容错",是同音集合的数学后果:C7 的音集 {C,E,G,A#} 里
        #   {E,G,A#} 正好是 Edim,而 Edim 的模板只有 3 个音、没有第 4 个音需要解释
        #   ⇒ 余弦天然更高。F7→Adim、G7→Bdim 同理。
        #   这一条压两件事:① `--triads-only` 的退化是**可预测**的(不是随机噪声);
        #   ② 反过来证明了默认档为什么必须含七和弦(见 DEFAULT_QUALITIES 的注释)。
        ("② 反向:--triads-only 把 dom7 读成 dim",
         [(0, "dom7"), (5, "dom7"), (7, "dom7"), (0, "dom7")],
         8, TRIAD_QUALITIES, ["Edim", "Adim", "Bdim", "Edim"]),
        ("③ 升号调",   [(2, "maj"), (9, "maj"), (11, "min"), (7, "maj")], 8, None, None),
    ]
    all_ok = True
    for name, prog, nharm, quals, exp in cases:
        ok, _got = _selftest_one(name, prog, bpm, offset, nharm, qualities=quals,
                                 expect_override=exp)
        all_ok = all_ok and ok

    print("  总结果:", "PASS" if all_ok else "FAIL")
    return 0 if all_ok else 1


# ---------------------------------------------------------------- CLI
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("input", nargs="?", help="音频文件")
    ap.add_argument("--bpm", type=float, default=None, help="速度(不给就现场测)")
    ap.add_argument("--first-beat-sec", type=float, default=None,
                    help="第一拍在音频内的秒数(不给就现场测)")
    ap.add_argument("--seg-beats", type=float, default=4.0,
                    help="每段多少拍(默认 4 = 4/4 一小节)")
    ap.add_argument("--octave", type=int, default=0, help="和弦整体升降八度")
    ap.add_argument("--max-candidates", type=int, default=3,
                    help="每段报几个候选和弦(默认 3;最佳与亚军一定在里面)")
    ap.add_argument("--group-name", default=None, help="write_notes_args.groupName")
    ap.add_argument("--chroma-max-hz", type=float, default=None,
                    help="chroma 分析上界(默认 8000 ≈ 不限)。真正的泛音问题由逐个峰的"
                         "基频加权解决;这个参数只用来挡没有谐波结构的高频噪声")
    ap.add_argument("--triads-only", action="store_true",
                    help="只匹配三和弦 + dim/sus4(更干净,但会把 V7 错标成它的减三和弦替身,"
                         "见 DEFAULT_QUALITIES 的注释)")
    ap.add_argument("--out", default=None, help="输出 JSON 路径(默认打印到 stdout)")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--json", action="store_true", help="只输出 JSON")
    args = ap.parse_args()

    if args.selftest:
        return selftest()
    if not args.input:
        raise SystemExit("需要输入音频,或用 --selftest")

    signal, sr = read_mono(args.input)
    if not args.json:
        print(f"读入 {args.input}  ({len(signal)/sr:.2f} 秒 @ {sr}Hz)")

    # 没给 --bpm 就现场调 analyze-audio.py 的逻辑(**import 进来直接调**,不 shell out:
    # 子进程要重新解一遍音频、还要处理编码,而它的 read_mono 我们本来就在用)。
    bpm, first_beat = args.bpm, args.first_beat_sec
    if bpm is None or first_beat is None:
        aa = _load_analyze_audio()
        env = aa.onset_envelope(signal)
        est = aa.estimate(env, sr)
        if bpm is None:
            bpm = est["bpm"]
        if first_beat is None:
            first_beat = est["firstBeatSec"]
        if not args.json:
            print(f"  现场测速:BPM {est['bpm']}(半速 {est['bpmHalf']} / 倍速 "
                  f"{est['bpmDouble']}),第一拍 {est['firstBeatSec']}s,"
                  f"置信 {est['confidence']}")
            print(f"  ⚠️ 半速/倍速歧义看 midpointHint:{est['midpointHint']}")

    gname = args.group_name or ("和弦进行 " + os.path.splitext(os.path.basename(args.input))[0])
    r = analyze(signal, sr, float(bpm), float(first_beat),
                seg_beats=args.seg_beats, octave=args.octave,
                max_candidates=args.max_candidates, group_name=gname,
                chroma_max_hz=args.chroma_max_hz,
                qualities=TRIAD_QUALITIES if args.triads_only else None)
    r["input"] = os.path.abspath(args.input)
    # 下发之前先用桥的规则自检一遍 —— 让"分析出错了"在这里就报出来,
    # 而不是等 write_notes 在宿主里整批拒写(那样只能看到一个笼统的错误)
    r["writeNotesProblems"] = check_write_notes_args(r["write_notes_args"])

    text = json.dumps(r, ensure_ascii=False, indent=2)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text)
    if args.json:
        # --json 也要能反映"结果不可下发":否则调用方拿到一段漂亮 JSON、
        # 退出码 0,却在下发时被桥整批拒掉。
        print(json.dumps(r, ensure_ascii=False))
        return 1 if r["writeNotesProblems"] else 0
    if args.out:
        print(f"写出 {args.out}")

    print(f"  BPM = {r['bpm']}   每拍 {r['beatSec']}s   每段 {r['segBeats']:g} 拍 "
          f"= {r['segSec']}s   共 {r['segCount']} 段")
    print(f"  chroma 频段 = {r['chromaBandHz'][0]:.0f}..{r['chromaBandHz'][1]:.0f}Hz   "
          f"和弦类型 = {'/'.join(r['qualities'])}")
    print(f"  {'起点':>7}  {'终点':>7}  {'起拍':>7}  {'止拍':>7}  {'和弦':<6} "
          f"{'得分':>6}  {'亚军':<6} {'置信':>6}")
    for c in r["chords"]:
        ru = c["runnerUp"]["label"] if c["runnerUp"] else "-"
        print(f"  {c['startSec']:>7.2f}  {c['endSec']:>7.2f}  {c['startQuarter']:>7.2f}  "
              f"{c['endQuarter']:>7.2f}  {c['label']:<6} {c['score']:>6.3f}  "
              f"{ru:<6} {c['confidence']:>6.3f}")
    print()
    print(f"下一步(让 DSH 调桥):write_notes {json.dumps(r['write_notes_args'], ensure_ascii=False)[:120]}…")
    print(f"  共 {len(r['write_notes_args']['notes'])} 个音符,"
          f"组名「{r['write_notes_args']['groupName']}」")
    # ⚠️ 如实报"这个结果有多可信",而不是只报一个和弦表就完事。
    #    真实伴奏(尤其钢琴)织体很密,冠亚军差常常落在噪声量级 ——
    #    那种段落的标签只能当"参考",不能当"事实"。
    confs = [c["confidence"] for c in r["chords"] if c["label"] != "N"]
    if confs:
        weak = sum(1 for c in confs if c < 0.02)
        med = float(np.median(confs))
        print(f"  置信度:中位数 {med:.3f},最小 {min(confs):.3f},最大 {max(confs):.3f};"
              f"{weak}/{len(confs)} 段低于 0.02")
        if weak > len(confs) * 0.4:
            print("  ⚠️ 过半段落的冠亚军差距在噪声量级 —— 和弦表只能当参考。"
                  "可试 --triads-only(更干净,但会把 V7 错标成 dim)、"
                  "或减小 --seg-beats 看局部。")
    if r["writeNotesProblems"]:
        print("  ⚠️ 输出没通过桥的 write_notes 校验:")
        for p in r["writeNotesProblems"]:
            print(f"     · {p}")
        return 1
    print("  ✓ 已通过桥的 write_notes 校验(音高范围 / 最短时长 / 不重叠)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
