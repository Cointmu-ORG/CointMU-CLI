import { stripColorWhenDisabled } from "./utils/color";

// Imported first by index.ts, ahead of the preflight, so every line cmu
// prints - the preflight's own error included - goes through the gate.
stripColorWhenDisabled(process.stdout);
stripColorWhenDisabled(process.stderr);
