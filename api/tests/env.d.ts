/** Types the `env` that `cloudflare:test` hands to tests as this Worker's own bindings. */
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
