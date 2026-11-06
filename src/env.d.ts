declare module '@deepseek-ai/dsh-client-runtime/client' {
  export interface ClientContext {
    slots: any
    locale: any
    [key: string]: any
  }
}

declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
