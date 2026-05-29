export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[diff truncated at ${maxChars} chars; inspect files directly before editing]`;
}

export function hasControlCharacter(value: string): boolean {
  return [...value].some((char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

export function hasWhitespaceOrControl(value: string): boolean {
  return [...value].some((char) => {
    const code = char.charCodeAt(0);
    return char.trim() === "" || code < 32 || code === 127;
  });
}
