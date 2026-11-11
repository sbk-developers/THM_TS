export type BindingKind = "local" | "enclosing" | "global" | "unbound";

export class SymbolTable {
  readonly locals = new Set<string>();
  readonly globals = new Set<string>();
  readonly nonlocals = new Set<string>();
  readonly captures = new Set<string>();

  constructor(
    readonly enclosing: ReadonlySet<string>,
    readonly isFunction: boolean,
  ) {}

  defineLocal(name: string): void {
    this.locals.add(name);
  }

  declareGlobal(name: string): void {
    this.globals.add(name);
  }

  declareNonlocal(name: string): void {
    this.nonlocals.add(name);
  }

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
