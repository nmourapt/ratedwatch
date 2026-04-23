// Worker entry. Composes the Hono app from the route modules.
//
// Slice 1 only serves the server-rendered landing page. Future slices will add
// the API surface under /api/*, more public pages (/leaderboard, /m/:id,
// /u/:name, /w/:id), and the authed SPA fall-through via the ASSETS binding.
import { Hono } from "hono";
import { LandingPage } from "@/public/landing";

const app = new Hono();

app.get("/", (c) => {
  return c.html(<LandingPage />);
});

export default app;
