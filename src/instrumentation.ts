// Next.js instrumentation hook: runs once when the server starts.
export async function register() {
  if (process.env.NPRS_DIAG === '1' && process.env.NEXT_RUNTIME !== 'edge') {
    const { startLagMonitor } = await import('@/lib/diagnostics/lag-monitor');
    startLagMonitor();
    console.log('[diag] event-loop lag monitor on');
  }
}
