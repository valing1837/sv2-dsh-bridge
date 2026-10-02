"""测音频的 BPM 与「第一拍在音频内的秒数」。

为什么在 SV2 之外做:
    SV2 脚本 API 没有音频 I/O(官方 26 个类里没有),所以测不出音频的节拍。
    但把音频**放**到哪儿、速度标写多少,是桥能做的 —— 两边配合就完成了对齐。

配合方式:
    python analyze-audio.py 伴奏.wav
      → {"bpm": 120.2, "firstBeatSec": 0.348, ...}
    然后让 DSH 调桥的 align_audio(firstBeatSec=0.348, bpm=120.2, anchor="measure", measure=1)
      → 音频被挪到第 1 小节,第一拍正好压在小节线上,并写一条 120.2 的速度标。

算法(纯 numpy,不依赖 librosa):
    ① STFT → 频谱通量(spectral flux)得到起音强度包络
    ② 减去滑动均值(自适应阈值)+ 半波整流,压掉持续音、突出打击点
    ③ 对包络做自相关,在 60~200 BPM 里找最强周期 ⇒ BPM
    ④ 固定该周期,扫一个周期内的所有相位,取"落在拍点上的能量最大"的那个 ⇒ 第一拍偏移

用法:
    python analyze-audio.py --selftest        # 合成 120BPM 点击轨自检
    python analyze-audio.py 伴奏.wav
    python analyze-audio.py 伴奏.wav --json
"""
from __future__ import annotations

import argparse
import json
import os
import struct
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DEPS = os.path.join(os.path.dirname(HERE), "py-deps")
if os.path.isdir(DEPS) and DEPS not in sys.path:
    sys.path.insert(0, DEPS)

FRAME = 2048
HOP = 512
BPM_MIN = 60.0
BPM_MAX = 200.0

# ⚠️ **分析窗延迟补偿** —— 这一条不补,对齐就会系统性偏早。
#    帧 i 覆盖 [i*HOP, i*HOP+FRAME),而频谱通量在"起音刚进入窗口"那一帧就起峰,
#    于是测得的时间比真实起音**早** (FRAME-HOP)/sr 秒。自检里 0.35s 的点击会被测成 0.279s,
#    差值 0.071s 正好等于 (2048-512)/22050 = 0.0697。
#    对 44.1kHz 素材按同式换算即可(用分析采样率,不是源采样率)。
def latency_sec(sr: int) -> float:
    return (FRAME - HOP) / sr


def read_wav_mono(path: str):
    """自己解析 RIFF/WAV(16/24/32 位 PCM 或 float32,单/多声道)→ (单声道 float32, 采样率)。

    ⚠️ 为什么不用标准库 `wave`:它**不支持 float32** WAV,而不少分离工具
    (含 MSST-GUI 的某些输出)导出的正是 float32。
    这是 `soundfile` 不可用时的兜底 —— 只认 WAV,但把常见位深都覆盖了。
    """
    with open(path, "rb") as f:
        buf = f.read()
    if len(buf) < 44 or buf[0:4] != b"RIFF" or buf[8:12] != b"WAVE":
        raise SystemExit(f"不是 RIFF/WAVE 文件: {path}")

    p, ch, sr, bits, fmt, data_off, data_size = 12, 2, 44100, 16, 1, 0, 0
    while p + 8 <= len(buf):
        cid = buf[p:p + 4]
        sz = struct.unpack_from("<I", buf, p + 4)[0]
        if cid == b"fmt ":
            fmt, ch, sr, bits = struct.unpack_from("<HHIH", buf, p + 8)[:4]
            if fmt == 0xFFFE and sz >= 40:   # WAVE_FORMAT_EXTENSIBLE
                fmt = struct.unpack_from("<H", buf, p + 8 + 24)[0]
        elif cid == b"data":
            data_off, data_size = p + 8, sz
            break
        p += 8 + sz + (sz % 2)

    if not data_off:
        raise SystemExit("WAV 里没有 data 块")
    data_size = min(data_size, len(buf) - data_off)
    bytes_per = bits // 8
    if bytes_per not in (1, 2, 3, 4):
        raise SystemExit(f"不支持的位深: {bits}")
    total = data_size // (ch * bytes_per)
    raw = np.frombuffer(buf, dtype=np.uint8, count=total * ch * bytes_per, offset=data_off)

    if fmt == 3 and bits == 32:                                  # IEEE float
        mono = raw.view(np.float32).reshape(-1, ch).mean(axis=1)
    elif bits == 16:
        mono = raw.view(np.int16).reshape(-1, ch).astype(np.float32).mean(axis=1) / 32768.0
    elif bits == 24:
        b = raw.reshape(-1, ch, 3).astype(np.int32)
        v = (b[:, :, 0] | (b[:, :, 1] << 8) | (b[:, :, 2] << 16))
        v = ((v << 8) >> 8).astype(np.float32)                   # 符号扩展
        mono = v.mean(axis=1) / 8388608.0
    elif bits == 32:                                             # int32 PCM
        mono = raw.view(np.int32).reshape(-1, ch).astype(np.float32).mean(axis=1) / 2147483648.0
    else:                                                        # 8 位无符号
        mono = (raw.reshape(-1, ch).astype(np.float32) - 128.0).mean(axis=1) / 128.0
    return mono, sr


