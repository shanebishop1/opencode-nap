// Text only the permission dialog shows; the transcript also shows the tool call itself.
export const PERMISSION_DIALOG = /Permission required .*nap-e2e-permission\.txt.* Allow once Always allow Reject/

// Tool rules live on each agent: shell asks, so a permission prompt appears;
// the question tool is allowed.
const agentPermissions = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "shell", resource: "*", effect: "ask" },
  { action: "question", resource: "*", effect: "allow" },
]

/** Server config that allows only the local fake provider started by `startProvider`. */
export const fakeProviderConfig = (providerUrl: string) => ({
  model: "local/deterministic",
  policies: [
    { action: "provider.use", resource: "*", effect: "deny" },
    { action: "provider.use", resource: "local", effect: "allow" },
  ],
  providers: {
    local: {
      name: "Local fake provider",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `${providerUrl}/v1` },
      models: {
        deterministic: {
          modelID: "deterministic",
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          limit: { context: 32_768, output: 4_096 },
        },
      },
    },
  },
  agents: { build: { permissions: agentPermissions }, plan: { permissions: agentPermissions } },
})
