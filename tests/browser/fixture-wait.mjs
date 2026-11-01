/** Await fixture IO explicitly; a Promise is truthy in the browser predicate poller. */
export async function waitForFixtureStats(read, matches, timeoutMs = 8000) {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (matches(value)) return value
    if (performance.now() >= deadline) throw new Error('The synthetic source did not reach the expected observable state')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}
