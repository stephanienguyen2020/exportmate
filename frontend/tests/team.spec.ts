import { test, expect, type Page } from "@playwright/test";

type Role = "owner" | "editor" | "viewer";
const company = {
  id: "company-1",
  name: "API Company",
  businessRole: "Manufacturer",
  origin: "Vietnam",
  transit: [],
  destination: "European Union",
  description: "Plywood and furniture for export.",
  currency: "USD",
};
const member = (userId: string, name: string, email: string, role: Role, you = false) => ({
  userId,
  name,
  email,
  role,
  joinedAt: "2026-10-01T09:00:00Z",
  you,
});

// A connected workspace whose team the test can read and change through the mocked API.
async function teamFixture(page: Page, options: { role?: Role; onboarded?: boolean } = {}) {
  const role = options.role ?? "owner";
  const me = {
    user: { id: "user-1", name: "Test Person", email: "me@example.com", alerts: true, digest: false },
    company: options.onboarded === false ? null : company,
    role: options.onboarded === false ? null : role,
    onboarded: options.onboarded !== false,
  };
  let members = [
    member("user-1", "Test Person", "me@example.com", role, true),
    member("user-2", "Binh Tran", "binh@example.com", "viewer"),
    ...(role === "owner" ? [] : [member("user-3", "Lan Owner", "lan@example.com", "owner")]),
  ];
  let invites: any[] = [];
  let received = [
    {
      id: "inv-9",
      companyName: "Binh Duong Wood Co.",
      role: "editor",
      invitedBy: { id: "user-7", name: "Lan" },
      expiresAt: "2026-10-29T09:00:00Z",
    },
  ];
  const requests: { path: string; method: string; body: any }[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    const method = request.method();
    let body: any = null;
    try {
      body = request.postDataJSON();
    } catch {
      body = null;
    }
    requests.push({ path, method, body });
    const reply = (data: unknown, status = 200) =>
      route.fulfill({ status, json: { data, meta: {} } });
    if (path === "/me") return reply(me);
    if (path === "/orders" || path === "/playbook/rules" || path === "/order-statuses")
      return reply([]);
    if (path === "/overview")
      return reply({
        totalOrders: 0,
        countsByStatus: {},
        valueAtRiskByCurrency: {},
        nearestAffectedShipDate: null,
        sourcesCheckedAt: null,
      });
    if (path === "/company/cost-settings") return reply([]);
    if (path === "/audit-events") return reply([]);
    if (path === "/company/members") return reply(members);
    if (path === "/company/invites" && method === "POST") {
      const invite = {
        id: `inv-${invites.length + 1}`,
        email: body.email.trim().toLowerCase(),
        role: body.role,
        invitedBy: { id: "user-1", name: "Test Person" },
        createdAt: "2026-10-15T09:00:00Z",
        expiresAt: "2026-10-29T09:00:00Z",
        expired: false,
      };
      invites = [invite, ...invites.filter((i) => i.email !== invite.email)];
      return reply({ ...invite, sandbox: true }, 201);
    }
    if (path === "/company/invites") return reply(invites);
    if (path.startsWith("/company/invites/")) {
      invites = invites.filter((i) => i.id !== path.split("/").pop());
      return reply({ deleted: true });
    }
    if (path.startsWith("/company/members/")) {
      const id = path.split("/").pop();
      if (method === "DELETE") {
        members = members.filter((m) => m.userId !== id);
        if (id === "user-1") Object.assign(me, { company: null, role: null, onboarded: false });
        return reply({ deleted: true });
      }
      members = members.map((m) => (m.userId === id ? { ...m, role: body.role } : m));
      return reply(members.find((m) => m.userId === id));
    }
    if (path === "/me/invites") return reply(received);
    if (path === "/me/invites/inv-9/accept") {
      received = [];
      Object.assign(me, { company, role: "editor", onboarded: true });
      return reply(me);
    }
    if (path === "/me/invites/inv-9") {
      received = [];
      return reply({ deleted: true });
    }
    return reply({});
  });
  return requests;
}

