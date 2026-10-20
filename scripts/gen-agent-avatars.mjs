#!/usr/bin/env node
// Draws the agent avatar cast (src/design/sprites.ts: every SPRITES character
// on every SHADES tile) as PNGs at the original invader's size, sprite colour
// and 36px pixel:
//   scripts/agent-avatar-<character>-<shade>.png
// Stale combinations are deleted. The hand-made scripts/agent-avatar.png stays:
// rooms still wearing it are recognised as ours and moved onto the cast. Run
// after changing the cast, then restart the bot, which uploads any new or
// changed icon and hands them out (see AVATAR_FILES there).
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { SPRITES, SHADES, AVATAR_FG } from '../src/design/sprites.ts'

const SIZE = 512
const PIXEL = 36
const CAST_FILE = /^agent-avatar-[a-z]+-[a-z]+\.png$/

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
const fg = rgb(AVATAR_FG)

function png(grid, bg) {
  const w = grid[0].length * PIXEL
  const h = grid.length * PIXEL
  const ox = Math.round((SIZE - w) / 2)
  const oy = Math.round((SIZE - h) / 2)
  const raw = Buffer.alloc(SIZE * (SIZE * 3 + 1))
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 3 + 1)] = 0 // filter: none
    for (let x = 0; x < SIZE; x++) {
      const gx = Math.floor((x - ox) / PIXEL)
      const gy = Math.floor((y - oy) / PIXEL)
      const lit = x >= ox && y >= oy && grid[gy]?.[gx] === 'X'
      raw.set(lit ? fg : bg, y * (SIZE * 3 + 1) + 1 + x * 3)
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(SIZE, 0)
  ihdr.writeUInt32BE(SIZE, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const wanted = new Set()
for (const [name, grid] of Object.entries(SPRITES)) {
  for (const [shade, hex] of Object.entries(SHADES)) {
    const file = `agent-avatar-${name}-${shade}.png`
    wanted.add(file)
    fs.writeFileSync(path.join(import.meta.dirname, file), png(grid, rgb(hex)))
  }
}
// Combinations no longer in the cast.
for (const file of fs.readdirSync(import.meta.dirname)) {
  if (CAST_FILE.test(file) && !wanted.has(file)) {
    fs.rmSync(path.join(import.meta.dirname, file))
    console.log(`removed ${file}`)
  }
}
console.log(`wrote ${wanted.size} avatars`)
