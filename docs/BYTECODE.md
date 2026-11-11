# THM bytecode

The bytecode implementation currently lives in
`src/compiler/bytecode/bytecode.ts`. A `Chunk` contains instructions,
constants, names, nested chunks, annotations, generic parameters, parameters,
local names, exception metadata, and a source filename. Instructions preserve
source line and column.

The validator checks opcodes, table indices, jump destinations, exception
metadata, stack underflow, and compatible stack depth at control-flow merges.
Stack effects are operand-aware for variable-sized collection builds,
unpacking, calls, and chained comparisons.

## `.thmc` version 6

The file is a binary container with a 14-byte header: `THMC` magic, a
big-endian 16-bit version, a big-endian 32-bit payload length, and a
big-endian 32-bit FNV-1a checksum of the payload. The payload is field-oriented
binary data, not JSON. Strings and collection lengths are UTF-8/unsigned
32-bit-length-prefixed. Chunks serialize their name and source file, numbered
opcodes and source locations, tagged constants, name tables, nested chunks,
metadata, and exception entries in a fixed order. Number constants use their
round-trippable decimal representation as a length-prefixed UTF-8 field.

The reader rejects unsupported versions, malformed lengths/tags/opcodes,
invalid UTF-8, checksum errors, trailing bytes, excessive nesting, and chunks
that fail bytecode validation. The disassembler prints each chunk and its
instructions, operands, and source locations. Opcode IDs follow the `opcodes`
array in `src/compiler/bytecode/bytecode.ts`; this order is part of version 6.
Integer constants are tagged separately from floating-point constants and are
encoded as decimal strings to preserve arbitrary precision.
