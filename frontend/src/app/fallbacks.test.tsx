// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { AppShell } from "@/components/layout/app-shell";
import RouteError from "./error";
import Loading from "./(operator)/loading";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
afterEach(cleanup);

test("the fixture mode label remains visible while a destination loads or fails", async () => {
  const retry = vi.fn();
  const user = userEvent.setup();
  const view = render(<AppShell fixtureEnabled><Loading /></AppShell>);
  const label = "Fixture mode · Sample data · No robot connected";
  expect(screen.getByText(label)).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("Loading preview");

  view.rerender(<AppShell fixtureEnabled><RouteError retry={retry} /></AppShell>);
  expect(screen.getByText(label)).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Unable to open this preview" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(retry).toHaveBeenCalledOnce();
});
