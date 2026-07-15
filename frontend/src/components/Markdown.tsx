export function Markdown({ text, inline = false }: { text: string; inline?: boolean }) {
  // Markdown rendering has been removed to bypass airlock dependency blocking.
  // We simply render the plain text directly.
  return inline ? <span className="md md-inline">{text}</span> : <div className="md">{text}</div>;
}
