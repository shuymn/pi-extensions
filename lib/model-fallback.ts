const RETRYABLE_ERROR_PATTERN =
  /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|terminated|retry delay|model.?unavailable|model.?not.?available|model.?not.?found/i;
const NON_FALLBACK_ERROR_PATTERN =
  /\b(401|403|unauthorized|forbidden|invalid api key|authentication|authorization)\b/i;

export function shouldFallbackForError(errorMessage: unknown): boolean {
  if (typeof errorMessage !== "string" || errorMessage.trim() === "") return false;
  if (NON_FALLBACK_ERROR_PATTERN.test(errorMessage)) return false;
  return RETRYABLE_ERROR_PATTERN.test(errorMessage);
}
