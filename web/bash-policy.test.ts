/**
 * Tests for the lazily-hydrated-workspace Bash command policy.
 */

import { describe, expect, test } from "bun:test";
import { evaluateBashCommand } from "./lib/bash-policy";

function verdict(command: string): string {
  return evaluateBashCommand(command, { hydrating: true }).verdict;
}

function bakedVerdict(command: string): string {
  return evaluateBashCommand(command, { hydrating: false }).verdict;
}

describe("evaluateBashCommand (hydrating workspace)", () => {
  test("denies tree walkers", () => {
    expect(verdict("tree")).toBe("deny");
    expect(verdict("tree -L 2 src")).toBe("deny");
    expect(verdict("find . -name '*.ts'")).toBe("deny");
    expect(verdict("ls -R src")).toBe("deny");
    expect(verdict("ls --recursive")).toBe("deny");
    expect(verdict("du -sh .")).toBe("deny");
  });

  test("denies recursive and direct-file content search", () => {
    expect(verdict("grep -r TODO src")).toBe("deny");
    expect(verdict("grep -rn pattern .")).toBe("deny");
    expect(verdict("rg pattern")).toBe("deny");
    expect(verdict("ag pattern src/")).toBe("deny");
    expect(verdict("grep pattern src/main.ts")).toBe("deny");
  });

  test("denies git grep with a promisor-fetch explanation", () => {
    const result = evaluateBashCommand("git grep planRemoteRepo", { hydrating: true });
    expect(result.verdict).toBe("deny");
    expect(result.reason).toContain("blob");
  });

  test("denies subprocess file readers", () => {
    expect(verdict("cat src/main.ts")).toBe("deny");
    expect(verdict("head -n 20 README.md")).toBe("deny");
    expect(verdict("tail -50 server.log")).toBe("deny");
    expect(verdict("wc -l src/main.ts")).toBe("deny");
  });

  test("allows pipeline filters that read stdin", () => {
    expect(verdict("git log --oneline | head -20")).toBe("allow");
    expect(verdict("git ls-files | grep test")).toBe("allow");
    expect(verdict("git log | wc -l")).toBe("allow");
  });

  test("denies history-wide content sweeps but allows targeted commit inspection", () => {
    expect(verdict("git log -p")).toBe("deny");
    expect(verdict("git log --stat")).toBe("deny");
    expect(verdict("git log --all -S planRemoteRepo")).toBe("deny");
    expect(verdict("git log --oneline --all")).toBe("allow");
    expect(verdict("git log --name-only --no-renames")).toBe("allow");
    // One commit's worth of blobs is targeted hydration — allowed.
    expect(verdict("git show abc123 --stat")).toBe("allow");
    expect(verdict("git diff HEAD~1")).toBe("allow");
  });

  test("allows read-only git metadata commands", () => {
    expect(verdict("git status")).toBe("allow");
    expect(verdict("git log --oneline -10")).toBe("allow");
    expect(verdict("git show HEAD:package.json")).toBe("allow");
    expect(verdict("git ls-tree -r --name-only HEAD")).toBe("allow");
    // Global options before the subcommand, and a cd prefix, as Claude writes them
    expect(verdict("git -C /tmp/cc-planner-abc ls-tree -r --name-only HEAD")).toBe("allow");
    expect(verdict("git --no-pager ls-tree HEAD src/")).toBe("allow");
    expect(verdict("git --git-dir=/r/.git --work-tree /r ls-tree HEAD")).toBe("allow");
    expect(verdict("cd /tmp/cc-planner-abc && git ls-tree -r HEAD | grep vite")).toBe("allow");
    expect(verdict("git diff HEAD~1")).toBe("allow");
  });

  test("allows plain safe commands", () => {
    expect(verdict("pwd")).toBe("allow");
    expect(verdict("ls -la src")).toBe("allow");
    expect(verdict("echo hello")).toBe("allow");
  });

  test("strictest segment wins in compound commands", () => {
    expect(verdict("pwd && find . -name '*.ts'")).toBe("deny");
    expect(verdict("git log; cat README.md")).toBe("deny");
    expect(verdict("echo a && git push")).toBe("ask");
  });

  test("git config overrides can run programs, so they ask", () => {
    expect(verdict("git -c core.pager=evil log")).toBe("ask");
    expect(verdict("git -c core.fsmonitor=evil ls-tree HEAD")).toBe("ask");
    expect(verdict("git --config-env=core.pager=X ls-tree HEAD")).toBe("ask");
    expect(verdict("git --exec-path=/tmp/x ls-tree HEAD")).toBe("ask");
    expect(bakedVerdict("git -c core.pager=evil ls-tree HEAD")).toBe("ask");
  });

  test("unknown or mutating commands fall through to ask", () => {
    expect(verdict("bun test")).toBe("ask");
    expect(verdict("git push origin main")).toBe("ask");
    expect(verdict("rm -rf node_modules")).toBe("ask");
  });

  test("skips env-var prefixes when identifying the command", () => {
    expect(verdict("FOO=bar tree")).toBe("deny");
    expect(verdict("CI=1 git status")).toBe("allow");
  });
});

