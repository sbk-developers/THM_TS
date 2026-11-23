/**
 * semantic-analyzer/symbol-table.ts
 * ---------------------------------------------------------------------------
 * Symbol table for one lexical scope. Records which names are locals,
 * globals, nonlocals or captured free variables during semantic analysis;
 * the compiler reads these sets to emit the right LOAD/STORE modes.

/** All binding kinds a name can have. */
export type BindingKind = "local" | "enclosing" | "global" | "unbound";

/** Binding classification for names referenced inside a scope. */
/** Collects bindings for a single scope during analysis. */
export class SymbolTable {
  readonly locals = new Set<string>();
  readonly globals = new Set<string>();
  readonly nonlocals = new Set<string>();
  readonly captures = new Set<string>();

  constructor(
    readonly enclosing: ReadonlySet<string>,
    readonly isFunction: boolean,
  ) {}

  // Mark a name as locally defined.
  defineLocal(name: string): void {
    this.locals.add(name);
  }

  // Mark a name as globally declared.
  declareGlobal(name: string): void {
    this.globals.add(name);
  }

  // Mark a name as nonlocally declared.
  declareNonlocal(name: string): void {
    this.nonlocals.add(name);
  }

  // Resolve a name to a binding kind; record captures for enclosing names.
  resolve(name: string): BindingKind {
    if (this.globals.has(name)) return "global";
    if (this.nonlocals.has(name)) return "enclosing";
    if (this.locals.has(name)) return "local";
    if (this.enclosing.has(name)) {
      this.captures.add(name);
      return "enclosing";
    }
    return "unbound";
  }
}
