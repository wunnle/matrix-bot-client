#!/usr/bin/env node
// Draws the agent avatar cast (src/design/sprites.ts SPRITES) as PNGs beside
// the original invader, at its exact size, colours and 36px pixel:
//   scripts/agent-avatar-<name>.png
// The invader itself is the hand-made scripts/agent-avatar.png and is left
// alone. Run after changing the cast, then restart the bot, which uploads any
// new or changed icon and hands them out (see AVATAR_FILES there).
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { SPRITES, AVATAR_BG, AVATAR_FG } from '../src/design/sprites.ts'

const SIZE = 512
const PIXEL = 36

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
const bg = rgb(AVATAR_BG)
const fg = rgb(AVATAR_FG)

function png(grid) {
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

for (const [name, grid] of Object.entries(SPRITES)) {
  if (name === 'invader') continue
  const file = path.join(import.meta.dirname, `agent-avatar-${name}.png`)
  fs.writeFileSync(file, png(grid))
  console.log(`wrote ${path.basename(file)}`)
}
