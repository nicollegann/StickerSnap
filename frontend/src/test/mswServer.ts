import { setupServer } from "msw/node";

// No default handlers here — each test file adds its own via server.use().
// Tests that need specific handlers pass them to server.use() directly,
// and setup.ts calls server.resetHandlers() after each test to clean up.
export const server = setupServer();
