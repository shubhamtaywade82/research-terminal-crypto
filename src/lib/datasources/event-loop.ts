/** Yield to the event loop so timers, sockets and requests get a turn. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
