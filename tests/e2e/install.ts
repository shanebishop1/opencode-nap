import { writeFile } from "fs/promises"
import { join, resolve } from "path"
import { $ } from "bun"

export const cliVersion = process.env.NAP_E2E_CLI_VERSION ?? "2.2.4"

/** Install the packed consumer, not a link to the source checkout. */
export async function install(root: string): Promise<void> {
  const repository = resolve(import.meta.dir, "..", "..")
  const archive = (await $`npm run build && npm pack --ignore-scripts --pack-destination ${root}`
    .cwd(repository).quiet().text()).trim().split("\n").pop()
  if (!archive) throw new Error("npm pack did not return an archive name")
  await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))
  // npm may use the caller's registry/cache; OpenCode itself runs isolated.
  await $`npm install --no-audit --no-fund ${join(root, archive)} ${`@opencode/cli@${cliVersion}`}`
    .cwd(root).quiet()
}
