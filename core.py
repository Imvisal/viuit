"""SimpleCut core: project model, ffmpeg export, ASS subtitles, Whisper captions.

No GUI code lives here, so everything can be tested from the command line.
"""
import json
import os
import re
import shutil
import subprocess
import sys

CREATE_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0

RESOLUTIONS = {"480p": (854, 480), "720p": (1280, 720), "1080p": (1920, 1080)}
QUALITY = {"Fast": ("veryfast", 23), "Balanced": ("medium", 20), "High": ("slow", 17)}


def have_ffmpeg():
    return bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def _run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True,
                          creationflags=CREATE_NO_WINDOW, **kw)


# --------------------------------------------------------------------------
# Project model (plain dicts so it saves straight to JSON)
# --------------------------------------------------------------------------

def new_project():
    return {
        "clips": [],     # {path, start, end, dur, has_audio, w, h}
        "audios": [],    # {path, offset, start, end, dur, volume}
        "texts": [],     # {text, start, end, x, y, size, color}
        "captions": [],  # {start, end, text}
        "cap_style": {"enabled": True, "size": 54, "color": "#FFFFFF",
                      "bottom": 8, "box": False},
    }


def probe(path):
    r = _run(["ffprobe", "-v", "error", "-print_format", "json",
              "-show_format", "-show_streams", path])
    if r.returncode != 0:
        raise RuntimeError("Cannot read file:\n" + r.stderr.strip())
    j = json.loads(r.stdout)
    info = {"dur": float(j.get("format", {}).get("duration") or 0),
            "has_video": False, "has_audio": False, "w": 0, "h": 0}
    for s in j.get("streams", []):
        if s["codec_type"] == "video" and not info["has_video"]:
            if s.get("disposition", {}).get("attached_pic"):
                continue
            info["has_video"] = True
            info["w"], info["h"] = int(s.get("width", 0)), int(s.get("height", 0))
            rot = 0
            for sd in s.get("side_data_list", []):
                rot = int(sd.get("rotation", rot) or 0)
            if abs(rot) in (90, 270):
                info["w"], info["h"] = info["h"], info["w"]
        elif s["codec_type"] == "audio":
            info["has_audio"] = True
    return info


def make_clip(path):
    i = probe(path)
    if not i["has_video"]:
        raise RuntimeError("That file has no video.")
    return {"path": os.path.abspath(path), "start": 0.0, "end": round(i["dur"], 3),
            "dur": i["dur"], "has_audio": i["has_audio"], "w": i["w"], "h": i["h"]}


def make_audio(path):
    i = probe(path)
    if not i["has_audio"]:
        raise RuntimeError("That file has no audio.")
    return {"path": os.path.abspath(path), "offset": 0.0, "start": 0.0,
            "end": round(i["dur"], 3), "dur": i["dur"], "volume": 100}


def total_duration(p):
    return sum(max(0.0, c["end"] - c["start"]) for c in p["clips"])


def output_size(p, res):
    long_, short = RESOLUTIONS[res]
    if p["clips"] and p["clips"][0]["h"] > p["clips"][0]["w"]:
        return short, long_  # portrait
    return long_, short


# --------------------------------------------------------------------------
# ASS subtitles (captions + text overlays are both drawn by libass)
# --------------------------------------------------------------------------

def _ass_color(hexs):
    h = hexs.lstrip("#")
    if len(h) != 6:
        h = "FFFFFF"
    return "&H00%s%s%s" % (h[4:6], h[2:4], h[0:2])