describe("evaluateBashCommand (full checkout)", () => {
  test("read-only shell commands are auto-allowed", () => {
    expect(bakedVerdict("find . -name '*.ts'")).toBe("allow");
    expect(bakedVerdict("tree -L 2 src")).toBe("allow");
    expect(bakedVerdict("cat src/main.ts")).toBe("allow");
    expect(bakedVerdict("grep -rn pattern src")).toBe("allow");
    expect(bakedVerdict("rg pattern")).toBe("allow");
    expect(bakedVerdict("head -n 20 README.md")).toBe("allow");
  });

  test("git metadata commands are auto-allowed (the reported case)", () => {
    expect(bakedVerdict("git ls-files")).toBe("allow");
    expect(bakedVerdict("git ls-tree -r --name-only HEAD")).toBe("allow");
    expect(bakedVerdict("git log -p")).toBe("allow");
    expect(bakedVerdict("git grep pattern")).toBe("allow");
    expect(bakedVerdict("git ls-files | grep test | wc -l")).toBe("allow");
  });

  test("mutating commands still ask", () => {
    expect(bakedVerdict("git push origin main")).toBe("ask");
    expect(bakedVerdict("rm -rf node_modules")).toBe("ask");
    expect(bakedVerdict("bun test")).toBe("ask");
    expect(bakedVerdict("git ls-files | xargs rm")).toBe("ask");
  });

  test("write redirects and mutating find flags are never auto-allowed", () => {
    expect(bakedVerdict("echo secret > .env")).toBe("ask");
    expect(bakedVerdict("git ls-files > files.txt")).toBe("ask");
    expect(bakedVerdict("cat a.txt >> b.txt")).toBe("ask");
    expect(bakedVerdict("find . -name '*.tmp' -delete")).toBe("ask");
    expect(bakedVerdict("find . -exec rm {} \\;")).toBe("ask");
    // Harmless stderr plumbing doesn't trip the redirect guard.
    expect(bakedVerdict("find . -name x 2>/dev/null")).toBe("allow");
    expect(bakedVerdict("git status 2>&1")).toBe("allow");
  });
});

describe("security holes in the old tokenizer now ask", () => {
  test.each([
    ["command substitution", "echo $(rm -rf ~)"],
    ["backticks", "echo `rm x`"],
    ["background separator", "ls & rm x"],
    ["process substitution", "cat <(rm x)"],
    ["output process substitution", "ls >(rm x)"],
    ["substitution inside double quotes", 'echo "$(rm x)"'],
    ["substitution in a here-string", 'grep x <<< "$(rm y)"'],
    ["substitution in an assignment", "FOO=$(rm x) ls"],
    ["newline separator", "ls\nrm x"],
    ["git branch -D", "git branch -D main"],
    ["git branch <name>", "git branch newname"],
    ["git branch -m", "git branch -m a b"],
    ["git branch --set-upstream-to", "git branch --set-upstream-to=origin/main"],
    ["git tag <name>", "git tag v1"],
    ["git tag -d", "git tag -d v1"],
    ["git config set", "git config user.name x"],
    ["git config --unset", "git config --unset user.name"],
    ["git config --edit", "git config --edit"],
    ["git config edit", "git config edit"],
    ["git remote add", "git remote add o url"],
    ["git remote remove", "git remote remove o"],
    ["git remote show (network)", "git remote show origin"],
    ["bare git stash", "git stash"],
    ["git stash drop", "git stash drop"],
    ["git diff --output", "git diff --output=f"],
    ["git log --output", "git log --output=f"],
    ["abbreviated --output", "git log --outp=f"],
    ["git diff --ext-diff", "git diff --ext-diff"],
    ["git grep -O", "git grep -Ovim foo"],
    ["git notes add behind --ref", "git notes --ref x add"],
    ["git reflog expire", "git reflog expire --all"],
    ["git worktree add", "git worktree add ../x"],
  ])("%s: %s", (_label, command) => {
    expect(bakedVerdict(command)).toBe("ask");
  });
});

