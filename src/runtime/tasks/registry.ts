import type { RuntimeTaskHandler } from './types.ts'

export class RuntimeTaskRegistry {
  private readonly handlers = new Map<string, RuntimeTaskHandler<unknown, unknown>>()

  register<Input, Output>(handler: RuntimeTaskHandler<Input, Output>): void {
    if (this.handlers.has(handler.type)) {
      throw new Error(`Task handler "${handler.type}" is already registered.`)
    }
    this.handlers.set(handler.type, handler as RuntimeTaskHandler<unknown, unknown>)
  }

  get<Input, Output>(type: string): RuntimeTaskHandler<Input, Output> | undefined {
    return this.handlers.get(type) as RuntimeTaskHandler<Input, Output> | undefined
  }
}
