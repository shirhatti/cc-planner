/**
 * Static checks for the small programs passed to sed and awk. Both
 * languages can write files and run commands from inside the script
 * (sed `w`/`e`, awk `system()`/`print > file`/pipes), so a script is only
 * safe if a scan finds none of those. Any construct the scanners don't
 * recognise makes the script unsafe.
 */

export interface ScriptCheck {
  safe: boolean;
  reason?: string;
  /** The script reads extra files (sed `r`/`R`). */
  readsFiles?: boolean;
}

const UNSAFE = (reason: string): ScriptCheck => ({ safe: false, reason });

// ---------------------------------------------------------------------------
// sed
// ---------------------------------------------------------------------------

export function checkSedScript(script: string): ScriptCheck {
  const s = script;
  let i = 0;
  let readsFiles = false;

  /** Read a delimited section (regex/replacement) ending at `delim`. */
  const readDelimited = (delim: string): boolean => {
    while (i < s.length) {
      const c = s[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === delim) {
        i++;
        return true;
      }
      i++;
    }
    return false;
  };

  const readAddress = (): boolean => {
    const c = s[i];
    if (c === undefined) return true;
    if (/[0-9]/.test(c)) {
      while (/[0-9]/.test(s[i] ?? "")) i++;
      if (s[i] === "~") {
        i++;
        while (/[0-9]/.test(s[i] ?? "")) i++;
      }
      return true;
    }
    if (c === "$") {
      i++;
      return true;
    }
    if (c === "/" || c === "\\") {
      let delim = "/";
      if (c === "\\") {
        delim = s[i + 1] ?? "";
        if (!delim || delim === "\n" || delim === "\\") return false;
        i++;
      }
      i++;
      if (!readDelimited(delim)) return false;
      while (s[i] === "I" || s[i] === "M") i++;
      return true;
    }
    return true;
  };

  const skipToLineEnd = () => {
    while (i < s.length && s[i] !== "\n") {
      if (s[i] === "\\" && s[i + 1] === "\n") i++;
      i++;
    }
  };

  const skipLabel = () => {
    while (i < s.length && s[i] !== "\n" && s[i] !== ";") i++;
  };

  while (i < s.length) {
    const c = s[i];
    if (/[\s;]/.test(c)) {
      i++;
      continue;
    }
    if (c === "#") {
      skipToLineEnd();
      continue;
    }
    if (c === "}") {
      i++;
      continue;
    }
    if (!readAddress()) return UNSAFE("unparseable sed address");
    if (s[i] === ",") {
      i++;
      if (s[i] === "+" || s[i] === "~") i++;
      if (!readAddress()) return UNSAFE("unparseable sed address");
    }
    while (s[i] === " " || s[i] === "\t") i++;
    while (s[i] === "!" || s[i] === " ") i++;
    const cmd = s[i];
    if (cmd === undefined) return UNSAFE("sed address without command");
    i++;
    switch (cmd) {
      case "{":
        continue;
      case "s": {
        const delim = s[i];
        if (!delim || delim === "\\" || delim === "\n") return UNSAFE("bad s delimiter");
        i++;
        if (!readDelimited(delim) || !readDelimited(delim)) {
          return UNSAFE("unterminated s command");
        }
        while (i < s.length && /[gpiImM0-9]/.test(s[i])) i++;
        if (s[i] === "w" || s[i] === "W") return UNSAFE("sed s///w writes a file");
        if (s[i] === "e") return UNSAFE("sed s///e executes a command");
        break;
      }
      case "y": {
        const delim = s[i];
        if (!delim || delim === "\\" || delim === "\n") return UNSAFE("bad y delimiter");
        i++;
        if (!readDelimited(delim) || !readDelimited(delim)) {
          return UNSAFE("unterminated y command");
        }
        break;
      }
      case "a":
      case "i":
      case "c":
        skipToLineEnd();
        continue;
      case "r":
      case "R":
        readsFiles = true;
        skipToLineEnd();
        continue;
      case "w":
      case "W":
        return UNSAFE(`sed ${cmd} writes a file`);
      case "e":
        return UNSAFE("sed e executes a command");
      case "b":
      case "t":
      case "T":
      case ":":
      case "v":
        skipLabel();
        continue;
      case "q":
      case "Q":
      case "l":
      case "L":
        while (s[i] === " ") i++;
        while (/[0-9]/.test(s[i] ?? "")) i++;
        break;
      default:
        if (!"=dDgGhHnNpPxzF".includes(cmd)) return UNSAFE(`unknown sed command '${cmd}'`);
    }
    while (s[i] === " " || s[i] === "\t") i++;
    if (i < s.length && !/[;\n}#]/.test(s[i])) {
      return UNSAFE(`unexpected '${s[i]}' after sed command`);
    }
  }
  return { safe: true, readsFiles };
}

// ---------------------------------------------------------------------------
// awk
// ---------------------------------------------------------------------------

/** Keywords after which a `/` starts a regex rather than a division. */
const AWK_NON_OPERAND_KEYWORDS = new Set(["print", "printf", "return", "in", "case", "do", "else"]);

export function checkAwkScript(script: string): ScriptCheck {
  const s = script;
  let i = 0;
  /** Previous significant token was an operand (so `/` means divide). */
  let prevOperand = false;
  let inPrint = false;
  let depth = 0;

  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "\n") {
      i += 2;
      continue;
    }
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    if (c === "#") {
      while (i < s.length && s[i] !== "\n") i++;
      continue;
    }
    if (c === "\n" || c === ";" || c === "{" || c === "}") {
      if (c !== "\n" || depth === 0) inPrint = false;
      if (c === "{" || c === "}") depth = 0;
      prevOperand = false;
      i++;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') i += s[i] === "\\" ? 2 : 1;
      if (i >= s.length) return UNSAFE("unterminated awk string");
      i++;
      prevOperand = true;
      continue;
    }
    if (c === "/" && !prevOperand) {
      i++;
      while (i < s.length && s[i] !== "/" && s[i] !== "\n") i += s[i] === "\\" ? 2 : 1;
      if (s[i] !== "/") return UNSAFE("unterminated awk regex");
      i++;
      prevOperand = true;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
      const ident = s.slice(i, j);
      i = j;
      if (ident === "system" || ident === "getline") {
        return UNSAFE(`awk ${ident} can run commands or read arbitrary files`);
      }
      if (ident === "print" || ident === "printf") {
        inPrint = true;
        depth = 0;
      }
      prevOperand = !AWK_NON_OPERAND_KEYWORDS.has(ident);
      continue;
    }
    if (/[0-9.]/.test(c)) {
      while (i < s.length && /[0-9.eE]/.test(s[i])) i++;
      prevOperand = true;
      continue;
    }
    if (c === "@") return UNSAFE("gawk @-directives");
    if (c === "|") {
      if (s[i + 1] === "|") {
        i += 2;
        prevOperand = false;
        continue;
      }
      return UNSAFE("awk pipes run commands");
    }
    if (c === ">" && inPrint && depth === 0) return UNSAFE("awk print > writes a file");
    if (c === "(" || c === "[") depth++;
    if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
    prevOperand = c === ")" || c === "]" || c === "$";
    i++;
  }
  return { safe: true };
}
