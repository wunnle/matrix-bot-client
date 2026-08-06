#!/usr/bin/env node
// Makes the Claude skill library visible to Codex rooms.
//
// Both harnesses read the same file: a `SKILL.md` with `name` and `description`
// frontmatter (Codex only adds an optional metadata.short-description, so
// Claude's format is a strict subset). So the skills are shared by symlink
// rather than copied — one source of truth, nothing to keep in sync.
//
//   node scripts/link-codex-skills.mjs [--dry-run]
//
// Idempotent. Safe to re-run after adding a skill, and safe to run on a machine
// where someone has written native Codex skills: it never replaces anything it
// did not create.
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

// Overridable so the script can be exercised against a scratch pair of
// directories, and for installs that keep either harness somewhere else.
const SRC = process.env.CLAUDE_SKILLS_DIR ?? path.join(os.homedir(), '.claude', 'skills')
const DEST = process.env.CODEX_SKILLS_DIR ?? path.join(os.homedir(), '.codex', 'skills')
const DRY = process.argv.includes('--dry-run')

// Codex keeps its bundled skills in `.system`; anything starting with a dot is
// its own business, not a skill we should shadow.
const isCandidate = (name) => !name.startsWith('.')

// Codex silently ignores a skill whose SKILL.md is missing or has no
// description, which is how two empty directories sat in ~/.claude/skills
// looking like skills for months. Report them rather than linking them.
function readSkill(dir) {
  const file = path.join(dir, 'SKILL.md')
  if (!fs.existsSync(file)) return { ok: false, why: 'no SKILL.md' }
  const head = fs.readFileSync(file, 'utf8').slice(0, 2000)
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head)
  if (!fm) return { ok: false, why: 'no frontmatter' }
  if (!/^description:\s*\S/m.test(fm[1])) return { ok: false, why: 'no description in frontmatter' }
  return { ok: true }
}

if (!fs.existsSync(SRC)) {
  console.error(`No ${SRC} — nothing to link.`)
  process.exit(0)
}
if (!DRY) fs.mkdirSync(DEST, { recursive: true })

let linked = 0, already = 0, skipped = 0
for (const name of fs.readdirSync(SRC).sort()) {
  if (!isCandidate(name)) continue
  const from = path.join(SRC, name)
  if (!fs.statSync(from).isDirectory()) continue

  const skill = readSkill(from)
  if (!skill.ok) {
    console.log(`skip  ${name} — ${skill.why}; Codex would ignore it silently`)
    skipped++
    continue
  }

  const to = path.join(DEST, name)
  const existing = fs.lstatSync(to, { throwIfNoEntry: false })
  if (existing) {
    if (!existing.isSymbolicLink()) {
      // A real directory here is a native Codex skill of the same name. Its
      // author outranks this script.
      console.log(`skip  ${name} — ${to} exists and is not a symlink`)
      skipped++
      continue
    }
    const target = fs.readlinkSync(to)
    if (target === from) {
      already++
      continue
    }
    if (!target.startsWith(SRC + path.sep)) {
      console.log(`skip  ${name} — symlink points outside ${SRC} (${target})`)
      skipped++
      continue
    }
  }

  console.log(`${DRY ? 'would link' : 'link '} ${name} -> ${from}`)
  if (!DRY) fs.symlinkSync(from, to)
  linked++
}

// Links we once created whose source is gone or no longer a valid skill. Only
// reported, never removed: this script's job is to add, and a wrong guess here
// would delete something by surprise.
const stale = []
if (fs.existsSync(DEST)) {
  for (const name of fs.readdirSync(DEST).sort()) {
    if (!isCandidate(name)) continue
    const at = path.join(DEST, name)
    if (!fs.lstatSync(at).isSymbolicLink()) continue
    const target = fs.readlinkSync(at)
    if (!target.startsWith(SRC + path.sep)) continue
    if (!fs.existsSync(target) || !readSkill(target).ok) stale.push({ name, at })
  }
}

console.log(`\n${DRY ? '[dry run] ' : ''}${linked} linked, ${already} already current, ${skipped} skipped.`)
if (stale.length) {
  console.log(`\n${stale.length} stale link(s) — the source is gone or is not a valid skill, so Codex ignores them:`)
  for (const s of stale) console.log(`  ${s.at}`)
  console.log('Remove them by hand if you want the directory tidy.')
}
if (linked && !DRY) {
  console.log('Codex picks these up on its next skills scan; a running app-server needs skills/list with forceReload.')
}
