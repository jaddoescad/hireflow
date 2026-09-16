// Serialize writes to one candidate while keeping its newest destination visible.
// Different candidates (and companies) can save independently.
export class OptimisticMoves {
  private targets = new Map<string, string>();
  private tails = new Map<string, Promise<unknown>>();
  private versions = new Map<string, object>();

  constructor(private changed: (targets: Map<string, string>) => void) {}

  async move<T>(
    key: string,
    stage: string,
    save: () => Promise<T>,
    commit: () => void,
  ): Promise<T> {
    const version = {};
    this.versions.set(key, version);
    this.targets.set(key, stage);
    this.changed(new Map(this.targets));
    const previous = this.tails.get(key);
    const task = (async () => {
      await previous?.catch(() => {});
      const result = await save();
      commit();
      return result;
    })();
    this.tails.set(key, task);
    try {
      return await task;
    } finally {
      if (this.versions.get(key) === version) {
        this.versions.delete(key);
        this.targets.delete(key);
        this.tails.delete(key);
        this.changed(new Map(this.targets));
      }
    }
  }
}
