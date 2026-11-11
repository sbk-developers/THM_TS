export abstract class ManagedObject {
  constructor(readonly heapId: number) {}

  abstract references(): ManagedObject[];
  abstract clearReferences(): void;
}

export class ManagedHeap {
  private nextId = 1;
  private objects: ManagedObject[] = [];

  allocate<T extends ManagedObject>(factory: (heapId: number) => T): T {
    const object = factory(this.nextId++);
    this.objects.push(object);
    return object;
  }

  collect(roots: ManagedObject[]): number {
    const managedIds = new Set(this.objects.map((object) => object.heapId));
    const marked = new Set<number>();
    const worklist = [...roots];
    while (worklist.length > 0) {
      const current = worklist.pop();
      if (current === undefined || !managedIds.has(current.heapId) || marked.has(current.heapId)) continue;
      marked.add(current.heapId);
      worklist.push(...current.references());
    }

    let removed = 0;
    const survivors: ManagedObject[] = [];
    for (const object of this.objects) {
      if (marked.has(object.heapId)) {
        survivors.push(object);
      } else {
        object.clearReferences();
        removed++;
      }
    }
    this.objects = survivors;
    return removed;
  }

  size(): number {
    return this.objects.length;
  }
}