def _ass_time(t):
    t = max(0.0, t)
    cs = int(round(t * 100))
    return "%d:%02d:%02d.%02d" % (cs // 360000, cs // 6000 % 60, cs // 100 % 60, cs % 100)


def _ass_text(s):
    return s.replace("\\", "").replace("{", "(").replace("}", ")").replace("\n", "\\N")


def build_ass(p, W, H):
    """Return ASS text, or None when there is nothing to draw."""
    cs = p["cap_style"]
    scale = min(W, H) / 1080.0 if W < H else H / 1080.0
    cap_size = max(8, int(cs["size"] * scale))
    outline = max(1, round(cap_size * 0.07, 1))
    margin_v = int(H * cs["bottom"] / 100.0)
    margin_lr = int(W * 0.06)
    border_style = 3 if cs.get("box") else 1
    back = "&H80000000"
    lines = [
        "[Script Info]", "ScriptType: v4.00+", "PlayResX: %d" % W, "PlayResY: %d" % H,
        "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
        "[V4+ Styles]",
        "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,"
        "Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,"
        "Alignment,MarginL,MarginR,MarginV,Encoding",
        "Style: Caption,Arial,%d,%s,&H000000FF,&H00000000,%s,-1,0,0,0,100,100,0,0,%d,%s,0,2,%d,%d,%d,1"
        % (cap_size, _ass_color(cs["color"]), back, border_style, outline, margin_lr, margin_lr, margin_v),
        "Style: Text,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,0,5,10,10,10,1",
        "", "[Events]",
        "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
    ]
    n = 0
    if cs.get("enabled", True):
        for c in p["captions"]:
            if c["end"] > c["start"] and c["text"].strip():
                lines.append("Dialogue: 0,%s,%s,Caption,,0,0,0,,%s"
                             % (_ass_time(c["start"]), _ass_time(c["end"]), _ass_text(c["text"].strip())))
                n += 1
    for t in p["texts"]:
        if t["end"] > t["start"] and t["text"].strip():
            size = max(8, int(t["size"] * scale))
            x, y = int(W * t["x"] / 100.0), int(H * t["y"] / 100.0)
            tag = "{\\an5\\pos(%d,%d)\\fs%d\\c%s\\bord%s}" % (
                x, y, size, _ass_color(t["color"]), max(1, round(size * 0.05, 1)))
            lines.append("Dialogue: 1,%s,%s,Text,,0,0,0,,%s%s"
                         % (_ass_time(t["start"]), _ass_time(t["end"]), tag, _ass_text(t["text"].strip())))
            n += 1
    return "\n".join(lines) + "\n" if n else None


# --------------------------------------------------------------------------
# ffmpeg command building
# --------------------------------------------------------------------------

def _num(x):
    return ("%.3f" % x).rstrip("0").rstrip(".") or "0"


def _clip_chains(p, W, H, fps, with_video=True):
    parts, labels = [], []
    for i, c in enumerate(p["clips"]):
        s, e = _num(c["start"]), _num(c["end"])
        d = _num(c["end"] - c["start"])
        if with_video:
            parts.append(
                "[%d:v]trim=start=%s:end=%s,setpts=PTS-STARTPTS,"
                "scale=%d:%d:force_original_aspect_ratio=decrease,"
                "pad=%d:%d:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=%d,format=yuv420p[v%d]"
                % (i, s, e, W, H, W, H, fps, i))
        if c["has_audio"]:
            parts.append("[%d:a]atrim=start=%s:end=%s,asetpts=PTS-STARTPTS,aresample=44100,"
                         "aformat=sample_fmts=fltp:channel_layouts=stereo[a%d]" % (i, s, e, i))
        else:
            parts.append("anullsrc=r=44100:cl=stereo,atrim=duration=%s,asetpts=PTS-STARTPTS,"
                         "aformat=sample_fmts=fltp:channel_layouts=stereo[a%d]" % (d, i))
        labels.append(("[v%d]" % i if with_video else "") + "[a%d]" % i)
    n = len(p["clips"])
    parts.append("%sconcat=n=%d:v=%d:a=1%s" % ("".join(labels), n, 1 if with_video else 0,
                                                "[vc][ac]" if with_video else "[ac]"))
    return parts


def build_export_cmd(p, out_path, W, H, fps, quality, ass_name=None):
    """Full ffmpeg command. Run it with cwd set to the folder that holds ass_name."""
    preset, crf = QUALITY[quality]
    cmd = ["ffmpeg", "-y", "-hide_banner", "-nostats", "-progress", "pipe:1"]
    for c in p["clips"]:
        cmd += ["-i", c["path"]]
    for a in p["audios"]:
        cmd += ["-i", a["path"]]
    fc = _clip_chains(p, W, H, fps)
    fc.append("[vc]%s[vout]" % ("ass=%s" % ass_name if ass_name else "null"))
    n = len(p["clips"])
    mix = ["[ac]"]
    for j, a in enumerate(p["audios"]):
        k = n + j
        ms = int(max(0.0, a["offset"]) * 1000)
        fc.append("[%d:a]atrim=start=%s:end=%s,asetpts=PTS-STARTPTS,aresample=44100,"
                  "aformat=sample_fmts=fltp:channel_layouts=stereo,volume=%s,adelay=%d|%d[m%d]"
                  % (k, _num(a["start"]), _num(a["end"]), _num(a["volume"] / 100.0), ms, ms, j))
        mix.append("[m%d]" % j)
    if len(mix) > 1:
        fc.append("%samix=inputs=%d:duration=first:normalize=0:dropout_transition=0,alimiter=limit=0.95[aout]"
                  % ("".join(mix), len(mix)))
        amap = "[aout]"
    else:
        amap = "[ac]"
    cmd += ["-filter_complex", ";".join(fc), "-map", "[vout]", "-map", amap,
            "-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
            "-t", _num(total_duration(p)), os.path.abspath(out_path)]
    return cmd


def run_export(p, out_path, res, fps, quality, workdir, on_progress=None, proc_holder=None):
    """Blocking export. on_progress(fraction). Raises RuntimeError on failure."""
    if not p["clips"]:
        raise RuntimeError("Add at least one video first.")
    W, H = output_size(p, res)
    ass = build_ass(p, W, H)
    ass_name = None
    if ass:
        ass_name = "subs.ass"
        with open(os.path.join(workdir, ass_name), "w", encoding="utf-8") as f:
            f.write(ass)
    cmd = build_export_cmd(p, out_path, W, H, fps, quality, ass_name)
    total = max(0.1, total_duration(p))
    proc = subprocess.Popen(cmd, cwd=workdir, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, creationflags=CREATE_NO_WINDOW)
    if proc_holder is not None:
        proc_holder.append(proc)
    err_lines = []
    import threading
    t = threading.Thread(target=lambda: err_lines.extend(proc.stderr.readlines()), daemon=True)
    t.start()
    for line in proc.stdout:
        if line.startswith("out_time_us=") or line.startswith("out_time_ms="):
            try:
                sec = int(line.split("=")[1]) / 1_000_000.0
                if on_progress:
                    on_progress(min(1.0, max(0.0, sec / total)))
            except ValueError:
                pass
    proc.wait()
    t.join(timeout=2)
    if proc.returncode != 0:
        raise RuntimeError("ffmpeg failed:\n" + "".join(err_lines[-12:]))
    if on_progress:
        on_progress(1.0)


def render_preview(p, t, png_path, workdir, ph=360):
    """Render one frame of the project at timeline time t (with text + captions)."""
    W, H = output_size(p, "480p")
    W, H = (int(ph * W / H) // 2 * 2, ph) if W >= H else (ph, int(ph * H / W) // 2 * 2)
    ass = build_ass(p, W, H)
    vf = []
    src, seek = None, 0.0
    acc = 0.0
    for c in p["clips"]:
        d = c["end"] - c["start"]
        if t < acc + d or c is p["clips"][-1]:
            src, seek = c["path"], c["start"] + max(0.0, min(t - acc, d - 0.05))
            break
        acc += d
    base = ("scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2:black,setsar=1"
            % (W, H, W, H))
    vf.append(base)
    if ass:
        with open(os.path.join(workdir, "preview.ass"), "w", encoding="utf-8") as f:
            f.write(ass)
        vf.append("setpts=PTS-STARTPTS+%s/TB" % _num(t))
        vf.append("ass=preview.ass")
    if src:
        cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-ss", _num(seek), "-i", src,
               "-frames:v", "1", "-vf", ",".join(vf), os.path.abspath(png_path)]
    else:
        cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
               "color=c=black:s=%dx%d" % (W, H), "-frames:v", "1", os.path.abspath(png_path)]
    r = subprocess.run(cmd, cwd=workdir, capture_output=True, text=True, creationflags=CREATE_NO_WINDOW)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip()[-400:])