describe("read-only usages are allowed on a full checkout", () => {
  test.each([
    'grep "a|b" file.txt',
    "grep -E 'foo|bar' src/main.ts",
    "git -C /x log --oneline -5 | head",
    "cd /r && git ls-tree -r HEAD | grep -E 'vite|tsconfig'",
    "bash -c 'git status'",
    'sh -c "ls | head"',
    "bash -o pipefail -c 'git log | head -3'",
    "git ls-files | xargs -0 wc -l",
    "find . -name '*.ts' | xargs grep -l foo",
    "git ls-files | xargs -I{} cat {}",
    "sed -n '1,20p'",
    "sed -n '1,20p' README.md",
    "sed -e 's/a/b/g' -e '/x/d' file",
    "sed -E 's/(a|b)+/X/g'",
    "sed -n '/start/,/end/{p;}'",
    "sed 's|a|b|g'",
    "awk '{print $1}'",
    "awk -F: '{print $1}' /etc/passwd",
    "awk '$3 > 100 { print $1 }' data.txt",
    "awk '{ print ($1 > 5) }'",
    "awk '/a|b/ { n++ } END { print n }'",
    "awk -v x=1 'NR==x'",
    "jq .name",
    "jq -r '.[] | .name' package.json",
    "jq -n --arg v 1 '$v'",
    "git log --oneline | awk '{print $1}' | sort | uniq -c | sort -rn",
    "sort -u names.txt",
    "uniq -c",
    "nl -ba file",
    "tac log",
    "rev",
    "column -t -s,",
    "fold -w 80",
    "comm -12 a b",
    "cmp a b",
    "diff <(git show a:f) <(git show b:f)",
    "printf '%s\\n' a b",
    "test -f x && echo yes",
    "[ -d src ] && ls src",
    "readlink -f x",
    "realpath .",
    "printenv HOME",
    "whoami",
    "uname -a",
    "id -u",
    "env",
    "env FOO=1 git status",
    "type git",
    "command -v git",
    "md5sum a",
    "sha256sum a b",
    "od -c file",
    "hexdump -C file",
    "xxd file",
    "xxd -l 64 file",
    "base64 file",
    "df -h",
    "fd -e ts",
    "rg -n foo src",
    "timeout 10 git status",
    "nice -n 5 ls",
    "time git log -1",
    "(cd src && ls)",
    "{ ls; pwd; }",
    "date +%s",
    "echo ${HOME} $((1 + 2)) $1",
    "x=$(git rev-parse HEAD) && echo $x",
    "echo $(git log -1 --format=%H)",
    "/usr/bin/git status",
    "GIT_PAGER=cat git log -3",
    "cat <<EOF\nhello $USER\nEOF",
    "cat <<'EOF'\n$(not run)\nEOF",
    "ls -la 2>/dev/null",
    "ls &>/dev/null",
    "echo err >&2",
    "cat < input.txt",
    "sleep 1 &",
  ])("%s", (command) => {
    expect(evaluateBashCommand(command, { hydrating: false })).toEqual({ verdict: "allow" });
  });

  test.each([
    "git log",
    "git show HEAD --stat",
    "git diff HEAD~1 -- src",
    "git status --porcelain",
    "git ls-files -z",
    "git ls-tree -r HEAD",
    "git rev-parse --show-toplevel",
    "git cat-file -p HEAD",
    "git rev-list --count HEAD",
    "git blame -L 1,10 f",
    "git shortlog -sn",
    "git describe --tags",
    "git grep foo",
    "git reflog",
    "git reflog show main",
    "git merge-base HEAD main",
    "git name-rev HEAD",
    "git for-each-ref --format='%(refname)' refs/heads",
    "git show-ref",
    "git count-objects -v",
    "git check-ignore -v x",
    "git var GIT_AUTHOR_IDENT",
    "git whatchanged -1",
    "git branch",
    "git branch -a",
    "git branch -vv",
    "git branch --show-current",
    "git branch --list 'feat/*'",
    "git branch -r --merged main",
    "git branch --contains abc123",
    "git tag",
    "git tag -l 'v*'",
    "git tag -n5",
    "git tag --contains abc",
    "git tag --points-at HEAD",
    "git remote",
    "git remote -v",
    "git remote show",
    "git remote show -n origin",
    "git remote get-url origin",
    "git config --get remote.origin.url",
    "git config --get-all core.x",
    "git config --get-regexp '^remote'",
    "git config -l",
    "git config --list --show-origin",
    "git config core.editor",
    "git config get user.name",
    "git stash list",
    "git stash show -p stash@{0}",
    "git worktree list",
    "git notes",
    "git notes list",
    "git notes show HEAD",
    "git --no-pager log -1",
    "git --version",
  ])("%s", (command) => {
    expect(bakedVerdict(command)).toBe("allow");
  });
});

