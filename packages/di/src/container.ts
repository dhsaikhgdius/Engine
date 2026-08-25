// @director/di — lightweight dependency injection container.
// Inspired by Cordis (DSH) but simplified: no decorators, no reflection,
// just a plain async container with singleton/transient/scoped lifecycles.

/** Unique token for a service. Strings or Symbols. */
export type ServiceToken = string | symbol;

/** Lifecycle policy for a service. */
export type Lifecycle = "singleton" | "transient" | "scoped";

/** A service factory — creates or resolves a service instance. */
export type ServiceFactory<T> = (ctx: Container) => T | Promise<T>;

/** A registered service descriptor. */
export interface ServiceDescriptor<T = unknown> {
  token: ServiceToken;
  factory: ServiceFactory<T>;
  lifecycle: Lifecycle;
  /** Optional dependencies (token names) for ordering. */
  dependencies?: ServiceToken[];
  /** Optional tags for filtering. */
  tags?: string[];
}

/** A plugin is a function that registers services on a container. */
export type Plugin = (ctx: Container) => void | Promise<void>;

/** A plugin module — exports a default plugin function. */
export interface PluginModule {
  default: Plugin;
  /** Optional metadata for discovery. */
  meta?: {
    name: string;
    version?: string;
    description?: string;
  };
}

// ---- Container ----

export class Container {
  private readonly services = new Map<ServiceToken, ServiceDescriptor>();
  private readonly instances = new Map<ServiceToken, unknown>();
  private readonly initializing = new Set<ServiceToken>();
  private readonly hooks = new Map<ServiceToken, Array<(instance: unknown) => void>>();
  private disposed = false;

  // -- Registration --

  /**
   * Register a service.
   *
   * @example
   * container.register({ token: "logger", factory: () => createLogger(), lifecycle: "singleton" });
   */
  register<T>(descriptor: ServiceDescriptor<T>): this {
    if (this.services.has(descriptor.token)) {
      throw new Error(`Service "${String(descriptor.token)}" is already registered`);
    }
    this.services.set(descriptor.token, descriptor as ServiceDescriptor);
    return this;
  }

  /**
   * Convenience: register a singleton service.
   * @example
   * container.singleton("config", (ctx) => loadConfig());
   */
  singleton<T>(token: ServiceToken, factory: ServiceFactory<T>, dependencies?: ServiceToken[]): this {
    return this.register({ token, factory, lifecycle: "singleton", dependencies });
  }

  /**
   * Convenience: register a transient service (new instance every resolve).
   */
  transient<T>(token: ServiceToken, factory: ServiceFactory<T>, dependencies?: ServiceToken[]): this {
    return this.register({ token, factory, lifecycle: "transient", dependencies });
  }

  /**
   * Convenience: register a constant value.
   */
  constant<T>(token: ServiceToken, value: T): this {
    return this.singleton(token, () => value);
  }

  // -- Resolution --

  /**
   * Resolve a service by token. Throws if not registered.
   */
  async resolve<T>(token: ServiceToken): Promise<T> {
    if (this.disposed) throw new Error(`Container disposed; cannot resolve "${String(token)}"`);

    const descriptor = this.services.get(token) as ServiceDescriptor<T> | undefined;
    if (!descriptor) {
      throw new Error(
        `Service "${String(token)}" is not registered. Available: ${[...this.services.keys()].map(String).join(", ")}`,
      );
    }

    if (descriptor.lifecycle === "singleton") {
      const cached = this.instances.get(token);
      if (cached !== undefined) return cached as T;
    }

    if (this.initializing.has(token)) {
      throw new Error(`Circular dependency detected: "${String(token)}"`);
    }

    this.initializing.add(token);
    try {
      const instance = await descriptor.factory(this);
      if (descriptor.lifecycle === "singleton") {
        this.instances.set(token, instance);
      }
      // Notify hooks
      const hooks = this.hooks.get(token);
      if (hooks) {
        for (const hook of hooks) hook(instance);
      }
      return instance;
    } finally {
      this.initializing.delete(token);
    }
  }

  /**
   * Synchronous resolve — only works for already-instantiated singletons.
   * Throws if the service hasn't been resolved yet.
   */
  get<T>(token: ServiceToken): T {
    const instance = this.instances.get(token);
    if (instance === undefined) {
      throw new Error(`Service "${String(token)}" has not been resolved yet. Use await resolve() instead.`);
    }
    return instance as T;
  }

  /**
   * Try to resolve a service. Returns undefined if not registered.
   */
  async tryResolve<T>(token: ServiceToken): Promise<T | undefined> {
    if (!this.services.has(token)) return undefined;
    return this.resolve<T>(token);
  }

  // -- Lifecycle hooks --

  /**
   * Register a hook that fires when a service is first resolved.
   */
  onResolved<T>(token: ServiceToken, hook: (instance: T) => void): this {
    const hooks = this.hooks.get(token) ?? [];
    hooks.push(hook as (instance: unknown) => void);
    this.hooks.set(token, hooks);
    return this;
  }

  // -- Batching --

  /**
   * Resolve multiple services in dependency order.
   */
  async resolveAll<T extends ServiceToken[]>(...tokens: T): Promise<{ [K in keyof T]: T[K] extends ServiceToken ? unknown : never }> {
    const results = await Promise.all(tokens.map((t) => this.resolve(t)));
    return results as any;
  }

  // -- Querying --

  /** List all registered service tokens. */
  list(): ServiceToken[] {
    return [...this.services.keys()];
  }

  /** Check if a service is registered. */
  has(token: ServiceToken): boolean {
    return this.services.has(token);
  }

  /** Find services by tag. */
  findByTag(tag: string): ServiceToken[] {
    return [...this.services.values()]
      .filter((d) => d.tags?.includes(tag))
      .map((d) => d.token);
  }

  // -- Disposal --

  /** Dispose the container and all disposable services. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const errors: Error[] = [];

    for (const [token, instance] of this.instances) {
      if (instance && typeof (instance as any).dispose === "function") {
        try {
          await (instance as any).dispose();
        } catch (err) {
          errors.push(err instanceof Error ? err : new Error(String(err)));
        }
      }
    }

    this.instances.clear();
    this.services.clear();
    this.hooks.clear();

    if (errors.length) {
      throw new AggregateError(errors, "Errors during container disposal");
    }
  }
}

// ---- Plugin loader ----

/**
 * Load a plugin module and register its services on the container.
 */
export async function loadPlugin(ctx: Container, plugin: Plugin | PluginModule): Promise<void> {
  if (typeof plugin === "function") {
    await plugin(ctx);
  } else if (plugin.default && typeof plugin.default === "function") {
    await plugin.default(ctx);
  } else {
    throw new Error("Invalid plugin: must export a default function");
  }
}

/**
 * Load multiple plugins in order.
 */
export async function loadPlugins(ctx: Container, plugins: Array<Plugin | PluginModule>): Promise<void> {
  for (const plugin of plugins) {
    await loadPlugin(ctx, plugin);
  }
}