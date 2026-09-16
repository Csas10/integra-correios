export type Brand<T, Name extends string> = T & {
  readonly __brand: Name;
};

export function assertNever(value: never): never {
  throw new Error(`Valor não previsto: ${String(value)}`);
}

export type Clock = () => Date;