async function login(page: Page) {
  await page.goto("/#/login");
  await page.getByLabel("Email", { exact: true }).fill("me@example.com");
  await page.getByLabel("Password", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

test("owners invite people, change roles and remove members", async ({ page }) => {
  const requests = await teamFixture(page);
  await login(page);
  await expect(page.getByText("CONNECTED WORKSPACE")).toBeVisible();
  await page.goto("/#/workspace/account");
  const team = page.getByRole("region", { name: "Team" });
  await expect(team.getByText("Binh Tran")).toBeVisible();
  // The only owner can't demote or remove themselves.
  await expect(team.getByLabel("Role of Test Person")).toBeDisabled();
  await expect(team.getByRole("button", { name: "Leave company" })).toHaveCount(0);

  await team.getByLabel("Email address").fill("Minh@Example.com");
  await team.getByLabel("Invite as").selectOption("editor");
  await team.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByText(/nothing was sent/)).toBeVisible();
  expect(requests.find((r) => r.path === "/company/invites" && r.method === "POST")?.body).toEqual(
    { email: "Minh@Example.com", role: "editor" },
  );
  const invitations = team.getByRole("list", { name: "Invitations" });
  await expect(invitations.getByText("minh@example.com")).toBeVisible();
  await invitations.getByRole("button", { name: "Withdraw" }).click();
  await expect(invitations).toHaveCount(0);

  await team.getByLabel("Role of Binh Tran").selectOption("editor");
  await expect(page.getByText("Binh Tran is now editor.")).toBeVisible();
  expect(
    requests.find((r) => r.path === "/company/members/user-2" && r.method === "PATCH")?.body,
  ).toEqual({ role: "editor" });

  const binh = team.getByRole("listitem").filter({ hasText: "Binh Tran" });
  await binh.getByRole("button", { name: "Remove" }).click();
  await binh.getByRole("button", { name: "Confirm: remove" }).click();
  await expect(team.getByText("Binh Tran")).toHaveCount(0);
});

test("viewers see the team read-only and can leave", async ({ page }) => {
  const requests = await teamFixture(page, { role: "viewer" });
  await login(page);
  await expect(page.getByText("CONNECTED WORKSPACE")).toBeVisible();
  await page.goto("/#/workspace/account");
  const team = page.getByRole("region", { name: "Team" });
  await expect(team.getByText("Lan Owner")).toBeVisible();
  await expect(team.getByText("Only an owner can invite people")).toBeVisible();
  await expect(team.getByRole("combobox")).toHaveCount(0);
  await expect(team.getByRole("button", { name: "Send invitation" })).toHaveCount(0);
  await expect(team.getByRole("button", { name: "Remove" })).toHaveCount(0);
  expect(requests.some((r) => r.path === "/company/invites")).toBe(false);

  await team.getByRole("button", { name: "Leave company" }).click();
  await team.getByRole("button", { name: "Confirm: leave" }).click();
  await expect(page).toHaveURL(/#\/onboarding$/);
  expect(
    requests.find((r) => r.path === "/company/members/user-1")?.method,
  ).toBe("DELETE");
});

test("an invited person joins the company from onboarding", async ({ page }) => {
  const requests = await teamFixture(page, { onboarded: false });
  await login(page);
  await expect(page).toHaveURL(/#\/onboarding$/);
  const invitations = page.getByRole("region", { name: "Invitations" });
  await expect(invitations.getByText("Lan invited you")).toBeVisible();
  await expect(invitations.getByText("Binh Duong Wood Co.", { exact: true })).toBeVisible();
  await invitations.getByRole("button", { name: "Join Binh Duong Wood Co." }).click();
  await expect(page.getByText("CONNECTED WORKSPACE")).toBeVisible();
  expect(requests.some((r) => r.path === "/me/invites/inv-9/accept" && r.method === "POST")).toBe(
    true,
  );
  expect(requests.some((r) => r.path === "/onboarding")).toBe(false);
});
