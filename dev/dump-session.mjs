// Dump a slice of one DSH v4 session log.
// Usage: node dump-session.mjs <session.v4.jsonl.zstd> [fromSeq] [toSeq]
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

function decodeZstdFrames(buf) {
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i)
  }
  if (starts.length === 0 || starts[0] !== 0) starts.unshift(0)
  let text = ''
  let pending = null
  for (let k = 0; k < starts.length; k++) {
    const chunk = buf.subarray(starts[k], k + 1 < starts.length ? starts[k + 1] : buf.length)
    const candidate = pending ? Buffer.concat([pending, chunk]) : chunk
    try {
      text += zstdDecompressSync(candidate).toString('utf8')
      pending = null
    } catch {
      pending = candidate
    }
  }
  return text
}

const [file, fromSeq, toSeq] = process.argv.slice(2)
const from = fromSeq === undefined ? -Infinity : Number(fromSeq)
const to = toSeq === undefined ? Infinity : Number(toSeq)

const text = decodeZstdFrames(readFileSync(file))
for (const line of text.split('\n')) {
  if (line.trim() === '') continue
  let e
  try { e = JSON.parse(line) } catch { continue }
  if (typeof e.seq !== 'number' || e.seq < from || e.seq > to) continue
  const data = JSON.stringify(e.data)
  console.log(`#${e.seq} ${e.type} ${data.length > 420 ? data.slice(0, 420) + '…' : data}`)
}
