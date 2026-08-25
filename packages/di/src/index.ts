/**
 * @director/di — barrel export.
 *
 * Re-exports the DI container, plugin loader, and all service descriptor
 * types from the dependency injection package.
 *
 * @module @director/di
 */

export { Container, loadPlugin, loadPlugins } from "./container";
export type {
  ServiceToken,
  Lifecycle,
  ServiceFactory,
  ServiceDescriptor,
  Plugin,
  PluginModule,
} from "./container";