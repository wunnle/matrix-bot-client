/**
 * Human-readable model name from a raw id, for the chat header and !model
 * pills: claude-opus-5-5 → "Opus 5.5", gpt-6.1-sol → "Sol 6.1",
 * gpt-5.4-mini → "GPT 5.4 Mini". Anything unrecognised comes back as-is.
 */
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function formatModel(id: string): string {
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(id)
  if (claude) {
    const [, family, major, minor] = claude
    return `${cap(family)} ${minor ? `${major}.${minor}` : major}`
  }
  const gpt = /^gpt-(\d+(?:\.\d+)?)(?:-([a-z]+))?$/i.exec(id)
  if (gpt) {
    const [, version, variant] = gpt
    if (!variant) return `GPT ${version}`
    if (/^(mini|nano|pro)$/i.test(variant)) return `GPT ${version} ${cap(variant)}`
    return `${cap(variant)} ${version}`
  }
  return id
}
