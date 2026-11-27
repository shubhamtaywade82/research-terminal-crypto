// Version counter for the stored datasets. Bumped after every committed dataset write,
// so cached summaries (the status endpoint's coverage table) are rebuilt exactly when
// the data changed, instead of re-aggregating millions of rows on every poll.

const g = globalThis as unknown as { __nprsDatasetVersion?: number };

export function currentDatasetVersion(): number {
  return g.__nprsDatasetVersion ?? 0;
}

export function bumpDatasetVersion(): void {
  g.__nprsDatasetVersion = currentDatasetVersion() + 1;
}
