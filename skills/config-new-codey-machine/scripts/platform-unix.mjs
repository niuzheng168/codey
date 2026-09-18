import { appendFile, chmod, lstat, readFile, realpath, rename } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { checkedPath, exists, requireValue, writePrivate } from "./machine-common.mjs";
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
export const unixProfiles = target => [".profile", ".bashrc", ".bash_profile", ".bash_login",
  ...(target.startsWith("macos-") ? [".zprofile", ".zshrc"] : [])];
export async function installUnixCommand(i, config) {
    const bin = await i.directory(path.join(i.home, ".local/bin")), file = path.join(bin, "codey");
    const marker = "# CODEY_MANAGED_LAUNCHER";
    let npmLink = false;
    if (await exists(file)) {
      const info = await lstat(file);
      requireValue(info.uid === process.getuid());
      if (info.isSymbolicLink()) {
        requireValue(await realpath(file) === config.codeyBin, "Refusing to replace an unrelated codey link");
        await checkedPath(config.codeyBin, i.home);
        npmLink = true;
      } else {
        requireValue(info.isFile());
        const text = await readFile(file, "utf8");
        requireValue(text.includes(marker) || text.includes("CODEY_MACOS_MANAGED_LAUNCHER") ||
          text.includes("CODEY_SHARED_NPM_LAUNCHER"), "Refusing to replace an unmanaged codey command");
      }
    }
    const argv = [config.nodeExe, config.workerPath ?? config.helperPath, "cli", i.file].map(shellQuote).join(" ");
    const body = `#!/bin/sh\n${marker}\nexec ${argv} "$@"\n`;
    if (npmLink) {
      const temporary = path.join(bin, ".codey-" + randomBytes(12).toString("hex"));
      await writePrivate(temporary, Buffer.from(body));
      await rename(temporary, file);
    } else if (!await exists(file) || await readFile(file, "utf8") !== body) await writePrivate(file, Buffer.from(body));
    await chmod(file, 0o700);
    const block = '\n# >>> Codey PATH >>>\ncase ":${PATH:-}:" in\n  *":$HOME/.local/bin:"*) ;;\n  *) export PATH="$HOME/.local/bin${PATH:+:$PATH}" ;;\nesac\n# <<< Codey PATH <<<\n';
    for (const name of unixProfiles(i.target)) {
      const profile = path.join(i.home, name), present = await exists(profile);
      if ([".bash_profile", ".bash_login"].includes(name) && !present) continue;
      // Preserve deliberate owner dotfile links, but never write through one outside HOME.
      if (present) {
        const resolved = await realpath(profile);
        await checkedPath(resolved, i.home);
        if ((await readFile(resolved, "utf8")).includes("# >>> Codey PATH >>>")) continue;
      }
      await appendFile(profile, block, { mode: 0o600 });
    }
}
