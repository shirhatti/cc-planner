/**
 * A conservative parser for the POSIX-ish subset of bash that Claude Code
 * writes in Bash tool calls. It does not execute or expand anything: it
 * flattens a command line into the simple commands it would run — including
 * every command inside `$(...)`, backticks, `<(...)`/`>(...)`, subshells and
 * `{ ...; }` groups — so the policy can judge each one.
 *
 * Anything it cannot confidently model (unbalanced quotes, control flow,
 * function definitions, assigning parameter expansions, arithmetic over
 * variables, heredocs with substitutions, ...) raises `UnsupportedSyntax`,
 * which the policy turns into "ask".
 */

export class UnsupportedSyntax extends Error {}

/** One shell word after quote removal. */
export interface Word {
  /** Literal text with quotes removed; expansions are kept as raw source. */
  text: string;
  /** Contains a parameter expansion or command substitution. */
  dynamic: boolean;
  /**
   * The word's final value is not knowable statically in a way that matters
   * for option parsing: it may start with `-` (leading expansion or glob) or
   * split into several words (unquoted expansion).
   */
  opaque: boolean;
  /** The whole word is a process substitution (`<(...)` / `>(...)`). */
  procSubst: boolean;
}

export interface Redirect {
  /** `>`, `>>`, `>|`, `&>`, `&>>`, `<`, `<>`, `>&`, `<&`, `<<`, `<<-`, `<<<`. */
  op: string;
  /** Explicit file-descriptor prefix (`2>`), if any. */
  fd?: string;
  target: Word;
}

export interface Assignment {
  name: string;
  value: Word;
}

export interface SimpleCommand {
  assignments: Assignment[];
  words: Word[];
  redirects: Redirect[];
}

const KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "function",
  "select",
  "coproc",
  "[[",
  "]]",
]);

const MAX_DEPTH = 16;

/** Characters that end an unquoted word. */
function isMeta(c: string | undefined): boolean {
  return (
    c === undefined ||
    c === " " ||
    c === "\t" ||
    c === "\n" ||
    c === ";" ||
    c === "&" ||
    c === "|" ||
    c === "(" ||
    c === ")" ||
    c === "<" ||
    c === ">"
  );
}

interface PendingHeredoc {
  delimiter: string;
  quoted: boolean;
  stripTabs: boolean;
}

/** Parse a full command line into the flat list of simple commands it runs. */
export function parseCommandLine(src: string): SimpleCommand[] {
  const out: SimpleCommand[] = [];
  new Parser(src, out, 0).parseProgram();
  return out;
}

class Parser {
  private pos = 0;
  private heredocs: PendingHeredoc[] = [];

  constructor(
    private readonly src: string,
    private readonly out: SimpleCommand[],
    private readonly depth: number,
  ) {
    if (depth > MAX_DEPTH) throw new UnsupportedSyntax("nesting too deep");
  }

  parseProgram(): void {
    this.parseList(undefined);
    if (this.pos < this.src.length) {
      throw new UnsupportedSyntax(`unexpected '${this.src[this.pos]}'`);
    }
    if (this.heredocs.length) throw new UnsupportedSyntax("unterminated heredoc");
  }

  // -------------------------------------------------------------------------
  // Lists, pipelines, compound commands
  // -------------------------------------------------------------------------

  /**
   * Parse `pipeline ((; | & | && | || | newline) pipeline)*` until `term`
   * (`)` or `}`) or end of input. Does not consume the terminator.
   */
  private parseList(term: ")" | "}" | undefined): void {
    for (;;) {
      this.skipBlanksAndNewlines();
      if (this.atEnd()) return;
      if (term === ")" && this.peek() === ")") return;
      if (term === "}" && this.atReservedClose()) return;
      this.parsePipeline(term);
      this.skipBlanks();
      if (this.atEnd()) return;
      const c = this.peek();
      if (c === "\n") continue;
      if (this.src.startsWith("&&", this.pos) || this.src.startsWith("||", this.pos)) {
        this.pos += 2;
        this.skipBlanksAndNewlines();
        this.requireCommandStart(term);
        continue;
      }
      if (c === ";" || c === "&") {
        if (this.src.startsWith(";;", this.pos)) throw new UnsupportedSyntax("';;'");
        this.pos++;
        continue;
      }
      if (term === ")" && c === ")") return;
      throw new UnsupportedSyntax(`unexpected '${c}'`);
    }
  }

