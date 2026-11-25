// Component tests: render one component in jsdom and drive it the way a person would.
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SkuChip } from "../ai/news/SkuChip";
import { CostWhy } from "./CostWhy";
import ErrorBoundary from "./ErrorBoundary";
import { isoDay, type Order } from "./data";

function Boom({ when }: { when: boolean }): React.ReactNode {
  if (when) throw new Error("render failed");
  return <p>All good</p>;
}

describe("ErrorBoundary", () => {
  it("shows the reload panel when a view crashes, and recovers on a new reset key", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(
      <ErrorBoundary resetKey="orders">
        <Boom when />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong on this page.");
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();

    rerender(
      <ErrorBoundary resetKey="map">
        <Boom when={false} />
      </ErrorBoundary>,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("All good")).toBeInTheDocument();
  });

  it("uses the fallback it is given", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary fallback={<p>Map unavailable</p>}>
        <Boom when />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Map unavailable")).toBeInTheDocument();
  });
});

describe("CostWhy", () => {
  it("explains the amount on keyboard focus and hides it on Escape", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CostWhy why="Duty 6.5% of the order value">USD 1,560</CostWhy>);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    await user.tab();
    const note = screen.getByRole("tooltip");
    expect(note).toHaveTextContent("Duty 6.5% of the order value");
    expect(screen.getByText("USD 1,560")).toHaveAttribute("aria-describedby", note.id);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("closes a moment after the pointer leaves", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CostWhy why="From the supplier quote">EUR 900</CostWhy>);
    await user.hover(screen.getByText("EUR 900"));
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    await user.unhover(screen.getByText("EUR 900"));
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(200));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    vi.useRealTimers();
  });
});

describe("SkuChip", () => {
  const future = isoDay(new Date(Date.now() + 30 * 86_400_000));
  const past = isoDay(new Date(Date.now() - 30 * 86_400_000));
  const order = (id: string, hsCode: string, shipDate = future): Order => ({
    id,
    product: `Product ${id}`,
    supplier: "Maker",
    destination: "Rotterdam, NL",
    value: 1000,
    shipDate,
    hsCode,
    risk: false,
  });
  const entry = { sku: "SKU-1", name: "Oak boards", reason: "Named in the alert" };
  const item = { sku: "SKU-1", name: "Oak boards", hsCode: "4407.91", markets: ["EU"] };

  it("links straight to the one matching open order", () => {
    render(
      <SkuChip
        entry={entry}
        item={item}
        orders={[order("PO-1", "4407.99"), order("PO-OLD", "4407.99", past)]}
        rejected={new Set()}
      />,
    );
    expect(screen.getByRole("link", { name: /SKU-1/ })).toHaveAttribute(
      "href",
      "#/workspace/orders/PO-1",
    );
  });

  it("lists several matches, leaving out rejected orders, and closes on Escape", async () => {
    const user = userEvent.setup();
    render(
      <SkuChip
        entry={entry}
        item={item}
        orders={[order("PO-1", "4407.99"), order("PO-2", "4407.10"), order("PO-3", "4407.10")]}
        rejected={new Set(["PO-3"])}
      />,
    );
    const chip = screen.getByRole("button", { name: "SKU-1: 2 matching orders" });
    await user.click(chip);
    const dialog = screen.getByRole("dialog", { name: "Orders for SKU-1" });
    expect(dialog).toHaveTextContent("HS 4407 · sells to EU");
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      expect.stringContaining("PO-1"),
      expect.stringContaining("PO-2"),
    ]);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(chip).toHaveFocus();
  });

  it("says why nothing matched", async () => {
    const user = userEvent.setup();
    render(<SkuChip entry={entry} item={item} orders={[order("PO-9", "6109.10")]} rejected={new Set()} />);
    await user.click(screen.getByRole("button", { name: "SKU-1: show matching orders" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "No open order has HS heading 4407 and ships to EU.",
    );
  });
});
