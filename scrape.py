# -*- coding: utf-8 -*-
"""给音频文件补内嵌封面 + 歌词（xiaomusic 只读内嵌标签）。

数据源：酷狗负责"确认是哪首歌"（按文件名搜 + 时长校验，文件都是酷狗源，命中极准），
        QQ 音乐负责封面（y.gtimg.cn CDN），酷狗负责带时间轴的 LRC 歌词。

用法：
    python scrape.py --scan            只读扫描，产出 /app/conf/scrape_plan.json
    python scrape.py --scan --limit 5  先试几首
    python scrape.py --apply --dry     演练写入（不落盘）
    python scrape.py --apply           真正写入（临时文件+校验+原子替换）
    python scrape.py --auto            一步到位：扫描 + 写入（已完整的文件自动跳过，
                                       新增音乐后直接跑这条就行）
"""
import argparse
import base64
import difflib
import json
import os
import re
import shutil
import time

import requests

MUSIC_DIR = "/app/music"
PLAN = "/app/conf/scrape_plan.json"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/122.0 Safari/537.36")
EXTS = (".flac", ".mp3")


# ---------------------------------------------------------------- 工具
def sim(a, b):
    if not a or not b:
        return 0.0
    return difflib.SequenceMatcher(None, a.lower(), b.lower()).ratio()


def norm(s):
    """规范化：酷狗会给文件名加【《xx》电影主题曲】这类后缀，必须先连内容一起去掉。"""
    s = (s or "").lower()
    s = re.sub(r"[\(\（\[【].*?[\)\）\]】]", "", s)
    return re.sub(r"[^\w\u4e00-\u9fff]", "", s)


def strip_ext(name):
    return os.path.splitext(os.path.basename(name))[0]


def read_meta(path):
    ext = os.path.splitext(path)[1].lower()
    m = {"ext": ext, "title": "", "artist": "", "album": "", "duration": 0.0,
         "has_cover": False, "has_lyric": False}
    if ext == ".flac":
        from mutagen.flac import FLAC
        a = FLAC(path)
        m["title"] = (a.get("title") or [""])[0]
        m["artist"] = (a.get("artist") or [""])[0]
        m["album"] = (a.get("album") or [""])[0]
        m["duration"] = (a.info.length if a.info else 0) or 0
        m["has_cover"] = bool(a.pictures)
        m["has_lyric"] = bool((a.get("lyrics") or [""])[0].strip())
    elif ext == ".mp3":
        from mutagen.id3 import ID3
        from mutagen.mp3 import MP3
        try:
            t = ID3(path)
        except Exception:
            t = None
        if t is not None:
            def one(k):
                v = t.getall(k)
                return str(v[0]) if v else ""
            m["title"] = one("TIT2")
            m["artist"] = one("TPE1")
            m["album"] = one("TALB")
            m["has_cover"] = bool(t.getall("APIC"))
            m["has_lyric"] = bool(one("USLT").strip())
        m["duration"] = MP3(path).info.length or 0
    return m


# ---------------------------------------------------------------- 数据源
def kg_search(kw, n=10):
    r = requests.get("http://mobilecdn.kugou.com/api/v3/search/song",
                     params={"format": "json", "keyword": kw, "page": 1, "pagesize": n},
                     headers={"User-Agent": UA}, timeout=12)
    return ((r.json().get("data") or {}).get("info")) or []


def kg_lyric(h, dur):
    try:
        r = requests.get("https://krcs.kugou.com/search",
                         params={"ver": 1, "man": "yes", "client": "mobi",
                                 "keyword": "", "duration": dur, "hash": h},
                         headers={"User-Agent": UA}, timeout=12)
        c = (r.json().get("candidates") or [])
        if not c:
            return ""
        c = c[0]
        r2 = requests.get("https://lyrics.kugou.com/download",
                          params={"ver": 1, "client": "pc", "id": c["id"],
                                  "accesskey": c["accesskey"], "fmt": "lrc", "charset": "utf8"},
                          headers={"User-Agent": UA}, timeout=12)
        return base64.b64decode(r2.json().get("content") or "").decode("utf-8", "replace")
    except Exception:
        return ""


