/**
 * Vercel Serverless Function Entry Point
 *
 * Catches all routes and forwards to Hono app.
 */

import { handle } from "hono/vercel";
import app from "../dist/app.js";

// Use Node.js runtime for better compatibility
export const config = {
  runtime: "nodejs",
};

// Export handlers for all HTTP methods
export const GET = handle(app);
export const POST = handle(app);
export const PUT = handle(app);
export const PATCH = handle(app);
export const DELETE = handle(app);
export const OPTIONS = handle(app);
