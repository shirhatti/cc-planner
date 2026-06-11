// electrobun's bun API re-exports optional three.js helpers, but the
// package doesn't declare types for that optional dependency — stub it so
// importing "electrobun/bun" typechecks.
declare module "three";