def read_mono(path: str, target_sr: int = 22050):
    """读音频 → 单声道 float32 @ target_sr。

    优先用 **soundfile**(libsndfile):它直接解 FLAC / OGG / MP3,不用先转 WAV ——
    而 SV2 工程里的素材常常就是 `.flac`。
    没有 soundfile 时退回**本文件内置**的 WAV 解析(`read_wav_mono`:只认 WAV,
    但处理了 float32 / 24bit / 多声道,不依赖标准库 `wave`)。
    """
    signal, sr = None, None
    try:
        import soundfile as sf
        data, sr = sf.read(path, dtype="float32", always_2d=True)
        signal = data.mean(axis=1)
    except Exception:
        signal, sr = None, None

    if signal is None:
        signal, sr = read_wav_mono(path)

    if sr != target_sr:
        n_out = int(len(signal) * target_sr / sr)
        pos = np.arange(n_out) * (sr / target_sr)
        i0 = np.floor(pos).astype(np.int64)
        i1 = np.minimum(i0 + 1, len(signal) - 1)
        frac = (pos - i0).astype(np.float32)
        signal = (signal[i0] * (1 - frac) + signal[i1] * frac).astype(np.float32)
    return signal, target_sr


def onset_envelope(signal: np.ndarray):
    """频谱通量 → 起音强度包络。"""
    n = (len(signal) - FRAME) // HOP + 1
    if n < 8:
        raise SystemExit("音频太短")
    win = np.hanning(FRAME).astype(np.float32)
    idx = np.arange(n)[:, None] * HOP + np.arange(FRAME)[None, :]
    frames = signal[idx] * win
    spec = np.abs(np.fft.rfft(frames, axis=1))
    # 对数压缩,压掉响度差
    spec = np.log1p(spec * 10.0)
    flux = np.diff(spec, axis=0)
    flux = np.maximum(flux, 0).sum(axis=1)          # 只取上升沿
    env = np.concatenate([[0.0], flux])
    # 自适应阈值:减滑动均值再整流
    k = max(3, int(0.35 * 22050 / HOP))             # 约 0.35 秒窗
    kernel = np.ones(k) / k
    base = np.convolve(env, kernel, mode="same")
    env = np.maximum(env - base, 0.0)
    if env.max() > 0:
        env = env / env.max()
    return env


def estimate(env: np.ndarray, sr: int) -> dict:
    fps = sr / HOP                                   # 包络帧率
    lag_min = int(fps * 60.0 / BPM_MAX)
    lag_max = int(fps * 60.0 / BPM_MIN)
    if lag_max >= len(env) - 1:
        lag_max = max(lag_min + 1, len(env) - 2)

    e = env - env.mean()
    ac = np.correlate(e, e, mode="full")[len(e) - 1:]
    ac = ac / (ac[0] + 1e-12)

    lags = np.arange(lag_min, lag_max + 1)
    if len(lags) == 0:
        raise SystemExit("音频太短,测不出速度")
    # ⚠️ **速度先验** —— 这一条不能省。
    #    自相关在"一拍"和"两拍"上的峰经常一样高(半速/倍速歧义),自检里就栽在这:
    #    120BPM 的点击轨被测成 60.03。乘一个以 120BPM 为中心的对数正态窗即可定下来。
    #    这也是通用节拍跟踪器(如 librosa.beat)的标准做法。
    tempos_of_lag = 60.0 * fps / lags
    prior = np.exp(-0.5 * (np.log2(tempos_of_lag / 120.0) / 0.9) ** 2)
    seg = ac[lag_min:lag_max + 1] * prior
    best = int(np.argmax(seg)) + lag_min
    # 抛物线插值细化周期
    if 0 < best < len(ac) - 1:
        y0, y1, y2 = ac[best - 1], ac[best], ac[best + 1]
        denom = (y0 - 2 * y1 + y2)
        shift = 0.5 * (y0 - y2) / denom if abs(denom) > 1e-12 else 0.0
        shift = float(np.clip(shift, -1.0, 1.0))
    else:
        shift = 0.0
    period = best + shift
    bpm = 60.0 * fps / period

    # 相位:固定周期,扫一个周期找能量最大的起点
    phases = np.arange(0, max(1, int(round(period))))
    best_phase, best_score = 0, -1.0
    for ph in phases:
        pos = np.arange(ph, len(env), period)
        idxs = np.round(pos).astype(np.int64)
        idxs = idxs[(idxs >= 0) & (idxs < len(env))]
        if len(idxs) < 2:
            continue
        score = float(env[idxs].sum() / np.sqrt(len(idxs)))
        if score > best_score:
            best_score, best_phase = score, int(ph)
    first_beat = best_phase / fps + latency_sec(sr)

    # 置信度:拍点上的平均能量 / 全局平均能量
    pos = np.arange(best_phase, len(env), period)
    idxs = np.round(pos).astype(np.int64)
    idxs = idxs[(idxs >= 0) & (idxs < len(env))]
    on_beat = float(env[idxs].mean()) if len(idxs) else 0.0
    conf = float(on_beat / (env.mean() + 1e-9))

    # ⚠️ **半速/倍速的判别指标**:看"格点中点"上的起音能量。
    #    如果中点能量和格点本身差不多 ⇒ 真正的拍其实是当前周期的**一半**
    #    (我们测到的只是半速,把每两拍当成了一拍)。
    #    如果中点明显更弱 ⇒ 当前周期就是真拍。
    half_pos = np.arange(best_phase + period / 2, len(env), period)
    hidx = np.round(half_pos).astype(np.int64)
    hidx = hidx[(hidx >= 0) & (hidx < len(env))]
    mid_energy = float(env[hidx].mean()) if len(hidx) else 0.0
    mid_ratio = mid_energy / (on_beat + 1e-9)

    # 把第一拍折到 [0, 一个周期) 内,并给"可能是半拍/倍拍"的备选
    return {
        "bpm": round(float(bpm), 2),
        "bpmHalf": round(float(bpm) / 2, 2),
        "bpmDouble": round(float(bpm) * 2, 2),
        "firstBeatSec": round(float(first_beat), 4),
        "beatPeriodSec": round(float(period / fps), 4),
        "confidence": round(conf, 3),
        "midpointRatio": round(mid_ratio, 3),
        "midpointHint": ("中点能量 %.2f×格点 ⇒ 真拍可能是**倍速** %.2f BPM"
                         % (mid_ratio, bpm * 2)) if mid_ratio > 0.7 else
                        ("中点能量 %.2f×格点 ⇒ 当前周期应当就是真拍" % mid_ratio),
        "beatCount": int(len(idxs)),
        "envelopeFps": round(fps, 2),
        "durationSec": round(len(env) * HOP / sr, 3),
    }