# --------------------------------------------------------------------------
# Auto captions (faster-whisper, runs fully offline after the first model download)
# --------------------------------------------------------------------------

def whisper_available():
    try:
        import faster_whisper  # noqa: F401
        return True
    except ImportError:
        return False


def extract_timeline_audio(p, wav_path):
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
    for c in p["clips"]:
        cmd += ["-i", c["path"]]
    fc = _clip_chains(p, 16, 16, 30, with_video=False)
    cmd += ["-filter_complex", ";".join(fc), "-map", "[ac]", "-ac", "1", "-ar", "16000", wav_path]
    r = _run(cmd)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip()[-400:])


def group_words(words, max_chars=32, max_gap=0.7, max_len=3.5):
    """words: list of (start, end, text). Returns caption dicts."""
    caps, cur = [], []

    def flush():
        if cur:
            text = "".join(w[2] for w in cur).strip()
            if text:
                caps.append({"start": round(cur[0][0], 2), "end": round(cur[-1][1], 2), "text": text})
            cur.clear()

    for w in words:
        if cur:
            cur_text = "".join(x[2] for x in cur)
            if (len(cur_text) + len(w[2]) > max_chars or w[0] - cur[-1][1] > max_gap
                    or w[1] - cur[0][0] > max_len):
                flush()
        cur.append(w)
        if re.search(r"[.!?。]$", w[2].strip()) and len("".join(x[2] for x in cur)) > 14:
            flush()
    flush()
    for i in range(len(caps) - 1):  # close tiny gaps so captions don't flicker
        if 0 < caps[i + 1]["start"] - caps[i]["end"] < 0.25:
            caps[i]["end"] = caps[i + 1]["start"]
    return caps