  private requireCommandStart(term: string | undefined): void {
    const c = this.peek();
    if (
      this.atEnd() ||
      c === ";" ||
      c === "&" ||
      c === "|" ||
      (c === ")" && term === ")") ||
      (term === "}" && this.atReservedClose())
    ) {
      throw new UnsupportedSyntax("missing command after operator");
    }
  }

  private parsePipeline(term: ")" | "}" | undefined): void {
    for (;;) {
      this.parseCommand(term);
      this.skipBlanks();
      if (this.peek() === "|" && this.src[this.pos + 1] !== "|") {
        this.pos += this.src[this.pos + 1] === "&" ? 2 : 1;
        this.skipBlanksAndNewlines();
        this.requireCommandStart(term);
        continue;
      }
      return;
    }
  }

  private parseCommand(term: ")" | "}" | undefined): void {
    this.skipBlanks();
    const c = this.peek();
    if (c === "(") {
      if (this.src[this.pos + 1] === "(") throw new UnsupportedSyntax("arithmetic command");
      this.pos++;
      this.parseList(")");
      if (this.peek() !== ")") throw new UnsupportedSyntax("unterminated subshell");
      this.pos++;
      this.parseTrailingRedirects();
      return;
    }
    if (c === "{" && /[\s]/.test(this.src[this.pos + 1] ?? "")) {
      this.pos++;
      this.parseList("}");
      if (!this.atReservedClose()) throw new UnsupportedSyntax("unterminated group");
      this.pos++;
      this.parseTrailingRedirects();
      return;
    }
    this.parseSimple(term);
  }

  /** Redirections after `( ... )` or `{ ...; }` apply to the whole group. */
  private parseTrailingRedirects(): void {
    const cmd: SimpleCommand = { assignments: [], words: [], redirects: [] };
    for (;;) {
      this.skipBlanks();
      const redirect = this.tryRedirect();
      if (!redirect) break;
      cmd.redirects.push(redirect);
    }
    if (!this.atEnd() && !isMeta(this.peek())) {
      throw new UnsupportedSyntax("unexpected word after group");
    }
    if (cmd.redirects.length) this.out.push(cmd);
  }

  private parseSimple(term: ")" | "}" | undefined): void {
    const cmd: SimpleCommand = { assignments: [], words: [], redirects: [] };
    for (;;) {
      this.skipBlanks();
      if (this.atEnd()) break;
      const c = this.peek();
      const redirect = this.tryRedirect();
      if (redirect) {
        cmd.redirects.push(redirect);
        continue;
      }
      if (c === "(") throw new UnsupportedSyntax("unexpected '('");
      if (isMeta(c) && !this.startsProcSubst()) break;
      if (term === "}" && cmd.words.length === 0 && this.atReservedClose()) break;

      if (cmd.words.length === 0) {
        const assign = /^[A-Za-z_][A-Za-z0-9_]*\+?=/.exec(this.src.slice(this.pos));
        if (assign) {
          const name = assign[0].replace(/\+?=$/, "");
          this.pos += assign[0].length;
          if (this.peek() === "(") throw new UnsupportedSyntax("array assignment");
          const value = isMeta(this.peek()) ? literalWord("") : this.readWord();
          cmd.assignments.push({ name, value });
          continue;
        }
      }
      const word = this.readWord();
      if (cmd.words.length === 0 && !word.dynamic && KEYWORDS.has(word.text) && this.wasUnquoted) {
        throw new UnsupportedSyntax(`'${word.text}' (control flow)`);
      }
      if (this.peek() === "(" && cmd.words.length === 0) {
        throw new UnsupportedSyntax("function definition");
      }
      cmd.words.push(word);
    }
    if (!cmd.words.length && !cmd.assignments.length && !cmd.redirects.length) {
      if (!this.atEnd() && this.peek() !== "\n" && this.peek() !== ")") {
        throw new UnsupportedSyntax(`unexpected '${this.peek()}'`);
      }
      return;
    }
    this.out.push(cmd);
  }

  // -------------------------------------------------------------------------
  // Redirections and heredocs
  // -------------------------------------------------------------------------

