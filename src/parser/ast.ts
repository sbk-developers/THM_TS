export type LiteralValue = null | boolean | bigint | number | string;

export type Expr =
  | { kind: "literal"; value: LiteralValue; line: number; column: number }
  | { kind: "bytes"; value: string; line: number; column: number }
  | { kind: "name"; name: string; line: number; column: number }
  | { kind: "tuple"; items: Expr[]; line: number; column: number }
  | { kind: "list"; items: Expr[]; line: number; column: number }
  | { kind: "set"; items: Expr[]; line: number; column: number }
  | { kind: "dict"; items: Array<[Expr, Expr]>; line: number; column: number }
  | { kind: "unary"; operator: string; operand: Expr; line: number; column: number }
  | { kind: "binary"; operator: string; left: Expr; right: Expr; line: number; column: number }
  | { kind: "compare"; first: Expr; rest: Array<{ operator: string; right: Expr }>; line: number; column: number }
  | { kind: "conditional"; whenTrue: Expr; condition: Expr; whenFalse: Expr; line: number; column: number }
  | { kind: "lambda"; parameters: Parameter[]; body: Expr; line: number; column: number }
  | { kind: "await"; value: Expr; line: number; column: number }
  | { kind: "yield"; value?: Expr; line: number; column: number }
  | { kind: "call"; callee: Expr; args: CallArgument[]; line: number; column: number }
  | { kind: "attribute"; receiver: Expr; name: string; line: number; column: number }
  | { kind: "index"; receiver: Expr; index: Expr; line: number; column: number }
  | { kind: "slice"; receiver: Expr; start?: Expr; stop?: Expr; step?: Expr; line: number; column: number }
  | { kind: "fstring"; parts: Array<string | Expr>; line: number; column: number }
  | { kind: "comprehension"; container: "list" | "set" | "dict"; element?: Expr; key?: Expr; clauses: Array<{ target: Expr; iterable: Expr; filters: Expr[]; isAsync: boolean }>; line: number; column: number };

export interface Parameter {
  name: string;
  kind: "positional" | "vararg" | "keywordOnly" | "kwarg";
  annotation?: string;
  defaultValue?: Expr;
}

export interface CallArgument {
  kind: "positional" | "keyword" | "star" | "keywordStar";
  value: Expr;
  name?: string;
}

export type Statement =
  | { kind: "expression"; expression: Expr; line: number; column: number }
  | { kind: "assign"; targets: Expr[]; value: Expr; line: number; column: number }
  | { kind: "annotate"; target: Expr; annotation: string; value?: Expr; line: number; column: number }
  | { kind: "augmentedAssign"; target: Expr; operator: string; value: Expr; line: number; column: number }
  | { kind: "function"; name: string; isAsync: boolean; isGenerator: boolean; typeParameters: string[]; parameters: Parameter[]; returnAnnotation?: string; decorators: Expr[]; body: Statement[]; line: number; column: number }
  | { kind: "class"; name: string; typeParameters: string[]; bases: Expr[]; metaclass?: Expr; decorators: Expr[]; body: Statement[]; line: number; column: number }
  | { kind: "if"; condition: Expr; body: Statement[]; otherwise: Statement[]; line: number; column: number }
  | { kind: "switch"; subject: Expr; cases: Array<{ value: Expr; body: Statement[] }>; defaultBody: Statement[]; line: number; column: number }
  | { kind: "while"; condition: Expr; body: Statement[]; otherwise: Statement[]; line: number; column: number }
  | { kind: "for"; target: Expr; iterable: Expr; body: Statement[]; otherwise: Statement[]; isAsync: boolean; line: number; column: number }
  | { kind: "return"; value?: Expr; line: number; column: number }
  | { kind: "break"; line: number; column: number }
  | { kind: "continue"; line: number; column: number }
  | { kind: "pass"; line: number; column: number }
  | { kind: "delete"; targets: Expr[]; line: number; column: number }
  | { kind: "scope"; scope: "global" | "nonlocal"; names: string[]; line: number; column: number }
  | { kind: "raise"; value?: Expr; line: number; column: number }
  | { kind: "assert"; condition: Expr; message?: Expr; line: number; column: number }
  | { kind: "try"; body: Statement[]; handlers: Array<{ type?: Expr; name?: string; body: Statement[] }>; otherwise: Statement[]; finalBody: Statement[]; line: number; column: number }
  | { kind: "import"; module: string; alias?: string; line: number; column: number }
  | { kind: "fromImport"; module: string; names: Array<{ name: string; alias?: string }>; line: number; column: number };

export interface Program {
  statements: Statement[];
}
