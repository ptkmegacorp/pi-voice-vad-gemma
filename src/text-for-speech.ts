/** Strip markdown/ANSI so assistant replies are safe to read aloud. */
export function textForSpeech(raw: string, maxChars = 2000): string {
  let text = raw
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length <= maxChars) return text;

  const truncated = text.slice(0, maxChars);
  const lastStop = Math.max(
    truncated.lastIndexOf(". "),
    truncated.lastIndexOf("! "),
    truncated.lastIndexOf("? "),
  );
  if (lastStop > maxChars * 0.5) {
    return truncated.slice(0, lastStop + 1).trim();
  }
  return `${truncated.trim()}...`;
}

export function extractAssistantSpeechText(
  content: Array<{ type: string; text?: string }>,
  maxChars: number,
): string {
  const text = content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text!.trim())
    .filter(Boolean)
    .join(" ");
  return textForSpeech(text, maxChars);
}
