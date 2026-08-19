// ---------------------------------------------------------------------------
// SpecModuleLoader — dev/playtest module loader.
//
// Reads a YAML spec from a local `games/` directory (filename = game ID),
// validates it, and assembles a CompiledGameModule in-process via the compiler.
//
// This is a devDependency-only path — production uses BundleModuleLoader.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync } from "fs";
import { join, basename, extname } from "path";
import { load } from "js-yaml";
import { validate } from "@chaincraft/gamedef/validator";
import type { ModularGameSpec } from "@chaincraft/gamedef";
import { assembleModule } from "@chaincraft/compiler";
import type { ModuleLoader } from "./module-loader.js";

export class SpecModuleLoader implements ModuleLoader {
  constructor(private readonly gamesDir: string) {}

  async load(gameId: string) {
    const filePath = join(this.gamesDir, `${gameId}.yaml`);
    const raw = load(readFileSync(filePath, "utf-8"));
    const result = validate(raw);
    if (!result.valid) {
      throw new Error(
        `Spec "${gameId}" failed validation: ${JSON.stringify(result.errors)}`,
      );
    }
    return assembleModule(result.spec as ModularGameSpec, gameId);
  }

  listGames(): string[] {
    return readdirSync(this.gamesDir)
      .filter((f) => extname(f) === ".yaml")
      .map((f) => basename(f, ".yaml"));
  }
}
