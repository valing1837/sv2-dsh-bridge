"""从人声(干声)提基频(F0)时间线 —— 用来和工程里的音符逐个对照。

为什么在 SV2 之外做:
    SV2 脚本 API 没有音频 I/O(官方 26 个类里没有),所以桥读不了波形。

为什么自己写(不用 librosa / pyin):
    环境里只有 numpy;而且这件事的难点**不在"算得多准"**,在于别掉进两个坑里 ——
    两个坑都是实测踩出来的,各自在这个文件里留了一条会失败的断言。

    ⚠️ 坑①(采样率):抽 3 取 1 得到的**实际**采样率是 sr/3(=14700),不是目标 16000。
       拿目标值去换算,整条时间线会被压缩、音高整体偏高 —— 实测 274.32s 的音频算成
       252.03s(比值 14700/16000 = 0.919),音高偏 +1.5 个半音。
       ⇒ 时间与频率**都必须用实际速率**(`_decimate` 把它一起返回)。
       ⚠️⚠️ 这条坑还有一层**更贵**的后果:时间线压缩之后,逐音对照会在**错误的时刻**
       取样 —— 于是读到的是**别的音**的音高。实测表现为"某个音低了整整一个八度
       (−1198 音分)",我一度以为是自相关锁半频,查到底才发现主因是**采样窗口错位**。
       ⇒ 看到"差一个八度"时,先怀疑时间轴,再怀疑基频提取。
    ⚠️ 坑②(半频/八度):两个候选相关峰接近时,`argmax` 可能选到低八度。
       抑制规则:短滞后处只要有 ≥90% 的峰,就取高频那个。
       实测效果**有限但真实**:同一段音频(工程音高 466.16Hz)抑制关 415.8Hz → 抑制开
       425.3Hz,即救回约 40 音分。
       ⚠️ 它的代价与边界:**信号里真的含半频成分时,报半频是正确的信号处理**
       (合成实验:466Hz 叠 0.15 幅度半频 ⇒ 开关抑制都报 233Hz,那是对的)。
       ⇒ 唱歌干声通常基频很强,但**边界情况请用频谱复核** —— 见 docs/音高对照.md §3.1。

算法:FFT 自相关(逐帧)+ 抛物线插值细化 + 半频抑制。

用法:
    python track-f0.py --selftest
    python track-f0.py 人声.wav out.csv [--sr 16000] [--fmin 65] [--fmax 700]
"""
from __future__ import annotations

import argparse
import os
import struct
import sys
import wave

import numpy as np

FRAME_SEC = 0.040
HOP_SEC = 0.010
RMS_GATE = 0.004          # 低于这个能量当静音(人声干声实测:浊音段远高于它)
SUBHARMONIC_RATIO = 0.90  # 短滞后峰达到长滞后峰的多少比例就改取高频


