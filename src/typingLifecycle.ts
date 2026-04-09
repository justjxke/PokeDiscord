export async function withManagedTypingIndicator<T>(
  typingStops: Map<string, () => Promise<void>>,
  bridgeRequestId: string,
  startIndicator: () => Promise<() => Promise<void>>,
  operation: () => Promise<T>,
  onStopError?: (error: unknown) => void
): Promise<T> {
  if (!typingStops.has(bridgeRequestId)) {
    try {
      typingStops.set(bridgeRequestId, await startIndicator());
    } catch {
      // Typing is best-effort only.
    }
  }

  try {
    return await operation();
  } finally {
    const stopTyping = typingStops.get(bridgeRequestId);
    if (stopTyping) {
      typingStops.delete(bridgeRequestId);
      try {
        await stopTyping();
      } catch (error) {
        onStopError?.(error);
      }
    }
  }
}