describe("unsafe forms of otherwise-allowed commands ask", () => {
  test.each([
    "sed -i 's/a/b/' f",
    "sed -ni 's/a/b/p' f",
    "sed --in-place=.bak 's/a/b/' f",
    "sed 's/a/b/w out'",
    "sed 's/a/b/e'",
    "sed '1w out'",
    "sed -f script.sed",
    'sed "s/$X/y/"',
    "awk '{print $1 > \"x\"}'",
    "awk '{ print | \"sh\" }'",
    "awk 'BEGIN { system(\"rm x\") }'",
    "awk '{ \"date\" | getline d }'",
    "awk -f prog.awk",
    "awk '@load \"x\"'",
    "sort -o out in",
    "sort -uo out",
    "sort --compress-prog=sh",
    "uniq in out",
    "xxd -r dump bin",
    "xxd in out",
    "base64 -o out in",
    "tree -o out",
    "fd -x rm",
    "fd --exec-batch rm",
    "rg --pre cat foo",
    "rg --pre-glob '*' foo",
    "find . -delete",
    "find . -fprint out",
    "less +!rm f",
    "date -s 2020-01-01",
    "date 010101",
    "printf -v PATH /tmp",
    'printf "$fmt"',
    "hostname evil",
    "file -C -m magic",
    "git ls-files | xargs rm",
    "git ls-files | xargs sort",
    "ls | xargs -I{} sh -c 'cat {}'",
    "bash script.sh",
    'bash -c "$CMD"',
    "sh",
    "env -S 'rm x'",
    "timeout 5 rm x",
    "nice rm x",
    "env rm x",
    "command rm x",
    "PATH=/tmp ls",
    "LD_PRELOAD=/x.so ls",
    "GIT_EXTERNAL_DIFF=x git diff",
    "GIT_PAGER=evil git log",
    "HOME=/tmp/evil git status",
    "IFS=x",
    "./git status",
    "/tmp/evil/cat x",
    "$CMD args",
    "sort $X",
    "sort *",
    "git log $(git merge-base a b)..HEAD",
    "echo hi > out.txt",
    "echo hi>out.txt",
    "ls 3>x",
    "ls >&out",
    "cat <> f",
    "{ ls; } > out",
    "(ls) > out",
    "> truncate-me",
    "ls | tee out",
  ])("%s", (command) => {
    expect(bakedVerdict(command)).toBe("ask");
  });
});