def read_wav_bytes(buf: bytes):
    """解析 RIFF/WAV 字节 → (单声道 float32, 采样率)。

    ⚠️ 为什么不用标准库 `wave`:它**不支持 IEEE float WAV**(format tag 3),
    而分离工具(实测:MSST 系)导出的正是 float32。所以这里自己走块。
    只认 WAV,但覆盖 16/24/32 位 PCM 与 32/64 位 float。
    """
    if len(buf) < 44 or buf[0:4] != b"RIFF" or buf[8:12] != b"WAVE":
        raise SystemExit("不是 RIFF/WAVE 数据")

    p, fmt, ch, sr, bits, data_off, data_size = 12, 1, 1, 44100, 16, 0, 0
    while p + 8 <= len(buf):
        cid = buf[p:p + 4]
        sz = struct.unpack_from("<I", buf, p + 4)[0]
        if cid == b"fmt ":
            fmt, ch, sr, _, _, bits = struct.unpack_from("<HHIIHH", buf, p + 8)
            if fmt == 0xFFFE and sz >= 40:      # WAVE_FORMAT_EXTENSIBLE
                fmt = struct.unpack_from("<H", buf, p + 8 + 24)[0]
        elif cid == b"data":
            data_off, data_size = p + 8, sz
            break
        p += 8 + sz + (sz % 2)
    if not data_off:
        raise SystemExit("WAV 里没有 data 块")
    data_size = min(data_size, len(buf) - data_off)
    body = buf[data_off:data_off + data_size]

    if fmt == 3:
        dt = {32: "<f4", 64: "<f8"}.get(bits)
        if dt is None:
            raise SystemExit(f"不支持的 float 位深: {bits}")
        x = np.frombuffer(body, dtype=dt).astype(np.float32)
    elif fmt == 1:
        if bits == 24:
            a = np.frombuffer(body, dtype=np.uint8).reshape(-1, 3)
            v = (a[:, 0].astype(np.int32) | (a[:, 1].astype(np.int32) << 8)
                 | (a[:, 2].astype(np.int8).astype(np.int32) << 16))
            x = v.astype(np.float32) / 8388608.0
        elif bits in (16, 32):
            dt = "<i2" if bits == 16 else "<i4"
            x = np.frombuffer(body, dtype=dt).astype(np.float32) / float(2 ** (bits - 1))
        else:
            raise SystemExit(f"不支持的 PCM 位深: {bits}")
    else:
        raise SystemExit(f"不支持的 WAV 格式 tag: {fmt}")

    n = (len(x) // ch) * ch
    x = x[:n].reshape(-1, ch).mean(axis=1)
    return x.astype(np.float32), int(sr)


def read_wav_mono(path: str):
    with open(path, "rb") as f:
        return read_wav_bytes(f.read())


def _decimate(x: np.ndarray, sr: int, target: int):
    """滑动平均抗混叠 + 抽取。返回 (信号, **实际**采样率)。

    ⚠️ 实际速率必须一起返回 —— 坑①的来源就是它(sr/3 = 14700 ≠ 16000)。
    """
    k = max(1, int(round(sr / float(target))))
    if k == 1:
        return x, float(sr)
    ker = np.ones(k, dtype=np.float32) / k
    y = np.convolve(x, ker, mode="same")
    return y[::k].astype(np.float32), float(sr) / k


def f0_track(x: np.ndarray, sr: float, fmin=65.0, fmax=700.0):
    """逐帧 F0 → (时间秒, 频率Hz, 归一化相关峰) 的数组;静音帧频率为 0。"""
    fl, hl = int(FRAME_SEC * sr), int(HOP_SEC * sr)
    if fl < 8 or len(x) < fl:
        return np.zeros((0, 3))
    lo, hi = max(1, int(sr / fmax)), min(fl - 2, int(sr / fmin))
    nfft = 1
    while nfft < 2 * fl:
        nfft *= 2
    win = np.hanning(fl).astype(np.float32)

    n = 1 + (len(x) - fl) // hl
    out = np.empty((n, 3), dtype=np.float64)
    for i in range(n):
        s = i * hl
        seg = x[s:s + fl]
        seg = seg - seg.mean()
        rms = float(np.sqrt(np.mean(seg * seg)))
        if rms < RMS_GATE:
            out[i] = (s / sr, 0.0, 0.0)
            continue
        spec = np.fft.rfft(seg * win, nfft)
        ac = np.fft.irfft(spec * np.conj(spec))[:fl]
        if ac[0] <= 0:
            out[i] = (s / sr, 0.0, 0.0)
            continue
        ac = ac / ac[0]
        k = int(np.argmax(ac[lo:hi])) + lo
        # 坑②:两个候选峰接近时 argmax 可能选到低八度。从最高频候选往下试,
        # 短滞后峰够高就取它。⚠️ 实测只值约 40 音分(见文件头),不是万能药。
        for div in (4, 3, 2):
            kk = int(round(k / div))
            if kk < lo:
                continue
            a2, b2 = max(lo, kk - 2), min(hi, kk + 3)
            j = a2 + int(np.argmax(ac[a2:b2]))
            if ac[j] >= SUBHARMONIC_RATIO * ac[k]:
                k = j
                break
        if k <= 0 or k >= len(ac) - 1:
            out[i] = (s / sr, 0.0, 0.0)
            continue
        a, b, c = ac[k - 1], ac[k], ac[k + 1]
        den = a - 2 * b + c
        d = (a - c) / (2 * den) if den != 0 else 0.0
        kk = k + d
        out[i] = (s / sr, sr / kk if kk > 0 else 0.0, float(b))
    return out


def track_file(path: str, target_sr=16000, fmin=65.0, fmax=700.0):
    x, sr = read_wav_mono(path)
    y, sr_eff = _decimate(x, sr, target_sr)
    return f0_track(y, sr_eff, fmin, fmax), float(len(x) / sr), sr_eff


def write_csv(rows, path: str):
    with open(path, "w", encoding="utf-8") as f:
        f.write("time_sec,f0_hz,conf\n")
        for t, hz, cf in rows:
            f.write("%.3f,%.2f,%.3f\n" % (t, hz, cf))


def _wav_bytes(x: np.ndarray, sr: int) -> bytes:
    """把 float32 波形编成 16 位 PCM WAV 字节(纯内存,不落盘)。

    ⚠️ 自检刻意**不建临时文件**:仓库里 `analyze-audio.py` 的自检也是纯内存,
    这样在任何沙箱/CI 里都能跑(实测有的环境禁止往新建临时目录写)。
    """
    import io
    import wave as _w
    buf = io.BytesIO()
    with _w.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
    return buf.getvalue()


# ---- 自检 -------------------------------------------------------------------
def _tone(f0, dur, sr, harmonics=((1, 1.0), (2, 0.5), (3, 0.25)), amp=0.3):
    t = np.arange(int(dur * sr)) / sr
    x = np.zeros_like(t)
    for k, a in harmonics:
        x += a * np.sin(2 * np.pi * f0 * k * t)
    return (amp * x).astype(np.float32)


def selftest() -> int:
    bad = 0

    def check(name, ok, detail=""):
        nonlocal bad
        if ok:
            print(f"  OK   {name}")
        else:
            bad += 1
            print(f"  FAIL {name}  {detail}")

    print("track-f0 --selftest")

    # ① 坑①:时间线必须等于音频真实时长(走 44100 → 抽 3 取 1 = 14700 这条真实路径)
    sr_in, dur = 44100, 3.0
    raw = _tone(220.0, dur, sr_in)
    blob = _wav_bytes(raw, sr_in)
    x, sr = read_wav_bytes(blob)
    check("自检走的 WAV 能被自己的解析器读回", sr == sr_in and abs(len(x) / sr - dur) < 1e-6,
          f"sr={sr} n={len(x)}")
    y, sr_eff = _decimate(x, sr, 16000)
    check("抽 3 取 1 后实际速率是 14700(不是 16000)",
          abs(sr_eff - 14700.0) < 1.0, f"got {sr_eff}")
    dur_eff = len(y) / sr_eff
    check("[坑①] 分析信号的长度仍等于音频真实时长(用错速率会算成 2.76s)",
          abs(dur_eff - dur) < 0.02, f"got {dur_eff:.3f}")
    rows = f0_track(y, sr_eff)
    last_t = float(rows[-1, 0]) if len(rows) else 0.0
    check("[坑①] 最后一帧的时间戳 ≈ 3.0s(时间线版本)",
          abs(last_t - dur) < 0.05, f"last={last_t:.3f}")

    # ② 音高精度:220Hz 必须报 ≈220(两个方向都不许差一个八度)
    voiced = rows[rows[:, 1] > 0, 1]
    check("有浊音帧", len(voiced) > 100, f"got {len(voiced)}")
    if len(voiced):
        med = float(np.median(voiced))
        cents = 1200 * np.log2(med / 220.0)
        check("220Hz 报成 220Hz(±20 音分内)", abs(cents) <= 20.0,
              f"got {med:.2f}Hz ({cents:+.0f} cents)")

    # ③ 坑②的另一面:真·低八度的信号必须报低八度(半频抑制不许把 110 顶到 220)
    y2, sr2 = _decimate(_tone(110.0, 1.5, sr_in), sr_in, 16000)
    rows2 = f0_track(y2, sr2)
    v2 = rows2[rows2[:, 1] > 0, 1]
    if len(v2):
        med2 = float(np.median(v2))
        check("110Hz 报成 110Hz(半频抑制不许把它顶到 220)",
              abs(1200 * np.log2(med2 / 110.0)) <= 25.0, f"got {med2:.2f}Hz")

    print(f"\ntrack-f0: {'全部通过' if bad == 0 else str(bad) + ' 条失败'}")
    return 1 if bad else 0


def main() -> int:
    # 控制台编码兜底:Windows 默认 GBK,断言文字里的非 GBK 字符(例如 ⚠️)
    # 会直接抛 UnicodeEncodeError —— 工具的输出必须能在默认控制台打出来。
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="从人声提基频(自相关 + 半频抑制)")
    ap.add_argument("wav", nargs="?", help="人声 WAV")
    ap.add_argument("out", nargs="?", help="输出 CSV")
    ap.add_argument("--sr", type=int, default=16000, help="分析采样率(默认 16000)")
    ap.add_argument("--fmin", type=float, default=65.0)
    ap.add_argument("--fmax", type=float, default=700.0)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest:
        return selftest()
    if not args.wav or not args.out:
        ap.error("需要 <wav> <out.csv>,或用 --selftest")

    rows, dur, sr_eff = track_file(args.wav, args.sr, args.fmin, args.fmax)
    write_csv(rows, args.out)
    voiced = int((rows[:, 1] > 0).sum()) if len(rows) else 0
    print("音频 %.2fs → 分析速率 %.0fHz · %d 帧(浊音 %d,%.1f%%)"
          % (dur, sr_eff, len(rows), voiced, 100.0 * voiced / max(1, len(rows))))
    print("写了", args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
