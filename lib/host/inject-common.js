// dsh-ling host — shared keyword helpers (used by inject & lifecycle).
// v0 query tokenizer: overlapping 4-grams per CJK segment. Stored overview
// keywords are 4..6-char windows; substring containment in l1.kwOverlap then
// hits regardless of window offsets (e.g. stored "双份项目讨论" ⊃ query "项目讨论").
export function keywordsFrom(text) {
  if (!text) return [];
  const segs = String(text).split(/[^\u4e00-\u9fff]+/).filter((s) => s.length >= 2);
  const out = [];
  for (const seg of segs.slice(0, 6)) {
    if (seg.length <= 6) {
      if (!out.includes(seg)) out.push(seg);
      continue;
    }
    // 滑动 4-gram
    for (let i = 0; i + 4 <= seg.length && out.length < 24; i += 2) {
      const g = seg.slice(i, i + 4);
      if (!out.includes(g)) out.push(g);
    }
    if (out.length < 24) {
      const head = seg.slice(0, 6);
      if (!out.includes(head)) out.push(head);
    }
  }
  return out.slice(0, 16);
}