def selftest() -> int:
    """合成一条 120BPM 的点击轨(第一拍在 0.35 秒),看能不能测回来。"""
    sr = 22050
    dur = 12.0
    sig = np.zeros(int(sr * dur), dtype=np.float32)
    bpm = 120.0
    period = 60.0 / bpm
    offset = 0.35
    t = offset
    click = 0
    while t < dur:
        i = int(t * sr)
        n = int(0.03 * sr)
        env = np.exp(-np.linspace(0, 8, n)).astype(np.float32)
        tone = np.sin(2 * np.pi * 1000 * np.arange(n) / sr).astype(np.float32)
        seg = min(n, len(sig) - i)
        if seg > 0:
            sig[i:i + seg] += (env * tone)[:seg] * (1.0 if click % 4 == 0 else 0.6)
        t += period
        click += 1

    print(f"自检:合成 {bpm:g} BPM 点击轨,第一拍在 {offset:.2f}s")
    env = onset_envelope(sig)
    r = estimate(env, sr)
    print(f"  测得 BPM = {r['bpm']}  (期望 {bpm:g})")
    print(f"  测得第一拍 = {r['firstBeatSec']}s  (期望 {offset:.2f})")
    print(f"  置信度 = {r['confidence']}   拍数 = {r['beatCount']}")

    bpm_ok = abs(r["bpm"] - bpm) < 2.0
    # 相位允许差一个周期(第一拍可能被认成第 2/3 拍)
    d = abs(r["firstBeatSec"] - offset)
    phase_ok = min(d, abs(d - r["beatPeriodSec"]), abs(d - 2 * r["beatPeriodSec"])) < 0.05
    print("  结果:", "PASS" if (bpm_ok and phase_ok) else "FAIL")
    return 0 if (bpm_ok and phase_ok) else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("input", nargs="?", help="音频文件")
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
    env = onset_envelope(signal)
    r = estimate(env, sr)
    r["input"] = os.path.abspath(args.input)

    if args.json:
        print(json.dumps(r, ensure_ascii=False))
    else:
        print(f"  BPM          = {r['bpm']}   (半速 {r['bpmHalf']} / 倍速 {r['bpmDouble']})")
        print(f"  第一拍在     = {r['firstBeatSec']} 秒")
        print(f"  每拍         = {r['beatPeriodSec']} 秒")
        print(f"  置信度       = {r['confidence']}   (拍点平均能量 / 全局平均;>1.5 比较可信)")
        print(f"  中点能量比   = {r['midpointRatio']}   ← {r['midpointHint']}")
        print(f"  识别到       = {r['beatCount']} 拍")
        print()
        print("下一步(让 DSH 调桥):")
        print(f'  align_audio {{firstBeatSec: {r["firstBeatSec"]}, bpm: {r["bpm"]}, '
              f'anchor: "measure", measure: 1}}')
    return 0


if __name__ == "__main__":
    sys.exit(main())
