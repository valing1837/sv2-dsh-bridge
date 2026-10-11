"""把原唱人声的基频与工程里的音符逐个对照 —— 用客观数字回答"哪里唱得不对劲"。

为什么在 SV2 之外做:
    SV2 脚本 API 没有音频 I/O,也没法在宿主里做 DSP。这里的产出是**一张表**:
    每个音的"原唱是多少 / 工程是多少 / 差多少音分",然后才轮到人决定动不动手。

输入:
    --f0     track-f0.py 出来的 `time_sec,f0_hz,conf`
    --notes  桥 `get_layout` 的 JSON(整份结果,或只有 layout 数组;键用
             `onsetQuarter` / `durationQuarter` / `pitch`)

⚠️ 两条实测结论决定了怎么量(每一条在 --selftest 里都有断言):

    ① **先求时间轴偏移**。WAV 的 0 秒未必是工程的 0 拍。实测《風に吹かれて》偏移
       −0.02s 时"±80 音分内"命中最多(563/586)。偏移错了,后面全是错的 ——
       而且**错得很像八度错误**(在错误的时刻读到别的音),这一点骗过我一次。

    ② **目标音高必须取"滑入完成之后的稳定段"(45%~80%)**,不能用中段。
       人声大量音符是**从低处 scoop 上来**的:拿中段中位数当音高,会把一整批本来
       唱准的音判成"低了 100~180 音分"(实测:一堆 p=63 的音被量成 61.2~62.3),
       照这个去写音高曲线就是把整首往下拽。
       ⇒ 滑入交给音头,音准看稳定段。

用法:
    python compare-pitch.py --selftest
    python compare-pitch.py --notes layout.json --f0 vocal-f0.csv --bpm 90
    python compare-pitch.py --notes layout.json --f0 vocal-f0.csv --bpm 90 --out report.csv
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import sys

import numpy as np

STEADY_LO, STEADY_HI = 0.45, 0.80   # 稳定段(见文件头结论②)
OFFSET_RANGE = (-1.0, 4.0)
OFFSET_STEP = 0.02
MIN_FRAMES = 3                       # 一段里至少几帧才算数
FLAG_CENTS = 40.0                    # 超过它才报"可疑"
PLAUSIBLE_CENTS = 80.0               # 求偏移时认作"这个音对上了"


def parse_notes(obj):
    """接受整份 get_layout 结果或只有 layout 数组 → [{i,on,dur,p}]。"""
    layout = obj.get("layout") if isinstance(obj, dict) else obj
    if not isinstance(layout, list):
        raise SystemExit("notes JSON 里找不到 layout 数组")
    out = []
    for k, n in enumerate(layout):
        try:
            out.append(dict(i=int(n.get("index", k)),
                            on=float(n["onsetQuarter"]),
                            dur=float(n["durationQuarter"]),
                            p=int(n["pitch"])))
        except (KeyError, TypeError, ValueError):
            raise SystemExit(f"layout[{k}] 缺 onsetQuarter/durationQuarter/pitch")
    out.sort(key=lambda x: x["i"])
    return out


def load_f0(path):
    t, hz = [], []
    with open(path, encoding="utf-8") as f:
        r = csv.reader(f)
        head = next(r, None)
        if head is None or "time_sec" not in head[0]:
            raise SystemExit("F0 CSV 表头不对(应为 time_sec,f0_hz,conf)")
        for row in r:
            if len(row) < 2:
                continue
            t.append(float(row[0])); hz.append(float(row[1]))
    return np.asarray(t), np.asarray(hz)


def _hz_of_midi(m):
    return 440.0 * 2.0 ** ((m - 69) / 12.0)


def _cents(hz, midi):
    return 1200.0 * math.log2(hz / _hz_of_midi(midi))


def _median_cents(t, hz, t0, t1, midi, max_off=300.0):
    """[t0,t1) 内、离该音音高不超过 max_off 音分的帧的中位偏差;帧太少返回 None。"""
    a, b = np.searchsorted(t, t0), np.searchsorted(t, t1)
    vals = []
    for h in hz[a:b]:
        if h <= 0:
            continue
        c = _cents(h, midi)
        if abs(c) <= max_off:
            vals.append(c)
    if len(vals) < MIN_FRAMES:
        return None
    return float(np.median(vals))


def find_offset(notes, t, hz, bpm):
    """扫偏移,取"所有音的稳定段偏差最小"的那个。

    ⚠️ 评分必须**按接近程度加权**,不能只数"命中几个":实测(自检里就复现了)
    只用命中个数打分时,一整片偏移都并列满分 ⇒ argmax 落在第一个极大上(实测偏了
    −0.38s),而偏移一错,后面的取样窗口整体错位 —— 看起来就像"某个音低了 100 多音分"。
    这也正是实战里那个"差一个八度"的真凶。
    """
    q2s = 60.0 / bpm
    offs, scores = [], []
    off = OFFSET_RANGE[0]
    while off <= OFFSET_RANGE[1] + 1e-9:
        score, seen = 0.0, 0
        for n in notes:
            t0 = off + n["on"] * q2s
            t1 = t0 + n["dur"] * q2s
            lo, hi = t0 + STEADY_LO * (t1 - t0), t0 + STEADY_HI * (t1 - t0)
            c = _median_cents(t, hz, lo, hi, n["p"], PLAUSIBLE_CENTS)
            if c is None:
                continue
            seen += 1
            if abs(c) <= PLAUSIBLE_CENTS:
                # ⚠️ 按**帧数**加权:长音证据多、短音证据少。
                #    不加权时几个短音就能把平台拉斜,偏移估计会偏出 ±0.1s ——
                #    而偏移一偏,后面每个音的取样窗口都跟着偏。
                w = max(1, int(np.searchsorted(t, hi) - np.searchsorted(t, lo)))
                score += w * (PLAUSIBLE_CENTS - abs(c))
        offs.append(off); scores.append(score)
        off += OFFSET_STEP
    if not scores:
        return 0.0, 0.0
    best = max(scores)
    # ⚠️ 最优点常常是**一段平台**(稳定段本来就有一段是平的)⇒ 取平台中点,
    #    而不是第一个极大。取边缘会让后面的取样窗口整体错位,看起来像"某音低了一百多音分"。
    plateau = [o for o, s in zip(offs, scores) if s >= best - 1e-9]
    return float(np.median(plateau)), best


def measure(notes, t, hz, bpm, offset, steady=True, min_frames=MIN_FRAMES):
    """逐音量偏差。steady=False 时用中段(用来演示结论②的错误量法)。"""
    q2s = 60.0 / bpm
    rows = []
    for n in notes:
        t0 = offset + n["on"] * q2s
        t1 = t0 + n["dur"] * q2s
        span = t1 - t0
        if steady:
            lo, hi = t0 + STEADY_LO * span, t0 + STEADY_HI * span
        else:
            lo, hi = t0 + 0.30 * span, t1 - 0.30 * span
        c = _median_cents(t, hz, lo, hi, n["p"])
        rows.append(dict(index=n["i"], at=n["on"], dur=n["dur"], note=n["p"],
                         cents=c, ok=c is not None))
    return rows


def summarize(rows, flag=FLAG_CENTS):
    have = [r for r in rows if r["ok"]]
    devs = sorted(abs(r["cents"]) for r in have)
    out = {
        "total": len(rows),
        "measured": len(have),
        "median_abs": devs[len(devs) // 2] if devs else None,
        "within30": sum(1 for d in devs if d <= 30.0),
        "flagged": [r for r in have if abs(r["cents"]) > flag],
    }
    return out


# ---- 自检 -------------------------------------------------------------------
def selftest() -> int:
    bad = 0

    def check(name, ok, detail=""):
        nonlocal bad
        if ok:
            print(f"  OK   {name}")
        else:
            bad += 1
            print(f"  FAIL {name}  {detail}")

    print("compare-pitch --selftest")
    bpm = 90.0
    q2s = 60.0 / bpm
    # 四段:准 / **短音**从低处 scoop / 整段低 50 音分(真错) / 准
    # ⚠️ scoop 那个音必须是**短音**(0.3 拍 ≈ 0.2s):实战里被误报的正是这种
    #    (8~13 帧 = 80~130ms)。长音里滑入只占一小截,中段量法自然也偏不了多少,
    #    那样的合成用例证明不了"稳定段必须换"。
    notes = [dict(i=0, on=0.0, dur=1.0, p=60),
             dict(i=1, on=1.0, dur=0.25, p=62),
             dict(i=2, on=2.0, dur=1.0, p=64),
             dict(i=3, on=3.0, dur=1.0, p=65)]

    dt = 0.005
    t = np.arange(0.0, 4.2, dt)
    hz = np.zeros_like(t)
    for k, n in enumerate(notes):
        a = int(n["on"] * q2s / dt)
        b = int((n["on"] + n["dur"]) * q2s / dt)
        base = _hz_of_midi(n["p"])
        seg = t[a:b]
        # 每个音都带 ±12 音分的轻颤音 —— 真实的稳定段不是一条直线。
        # ⚠️ 没有它,分段常量信号会让"偏移评分"出现一整片平台(取到平台边缘 ⇒
        #    后面所有取样窗口整体错位,看起来就像"某个音低了一百多音分")。
        vib = 12.0 * np.sin(2 * np.pi * 5.0 * (seg - seg[0]))
        if k == 1:
            rel = (seg - seg[0]) / max(1e-9, seg[-1] - seg[0])
            ramp = np.clip(rel / 0.70, 0.0, 1.0)
            cents = -150.0 * (1.0 - ramp) + vib
        elif k == 2:
            cents = np.full_like(seg, -50.0) + vib
        else:
            cents = vib
        hz[a:b] = base * 2.0 ** (cents / 1200.0)

    off, score = find_offset(notes, t, hz, bpm)
    check("偏移搜索找到 ~0s", abs(off) <= 0.05, f"got {off:+.2f}")
    check("评分是正的(确实对上了)", score > 0, f"got {score:.1f}")

    rows = measure(notes, t, hz, bpm, off, steady=True)
    s = summarize(rows)
    flagged = {r["index"] for r in s["flagged"]}
    check("整段低 50 音分的音被报出来", 2 in flagged, f"flagged={sorted(flagged)}")
    check("两个准的音不被报", not ({0, 3} & flagged), f"flagged={sorted(flagged)}")

    naive = measure(notes, t, hz, bpm, off, steady=False)
    check("[结论②] 稳定段量法比中段量法更接近真值(scoop 那个音)",
          abs(rows[1]["cents"]) < abs(naive[1]["cents"]),
          f"稳定段 {rows[1]['cents']:+.0f} vs 中段 {naive[1]['cents']:+.0f}")
    # 反证:中段量法必须真的偏 —— 否则上面那条"更好"是空的
    check("[结论② 的反证] 中段量法在 scoop 上确实偏得更远",
          abs(naive[1]["cents"]) > abs(rows[1]["cents"]) + 10.0,
          f"中段 {naive[1]['cents']:+.0f} vs 稳定段 {rows[1]['cents']:+.0f}")

    print(f"\ncompare-pitch: {'全部通过' if bad == 0 else str(bad) + ' 条失败'}")
    return 1 if bad else 0


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="原唱基频 vs 工程音符 的逐音对照")
    ap.add_argument("--notes", help="get_layout 的 JSON")
    ap.add_argument("--f0", help="track-f0.py 输出的 CSV")
    ap.add_argument("--bpm", type=float, default=90.0)
    ap.add_argument("--out", help="写逐音明细 CSV")
    ap.add_argument("--flag", type=float, default=FLAG_CENTS,
                    help=f"报可疑的阈值(音分,默认 {FLAG_CENTS:.0f})")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest:
        return selftest()
    if not args.notes or not args.f0:
        ap.error("需要 --notes 与 --f0,或用 --selftest")

    notes = parse_notes(json.load(open(args.notes, encoding="utf-8")))
    t, hz = load_f0(args.f0)
    off, score = find_offset(notes, t, hz, args.bpm)
    print("音符 %d 个 · 最佳偏移 %+.2fs(贴合分 %.0f)" % (len(notes), off, score))
    rows = measure(notes, t, hz, args.bpm, off)
    s = summarize(rows, args.flag)
    if s["median_abs"] is not None:
        print("测得 %d 个:偏差中位 %.1f 音分 · ±30 音分内 %d 个(%.0f%%)"
              % (s["measured"], s["median_abs"], s["within30"],
                 100.0 * s["within30"] / max(1, s["measured"])))
    print("超过 %.0f 音分的 %d 个:" % (args.flag, len(s["flagged"])))
    for r in sorted(s["flagged"], key=lambda x: -abs(x["cents"])):
        print("  #%-4d %8.2f 拍  p=%-3d  %+7.1f 音分"
              % (r["index"], r["at"], r["note"], r["cents"]))

    if args.out:
        with open(args.out, "w", encoding="utf-8", newline="") as f:
            w = csv.writer(f)
            w.writerow(["index", "onset_q", "dur_q", "note_pitch", "cents_dev", "measured"])
            for r in rows:
                w.writerow([r["index"], r["at"], r["dur"], r["note"],
                            "" if r["cents"] is None else "%.1f" % r["cents"],
                            1 if r["ok"] else 0])
        print("写了", args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