describe("hydrating workspace: file operands of readers are denied", () => {
  test.each([
    "sed -n '1,20p' README.md",
    "sed '1r other' ",
    "awk '{print $1}' data.txt",
    "sort names.txt",
    "uniq names.txt",
    "nl file",
    "tac file",
    "jq .name package.json",
    "xxd file",
    "od -c file",
    "md5sum file",
    "diff a b",
    "stat file",
    "cut -d, -f1 data.csv",
    "cat < input.txt",
    "wc -l < f",
    "git ls-files | xargs cat",
    "git ls-files | xargs -0 wc -l",
    "git ls-files | xargs grep foo",
    "fd foo",
    "echo $(cat README.md)",
    "bash -c 'cat README.md'",
  ])("%s", (command) => {
    const result = evaluateBashCommand(command, { hydrating: true });
    expect(result.verdict).toBe("deny");
    expect(result.reason).toBeTruthy();
  });

  test("reader guidance points at the Read tool", () => {
    expect(evaluateBashCommand("sed -n 1p f", { hydrating: true }).reason).toContain("Read tool");
    expect(evaluateBashCommand("fd x", { hydrating: true }).reason).toContain("Glob");
  });

  test.each([
    "git log --oneline | sed -n '1,5p'",
    "git ls-files | awk -F/ '{print $1}' | sort | uniq -c",
    "git show HEAD:package.json | jq .scripts",
    "git log --format=%an | sort | uniq",
    "git ls-files | xxd | head",
    "cat <<EOF\nhi\nEOF",
    "diff <(git show a:f) <(git show b:f)",
    "ls -lrt",
    "git log --oneline | xargs -n1 echo",
  ])("stdin filters stay allowed: %s", (command) => {
    expect(verdict(command)).toBe("allow");
  });

  test("the hydration deny beats an ask in the same line", () => {
    expect(verdict("rm x; cat README.md")).toBe("deny");
  });
});

describe("parser edge cases", () => {
  test.each([
    ['echo "unbalanced', "ask"],
    ["echo 'unbalanced", "ask"],
    ["echo `unbalanced", "ask"],
    ["echo $(ls", "ask"],
    ["ls &&", "ask"],
    ["| ls", "ask"],
    ["ls ; ; ls", "ask"],
    ["ls )", "ask"],
    ["echo a \\| rm x", "allow"],
    ["echo 'a | rm x'", "allow"],
    ['echo "a; rm x"', "allow"],
    ["ls # ; rm x", "allow"],
    ["echo ok # $(rm x)", "allow"],
    ['echo "a # b" | grep "#"', "allow"],
    ["echo $( echo $(git status) )", "allow"],
    ["echo $( echo $(rm x) )", "ask"],
    ["echo $(echo `rm x`)", "ask"],
    ["ls \\\n  -la", "allow"],
    ["echo $'a\\tb'", "allow"],
    ["echo ${HOME:-/root}", "allow"],
    ["echo ${X:-$(rm x)}", "ask"],
    ["echo ${X:=y}", "ask"],
    ["echo ${X=y}", "ask"],
    ["echo ${!X}", "ask"],
    ["echo ${X:1:2}", "ask"],
    ["echo $((x))", "ask"],
    ["echo $(( $(rm x) ))", "ask"],
    ["if true; then ls; fi", "ask"],
    ["for f in *; do cat $f; done", "ask"],
    ["while true; do ls; done", "ask"],
    ["case x in x) ls;; esac", "ask"],
    ["f() { ls; }; f", "ask"],
    ["[[ -f x ]]", "ask"],
    ["(( x = 1 ))", "ask"],
    ["eval ls", "ask"],
    ["exec ls", "ask"],
    ["source ./x", "ask"],
    [". ./x", "ask"],
    ["cat <<EOF\n$(rm x)\nEOF", "ask"],
    ["cat <<EOF\nno terminator", "ask"],
    ["cat <<EOF > out\nhi\nEOF", "ask"],
    ["ls |& grep x", "allow"],
    ["! grep -q x f", "allow"],
    ["", "allow"],
  ])("%s → %s", (command, expected) => {
    expect(bakedVerdict(command)).toBe(expected);
  });
});
