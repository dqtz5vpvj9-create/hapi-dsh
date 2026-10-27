/** Pin the oldest archived turn by source identity, independently of rail DOM order. */
export function selectSourceNavigationTarget(outline) {
  if (!outline || outline.complete === false || !Number.isSafeInteger(outline.firstTurn)
    || !Array.isArray(outline.entries)) throw new Error('No complete source outline for navigation');
  const entries = outline.entries.filter(row => Number.isSafeInteger(row?.turn) && row.turn >= 0
    && row.turn < outline.firstTurn && typeof row.messageId === 'string' && row.messageId.length > 0);
  if (!entries.length) throw new Error('Source outline has no archived navigation target');
  const target = entries.reduce((oldest, row) => row.turn < oldest.turn ? row : oldest);
  if (outline.entries.filter(row => row.turn === target.turn || row.messageId === target.messageId).length !== 1)
    throw new Error('Source navigation target identity is ambiguous');
  return { turn: target.turn, messageId: target.messageId };
}

/** Outline prompts may be truncated labels; prove the exact body from its source row. */
export function sourceNavigationText(records, target) {
  const messages = records.filter(row => row?.event?.type === 'user/message');
  const matching = messages.filter(row => row.source?.messageId === target.messageId);
  if (matching.length !== 1) throw new Error('Source navigation page did not contain one exact target user message');
  const contents = matching[0].event.data?.content;
  const texts = Array.isArray(contents) ? contents.filter(part => part?.type === 'text' && typeof part.text === 'string'
    && part.text.trim().length > 0).map(part => part.text) : [];
  if (texts.length !== 1) throw new Error('Source navigation target has no unique exact text block');
  const text = texts[0];
  // Keep raw source text in the proof. Rendering trims outer whitespace, so
  // distinct source identities differing only there are still ambiguous.
  if (messages.some(row => row !== matching[0] && Array.isArray(row.event.data?.content)
    && row.event.data.content.some(part => part?.type === 'text' && typeof part.text === 'string'
      && part.text.trim() === text.trim())))
    throw new Error('Source navigation target text is ambiguous in its context page');
  return text;
}

const sourcePositionValid = source => typeof source?.messageId === 'string' && source.messageId.length > 0
  && Number.isFinite(source.at) && Number.isSafeInteger(source.seq) && source.seq >= 0;
const compareSourcePosition = (left, right) => left.at - right.at || left.seq - right.seq;
const messageTexts = row => {
  const event = row?.event;
  const content = event?.type === 'user/message' ? event.data?.content
    : event?.type === 'assistant/message' ? event.data?.message?.content : undefined;
  return Array.isArray(content) ? content.filter(part => part?.type === 'text' && typeof part.text === 'string'
    && part.text.trim().length > 0).map(part => part.text) : [];
};

/** The authoritative head may be a tool/lifecycle row. Pin the latest readable
 * message at or before that exact head, from this bounded contiguous context. */
export function sourceLatestTarget(records, head) {
  if (!sourcePositionValid(head)) throw new Error('Source outline has no exact latest identity and position');
  const headRows = records.filter(row => row?.source?.messageId === head.messageId);
  if (!headRows.length || headRows.some(row => !sourcePositionValid(row.source)
    || compareSourcePosition(row.source, head) !== 0))
    throw new Error('Source head page did not contain the exact authoritative head');
  const messages = records.flatMap(row => {
    const texts = messageTexts(row);
    if (!texts.length) return [];
    if (!sourcePositionValid(row.source)) throw new Error('Source latest text has no exact source position');
    return [{ row, texts }];
  });
  const candidates = messages.filter(({ row }) => compareSourcePosition(row.source, head) <= 0);
  if (!candidates.length) throw new Error('Source head context contains no readable latest text');
  const latest = candidates.reduce((last, entry) => compareSourcePosition(entry.row.source, last.row.source) > 0 ? entry : last);
  if (candidates.filter(({ row }) => row.source.messageId === latest.row.source.messageId
    || compareSourcePosition(row.source, latest.row.source) === 0).length !== 1)
    throw new Error('Source latest text identity is ambiguous');
  if (latest.texts.length !== 1) throw new Error('Source latest message has no unique exact text block');
  const text = latest.texts[0];
  if (messages.some(entry => entry !== latest && entry.texts.some(other => other.trim() === text.trim())))
    throw new Error('Source latest text is ambiguous in its context page');
  return { messageId: latest.row.source.messageId, at: latest.row.source.at, seq: latest.row.source.seq,
    eventType: latest.row.event.type, text };
}

/** Compatibility for private cold-opening baselines, with the same exact proof. */
export function sourceLatestText(records, head) { return sourceLatestTarget(records, head).text; }

/** Freeze a rendered source watermark, including a completed tool whose text is
 * legitimately newer than the last assistant answer. Lifecycle annotations may
 * prove the head boundary without owning a visible card themselves. */
export function sourceOpeningTarget(records, head) {
  if (!sourcePositionValid(head)) throw new Error('Source outline has no exact latest identity and position');
  const headRows = records.filter(row => row?.source?.messageId === head.messageId);
  if (!headRows.length || headRows.some(row => !sourcePositionValid(row.source)
    || compareSourcePosition(row.source, head) !== 0))
    throw new Error('Source head page did not contain the exact authoritative head');
  const candidates = records.flatMap(row => {
    const texts = messageTexts(row), result = row?.event?.type === 'tool/result';
    if (!texts.length && !result) return [];
    if (!sourcePositionValid(row.source)) throw new Error('Source opening item has no exact source position');
    if (compareSourcePosition(row.source, head) > 0) return [];
    return [{ row, texts, result }];
  });
  if (!candidates.length) throw new Error('Source head context contains no rendered text or completed tool');
  const latest = candidates.reduce((last, item) => compareSourcePosition(item.row.source, last.row.source) > 0 ? item : last);
  if (latest.row.source.messageId !== head.messageId && headRows.some(row =>
    ['user/message', 'assistant/message', 'tool/call', 'tool/result'].includes(row.event?.type)))
    throw new Error('The rendered source head has no supported exact visible watermark');
  if (candidates.filter(({ row }) => row.source.messageId === latest.row.source.messageId
    || compareSourcePosition(row.source, latest.row.source) === 0).length !== 1)
    throw new Error('Source opening item identity is ambiguous');
  const common = { ...latest.row.source, eventType: latest.row.event.type,
    sourceHead: { ...head }, targetAtHead: latest.row.source.messageId === head.messageId };
  if (latest.result) {
    const message = latest.row.event.data?.message;
    const callId = message?.source?.callId;
    if (typeof callId !== 'string' || !callId || (message.toolCallId !== undefined && message.toolCallId !== callId))
      throw new Error('Source tool result has no unambiguous official call identity');
    return { ...common, marker: { kind: 'tool-result', callId } };
  }
  if (latest.texts.length !== 1) throw new Error('Source opening message has no unique exact text block');
  if (candidates.some(item => item !== latest && item.texts.some(text => text.trim() === latest.texts[0].trim())))
    throw new Error('Source opening text is ambiguous in its context page');
  return { ...common, marker: { kind: 'text', text: latest.texts[0] } };
}
