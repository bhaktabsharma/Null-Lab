import { test, expect } from "@playwright/test";

test.describe("NULLLAB web app", () => {
  test("guest login, browsing the catalogue, launching a lab, theming, and logout", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/NULLLAB/);

    await page.getByRole("button", { name: "Continue as guest" }).click();
    await expect(page.getByRole("heading", { name: "Lab Catalogue" })).toBeVisible({ timeout: 10_000 });

    // The card count must match what the backend actually serves — never a hard-coded number.
    const { labs } = (await (await page.request.get("/api/labs")).json()) as { labs: { family: string; difficulty: string }[] };
    expect(labs.length).toBeGreaterThanOrEqual(20);
    const cards = page.locator(".nl-card");
    await expect(cards).toHaveCount(labs.length, { timeout: 10_000 });
    await expect(page.getByText(`${labs.length} of ${labs.length} labs`)).toBeVisible();

    const firstCard = cards.first();
    const labTitle = await firstCard.locator("h3").textContent();
    await firstCard.getByRole("button", { name: "Launch lab" }).click();

    await page.waitForURL(/\/workspace\//, { timeout: 15_000 });
    await expect(page.getByRole("link", { name: "Open target in new tab" })).toBeVisible({ timeout: 15_000 });
    const targetHref = await page.getByRole("link", { name: "Open target in new tab" }).getAttribute("href");
    expect(targetHref).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await page.locator("h1").first().textContent()).toContain(labTitle?.split(" ")[0] ?? "");

    // Theme switcher — applies instantly and persists across a reload.
    await page.getByRole("link", { name: "Settings" }).click();
    await expect(page.getByText("Color theme")).toBeVisible();
    const accentBefore = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--nl-accent").trim());
    await page.getByRole("button", { name: /Acid Green/ }).click();
    await page.waitForTimeout(300);
    const accentAfter = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--nl-accent").trim());
    expect(accentAfter).not.toBe(accentBefore);

    await page.reload();
    await expect(page.getByText("Color theme")).toBeVisible();
    const accentAfterReload = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--nl-accent").trim());
    expect(accentAfterReload).toBe(accentAfter);

    // Progress page.
    await page.getByRole("link", { name: "Progress" }).click();
    await expect(page.getByText("Total XP")).toBeVisible();

    // Logout returns to the login screen.
    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page.getByRole("button", { name: "Continue as guest" })).toBeVisible();
  });

  test("register, logout, wrong password, then correct login", async ({ page }) => {
    const username = `e2e_user_${Date.now()}`;
    await page.goto("/");

    await page.getByText("New here? Create a profile").click();
    await page.getByPlaceholder("Username").fill(username);
    await page.getByPlaceholder("Password").fill("correct-horse-battery");
    await page.getByRole("button", { name: "Create profile" }).click();
    await expect(page.getByRole("heading", { name: "Lab Catalogue" })).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page.getByRole("button", { name: "Continue as guest" })).toBeVisible();

    // Wrong password shows an error and does not log in.
    await page.getByText("New here? Create a profile").click(); // toggles back via the link's sibling text in login mode
    await page.goto("/"); // ensure a clean login-mode view
    await page.getByPlaceholder("Username").fill(username);
    await page.getByPlaceholder("Password").fill("totally-wrong");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText(/Invalid username or password/)).toBeVisible({ timeout: 5_000 });

    // Correct password logs in.
    await page.getByPlaceholder("Password").fill("correct-horse-battery");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Lab Catalogue" })).toBeVisible({ timeout: 10_000 });
  });

  test("catalogue search and filters narrow the list using real backend data", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Continue as guest" }).click();
    await expect(page.getByRole("heading", { name: "Lab Catalogue" })).toBeVisible({ timeout: 10_000 });
    const { labs } = (await (await page.request.get("/api/labs")).json()) as { labs: { family: string; difficulty: string }[] };
    const cards = page.locator(".nl-card");
    await expect(cards).toHaveCount(labs.length);

    // Family filter.
    const ac = labs.filter((l) => l.family === "access-control").length;
    await page.getByLabel("Family").selectOption("access-control");
    await expect(cards).toHaveCount(ac);
    await expect(page.getByText(`${ac} of ${labs.length} labs`)).toBeVisible();

    // Difficulty filter composes with the family filter.
    const acHard = labs.filter((l) => l.family === "access-control" && l.difficulty === "hard").length;
    expect(acHard).toBeGreaterThan(0);
    await page.getByLabel("Difficulty").selectOption("hard");
    await expect(cards).toHaveCount(acHard);

    // Reset filters, then search by a tag/word.
    await page.getByLabel("Family").selectOption("all");
    await page.getByLabel("Difficulty").selectOption("all");
    await page.getByPlaceholder("Search labs…").fill("CloudDesk");
    await expect(cards).toHaveCount(1);
    await expect(cards.first().locator("h3")).toContainText("CloudDesk");

    // A search with no matches shows the empty state.
    await page.getByPlaceholder("Search labs…").fill("zzz-no-such-lab");
    await expect(page.getByText("No labs match those filters yet.")).toBeVisible();
  });

  test("hints are revealed one at a time; the debrief appears only after a real solve", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Continue as guest" }).click();
    await expect(page.getByRole("heading", { name: "Lab Catalogue" })).toBeVisible({ timeout: 10_000 });

    await page.locator(".nl-card", { hasText: "Halden Staff Portal" }).getByRole("button", { name: "Launch lab" }).click();
    await page.waitForURL(/\/workspace\//, { timeout: 15_000 });
    const target = await page.getByRole("link", { name: "Open target in new tab" }).getAttribute("href", { timeout: 15_000 });
    expect(target).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // Nothing is revealed up front.
    await expect(page.getByText("Hints", { exact: true })).toBeVisible();
    await expect(page.getByText(/^Hint 1:/)).toHaveCount(0);
    await expect(page.getByText("Debrief", { exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Reveal hint 1 of 2" }).click();
    await expect(page.getByText(/Hint 1:/)).toBeVisible();
    await expect(page.getByText(/Hint 2:/)).toHaveCount(0);
    await page.getByRole("button", { name: "Reveal hint 2 of 2" }).click();
    await expect(page.getByText(/Hint 2:/)).toBeVisible();
    await expect(page.getByRole("button", { name: /Reveal hint/ })).toHaveCount(0);

    // Do the real exploit over plain HTTP, like a learner using curl or Burp.
    const res = await page.request.get(`${target}/staff-tools-4821/payroll-export`);
    expect(res.status()).toBe(200);

    // The workspace notices the server-side solve and shows the debrief.
    await expect(page.getByText("Debrief", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/What the server verified/)).toBeVisible();
  });

  test("stop shuts a lab down; a fresh instance can be started from the workspace", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Continue as guest" }).click();
    await expect(page.getByRole("heading", { name: "Lab Catalogue" })).toBeVisible({ timeout: 10_000 });

    await page.locator(".nl-card", { hasText: "NoteNest" }).getByRole("button", { name: "Launch lab" }).click();
    await page.waitForURL(/\/workspace\//, { timeout: 15_000 });
    const target = await page.getByRole("link", { name: "Open target in new tab" }).getAttribute("href", { timeout: 15_000 });
    expect((await page.request.get(`${target}/healthz`)).status()).toBe(200);

    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByText(/This instance is stopped/)).toBeVisible({ timeout: 15_000 });
    await expect(page.request.get(`${target}/healthz`, { timeout: 3000 })).rejects.toThrow();

    await page.getByRole("button", { name: "Start a fresh instance" }).click();
    await expect(page.getByRole("link", { name: "Open target in new tab" })).toBeVisible({ timeout: 20_000 });
  });
});
