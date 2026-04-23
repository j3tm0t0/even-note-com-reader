import { getTextWidth } from '@evenrealities/pretext'

// Wrap a text into individual lines that fit within `maxWidth` pixels using
// the same glyph widths as the G2 firmware. Empty input lines (paragraph
// gaps) are preserved as empty strings so callers can rejoin with '\n' and
// keep visual paragraph separation.
//
// Greedy per-grapheme break: works for CJK (no whitespace) and falls through
// for Latin. Word-boundary preference is intentionally omitted — it adds
// complexity for a marginal win in news-style display.
export function wrapToLines(text: string, maxWidth: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    if (!para) {
      out.push('')
      continue
    }
    out.push(...wrapParagraph(para, maxWidth))
  }
  return out
}

function wrapParagraph(text: string, maxWidth: number): string[] {
  const out: string[] = []
  let line = ''
  for (const ch of Array.from(text)) {
    const candidate = line + ch
    if (getTextWidth(candidate) > maxWidth && line) {
      out.push(line)
      line = ch
    } else {
      line = candidate
    }
  }
  if (line) out.push(line)
  return out
}
