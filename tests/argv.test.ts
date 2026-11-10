import { describe, expect, it } from "bun:test"
import { buildWakeArgs, type Route } from "../src/argv.js"

const home: Route = { type: "other" }
const session = (sessionID: string): Route => ({ type: "session", sessionID })

function argsOf(args: string[], route: Route = home): string[] {
  const result = buildWakeArgs(args, route)
  if (!result.ok) throw new Error(`refused: ${result.reason}`)
  return result.args
}

function reasonOf(args: string[], route: Route = home): string {
  const result = buildWakeArgs(args, route)
  if (result.ok) throw new Error(`accepted: ${JSON.stringify(result.args)}`)
  return result.reason
}

describe("buildWakeArgs", () => {
  it("ac-no-resubmit: drops -s and --session in both forms and resumes the current session", () => {
    expect(argsOf(["-s", "ses_old"], session("ses_new"))).toEqual(["-s", "ses_new"])
    expect(argsOf(["--session", "ses_old"], session("ses_new"))).toEqual(["-s", "ses_new"])
    expect(argsOf(["--session=ses_old"], session("ses_new"))).toEqual(["-s", "ses_new"])
  })

  it("ac-no-resubmit: drops -c and --continue", () => {
    expect(argsOf(["-c"], home)).toEqual([])
    expect(argsOf(["--continue"], home)).toEqual([])
    expect(argsOf(["-c", "--continue", "--auto"], session("ses_new"))).toEqual(["--auto", "-s", "ses_new"])
  })

  it("ac-no-resubmit: drops --prompt in both forms, including a value that looks like a flag", () => {
    expect(argsOf(["--prompt", "a b"], home)).toEqual([])
    expect(argsOf(["--prompt=a b"], home)).toEqual([])
    expect(argsOf(["--prompt", "-s", "--auto"], home)).toEqual(["--auto"])
    expect(argsOf(["--prompt", "-s"], session("ses_new"))).toEqual(["-s", "ses_new"])
    expect(argsOf(["--prompt", "--continue"], home)).toEqual([])
  })

  it("ac-no-resubmit: never emits --prompt or --continue and emits exactly one -s", () => {
    const input = ["-c", "--continue", "--prompt", "a b", "--prompt=x", "--session=ses_old", "-s", "ses_older", "--auto"]
    expect(argsOf(input, session("ses_new"))).toEqual(["--auto", "-s", "ses_new"])
  })

  it("ac-args-kept: keeps --server in both forms", () => {
    expect(argsOf(["--server", "http://127.0.0.1:1234"], home)).toEqual(["--server", "http://127.0.0.1:1234"])
    expect(argsOf(["--server=http://127.0.0.1:1234"], home)).toEqual(["--server=http://127.0.0.1:1234"])
  })

  it("ac-args-kept: keeps --auto, --log-level, --print-logs and the directory in order", () => {
    expect(argsOf(["--auto", "--log-level", "debug", "--print-logs", "/work/app"], home)).toEqual([
      "--auto",
      "--log-level",
      "debug",
      "--print-logs",
      "/work/app",
    ])
  })

  it("ac-args-kept: keeps values with spaces, quotes, $ and newlines byte-for-byte", () => {
    const dir = "/work/my app/$HOME \"q\" 'x'\nline two"
    const server = "http://127.0.0.1:1234/a b$c"
    expect(argsOf(["--server", server, dir], home)).toEqual(["--server", server, dir])
    expect(argsOf([dir], session("ses_new"))).toEqual([dir, "-s", "ses_new"])
  })

  it("ac-args-kept: home route adds no -s", () => {
    const out = argsOf(["--auto"], home)
    expect(out).toEqual(["--auto"])
    expect(out).not.toContain("-s")
  })

  it("ac-args-kept: session route adds exactly one -s with the current id even when started with a different -s", () => {
    expect(argsOf(["-s", "ses_old", "--auto", "--session=ses_older"], session("ses_new"))).toEqual([
      "--auto",
      "-s",
      "ses_new",
    ])
  })

  it("ac-unknown-args: refuses unknown flags and names them", () => {
    expect(reasonOf(["--bogus"])).toContain("--bogus")
    expect(reasonOf(["-x"])).toContain("-x")
    expect(reasonOf(["--auto=yes"])).toContain("--auto=yes")
    expect(reasonOf(["--continue=1"])).toContain("--continue=1")
  })

  it("ac-unknown-args: refuses -s=value and -svalue rather than guessing how they parse", () => {
    expect(reasonOf(["-s=ses_old"], session("ses_new"))).toContain("-s=ses_old")
    expect(reasonOf(["-sses_old"], session("ses_new"))).toContain("-sses_old")
    expect(reasonOf(["-c=1"])).toContain("-c=1")
  })

  it("ac-unknown-args: refuses --standalone and flags that start an action", () => {
    expect(reasonOf(["--standalone"])).toContain("--standalone")
    expect(reasonOf(["--help"])).toContain("--help")
    expect(reasonOf(["-h"])).toContain("-h")
    expect(reasonOf(["--version"])).toContain("--version")
    expect(reasonOf(["-v"])).toContain("-v")
    expect(reasonOf(["--wizard"])).toContain("--wizard")
    expect(reasonOf(["--completions", "bash"])).toContain("--completions")
  })

  it("ac-unknown-args: refuses a positional that names a subcommand", () => {
    expect(reasonOf(["run"])).toContain("run")
    expect(reasonOf(["session"])).toContain("session")
    expect(reasonOf(["/work", "pair"])).toContain("pair")
  })

  it("ac-unknown-args: refuses more than one positional", () => {
    expect(reasonOf(["/a", "/b"])).toContain("/b")
  })

  it("ac-unknown-args: refuses --", () => {
    expect(reasonOf(["--"])).toContain("--")
    expect(reasonOf(["--", "/work"])).toContain("--")
  })

  it("ac-unknown-args: refuses a value flag with no value", () => {
    expect(reasonOf(["--server"])).toContain("--server")
    expect(reasonOf(["--log-level"])).toContain("--log-level")
    expect(reasonOf(["-s"], home)).toContain("-s")
    expect(reasonOf(["--session"], home)).toContain("--session")
    expect(reasonOf(["--prompt"], home)).toContain("--prompt")
  })

  it("ac-unknown-args: refuses empty or flag-like values for kept flags", () => {
    expect(reasonOf(["--server="])).toContain("--server")
    expect(reasonOf(["--server", "--prompt"])).toContain("--server")
    expect(reasonOf(["--log-level", "-x"])).toContain("--log-level")
  })

  it("ac-unknown-args: refuses an empty positional", () => {
    expect(reasonOf([""])).toContain("empty")
  })

  it("ac-unknown-args: refuses an empty or flag-like session id", () => {
    expect(reasonOf([], session(""))).toContain("session id")
    expect(reasonOf([], session("-x"))).toContain("-x")
  })
})
