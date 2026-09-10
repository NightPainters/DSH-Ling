// dsh-ling host — zstd 拼接帧解码(纯 node;供 backfill/deepsummary/CLI 共用)
import { zstdDecompressSync } from 'node:zlib';

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/** 返回连续 zstd 帧的 [start,end) 偏移列表。 */
export function frameBounds(buf) {
  const bounds = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    if (!(buf[off] === MAGIC[0] && buf[off + 1] === MAGIC[1] && buf[off + 2] === MAGIC[2] && buf[off + 3] === MAGIC[3])) break;
    let p = off + 4;
    if (p >= buf.length) break;
    const fhd = buf[p++];
    const dictFlag = fhd & 0x03;
    const fcsFlag = (fhd >> 6) & 0x03;
    const single = (fhd >> 5) & 0x01;
    const checksum = (fhd >> 2) & 0x01;
    if (!single) {
      p += 1;
      if (p > buf.length) break;
    }
    if (single) p += [1, 2, 4, 8][fcsFlag];
    else if (fcsFlag !== 0) p += [0, 2, 4, 8][fcsFlag];
    p += [0, 1, 2, 4][dictFlag];
    if (p > buf.length) break;
    let done = false;
    let guard = 0;
    while (!done && p + 3 <= buf.length && guard++ < 1e6) {
      const b0 = buf[p];
      const last = b0 & 1;
      const type = (b0 >> 1) & 0x03;
      const size = (b0 >> 3) | (buf[p + 1] << 5) | (buf[p + 2] << 13);
      p += 3;
      if (type === 3) break;
      if (type === 1) p += 1;
      else {
        if (p + size > buf.length) break;
        p += size;
      }
      if (last) done = true;
    }
    if (!done) break;
    if (checksum) p += 4;
    bounds.push([off, p]);
    off = p;
  }
  return bounds;
}

/** 解码拼接帧并拼接为文本。 */
export function decodeAll(buf) {
  const bounds = frameBounds(buf);
  let out = '';
  for (const [s, e] of bounds) {
    try {
      out += zstdDecompressSync(buf.subarray(s, e)).toString('utf8');
    } catch {
      // 单帧失败不影响其他帧
    }
  }
  return out;
}
