import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll } from "vitest";
import { cleanup } from "@testing-library/react";
import { server } from "./mswServer";

// Start MSW before all tests, reset handlers after each, close after all.
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  cleanup(); // unmount any components rendered during a test
});
afterAll(() => server.close());
