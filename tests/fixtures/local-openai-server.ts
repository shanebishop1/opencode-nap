// A loopback-only fake OpenAI-compatible provider for the end-to-end tests.
//
// Usage: bun local-openai-server.ts <log file> <slow chunks> <slow delay ms>
// Listens on a free loopback port and prints "READY <url>". Every request and stream event is
// appended to the log file as one JSON line.
//
// The reply to a request that offers tools depends on the text of the last
// user message (a request without tools, such as the session title, gets OK):
//   NAP_SLOW      streams the slow chunks, one per delay, then NAP_SLOW_DONE
//   NAP_PERM      calls the shell tool once, then replies NAP_PERM_DONE
//   NAP_QUESTION  calls the question tool once, then replies NAP_QUESTION_DONE
//   anything else replies OK
import { appendFileSync } from "fs"

type Json = Record<string, unknown>

const [logFile, slowChunks, slowDelayMs] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4])]
let calls = 0

const log = (entry: Json) => appendFileSync(logFile, `${JSON.stringify({ time: Date.now(), ...entry })}\n`)

const asObject = (value: unknown): Json => (typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : {})

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map(part => String(asObject(part).text ?? "")).join(" ")
  return ""
}

const toolDetails = (tool: unknown): { name: string; schema: Json } => {
  const wrapper = asObject(tool)
  const definition = Object.keys(asObject(wrapper.function)).length > 0 ? asObject(wrapper.function) : wrapper
  return { name: String(definition.name ?? ""), schema: asObject(definition.parameters ?? definition.input_schema) }
}

// Fills a JSON schema with harmless values: a question with two options.
function fill(schema: Json, name = ""): unknown {
  if (Array.isArray(schema.enum)) return schema.enum[0]
  const type = schema.type
  if (type === "object" || "properties" in schema) {
    const properties = asObject(schema.properties)
    const required = Array.isArray(schema.required) ? schema.required as string[] : Object.keys(properties)
    return Object.fromEntries(required.filter(key => key in properties).map(key => [key, fill(asObject(properties[key]), key)]))
  }
  if (type === "array") {
    const item = asObject(schema.items)
    return name === "options" ? [option(item, "Alpha"), option(item, "Beta")] : [fill(item)]
  }
  if (type === "boolean") return false
  if (type === "number" || type === "integer") return 1
  const named: Record<string, string> = {
    question: "NAP_E2E question: pick one",
    header: "Nap e2e",
    label: "Alpha",
    description: "a harmless choice",
  }
  return named[name] ?? `nap e2e ${name}`
}

function option(item: Json, label: string): unknown {
  if (item.type === "string") return label
  const properties = asObject(item.properties)
  return Object.fromEntries(Object.entries(properties).map(([key, value]) =>
    [key, key === "label" ? label : asObject(value).type === "string" ? `harmless ${label}` : fill(asObject(value), key)]))
}

function shellArguments(schema: Json): Json {
  const properties = asObject(schema.properties)
  const args: Json = {}
  if ("command" in properties) args.command = "printf ok > nap-e2e-permission.txt"
  if ("description" in properties) args.description = "NAP_E2E permission probe"
  if ("timeout" in properties) args.timeout = 10_000
  return args
}

const encoder = new TextEncoder()
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms))

function reply(call: number, mode: string, tool: { name: string; args: Json } | undefined, signal: AbortSignal): Response {
  const base = { id: `nap-e2e-${call}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "deterministic" }
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (value: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`))
      const chunk = (delta: Json, finish: string | null = null) => send({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })
      try {
        chunk({ role: "assistant", content: "" })
        let finish = "stop"
        if (mode === "slow") {
          for (let i = 1; i <= slowChunks; i++) {
            if (signal.aborted) throw new Error("client gone")
            chunk({ content: `slow-chunk-${String(i).padStart(3, "0")} ` })
            await sleep(slowDelayMs)
          }
          chunk({ content: "NAP_SLOW_DONE" })
        } else if (tool) {
          chunk({ tool_calls: [{ index: 0, id: `call_${call}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] })
          finish = "tool_calls"
        } else {
          chunk({ content: { "perm-done": "NAP_PERM_DONE", "question-done": "NAP_QUESTION_DONE" }[mode] ?? "OK" })
        }
        chunk({}, finish)
        send({ ...base, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        controller.close()
        log({ call, finished: mode })
      } catch (error) {
        log({ call, clientGone: String(error) })
        try {
          controller.close()
        } catch {
          // Already closed by the client.
        }
      }
    },
  })
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  // A slow stream is quiet between chunks; never time it out.
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/v1/models") {
      return Response.json({ object: "list", data: [{ id: "deterministic", object: "model", owned_by: "nap-e2e" }] })
    }
    if (url.pathname !== "/v1/chat/completions" || request.method !== "POST") return new Response("not found", { status: 404 })

    const body = asObject(await request.json())
    const messages = (Array.isArray(body.messages) ? body.messages : []).map(asObject)
    const lastUser = messages.map(message => message.role).lastIndexOf("user")
    const lastUserText = lastUser === -1 ? "" : textOf(messages[lastUser].content)
    const answered = lastUser !== -1 && messages.slice(lastUser).some(message => message.role === "tool")
    const tools = (Array.isArray(body.tools) ? body.tools : []).map(toolDetails)
    const call = ++calls

    let mode = "text"
    let tool: { name: string; args: Json } | undefined
    // A request without tools (the session title) quotes the prompt but must not act on it.
    if (tools.length > 0) {
      if (lastUserText.includes("NAP_SLOW")) mode = "slow"
      else if (lastUserText.includes("NAP_PERM")) mode = answered ? "perm-done" : "perm"
      else if (lastUserText.includes("NAP_QUESTION")) mode = answered ? "question-done" : "question"
    }
    if (mode === "perm") {
      const shell = tools.find(candidate => candidate.name === "shell" || candidate.name === "bash")
      if (shell) tool = { name: shell.name, args: shellArguments(shell.schema) }
    }
    if (mode === "question") {
      const question = tools.find(candidate => candidate.name === "question")
      if (question) tool = { name: question.name, args: asObject(fill(question.schema)) }
    }
    log({ call, mode, tool: tool?.name, tools: tools.map(candidate => candidate.name), lastUser: lastUserText.slice(0, 200) })
    return reply(call, mode, tool, request.signal)
  },
})

console.log(`READY http://127.0.0.1:${server.port}`)
