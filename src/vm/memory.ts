/**
 * vm/memory.ts
 * ---------------------------------------------------------------------------
 * Managed heap and garbage collection for THM runtime values.
 *
 * THM values that can form reference cycles live on a ManagedHeap instead of
 * relying on JS reference counting. Each ManagedObject gets a unique heap id
 * at allocation; collect() marks every object reachable from the given roots
 * and sweeps (drops) the rest, calling clearReferences() on freed objects.
 */

/** Managed heap base class: every heap-resident value extends this and
 *  reports its child references so the GC can mark reachable objects. */
export abstract class ManagedObject {
  constructor(readonly heapId: number) {}

  abstract references(): ManagedObject[];
  abstract clearReferences(): void;
}

/** A heap with mark-and-sweep garbage collection over ManagedObjects.
 *  Objects are allocated with unique ids; collect() walks roots and frees
 *  every object the roots cannot reach. */
export class ManagedHeap {
  private nextId = 1;
  private objects: ManagedObject[] = [];

  /** Allocate a new managed object and assign it a heap ID. */
  allocate<T extends ManagedObject>(factory: (heapId: number) => T): T {
    const object = factory(this.nextId++);
    this.objects.push(object);
    return object;
  }

  /** Mark from `roots`, sweep the rest, and return the number freed. */
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

  // Return the number of live managed objects.
  size(): number {
    return this.objects.length;
  }
}
