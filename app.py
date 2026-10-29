"""viuit - a small desktop video editor. Run:  python app.py"""
import os
import queue
import shutil
import tempfile
import threading
import tkinter as tk
from tkinter import colorchooser, filedialog, messagebox, ttk

import core

VIDEO_TYPES = [("Video", "*.mp4 *.mov *.mkv *.avi *.webm *.m4v"), ("All files", "*.*")]
AUDIO_TYPES = [("Audio / video", "*.mp3 *.wav *.m4a *.aac *.ogg *.flac *.mp4 *.mov"), ("All files", "*.*")]


def fmt(t):
    t = max(0, t)
    return "%d:%04.1f" % (int(t // 60), t % 60)


def fnum(s, default=0.0):
    try:
        return float(str(s).strip())
    except ValueError:
        return default


def ask_fields(parent, title, fields):
    """fields: list of (label, default[, 'color']). Returns list of strings or None."""
    win = tk.Toplevel(parent)
    win.title(title)
    win.transient(parent)
    win.resizable(False, False)
    frm = ttk.Frame(win, padding=14)
    frm.pack()
    vars_ = []
    for r, f in enumerate(fields):
        ttk.Label(frm, text=f[0]).grid(row=r, column=0, sticky="w", pady=4, padx=(0, 10))
        v = tk.StringVar(value=str(f[1]))
        e = ttk.Entry(frm, textvariable=v, width=34)
        e.grid(row=r, column=1, pady=4)
        if r == 0:
            e.focus_set()
        if len(f) > 2 and f[2] == "color":
            def pick(v=v):
                c = colorchooser.askcolor(color=v.get(), parent=win)[1]
                if c:
                    v.set(c)
            ttk.Button(frm, text="Pick", width=5, command=pick).grid(row=r, column=2, padx=(6, 0))
        vars_.append(v)
    result = []

    def ok(_e=None):
        result.append([v.get() for v in vars_])
        win.destroy()

    bar = ttk.Frame(frm)
    bar.grid(row=len(fields), column=0, columnspan=3, pady=(10, 0), sticky="e")
    ttk.Button(bar, text="Cancel", command=win.destroy).pack(side="right", padx=(6, 0))
    ttk.Button(bar, text="OK", command=ok).pack(side="right")
    win.bind("<Return>", ok)
    win.bind("<Escape>", lambda e: win.destroy())
    win.grab_set()
    parent.wait_window(win)
    return result[0] if result else None


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("viuit")
        self.geometry("1180x780")
        self.minsize(980, 680)
        self.p = core.new_project()
        self.proj_path = None
        self.work = tempfile.mkdtemp(prefix="viuit_")
        self.playhead = 0.0
        self.q = queue.Queue()
        self.export_proc = []
        self.cancel_flag = False
        self.preview_busy = False
        self.preview_again = False
        self.photo = None
        self._style()
        self._menu()
        self._layout()
        self.protocol("WM_DELETE_WINDOW", self._close)
        self.after(100, self._poll)
        self.refresh()
        if not core.have_ffmpeg():
            messagebox.showwarning("FFmpeg missing",
                                   "FFmpeg was not found. Install it and make sure 'ffmpeg' and 'ffprobe' "
                                   "work in a terminal, then restart SimpleCut.")

    # ---------------------------------------------------------------- setup
    def _style(self):
        st = ttk.Style(self)
        try:
            st.theme_use("clam")
        except tk.TclError:
            pass
        self.configure(bg="#1d1f24")
        st.configure(".", background="#262930", foreground="#e8e8ec", fieldbackground="#33363f",
                     font=("Segoe UI", 10))
        st.configure("TNotebook", background="#1d1f24", borderwidth=0)
        st.configure("TNotebook.Tab", padding=(14, 6), background="#2e3139")
        st.map("TNotebook.Tab", background=[("selected", "#262930")])
        st.configure("TButton", padding=(10, 5), background="#3b3f4a")
        st.map("TButton", background=[("active", "#4a4f5c")])
        st.configure("Accent.TButton", background="#e8832a", foreground="#101010", font=("Segoe UI", 10, "bold"))
        st.map("Accent.TButton", background=[("active", "#f39a45")])
        st.configure("Horizontal.TProgressbar", background="#e8832a", troughcolor="#33363f")

    def _menu(self):
        m = tk.Menu(self)
        f = tk.Menu(m, tearoff=0)
        f.add_command(label="New project", command=self.new)
        f.add_command(label="Open project...", command=self.open_proj)
        f.add_command(label="Save project", command=self.save_proj)
        f.add_command(label="Save project as...", command=lambda: self.save_proj(True))
        f.add_separator()
        f.add_command(label="Quit", command=self._close)
        m.add_cascade(label="File", menu=f)
        self.config(menu=m)

    def _layout(self):
        top = ttk.Frame(self)
        top.pack(fill="both", expand=True, padx=8, pady=(8, 4))
        top.columnconfigure(0, weight=3)
        top.columnconfigure(1, weight=2)
        top.rowconfigure(0, weight=1)

        # ---- preview
        left = ttk.Frame(top)
        left.grid(row=0, column=0, sticky="nsew", padx=(0, 8))
        left.rowconfigure(0, weight=1)
        left.columnconfigure(0, weight=1)
        self.pv = tk.Label(left, bg="black", text="Add a video to start", fg="#888")
        self.pv.grid(row=0, column=0, sticky="nsew")
        bar = ttk.Frame(left)
        bar.grid(row=1, column=0, sticky="ew", pady=(6, 0))
        bar.columnconfigure(1, weight=1)
        self.tlabel = ttk.Label(bar, text="0:00.0 / 0:00.0", width=16)
        self.tlabel.grid(row=0, column=0)
        self.scale = ttk.Scale(bar, from_=0, to=1, command=self._scrub)
        self.scale.grid(row=0, column=1, sticky="ew", padx=8)
        self.scale.bind("<ButtonRelease-1>", lambda e: self.update_preview())
        ttk.Button(bar, text="Play preview", command=self.play_preview).grid(row=0, column=2)

        # ---- tabs
        nb = ttk.Notebook(top)
        nb.grid(row=0, column=1, sticky="nsew")
        self.lb = {}
        self._tab_videos(nb)
        self._tab_audio(nb)
        self._tab_text(nb)
        self._tab_captions(nb)

        # ---- timeline
        self.tl = tk.Canvas(self, height=150, bg="#1a1c20", highlightthickness=0)
        self.tl.pack(fill="x", padx=8, pady=4)
        self.tl.bind("<Button-1>", self._tl_click)
        self.tl.bind("<B1-Motion>", self._tl_click)
        self.tl.bind("<ButtonRelease-1>", lambda e: self.update_preview())
        self.tl.bind("<Configure>", lambda e: self.draw_timeline())

        # ---- export bar
        ex = ttk.Frame(self, padding=(8, 4, 8, 10))
        ex.pack(fill="x")
        self.res = tk.StringVar(value="1080p")
        self.fps = tk.StringVar(value="30")
        self.qual = tk.StringVar(value="Balanced")
        for lbl, var, vals, w in (("Resolution", self.res, list(core.RESOLUTIONS), 7),
                                  ("FPS", self.fps, ["24", "30", "60"], 5),
                                  ("Quality", self.qual, list(core.QUALITY), 9)):
            ttk.Label(ex, text=lbl).pack(side="left", padx=(0, 4))
            ttk.Combobox(ex, textvariable=var, values=vals, width=w, state="readonly").pack(side="left", padx=(0, 14))
        self.export_btn = ttk.Button(ex, text="Export MP4", style="Accent.TButton", command=self.export)
        self.export_btn.pack(side="right")
        self.cancel_btn = ttk.Button(ex, text="Cancel", command=self.cancel_export)
        self.status = ttk.Label(ex, text="", width=26, anchor="e")
        self.status.pack(side="right", padx=10)
        self.prog = ttk.Progressbar(ex, length=220, maximum=1.0)
        self.prog.pack(side="right")

    def _listbox(self, parent, key):
        fr = ttk.Frame(parent)
        lb = tk.Listbox(fr, bg="#33363f", fg="#e8e8ec", selectbackground="#e8832a", selectforeground="#101010",
                        highlightthickness=0, bd=0, activestyle="none", font=("Segoe UI", 10))
        sb = ttk.Scrollbar(fr, command=lb.yview)
        lb.config(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        lb.pack(side="left", fill="both", expand=True)
        self.lb[key] = lb
        return fr, lb

    def _buttons(self, parent, items):
        bar = ttk.Frame(parent)
        for text, cmd in items:
            ttk.Button(bar, text=text, command=cmd).pack(side="left", padx=(0, 6))
        return bar

    def _tab_videos(self, nb):
        t = ttk.Frame(nb, padding=8)
        nb.add(t, text="Videos")
        ttk.Label(t, text="Clips play one after another.").pack(anchor="w", pady=(0, 6))
        fr, lb = self._listbox(t, "clips")
        self._buttons(t, [("Add video", self.add_video), ("Trim", self.trim_clip), ("Up", lambda: self.move_clip(-1)),
                          ("Down", lambda: self.move_clip(1)), ("Remove", self.rm_clip)]).pack(side="bottom", anchor="w", pady=(8, 0))
        fr.pack(fill="both", expand=True)
        lb.bind("<Double-Button-1>", lambda e: self.trim_clip())

    def _tab_audio(self, nb):
        t = ttk.Frame(nb, padding=8)
        nb.add(t, text="Sound")
        ttk.Label(t, text="Music or voice-over mixed over the video.").pack(anchor="w", pady=(0, 6))
        fr, lb = self._listbox(t, "audios")
        self._buttons(t, [("Add sound", self.add_audio), ("Edit", self.edit_audio), ("Remove", self.rm_audio)]
                      ).pack(side="bottom", anchor="w", pady=(8, 0))
        fr.pack(fill="both", expand=True)
        lb.bind("<Double-Button-1>", lambda e: self.edit_audio())

    def _tab_text(self, nb):
        t = ttk.Frame(nb, padding=8)
        nb.add(t, text="Text")
        ttk.Label(t, text="Titles and labels. Position is % from the left / top.").pack(anchor="w", pady=(0, 6))
        fr, lb = self._listbox(t, "texts")
        self._buttons(t, [("Add text", self.add_text), ("Edit", self.edit_text), ("Remove", self.rm_text)]
                      ).pack(side="bottom", anchor="w", pady=(8, 0))
        fr.pack(fill="both", expand=True)
        lb.bind("<Double-Button-1>", lambda e: self.edit_text())

    def _tab_captions(self, nb):
        t = ttk.Frame(nb, padding=8)
        nb.add(t, text="Captions")
        gen = ttk.Frame(t)
        gen.pack(fill="x")
        self.model = tk.StringVar(value="base")
        self.lang = tk.StringVar(value="auto")
        ttk.Label(gen, text="AI model").grid(row=0, column=0, sticky="w")
        ttk.Combobox(gen, textvariable=self.model, values=["tiny", "base", "small", "medium"], width=8,
                     state="readonly").grid(row=0, column=1, padx=6)
        ttk.Label(gen, text="Language").grid(row=0, column=2, sticky="w")
        ttk.Combobox(gen, textvariable=self.lang, width=8, state="readonly",
                     values=["auto", "en", "si", "ta", "hi", "es", "fr", "de", "ja", "ko", "zh"]).grid(row=0, column=3, padx=6)
        self.gen_btn = ttk.Button(gen, text="Auto captions", style="Accent.TButton", command=self.gen_captions)
        self.gen_btn.grid(row=0, column=4, padx=(8, 0))
        fr, lb = self._listbox(t, "caps")
        fr.pack(fill="both", expand=True, pady=8)
        lb.bind("<Double-Button-1>", lambda e: self.edit_caption())
        self._buttons(t, [("Edit", self.edit_caption), ("Add", self.add_caption), ("Remove", self.rm_caption)]
                      ).pack(anchor="w")
        st = ttk.Frame(t)
        st.pack(fill="x", pady=(10, 0))
        cs = self.p["cap_style"]
        self.cap_on = tk.BooleanVar(value=cs["enabled"])
        self.cap_box = tk.BooleanVar(value=cs["box"])
        self.cap_size = tk.StringVar(value=str(cs["size"]))
        self.cap_bottom = tk.StringVar(value=str(cs["bottom"]))
        self.cap_color = tk.StringVar(value=cs["color"])
        ttk.Checkbutton(st, text="Show on video", variable=self.cap_on, command=self.style_changed).grid(row=0, column=0, sticky="w")
        ttk.Checkbutton(st, text="Dark box", variable=self.cap_box, command=self.style_changed).grid(row=0, column=1, sticky="w", padx=10)
        ttk.Label(st, text="Size").grid(row=1, column=0, sticky="w", pady=(6, 0))
        e1 = ttk.Entry(st, textvariable=self.cap_size, width=6)
        e1.grid(row=1, column=0, sticky="e", pady=(6, 0))
        ttk.Label(st, text="From bottom %").grid(row=1, column=1, sticky="w", padx=10, pady=(6, 0))
        e2 = ttk.Entry(st, textvariable=self.cap_bottom, width=5)
        e2.grid(row=1, column=2, pady=(6, 0))
        ttk.Button(st, text="Color", command=self.pick_cap_color).grid(row=1, column=3, padx=8, pady=(6, 0))
        for e in (e1, e2):
            e.bind("<FocusOut>", lambda ev: self.style_changed())
            e.bind("<Return>", lambda ev: self.style_changed())
        self.cap_msg = ttk.Label(t, text="")
        self.cap_msg.pack(anchor="w", pady=(8, 0))

    # ---------------------------------------------------------------- helpers
    def total(self):
        return core.total_duration(self.p)

    def sel(self, key):
        s = self.lb[key].curselection()
        return s[0] if s else None

    def refresh(self, keep_preview=False):
        for key in self.lb:
            self.lb[key].delete(0, "end")
        for c in self.p["clips"]:
            self.lb["clips"].insert("end", "%s   [%s - %s]" % (os.path.basename(c["path"]), fmt(c["start"]), fmt(c["end"])))
        for a in self.p["audios"]:
            self.lb["audios"].insert("end", "%s   starts %s, vol %d%%" % (os.path.basename(a["path"]), fmt(a["offset"]), a["volume"]))
        for t in self.p["texts"]:
            self.lb["texts"].insert("end", "%s - %s   %s" % (fmt(t["start"]), fmt(t["end"]), t["text"].replace("\n", " ")))
        for c in self.p["captions"]:
            self.lb["caps"].insert("end", "%s   %s" % (fmt(c["start"]), c["text"]))
        tot = self.total()
        self.scale.configure(to=max(tot, 0.1))
        self.playhead = min(self.playhead, tot)
        self.tlabel.config(text="%s / %s" % (fmt(self.playhead), fmt(tot)))
        self.draw_timeline()
        if not keep_preview:
            self.update_preview()

    def style_changed(self):
        cs = self.p["cap_style"]
        cs["enabled"] = self.cap_on.get()
        cs["box"] = self.cap_box.get()
        cs["size"] = int(min(300, max(10, fnum(self.cap_size.get(), 54))))
        cs["bottom"] = min(90, max(0, fnum(self.cap_bottom.get(), 8)))
        cs["color"] = self.cap_color.get()
        self.update_preview()

    def pick_cap_color(self):
        c = colorchooser.askcolor(color=self.cap_color.get(), parent=self)[1]
        if c:
            self.cap_color.set(c)
            self.style_changed()

    # ---------------------------------------------------------------- preview
    def _scrub(self, v):
        self.playhead = float(v)
        self.tlabel.config(text="%s / %s" % (fmt(self.playhead), fmt(self.total())))
        self.draw_timeline()

    def update_preview(self):
        if not self.p["clips"]:
            self.pv.config(image="", text="Add a video to start")
            self.photo = None
            return
        if self.preview_busy:
            self.preview_again = True
            return
        self.preview_busy = True
        snap = {k: (list(v) if isinstance(v, list) else dict(v)) for k, v in self.p.items()}
        t = self.playhead
        out = os.path.join(self.work, "pv.png")

        def job():
            try:
                core.render_preview(snap, t, out, self.work)
                self.q.put(("preview", out))
            except Exception as e:  # noqa: BLE001
                self.q.put(("preview_err", str(e)))
        threading.Thread(target=job, daemon=True).start()

    def play_preview(self):
        if not self.p["clips"]:
            return
        self.status.config(text="Rendering preview...")
        snap = {k: (list(v) if isinstance(v, list) else dict(v)) for k, v in self.p.items()}
        out = os.path.join(self.work, "preview.mp4")

        def job():
            try:
                core.run_export(snap, out, "480p", 24, "Fast", self.work)
                self.q.put(("play", out))
            except Exception as e:  # noqa: BLE001
                self.q.put(("error", str(e)))
        threading.Thread(target=job, daemon=True).start()

    # ---------------------------------------------------------------- timeline
    def _tl_geom(self):
        w = max(300, self.tl.winfo_width())
        span = max(self.total(), 10.0)
        return 70, w - 14, span

    def _x(self, t):
        x0, x1, span = self._tl_geom()
        return x0 + (x1 - x0) * t / span

    def draw_timeline(self):
        c = self.tl
        c.delete("all")
        x0, x1, span = self._tl_geom()
        rows = [("Video", "#3f7cd6"), ("Sound", "#3fae7a"), ("Text", "#d6a53f"), ("Captions", "#a56ad6")]
        step = 1 if span <= 20 else 5 if span <= 120 else 15 if span <= 600 else 60
        t = 0
        while t <= span:
            x = self._x(t)
            c.create_line(x, 14, x, 150, fill="#2a2d34")
            c.create_text(x + 3, 7, text=fmt(t), anchor="w", fill="#777", font=("Segoe UI", 8))
            t += step
        for i, (name, col) in enumerate(rows):
            y = 20 + i * 32
            c.create_text(8, y + 12, text=name, anchor="w", fill="#aaa", font=("Segoe UI", 9))
            blocks = []
            if i == 0:
                acc = 0
                for cl in self.p["clips"]:
                    d = cl["end"] - cl["start"]
                    blocks.append((acc, acc + d, os.path.basename(cl["path"])))
                    acc += d
            elif i == 1:
                blocks = [(a["offset"], a["offset"] + (a["end"] - a["start"]), os.path.basename(a["path"])) for a in self.p["audios"]]
            elif i == 2:
                blocks = [(t_["start"], t_["end"], t_["text"]) for t_ in self.p["texts"]]
            else:
                blocks = [(k["start"], k["end"], k["text"]) for k in self.p["captions"]]
            for s, e, label in blocks:
                xa, xb = self._x(s), max(self._x(e), self._x(s) + 3)
                c.create_rectangle(xa, y, xb, y + 24, fill=col, outline="#1a1c20")
                if xb - xa > 30:
                    c.create_text(xa + 4, y + 12, text=label, anchor="w", fill="white", font=("Segoe UI", 8))
        px = self._x(self.playhead)
        c.create_line(px, 14, px, 150, fill="#ff5a4d", width=2)

    def _tl_click(self, e):
        x0, x1, span = self._tl_geom()
        t = (e.x - x0) / (x1 - x0) * span
        self.playhead = min(max(0, t), self.total())
        self.scale.set(self.playhead)
        self.tlabel.config(text="%s / %s" % (fmt(self.playhead), fmt(self.total())))
        self.draw_timeline()

    # ---------------------------------------------------------------- videos
    def add_video(self):
        for path in filedialog.askopenfilenames(title="Add video", filetypes=VIDEO_TYPES):
            try:
                self.p["clips"].append(core.make_clip(path))
            except Exception as e:  # noqa: BLE001
                messagebox.showerror("Cannot add", "%s\n\n%s" % (os.path.basename(path), e))
        self.refresh()

    def trim_clip(self):
        i = self.sel("clips")
        if i is None:
            return messagebox.showinfo("Trim", "Select a clip first.")
        c = self.p["clips"][i]
        r = ask_fields(self, "Trim clip (seconds)", [("Start", c["start"]), ("End", c["end"])])
        if r:
            s = min(max(0, fnum(r[0])), c["dur"])
            e = min(max(0, fnum(r[1], c["dur"])), c["dur"])
            if e - s < 0.1:
                return messagebox.showerror("Trim", "End must be after start.")
            c["start"], c["end"] = round(s, 3), round(e, 3)
            self.refresh()

    def move_clip(self, d):
        i = self.sel("clips")
        if i is None or not 0 <= i + d < len(self.p["clips"]):
            return
        cl = self.p["clips"]
        cl[i], cl[i + d] = cl[i + d], cl[i]
        self.refresh()
        self.lb["clips"].selection_set(i + d)

    def rm_clip(self):
        i = self.sel("clips")
        if i is not None:
            del self.p["clips"][i]
            self.refresh()

    # ---------------------------------------------------------------- audio
    def add_audio(self):
        for path in filedialog.askopenfilenames(title="Add sound", filetypes=AUDIO_TYPES):
            try:
                a = core.make_audio(path)
                a["offset"] = round(self.playhead, 2)
                self.p["audios"].append(a)
            except Exception as e:  # noqa: BLE001
                messagebox.showerror("Cannot add", "%s\n\n%s" % (os.path.basename(path), e))
        self.refresh(keep_preview=True)

    def edit_audio(self):
        i = self.sel("audios")
        if i is None:
            return messagebox.showinfo("Sound", "Select a sound first.")
        a = self.p["audios"][i]
        r = ask_fields(self, "Sound settings", [("Starts on timeline (s)", a["offset"]), ("Use from (s)", a["start"]),
                                                ("Use until (s)", a["end"]), ("Volume %", a["volume"])])
        if r:
            a["offset"] = max(0, fnum(r[0]))
            a["start"] = min(max(0, fnum(r[1])), a["dur"])
            a["end"] = min(max(a["start"] + 0.1, fnum(r[2], a["dur"])), a["dur"])
            a["volume"] = min(300, max(0, fnum(r[3], 100)))
            self.refresh(keep_preview=True)

    def rm_audio(self):
        i = self.sel("audios")
        if i is not None:
            del self.p["audios"][i]
            self.refresh(keep_preview=True)

    # ---------------------------------------------------------------- text
    def _text_dialog(self, t):
        r = ask_fields(self, "Text", [("Text (use \\n for new line)", t["text"].replace("\n", "\\n")),
                                      ("Start (s)", t["start"]), ("End (s)", t["end"]),
                                      ("Left %", t["x"]), ("Top %", t["y"]), ("Size", t["size"]),
                                      ("Color", t["color"], "color")])
        if not r or not r[0].strip():
            return None
        return {"text": r[0].replace("\\n", "\n"), "start": max(0, fnum(r[1])), "end": max(0, fnum(r[2], 3)),
                "x": min(100, max(0, fnum(r[3], 50))), "y": min(100, max(0, fnum(r[4], 50))),
                "size": int(min(400, max(10, fnum(r[5], 80)))), "color": r[6] or "#FFFFFF"}

    def add_text(self):
        s = round(self.playhead, 1)
        t = self._text_dialog({"text": "Your text", "start": s, "end": s + 3, "x": 50, "y": 50, "size": 90, "color": "#FFFFFF"})
        if t:
            self.p["texts"].append(t)
            self.refresh()

    def edit_text(self):
        i = self.sel("texts")
        if i is None:
            return messagebox.showinfo("Text", "Select a text first.")
        t = self._text_dialog(self.p["texts"][i])
        if t:
            self.p["texts"][i] = t
            self.refresh()

    def rm_text(self):
        i = self.sel("texts")
        if i is not None:
            del self.p["texts"][i]
            self.refresh()

    # ---------------------------------------------------------------- captions
    def _cap_dialog(self, c):
        r = ask_fields(self, "Caption", [("Text", c["text"]), ("Start (s)", c["start"]), ("End (s)", c["end"])])
        if not r or not r[0].strip():
            return None
        return {"text": r[0].strip(), "start": max(0, fnum(r[1])), "end": max(0, fnum(r[2]))}

    def add_caption(self):
        s = round(self.playhead, 1)
        c = self._cap_dialog({"text": "", "start": s, "end": s + 2})
        if c:
            self.p["captions"].append(c)
            self.p["captions"].sort(key=lambda k: k["start"])
            self.refresh()

    def edit_caption(self):
        i = self.sel("caps")
        if i is None:
            return
        c = self._cap_dialog(self.p["captions"][i])
        if c:
            self.p["captions"][i] = c
            self.p["captions"].sort(key=lambda k: k["start"])
            self.refresh()

    def rm_caption(self):
        i = self.sel("caps")
        if i is not None:
            del self.p["captions"][i]
            self.refresh()

    def gen_captions(self):
        if not self.p["clips"]:
            return messagebox.showinfo("Captions", "Add a video first.")
        if not core.whisper_available():
            return messagebox.showinfo("Captions", "Auto captions need one extra package.\n\n"
                                       "Run this in a terminal, then restart:\n\npip install faster-whisper")
        if self.p["captions"] and not messagebox.askyesno("Captions", "Replace the existing captions?"):
            return
        lang = None if self.lang.get() == "auto" else self.lang.get()
        snap = {k: (list(v) if isinstance(v, list) else dict(v)) for k, v in self.p.items()}
        self.gen_btn.state(["disabled"])

        def status(msg, frac):
            self.q.put(("cap_status", (msg, frac)))

        def job():
            try:
                caps = core.generate_captions(snap, self.work, self.model.get(), lang, status)
                self.q.put(("captions", caps))
            except Exception as e:  # noqa: BLE001
                self.q.put(("cap_error", str(e)))
        threading.Thread(target=job, daemon=True).start()

    # ---------------------------------------------------------------- export
    def export(self):
        if not self.p["clips"]:
            return messagebox.showinfo("Export", "Add a video first.")
        out = filedialog.asksaveasfilename(title="Export video", defaultextension=".mp4", filetypes=[("MP4 video", "*.mp4")],
                                           initialfile="my_video.mp4")
        if not out:
            return
        snap = {k: (list(v) if isinstance(v, list) else dict(v)) for k, v in self.p.items()}
        res, fps, qual = self.res.get(), int(self.fps.get()), self.qual.get()
        self.export_btn.state(["disabled"])
        self.cancel_btn.pack(side="right", padx=(0, 8), before=self.status)
        self.cancel_flag = False
        self.export_proc.clear()
        self.prog["value"] = 0
        self.status.config(text="Exporting %s..." % res)

        def job():
            try:
                core.run_export(snap, out, res, fps, qual, self.work, lambda f: self.q.put(("progress", f)), self.export_proc)
                self.q.put(("done", out))
            except Exception as e:  # noqa: BLE001
                self.q.put(("error", "Export cancelled." if self.cancel_flag else str(e)))
        threading.Thread(target=job, daemon=True).start()

    def cancel_export(self):
        self.cancel_flag = True
        for pr in self.export_proc:
            try:
                pr.kill()
            except OSError:
                pass

    # ---------------------------------------------------------------- events
    def _poll(self):
        try:
            while True:
                kind, val = self.q.get_nowait()
                if kind == "preview":
                    self.preview_busy = False
                    try:
                        self.photo = tk.PhotoImage(file=val)
                        self.pv.config(image=self.photo, text="")
                    except tk.TclError:
                        pass
                    if self.preview_again:
                        self.preview_again = False
                        self.update_preview()
                elif kind == "preview_err":
                    self.preview_busy = False
                    self.status.config(text="Preview failed")
                elif kind == "progress":
                    self.prog["value"] = val
                    self.status.config(text="Exporting... %d%%" % int(val * 100))
                elif kind == "done":
                    self._export_end("Saved")
                    messagebox.showinfo("Export finished", "Saved to:\n" + val)
                elif kind == "error":
                    self._export_end("")
                    if val != "Export cancelled.":
                        messagebox.showerror("Error", val)
                elif kind == "play":
                    self.status.config(text="")
                    self._open_file(val)
                elif kind == "cap_status":
                    self.cap_msg.config(text=val[0])
                    self.prog["value"] = val[1]
                elif kind == "captions":
                    self.p["captions"] = val
                    self.gen_btn.state(["!disabled"])
                    self.cap_msg.config(text="%d captions added. Double-click one to fix a word." % len(val))
                    self.prog["value"] = 0
                    self.refresh()
                elif kind == "cap_error":
                    self.gen_btn.state(["!disabled"])
                    self.cap_msg.config(text="")
                    self.prog["value"] = 0
                    messagebox.showerror("Captions failed", val)
        except queue.Empty:
            pass
        self.after(100, self._poll)

    def _export_end(self, msg):
        self.export_btn.state(["!disabled"])
        self.cancel_btn.pack_forget()
        self.status.config(text=msg)
        if not msg:
            self.prog["value"] = 0

    @staticmethod
    def _open_file(path):
        import subprocess
        import sys
        if sys.platform == "win32":
            os.startfile(path)  # noqa: S606
        elif sys.platform == "darwin":
            subprocess.Popen(["open", path])
        else:
            subprocess.Popen(["xdg-open", path])

    # ---------------------------------------------------------------- project files
    def new(self):
        if self.p["clips"] and not messagebox.askyesno("New project", "Discard the current project?"):
            return
        self.p = core.new_project()
        self.proj_path = None
        self.playhead = 0
        cs = self.p["cap_style"]
        self.cap_on.set(cs["enabled"])
        self.cap_box.set(cs["box"])
        self.cap_size.set(str(cs["size"]))
        self.cap_bottom.set(str(cs["bottom"]))
        self.cap_color.set(cs["color"])
        self.refresh()

    def open_proj(self):
        path = filedialog.askopenfilename(filetypes=[("SimpleCut project", "*.scut"), ("All files", "*.*")])
        if path:
            try:
                self.p = core.load_project(path)
            except Exception as e:  # noqa: BLE001
                return messagebox.showerror("Open", str(e))
            self.proj_path = path
            cs = self.p["cap_style"]
            self.cap_on.set(cs["enabled"])
            self.cap_box.set(cs["box"])
            self.cap_size.set(str(cs["size"]))
            self.cap_bottom.set(str(cs["bottom"]))
            self.cap_color.set(cs["color"])
            self.refresh()

    def save_proj(self, as_new=False):
        path = self.proj_path
        if as_new or not path:
            path = filedialog.asksaveasfilename(defaultextension=".scut", filetypes=[("SimpleCut project", "*.scut")])
        if path:
            core.save_project(self.p, path)
            self.proj_path = path
            self.status.config(text="Project saved")

    def _close(self):
        self.cancel_export()
        shutil.rmtree(self.work, ignore_errors=True)
        self.destroy()


if __name__ == "__main__":
    App().mainloop()
