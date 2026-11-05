/** One server-sent event: the `event:` field (if any) and the joined `data:` lines. */
export interface SseEvent {
  event?: string
  data: string
}

/**
 * Parses a complete SSE text into events (WHATWG rules, simplified): events are separated by a blank
 * line, multiple `data:` lines are joined with '\n', comments and unknown fields are ignored.
 */
export function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = []
  let event: string | undefined
  let data: string[] = []
  const flush = () => {
    if (data.length > 0) events.push(event === undefined ? { data: data.join('\n') } : { event, data: data.join('\n') })
    event = undefined
    data = []
  }
  for (const raw of text.split(/\r\n|\r|\n/)) {
    if (raw === '') {
      flush()
      continue
    }
    if (raw.startsWith(':')) continue
    const colon = raw.indexOf(':')
    const field = colon === -1 ? raw : raw.slice(0, colon)
    let value = colon === -1 ? '' : raw.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  }
  flush()
  return events
}
