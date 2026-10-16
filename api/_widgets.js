/**
 * Home-screen boards: what the Construct widget draws, set by bots through
 * /api/widget and fetched by the widget on its own schedule.
 *
 * Registry: Matrix account data `com.construct.widgets`, its own document like
 * the Live Activity registry.
 *
 *   { boards: { "<boardId>": {
 *       title, tone, tiles: [{icon, value, sub?, tone?}], lines: [string],
 *       roomId, updatedAt (unix seconds) } } }
 *
 * The board shape is a contract with `Board` in the widget
 * (ContructWidgets/ContructWidgets.swift). The widget decodes leniently, but
 * keep the keys in step.
 *
 * Unlike a Live Activity there's no push: iOS reloads the widget's timeline on
 * its own budget (every 15 minutes at best) and whenever the app comes to the
 * foreground. A board is read the next time that happens.
 */
import { readDoc, writeDoc, str, parseTiles, ActivityError, ID_PATTERN, TONES } from "./_activities.js";

const REGISTRY_TYPE = "com.construct.widgets";

/** A medium widget fits a 2×2 grid; the small one draws the first two. */
export const MAX_BOARD_TILES = 4;
export const MAX_LINES = 3;
/** Boards are few and hand-named; this only stops a runaway loop. */
export const MAX_BOARDS = 12;

function parseLines(lines) {
  if (lines === undefined) return undefined;
  if (lines === null) return [];
  if (!Array.isArray(lines)) throw new ActivityError(400, "lines must be an array");
  if (lines.length > MAX_LINES) throw new ActivityError(400, `at most ${MAX_LINES} lines`);
  return lines.map((l, i) => str(l, `lines[${i}]`, 120, { required: true }));
}

/**
 * Merges `input` over the board `prev` (or an empty one): only the fields given
 * change, `null` clears tiles or lines. Pure.
 */
export function buildBoard(input, prev = null, nowMs = Date.now()) {
  const board = prev
    ? { ...prev }
    : { title: "", tone: "neutral", tiles: [], lines: [], roomId: "" };

  const title = str(input.title, "title", 60);
  if (title !== undefined) board.title = title;
  if (input.tone !== undefined) {
    if (!TONES.has(input.tone)) throw new ActivityError(400, `tone must be one of ${[...TONES].join(", ")}`);
    board.tone = input.tone;
  }
  const tiles = parseTiles(input.tiles, MAX_BOARD_TILES);
  if (tiles !== undefined) board.tiles = tiles ?? [];
  const lines = parseLines(input.lines);
  if (lines !== undefined) board.lines = lines;
  if (input.room !== undefined) {
    const room = input.room === null ? "" : str(input.room, "room", 255);
    if (room && !room.startsWith("!")) throw new ActivityError(400, "room must be a room id (!…)");
    board.roomId = room;
  }

  if (!board.title && board.tiles.length === 0 && board.lines.length === 0) {
    throw new ActivityError(400, "a board needs a title, tiles or lines");
  }
  board.updatedAt = Math.floor(nowMs / 1000);
  return board;
}

async function readRegistry() {
  const doc = await readDoc(REGISTRY_TYPE);
  return { ...doc, boards: doc.boards ?? {} };
}

/** POST: set (merge) a board, or `clear: true` to remove it. */
export async function upsertBoard(input) {
  const id = input.id;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw new ActivityError(400, "id must be 1-64 of A-Z a-z 0-9 _ . : -");
  }
  const reg = await readRegistry();
  if (input.clear) {
    const existed = id in reg.boards;
    delete reg.boards[id];
    if (existed) await writeDoc(REGISTRY_TYPE, reg);
    return { id, cleared: existed };
  }
  if (!(id in reg.boards) && Object.keys(reg.boards).length >= MAX_BOARDS) {
    throw new ActivityError(400, `at most ${MAX_BOARDS} boards; clear one first`);
  }
  const board = buildBoard(input, reg.boards[id] ?? null);
  reg.boards[id] = board;
  await writeDoc(REGISTRY_TYPE, reg);
  return { id, board };
}

/** GET: every board, or `{ id, board }` (board null when unset) for one. */
export async function readBoards(id) {
  const reg = await readRegistry();
  if (id === undefined) return { boards: reg.boards };
  return { id, board: reg.boards[id] ?? null };
}
