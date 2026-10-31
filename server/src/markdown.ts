const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ENTITIES[char]!);
}

/** Inline markdown on already-escaped text: `code`, **bold**, *italic* and http(s) links. */
function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
}

/**
 * A small, safe subset of markdown for release notes: headings, bullet lists,
 * paragraphs and inline formatting. Everything else is escaped text.
 */
export function markdownToHtml(markdown: string): string {
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];

  const flush = () => {
    if (paragraph.length) blocks.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
    if (list.length) blocks.push(`<ul>${list.map((item) => `<li>${inline(item)}</li>`).join('')}</ul>`);
    paragraph = [];
    list = [];
  };

  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const item = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (!line.trim()) {
      flush();
    } else if (heading) {
      flush();
      blocks.push(`<h3>${inline(heading[1]!.trim())}</h3>`);
    } else if (item) {
      if (paragraph.length) flush();
      list.push(item[1]!.trim());
    } else if (list.length && /^\s+\S/.test(line)) {
      list[list.length - 1] += ` ${line.trim()}`;
    } else {
      if (list.length) flush();
      paragraph.push(line.trim());
    }
  }
  flush();
  return blocks.join('\n');
}
