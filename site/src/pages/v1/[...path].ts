import type { APIRoute } from "astro";
import { serve } from "@horse-holder/api/serve.ts";

export const prerender = false;

export const ALL: APIRoute = ({ request, locals }) => serve(request, locals.runtime.env);
