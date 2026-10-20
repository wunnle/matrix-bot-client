/**
 * Pixel characters for agent room avatars, drawn on the same grid as the
 * original invader (scripts/agent-avatar.png): one row per string, X for a
 * lit pixel. Kept symmetrical; that is what makes them read at 36px.
 *
 * SPRITES is the cast the bot hands out. Changing one means regenerating its
 * PNG: node scripts/gen-agent-avatars.mjs, then restart the bot.
 */
export const SPRITES: Record<string, string[]> = {
  invader: ['..X.....X..', '...X...X...', '..XXXXXXX..', '.XX.XXX.XX.', 'XXXXXXXXXXX', 'X.XXXXXXX.X', 'X.X.....X.X', '...XX.XX...'],
  squid: ['...XX...', '..XXXX..', '.XXXXXX.', 'XX.XX.XX', 'XXXXXXXX', '.X.XX.X.', 'X......X', '.X....X.'],
  rocket: ['.....X.....', '....XXX....', '....XXX....', '...XX.XX...', '...XXXXX...', '...XXXXX...', '..XXXXXXX..', '.XX.XXX.XX.', '.X..X.X..X.'],
  crown: ['X....X....X', 'XX..XXX..XX', 'XXX.XXX.XXX', 'XXXXXXXXXXX', 'XXXXXXXXXXX', 'X.XXX.XXX.X', 'XXXXXXXXXXX'],
  saucer: ['....XXX....', '...XXXXX...', '.XXXXXXXXX.', 'XX.XX.XX.XX', '.XXXXXXXXX.', '...X...X...', '..X.....X..', '.X.......X.'],
}

/** Candidates for the cast, not yet in use. */
export const CANDIDATES: Record<string, string[]> = {
  planet: ['.....XXX.....', '...XXXXXXX...', '..XXXXXXXXX..', 'XXXXXXXXXXXXX', 'X..XXXXXXX..X', 'XXXXXXXXXXXXX', '..XXXXXXXXX..', '...XXXXXXX...', '.....XXX.....'],
  star: ['.....X.....', '....XXX....', '....XXX....', 'XXXXXXXXXXX', '.XXXXXXXXX.', '..XXXXXXX..', '..XXXXXXX..', '.XXXX.XXXX.', '.XX.....XX.'],
  heart: ['.XXX...XXX.', 'XXXXX.XXXXX', 'XXXXXXXXXXX', 'XXXXXXXXXXX', '.XXXXXXXXX.', '..XXXXXXX..', '...XXXXX...', '....XXX....', '.....X.....'],
  potion: ['...XXX...', '....X....', '...XXX...', '..XXXXX..', '.XXX.XXX.', 'XXXXXXXXX', 'XX.XXX.XX', 'XXXXXXXXX', '.XXXXXXX.'],
  gem: ['..XXXXXXX..', '.XX.XXX.XX.', 'XXXXXXXXXXX', '.XXXX.XXXX.', '..XXX.XXX..', '...XXXXX...', '....XXX....', '.....X.....'],
  flame: ['....X....', '...XXX...', '..XXXXX..', '..XX.XX..', '.XXX.XXX.', 'XXX...XXX', 'XXX...XXX', 'XXXX.XXXX', '.XXXXXXX.', '..XXXXX..'],
  helmet: ['...XXXXX...', '.XXXXXXXXX.', 'XXX.....XXX', 'XX.......XX', 'XX.......XX', 'XXX.....XXX', '.XXXXXXXXX.', 'XX.XXXXX.XX', 'XXXXXXXXXXX'],
  bulb: ['..XXXXX..', '.XXXXXXX.', 'XXXXXXXXX', 'XXX.X.XXX', 'XXXX.XXXX', '.XXX.XXX.', '..XX.XX..', '..XXXXX..', '...XXX...', '..XXXXX..', '...XXX...'],
  trophy: ['XXXXXXXXXXX', 'X.XXXXXXX.X', 'X.XXXXXXX.X', '.XXXXXXXXX.', '..XXXXXXX..', '....XXX....', '....XXX....', '...XXXXX...', '..XXXXXXX..'],
  tree: ['....X....', '...XXX...', '..XXXXX..', '...XXX...', '..XXXXX..', '.XXXXXXX.', '..XXXXX..', '.XXXXXXX.', 'XXXXXXXXX', '...XXX...'],
}

// The invader PNG's own colours; scripts/gen-agent-avatars.mjs draws the rest
// of the cast with them, at its 36px pixel.
export const AVATAR_BG = '#d97757'
export const AVATAR_FG = '#faf9f5'

/**
 * A sprite as an SVG tile. The pixel size matches the invader's (a 14.2-pixel
 * tile), widened only for sprites that would not fit with a margin.
 */
export function spriteSvg(grid: string[], bg = AVATAR_BG, fg = AVATAR_FG): string {
  const h = grid.length
  const w = grid[0].length
  const tile = Math.max(14.2, w + 3, h + 3.4)
  const ox = (tile - w) / 2
  const oy = (tile - h) / 2
  let px = ''
  grid.forEach((row, y) => [...row].forEach((c, x) => {
    if (c === 'X') px += `<rect x="${ox + x}" y="${oy + y}" width="1.01" height="1.01"/>`
  }))
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${tile} ${tile}" shape-rendering="crispEdges"><rect width="${tile}" height="${tile}" fill="${bg}"/><g fill="${fg}">${px}</g></svg>`
}