def qq_cover(singer, song):
    """QQ 音乐按专辑取 500x500 封面。返回 (url, qq歌手)。"""
    try:
        r = requests.get("https://c.y.qq.com/soso/fcgi-bin/client_search_cp",
                         params={"w": "%s %s" % (singer, song), "format": "json", "n": 3, "p": 1},
                         headers={"User-Agent": UA, "Referer": "https://y.qq.com/"}, timeout=12)
        t = r.text.strip()
        if t.startswith("callback("):
            t = t[9:-1]
        lst = (((json.loads(t).get("data") or {}).get("song") or {}).get("list")) or []
        if not lst:
            return "", ""
        top = lst[0]
        mid = top.get("albummid") or ""
        ar = " / ".join(a.get("name", "") for a in (top.get("singer") or []))
        if not mid:
            return "", ar
        return "https://y.gtimg.cn/music/photo_new/T002R500x500M000%s.jpg" % mid, ar
    except Exception:
        return "", ""


def pick_kugou(cands, stem, dur):
    """按 时长差 + 文件名相似度 选，宁缺毋滥。"""
    best, bd, bs = None, 9e9, 0.0
    for s in cands:
        d = abs((s.get("duration") or 0) - dur)
        fn = s.get("filename") or ""
        sc = max(sim(stem, fn), sim(norm(stem), norm(fn)))
        if d < bd - 0.5 or (abs(d - bd) <= 0.5 and sc > bs):
            best, bd, bs = s, d, sc
    if not best:
        return None, 9e9, 0.0
    strong = (bd <= 2 and bs >= 0.80) or (bd <= 1 and bs >= 0.65) or (bs >= 0.95 and bd <= 8)
    return (best if strong else None), bd, bs


# ---------------------------------------------------------------- 扫描
def scan(limit=None):
    files = []
    for root, dirs, names in os.walk(MUSIC_DIR):
        dirs[:] = [d for d in dirs if d not in ("@eaDir", "@tmp", "tmp")]
        for n in sorted(names):
            if n.lower().endswith(EXTS):
                files.append(os.path.join(root, n))
    files.sort()
    if limit:
        files = files[:limit]

    plan, st = [], {"total": 0, "skip": 0, "need": 0, "ok": 0,
                    "cover": 0, "lyric": 0, "unmatched": 0}
    for i, path in enumerate(files, 1):
        rel = os.path.relpath(path, MUSIC_DIR)
        st["total"] += 1
        try:
            m = read_meta(path)
        except Exception as e:
            print("[%3d] 读取失败 %s: %r" % (i, rel, e))
            continue
        if m["has_cover"] and m["has_lyric"]:
            st["skip"] += 1
            plan.append({"path": path, "rel": rel, "action": "skip"})
            continue

        st["need"] += 1
        stem = strip_ext(path)
        e = {"path": path, "rel": rel, "action": "reject",
             "need_cover": not m["has_cover"], "need_lyric": not m["has_lyric"]}
        try:
            best, d, sc = pick_kugou(kg_search(stem), stem, m["duration"])
        except Exception as ex:
            e["reason"] = "搜索失败 %s" % str(ex)[:50]
            plan.append(e)
            print("[%3d] %-44s ERR %s" % (i, rel[:44], str(ex)[:40]))
            continue

        if not best:
            st["unmatched"] += 1
            e["reason"] = "未匹配到可靠结果"
            plan.append(e)
            print("[%3d] %-44s — 跳过（匹配不可靠）" % (i, rel[:44]))
            continue

        st["ok"] += 1
        e.update({"action": "write", "hit": best.get("filename"),
                  "hash": best.get("hash"), "kg_dur": best.get("duration"),
                  "dur_diff": round(d, 1), "name_sim": round(sc, 2),
                  "kg_singer": best.get("singername"), "kg_song": best.get("songname")})
        if e["need_lyric"]:
            ly = kg_lyric(best.get("hash"), best.get("duration"))
            if ly.strip():
                e["lyric"] = ly
                st["lyric"] += 1
        if e["need_cover"]:
            url, qq_ar = qq_cover(best.get("singername"), best.get("songname"))
            if url:
                e["cover"] = url
                e["qq_artist"] = qq_ar
                st["cover"] += 1
        print("[%3d] %-40s OK Δ%.0fs 名%.2f %s%s"
              % (i, rel[:40], d, sc,
                 "封面" if e.get("cover") else "",
                 " 歌词%d字" % len(e["lyric"]) if e.get("lyric") else ""))
        plan.append(e)
        time.sleep(0.08)

    with open(PLAN, "w", encoding="utf-8") as f:
        json.dump(plan, f, ensure_ascii=False, indent=1)

    print("\n=== 汇总 ===")
    print("文件 %(total)d | 已完整跳过 %(skip)d | 待处理 %(need)d" % st)
    print("可靠匹配 %(ok)d | 未匹配 %(unmatched)d | 封面 %(cover)d | 歌词 %(lyric)d" % st)
    print("plan ->", PLAN)


