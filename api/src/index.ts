/**
 * Worker entry point for the standalone Horse Holder API.
 */

import { serve } from "./serve.ts";

export { BudgetGroup } from "./budget.ts";

export default {
  fetch: serve,
} satisfies ExportedHandler<Env>;