def generate_captions(p, workdir, model_size="base", language=None, on_status=None, cancel=None):
    from faster_whisper import WhisperModel
    if not p["clips"]:
        raise RuntimeError("Add a video first.")
    say = on_status or (lambda *_: None)
    say("Extracting audio...", 0.02)
    wav = os.path.join(workdir, "speech.wav")
    extract_timeline_audio(p, wav)
    say("Loading AI model (first time downloads it)...", 0.08)
    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    say("Listening...", 0.15)
    segments, _info = model.transcribe(wav, language=language, word_timestamps=True,
                                       vad_filter=True, beam_size=5)
    total = max(0.1, total_duration(p))
    words, caps = [], []
    for seg in segments:
        if cancel and cancel():
            raise RuntimeError("Cancelled")
        if getattr(seg, "words", None):
            for w in seg.words:
                words.append((w.start, w.end, w.word))
        else:
            caps.append({"start": round(seg.start, 2), "end": round(seg.end, 2), "text": seg.text.strip()})
        say("Listening...", 0.15 + 0.85 * min(1.0, seg.end / total))
    if words:
        caps = group_words(words) + caps
        caps.sort(key=lambda c: c["start"])
    return caps


# --------------------------------------------------------------------------
# Save / load
# --------------------------------------------------------------------------

def save_project(p, path):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(p, f, indent=2, ensure_ascii=False)


def load_project(path):
    with open(path, encoding="utf-8") as f:
        p = json.load(f)
    base = new_project()
    for k, v in base.items():
        p.setdefault(k, v)
    for k, v in base["cap_style"].items():
        p["cap_style"].setdefault(k, v)
    return p