# ---------------------------------------------------------------- 写入
def write_one(path, cover_url, lyric, dry=False):
    img = b""
    if cover_url:
        r = requests.get(cover_url, headers={"User-Agent": UA}, timeout=20)
        if r.status_code == 200 and r.content[:3] == b"\xff\xd8\xff":
            img = r.content
    if not img and not lyric:
        return "无数据可写"

    ext = os.path.splitext(path)[1].lower()
    tmp = path + ".scrapetmp"
    shutil.copy2(path, tmp)
    try:
        if ext == ".flac":
            from mutagen.flac import FLAC, Picture
            a = FLAC(tmp)
            if lyric:
                a["lyrics"] = lyric
            if img:
                a.clear_pictures()
                p = Picture()
                p.type = 3
                p.mime = "image/jpeg"
                p.desc = "Cover"
                p.data = img
                a.add_picture(p)
            a.save()
            chk = FLAC(tmp)
            ok = ((not lyric or (chk.get("lyrics") or [""])[0].strip() == lyric.strip())
                  and (not img or bool(chk.pictures)))
        else:
            from mutagen.id3 import ID3, APIC, USLT, ID3NoHeaderError
            try:
                t = ID3(tmp)
            except ID3NoHeaderError:
                t = ID3()
            if lyric:
                t.delall("USLT")
                t.add(USLT(encoding=3, lang="eng", desc="", text=lyric))
            if img:
                t.delall("APIC")
                t.add(APIC(encoding=3, mime="image/jpeg", type=3, desc="Cover", data=img))
            t.save(tmp, v2_version=3)
            chk = ID3(tmp)
            ok = ((not lyric or bool(chk.getall("USLT")))
                  and (not img or bool(chk.getall("APIC"))))
        if not ok:
            raise RuntimeError("写入后校验不通过")
        if dry:
            os.remove(tmp)
            return "演练通过"
        os.replace(tmp, path)
        return "已写入(封面%s 歌词%s)" % ("✓" if img else "✗", "✓" if lyric else "✗")
    except Exception:
        try:
            os.remove(tmp)
        except Exception:
            pass
        raise


def apply(dry=False, limit=None):
    plan = json.load(open(PLAN, encoding="utf-8"))
    todo = [p for p in plan if p.get("action") == "write"]
    if limit:
        todo = todo[:limit]
    print("待写入 %d 个文件%s\n" % (len(todo), "（演练模式，不落盘）" if dry else ""))
    ok = fail = 0
    for i, p in enumerate(todo, 1):
        try:
            r = write_one(p["path"], p.get("cover"), p.get("lyric"), dry)
            ok += 1
            print("[%3d/%3d] %-44s %s" % (i, len(todo), p["rel"][:44], r))
        except Exception as e:
            fail += 1
            print("[%3d/%3d] %-44s 失败: %s" % (i, len(todo), p["rel"][:44], str(e)[:70]))
        time.sleep(0.05)
    print("\n完成：成功 %d，失败 %d" % (ok, fail))

    if not dry:
        try:
            r = requests.post("http://127.0.0.1:8090/refreshmusictag", timeout=30)
            print("刷新 xiaomusic 标签缓存:", r.status_code)
        except Exception as e:
            print("刷新缓存失败（可手动执行）：", str(e)[:80])


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--scan", action="store_true")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--auto", action="store_true",
                    help="扫描 + 写入一步完成，已完整的文件自动跳过")
    a = ap.parse_args()
    if a.auto:
        print("=== 扫描（已完整的文件会跳过，不联网）===")
        scan(a.limit)
        print("\n=== 写入 ===")
        apply(dry=False, limit=a.limit)
    elif a.apply or a.dry:
        apply(dry=a.dry, limit=a.limit)
    elif a.scan:
        scan(a.limit)
    else:
        ap.print_help()
