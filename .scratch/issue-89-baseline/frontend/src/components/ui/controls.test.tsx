// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { Button } from "./button";
import { Field } from "./field";
import { RetrievalFeedback } from "./feedback";

afterEach(cleanup);

test("a keyboard user can correct a required field and activate a submission", async () => {
  const submit = vi.fn((event) => event.preventDefault());
  const user = userEvent.setup();
  render(
    <form onSubmit={submit}>
      <Field label="Sample label" description="Enter a short label." error="A label is required." required />
      <Button type="submit">Save sample</Button>
    </form>,
  );

  const input = screen.getByRole("textbox", { name: /Sample label/ });
  expect(input).toHaveProperty("required", true);
  expect(input.getAttribute("aria-invalid")).toBe("true");
  const description = input.getAttribute("aria-describedby")!.split(" ")
    .map((id) => document.getElementById(id)?.textContent).join(" ");
  expect(description).toContain("Enter a short label.");
  expect(description).toContain("A label is required.");

  await user.tab();
  expect(document.activeElement).toBe(input);
  await user.keyboard("Control specimen{Tab}{Enter}");
  expect(input).toHaveProperty("value", "Control specimen");
  expect(submit).toHaveBeenCalledOnce();
});

test("pending blocks activation and keeps focus while a disabled action shows its reason", async () => {
  const activate = vi.fn();
  const user = userEvent.setup();
  const { rerender } = render(<Button onClick={activate}>Save sample</Button>);

  await user.tab();
  await user.keyboard("{Enter}");
  rerender(<Button onClick={activate} pending>Save sample</Button>);
  const button = screen.getByRole("button", { name: "Save sample" });
  expect(document.activeElement).toBe(button);
  expect(button.getAttribute("aria-disabled")).toBe("true");
  await user.keyboard("{Enter} ");
  await user.click(button);
  expect(activate).toHaveBeenCalledOnce();

  rerender(<Button disabledReason="Select a sample first.">Save sample</Button>);
  expect(screen.getByRole("button", { name: "Save sample" })).toHaveProperty("disabled", true);
  const reason = screen.getByText("Select a sample first.");
  expect(reason.hidden).toBe(false);
  expect(button.getAttribute("aria-describedby")).toBe(reason.id);
});

test("a deliberate keyboard retry preserves focus through loading and an empty response", async () => {
  const read = vi.fn();
  const user = userEvent.setup();
  const settings = { onRead: read, loadingLabel: "Checking results", failedLabel: "Results unavailable" };
  const { rerender } = render(<RetrievalFeedback {...settings} state="unavailable" />);
  expect(screen.getByRole("status").textContent).toContain("Results unavailable");
  await user.tab();
  await user.keyboard("{Enter}");
  expect(read).toHaveBeenCalledOnce();
  rerender(<RetrievalFeedback {...settings} state="loading" />);
  expect(screen.getByRole("status").textContent).toContain("Checking results");
  await user.keyboard("{Enter}");
  expect(read).toHaveBeenCalledOnce();
  rerender(<RetrievalFeedback {...settings} state="empty" />);
  expect(screen.getByRole("status").textContent).toContain("No data");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Read again" }));
});
