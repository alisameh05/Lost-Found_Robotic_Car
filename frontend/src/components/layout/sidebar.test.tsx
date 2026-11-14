// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { AppShell } from "./app-shell";

const path = vi.hoisted(() => ({ value: "/sessions/sample-session/live" }));
vi.mock("next/navigation", () => ({ usePathname: () => path.value }));
afterEach(cleanup);

test("operators can skip the sidebar and identify the active section by its accessible state", async () => {
  const user = userEvent.setup();
  render(<AppShell fixtureEnabled><h1>Search Workspace</h1></AppShell>);

  const navigation = screen.getByRole("navigation", { name: "Main navigation" });
  expect(navigation.querySelectorAll("a")).toHaveLength(5);
  expect(screen.getByRole("link", { name: /Objects \/ History/ }).getAttribute("aria-current")).toBe("location");
  expect(screen.getByRole("link", { name: /Dashboard/ }).getAttribute("aria-current")).toBeNull();

  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole("link", { name: "Skip to content" }));
  expect(document.activeElement?.getAttribute("href")).toBe("#main-content");
  expect(screen.getByRole("main").id).toBe("main-content");
});
