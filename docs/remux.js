/* Turns the fragmented MP4 that MediaRecorder produces into a normal MP4 (full duration, seekable, gallery friendly). */
(function (root) {
  const CONT = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);
  const u32 = (d, o) => d.getUint32(o), u64 = (d, o) => d.getUint32(o) * 4294967296 + d.getUint32(o + 4);
  function parse(buf, start, end) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), out = [];
    let o = start;
    while (o + 8 <= end) {
      let size = u32(dv, o), h = 8; const type = String.fromCharCode(buf[o + 4], buf[o + 5], buf[o + 6], buf[o + 7]);
      if (size === 1) { size = u64(dv, o + 8); h = 16; } else if (size === 0) size = end - o;
      if (size < h || o + size > end) break;
      const b = { type, start: o, size, h };
      if (CONT.has(type)) b.kids = parse(buf, o + h, o + size); else b.data = buf.subarray(o + h, o + size);
      out.push(b); o += size;
    }
    return out;
  }
  const find = (a, t) => a.find(b => b.type === t);
  function box(type, ...parts) {
    let n = 8; parts.forEach(p => { n += p.length; });
    const r = new Uint8Array(n), dv = new DataView(r.buffer); dv.setUint32(0, n);
    for (let i = 0; i < 4; i++) r[4 + i] = type.charCodeAt(i);
    let o = 8; parts.forEach(p => { r.set(p, o); o += p.length; });
    return r;
  }
  const words = (arr, bytes = 4) => { const r = new Uint8Array(arr.length * 4); const dv = new DataView(r.buffer); arr.forEach((v, i) => dv.setInt32(i * 4, v)); return r; };
  const full = (ver, flags, ...ints) => { const r = words([(ver << 24) | flags, ...ints]); return r; };
  function ser(b, rep) {
    if (rep && rep[b.type] !== undefined && !b.kids) return rep[b.type];
    if (b.kids) return box(b.type, ...b.kids.map(k => ser(k, rep)).filter(Boolean));
    return box(b.type, b.data);
  }
  function fmp4ToMp4(ab) {
    const buf = new Uint8Array(ab), top = parse(buf, 0, buf.length), dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const ftyp = find(top, 'ftyp'), moov = find(top, 'moov');
    if (!moov || !moov.kids.some(k => k.type === 'mvex')) return buf; // already a normal mp4
    const tracks = {};
    moov.kids.filter(k => k.type === 'trak').forEach(t => {
      const tkhd = find(t.kids, 'tkhd').data, ver = tkhd[0], id = new DataView(tkhd.buffer, tkhd.byteOffset).getUint32(ver ? 20 : 12);
      const mdia = find(t.kids, 'mdia'), mdhd = find(mdia.kids, 'mdhd').data, mv = mdhd[0], ts = new DataView(mdhd.buffer, mdhd.byteOffset).getUint32(mv ? 20 : 12);
      const hd = find(mdia.kids, 'hdlr').data, hdv = String.fromCharCode(hd[8], hd[9], hd[10], hd[11]);
      tracks[id] = { trak: t, id, ts, video: hdv === 'vide', s: [] };
    });
    const trex = {}; find(moov.kids, 'mvex') && find(moov.kids, 'mvex').data;
    // trex defaults live inside mvex (not parsed as container), read them by scanning
    const mvex = moov.kids.find(k => k.type === 'mvex');
    { const sub = parse(buf, mvex.start + mvex.h, mvex.start + mvex.size); sub.filter(b => b.type === 'trex').forEach(b => { const d = new DataView(b.data.buffer, b.data.byteOffset); trex[d.getUint32(4)] = { dur: d.getUint32(12), size: d.getUint32(16), flags: d.getUint32(20) }; }); }
    // walk fragments
    for (const mf of top.filter(b => b.type === 'moof')) {
      const parts = parse(buf, mf.start + mf.h, mf.start + mf.size);
      // traf is not a registered container in CONT: parse manually
      for (const traf of parts.filter(b => b.type === 'traf')) {
        const sub = parse(buf, traf.start + traf.h, traf.start + traf.size === 0 ? 0 : traf.start + traf.size);
        const tfhd = sub.find(b => b.type === 'tfhd'), d = new DataView(tfhd.data.buffer, tfhd.data.byteOffset), fl = d.getUint32(0) & 0xffffff, id = d.getUint32(4);
        let p = 8, base = mf.start, defDur, defSize, defFlags;
        if (fl & 1) { base = u64(d, p); p += 8; }
        if (fl & 2) p += 4;
        const T = tracks[id], tx = trex[id] || {};
        defDur = fl & 8 ? d.getUint32(p) : tx.dur; if (fl & 8) p += 4;
        defSize = fl & 0x10 ? d.getUint32(p) : tx.size; if (fl & 0x10) p += 4;
        defFlags = fl & 0x20 ? d.getUint32(p) : tx.flags;
        let pos = base;
        for (const trun of sub.filter(b => b.type === 'trun')) {
          const t = new DataView(trun.data.buffer, trun.data.byteOffset), tf = t.getUint32(0) & 0xffffff, ver = trun.data[0], n = t.getUint32(4);
          let q = 8, off = pos;
          if (tf & 1) { off = base + t.getInt32(q); q += 4; }
          let first = null; if (tf & 4) { first = t.getUint32(q); q += 4; }
          for (let i = 0; i < n; i++) {
            const dur = tf & 0x100 ? t.getUint32(q) : defDur; if (tf & 0x100) q += 4;
            const size = tf & 0x200 ? t.getUint32(q) : defSize; if (tf & 0x200) q += 4;
            let flags = tf & 0x400 ? t.getUint32(q) : (i === 0 && first !== null ? first : defFlags); if (tf & 0x400) q += 4;
            if (i === 0 && first !== null && !(tf & 0x400)) flags = first;
            const cto = tf & 0x800 ? (ver ? t.getInt32(q) : t.getUint32(q)) : 0; if (tf & 0x800) q += 4;
            T.s.push({ off, size, dur, sync: !(flags & 0x10000), cto }); off += size;
          }
          pos = off;
        }
      }
    }
    const list = Object.values(tracks);
    const mvhdBox = moov.kids.find(k => k.type === 'mvhd'), mvd = mvhdBox.data, mvv = mvd[0], mvDv = new DataView(mvd.buffer, mvd.byteOffset), mvTs = mvDv.getUint32(mvv ? 20 : 12);
    const setDur = (data, verOff, durOff, val) => { const c = new Uint8Array(data); const d = new DataView(c.buffer); if (data[0]) { d.setUint32(durOff, Math.floor(val / 4294967296)); d.setUint32(durOff + 4, val >>> 0); } else d.setUint32(durOff, val >>> 0); return c; };
    let movieDur = 0; list.forEach(T => { T.dur = T.s.reduce((a, s) => a + s.dur, 0); movieDur = Math.max(movieDur, Math.round(T.dur / T.ts * mvTs)); });
    const build = bases => {
      const rep = {};
      const moovKids = moov.kids.filter(k => k.type !== 'mvex').map(k => {
        if (k.type === 'mvhd') return { type: 'mvhd', data: setDur(k.data, 0, k.data[0] ? 24 : 16, movieDur) };
        if (k.type !== 'trak') return k;
        const T = list.find(x => x.trak === k), S = T.s;
        const tkhd = find(k.kids, 'tkhd'), mdia = find(k.kids, 'mdia'), mdhd = find(mdia.kids, 'mdhd'), minf = find(mdia.kids, 'minf'), stbl = find(minf.kids, 'stbl');
        const stts = []; S.forEach(s => { const l = stts[stts.length - 1]; if (l && l[1] === s.dur) l[0]++; else stts.push([1, s.dur]); });
        const kids = [stbl.kids.find(x => x.type === 'stsd'),
          { type: 'stts', data: full(0, 0, stts.length, ...stts.flat()) },
          { type: 'stsc', data: full(0, 0, 1, 1, S.length, 1) },
          { type: 'stsz', data: full(0, 0, 0, S.length, ...S.map(s => s.size)) },
          { type: 'stco', data: full(0, 0, 1, bases[T.id] || 0) }];
        if (T.video) { const ss = []; S.forEach((s, i) => { if (s.sync) ss.push(i + 1); }); if (ss.length && ss.length < S.length) kids.push({ type: 'stss', data: full(0, 0, ss.length, ...ss) }); }
        if (S.some(s => s.cto)) { const c = []; S.forEach(s => { const l = c[c.length - 1]; if (l && l[1] === s.cto) l[0]++; else c.push([1, s.cto]); }); kids.push({ type: 'ctts', data: full(1, 0, c.length, ...c.flat()) }); }
        const mvDur = Math.round(T.dur / T.ts * mvTs);
        const newStbl = { type: 'stbl', kids };
        const newMinf = { type: 'minf', kids: minf.kids.map(x => x === stbl ? newStbl : x) };
        const newMdia = { type: 'mdia', kids: mdia.kids.map(x => x === minf ? newMinf : x === mdhd ? { type: 'mdhd', data: setDur(x.data, 0, x.data[0] ? 24 : 16, T.dur) } : x) };
        return { type: 'trak', kids: k.kids.map(x => x === mdia ? newMdia : x === tkhd ? { type: 'tkhd', data: setDur(x.data, 0, x.data[0] ? 28 : 20, mvDur) } : x) };
      });
      return ser({ type: 'moov', kids: moovKids });
    };
    const head = ftyp ? buf.subarray(ftyp.start, ftyp.start + ftyp.size) : new Uint8Array(0);
    const mdatSize = list.reduce((a, T) => a + T.s.reduce((x, s) => x + s.size, 0), 0);
    const moov0 = build({}), bases = {}; let pos = head.length + moov0.length + 16;
    list.forEach(T => { bases[T.id] = pos; pos += T.s.reduce((x, s) => x + s.size, 0); });
    const moovF = build(bases);
    const out = new Uint8Array(head.length + moovF.length + 16 + mdatSize), o = new DataView(out.buffer);
    out.set(head, 0); out.set(moovF, head.length);
    let p = head.length + moovF.length;
    o.setUint32(p, 1); out.set([0x6d, 0x64, 0x61, 0x74], p + 4); o.setUint32(p + 8, Math.floor((mdatSize + 16) / 4294967296)); o.setUint32(p + 12, (mdatSize + 16) >>> 0); p += 16;
    list.forEach(T => T.s.forEach(s => { out.set(buf.subarray(s.off, s.off + s.size), p); p += s.size; }));
    return out;
  }
  root.fmp4ToMp4 = fmp4ToMp4;
  if (typeof module !== 'undefined') module.exports = { fmp4ToMp4 };
})(typeof window !== 'undefined' ? window : globalThis);