  private tryRedirect(): Redirect | null {
    const m = /^(\d*)(&>>|&>|>>|>\||>&|>|<<<|<<-|<<|<&|<>|<)/.exec(this.src.slice(this.pos));
    if (!m) return null;
    const [whole, fd, op] = m;
    // `<(` / `>(` is process substitution, not a redirect.
    if ((op === "<" || op === ">") && this.src[this.pos + whole.length] === "(") {
      if (fd) throw new UnsupportedSyntax("fd before process substitution");
      return null;
    }
    if (fd && op.startsWith("&")) throw new UnsupportedSyntax("malformed redirect");
    this.pos += whole.length;
    this.skipBlanks();
    if (isMeta(this.peek()) && !this.startsProcSubst()) {
      throw new UnsupportedSyntax("redirect without target");
    }
    if (op === "<<" || op === "<<-") {
      const start = this.pos;
      const target = this.readWord();
      const raw = this.src.slice(start, this.pos);
      if (target.dynamic) throw new UnsupportedSyntax("dynamic heredoc delimiter");
      this.heredocs.push({
        delimiter: target.text,
        quoted: /['"\\]/.test(raw),
        stripTabs: op === "<<-",
      });
      return { op, fd: fd || undefined, target };
    }
    return { op, fd: fd || undefined, target: this.readWord() };
  }

  private startsProcSubst(): boolean {
    const c = this.peek();
    return (c === "<" || c === ">") && this.src[this.pos + 1] === "(";
  }

  /** Consume heredoc bodies that start after the newline just consumed. */
  private readHeredocBodies(): void {
    while (this.heredocs.length) {
      const doc = this.heredocs.shift()!;
      let found = false;
      while (this.pos < this.src.length) {
        const nl = this.src.indexOf("\n", this.pos);
        const end = nl === -1 ? this.src.length : nl;
        let line = this.src.slice(this.pos, end);
        this.pos = nl === -1 ? this.src.length : nl + 1;
        if (doc.stripTabs) line = line.replace(/^\t+/, "");
        if (line === doc.delimiter) {
          found = true;
          break;
        }
        if (!doc.quoted && /`|\$\(|\$\[|\$\{/.test(line)) {
          throw new UnsupportedSyntax("heredoc with expansions");
        }
      }
      if (!found) throw new UnsupportedSyntax("unterminated heredoc");
    }
  }

  // -------------------------------------------------------------------------
  // Words
  // -------------------------------------------------------------------------

  /** Whether the last word read contained no quoting at all. */
  private wasUnquoted = true;

  private readWord(): Word {
    const word: Word = { text: "", dynamic: false, opaque: false, procSubst: false };
    this.wasUnquoted = true;

    if (this.startsProcSubst()) {
      const open = this.pos;
      this.pos += 2;
      this.parseNested(")");
      word.text = this.src.slice(open, this.pos);
      word.procSubst = true;
      word.dynamic = true;
      if (!isMeta(this.peek())) throw new UnsupportedSyntax("text after process substitution");
      return word;
    }

    // Globs and brace expansions can expand to option-like file names.
    const lead = /^(?:[*?]|\[[^\s\]]*\]|\{[^\s}]*,)/.test(this.src.slice(this.pos));
    if (lead) word.opaque = true;

    while (!this.atEnd()) {
      const c = this.peek();
      if (isMeta(c)) break;
      const atStart = word.text === "";
      if (c === "\\") {
        const next = this.src[this.pos + 1];
        if (next === undefined) throw new UnsupportedSyntax("trailing backslash");
        this.pos += 2;
        this.wasUnquoted = false;
        if (next !== "\n") word.text += next;
        continue;
      }
      if (c === "'") {
        const end = this.src.indexOf("'", this.pos + 1);
        if (end === -1) throw new UnsupportedSyntax("unbalanced single quote");
        word.text += this.src.slice(this.pos + 1, end);
        this.pos = end + 1;
        this.wasUnquoted = false;
        continue;
      }
      if (c === '"') {
        this.pos++;
        this.wasUnquoted = false;
        this.readDoubleQuoted(word, atStart);
        continue;
      }
      if (c === "$" && this.src[this.pos + 1] === "'") {
        this.pos += 2;
        this.wasUnquoted = false;
        word.text += this.readAnsiC();
        continue;
      }
      if (c === "$" && this.src[this.pos + 1] === '"') {
        this.pos += 2;
        this.wasUnquoted = false;
        this.readDoubleQuoted(word, atStart);
        continue;
      }
      if (c === "$" || c === "`") {
        const start = this.pos;
        if (this.readExpansion()) {
          word.text += this.src.slice(start, this.pos);
          word.dynamic = true;
          word.opaque = true; // unquoted: may split into several words
          continue;
        }
      }
      word.text += c;
      this.pos++;
    }
    return word;
  }

  /** Contents of "..." (opening quote already consumed). */
  private readDoubleQuoted(word: Word, atStart: boolean): void {
    let first = true;
    for (;;) {
      if (this.atEnd()) throw new UnsupportedSyntax("unbalanced double quote");
      const c = this.peek();
      if (c === '"') {
        this.pos++;
        return;
      }
      if (c === "\\") {
        const next = this.src[this.pos + 1];
        if (next === undefined) throw new UnsupportedSyntax("unbalanced double quote");
        if (next === "$" || next === "`" || next === '"' || next === "\\") word.text += next;
        else if (next !== "\n") word.text += c + next;
        this.pos += 2;
        first = false;
        continue;
      }
      if (c === "$" || c === "`") {
        const start = this.pos;
        if (this.readExpansion()) {
          word.text += this.src.slice(start, this.pos);
          word.dynamic = true;
          // Quoted expansions don't split, but a leading one may yield `-x`.
          if (atStart && first) word.opaque = true;
          first = false;
          continue;
        }
      }
      word.text += c;
      this.pos++;
      first = false;
    }
  }

  /** `$'...'` ANSI-C quoting (opening `$'` consumed). */
  private readAnsiC(): string {
    let text = "";
    const escapes: Record<string, string> = {
      n: "\n",
      t: "\t",
      r: "\r",
      a: "\x07",
      b: "\b",
      e: "\x1b",
      E: "\x1b",
      f: "\f",
      v: "\v",
      "\\": "\\",
      "'": "'",
      '"': '"',
      "?": "?",
    };
    for (;;) {
      if (this.atEnd()) throw new UnsupportedSyntax("unbalanced $' quote");
      const c = this.peek();
      if (c === "'") {
        this.pos++;
        return text;
      }
      if (c === "\\") {
        const next = this.src[this.pos + 1];
        if (next === undefined) throw new UnsupportedSyntax("unbalanced $' quote");
        text += escapes[next] ?? "\\" + next;
        this.pos += 2;
        continue;
      }
      text += c;
      this.pos++;
    }
  }

  /**
   * At `$` or a backtick: consume one expansion, parsing any nested command
   * bodies. Returns false if the `$` is just a literal dollar sign.
   */
  private readExpansion(): boolean {
    const c = this.peek();
    if (c === "`") {
      this.readBacktick();
      return true;
    }
    const next = this.src[this.pos + 1];
    if (next === "(") {
      if (this.src[this.pos + 2] === "(") {
        this.readArithmetic();
        return true;
      }
      this.pos += 2;
      this.parseNested(")");
      return true;
    }
    if (next === "{") {
      this.pos += 2;
      this.readBraceExpansion();
      return true;
    }
    if (next === "[") throw new UnsupportedSyntax("$[...] arithmetic");
    if (next !== undefined && /[A-Za-z_]/.test(next)) {
      this.pos += 2;
      while (/[A-Za-z0-9_]/.test(this.peek() ?? "")) this.pos++;
      return true;
    }
    if (next !== undefined && /[0-9@*#?$!-]/.test(next)) {
      this.pos += 2;
      return true;
    }
    return false;
  }

  /** Parse a nested command list up to `close` (the opener already consumed). */
  private parseNested(close: ")"): void {
    const inner = new Parser(this.src, this.out, this.depth + 1);
    inner.pos = this.pos;
    inner.parseList(close);
    if (inner.heredocs.length) throw new UnsupportedSyntax("heredoc inside substitution");
    if (inner.peek() !== close) throw new UnsupportedSyntax("unterminated substitution");
    this.pos = inner.pos + 1;
  }

  private readBacktick(): void {
    this.pos++;
    let body = "";
    for (;;) {
      if (this.atEnd()) throw new UnsupportedSyntax("unbalanced backtick");
      const c = this.peek();
      if (c === "`") {
        this.pos++;
        break;
      }
      if (c === "\\") {
        const next = this.src[this.pos + 1];
        if (next === undefined) throw new UnsupportedSyntax("unbalanced backtick");
        body += next === "`" || next === "$" || next === "\\" ? next : c + next;
        this.pos += 2;
        continue;
      }
      body += c;
      this.pos++;
    }
    new Parser(body, this.out, this.depth + 1).parseProgram();
  }

  /** `$(( ... ))`: only literal integer arithmetic is accepted. */
  private readArithmetic(): void {
    let i = this.pos + 3;
    let depth = 0;
    for (; i < this.src.length; i++) {
      const c = this.src[i];
      if (c === "(") depth++;
      else if (c === ")") {
        if (depth === 0) break;
        depth--;
      }
    }
    if (this.src[i] !== ")" || this.src[i + 1] !== ")") {
      throw new UnsupportedSyntax("unterminated arithmetic");
    }
    const body = this.src.slice(this.pos + 3, i);
    // Variables in arithmetic are evaluated recursively (and array
    // subscripts can run command substitutions), so only literals pass.
    if (/[A-Za-z_$`[\]'"\\]/.test(body.replace(/\b0[xX][0-9a-fA-F]+\b|\b\d+#\w+\b/g, "0"))) {
      throw new UnsupportedSyntax("arithmetic over variables");
    }
    this.pos = i + 2;
  }

  /** `${...}` (opening `${` consumed). */
  private readBraceExpansion(): void {
    const rest = this.src.slice(this.pos);
    if (rest.startsWith("#}")) {
      this.pos += 2;
      return;
    }
    if (rest[0] === "!") throw new UnsupportedSyntax("indirect expansion");
    const m = /^(#?)([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])/.exec(rest);
    if (!m) throw new UnsupportedSyntax("bad parameter expansion");
    this.pos += m[0].length;
    if (this.peek() === "}") {
      this.pos++;
      return;
    }
    if (m[1]) throw new UnsupportedSyntax("bad parameter expansion");
    const after = this.src.slice(this.pos);
    if (after[0] === "[") throw new UnsupportedSyntax("array subscript");
    const op = /^(:-|:\+|:\?|##|%%|\/\/|\/#|\/%|\^\^|,,|[-+?#%/^,])/.exec(after);
    if (!op) {
      // `:=`/`=` assign, `:offset` is arithmetic, `@P` expands prompts.
      throw new UnsupportedSyntax("unsupported parameter expansion");
    }
    this.pos += op[0].length;
    this.readExpansionWord();
  }

  /** The word part of `${name<op>word}`, up to the matching `}`. */
  private readExpansionWord(): void {
    for (;;) {
      if (this.atEnd()) throw new UnsupportedSyntax("unterminated ${");
      const c = this.peek();
      if (c === "}") {
        this.pos++;
        return;
      }
      if (c === "\\") {
        this.pos += 2;
        continue;
      }
      if (c === "'") {
        const end = this.src.indexOf("'", this.pos + 1);
        if (end === -1) throw new UnsupportedSyntax("unbalanced single quote");
        this.pos = end + 1;
        continue;
      }
      if (c === '"') {
        this.pos++;
        this.readDoubleQuoted({ text: "", dynamic: false, opaque: false, procSubst: false }, false);
        continue;
      }
      if ((c === "$" || c === "`") && this.readExpansion()) continue;
      this.pos++;
    }
  }

  // -------------------------------------------------------------------------
  // Low-level helpers
  // -------------------------------------------------------------------------

  private peek(): string | undefined {
    return this.src[this.pos];
  }

  private atEnd(): boolean {
    return this.pos >= this.src.length;
  }

  /** `}` in command position, as a reserved word. */
  private atReservedClose(): boolean {
    return this.peek() === "}" && isMeta(this.src[this.pos + 1]);
  }

  private skipBlanks(): void {
    for (;;) {
      const c = this.peek();
      if (c === " " || c === "\t") this.pos++;
      else if (c === "\\" && this.src[this.pos + 1] === "\n") this.pos += 2;
      else if (c === "#" && this.atWordBoundary()) this.skipComment();
      else return;
    }
  }

  private atWordBoundary(): boolean {
    const prev = this.src[this.pos - 1];
    return prev === undefined || /[\s;&|()<>]/.test(prev);
  }

  private skipBlanksAndNewlines(): void {
    for (;;) {
      this.skipBlanks();
      if (this.peek() !== "\n") return;
      this.pos++;
      this.readHeredocBodies();
    }
  }

  private skipComment(): void {
    while (!this.atEnd() && this.peek() !== "\n") this.pos++;
  }
}

function literalWord(text: string): Word {
  return { text, dynamic: false, opaque: false, procSubst: false };
}
