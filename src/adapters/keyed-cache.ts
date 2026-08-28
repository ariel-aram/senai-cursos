// A race-safe, TTL-cached, keyed async value store — the shared primitive every
// adapter's catalog/área/unit cache should go through instead of hand-rolling
// its own Map<key, {data, updatedAt}> + Map<key, Promise<...>> pair.
//
// It exists because that hand-rolled pattern broke twice in production, in ways
// that only showed up under real concurrent load:
//
//   1. RACE ON DUPLICATE BUILDS — if the "pending" map is set anywhere AFTER an
//      `await` (e.g. `await getAreaDefs()` before `pending.set(key, promise)`),
//      every concurrent caller for the same key passes the "not pending yet"
//      check before the first one registers, and each kicks off its own full
//      rebuild. Confirmed in practice: sp.ts's getCatalog() did this and caused
//      5 concurrent full-state scrapes to run at once during warmup, starving
//      every other adapter's requests on the same process.
//
//   2. POISONED EMPTY CACHE — if a transient failure resolves successfully but
//      empty (get() in http.ts swallows fetch errors into "" rather than
//      throwing), caching that empty result is indistinguishable from "this
//      state genuinely has zero areas/courses" and wedges every dependent
//      endpoint empty for a full TTL (2h default). Confirmed in practice: this
//      is exactly what took Tocantins's área dropdown to empty after one
//      transient fetch failure during startup contention.
//
// This class fixes both unconditionally: the pending promise is always
// registered synchronously (before the builder's first await can run), and a
// result is only cached when `isEmpty` says it's non-empty — an empty result
// still resolves for the caller (so the UI doesn't hang) but leaves the key
// eligible for an immediate retry on the next call instead of being wedged.
export class KeyedAsyncCache<T> {
	private readonly cache = new Map<string, { value: T; updatedAt: number }>();
	private readonly pending = new Map<string, Promise<T>>();

	constructor(
		private readonly ttlMs: number,
		private readonly isEmpty: (value: T) => boolean = () => false,
	) {}

	async get(key: string, build: () => Promise<T>): Promise<T> {
		const cached = this.cache.get(key);
		const isStale = !cached || Date.now() - cached.updatedAt > this.ttlMs;
		if (!isStale && cached) return cached.value;

		const existingPending = this.pending.get(key);
		if (existingPending) return existingPending;

		// `build()` is invoked synchronously here — it returns a pending promise
		// without suspending this function, so `.then/.catch` attach synchronously
		// too, and `this.pending.set()` below runs before this `get()` call ever
		// yields to the event loop. Any concurrent `get()` call for the same key
		// is guaranteed to see the pending entry, however soon it runs.
		const promise = build()
			.then((value) => {
				if (!this.isEmpty(value)) this.cache.set(key, { value, updatedAt: Date.now() });
				this.pending.delete(key);
				return this.isEmpty(value) ? (this.cache.get(key)?.value ?? value) : value;
			})
			.catch((err) => {
				this.pending.delete(key);
				throw err;
			});
		this.pending.set(key, promise);
		return promise;
	}

	/** Force the next get() for this key to rebuild, even if still within TTL. */
	invalidate(key: string): void {
		this.cache.delete(key);
	}
}
