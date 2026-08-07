import type { CompiledGameModule } from '@chaincraft/runtime';

/**
 * ModuleLoader — abstraction for loading a CompiledGameModule by game ID.
 *
 * Implementations:
 *   - SpecModuleLoader (dev/playtest): reads YAML spec from local dir, assembles in-process.
 *   - BundleModuleLoader (production): fetches signed bundle from CDN, verifies, imports.
 */
export interface ModuleLoader {
  load(gameId: string, version?: string): Promise<CompiledGameModule>;
  listGames(): string[] | Promise<string[]>;
}
