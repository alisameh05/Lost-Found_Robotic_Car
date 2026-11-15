// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { DashboardFixtureControls, readFixtureShell } from "@/features/runtime";
import RouteError from "./error";
import Loading from "./(operator)/loading";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
afterEach(cleanup);

test("the fixture label and emergency action stay available in route loading and error fallbacks", async () => {
  const retry = vi.fn();
  const user = userEvent.setup();
  const FixtureShell = await readFixtureShell();
  const view = render(<FixtureShell harnessEnabled><DashboardFixtureControls /></FixtureShell>);
  await user.selectOptions(await screen.findByLabelText("Fixture scenario", {}, { timeout: 5000 }), "searching");
  const emergency = await screen.findByRole("button", { name: "Emergency Stop" });
  const label = "Fixture mode · Sample data · No robot connected";
  view.rerender(<FixtureShell harnessEnabled><Loading /></FixtureShell>);
  expect(screen.getByText(label)).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Loading preview" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Emergency Stop" })).toBe(emergency);

  view.rerender(<FixtureShell harnessEnabled><RouteError retry={retry} /></FixtureShell>);
  expect(screen.getByText(label)).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Unable to open this preview" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(retry).toHaveBeenCalledOnce();
  await user.click(emergency);
  expect(await screen.findByText("Motion permission revoked")).toBeTruthy();
});
